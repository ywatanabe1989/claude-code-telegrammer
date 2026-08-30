/**
 * Wake-delivery failure tracker for the health doctor (incident
 * incident-cct-inbound-dies-silently-with-mcp-server-20260711).
 *
 * poller_alive proves the getUpdates FETCH loop lives; it says nothing
 * about whether the WAKE POST to the agent's own /v1/turn actually lands.
 * A dead turn-bridge (nothing listening on the configured TURN_URL) makes
 * every wake fail while poller_alive stays green — the exact gap that let
 * an outage go undetected while the doctor reported every check ok.
 *
 * This module is the durable-enough signal a LATER health check can read:
 * a running count of consecutive wake failures since the last success.
 * Reset to zero on any success, so it answers "is the wake path stuck
 * failing RIGHT NOW", not "did it ever fail".
 *
 * CROSS-PROCESS (architecture fix, incident-cct-inbound-dies-silently-with-
 * mcp-server-20260711 follow-up, 2026-07): the getUpdates poller now runs in
 * its own standalone process (ts/telegram-poller.ts), decoupled from the MCP
 * server (ts/telegram-server.ts) so an MCP-child restart can no longer kill
 * inbound delivery. recordWakeFailure/recordWakeSuccess are called from the
 * POLLER process (lib/handle-update.ts); the `health` MCP tool that reads
 * getWakeFailureState() runs in the SEPARATE MCP-server process. In-process
 * module state alone can no longer bridge that gap, so every write is ALSO
 * persisted to the shared store (same meta-table kv pattern
 * lib/poll-watchdog.ts uses for its own last-poll heartbeat via
 * saveLastPollTs/loadLastPollTs) and every read prefers the persisted value,
 * falling back to the in-process one only when the store is unavailable (e.g.
 * a unit test that never called initStore(), or the CLI `health` doctor mode
 * which deliberately never starts the store).
 *
 * WHAT THE ENGINE MOVE SIMPLIFIED. The retry ladder below used to carry two
 * hand-tuned file-lock timeouts, because each write opened its own handle to a
 * locally-locked file and a blocking wait on that lock ran on the same thread
 * whose whole job is staying responsive to Telegram polling. Those numbers
 * described a lock that no longer exists: a single-row upsert on the server
 * does not queue behind the poller's own writes the way a whole-file lock did.
 * What is KEPT is the part that was never about locking — one retry, then a
 * LOUD give-up — because the failure this guards against (a silently dropped
 * write on the exact counter the health tool trusts) is unchanged.
 */

import { getSql } from "./pg.js";
import { storeSchema } from "./store.js";
import { statements } from "./store-schema.js";
import { log } from "./log.js";
import { broadcastSystemAlert } from "./loudfail.js";
import type { WakeFailCategory } from "./wake.js";

export interface WakeFailureState {
  count: number;
  lastCategory: WakeFailCategory | null;
  lastReason: string | null;
  lastAtMs: number | null;
}

const META_KEY = "wake_failure_state";
const PERSIST_MAX_ATTEMPTS = 2;
const PERSIST_RETRY_DELAY_MS = 50;

let count = 0;
let lastCategory: WakeFailCategory | null = null;
let lastReason: string | null = null;
let lastAtMs: number | null = null;

async function realPersistAttempt(): Promise<void> {
  await getSql().unsafe(statements(storeSchema()).metaUpsert, [
    META_KEY,
    JSON.stringify({ count, lastCategory, lastReason, lastAtMs }),
  ]);
}

let persistAttempt: () => Promise<void> = realPersistAttempt;

/** Test-only: override the single-attempt persist implementation, to
 * force failures deterministically without touching the real store. Returns
 * the previous implementation. */
export function _setPersistAttempt(
  impl: () => Promise<void>,
): () => Promise<void> {
  const prev = persistAttempt;
  persistAttempt = impl;
  return prev;
}

/** Test-only: restore the real store-backed persist attempt. */
export function _resetPersistAttempt(): void {
  persistAttempt = realPersistAttempt;
}

/**
 * Best-effort: write the current in-process state to the shared store,
 * retrying up to PERSIST_MAX_ATTEMPTS times (brief backoff between attempts)
 * before giving up LOUDLY (adversarial-review finding #5: a silently-dropped
 * write on this exact counter — meant to be the trustworthy cross-process
 * health signal the `health` tool reads — could under-report or fail to clear
 * a real failure streak with nothing to notice).
 */
async function persist(): Promise<void> {
  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt++) {
    try {
      await persistAttempt();
      return;
    } catch (err) {
      if (attempt < PERSIST_MAX_ATTEMPTS) {
        log(
          "wake-health",
          `persist attempt ${attempt}/${PERSIST_MAX_ATTEMPTS} failed — retrying`,
          { error: String(err) },
        );
        await new Promise((r) => setTimeout(r, PERSIST_RETRY_DELAY_MS));
      } else {
        const msg =
          `FATAL: wake-failure state failed to persist after ` +
          `${PERSIST_MAX_ATTEMPTS} attempts — the cross-process wake-health ` +
          `signal (the health tool's wake_delivery_backlog) may now be ` +
          `stale/incorrect. Last error: ` +
          `${err instanceof Error ? err.message : String(err)}`;
        log("wake-health", msg);
        void broadcastSystemAlert(msg);
      }
    }
  }
}

/** Best-effort read of the persisted state. Returns null when the store isn't
 * reachable yet (no namespace, no meta row, or a genuinely unrelated process
 * that never called initStore()) so the caller can fall back cleanly. */
async function readPersisted(): Promise<WakeFailureState | null> {
  try {
    const rows = await getSql().unsafe(statements(storeSchema()).metaRead, [
      META_KEY,
    ]);
    const row = rows[0] as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as WakeFailureState;
  } catch (err) {
    log(
      "wake-health",
      "failed to read persisted wake-failure state — falling back to in-process value",
      { error: String(err) },
    );
    return null;
  }
}

/** Call on every wakeTurn failure. Increments the running backlog counter. */
export async function recordWakeFailure(
  category: WakeFailCategory,
  reason: string,
  now: number = Date.now(),
): Promise<void> {
  count += 1;
  lastCategory = category;
  lastReason = reason;
  lastAtMs = now;
  await persist();
}

/** Call on every wakeTurn success. Clears the backlog — the path is proven live again. */
export async function recordWakeSuccess(): Promise<void> {
  count = 0;
  lastCategory = null;
  lastReason = null;
  lastAtMs = null;
  await persist();
}

/**
 * Read the current state for the health doctor. Prefers the persisted
 * (possibly cross-process) value — the poller process is the one actually
 * calling record{Failure,Success}, so a health-tool call running in the
 * separate MCP-server process must read THAT, not its own (permanently
 * unwritten) in-process copy. Falls back to the in-process value when the
 * store isn't reachable (unit tests that skip initStore(), or the CLI
 * `health` doctor mode, which never starts the store at all).
 */
export async function getWakeFailureState(): Promise<WakeFailureState> {
  const persisted = await readPersisted();
  if (persisted !== null) return persisted;
  return { count, lastCategory, lastReason, lastAtMs };
}

/** Test-only: reset all state, in-process AND persisted. */
export async function _resetWakeFailureState(): Promise<void> {
  count = 0;
  lastCategory = null;
  lastReason = null;
  lastAtMs = null;
  await persist();
}
