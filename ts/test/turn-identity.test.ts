/**
 * The turn bridge identifies its agent BY PORT. A stale bridge holding a
 * reallocated port accepts the POST and returns 200, so a misdelivery is
 * indistinguishable from success and loudfail never fires — the third branch
 * documented in lib/loudfail.ts and measured live on 2026-08-19.
 */

import { describe, test, expect } from "bun:test";
import {
  healthUrlFor,
  identityVerdict,
  checkBridgeIdentity,
} from "../lib/turn-identity.js";

describe("healthUrlFor derives the origin, not a string-append", () => {
  test("drops the turn path and keeps the origin", () => {
    expect(healthUrlFor("http://127.0.0.1:19005/v1/turn")).toBe(
      "http://127.0.0.1:19005/health",
    );
  });

  test("works for the named route shape too", () => {
    expect(healthUrlFor("http://127.0.0.1:19003/agents/scitex-cards/turn")).toBe(
      "http://127.0.0.1:19003/health",
    );
  });

  test("an unparseable TURN_URL yields null, which becomes UNKNOWN — never a refusal", () => {
    expect(healthUrlFor("not a url")).toBeNull();
  });
});

describe("identityVerdict is three-valued — unknown is not a failure", () => {
  test("matching agent is ours", () => {
    expect(identityVerdict("scitex-cards", "scitex-cards")).toBe("ours");
  });

  test("THE LIVE DEFECT: cards' port answered by scitex-agent-container", () => {
    // Measured 2026-08-19: scitex-cards posts to 19003; the bridge on 19003
    // runs scitex-agent-container's spec and /health says so.
    expect(identityVerdict("scitex-cards", "scitex-agent-container")).toBe(
      "not-ours",
    );
  });

  test("no reported agent is UNKNOWN, not a mismatch", () => {
    // An older bridge, an unreachable /health, or malformed JSON. Treating
    // this as a failure would convert version skew into an outage.
    expect(identityVerdict("scitex-cards", undefined)).toBe("unknown");
  });

  test("no expected agent is UNKNOWN — we cannot judge without our own name", () => {
    expect(identityVerdict("", "scitex-cards")).toBe("unknown");
  });
});

describe("checkBridgeIdentity never throws — every failure route is unknown", () => {
  test("a fetcher that throws yields unknown, not an exception", async () => {
    const r = await checkBridgeIdentity("http://127.0.0.1:19005/v1/turn", "me", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.verdict).toBe("unknown");
  });

  test("a bridge with no agent field yields unknown", async () => {
    const r = await checkBridgeIdentity("http://127.0.0.1:19005/v1/turn", "me", async () => ({}));
    expect(r.verdict).toBe("unknown");
  });

  test("reports WHO it found, so the operator learns who is squatting", async () => {
    const r = await checkBridgeIdentity(
      "http://127.0.0.1:19003/v1/turn",
      "scitex-cards",
      async () => ({ status: "ok", agent: "scitex-agent-container" }) as never,
    );
    expect(r.verdict).toBe("not-ours");
    expect(r.reported).toBe("scitex-agent-container");
  });
});
