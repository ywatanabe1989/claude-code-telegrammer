/**
 * Is the bridge on the other end of TURN_URL actually OURS?
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The turn bridge identifies its agent BY PORT NUMBER — its own route table
 * documents the bare route as "(the port identifies the agent)". So a bridge
 * bound to a port that was since reallocated to another agent accepts our POST
 * and returns 200. wakeTurn sees {ok:true, status:200}, loudfail never fires,
 * and the agent the message was FOR never hears about it.
 *
 * MEASURED 2026-08-19 on scitex-compute-04, and STILL PRESENT at 21:55 the
 * same day:
 *
 *     PORT   SENDER                  LISTENER                 VERDICT
 *     19000  handyman-01             handyman-06              MISROUTE
 *     19003  scitex-cards            scitex-agent-container   MISROUTE
 *     19008  scitex-dev              scitex-hpc               MISROUTE
 *
 * Three agents' inbound mail landing in other agents' sessions, silently,
 * because a successful POST is indistinguishable from a correct one.
 *
 * ── Why /health and not the named route ───────────────────────────────────
 *
 * The bridge also serves `POST /agents/<name>/turn` and 404s a name it does
 * not own, which would make a misroute loud. But a 404 carries TWO facts:
 *
 *     wrong agent                  -> we want the alarm
 *     bridge too old to serve it   -> delivery is fine; an alarm is a FALSE
 *                                     one, and a check that cries wolf gets
 *                                     switched off, leaving us worse than now
 *
 * `GET /health` separates them, because it reports the bridge's own identity
 * rather than making us infer it from a status code:
 *
 *     {"status": "ok", "agent": "scitex-agent-container"}
 *
 * Verified on three live ports 2026-08-19, including both misrouting ones,
 * where it correctly names the SQUATTING agent rather than the intended one.
 *
 * ── The three-valued rule, which is the load-bearing part ─────────────────
 *
 * UNKNOWN IS NOT A FAILURE. If /health is unreachable, malformed, or absent
 * (an older bridge), we proceed exactly as before. Refusing on unknown would
 * convert a version skew into an outage — turning a safety check into the
 * thing that breaks delivery is a worse defect than the one it prevents.
 * Only a POSITIVE mismatch — the bridge naming an agent that is not ours —
 * stops the send.
 */

/** What the bridge's /health reports, as far as we depend on it. */
export interface BridgeHealth {
  agent?: string;
}

export type IdentityVerdict = "ours" | "not-ours" | "unknown";

/**
 * Derive the health URL from a turn URL, preserving origin and dropping path.
 *
 * TURN_URL is a whole URL ("http://127.0.0.1:19005/v1/turn"), so the origin
 * has to be recovered rather than assumed. Returns null when TURN_URL is not
 * parseable — which yields `unknown`, not a refusal.
 */
export function healthUrlFor(turnUrl: string): string | null {
  try {
    const u = new URL(turnUrl);
    return `${u.origin}/health`;
  } catch {
    return null;
  }
}

/**
 * The DECISION, pure and separate from the fetch so it is testable without a
 * server — the same reason poller-supervisor factors its spawn decision out.
 *
 * `reported` is whatever /health said the bridge's agent is; undefined means
 * we could not establish it (unreachable, malformed, no `agent` field).
 */
export function identityVerdict(
  expected: string,
  reported: string | undefined,
): IdentityVerdict {
  if (!reported) return "unknown";
  if (!expected) return "unknown";
  return reported === expected ? "ours" : "not-ours";
}

/** Injectable so tests never touch the network. */
export type HealthFetcher = (url: string) => Promise<BridgeHealth | undefined>;

const defaultFetcher: HealthFetcher = async (url) => {
  try {
    // A short timeout on purpose: this is a localhost call on the delivery
    // hot path. If the bridge cannot answer promptly we take `unknown` and
    // send anyway, rather than delay the operator's message to satisfy a
    // check that is allowed to be inconclusive.
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return undefined;
    return (await resp.json()) as BridgeHealth;
  } catch {
    return undefined;
  }
};

/**
 * Ask the bridge who it serves, and compare with who we are.
 *
 * Never throws: every failure route yields `unknown`, because this check must
 * not be able to break delivery.
 */
export async function checkBridgeIdentity(
  turnUrl: string,
  expectedAgent: string,
  fetcher: HealthFetcher = defaultFetcher,
): Promise<{ verdict: IdentityVerdict; reported?: string }> {
  const healthUrl = healthUrlFor(turnUrl);
  if (!healthUrl) return { verdict: "unknown" };
  // The catch belongs HERE, not only in defaultFetcher: the promise above is
  // "never throws", and a promise the code cannot keep is the exact defect
  // this module exists to prevent one layer down. An injected fetcher (tests,
  // or any future caller) that throws must still yield `unknown` rather than
  // propagate — a preflight that can break delivery is worse than no preflight.
  let reported: string | undefined;
  try {
    reported = (await fetcher(healthUrl))?.agent;
  } catch {
    return { verdict: "unknown" };
  }
  return { verdict: identityVerdict(expectedAgent, reported), reported };
}
