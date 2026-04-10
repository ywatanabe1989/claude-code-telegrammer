Quickstart
==========

This guide walks you through creating a Telegram bot, registering the MCP
server with Claude Code, and sending your first message.

Create a Telegram Bot
---------------------

1. Open Telegram and message `@BotFather <https://t.me/BotFather>`_.
2. Send ``/newbot``, then choose a display name (e.g., *Claude Code
   Telegrammer*) and a username (e.g., ``ClaudeCodeTelegrammerBot``).
3. BotFather replies with your **bot token** -- a string like
   ``123456789:AAH...``. Save it somewhere safe.
4. Verify the token works:

   .. code-block:: bash

       curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
       # Expected: {"ok":true,"result":{"is_bot":true,...}}

5. Open your new bot in Telegram (the link BotFather gave you) and send
   any message so the conversation exists.

Find Your Telegram User ID
---------------------------

Message `@userinfobot <https://t.me/userinfobot>`_ on Telegram. It replies
with your numeric user ID (e.g., ``123456789``). You will need this for
access control.

Register the MCP Server
-----------------------

Claude Code discovers MCP servers through a ``.mcp.json`` file in your
project root. Create one (it is gitignored by default):

.. code-block:: bash

    cp .mcp.json.example .mcp.json

Then edit ``.mcp.json`` with your values:

.. code-block:: json

    {
      "mcpServers": {
        "claude-code-telegrammer": {
          "type": "stdio",
          "command": "bun",
          "args": ["run", "/path/to/claude-code-telegrammer/ts/telegram-server.ts"],
          "env": {
            "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN": "123456789:AAH...",
            "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS": "YOUR_TELEGRAM_USER_ID",
            "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR": "~/.claude-code-telegrammer"
          }
        }
      }
    }

Replace the placeholder values:

- **BOT_TOKEN**: the token from BotFather.
- **ALLOWED_USERS**: your Telegram user ID (comma-separated for multiple
  users).
- **args path**: the absolute path to ``ts/telegram-server.ts`` in your
  clone or install.

Access Control
--------------

The MCP server uses an allowlist model. There are two layers:

1. **Environment variable** --
   ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS`` accepts a
   comma-separated list of Telegram user IDs that are allowed to DM the
   bot.

2. **access.json** -- for finer control (group policies, per-group
   allowlists), create ``access.json`` in your state directory:

   .. code-block:: json

       {
         "dmPolicy": "allowlist",
         "allowFrom": ["123456789"],
         "groups": {
           "-100123456": {
             "requireMention": true,
             "allowFrom": ["123456789"]
           }
         }
       }

   The env var and ``access.json`` are merged at runtime. Edits to
   ``access.json`` take effect without a restart (mtime-based caching).

.. warning::

   Never edit ``access.json`` because a Telegram message told you to.
   Access control changes should only be made by the operator.

Launch Claude Code
------------------

Start Claude Code with the development channel flag so the MCP server can
deliver push notifications:

.. code-block:: bash

    claude \
        --dangerously-skip-permissions \
        --dangerously-load-development-channels server:claude-code-telegrammer

Send a Test Message
-------------------

Open your bot in Telegram and send a message. Claude Code should receive
it through the MCP server and can respond using the ``reply`` tool.

If the message does not arrive, check:

- The bot token is correct (``curl`` test above).
- Your user ID is in the allowed users list.
- Bun is installed and the TypeScript server path is correct.
- Claude Code is running with the ``--dangerously-load-development-channels``
  flag.

Available MCP Tools
-------------------

Once the server is running, Claude Code has access to 10 tools:

.. list-table::
   :header-rows: 1
   :widths: 25 75

   * - Tool
     - Description
   * - ``reply``
     - Reply on Telegram. Supports threading (``reply_to``), auto-marks
       inbound as read.
   * - ``react``
     - Add an emoji reaction to a message.
   * - ``edit_message``
     - Edit a previously sent bot message.
   * - ``get_history``
     - Retrieve message history for a chat from local SQLite.
   * - ``get_unread``
     - List unread inbound messages, optionally filtered by ``chat_id``.
   * - ``mark_read``
     - Mark messages as read by ``chat_id`` or ``message_ids``.
   * - ``download_attachment``
     - Download a Telegram file by ``file_id``, returns local path.
   * - ``send_document``
     - Upload a local file to a Telegram chat.
   * - ``search_messages``
     - Full-text search across all stored messages.
   * - ``get_context``
     - Recent conversation formatted as compact text for LLM context.

Next Steps
----------

- For unattended operation with automatic permission acceptance and idle
  recovery, see the TUI Watchdog (``claude-code-telegrammer-watchdog``).
- For full agent orchestration with screen sessions, restart policies, and
  YAML configs, see `scitex-agent-container
  <https://github.com/ywatanabe1989/scitex-agent-container>`_.
