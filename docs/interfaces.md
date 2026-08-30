# Interfaces

## MCP server (for AI agents)

Start command:

```bash
bun run ts/telegram-server.ts
```

Exposes 11 tools over the MCP stdio protocol. The server's MCP instructions embed
a **responsiveness policy**: acknowledge inbound messages immediately and
delegate heavy work to background subagents, so the relay never blocks.

| Tool | Description |
|------|-------------|
| `reply` | Reply on Telegram. Supports threading (`reply_to`), auto-marks the inbound as read; inbound reply-to references are tracked and forwarded. |
| `react` | Add an emoji reaction. Inbound reactions (`message_reaction`) are also delivered as channel notifications. |
| `edit_message` | Edit a message the bot previously sent. |
| `get_history` | Retrieve message history for a chat from the message store. Rows with stored attachments include an `attachments` array (kind, file_id, local_path, …). |
| `get_unread` | List unread inbound messages, optionally filtered by `chat_id`. Includes the same `attachments` array. |
| `mark_read` | Mark messages read by `chat_id` or `message_ids`. |
| `download_attachment` | Resolve a Telegram file to a local path by `file_id` **or** `row_id`. Returns the existing path without re-downloading when the auto-download already completed. |
| `send_document` | Upload a local file to a Telegram chat. |
| `search_messages` | Text search across stored messages. |
| `get_context` | Recent conversation formatted as compact text for LLM context. |
| `health` | Run the health check (doctor) inside the server process; returns the JSON report below. |

Inbound messages arrive as `<channel source="claude-code-telegrammer" …>`
notifications carrying `chat_id` / `message_id` / `row_id` / `user` — pass
`chat_id` and `row_id` back to `reply`.

### Inbound attachments

Media messages (photo/document/voice/audio/video) render a bracketed
descriptor directly in the content line — e.g.
`(photo) [attachment kind=photo file_id=AgACAg… — call
download_attachment(file_id) for the local path]` — because only the content
string is guaranteed to reach the agent (the harness renders a whitelist of
meta keys). Retrieve the file via `download_attachment` with that `file_id`
or with the message's `row_id`; attachments are also auto-downloaded in the
background, after which `get_history` / `get_unread` report the `local_path`.

### Inbound replies

When the operator replies to a specific message, the `<channel …>` tag gains
`reply_to_message_id`, and the content line is prefixed with a one-line
descriptor carrying an excerpt of the replied-to message:

```
<channel source="cct" … message_id="8303" reply_to_message_id="8293">
[in-reply-to message_id=8293 from=bot:@YourBot text="…which option, A or B?"]
A
</channel>
```

The excerpt exists so a one-word reply ("A") is answerable without a second
lookup. It is capped at 512 code points — above the 509-character maximum of
the real message corpus, so it does not truncate in practice — collapsed to a
single line, and marked when it does truncate
(`truncated_from=<N>`, plus a trailing `…`).

Both directions can be reply targets; replying to a message the BOT sent is
the common case. A target the bridge cannot resolve is stated rather than
omitted (`text=UNRESOLVED …`), so "not a reply" and "a reply I could not
resolve" never look alike. A quoted fragment (Bot API 7.0) renders as
`quote="…"` instead of `text="…"`.

## Skills (for AI agent discovery)

A bundled skill lives at
`src/claude_code_telegrammer/_skills/claude-code-telegrammer/SKILL.md`.

## config probe (for orchestrators)

```bash
bun run ts/telegram-server.ts config [--check]
```

Resolves and prints the effective config as JSON (agent_id, bot_token_hash,
state_dir, channel_source, turn_url) **without** starting the server or poller.
`--check` adds a single `getMe` to confirm the token → `@username` mapping. Used
to preflight per-agent bot identity and detect two agents resolving to the same
bot. The raw token is never printed.

## health (doctor)

```bash
bun run ts/telegram-server.ts health          # CLI (or: claude-code-telegrammer health)
```

Runs the standard health-checker — also exposed as the `health` MCP tool — and
prints a JSON report **without** starting the server or poller. Ten named
checks cover env hygiene (`env_unexpanded`, `env_renamed`, `env_legacy`), the
bot token (`bot_token_present`, `bot_token_valid` via getMe), delivery
(`webhook_absent` — a set webhook starves getUpdates polling), the poller
(`poller_alive` via kill-0 on the recorded PID; the MCP-tool variant reports
its own process), access gating (`allowlist_nonempty`), and local state
(`state_dir_writable`, `db_schema_current` incl. a poisoned-`update_offset`
detector). Every failing check carries an actionable `hint`; a tokenless agent
is reported as disabled-by-design (warn), not unhealthy. The exit code reflects
probe success, not health — a false `ok` is a finding, not a crash. The raw
token is never printed.

```json
{
  "package": "claude-code-telegrammer",
  "ok": true,
  "checks": [
    { "name": "env_unexpanded", "ok": true, "detail": "...", "hint": null }
  ],
  "summary": "10/10 checks ok"
}
```
