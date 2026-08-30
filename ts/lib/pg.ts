/**
 * The one place this bridge learns how to reach PostgreSQL.
 *
 * WHY THIS FILE EXISTS AT ALL. Every durable thing the bridge remembers —
 * the operator's message history, the attachment index, the getUpdates
 * watermark, the poll heartbeat — used to live in a per-agent file on local
 * disk. The fleet standing directive (2026-08-29) removes that storage engine
 * everywhere, with no exceptions, so this module is the replacement seam: ONE
 * connection, resolved from the environment, shared by every module that
 * persists anything.
 *
 * THREE RULES ARE LOAD-BEARING HERE, and each exists because its opposite has
 * already cost something somewhere in this fleet:
 *
 *   1. THE DSN COMES FROM THE ENVIRONMENT AND NOWHERE ELSE. It is never
 *      hardcoded, and there is deliberately NO fallback to a local file. A
 *      silent local fallback is precisely the failure the storage-engine
 *      migration exists to remove: a process that "works" while writing where
 *      nobody is reading. Unset means THROW, loudly, naming the variable.
 *
 *   2. THE PASSWORD IS NEVER IN argv AND NEVER IN A LOG LINE. It is resolved
 *      from PGPASSWORD or the libpq password file and handed straight to the
 *      driver. {@link describeTarget} exists so diagnostics can name the
 *      server without naming the credential.
 *
 *   3. EACH AGENT GETS ITS OWN SCHEMA. The old design gave each agent its own
 *      DATABASE FILE, keyed by agent id, and that isolation is not incidental
 *      — in a Telegram private chat `chat.id` is the HUMAN's user id, so the
 *      operator talking to two different bots produces two different message
 *      streams carrying the SAME chat_id, and (chat_id, message_id) collides
 *      across agents. Pooling every agent into shared tables would silently
 *      cross-wire their histories. A schema per agent reproduces the old
 *      isolation exactly, with the same key.
 *
 * WHY Bun's BUILT-IN CLIENT rather than an npm driver: this package has
 * exactly one runtime dependency and adding a second to move one storage
 * engine is a poor trade. `Bun.SQL` speaks the wire protocol natively.
 * Measured on Bun 1.3.14 against the fleet primary before this was written:
 * parameterised `.unsafe(q, params)`, `.begin()` transactions and `.simple()`
 * multi-statement DDL all behave, and it honours PGUSER — but it does NOT
 * read the libpq password file, which is what the fleet actually stores
 * credentials in. Hence {@link lookupPasswordFile} below: ~40 lines, no
 * dependency, and the deployment does not have to change shape.
 */

import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SQL } from "bun";
import { getenv } from "./env.js";

/** The fleet-wide switch. Read when no telegrammer-scoped override is set. */
export const FLEET_DSN_ENV = "SCITEX_STORE_DSN";

/**
 * Resolve the connection string.
 *
 * Precedence: a telegrammer-scoped `CCT_STORE_DSN` /
 * `CLAUDE_CODE_TELEGRAMMER_STORE_DSN` wins (an agent pointed at its own
 * server), then the fleet-wide `SCITEX_STORE_DSN`.
 *
 * THROWS when neither is set. That is the whole point — see rule 1 above.
 */
export function resolveDsn(
  env: Record<string, string | undefined> = process.env,
): string {
  const scoped = getenv("STORE_DSN", undefined, env);
  if (scoped) return scoped;
  const fleet = env[FLEET_DSN_ENV];
  if (fleet) return fleet;
  throw new Error(
    `No database connection string. Set ${FLEET_DSN_ENV} (the fleet-wide ` +
      `switch) or CCT_STORE_DSN (this bridge only).\n` +
      `\n` +
      `There is deliberately NO local-file fallback. A bridge that quietly ` +
      `stored the operator's messages somewhere nobody reads would look ` +
      `healthy while losing every one of them, which is exactly the failure ` +
      `this store was moved off local files to remove. Refusing to start is ` +
      `the honest outcome.`,
  );
}

// ── Credential resolution ───────────────────────────────────────────────────

/** Un-escape one libpq password-file field (`\:` and `\\`). */
function unescapeField(field: string): string {
  return field.replace(/\\(.)/g, "$1");
}

/** Split on unescaped colons only — a password may legally contain `\:`. */
function splitFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[i + 1];
      i += 1;
    } else if (c === ":") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * libpq password-file lookup: `host:port:database:user:password`, `*` matching
 * anything, first match wins.
 *
 * Returns null when the file is absent or nothing matches — the caller then
 * lets the driver try whatever else the server accepts, and a genuine auth
 * failure surfaces as an auth failure rather than as a confusing silence.
 *
 * A world/group-readable file is IGNORED, the same way libpq ignores it. Being
 * quietly stricter than the user expects is bad, but reading a credential out
 * of a file the whole machine can read is worse, and matching libpq means the
 * behaviour is at least the one documented everywhere else.
 */
export function lookupPasswordFile(
  host: string,
  port: string,
  database: string,
  user: string,
  path: string,
): string | null {
  let text: string;
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) return null; // group/world readable — libpq skips it too
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = splitFields(line);
    if (fields.length < 5) continue;
    const [h, p, d, u] = fields.slice(0, 4).map(unescapeField);
    // A password containing an unescaped colon still rejoins correctly.
    const secret = unescapeField(fields.slice(4).join(":"));
    const matches = (pattern: string, value: string) =>
      pattern === "*" || pattern === value;
    if (
      matches(h, host) &&
      matches(p, port) &&
      matches(d, database) &&
      matches(u, user)
    ) {
      return secret;
    }
  }
  return null;
}

/** Everything needed to open a connection, credential kept separate. */
export interface ConnectionTarget {
  host: string;
  port: string;
  database: string;
  user: string;
  /** Never logged, never placed in argv. */
  password: string | null;
}

/**
 * Parse the DSN and resolve the credential.
 *
 * Credential precedence mirrors libpq: the DSN's own password, then
 * `PGPASSWORD`, then the password file (`PGPASSFILE`, else `~/.pgpass`).
 * The username likewise falls back to `PGUSER`, because the fleet's DSN
 * carries no role and relies on the environment to supply it.
 */
export function resolveTarget(
  dsn: string = resolveDsn(),
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): ConnectionTarget {
  const url = new URL(dsn);
  const host = url.hostname;
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username) || env.PGUSER || "";
  const inline = url.password ? decodeURIComponent(url.password) : "";
  const password =
    inline ||
    env.PGPASSWORD ||
    lookupPasswordFile(
      host,
      port,
      database,
      user,
      env.PGPASSFILE ?? join(home, ".pgpass"),
    );
  return { host, port, database, user, password: password || null };
}

/**
 * A one-line, credential-free description of where we are connecting.
 *
 * Health output, startup logs and error messages all need to say WHICH server
 * they mean; none of them may say with what secret. This is the only rendering
 * of a connection target this codebase should ever print.
 */
export function describeTarget(target: ConnectionTarget): string {
  return `postgresql://${target.user}@${target.host}:${target.port}/${target.database}`;
}

// ── Schema naming ───────────────────────────────────────────────────────────

/** Prefix on every schema this package owns, so its tables are identifiable. */
export const SCHEMA_PREFIX = "cct_";

/**
 * Fold an agent id into a legal, stable, collision-resistant schema name.
 *
 * Postgres truncates identifiers at 63 bytes SILENTLY, which would let two
 * long agent ids share one schema and merge their histories — the exact
 * cross-wiring rule 3 exists to prevent. So a name that would overflow keeps a
 * readable head and appends a digest of the FULL id, which cannot collide by
 * truncation.
 */
export function schemaForAgent(agentId: string): string {
  const folded = agentId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const candidate = `${SCHEMA_PREFIX}${folded}`;
  if (candidate.length <= 63) return candidate;
  const digest = new Bun.CryptoHasher("sha256")
    .update(agentId)
    .digest("hex")
    .slice(0, 12);
  return `${candidate.slice(0, 63 - 13)}_${digest}`;
}

/**
 * The schema this process reads and writes.
 *
 * `CCT_STORE_SCHEMA` overrides it outright — that is how the test preload
 * points a run at a throwaway namespace, and how an operator could park a
 * bridge on a copy of its own data without touching the live one.
 */
export function resolveSchema(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = getenv("STORE_SCHEMA", undefined, env);
  if (explicit) return explicit;
  return schemaForAgent(getenv("AGENT_ID", undefined, env) ?? "telegram");
}

/**
 * The schema name quoted for interpolation into SQL.
 *
 * Every query in this package is built once at init with the schema spliced
 * in, because the driver's parameter slots cannot carry an identifier. That
 * makes the quoting here the only thing standing between a hostile agent id
 * and injected SQL, so it is enforced rather than assumed: anything outside
 * `[A-Za-z0-9_]` is refused rather than escaped, because a schema name is
 * generated by {@link schemaForAgent} and an exotic one means a caller has
 * gone around it.
 */
export function quoteSchema(schema: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(schema)) {
    throw new Error(
      `Refusing to build SQL with the schema name ${JSON.stringify(schema)}: ` +
        `only [A-Za-z0-9_] is accepted. Schema names come from ` +
        `schemaForAgent(); a name outside that set means something bypassed ` +
        `it, and interpolating it into a statement would be an injection.`,
    );
  }
  return `"${schema}"`;
}

// ── The connection ──────────────────────────────────────────────────────────

let pool: SQL | null = null;

/**
 * Open (once) and return the shared connection pool.
 *
 * Every module that persists anything shares this. The old design opened an ad
 * hoc handle per module, each having to remember its own lock-timeout setting
 * — a footgun that was found the hard way and then documented in four separate
 * places. One pool retires the whole class of mistake.
 */
export function getSql(): SQL {
  if (pool) return pool;
  const target = resolveTarget();
  pool = new SQL({
    hostname: target.host,
    port: Number(target.port),
    database: target.database,
    username: target.user,
    ...(target.password === null ? {} : { password: target.password }),
    max: 4,
  });
  return pool;
}

/** Close the shared pool. Safe to call when it was never opened. */
export async function closeSql(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.close();
}

/** Test hook: forget the pool without closing it (fresh env, fresh target). */
export function _resetSqlForTests(): void {
  pool = null;
}
