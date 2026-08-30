/**
 * Tests for the health check ("doctor"), part 2 — poller_alive,
 * allowlist_nonempty, state_dir_writable, db_schema_current, and the
 * token-redaction belt in lib/health-adapters.ts. Part 1 (contract shape,
 * tokenless skips, env checks, token/webhook) lives in health.test.ts;
 * fixtures in health-fixtures.ts.
 */

import { describe, test, expect } from "bun:test";
import { buildHealthReport } from "../lib/health.js";
import { redactToken, serializeHealthReport } from "../lib/health-adapters.js";
import { SCHEMA_VERSION } from "../lib/store.js";
import { FAKE_TOKEN, healthyInputs, byName } from "./health-fixtures.js";

describe("poller_alive", () => {
  test("self mode (MCP tool inside the server) → ok with own pid", () => {
    const c = byName(
      buildHealthReport(healthyInputs({ poller: { kind: "self", pid: 777 } })),
      "poller_alive",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("777");
    expect(c.detail).toContain("self");
  });

  test("external: recorded pidfile pid dead → fail with restart hint", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          poller: {
            kind: "external",
            lockPid: 100,
            lockAlive: true,
            pidfilePid: 4242,
            pidfileAlive: false,
            pidfilePath: "/tmp/x/poller-abcd1234.pid",
          },
        }),
      ),
      "poller_alive",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("4242");
    expect(c.hint).toContain("restart");
  });

  test("external: pidfile pid alive (kill-0) → ok", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          poller: {
            kind: "external",
            lockPid: null,
            lockAlive: false,
            pidfilePid: 4242,
            pidfileAlive: true,
            pidfilePath: "/tmp/x/poller-abcd1234.pid",
          },
        }),
      ),
      "poller_alive",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("kill-0");
  });

  test("external: only the lock file recorded and alive → ok via lock fallback", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          poller: {
            kind: "external",
            lockPid: 100,
            lockAlive: true,
            pidfilePid: null,
            pidfileAlive: false,
            pidfilePath: "/tmp/x/poller-abcd1234.pid",
          },
        }),
      ),
      "poller_alive",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("100");
  });

  test("external: nothing recorded → fail with restart hint", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          poller: {
            kind: "external",
            lockPid: null,
            lockAlive: false,
            pidfilePid: null,
            pidfileAlive: false,
            pidfilePath: "/tmp/x/poller-abcd1234.pid",
          },
        }),
      ),
      "poller_alive",
    );
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("restart");
  });
});

describe("allowlist_nonempty", () => {
  test("fail-closed empty allowlist → fail, hint names CCT_ALLOWED_USERS", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          access: {
            accessFileExists: false,
            envAllowedCount: 0,
            dmPolicy: "allowlist",
          },
        }),
      ),
      "allowlist_nonempty",
    );
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("CCT_ALLOWED_USERS");
  });

  test("env entries present → ok with the gating description as detail", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          access: {
            accessFileExists: false,
            envAllowedCount: 2,
            dmPolicy: "allowlist",
          },
        }),
      ),
      "allowlist_nonempty",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("dmPolicy=allowlist");
  });
});

describe("state_dir_writable", () => {
  test("missing but creatable → ok (first run)", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          stateDirProbe: { path: "/tmp/new", exists: false, writable: true },
        }),
      ),
      "state_dir_writable",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("creatable");
  });

  test("not writable → fail, hint names CCT_AGENT_STATE_DIR + CCT_AGENT_ID derivation", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          stateDirProbe: {
            path: "/tmp/x",
            exists: true,
            writable: false,
            detail: "EACCES: permission denied",
          },
        }),
      ),
      "state_dir_writable",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("EACCES");
    expect(c.hint).toContain("CCT_AGENT_STATE_DIR");
    expect(c.hint).toContain("CCT_AGENT_ID");
  });
});

describe("db_schema_current", () => {
  test("missing DB → ok, 'not yet created (first run)'", () => {
    const c = byName(
      buildHealthReport(healthyInputs({ db: { exists: false } })),
      "db_schema_current",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toBe("not yet created (first run)");
  });

  test("schema version mismatch → fail naming found vs expected", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: {
            exists: true,
            schemaVersion: "1",
            updateOffset: null,
            maxUpdateId: null,
            inboundCount: 0,
          },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("schema_version=1");
    expect(c.detail).toContain(SCHEMA_VERSION);
    expect(c.hint).not.toBeNull();
  });

  test("implausible persisted offset (10-day-outage class) → fail mentioning update_offset", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: {
            exists: true,
            schemaVersion: SCHEMA_VERSION,
            updateOffset: 999999999,
            maxUpdateId: 5000,
            inboundCount: 42,
          },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("update_offset=999999999");
    expect(c.hint).toContain("update_offset");
    expect(c.hint).toContain("poller is stopped");
  });

  test("offset within max+1000 slack → ok (plausible)", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: {
            exists: true,
            schemaVersion: SCHEMA_VERSION,
            updateOffset: 5900,
            maxUpdateId: 5000,
            inboundCount: 42,
          },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("plausible");
  });

  test("an unreadable store → fail with a hint naming what to actually check", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: { exists: true, error: "connection refused" },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(false);
    // THE RULE THIS CASE ENFORCES, restated for the current store: the hint
    // must name the thing the operator can actually go and look at. It used
    // to check that the hint named the live database FILE rather than the
    // abandoned legacy one, because sending him to edit a dead file wastes
    // the trip. There is no file now — the equivalent mistake would be a hint
    // pointing at the state directory — so it must name the connection and
    // the namespace instead.
    expect(c.hint).toContain("SCITEX_STORE_DSN");
    expect(c.hint).toContain("schema");
    expect(c.hint).not.toContain("state dir");
  });

  // ── The 2026-08-11 false alarm ──────────────────────────────────────────
  //
  // MEASURED on scitex-hub's live store: update_offset=104702033 while the
  // newest STORED inbound update_id was 104700678 — a gap of 1355. This check
  // called that "implausible" and told the operator to DELETE the offset.
  // Both halves were wrong:
  //
  //   - The gap is ordinary. Reactions, edits, chat-member updates and
  //     messages from non-allowlisted senders all advance Telegram's
  //     update_id and never become a stored message row, so the comparand
  //     drifts on any chat that is quiet but reacted-to. The poller log
  //     proved ingestion was LIVE at that very offset (two reactions
  //     delivered the evening before).
  //   - Deleting the offset makes getUpdates re-fetch Telegram's 24h backlog,
  //     RE-DELIVERING already-seen messages into the operator's session.
  //
  // A check that cannot separate healthy from broken must not report broken,
  // and must never hand out a destructive first step. The genuinely poisoned
  // case (an offset no plausible update volume explains) still fails hard.
  test("REGRESSION: a quiet, reacted-to chat is not reported broken", () => {
    const report = buildHealthReport(
      healthyInputs({
        db: {
          exists: true,
          schemaVersion: SCHEMA_VERSION,
          updateOffset: 104702033,
          maxUpdateId: 104700678,
          inboundCount: 124,
        },
      }),
    );
    const c = byName(report, "db_schema_current");

    expect(c.ok).toBe(true); // <- was false: the false alarm
    expect(report.ok).toBe(true); // and it must not redden the whole report
    expect(c.detail).toContain("1355"); // still SHOWS the gap, honestly
    expect(c.hint).toBeNull(); // nothing to act on
  });

  test("REGRESSION: the destructive delete-the-offset hint is gone", () => {
    // Even in the hard-fail branch the first step must not be data loss.
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: {
            exists: true,
            schemaVersion: SCHEMA_VERSION,
            updateOffset: 999999999,
            maxUpdateId: 5000,
            inboundCount: 42,
          },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(false);
    // It must say to CONFIRM the rail is actually dead first…
    expect(c.hint).toContain("confirm");
    // …warn that resetting re-delivers Telegram's backlog…
    expect(c.hint).toContain("re-deliver");
    // …and name the file that actually exists.
    expect(c.hint).not.toContain("messages.db");
  });

  test("a gap no update volume explains still fails (10-day-outage class)", () => {
    // The detection this check exists for must survive the fix.
    const c = byName(
      buildHealthReport(
        healthyInputs({
          db: {
            exists: true,
            schemaVersion: SCHEMA_VERSION,
            updateOffset: 104700678 + 5_000_000,
            maxUpdateId: 104700678,
            inboundCount: 124,
          },
        }),
      ),
      "db_schema_current",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("update_offset");
  });
});

describe("token redaction belt (health-adapters)", () => {
  test("redactToken replaces every occurrence with the literal <TOKEN>", () => {
    const s = `Unable to connect. URL: https://api.telegram.org/bot${FAKE_TOKEN}/getWebhookInfo (${FAKE_TOKEN})`;
    const redacted = redactToken(s);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain("bot<TOKEN>/getWebhookInfo");
  });

  test("serializeHealthReport strips a token that leaked into a probe string", () => {
    const report = buildHealthReport(
      healthyInputs({
        webhook: {
          kind: "transport_error",
          detail: `fetch failed: https://api.telegram.org/bot${FAKE_TOKEN}/getWebhookInfo`,
        },
      }),
    );
    const out = serializeHealthReport(report);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain("<TOKEN>");
    // Still valid JSON in the shared contract shape.
    const parsed = JSON.parse(out);
    expect(parsed.package).toBe("claude-code-telegrammer");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
