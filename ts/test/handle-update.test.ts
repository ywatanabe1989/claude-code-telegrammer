/**
 * lib/handle-update.ts — post-split migration off `mcp` (architecture fix,
 * incident-cct-inbound-dies-silently-with-mcp-server-20260711, 2026-07).
 *
 * handleReaction/handleUpdate no longer take an `mcp: Server` parameter —
 * the standalone poller process (ts/telegram-poller.ts) that now runs them
 * has no mcp/Server object at all. handleReaction's `mcp.notification(...)`
 * push is replaced by reusing the already mcp-independent /v1/turn wake POST
 * (lib/wake.ts::wakeTurn) — these tests pin THAT wiring via wakeTurn's
 * injectable turnPoster seam (setTurnPoster), the same seam ts/test/wake.test.ts
 * already uses.
 *
 * NOTE on coverage limits: ts/test/preload.ts fixes
 * CLAUDE_CODE_TELEGRAMMER_TURN_URL to a non-empty fake URL for the WHOLE test
 * process (TURN_URL is a module-load-time constant — see lib/config.ts), so
 * wakeEnabled() is always true here. This matches wake.test.ts's own
 * documented limitation ("the env-gated branch is exercised via the
 * injectable poster contract that does not depend on TURN_URL being set")
 * — the interactive-CLI (!wakeEnabled(), no TURN_URL) log-only fallback
 * paths in handleReaction/handleUpdate are NOT exercised by this bun:test
 * process for the same structural reason and are covered by code review
 * only (a single `log(...)` call, no branching complexity).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { initStore, getHistory } from "../lib/store.js";
import { _resetCache } from "../lib/access.js";
import { ACCESS_FILE, STATE_DIR } from "../lib/config.js";
import { setTurnPoster, wakeEnabled, type WakeMeta } from "../lib/wake.js";
import { handleReaction, handleUpdate } from "../lib/handle-update.js";
import { relayPendingNotificationsOnce } from "../lib/notify-relay.js";
import { setLoudFailSender, _resetLoudFail } from "../lib/loudfail.js";

const USER_ID = "8675309";
const CHAT_ID = "8675309";

type TurnCall = { url: string; body: { text: string }; bearer: string };

function captureTurnCalls(status: number = 200): TurnCall[] {
  const calls: TurnCall[] = [];
  setTurnPoster(async (url, body, bearer) => {
    calls.push({ url, body, bearer });
    return status;
  });
  return calls;
}

function reactionUpdate(emoji: string, messageId: number) {
  return {
    update_id: 1,
    message_reaction: {
      chat: { id: Number(CHAT_ID), type: "private" },
      message_id: messageId,
      user: { id: Number(USER_ID), username: "alice" },
      date: 1717000000,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji }],
    },
  };
}

beforeAll(async () => {
  await initStore();
  expect(wakeEnabled()).toBe(true); // sanity: see the NOTE above.
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: [USER_ID] }));
  _resetCache();
});

afterAll(() => {
  rmSync(ACCESS_FILE, { force: true });
  _resetCache();
});

beforeEach(() => {
  captureTurnCalls(); // reset to a fresh, default (200) poster before each test
});

describe("handleReaction: migrated off mcp.notification onto wakeTurn", () => {
  test("an allowlisted reaction is delivered via the /v1/turn wake POST", async () => {
    const calls = captureTurnCalls();
    await handleReaction(reactionUpdate("👍", 42));

    expect(calls.length).toBe(1);
    expect(calls[0].body.text).toContain("<channel");
    expect(calls[0].body.text).toContain("(reaction: 👍 on message 42)");
    expect(calls[0].body.text).toContain(`chat_id="${CHAT_ID}"`);
  });

  test("a reaction from a user NOT in the allowlist is rejected — no wake POST", async () => {
    const calls = captureTurnCalls();
    const update = reactionUpdate("👍", 43);
    update.message_reaction.user.id = 999999999; // not allowlisted
    await handleReaction(update);
    expect(calls.length).toBe(0);
  });

  test("a reaction with no emoji entries is a no-op — no wake POST", async () => {
    const calls = captureTurnCalls();
    const update = reactionUpdate("👍", 44);
    update.message_reaction.new_reaction = []; // stripped
    await handleReaction(update);
    expect(calls.length).toBe(0);
  });

  test("a wakeTurn failure is swallowed — handleReaction never throws", async () => {
    setTurnPoster(async () => {
      throw new Error("simulated connection refused");
    });
    await expect(
      handleReaction(reactionUpdate("🎉", 45)),
    ).resolves.toBeUndefined();
  });

  test("handleUpdate dispatches message_reaction updates to handleReaction and always reports ok", async () => {
    const calls = captureTurnCalls();
    const status = await handleUpdate(reactionUpdate("🔥", 46));
    expect(status).toBe("ok");
    expect(calls.length).toBe(1);
  });
});

describe("handleUpdate: regular text message still reaches wakeTurn (mcp removed from the signature)", () => {
  test("a plain allowlisted text message persists AND wakes the agent", async () => {
    const calls = captureTurnCalls();
    const update = {
      update_id: 2,
      message: {
        message_id: 100,
        from: { id: Number(USER_ID), is_bot: false, username: "alice" },
        chat: { id: Number(CHAT_ID), type: "private" },
        date: 1717000100,
        text: "hello from the split poller",
      },
    };

    const status = await handleUpdate(update);
    expect(status).toBe("ok");

    // Durably persisted regardless of wake outcome.
    const history = await getHistory(CHAT_ID, 50, 0);
    expect(history.some((r) => r.text === "hello from the split poller")).toBe(
      true,
    );

    // Delivered via the mcp-independent wake POST — handleUpdate no longer
    // takes (or needs) an mcp/Server argument at all.
    expect(calls.length).toBe(1);
    expect(calls[0].body.text).toContain("hello from the split poller");
  });
});

/**
 * incident-cct-operator-messages-not-arriving-20260714.
 *
 * The wake POST targets sac's a2a sidecar. A failed wake used to end at
 * "mark ❌ + loud-fail reply", with the message itself DROPPED — the
 * getUpdates offset had already advanced, so nothing redelivered it and the
 * operator had to notice the failure and resend by hand. That made sac's
 * sidecar a single point of failure on his ONLY channel to the fleet.
 *
 * A failed wake now also persists the payload for the MCP-server-side notify
 * relay, which reaches an attached session WITHOUT going through sac.
 */
describe("handleUpdate: a failed wake falls back to the notify relay", () => {
  /** Let the fire-and-forget `void wakeTurn(...).then(...)` chain settle. */
  const settleWake = () => new Promise((r) => setTimeout(r, 10));

  function textUpdate(updateId: number, messageId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: messageId,
        from: { id: Number(USER_ID), is_bot: false, username: "alice" },
        chat: { id: Number(CHAT_ID), type: "private" },
        date: 1717000200,
        text,
      },
    };
  }

  function collectRelayed() {
    const delivered: unknown[] = [];
    const mcp = {
      notification: async (n: unknown) => {
        delivered.push(n);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { delivered, mcp: mcp as any };
  }

  test("wake FAILURE still delivers via relay — no per-message loud-fail reply", async () => {
    const loudFails: string[] = [];
    setLoudFailSender(async (_chatId, text) => {
      loudFails.push(text); // stubbed: a test must never post to real Telegram
    });
    captureTurnCalls(503); // sac's sidecar is down

    const text = "sent while the sidecar was down";
    expect(await handleUpdate(textUpdate(3, 101, text))).toBe("ok");
    await settleWake();

    const { delivered, mcp } = collectRelayed();
    const relayed = await relayPendingNotificationsOnce({ mcp });

    // The message survived the sidecar being down.
    expect(relayed).toBe(1);
    expect(JSON.stringify(delivered)).toContain(text);

    // No per-message loud-fail reply because the relay delivered the message.
    // The outage is still surfaced — recordWakeFailure() still runs first and
    // unchanged in this branch, and lib/wake-health.ts counts consecutive wake
    // failures and calls broadcastSystemAlert() once a threshold is crossed,
    // so the outage is announced ONCE for the outage, not once per message.
    expect(loudFails.length).toBe(0);

    _resetLoudFail();
  });

  test("wake SUCCESS queues nothing (no 'sent twice' regression)", async () => {
    captureTurnCalls(200); // healthy sidecar

    const text = "sent while the sidecar was healthy";
    expect(await handleUpdate(textUpdate(4, 102, text))).toBe("ok");
    await settleWake();

    const { delivered, mcp } = collectRelayed();
    await relayPendingNotificationsOnce({ mcp });

    // A healthy wake-enabled agent still has exactly ONE delivery path. If
    // this ever fails, the operator is getting every message twice again
    // (his 2026-06-18 report), which is why the relay must stay failure-only.
    expect(JSON.stringify(delivered)).not.toContain(text);
  });
});
