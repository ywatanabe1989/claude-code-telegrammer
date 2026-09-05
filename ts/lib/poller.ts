/**
 * Telegram getUpdates long-polling loop with inbound message delivery.
 *
 * Per-update handling lives in handle-update.ts (handleUpdate) and the
 * batch/offset/durability-retry logic in poller-batch.ts (processBatch).
 * This file owns only the poll loop itself: takeover preflight, the
 * getUpdates call, 409-conflict handling, and persisting the offset that
 * processBatch decides is safe to advance to.
 */

import { tgApi, isConflictError } from "./telegram-api.js";
import { loadAccess, allowlistIsUsable } from "./access.js";
import { log } from "./log.js";
import { BOT_TOKEN_HASH, STATE_DIR, TURN_URL, AGENT_ID } from "./config.js";
import { checkBridgeIdentity } from "./turn-identity.js";
import { saveOffset, loadOffset } from "./store.js";
import {
  claimAuthoritative,
  type ClaimOutgoingVerdict,
  checkAuthority,
  isAuthoritative,
  releaseAuthoritative,
  pollerPidfilePath,
} from "./takeover.js";
import { processBatch } from "./poller-batch.js";
import { recordSuccessfulPoll, startStallWatchdog } from "./poll-watchdog.js";
import { getenv } from "./env.js";
import { broadcastSystemAlert } from "./loudfail.js";
import {
  startupConflictVerdict,
  STARTUP_409_LIMIT,
} from "./startup-conflict.js";

/**
 * Max consecutive 409 Conflict responses we tolerate before declaring
 * the poller dead and exiting. Each 409 triggers a 3s backoff, so this
 * is roughly a 90s grace window for a previous orphaned poller's long-
 * poll to time out and its per-iteration isAuthoritative() check to
 * notice it has been preempted by us. 30 × 3s = 90s — comfortably above
 * Telegram's 30s long-poll cap.
 */
const MAX_CONSECUTIVE_409 = 30;
/** Backoff between getUpdates errors (409s or other). */
const ERROR_BACKOFF_MS = 3000;

let updateOffset = 0;
let polling = true;

export function stopPolling(): void {
  polling = false;
}

export async function startPolling(): Promise<void> {
  log("poller", "starting getUpdates polling...");

  const access = loadAccess();
  if (!allowlistIsUsable(access)) {
    const refusal =
      "REFUSING TO START: the allow list is empty — no user and no group is " +
      "permitted, so every inbound message would be rejected AND consumed " +
      "(the offset advances past rejections, making them unrecoverable). " +
      `state_dir=${STATE_DIR}. Set CCT_ALLOWED_USERS (a.k.a. ` +
      "CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS) to your numeric telegram id, " +
      `or create access.json in ${STATE_DIR}.`;
    log("poller", refusal);
    void broadcastSystemAlert(refusal);
    // Non-zero, and before ANY Telegram call at all: a refusing poller
    // must not consume mail, must not claim the pidfile away from a live
    // incumbent, and must not mutate remote state either. deleteWebhook
    // used to run first — harmless for the offset, but a refusal that
    // still tears down the webhook is not the no-op it claims to be.
    process.exitCode = 1;
    return;
  }

  // ── Turn-bridge identity preflight ──────────────────────────────────
  //
  // The bridge we POST inbound turns to identifies its agent BY PORT — its
  // own route table documents the bare route as "(the port identifies the
  // agent)". A bridge holding a port that was since reallocated ACCEPTS the
  // POST and returns 200, so wakeTurn sees success, loudfail never fires,
  // and every inbound lands in another agent's session. Measured live on
  // 2026-08-19: three agents misrouted this way for hours, unremarked,
  // because the failure produces the exact signature of success.
  //
  // Checked ONCE here rather than per message. The wake is fire-and-forget
  // (handle-update.ts: `void wakeTurn(...)`), so a per-message round-trip
  // would delay EVERY inbound by the health timeout — a safety check that
  // slows the path it protects is the wrong shape.
  //
  // UNKNOWN PROCEEDS. An older bridge, an unreachable /health, malformed
  // JSON — none of those are evidence of a wrong bridge, and refusing on
  // them would turn version skew into an outage. Only a POSITIVE mismatch
  // stops us, which is the same three-valued rule the doctor uses.
  //
  // Note this refusal is DELIVERABLE, unlike the allowlist one above:
  // broadcastSystemAlert sends via the Telegram Bot API, which never
  // traverses the turn bridge, so the operator hears about it even though
  // the inbound rail is the thing that is broken.
  if (TURN_URL.trim() !== "") {
    const identity = await checkBridgeIdentity(TURN_URL, AGENT_ID);
    if (identity.verdict === "not-ours") {
      const refusal =
        `REFUSING TO START: the turn bridge at ${TURN_URL} serves ` +
        `"${identity.reported}", not "${AGENT_ID}". Its port was reallocated ` +
        "and a stale bridge still holds it, so every inbound message would be " +
        "POSTed successfully into the WRONG agent's session and no failure " +
        "would be reported. Stop the stale bridge (or let the supervisor " +
        "reallocate) and restart.";
      log("poller", refusal);
      void broadcastSystemAlert(refusal);
      process.exitCode = 1;
      return;
    }
  }

  // ── Takeover preflight ──────────────────────────────────────────────
  //
  // "Newest wins" — claim authoritativeness for this bot token. If an
  // older poller for the same token is running (typical case: agent
  // restart left a bun orphan parented to PID 1), best-effort SIGTERM
  // it and overwrite the pidfile so our PID is the recorded authority.
  // The incumbent's per-iteration isAuthoritative() check will see it's
  // been preempted on its next loop tick and exit cleanly.
  //
  // Then call deleteWebhook (idempotent) — clears any leftover webhook
  // that would itself produce 409 on getUpdates.
  // Whether we displaced a RECORDED predecessor decides how a startup 409 is
  // read: our own predecessor may be draining a long-poll (wait), whereas a
  // 409 with nobody in our pidfile means a FOREIGN consumer holds the token
  // and nothing will yield (refuse). See lib/startup-conflict.ts.
  let displacedLivePredecessor = false;

  try {
    // The verdict on the outgoing record is logged by NAME. Before this, every
    // takeover logged "preempted previous poller" whether it had SIGTERMed a
    // live poller, skipped a dead pid, or - the 2026-09-05 incident - signalled
    // a process that merely held a recycled pid (the MCP server, in a fresh
    // container namespace). Three different worlds, one log line; the
    // investigation had to reconstruct which from pid arithmetic.
    let verdict: ClaimOutgoingVerdict | null = null;
    const outgoing = claimAuthoritative({
      stateDir: STATE_DIR,
      tokenHash: BOT_TOKEN_HASH,
      report: (v) => {
        verdict = v;
      },
    });
    if (outgoing && outgoing.pid !== process.pid) {
      displacedLivePredecessor = verdict === "signalled";
      const what =
        verdict === "signalled"
          ? "preempted previous poller (newest wins) — SIGTERM sent, wrote our PID to pidfile"
          : verdict === "stale-pid-not-a-poller"
            ? "pidfile named a pid that is NOT a poller of this agent (recycled pid) — no signal sent, overwrote the stale record"
            : "pidfile named a dead pid — overwrote the stale record";
      log("poller", what, {
        outgoingPid: outgoing.pid,
        ourPid: process.pid,
        verdict: verdict ?? "unreported",
      });
    } else {
      log("poller", "claimed pidfile (no prior poller recorded)", {
        ourPid: process.pid,
      });
    }
  } catch (err) {
    log("poller", `claimAuthoritative failed (proceeding anyway): ${err}`);
  }

  try {
    await tgApi("deleteWebhook", { drop_pending_updates: false });
    log("poller", "deleteWebhook ok — no webhook will compete with getUpdates");
  } catch (err) {
    // Non-fatal; deleteWebhook may itself 409 if a competing poller has
    // not yet released. The takeover-loop below handles it.
    log("poller", `deleteWebhook warning: ${err} (proceeding anyway)`);
  }

  // Restore persisted offset from DB
  try {
    updateOffset = await loadOffset();
    if (updateOffset > 0) {
      log("poller", `resumed from persisted offset ${updateOffset}`);
    }
  } catch (err) {
    log("poller", "failed to load offset from the store, starting from 0", {
      error: String(err),
    });
  }

  // Check allowlist at startup — REFUSE if empty.
  //
  // This comment used to say "fail loud if empty" and the body only log()ed,
  // then polled on. That is a declaration the code did not honour, and the
  // consequence is not a noisy log: handle-update returns "ok" for a rejected
  // message, poller-batch treats "ok" as durable, so the offset advances PAST
  // every message we refuse. An empty allowlist therefore CONSUMES the
  // operator's mail instead of holding it. Measured 2026-08-16: four of his
  // updates rejected, offset advanced past all four, unrecoverable, resent by
  // hand.
  //
  // Refusing a stranger is fine and still advances — otherwise a stranger's
  // message is redelivered forever. But when NOTHING can be accepted, polling
  // can only destroy, so we do not poll.
 
  try {
    const me = await tgApi("getMe");
    // Identity triple on the startup line: two agents sharing ONE bot
    // token + state dir will print the SAME token hash + state_dir here,
    // making the collision spottable at a glance across agent logs.
    const agentId = getenv("AGENT_ID") ?? "-";
    log(
      "poller",
      `polling as @${me.username} (token=${BOT_TOKEN_HASH} state_dir=${STATE_DIR} agent=${agentId})`,
    );
  } catch (err) {
    log("poller", `getMe failed: ${err}`);
  }

  let consecutive409 = 0;
  let hasPolledSuccessfully = false;

  // Ingestion-stall watchdog: alarms LOUDLY if the process stays alive but
  // getUpdates stops returning (wedged long-poll / hung socket / network
  // black-hole) — the failure kill-0 liveness checks miss. Stopped in the
  // finally below so it can never leak or alarm after a clean shutdown /
  // preemption (isPolling() also gates it). See poll-watchdog.ts.
  const watchdog = startStallWatchdog(() => polling);

  try {
    while (polling) {
      // Per-iteration authority check.
      //
      // This USED to be `if (!isAuthoritative(...)) exit`, which collapsed two
      // completely different situations into one:
      //
      //   - a NEWER poller overwrote our pidfile  -> stand down (correct)
      //   - the pidfile simply VANISHED           -> ...also stand down (WRONG)
      //
      // A file that disappeared is not a successor. Nobody preempted us; nobody
      // owns the pidfile at all. But the loop logged "preempted by newer poller"
      // and killed a perfectly healthy poller — and the operator's inbound
      // Telegram channel died with it, repeatedly, on 2026-07-14. The evidence
      // is unambiguous in the poller log: one process exits "cleanly" claiming
      // preemption, and its replacement starts up finding "no prior poller
      // recorded". Nobody had taken over. Deleting a file must never kill a
      // healthy process.
      const authority = checkAuthority({
        stateDir: STATE_DIR,
        tokenHash: BOT_TOKEN_HASH,
      });

      if (authority.kind === "preempted") {
        // A genuinely newer poller holds the pidfile. Exit WITHOUT issuing
        // another getUpdates, so we never 409-storm the new incumbent.
        log(
          "poller",
          `preempted by newer poller (pid ${authority.byPid} now holds the pidfile) — exiting cleanly (token=${BOT_TOKEN_HASH} state_dir=${STATE_DIR})`,
          { ourPid: process.pid, byPid: authority.byPid },
        );
        polling = false;
        // Do NOT release the pidfile — it belongs to the successor now.
        return;
      }

      if (authority.kind === "vacant" || authority.kind === "stale") {
        // Nobody real holds the pidfile, and we are still alive and polling.
        //
        //   vacant — the file is GONE. Something deleted it out from under us.
        //   stale  — the file names a pid that NO LONGER EXISTS. It looks like a
        //            successor, but it is a corpse. On 2026-07-14 a test run
        //            whose hermetic preload had not loaded stamped the LIVE
        //            pidfile with its own pid, exited seconds later, and the
        //            real poller killed itself for that dead pid.
        //
        // Either way we are still the only poller for this token. RE-CLAIM and
        // carry on. Neither an absent file nor a dead pid is a successor, and
        // neither is a reason to take the operator's inbound channel down.
        //
        // signalOutgoing:false — there is nothing live to SIGTERM, and signalling
        // a recycled PID could only ever hit an unrelated process.
        const why =
          authority.kind === "vacant"
            ? "pidfile VANISHED (nobody holds it)"
            : `pidfile records a DEAD pid (${authority.byPid}) — a stale claim, not a successor`;

        log(
          "poller",
          `${why} — re-claiming it and continuing; we are still the only poller ` +
            `for this token (token=${BOT_TOKEN_HASH} state_dir=${STATE_DIR})`,
          { ourPid: process.pid },
        );
        claimAuthoritative({
          stateDir: STATE_DIR,
          tokenHash: BOT_TOKEN_HASH,
          signalOutgoing: false,
        });
      }

      try {
        const updates = await tgApi("getUpdates", {
          offset: updateOffset,
          timeout: 30,
          allowed_updates: ["message", "message_reaction"],
        });
        consecutive409 = 0;
        hasPolledSuccessfully = true;
        // Heartbeat: getUpdates RETURNED (regardless of update count — a
        // healthy long-poll returns at least every ~30s even with zero
        // updates). Stamps the in-process + persisted "last successful poll"
        // timestamp the stall watchdog reads. A wedged getUpdates never
        // reaches here, so the heartbeat goes stale and the watchdog fires.
        await recordSuccessfulPoll();
        if (!Array.isArray(updates)) continue;
        if (updates.length > 0) {
          // processBatch NEVER advances the offset past an un-persisted
          // update: it returns update_id+1 for each durable ("ok" /
          // "duplicate") update but STOPS at the first real "persistError"
          // (returning that update's own update_id so Telegram redelivers
          // it), emitting a loud channel notification so the failure is
          // never silent. See poller-batch.ts.
          updateOffset = await processBatch(updates, updateOffset);
          try {
            await saveOffset(updateOffset);
          } catch (err) {
            log("poller", "failed to persist offset", { error: String(err) });
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Classify on the ENVELOPE, never on the prose. This was
        // `errMsg.includes("409")` until 2026-08-11, and Telegram's 409 body
        // carries its code in `error_code` while the message it produced read
        // "Conflict: terminated by other getUpdates request" — no digits. So
        // this branch never ran: 161 conflicts in four hours all fell through
        // to the generic retry below, consecutive409 stayed 0, the
        // stand-down alert below was unreachable, and because no poll ever
        // succeeded the heartbeat froze until the stall watchdog respawned
        // the poller straight back into the contention. scitex-hub's inbound
        // rail was dead for a month behind green liveness checks.
        // See lib/telegram-api.ts and test/conflict-classification.test.ts.
        if (isConflictError(err)) {
          consecutive409 += 1;
          // 409 from Telegram = "another consumer is in a getUpdates
          // call". Under "newest wins", the most common cause RIGHT after
          // we took the pidfile is that the previous poller's long-poll
          // hasn't finished yet — it'll exit on its next iteration when
          // its isAuthoritative() check fires. Back off and retry; only
          // give up after MAX_CONSECUTIVE_409 (covers a 30s long-poll
          // cycle with margin).
          log(
            "poller",
            `409 Conflict on getUpdates (${consecutive409}/${MAX_CONSECUTIVE_409}) — backing off ${ERROR_BACKOFF_MS}ms (likely the previous poller is still draining its long-poll; it should exit on its next isAuthoritative() tick)`,
          );
          // STARTUP REFUSAL, ahead of the long grace below.
          //
          // The 90s backoff exists for ONE case: our own predecessor draining
          // its long-poll after we took its pidfile. When we displaced nobody
          // there is no drain in flight, so waiting is not patience — it is
          // the silence that let an operator talk to a deaf agent for 27
          // minutes on 2026-08-16. Refuse while someone is still watching the
          // restart, and exit NON-ZERO. That exit code was
          // inert when it was written: measured 2026-08-19, an ADOPTED poller's
          // parent is the container init, which reaps and never respawns. It is
          // real now only because startPollerSupervision() re-checks liveness on
          // an interval; the alert below, not the exit code, is still what
          // actually reaches a human.
          if (
            startupConflictVerdict({
              displacedLivePredecessor,
              hasPolledSuccessfully,
              consecutive409,
            }) === "refuse"
          ) {
            const refusal =
              `REFUSING TO START: ${consecutive409} consecutive 409 Conflicts and we displaced NO prior poller — ` +
              `another consumer already holds this bot token. ` +
              `token=${BOT_TOKEN_HASH} state_dir=${STATE_DIR} our_pid=${process.pid} ` +
              `pidfile=${pollerPidfilePath(STATE_DIR, BOT_TOKEN_HASH)}. ` +
              "Each agent needs its OWN bot token. Find the other consumer (it is not one of ours — " +
              "ours record themselves in the pidfile above) and stop it, then restart.";
            log("poller", refusal);
            void broadcastSystemAlert(refusal);
            polling = false;
            releaseAuthoritative({
              stateDir: STATE_DIR,
              tokenHash: BOT_TOKEN_HASH,
            });
            // Non-zero: a wedged poller looks alive to every liveness check we
            // have. Supervision will retry this a bounded number of times and then
            // page — contention is often transient (a predecessor draining), and a
            // permanent collision must end at a human, not in a retry loop.
            process.exitCode = 1;
            return;
          }

          if (consecutive409 >= MAX_CONSECUTIVE_409) {
            const fatalMsg =
              `FATAL: ${MAX_CONSECUTIVE_409} consecutive 409 Conflicts — another process is polling this bot token and has NOT yielded after backoff. ` +
              "This is likely a foreign poller (not one of ours — ours obey the pidfile-takeover protocol) or a stuck webhook. " +
              `Another consumer holds THIS bot token (hash=${BOT_TOKEN_HASH}, state_dir=${STATE_DIR}) — commonly multiple agents sharing one bot token. Each agent needs its OWN bot token + CCT_STATE_DIR. ` +
              "Stop the other consumer (or call deleteWebhook) and restart the bridge.";
            log("poller", fatalMsg);
            // Broadcast directly to Telegram — this runs in the standalone
            // poller process, with no mcp/Server object to notify through
            // (see lib/loudfail.ts::broadcastSystemAlert).
            void broadcastSystemAlert(fatalMsg);
            polling = false;
            // We DID hold the lease; release it so the operator's manual
            // restart can re-claim cleanly.
            releaseAuthoritative({
              stateDir: STATE_DIR,
              tokenHash: BOT_TOKEN_HASH,
            });
            return;
          }
          await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
        } else {
          log("poller", `getUpdates error: ${errMsg}. Retrying in 3s...`);
          await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
        }
      }
    }
  } finally {
    // Always stop the watchdog on ANY loop exit (normal stop, preemption,
    // 409-fatal return) so its interval can neither leak nor alarm after
    // the poller has released authority / shut down.
    watchdog.stop();
  }
}
