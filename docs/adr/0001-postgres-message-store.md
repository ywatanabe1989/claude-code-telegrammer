# ADR 0001 — The message store moves to PostgreSQL

**Status:** accepted
**Date:** 2026-08-30

## Context

The fleet's standing directive (operator ruling, 2026-08-29) removes SQLite
from every SciTeX package, with no exceptions. This bridge was the last
holdout and the only one that is not Python: it is TypeScript, and it used
`bun:sqlite`, Bun's built-in driver.

That is why this needed a decision rather than a mechanical rewrite. The usual
answer elsewhere in the fleet — "use `scitex_dev.store`" — does not apply,
because that primitive is a Python package and there is no Python entry point
here at all.

### What the store actually held

Measured on one live agent's instance before anything was written
(`scitex-agent-container`, 2026-08-30):

| | |
|---|---|
| `messages` | 8,545 rows (2,894 inbound / 5,651 outbound) |
| `attachments` | 140 rows |
| `meta` | 4 keys — `schema_version`, `update_offset`, `last_poll_ts`, `wake_failure_state` |
| file sizes | 9.17 MB `.db` + 4.48 MB `-wal` + 32 KB `-shm` |
| span | 2026-08-11 → 2026-08-30, a single chat |

So it is roughly half durable state the fleet genuinely cares about (the
operator's message history, the attachment index) and half poller
restart-state (the getUpdates watermark, the poll-freshness heartbeat, the
wake-failure counter). None of it is a cache. Downloaded attachment FILES live
on the filesystem, not in the database, and they do not move.

## Decision

### The client: `Bun.SQL`

Bun ships a PostgreSQL client in its standard library. This package has
exactly one runtime dependency (`@modelcontextprotocol/sdk`), and adding a
second in order to move one storage engine is a poor trade, so the built-in
client wins on the "smallest dependency that does the job" test.

It was measured against the fleet primary on Bun 1.3.14 BEFORE any code was
written, because "it should work" is not a reason to build on something:

- parameterised `sql.unsafe(query, params)` with `$1` placeholders — works
- `sql.begin(tx)` transactions — work
- `.simple()` multi-statement DDL batches — work
- `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')` reproduces the
  previous engine's `datetime('now')` output byte for byte

Two things it does NOT do, both handled explicitly in `ts/lib/pg.ts`:

- It honours `PGUSER` but does **not** read the libpq password file, which is
  what this fleet actually stores credentials in. `lookupPasswordFile()` is a
  ~40-line reader for that format (including `*` wildcards, `\:` escapes, and
  libpq's refusal to read a group/world-readable file). No credential is ever
  placed in argv or written to a log; `describeTarget()` exists so diagnostics
  can name the server without naming the secret.
- 64-bit columns arrive as STRINGS (verified: `BIGSERIAL` → string, `INTEGER`
  → number), because a 64-bit integer does not fit a JavaScript number. `id`
  and `reply_to_row_id` are returned verbatim to MCP callers, so `store.ts`
  normalises them back to numbers rather than changing a shape agents already
  read.

### The DSN: environment only, no fallback

Precedence is `CCT_STORE_DSN` (telegrammer-scoped) → `SCITEX_STORE_DSN` (the
fleet switch) → **throw**. There is deliberately no local-file fallback. A
bridge that quietly stored the operator's messages somewhere nobody reads
would look healthy while losing every one of them, which is the exact failure
this migration exists to remove. Refusing to start is the honest outcome.

### The layout: one schema per agent

Each agent gets `cct_<sanitized agent id>`, mirroring the per-agent database
file it replaces and keyed identically.

This is not cosmetic. **In a Telegram private chat, `chat.id` is the human's
own user id**, which is the same for every bot he talks to. Two agents
therefore receive different message streams carrying the SAME `chat_id`, and
the `(chat_id, message_id, direction)` dedup index collides between them.
Pooling every agent into shared tables would have silently cross-wired their
histories — the kind of fault that produces a plausible-looking wrong answer
rather than an error.

Long agent ids are folded with a digest suffix, because PostgreSQL truncates
identifiers at 63 bytes SILENTLY and two truncated names would merge two
agents' stores.

### What did NOT change

The tables. Same columns, same names, same indexes, same partial indexes, same
`YYYY-MM-DD HH:MM:SS` UTC text timestamps. Anything reading a row sees exactly
what it saw before. The one unavoidable change is that every store function is
now `async`; a network database cannot be synchronous.

## Consequences

### Two real defects the new tests found

Both were found by tests that were converted rather than deleted, which is the
argument for converting them:

1. **`CREATE SCHEMA IF NOT EXISTS` is not concurrency-safe.** The MCP server
   and its poller start together and both call `initStore()`. Measured with
   two real processes: the loser died with `duplicate key value violates
   unique constraint "pg_namespace_nspname_index"`. A throw out of
   `initStore()` lands at top level, where JavaScript cannot resume, so the
   poller would have gone SILENTLY INERT — process alive, pidfile fresh,
   nothing ingesting. That is the 2026-07 incident this codebase already paid
   for once under the previous engine, arriving through a different door.
   Fixed by retrying the DDL batch on a catalog race (`applySchema`).

2. **A one-element array parameter was flattened to a scalar.** `= ANY($1)`
   with `[9]` produced `malformed array literal: "9"`, so a history page
   containing exactly ONE attachment failed while a page with two worked. The
   id list now travels as a comma-joined string the server expands, which has
   the same wire shape at every arity.

A third, pre-existing flake was also fixed: `health-adapters.test.ts` read
`/proc/<pid>/cmdline` before the spawned child had exec'd. Measured on the
unchanged branch, same host, three full-suite runs: 2, 2, and 1 failures,
while the file passed in isolation.

### The data has NOT been migrated

**This ADR ships the code change only.** No existing database file is
deleted, truncated, moved, renamed, or even opened. Every legacy file remains
byte-identical and fully re-readable.

That is a deliberate split, not an oversight. The store holds the operator's
own Telegram history and it is the only channel he reads, so a row import is
worth doing carefully and separately from a change that also rewrites the
storage layer, the test suite and two entry points.

What the code change DOES do is refuse to be silent about it.
`migrateLegacyStateDir()` detects a leftover `messages.db` /
`claude-code-telegrammer.db` in the legacy state dir and announces it — in the
structured result (`strandedDbFiles`) and in a log line that says the history
was not carried forward and points here. A history gap the operator has to
discover for himself is the incident that module was written for; announcing
it is the alternative.

### Importing the rows, when it is time

The import is an operator-run, one-shot step that lives OUTSIDE this
repository, because a tool that reads the old format would have to name the
retired engine and the eradication directive permits that string only in this
directory.

The shape it needs to take:

1. **Read-only, against a copy.** Snapshot the source first (its own
   `VACUUM INTO` produces one atomic, internally consistent file with no
   sidecars) and import from the snapshot, so a live bridge writing to the
   original cannot interleave with the read.
2. **Target the agent's own schema**, `cct_<sanitized agent id>` — the same
   name `schemaForAgent()` computes. Importing into the wrong namespace is
   the cross-wiring hazard described above.
3. **Preserve `id`.** `reply_to_row_id` references it, so a re-numbered import
   silently breaks reply threading. Insert with explicit ids, then
   `setval()` the `messages_id_seq` past the maximum, or the first new inbound
   message collides on the primary key.
4. **`ON CONFLICT DO NOTHING`**, so a re-run after a partial import resumes
   instead of failing, and so a message the live bridge has already stored
   post-cutover is never overwritten by an older copy of itself.
5. **Import `messages` before `attachments`** — the foreign key requires it.
6. **Leave `meta` alone.** `update_offset` and `last_poll_ts` describe the
   poller's position *now*; restoring an old watermark would make Telegram
   redeliver up to 24h of backlog, which the operator would experience as
   every already-read message arriving again.
7. **Verify by counting both sides**, per table, before declaring it done —
   and count the SOURCE inside the same run that does the import, not
   afterwards, because a tidy-up consumes the evidence it would be checked
   against.

Restarting the bridge is required for the code change to take effect. That is
an operator action; nothing here restarts a running bot.

### Testing

`bun test` now needs a real PostgreSQL. The suite refuses to run against a
production namespace (`lib/hermetic-guard.ts` requires a `cct_test_` schema,
which `ts/test/preload.ts` mints per process and drops afterwards, sweeping
namespaces abandoned by killed runs). CI provisions a `postgres:16` service
container, following the precedent set by `scitex-cards`.

There are no mocks. The concurrency, migration and race tests spawn real
processes against a real server, because that is the only way the properties
they pin can be observed at all.
