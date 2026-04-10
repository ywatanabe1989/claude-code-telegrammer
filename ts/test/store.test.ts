/**
 * Tests for SQLite message store (store.ts)
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
  beforeAll(() => {
    initStore();
  });

  test("saveInbound stores a message and returns row id", () => {
    const rowId = saveInbound({
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

  test("saveInbound deduplicates on (chat_id, message_id, direction)", () => {
    const rowId = saveInbound({
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

  test("getUnread returns unread inbound messages", () => {
    const unread = getUnread();
    expect(unread.length).toBeGreaterThanOrEqual(1);
    expect(unread[0].text).toBe("Hello");
    expect(unread[0].read_at).toBeNull();
  });

  test("getUnread filters by chat_id", () => {
    const unread = getUnread("100");
    expect(unread.length).toBeGreaterThanOrEqual(1);
    const unreadOther = getUnread("999");
    expect(unreadOther.length).toBe(0);
  });

  test("markRead marks a single message as read", () => {
    const unread = getUnread("100");
    const id = unread[0].id as number;
    markRead(id);
    const afterMark = getUnread("100");
    expect(afterMark.length).toBe(0);
  });

  test("saveOutbound stores outbound message", () => {
    const rowId = saveOutbound("100", "Reply text", "msg-out-1", undefined, {
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
    });
    expect(typeof rowId).toBe("number");
  });

  test("saveOutbound with replyToRowId marks inbound as replied", () => {
    const inboundId = saveInbound({
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

    saveOutbound("200", "Answer", "msg-out-11", inboundId!, {
      host: "testhost",
      project: "/test",
      agent_id: "test",
      bot_token_hash: "abcd1234",
    });

    const history = getHistory("200");
    const inbound = history.find((r) => r.id === inboundId);
    expect(inbound?.replied_at).not.toBeNull();
  });

  test("markAllRead marks all messages in a chat as read", () => {
    saveInbound({
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
    saveInbound({
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

    expect(getUnread("300").length).toBe(2);
    markAllRead("300");
    expect(getUnread("300").length).toBe(0);
  });

  test("getHistory returns messages in chronological order", () => {
    const history = getHistory("300");
    expect(history.length).toBe(2);
    expect((history[0].id as number) < (history[1].id as number)).toBe(true);
  });

  test("getHistory respects limit and offset", () => {
    const page1 = getHistory("300", 1, 0);
    expect(page1.length).toBe(1);
    const page2 = getHistory("300", 1, 1);
    expect(page2.length).toBe(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  test("offset persistence round-trips", () => {
    saveOffset(12345);
    expect(loadOffset()).toBe(12345);
    saveOffset(99999);
    expect(loadOffset()).toBe(99999);
  });

  test("searchMessages finds by text", () => {
    const results = searchMessages("Hello");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toBe("Hello");
  });

  test("searchMessages filters by chat_id", () => {
    const results = searchMessages("Msg", "300");
    expect(results.length).toBe(2);
    const resultsOther = searchMessages("Msg", "999");
    expect(resultsOther.length).toBe(0);
  });

  test("getConversationContext formats messages", () => {
    const ctx = getConversationContext("300", 10);
    expect(ctx).toContain("Msg A");
    expect(ctx).toContain("Msg B");
    expect(ctx).toContain("(user)");
  });
});
