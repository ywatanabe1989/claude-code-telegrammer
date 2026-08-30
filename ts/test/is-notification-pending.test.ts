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
import { initStore } from "../lib/store.js";
import { isNotificationPending } from "../lib/notify-relay.js";
import { insertRow, query } from "./helpers/store-access.js";

beforeAll(async () => {
  await initStore();
});

describe("isNotificationPending", () => {
  test("a row whose pending_notification is set returns true", async () => {
    let rowId: number | undefined;
    try {
      rowId = await insertRow(
        "INSERT INTO ${SCHEMA}.messages (direction, chat_id, message_id," +
          " user_id, username, text, telegram_ts, pending_notification)" +
          " VALUES ('inbound', 'np-set', 'np-1', '42', 'op', 'pending-msg'," +
          " '2026-01-01T00:00:00Z', $1) RETURNING id",
        [JSON.stringify({ content: "hello", meta: {} })],
      );

      expect(await isNotificationPending(rowId)).toBe(true);
    } finally {
      // Every test file shares one process and one namespace, so a row left
      // here is a row the next file sees. This one is pending on purpose,
      // which makes it exactly the kind another file's relay would pick up.
      if (rowId !== undefined) {
        await query("DELETE FROM ${SCHEMA}.messages WHERE id = $1", [rowId]);
      }
    }
  });

  test("a row whose pending_notification is NULL returns false", async () => {
    let rowId: number | undefined;
    try {
      rowId = await insertRow(
        "INSERT INTO ${SCHEMA}.messages (direction, chat_id, message_id," +
          " user_id, username, text, telegram_ts, pending_notification)" +
          " VALUES ('inbound', 'np-null', 'np-2', '42', 'op', 'cleared-msg'," +
          " '2026-01-01T00:00:01Z', NULL) RETURNING id",
      );

      expect(await isNotificationPending(rowId)).toBe(false);
    } finally {
      if (rowId !== undefined) {
        await query("DELETE FROM ${SCHEMA}.messages WHERE id = $1", [rowId]);
      }
    }
  });

  test("an unreadable store returns false and does NOT throw", async () => {
    // Use the injectable schema seam: point at a namespace that does not
    // exist, so the query errors the way an unreachable or misconfigured
    // store would. The shared namespace is never touched.
    const missing = "cct_test_no_such_namespace_at_all";

    expect(await isNotificationPending(999, missing)).toBe(false);
  });

  test("a row id that does not exist returns false", async () => {
    // Distinct from the error case above and worth its own line: "no such
    // row" must be a plain false, not an exception and not a true.
    expect(await isNotificationPending(2_000_000_000)).toBe(false);
  });
});
