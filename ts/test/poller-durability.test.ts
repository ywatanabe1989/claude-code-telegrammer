/**
 * Durability fix PR-B: the getUpdates offset must NEVER advance past an
 * inbound update whose DB persistence FAILED, so Telegram redelivers it
 * on the next poll instead of the message being silently lost forever.
 *
 * These tests drive poller-batch.ts::processBatch directly — the module
 * that owns the "advance vs stop" decision. The injected handler mirrors
 * handleUpdate's exact persistence contract:
 *
 *     try { rowId = saveInbound(...) } catch { return "persistError" }
 *     return rowId === null ? "duplicate" : "ok";
 *
 * so a designated update literally simulates saveInbound THROWING while
 * its neighbours persist real rows against a real store. No
 * network is touched (the wake/receipt paths of the real handleUpdate
 * are deliberately not exercised — this is a pure test of the offset /
 * retry / loud-notification logic).
 *
 * Architecture fix (2026-07, incident-cct-inbound-dies-silently-with-mcp-
 * server-20260711): processBatch no longer takes an `mcp: Server` parameter
 * — the standalone poller process has no mcp object at all. Loud
 * notifications now broadcast directly to Telegram (poller-batch.ts::
 * emitLoud → lib/loudfail.ts::broadcastSystemAlert), so these tests
 * intercept THAT seam (setSystemAlertSender) instead of a fake
 * mcp.notification.
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
import { initStore, saveInbound, getUnread } from "../lib/store.js";
import {
  processBatch,
  _resetPersistFailures,
  MAX_PERSIST_RETRIES,
} from "../lib/poller-batch.js";
import type { UpdateStatus } from "../lib/handle-update.js";
import {
  setSystemAlertSender,
  _resetSystemAlertSender,
} from "../lib/loudfail.js";
import { _resetCache } from "../lib/access.js";
import { ACCESS_FILE, STATE_DIR } from "../lib/config.js";

const CHAT = "7700";
const ALERT_RECIPIENT = "999000111";

/** A recording stand-in for loudfail's direct-Telegram broadcast seam. */
function captureAlerts(): Array<{ chatId: string; text: string }> {
  const alerts: Array<{ chatId: string; text: string }> = [];
  setSystemAlertSender(async (chatId, text) => {
    alerts.push({ chatId, text });
    return { ok: true };
  });
  return alerts;
}

function textUpdate(updateId: number, messageId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false, first_name: "Op", username: "op" },
      chat: { id: Number(CHAT), type: "private" },
      date: 1720400000,
      text: `msg ${messageId}`,
    },
  };
}

/**
 * Handler that mirrors handleUpdate's persistence contract. Updates whose
 * update_id is in `throwIds` simulate saveInbound THROWING (→
 * "persistError"); every other update persists a real row and returns
 * "ok" (or "duplicate" if saveInbound reported an existing row).
 */
function persistingHandler(throwIds: Set<number>) {
  return async (update: any): Promise<UpdateStatus> => {
    try {
      if (throwIds.has(update.update_id)) {
        throw new Error("simulated DB failure");
      }
      const msg = update.message;
      const rowId = await saveInbound({
        chat_id: CHAT,
        message_id: String(msg.message_id),
        user_id: "42",
        username: "op",
        text: msg.text,
        telegram_ts: new Date(msg.date * 1000).toISOString(),
        host: "h",
        project: "p",
        agent_id: "a",
        bot_token_hash: "b",
        raw_json: JSON.stringify(update),
      });
      return rowId === null ? "duplicate" : "ok";
    } catch {
      return "persistError";
    }
  };
}

/** Always-fail handler for the retry-then-skip test. */
async function alwaysPersistError(): Promise<UpdateStatus> {
  return "persistError";
}

async function storedMessageIds(): Promise<Set<string>> {
  return new Set((await getUnread(CHAT)).map((r) => String(r.message_id)));
}

beforeAll(async () => {
  await initStore();
  // broadcastSystemAlert defaults its recipients to loadAccess().allowFrom;
  // give it a non-empty allowlist so these tests actually exercise the send
  // path instead of hitting the "no recipients" no-op branch. Undone in
  // afterAll so later test files see the same absent-access.json default
  // preload.ts's fresh TEST_DIR starts with.
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: [ALERT_RECIPIENT] }));
  _resetCache();
});

afterAll(() => {
  _resetSystemAlertSender();
  rmSync(ACCESS_FILE, { force: true });
  _resetCache();
});

beforeEach(() => {
  // The consecutive-failure tracker is module-global — isolate each test.
  _resetPersistFailures();
});

describe("processBatch never advances past an un-persisted update", () => {
  test("stops at the failed update; preceding successes persist, rest deferred", async () => {
    const alerts = captureAlerts();
    // u1 persists, u2 THROWS (persist error), u3 would persist but is
    // deferred because we stop at u2.
    const u1 = textUpdate(5001, 7001);
    const u2 = textUpdate(5010, 7002);
    const u3 = textUpdate(5020, 7003);
    const handle = persistingHandler(new Set([u2.update_id]));

    const newOffset = await processBatch([u1, u2, u3], u1.update_id, handle);

    // Offset left AT the failed update_id — NOT advanced past it, so
    // Telegram redelivers u2 (and u3) on the next poll.
    expect(newOffset).toBe(u2.update_id);
    expect(newOffset).toBeLessThan(u2.update_id + 1);

    // The preceding success is durably stored; the failed + deferred
    // updates are NOT.
    const ids = await storedMessageIds();
    expect(ids.has("7001")).toBe(true); // u1 persisted
    expect(ids.has("7002")).toBe(false); // u2 threw
    expect(ids.has("7003")).toBe(false); // u3 deferred (never handled)

    // A LOUD alert broadcast directly to Telegram fired for the persist
    // failure (no mcp/Server object involved at all).
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const loud = alerts[alerts.length - 1];
    expect(loud.chatId).toBe(ALERT_RECIPIENT);
    expect(loud.text).toContain("NOT");
    expect(loud.text).toContain(String(u2.update_id));
  });

  test("an all-success batch advances past every update", async () => {
    const u1 = textUpdate(5101, 7101);
    const u2 = textUpdate(5102, 7102);
    const handle = persistingHandler(new Set());

    const newOffset = await processBatch([u1, u2], u1.update_id, handle);
    expect(newOffset).toBe(u2.update_id + 1);
  });

  test("a duplicate (saveInbound → null) is durable → advances", async () => {
    const u = textUpdate(5201, 7201);
    const handle = persistingHandler(new Set());
    // Pre-store the row so the second attempt returns null (duplicate).
    await processBatch([u], u.update_id, handle);

    const newOffset = await processBatch([u], u.update_id, handle);
    // duplicate is NOT a persistError — safe to advance past it.
    expect(newOffset).toBe(u.update_id + 1);
  });
});

describe("retry-then-loud-skip after N consecutive failures", () => {
  test(`holds the offset for ${MAX_PERSIST_RETRIES - 1} tries, then SKIPS loudly on the Nth`, async () => {
    const alerts = captureAlerts();
    const u = textUpdate(5301, 7301);

    // Attempts 1..(N-1): offset stays AT the failed update_id.
    for (let attempt = 1; attempt < MAX_PERSIST_RETRIES; attempt++) {
      const off = await processBatch([u], u.update_id, alwaysPersistError);
      expect(off).toBe(u.update_id);
    }

    const before = alerts.length;

    // Attempt N: FATAL loud + advance PAST the poison update (skip).
    const off = await processBatch([u], u.update_id, alwaysPersistError);
    expect(off).toBe(u.update_id + 1);

    const fatal = alerts[alerts.length - 1];
    expect(alerts.length).toBeGreaterThan(before);
    expect(fatal.text).toContain("FATAL");
    expect(fatal.text).toContain("SKIPPING");
  });

  test("a success resets the counter (fresh update starts at attempt 1)", async () => {
    const u = textUpdate(5401, 7401);

    // Rack up (N-1) failures, then a success resets the tracker.
    for (let attempt = 1; attempt < MAX_PERSIST_RETRIES; attempt++) {
      await processBatch([u], u.update_id, alwaysPersistError);
    }
    await processBatch(
      [textUpdate(5402, 7402)],
      5402,
      persistingHandler(new Set()),
    );

    // The next failure for u must be treated as attempt 1 again — i.e.
    // the offset is HELD (not skipped), proving the counter reset.
    const off = await processBatch([u], u.update_id, alwaysPersistError);
    expect(off).toBe(u.update_id);
  });
});
