/**
 * lib/pg.ts — how this bridge learns where its store is, and how it gets in.
 *
 * Three of these cases guard rules that are not style preferences:
 *
 *   - An unset DSN must THROW. There is no local-file fallback by design; a
 *     bridge that quietly stored the operator's messages somewhere nobody
 *     reads would look healthy while losing every one of them.
 *   - The credential must never appear in anything renderable. describeTarget
 *     is the ONLY sanctioned rendering of a connection target, and it is
 *     pinned here against a password that would be obvious if it leaked.
 *   - The schema name is spliced into SQL text (a parameter slot cannot carry
 *     an identifier), so quoteSchema is the last line before an injection.
 *
 * No mocks: the password-file cases write real files with real permissions
 * into a real temp dir.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveDsn,
  resolveTarget,
  describeTarget,
  lookupPasswordFile,
  schemaForAgent,
  resolveSchema,
  quoteSchema,
  FLEET_DSN_ENV,
  SCHEMA_PREFIX,
} from "../lib/pg.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a password file with the 0600 mode libpq insists on. */
function passwordFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "cct-pgpass-"));
  dirs.push(dir);
  const path = join(dir, "pgpass");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

describe("resolveDsn", () => {
  test("the telegrammer-scoped override wins over the fleet switch", () => {
    expect(
      resolveDsn({
        CCT_STORE_DSN: "postgresql://scoped/db",
        [FLEET_DSN_ENV]: "postgresql://fleet/db",
      }),
    ).toBe("postgresql://scoped/db");
  });

  test("the fleet switch is used when no scoped override is set", () => {
    expect(resolveDsn({ [FLEET_DSN_ENV]: "postgresql://fleet/db" })).toBe(
      "postgresql://fleet/db",
    );
  });

  // THE CASE. Everything else here is bookkeeping.
  test("THROWS when nothing is set — there is no local fallback", () => {
    expect(() => resolveDsn({})).toThrow();
  });

  test("the refusal explains itself rather than just failing", () => {
    let msg = "";
    try {
      resolveDsn({});
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain(FLEET_DSN_ENV); // what to set
    expect(msg).toContain("CCT_STORE_DSN"); // the other thing to set
    expect(msg).toContain("NO local-file fallback"); // why it refuses
  });
});

describe("lookupPasswordFile", () => {
  test("matches on host/port/database/user", () => {
    const f = passwordFile(
      "other:5432:db:user:wrong\nhost:5432:db:user:right\n",
    );
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBe("right");
  });

  test("* matches any field, and the FIRST match wins", () => {
    const f = passwordFile("*:*:*:*:wildcard\nhost:5432:db:user:specific\n");
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBe(
      "wildcard",
    );
  });

  test("comments and blank lines are skipped", () => {
    const f = passwordFile("# a comment\n\nhost:5432:db:user:secret\n");
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBe("secret");
  });

  test("an escaped colon inside a password survives", () => {
    // A password may legally contain ':' escaped as '\:'. Splitting naively
    // would truncate it at the colon and produce a wrong password, which
    // fails as an AUTH error and looks like a wrong credential rather than a
    // parsing bug.
    const f = passwordFile("host:5432:db:user:pa\\:ss\\\\word\n");
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBe(
      "pa:ss\\word",
    );
  });

  test("a group/world-readable file is IGNORED, exactly as libpq ignores it", () => {
    const f = passwordFile("host:5432:db:user:secret\n", 0o644);
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBeNull();
  });

  test("a missing file is null, not a throw", () => {
    expect(
      lookupPasswordFile("h", "1", "d", "u", "/nonexistent/nope/pgpass"),
    ).toBeNull();
  });

  test("no matching line is null", () => {
    const f = passwordFile("other:5432:db:user:secret\n");
    expect(lookupPasswordFile("host", "5432", "db", "user", f)).toBeNull();
  });
});

describe("resolveTarget", () => {
  test("an inline password in the URL is used as-is", () => {
    const t = resolveTarget("postgresql://u:inline@h:5432/d", {});
    expect(t).toEqual({
      host: "h",
      port: "5432",
      database: "d",
      user: "u",
      password: "inline",
    });
  });

  test("PGPASSWORD is consulted when the URL carries none", () => {
    const t = resolveTarget("postgresql://u@h:5432/d", {
      PGPASSWORD: "from-env",
    });
    expect(t.password).toBe("from-env");
  });

  test("the password file is the last resort, and PGPASSFILE points at it", () => {
    const f = passwordFile("h:5432:d:u:from-file\n");
    const t = resolveTarget("postgresql://u@h:5432/d", { PGPASSFILE: f });
    expect(t.password).toBe("from-file");
  });

  test("PGUSER supplies the role when the DSN carries none — the fleet's shape", () => {
    // The fleet's SCITEX_STORE_DSN is deliberately roleless; the role comes
    // from the environment. A DSN with no user must therefore NOT fall through
    // to the OS user, which connects as somebody with no grants and fails in a
    // way that blames the wrong thing.
    const t = resolveTarget("postgresql://h:5432/d", { PGUSER: "role-a" });
    expect(t.user).toBe("role-a");
  });

  test("the default port is 5432 when the URL omits it", () => {
    expect(resolveTarget("postgresql://u@h/d", {}).port).toBe("5432");
  });

  test("no credential is found rather than invented", () => {
    expect(
      resolveTarget("postgresql://u@h:5432/d", {
        PGPASSFILE: "/nonexistent/nope",
      }).password,
    ).toBeNull();
  });
});

describe("describeTarget", () => {
  // THE RULE: never print a credential. This is the only rendering of a
  // connection target this codebase is allowed to emit, so it is the one
  // place the rule can be enforced by a test.
  test("names the server and NEVER the password", () => {
    const t = resolveTarget("postgresql://u:hunter2@h:5432/d", {});
    const rendered = describeTarget(t);
    expect(rendered).toBe("postgresql://u@h:5432/d");
    expect(rendered).not.toContain("hunter2");
  });
});

describe("schemaForAgent", () => {
  test("folds an agent id into a legal identifier", () => {
    expect(schemaForAgent("scitex-agent-container")).toBe(
      `${SCHEMA_PREFIX}scitex_agent_container`,
    );
    expect(schemaForAgent("Telegram")).toBe(`${SCHEMA_PREFIX}telegram`);
  });

  test("stays inside PostgreSQL's 63-byte identifier limit", () => {
    const long = "a".repeat(200);
    expect(schemaForAgent(long).length).toBeLessThanOrEqual(63);
  });

  // WHY THE DIGEST EXISTS. PostgreSQL truncates identifiers at 63 bytes
  // SILENTLY. Two long agent ids sharing a prefix would collapse onto ONE
  // schema and merge their message histories — a wrong answer that looks
  // right, which is the whole failure class the per-agent namespace prevents.
  test("two long ids sharing a prefix do NOT collapse onto one namespace", () => {
    const a = schemaForAgent("x".repeat(80) + "-alpha");
    const b = schemaForAgent("x".repeat(80) + "-beta");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
  });

  test("every produced name is accepted by quoteSchema", () => {
    for (const id of ["a/b", "../evil", "Agent Name!", "x".repeat(120)]) {
      expect(() => quoteSchema(schemaForAgent(id))).not.toThrow();
    }
  });
});

describe("resolveSchema", () => {
  test("an explicit override wins", () => {
    expect(resolveSchema({ CCT_STORE_SCHEMA: "cct_test_explicit" })).toBe(
      "cct_test_explicit",
    );
  });

  test("otherwise it is derived from the agent id", () => {
    expect(resolveSchema({ CCT_AGENT_ID: "orochi" })).toBe(
      `${SCHEMA_PREFIX}orochi`,
    );
  });

  test("the default agent id is 'telegram'", () => {
    expect(resolveSchema({})).toBe(`${SCHEMA_PREFIX}telegram`);
  });
});

describe("quoteSchema", () => {
  test("quotes a legal identifier", () => {
    expect(quoteSchema("cct_agent")).toBe('"cct_agent"');
  });

  // The schema name is spliced into SQL TEXT because a parameter slot cannot
  // carry an identifier. Anything outside [A-Za-z0-9_] is REFUSED rather than
  // escaped: names come from schemaForAgent(), so an exotic one means
  // something bypassed it.
  test("REFUSES anything that could terminate the identifier", () => {
    for (const evil of [
      'x"; DROP SCHEMA public CASCADE; --',
      "a-b",
      "a b",
      "a;b",
      "",
      "a.b",
    ]) {
      expect(() => quoteSchema(evil)).toThrow(/only \[A-Za-z0-9_\]/);
    }
  });
});
