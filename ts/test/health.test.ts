/**
 * Tests for the health check ("doctor") — shared contract shape, tokenless
 * skip semantics, env checks, bot_token_valid, and webhook_absent. The
 * remaining per-check paths (poller, allowlist, state dir, db, redaction)
 * live in health-checks.test.ts; fixtures in health-fixtures.ts.
 *
 * Every path is exercised with INJECTED inputs (no network/fs — the adapters
 * gather those in production). The shared contract is asserted structurally:
 * {package, ok, checks[{name, ok, detail, hint}], summary}, every FAILING
 * check carries a non-null actionable hint, and the top-level ok is the AND
 * of all non-warn checks (a deliberately tokenless agent, or a legacy-env
 * nudge, never flips the aggregate).
 */

import { describe, test, expect } from "bun:test";
import { buildHealthReport, SKIPPED_DISABLED_DETAIL } from "../lib/health.js";
import {
  serializeHealthReport,
  probeLegacyEnv,
} from "../lib/health-adapters.js";
import { validateBotToken } from "../lib/startup-validate.js";
import { FAKE_TOKEN, healthyInputs, byName } from "./health-fixtures.js";

describe("shared contract shape", () => {
  test("healthy inputs → ok:true, all 14 checks present, passing hints null", () => {
    const report = buildHealthReport(healthyInputs());
    expect(report.package).toBe("claude-code-telegrammer");
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "env_unexpanded",
      "env_renamed",
      "bot_token_present",
      "bot_token_valid",
      "webhook_absent",
      "poller_alive",
      // Sits right after poller_alive because it answers the question
      // poller_alive does NOT: the process can be up while nothing arrives.
      // A month of silent inbound outage lived in that gap — see
      // lib/health-checks-ingestion.ts.
      "ingestion_live",
      "allowlist_nonempty",
      "state_dir_writable",
      "db_schema_current",
      "env_legacy",
      "wake_target_reachable",
      "wake_delivery_backlog",
      // #83: "am I running the code that is on disk?" — the default fixture
      // supplies no codeCurrency probe, so this skips (ok, hint null) rather
      // than failing the report. A doctor that crashes on a missing input is
      // worse than one that skips a check.
      "code_current",
    ]);
    for (const c of report.checks) {
      expect(c.ok).toBe(true);
      expect(c.detail.length).toBeGreaterThan(0); // no silent pass
      expect(c.hint).toBeNull();
    }
    // wake_target_reachable/wake_delivery_backlog are skipped-disabled in the
    // default fixture (no TURN_URL) — still counted, still hint:null, still
    // "ok" in the summary (skipped is a legitimate healthy state here, same
    // as the tokenless-skip pattern elsewhere in this report).
    expect(report.summary).toContain("14/14");
  });

  test("every failing check carries a non-null hint (fail-loud, actionable)", () => {
    const report = buildHealthReport(
      healthyInputs({
        unexpandedEnvLines: ["CCT_BOT_TOKEN=${SCITEX_LEAD_TELEGRAM_TOKEN}"],
        renamedEnvLines: [
          "CCT_STATE_DIR was renamed to CCT_AGENT_STATE_DIR; unset the old var (its value is ignored).",
        ],
        tokenCheck: {
          ok: false,
          kind: "invalid_token",
          message: "fix CCT_BOT_TOKEN",
        },
        webhook: {
          kind: "response",
          ok: true,
          url: "https://example.com/hook",
        },
        poller: {
          kind: "external",
          lockPid: null,
          lockAlive: false,
          pidfilePid: null,
          pidfileAlive: false,
          pidfilePath: "/tmp/x/poller-abc.pid",
        },
        access: {
          accessFileExists: false,
          envAllowedCount: 0,
          dmPolicy: "allowlist",
        },
        stateDirProbe: {
          path: "/tmp/x",
          exists: true,
          writable: false,
          detail: "EACCES",
        },
        db: { exists: true, error: "SQLITE_CANTOPEN" },
      }),
    );
    expect(report.ok).toBe(false);
    const failing = report.checks.filter((c) => !c.ok);
    expect(failing.length).toBeGreaterThanOrEqual(7);
    for (const c of failing) {
      expect(c.hint).not.toBeNull();
      expect((c.hint as string).length).toBeGreaterThan(0);
    }
    expect(report.summary).toContain("FAILING");
  });
});

describe("tokenless (telegram disabled by design)", () => {
  const report = buildHealthReport(
    healthyInputs({
      tokenPresent: false,
      tokenCheck: null,
      webhook: null,
      poller: null,
      access: null,
    }),
  );

  test("bot_token_present → ok:false with the buildDisabledWarning hint", () => {
    const c = byName(report, "bot_token_present");
    expect(c.ok).toBe(false);
    expect(c.hint).not.toBeNull();
    expect(c.hint).toContain("CCT_BOT_TOKEN_<NAME>");
    expect(c.hint).toContain(
      "~/.bash.d/secrets/010_scitex/01_claude-code-telegrammer.src",
    );
    expect(c.hint).toContain("test-agent");
  });

  test("bot_token_valid / webhook_absent / poller_alive / ingestion_live / allowlist_nonempty are skipped-ok", () => {
    for (const name of [
      "bot_token_valid",
      "webhook_absent",
      "poller_alive",
      "ingestion_live",
      "allowlist_nonempty",
    ]) {
      const c = byName(report, name);
      expect(c.ok).toBe(true);
      expect(c.detail).toBe(SKIPPED_DISABLED_DETAIL);
      expect(c.hint).toBeNull();
    }
  });

  test("aggregate ok stays TRUE — tokenless is a warn, not unhealthy", () => {
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("warnings: bot_token_present");
  });
});

describe("env checks", () => {
  test("env_unexpanded fail lists the offending line and hints claude.sh / direct export", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          unexpandedEnvLines: ["CCT_BOT_TOKEN=${SCITEX_LEAD_TELEGRAM_TOKEN}"],
        }),
      ),
      "env_unexpanded",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("${SCITEX_LEAD_TELEGRAM_TOKEN}");
    expect(c.hint).toContain("claude.sh");
  });

  test("env_renamed fail reuses the findRenamedEnv line as the hint", () => {
    const line =
      "CCT_STATE_DIR was renamed to CCT_AGENT_STATE_DIR; unset the old var (its value is ignored).";
    const c = byName(
      buildHealthReport(healthyInputs({ renamedEnvLines: [line] })),
      "env_renamed",
    );
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("CCT_AGENT_STATE_DIR");
  });

  test("env_legacy set → ok:true (warn) with a rename hint; aggregate unaffected", () => {
    const report = buildHealthReport(
      healthyInputs({
        legacyEnvNames: ["CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN"],
      }),
    );
    const c = byName(report, "env_legacy");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN");
    expect(c.hint).toContain("CCT_");
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("env_legacy");
  });

  test("probeLegacyEnv picks up only non-empty legacy-prefixed vars", () => {
    const names = probeLegacyEnv({
      CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN: "x",
      CLAUDE_CODE_TELEGRAMMER_TELEGRAM_EMPTY: "",
      CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN: "y",
      CCT_BOT_TOKEN: "z",
    });
    expect(names).toEqual(["CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN"]);
  });
});

describe("bot_token_valid", () => {
  test("getMe 401 → fail whose hint contains CCT_BOT_TOKEN (incident class)", async () => {
    const tokenCheck = await validateBotToken(async () => ({
      ok: false,
      error_code: 401,
      description: "Unauthorized",
    }));
    const c = byName(
      buildHealthReport(healthyInputs({ tokenCheck })),
      "bot_token_valid",
    );
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("CCT_BOT_TOKEN");
    expect(c.hint).toContain("Unauthorized");
  });

  test("transient (network throw) → ok:true, detail notes transient/unverifiable", async () => {
    const tokenCheck = await validateBotToken(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    });
    const c = byName(
      buildHealthReport(healthyInputs({ tokenCheck })),
      "bot_token_valid",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("transient");
    expect(c.hint).toBeNull();
  });

  test("valid token → detail includes @username", () => {
    const c = byName(buildHealthReport(healthyInputs()), "bot_token_valid");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("@my_bot");
  });
});

describe("webhook_absent", () => {
  test("webhook SET → fail with the deleteWebhook hint using the literal <TOKEN>", () => {
    const report = buildHealthReport(
      healthyInputs({
        webhook: {
          kind: "response",
          ok: true,
          url: "https://evil.example/hook",
        },
      }),
    );
    const c = byName(report, "webhook_absent");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("https://evil.example/hook");
    expect(c.hint).toContain(
      "curl https://api.telegram.org/bot<TOKEN>/deleteWebhook",
    );
    // The raw token must never appear anywhere in the output.
    expect(serializeHealthReport(report)).not.toContain(FAKE_TOKEN);
    expect(report.ok).toBe(false);
  });

  test("transport error → ok:true unverifiable (transient, not a finding)", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          webhook: { kind: "transport_error", detail: "connect ECONNREFUSED" },
        }),
      ),
      "webhook_absent",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("ECONNREFUSED");
  });

  test("getWebhookInfo non-ok envelope → ok:true unverifiable", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          webhook: {
            kind: "response",
            ok: false,
            url: "",
            error_code: 502,
            description: "Bad Gateway",
          },
        }),
      ),
      "webhook_absent",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("502");
  });
});
