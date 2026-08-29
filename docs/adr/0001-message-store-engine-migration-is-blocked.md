# ADR-0001 — The message-store engine migration is blocked on a primitive gap

- **Status:** Open. Records a blocker and the ruling needed to clear it; it does
  NOT grant this package an exemption.
- **Date:** 2026-08-29
- **Context:** the fleet-wide ruling that SQLite is abolished and that storage is
  the per-host PostgreSQL reached through `scitex_dev.store`.

## Why this file exists

`docs/adr/` is the only location exempt from the "the string must not appear"
rule, because an ADR records a decision actually taken and rewriting it destroys
the record. This ADR is written **because** the migration could not be completed,
so that the residual violation is a measured, explained blocker rather than an
unexplained one. It must be deleted once the migration lands.

## What was measured

The audit was run against the live tree on 2026-08-29.

**This package has no Python storage layer to migrate.** The runtime is two
Bun/TypeScript processes — `ts/telegram-server.ts` (the 11 MCP tools) and
`ts/telegram-poller.ts` (`getUpdates`). `src/claude_code_telegrammer/_cli.py` is
a 154-line `execv` launcher; its own docstring says "Python never reimplements
env/hash logic, it only `execv`s `bun`." `pyproject.toml` declares zero runtime
dependencies. The store is `ts/lib/store.ts`, 494 lines against `bun:sqlite`.

**Live data at the time of the audit:** 8,444 messages (2,879 inbound / 5,565
outbound), 139 attachments all downloaded, one chat, 18 days of history
(2026-08-11 → 2026-08-29), growing at roughly 470 rows/day. `max(id)` equals the
row count, so nothing has ever been deleted.

## Why `scitex_dev.store` cannot back this store

Four independent blockers, any one of which is sufficient:

1. **No non-Python access path.** `scitex-dev store --help` → `No such command
   'store'`. There is no CLI, no REST surface, no socket server and no
   TypeScript client. A Bun process cannot reach the primitive at all.

2. **No query surface.** The entire read API is `get(key)` and `rows()`, and
   `rows()` is literally `SELECT * FROM <table>` fetched into Python — no
   filter, no `ORDER BY`, no `LIMIT`, no text search. Four of the eleven MCP
   tools have no expressible form: `get_history` (ordered, LIMIT/OFFSET),
   `get_unread` (filtered on a partial index), `search_messages` (`LIKE`), and
   `get_context` (ordered, limited). Each call would full-scan the message table.

3. **Wrong data model.** `scitex_dev.store` stores identity-keyed, last-writer-
   wins CRDT records and has no delete. The message log is an append-only
   `INTEGER PRIMARY KEY AUTOINCREMENT` sequence with a `UNIQUE(chat_id,
   message_id, direction)` index — that index *is* the dedup contract
   (`saveInbound` returns `null` on a duplicate) — plus an `attachments` child
   table with an `ON DELETE CASCADE` foreign key. `row_id` values are live
   protocol identifiers handed out to MCP clients in `<channel row_id=…>` tags,
   so they must survive any migration byte-for-byte.

4. **Synchronous vs asynchronous.** `bun:sqlite` is synchronous. Every
   PostgreSQL client available to Bun is promise-based. There are 261 store call
   sites across 28 modules and test files in a 24,691-line TypeScript codebase;
   all of them become `await`, virally, along with their callers.

## The trade-off a ruling has to weigh

Today the store is a local file with no network dependency. Pointing it at
`scitex-primary:55432` makes the operator's only channel to the fleet depend on
the overlay network and on one remote cluster — so a fleet outage would also
remove the channel he would use to hear about it. That is a deliberate
availability trade-off and is not this package's call to make alone.

## Options

- **A — port `ts/lib/store.ts` to PostgreSQL with a Bun client.** Clears the
  engine ruling. Does *not* use `scitex_dev.store`, so it is the hand-rolled
  database layer the second standing rule forbids; it needs an explicit waiver.
  Multi-PR: the async conversion alone touches every module.
- **B — give `scitex_dev.store` a non-Python access path and a query surface,**
  then port. Correct by both rules, and the gap is the primitive's, not this
  package's. Blocked until the primitive can filter, order and limit.
- **C — rewrite both processes in Python.** Discards a 24,691-line tested
  codebase and 684 passing tests. Not recommended.

## Decision

None taken. The code change is **not** attempted in the PR that adds this file,
because a half-migration of this store loses the operator's message history or
breaks the reply path, and this package is his only channel to the fleet.

## Consequences

`sqlite` still appears in `ts/` and in the documentation that describes it.
Scrubbing those strings while the engine remains was explicitly rejected: it
would leave either the code comments or the documentation asserting something
false about the running system. The count stays non-zero, visibly, until one of
the options above is chosen.
