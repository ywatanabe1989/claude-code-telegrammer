/**
 * isNotificationPending() — the probe that decides whether to raise an alarm.
 *
 * Its doc comment promises "Returns false on any thrown error". That contract
 * MUST hold: the only caller (startNotifyRelay's tick → setTimeout callback)
 * has no outer try/catch — an escaping exception is an uncaught exception
 * that can take the whole poller/MCP-server process down. A probe whose
 * job is to decide whether to raise an alarm must never itself be the thing
 * that crashes.
 *
 * Shape copied from ts/test/notify-relay.test.ts (same test runner, same
 * describe/test structure, same import style).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initStore, DB_PATH } from "../lib/store.js";
import { isNotificationPending } from "../lib/notify-relay.js";

beforeAll(() => {
  initStore();
});

describe("isNotificationPending", () => {
  test("a row whose pending_notification is set returns true", () => {
    const db = new Database(DB_PATH);
    let rowId: number | undefined;
    try {
      const res = db.prepare(
        "INSERT INTO messages (direction, chat_id, message_id, user_id, username, text, telegram_ts, pending_notification) " +
          "VALUES ('inbound', 'np-set', 'np-1', '42', 'op', 'pending-msg', '2026-01-01T00:00:00Z', ?)",
      ).run(JSON.stringify({ content: "hello", meta: {} }));
      rowId = Number(res.lastInsertRowid);

      expect(isNotificationPending(rowId)).toBe(true);
    } finally {
      // Every test file shares one process and one database, so a row left
      // here is a row the next file sees. This one is pending on purpose,
      // which makes it exactly the kind another file's relay would pick up.
      try {
        if (rowId !== undefined) {
          db.prepare("DELETE FROM messages WHERE id = ?").run(rowId);
        }
      } finally {
        db.close();
      }
    }
  });

  test("a row whose pending_notification is NULL returns false", () => {
    const db = new Database(DB_PATH);
    let rowId: number | undefined;
    try {
      const res = db.prepare(
        "INSERT INTO messages (direction, chat_id, message_id, user_id, username, text, telegram_ts, pending_notification) " +
          "VALUES ('inbound', 'np-null', 'np-2', '42', 'op', 'cleared-msg', '2026-01-01T00:00:01Z', NULL)",
      ).run();
      rowId = Number(res.lastInsertRowid);

      expect(isNotificationPending(rowId)).toBe(false);
    } finally {
      try {
        if (rowId !== undefined) {
          db.prepare("DELETE FROM messages WHERE id = ?").run(rowId);
        }
      } finally {
        db.close();
      }
    }
  });

  test("an unopenable / missing database returns false and does NOT throw", () => {
    // Use the injectable dbPath seam: pass a path inside a directory that
    // does not exist, so bun:sqlite throws "unable to open database".
    // The shared DB is never touched.
    const impossiblePath = "/nonexistent/path/no-such-dir-at-all/messages.db";

    expect(() => isNotificationPending(999, impossiblePath)).not.toThrow();
    expect(isNotificationPending(999, impossiblePath)).toBe(false);
  });
});
