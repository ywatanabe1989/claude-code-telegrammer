.. claude-code-telegrammer documentation master file

claude-code-telegrammer
=======================

**Custom Telegram MCP server + TUI auto-responder for running Claude Code
as an autonomous Telegram agent.**

Part of the `SciTeX <https://scitex.ai>`_ ecosystem.

The official ``plugin:telegram@claude-plugins-official`` has several
unresolved issues (hardcoded paths, 409 conflicts on multi-instance
polling, zombie CPU usage). This package replaces and extends it with a
self-contained MCP server and a TUI watchdog that keeps Claude Code
running unattended.

Why Not the Official Plugin?
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 35 30 35

   * - Problem
     - Official Plugin
     - claude-code-telegrammer
   * - Hardcoded paths (`#851 <https://github.com/anthropics/claude-code/issues/851>`_)
     - Config path ``~/.claude/`` only
     - Configurable ``STATE_DIR`` env var
   * - 409 Conflict on multi-bot (`#1075 <https://github.com/anthropics/claude-code/issues/1075>`_)
     - No single-instance guard
     - PID-based lock file prevents duplicates
   * - Zombie CPU usage (`#1146 <https://github.com/anthropics/claude-code/issues/1146>`_)
     - Process lingers after session ends
     - Clean shutdown on stdin close / SIGTERM
   * - Message persistence
     - No local history
     - SQLite store with full-text search
   * - Access control
     - Basic allowlist
     - DM + group policies, mtime hot-reload
   * - Attachment support
     - None
     - Auto-download inbound, upload via tool
   * - Reply threading
     - Not tracked
     - ``reply_to_message_id`` stored and delivered
   * - Reaction support
     - Not available
     - Send and receive emoji reactions

.. toctree::
   :maxdepth: 2
   :caption: Getting Started

   installation
   quickstart

.. toctree::
   :maxdepth: 2
   :caption: API Reference

   api/claude_code_telegrammer

Key Features
------------

- **10 MCP Tools** -- ``reply``, ``react``, ``edit_message``,
  ``get_history``, ``get_unread``, ``mark_read``, ``download_attachment``,
  ``send_document``, ``search_messages``, ``get_context``.
- **SQLite Message Store** -- all messages persisted in WAL-mode SQLite
  with full-text search, threading metadata, and attachment tracking.
- **Allowlist Access Control** -- DM and group policies via env var and
  ``access.json``, merged at runtime with mtime-based hot-reload.
- **Attachment Handling** -- auto-download inbound files, upload local
  files via ``send_document``.
- **Reaction Support** -- add emoji reactions to any message.
- **Message Editing** -- edit previously sent bot messages in-place.
- **PID-based Single-instance Lock** -- prevents 409 conflict errors when
  multiple sessions target the same bot.
- **Clean Shutdown** -- exits on stdin close or SIGTERM, no zombie
  processes.
- **TUI Watchdog** -- polls a GNU Screen session, detects Claude Code's
  TUI state (permission prompts, idle), and sends keystrokes to keep the
  agent running.
- **Configurable State Directory** -- all state (DB, lock, access config)
  lives under ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR``, not
  hardcoded paths.

Quick Example
-------------

.. code-block:: bash

    # Install
    pip install claude-code-telegrammer

    # Configure .mcp.json with your bot token and user ID
    cp .mcp.json.example .mcp.json

    # Launch Claude Code with the Telegram channel
    claude \
        --dangerously-skip-permissions \
        --dangerously-load-development-channels server:claude-code-telegrammer

Architecture
------------

.. code-block:: text

    User (Telegram)
        |
        |  Bot API (getUpdates long-polling)
        v
    Custom Telegram MCP Server (ts/telegram-server.ts)
        Bun + @modelcontextprotocol/sdk
        Poller | SQLite Store | 10 MCP Tools | Attachments
        Access Control | Config (env vars) | PID Lock
        |
        | MCP stdio
        v
    Claude Code (in GNU Screen session)
        |
        | screen buffer
        v
    Watchdog (claude-code-telegrammer-watchdog)
        Polls screen buffer, detects TUI state, sends keystrokes

Indices and tables
==================

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
