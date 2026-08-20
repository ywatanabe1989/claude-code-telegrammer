/**
 * THE SEAM TEST — proves this repo can finally watch its own Telegram wire.
 *
 * Everything here asserts on OBSERVED REQUESTS arriving at a REAL HTTP server
 * bound to 127.0.0.1 (test/helpers/fake-telegram.ts). Nothing is mocked and no
 * `fetch` is patched: a real `bun` child process is spawned, told where the
 * Telegram API lives via CCT_TELEGRAM_API_BASE, and the only evidence used is
 * what actually landed on the socket.
 *
 * Why that distinction is the whole point: before this seam existed the base
 * URL was a module-load-time const, so every poller test in this repo could
 * only assert against injected fakes. Two live pollers fighting over one bot
 * token would have left all of them green — the suite had no way to see the
 * wire at all, which is how a 409-classification bug survived a month in
 * production behind passing tests. These tests fail if the process talks to
 * api.telegram.org instead of us, because then nothing arrives here.
 *
 * NOTE FOR THE POSITIVE CONTROL: this file deliberately imports NOTHING from
 * lib/ — only the test helper. Delete the override handling from
 * lib/api-root.ts and this file still compiles; it goes red because the
 * requests stop arriving, which is the only red worth having.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startFakeTelegram, FILE_DOWNLOAD } from "./helpers/fake-telegram.js";

const POLLER = join(import.meta.dir, "..", "telegram-poller.ts");
const EGRESS_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "api-egress-fixture.ts",
);

/** Distinct from preload.ts's "fake:token" so an observed token proves it is OURS. */
const SEAM_TOKEN = "seam:token";

/** Child env: hermetic state dir + our token + the override under test. */
function childEnv(
  stateDir: string,
  apiBase: string,
): Record<string, string | undefined> {
  return {
    ...process.env,
    // preload.ts purges CCT_* / CLAUDE_CODE_TELEGRAMMER_* from this process
    // and sets the canonical spellings, so overriding the canonical names here
    // cannot collide with a short alias (getenv throws on disagreement).
    CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR: stateDir,
    CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN: SEAM_TOKEN,
    // A REAL id, not "": the poller REFUSES TO START on an empty allowlist,
    // because every inbound would be rejected AND consumed. That refusal
    // landed after this fixture was written, so "" quietly turned the
    // spawn test into a 20s timeout — the poller exited before sending a
    // single getUpdates. The value is irrelevant to what these tests
    // observe (they watch EGRESS); it only has to be non-empty.
    CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS: "424242",
    CCT_TELEGRAM_API_BASE: apiBase,
  };
}

describe("CCT_TELEGRAM_API_BASE — the Telegram wire is observable", () => {
  test("the REAL poller process sends getUpdates to OUR 127.0.0.1 server", async () => {
    const fake = startFakeTelegram();
    const stateDir = mkdtempSync(join(tmpdir(), "cct-seam-poller-"));
    const child = Bun.spawn([process.execPath, "run", POLLER], {
      env: childEnv(stateDir, fake.url),
      stdout: "ignore",
      stderr: "pipe",
    });
    // Drain stderr continuously (an unread pipe can back-pressure the child)
    // and keep it for the failure message.
    const stderrText = new Response(child.stderr as ReadableStream).text();

    try {
      let poll;
      try {
        poll = await fake.waitFor("getUpdates", { timeoutMs: 20_000 });
      } catch (err) {
        child.kill("SIGKILL");
        throw new Error(
          `${err}\n--- poller stderr ---\n${await stderrText}` +
            `\n--- fake server: ${fake.url} ---`,
        );
      }

      // Observed on our socket — not "a function was called".
      expect(poll.verb).toBe("POST");
      expect(poll.pathname).toBe(`/bot${SEAM_TOKEN}/getUpdates`);
      expect(poll.token).toBe(SEAM_TOKEN);
      expect(poll.body?.timeout).toBe(30);
      expect(poll.body?.allowed_updates).toEqual([
        "message",
        "message_reaction",
      ]);

      // The whole startup handshake came here too — the override is not a
      // getUpdates-only patch. getUpdates is issued last, so by now these have
      // already arrived or they never will.
      expect(fake.calls("deleteWebhook").length).toBeGreaterThan(0);
      expect(fake.calls("getMe").length).toBeGreaterThan(0);

      // Nothing leaked to a path we did not model, and every request carried
      // OUR token — i.e. this really is the process we spawned.
      expect(fake.calls("UNMATCHED")).toEqual([]);
      expect(fake.requests.every((r) => r.token === SEAM_TOKEN)).toBe(true);
    } finally {
      // SIGKILL, not SIGTERM: the poller's handler sleeps 2s before exiting.
      child.kill("SIGKILL");
      await child.exited;
      await stderrText;
      await fake.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 45_000);

  test("EVERY egress site honours it — methods, getMe, multipart, file download, webhook probe", async () => {
    const fake = startFakeTelegram();
    const workDir = mkdtempSync(join(tmpdir(), "cct-seam-egress-"));
    try {
      const child = Bun.spawn(
        [process.execPath, "run", EGRESS_FIXTURE, workDir],
        {
          env: childEnv(workDir, fake.url),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
      ]);
      if (code !== 0) {
        throw new Error(
          `api-egress-fixture exited ${code}\n--- stdout ---\n${out}` +
            `\n--- stderr ---\n${err}`,
        );
      }
      expect(out).toContain("EGRESS_FIXTURE_OK");

      const seen = fake.requests.map((r) => r.method);
      // Five DIFFERENT code paths, only one of which is the tgApi funnel.
      expect(seen).toContain("sendChatAction"); // tgApi
      expect(seen).toContain("getMe"); // getMeRaw (own fetch)
      expect(seen).toContain("sendDocument"); // own multipart fetch
      expect(seen).toContain(FILE_DOWNLOAD); // FILE_BASE, other path shape
      expect(seen).toContain("getWebhookInfo"); // health-adapters (own fetch)

      // The file base is the one that used to be a second hardcoded literal:
      // check its exact shape, not just that something arrived.
      const download = fake.calls(FILE_DOWNLOAD)[0]!;
      expect(download.verb).toBe("GET");
      expect(download.pathname).toBe(
        `/file/bot${SEAM_TOKEN}/documents/seam-file.bin`,
      );

      expect(fake.calls("UNMATCHED")).toEqual([]);
      expect(fake.requests.every((r) => r.token === SEAM_TOKEN)).toBe(true);
    } finally {
      await fake.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 45_000);

  test("a malformed override REFUSES to start instead of falling back to the real API", async () => {
    const fake = startFakeTelegram();
    const stateDir = mkdtempSync(join(tmpdir(), "cct-seam-bad-"));
    try {
      const child = Bun.spawn([process.execPath, "run", POLLER], {
        env: childEnv(stateDir, "not a url"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([
        child.exited,
        new Response(child.stderr as ReadableStream).text(),
      ]);

      // Loud: non-zero exit, and a message naming the variable AND the value.
      expect(code).not.toBe(0);
      expect(err).toContain("CCT_TELEGRAM_API_BASE");
      expect(err).toContain("not a url");

      // Silent fallback is the failure mode being ruled out: a refusing
      // process must not have polled the default API either. It could not have
      // reached US, and it reported no successful start.
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
