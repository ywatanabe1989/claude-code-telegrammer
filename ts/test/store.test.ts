/**
 * Tests for the PostgreSQL message store (store.ts).
 *
 * Every call is awaited now: the store crossed a process boundary onto a
 * real server, so nothing about it can be synchronous any more. The
 * namespace is the throwaway one ts/test/preload.ts minted for this
 * process, which is also what lib/hermetic-guard.ts checks before the store
 * will open at all.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  initStore,
  saveInbound,
  saveOutbound,
  getUnread,
  markRead,
  markAllRead,
  getHistory,
  saveOffset,
  loadOffset,
  searchMessages,
  getConversationContext,
} from "../lib/store.js";

describe("message store", () => {
  beforeAll(async () => {
    await initStore();
  });

  test("saveInbound stores a message and returns row id", async () => {
    const rowId = await saveInbound({
      chat_id: "100",
      message_id: "1",
      user_id: "42",
      username: "testuser",
      text: "Hello",
      telegram_ts: "2026-01-01T00:00:00Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    expect(rowId).not.toBeNull();
    expect(typeof rowId).toBe("number");
  });

  test("saveInbound deduplicates on (chat_id, message_id, direction)", async () => {
    const rowId = await saveInbound({
      chat_id: "100",
      message_id: "1",
      user_id: "42",
      username: "testuser",
      text: "Hello duplicate",
      telegram_ts: "2026-01-01T00:00:00Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    expect(rowId).toBeNull();
  });

  test("getUnread returns unread inbound messages", async () => {
    const unread = await getUnread();
    expect(unread.length).toBeGreaterThanOrEqual(1);
    // bun runs test files in one process and shares the singleton store,
    // so other *.test.ts files may have inserted rows ahead of "Hello".
    // Locate it by text rather than positional index.
    const hello = unread.find((r) => r.text === "Hello");
    expect(hello).toBeDefined();
    expect(hello!.read_at).toBeNull();
  });

  test("getUnread filters by chat_id", async () => {
    const unread = await getUnread("100");
    expect(unread.length).toBeGreaterThanOrEqual(1);
    const unreadOther = await getUnread("999");
    expect(unreadOther.length).toBe(0);
  });

  test("markRead marks a single message as read", async () => {
    const unread = await getUnread("100");
    const id = unread[0].id as number;
    await markRead(id);
    const afterMark = await getUnread("100");
    expect(afterMark.length).toBe(0);
  });

  test("saveOutbound stores outbound message", async () => {
    const rowId = await saveOutbound("100", "Reply text", "msg-out-1", undefined, {
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
    });
    expect(typeof rowId).toBe("number");
  });

  test("saveOutbound with replyToRowId marks inbound as replied", async () => {
    const inboundId = await saveInbound({
      chat_id: "200",
      message_id: "10",
      user_id: "42",
      username: "testuser",
      text: "Question",
      telegram_ts: "2026-01-01T00:00:01Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    expect(inboundId).not.toBeNull();

    await saveOutbound("200", "Answer", "msg-out-11", inboundId!, {
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
    });

    const history = await getHistory("200");
    const inbound = history.find((r) => r.id === inboundId);
    expect(inbound?.replied_at).not.toBeNull();
  });

  test("markAllRead marks all messages in a chat as read", async () => {
    await saveInbound({
      chat_id: "300",
      message_id: "20",
      user_id: "42",
      username: "testuser",
      text: "Msg A",
      telegram_ts: "2026-01-01T00:00:02Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    await saveInbound({
      chat_id: "300",
      message_id: "21",
      user_id: "42",
      username: "testuser",
      text: "Msg B",
      telegram_ts: "2026-01-01T00:00:03Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });

    expect((await getUnread("300")).length).toBe(2);
    await markAllRead("300");
    expect((await getUnread("300")).length).toBe(0);
  });

  test("getHistory returns messages in chronological order", async () => {
    const history = await getHistory("300");
    expect(history.length).toBe(2);
    expect((history[0].id as number) < (history[1].id as number)).toBe(true);
  });

  test("getHistory respects limit and offset", async () => {
    const page1 = await getHistory("300", 1, 0);
    expect(page1.length).toBe(1);
    const page2 = await getHistory("300", 1, 1);
    expect(page2.length).toBe(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  test("offset persistence round-trips", async () => {
    await saveOffset(12345);
    expect(await loadOffset()).toBe(12345);
    await saveOffset(99999);
    expect(await loadOffset()).toBe(99999);
  });

  test("searchMessages finds by text", async () => {
    const results = await searchMessages("Hello");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toBe("Hello");
  });

  test("searchMessages filters by chat_id", async () => {
    const results = await searchMessages("Msg", "300");
    expect(results.length).toBe(2);
    const resultsOther = await searchMessages("Msg", "999");
    expect(resultsOther.length).toBe(0);
  });

  test("getConversationContext formats messages", async () => {
    const ctx = await getConversationContext("300", 10);
    expect(ctx).toContain("Msg A");
    expect(ctx).toContain("Msg B");
    expect(ctx).toContain("(user)");
  });

  test("saveInbound persists forward_json column round-trip", async () => {
    const forwardJson = JSON.stringify({
      kind: "channel",
      from_name: "News Channel",
      from_id: "-1009876543210",
      date_iso: "2024-06-05T04:33:20.000Z",
      original_message_id: "999",
    });
    const rowId = await saveInbound({
      chat_id: "400",
      message_id: "30",
      user_id: "42",
      username: "testuser",
      text: "[forwarded from News Channel, 2024-06-05T04:33:20.000Z]\nbody",
      telegram_ts: "2026-01-01T00:00:05Z",
      forward_json: forwardJson,
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    expect(rowId).not.toBeNull();

    const history = await getHistory("400");
    expect(history.length).toBe(1);
    expect(history[0].forward_json).toBe(forwardJson);
  });

  test("saveInbound without forward_json stores null", async () => {
    const rowId = await saveInbound({
      chat_id: "401",
      message_id: "31",
      user_id: "42",
      username: "testuser",
      text: "plain message",
      telegram_ts: "2026-01-01T00:00:06Z",
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
      raw_json: "{}",
    });
    expect(rowId).not.toBeNull();
    const history = await getHistory("401");
    expect(history[0].forward_json).toBeNull();
  });
});
