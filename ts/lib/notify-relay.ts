/**
 * Cross-process relay for inbound messages that could not be live-pushed
 * at ingestion time (adversarial-review finding #3, follow-up to the
 * poller/MCP-server decoupling PR).
 *
 * Interactive-CLI (no TURN_URL / !wakeEnabled()) deployments used to
 * receive inbound Telegram messages as a live `mcp.notification()` push
 * straight from the poller's own lib/handle-update.ts, rendering into an
 * ACTIVE turn. Once the poller became a separate process
 * (ts/telegram-poller.ts) with no mcp/Server object at all, that direct
 * push became categorically impossible from there — a separate OS process
 * cannot call a method on another process's live MCP stdio connection.
 * The first cut of this decoupling PR left this as a documented gap
 * (message durably saved, but not live-pushed). This module closes it.
 *
 * The fix mirrors lib/wake-health.ts's own cross-process pattern: the
 * WRITER (the poller process, via lib/handle-update.ts::savePendingNotification)
 * persists the fully-built notification payload (content + meta) onto the
 * message's own row in the shared SQLite store, using an independent DB
 * handle (same "many handles, one WAL file" pattern as
 * lib/attachments.ts::getDb() / lib/health-adapters.ts::probeDb()) rather
 * than growing lib/store.ts (already at this repo's per-file line cap).
 * The READER (THIS module, running in the MCP-server process, which still
 * holds the live `mcp` object throughout an interactive session) polls for
 * pending rows and calls mcp.notification() itself, then clears the
 * payload once delivered — restoring the ORIGINAL live-push behaviour via
 * a short (default 1s) delay instead of an immediate call, the necessary
 * cost of the payload having to cross a process boundary via disk instead
 * of a function call.
 *
 * Only ever populated for !wakeEnabled() deployments (see
 * lib/handle-update.ts) — wake-enabled agents deliver via the already
 * mcp-independent /v1/turn POST and never write here, so this relay simply
 * finds nothing to do for them; started only when !wakeEnabled() in
 * ts/telegram-server.ts to avoid a pointless poll for the common
 * (wake-enabled fleet) case.
 */

import { Database } from "bun:sqlite";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DB_PATH } from "./store.js";
import { log } from "./log.js";

export interface PendingNotificationPayload {
  content: string;
  meta: Record<string, string>;
}

/**
 * WRITER side — called from lib/handle-update.ts (standalone poller
 * process). Persists the fully-built notification payload VERBATIM on the
 * message's own row, so the reader delivers EXACTLY what the old direct
 * push would have (including the attachment descriptor appended to
 * `deliveredText`, which is not itself a separate stored column) — no
 * re-derivation needed on the reader side. Best-effort: a write failure is
 * logged, never thrown — must not crash inbound message handling over a
 * delivery-relay concern.
 */
export function savePendingNotification(
  rowId: number,
  payload: PendingNotificationPayload,
): void {
  try {
    const db = new Database(DB_PATH);
    try {
      // busy_timeout is per-CONNECTION, not inherited from the file's
      // WAL-mode schema (adversarial-review finding #6) — every ad hoc
      // handle in this module sets it explicitly for the same reason.
      db.exec("PRAGMA busy_timeout = 5000;");
      db.prepare(
        "UPDATE messages SET pending_notification = ? WHERE id = ?",
      ).run(JSON.stringify(payload), rowId);
    } finally {
      db.close();
    }
  } catch (err) {
    log("notify-relay", "failed to persist pending notification", {
      row_id: rowId,
      error: String(err),
    });
  }
}

/**
 * Check whether a notification saved via savePendingNotification() is still
 * pending (i.e. the notify-relay reader has not yet delivered and NULLed
 * the column). Returns true when the row exists AND its
 * pending_notification is not null. Returns false on any thrown error so a
 * broken probe never creates a false alarm.
 *
 * @param rowId - The messages.row to check.
 * @param dbPath - The database file to open. Defaults to DB_PATH. Injected
 *   as an optional second parameter so tests can target a non-existent path
 *   (e.g. inside a directory that does not exist) without touching the
 *   shared database used by the whole suite.
 */
export function isNotificationPending(
  rowId: number,
  dbPath: string = DB_PATH,
): boolean {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db
      .prepare("SELECT pending_notification FROM messages WHERE id = ?")
      .get(rowId) as { pending_notification: string | null } | undefined;
    return !!row && row.pending_notification !== null;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

interface PendingRow {
  id: number;
  pending_notification: string;
}

/** READONLY read of currently-pending rows — never mutates, safe against
 * the live poller's WAL, same precedent as health-adapters.ts::probeDb(). */
function readPendingRows(): PendingRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return db
      .prepare(
        "SELECT id, pending_notification FROM messages " +
          "WHERE pending_notification IS NOT NULL ORDER BY id",
      )
      .all() as PendingRow[];
  } finally {
    db.close();
  }
}

function clearPendingRow(id: number): void {
  const db = new Database(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.prepare(
      "UPDATE messages SET pending_notification = NULL WHERE id = ?",
    ).run(id);
  } finally {
    db.close();
  }
}

export interface NotifyRelayDeps {
  mcp: Server;
  /** Injectable for tests; defaults to a real readPendingRows() call. */
  getPending?: () => PendingRow[];
  /** Injectable for tests; defaults to a real clearPendingRow() call. */
  clearPending?: (id: number) => void;
  logFn?: typeof log;
}

/**
 * READER side — called from ts/telegram-server.ts, which holds the live
 * mcp object throughout the process lifetime. One poll tick: relay every
 * currently-pending notification, oldest first, then clear it. Exported
 * separately from startNotifyRelay() so the relay DECISION is unit-
 * testable without a real timer (same injectable-seam pattern
 * poller-batch.ts / poll-watchdog.ts already use).
 */
export async function relayPendingNotificationsOnce(
  deps: NotifyRelayDeps,
): Promise<number> {
  const getPending = deps.getPending ?? readPendingRows;
  const clearPending = deps.clearPending ?? clearPendingRow;
  const logFn = deps.logFn ?? log;

  let delivered = 0;
  for (const row of getPending()) {
    try {
      const payload = JSON.parse(
        row.pending_notification,
      ) as PendingNotificationPayload;
      await deps.mcp.notification({
        method: "notifications/claude/channel",
        params: payload,
      });
      clearPending(row.id);
      delivered += 1;
    } catch (err) {
      // Leave the row pending — retried on the next tick. Logged, never
      // thrown (must not crash the relay loop or the MCP server).
      logFn("notify-relay", "failed to relay a pending notification", {
        row_id: row.id,
        error: String(err),
      });
    }
  }
  return delivered;
}

export interface NotifyRelayHandle {
  stop(): void;
}

/**
 * Production entry point: poll every intervalMs (default 1000ms), unref'd
 * so it never keeps the MCP server process alive on its own. Called from
 * ts/telegram-server.ts only when !wakeEnabled().
 *
 * SELF-RESCHEDULING, not a bare setInterval (round-2 adversarial-review
 * finding #1 — real duplicate delivery, confirmed via
 * ts/test/notify-relay.test.ts): relayPendingNotificationsOnce takes a
 * snapshot then sequentially awaits mcp.notification()+clearPending() per
 * row, uncapped. A bare setInterval fires on a fixed wall-clock schedule
 * REGARDLESS of whether the previous tick finished — so a tick slower than
 * intervalMs (one slow notification round-trip, or a modest backlog; the
 * realistic trigger is a long-lived detached poller draining an
 * accumulated backlog in a burst the moment an MCP-server session
 * connects) lets the NEXT tick start while the SAME rows are still
 * uncleared, re-relaying them — the operator sees the same message twice.
 * Scheduling the next tick only AFTER the current one's promise settles
 * makes that structurally impossible: at most one tick is ever in flight.
 */
export function startNotifyRelay(
  deps: NotifyRelayDeps,
  intervalMs = 1000,
): NotifyRelayHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const logFn = deps.logFn ?? log;

  const unrefTimer = (h: ReturnType<typeof setTimeout>) => {
    if (typeof h === "object" && h && "unref" in h) {
      (h as { unref: () => void }).unref();
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    unrefTimer(timer);
  };

  const tick = () => {
    void relayPendingNotificationsOnce(deps)
      .catch((err) => {
        // relayPendingNotificationsOnce already catches per-row errors
        // internally and never rejects in practice, but guard here too —
        // a throw must not silently kill the reschedule loop.
        logFn("notify-relay", "unexpected error in relay tick", {
          error: String(err),
        });
      })
      .finally(() => {
        scheduleNext();
      });
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
