/**
 * lib/notify-relay.ts — cross-process inbound-notification relay
 * (adversarial-review finding #3, follow-up to the poller/MCP-server
 * decoupling PR). Restores live-push delivery for interactive-CLI
 * (!wakeEnabled()) deployments after the poller became a separate process
 * with no mcp/Server object: the poller persists the notification payload
 * on the message's own row; the MCP-server process (this module) polls
 * for pending rows and delivers them.
 *
 * The relay DECISION logic (relayPendingNotificationsOnce) is thoroughly
 * covered below with injected dependencies. startNotifyRelay() (the
 * production timer wrapper) gets ONE direct test too — unlike
 * lib/poll-watchdog.ts::startStallWatchdog (untested directly; only its
 * pure createStallWatchdog is), this wrapper owns real scheduling
 * behaviour worth pinning: the reentrancy guard (round-2 adversarial-
 * review finding #1) that stops a slow/backlogged tick from overlapping
 * with the next scheduled one and double-relaying the same rows.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initStore, saveInbound } from "../lib/store.js";
import {
  savePendingNotification,
  relayPendingNotificationsOnce,
  startNotifyRelay,
  type PendingNotificationPayload,
} from "../lib/notify-relay.js";

const CHAT = "notify-relay-test-chat";

function fakeMcp() {
  const calls: Array<{ method: string; params: PendingNotificationPayload }> =
    [];
  return {
    mcp: {
      notification: async (n: {
        method: string;
        params: PendingNotificationPayload;
      }) => {
        calls.push(n);
      },
    } as any,
    calls,
  };
}

beforeAll(async () => {
  await initStore();
});

describe("savePendingNotification + relayPendingNotificationsOnce: real store round trip", () => {
  test("a saved pending row is relayed via mcp.notification, then cleared so it is not delivered twice", async () => {
    const rowId = await saveInbound({
      chat_id: CHAT,
      message_id: `msg-${Date.now()}`,
      user_id: "1",
      username: "op",
      text: "hello from the relay round-trip test",
      telegram_ts: new Date().toISOString(),
      host: "h",
      project: "p",
      agent_id: "a",
      bot_token_hash: "b",
      raw_json: "{}",
    });
    expect(rowId).not.toBeNull();

    const payload: PendingNotificationPayload = {
      content: "hello from the relay round-trip test",
      meta: { chat_id: CHAT, source: "cct" },
    };
    await savePendingNotification(rowId!, payload);

    const { mcp, calls } = fakeMcp();
    const delivered = await relayPendingNotificationsOnce({ mcp });
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(
      calls.some(
        (c) =>
          c.method === "notifications/claude/channel" &&
          c.params.content === "hello from the relay round-trip test" &&
          c.params.meta.chat_id === CHAT,
      ),
    ).toBe(true);

    // Second tick: this row's payload was cleared — must NOT be delivered
    // again (no double-delivery once relayed).
    const { mcp: mcp2, calls: calls2 } = fakeMcp();
    await relayPendingNotificationsOnce({ mcp: mcp2 });
    expect(calls2.some((c) => c.params.meta.chat_id === CHAT)).toBe(false);
  });
});

describe("relayPendingNotificationsOnce: injected deps (no real store)", () => {
  test("delivers each pending row in order and clears it", async () => {
    const rows = [
      {
        id: 1,
        pending_notification: JSON.stringify({ content: "a", meta: {} }),
      },
      {
        id: 2,
        pending_notification: JSON.stringify({ content: "b", meta: {} }),
      },
    ];
    const cleared: number[] = [];
    const { mcp, calls } = fakeMcp();

    const delivered = await relayPendingNotificationsOnce({
      mcp,
      getPending: () => rows,
      clearPending: (id) => cleared.push(id),
    });

    expect(delivered).toBe(2);
    expect(cleared).toEqual([1, 2]);
    expect(calls.map((c) => c.params.content)).toEqual(["a", "b"]);
  });

  test("a malformed pending_notification JSON is logged and left pending — never thrown", async () => {
    const rows = [{ id: 42, pending_notification: "not-json{{{" }];
    const cleared: number[] = [];
    const logs: Array<{ component: string; msg: string; data?: unknown }> = [];
    const { mcp, calls } = fakeMcp();

    const delivered = await relayPendingNotificationsOnce({
      mcp,
      getPending: () => rows,
      clearPending: (id) => cleared.push(id),
      logFn: (component, msg, data) => logs.push({ component, msg, data }),
    });

    expect(delivered).toBe(0);
    expect(cleared).toEqual([]);
    expect(calls.length).toBe(0);
    expect(
      logs.some((l) => (l.data as { row_id?: number })?.row_id === 42),
    ).toBe(true);
  });

  test("an mcp.notification rejection leaves the row pending for retry — never thrown", async () => {
    const rows = [
      {
        id: 7,
        pending_notification: JSON.stringify({ content: "x", meta: {} }),
      },
    ];
    const cleared: number[] = [];
    const mcp = {
      notification: async () => {
        throw new Error("simulated stdio write failure");
      },
    } as any;

    const delivered = await relayPendingNotificationsOnce({
      mcp,
      getPending: () => rows,
      clearPending: (id) => cleared.push(id),
    });

    expect(delivered).toBe(0);
    expect(cleared).toEqual([]);
  });

  test("one failing row does not block delivery of the others", async () => {
    const rows = [
      { id: 1, pending_notification: "bad-json" },
      {
        id: 2,
        pending_notification: JSON.stringify({ content: "good", meta: {} }),
      },
    ];
    const cleared: number[] = [];
    const { mcp, calls } = fakeMcp();

    const delivered = await relayPendingNotificationsOnce({
      mcp,
      getPending: () => rows,
      clearPending: (id) => cleared.push(id),
    });

    expect(delivered).toBe(1);
    expect(cleared).toEqual([2]);
    expect(calls.length).toBe(1);
  });

  test("no pending rows -> zero delivered, no calls at all", async () => {
    const { mcp, calls } = fakeMcp();
    const delivered = await relayPendingNotificationsOnce({
      mcp,
      getPending: () => [],
      clearPending: () => {
        throw new Error("must not be called when there is nothing pending");
      },
    });
    expect(delivered).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe("startNotifyRelay: reentrancy guard (round-2 adversarial-review finding #1)", () => {
  test("a tick slower than intervalMs never overlaps with the next scheduled tick — no row is relayed twice", async () => {
    // Realistic trigger: a long-lived detached poller accumulates a
    // backlog while no MCP-server session is running, then it drains in a
    // burst the moment a session connects — several rows in one tick,
    // comfortably over the poll interval. Simulated here with a SHORT
    // intervalMs (20ms) and a notification call slower than that (60ms
    // per row), so a bare `setInterval` (no reentrancy guard) would fire
    // several more times WHILE the first tick is still mid-flight,
    // re-relaying the still-uncleared rows.
    const rows = [
      {
        id: 1,
        pending_notification: JSON.stringify({ content: "row-1", meta: {} }),
      },
      {
        id: 2,
        pending_notification: JSON.stringify({ content: "row-2", meta: {} }),
      },
    ];
    const cleared = new Set<number>();
    const deliveryCounts: Record<string, number> = {};

    const getPending = () => rows.filter((r) => !cleared.has(r.id));
    const clearPending = (id: number) => cleared.add(id);
    const mcp = {
      notification: async (n: { params: PendingNotificationPayload }) => {
        deliveryCounts[n.params.content] =
          (deliveryCounts[n.params.content] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 60)); // slower than intervalMs
      },
    } as any;

    const handle = startNotifyRelay({ mcp, getPending, clearPending }, 20);
    try {
      // Let several 20ms intervals elapse while the (2 rows x 60ms =
      // ~120ms) first tick is still mid-flight, plus margin for a second
      // tick to run once the first one legitimately finishes.
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      handle.stop();
    }

    expect(cleared.size).toBe(2);
    expect(deliveryCounts["row-1"]).toBe(1);
    expect(deliveryCounts["row-2"]).toBe(1);
  });

  test("stop() prevents any further ticks, including one already scheduled", async () => {
    let getPendingCalls = 0;
    const { mcp } = fakeMcp();
    const handle = startNotifyRelay(
      {
        mcp,
        getPending: () => {
          getPendingCalls += 1;
          return [];
        },
      },
      15,
    );
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();
    const countAtStop = getPendingCalls;
    await new Promise((r) => setTimeout(r, 80));
    expect(getPendingCalls).toBe(countAtStop);
  });
});
