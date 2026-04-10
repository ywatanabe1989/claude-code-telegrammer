Installation
============

Prerequisites
-------------

- **Python** >= 3.10 (for the CLI and watchdog)
- **Bun** >= 1.0 (for the MCP server -- `install Bun <https://bun.sh/>`_)
- **GNU Screen** (for the TUI watchdog, optional)
- **Claude Code CLI** installed and authenticated
- A **Telegram Bot Token** (see :doc:`quickstart`)

From PyPI
---------

.. code-block:: bash

    pip install claude-code-telegrammer

This installs the Python package with CLI entry points
(``claude-code-telegrammer``, ``claude-code-telegrammer-watchdog``, etc.).

From Source
-----------

.. code-block:: bash

    git clone https://github.com/ywatanabe1989/claude-code-telegrammer.git
    cd claude-code-telegrammer
    pip install -e .

    # Install TypeScript dependencies for the MCP server
    cd ts && bun install

Environment Variables
---------------------

MCP Server
^^^^^^^^^^

.. list-table::
   :header-rows: 1
   :widths: 35 10 15 40

   * - Variable
     - Required
     - Default
     - Description
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN``
     - Yes
     - --
     - Telegram Bot API token from BotFather.
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR``
     - No
     - ``~/.claude-code-telegrammer``
     - Directory for SQLite DB, access.json, and lock file.
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS``
     - No
     - --
     - Comma-separated Telegram user IDs for the DM allowlist.
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_HOST_NAME``
     - No
     - ``os.hostname()``
     - Hostname stored with each message.
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_PROJECT``
     - No
     - ``process.cwd()``
     - Project path stored with each message.
   * - ``CLAUDE_CODE_TELEGRAMMER_TELEGRAM_AGENT_ID``
     - No
     - ``telegram``
     - Agent identifier stored with each message.

Watchdog
^^^^^^^^

.. list-table::
   :header-rows: 1
   :widths: 40 20 40

   * - Variable
     - Default
     - Description
   * - ``CLAUDE_CODE_TELEGRAMMER_SESSION``
     - ``claude-code-telegrammer``
     - GNU Screen session name to monitor.
   * - ``CLAUDE_CODE_TELEGRAMMER_WATCHDOG_INTERVAL``
     - ``1.5``
     - Poll interval in seconds.
   * - ``CLAUDE_CODE_TELEGRAMMER_RESP_Y_N``
     - ``1``
     - Keystroke sent for y/n prompts.
   * - ``CLAUDE_CODE_TELEGRAMMER_RESP_Y_Y_N``
     - ``2``
     - Keystroke sent for y/y/n prompts.
   * - ``CLAUDE_CODE_TELEGRAMMER_RESP_WAITING``
     - ``/speak-and-call``
     - Command sent when Claude Code is idle.

Verify the Installation
-----------------------

1. Check the Python package:

   .. code-block:: bash

       claude-code-telegrammer --help

2. Check that Bun can run the MCP server:

   .. code-block:: bash

       bun --version
       # Should print >= 1.0

3. Test the bot token (replace with your actual token):

   .. code-block:: bash

       curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
       # Should return {"ok":true,"result":{"is_bot":true,...}}

If all three checks pass, proceed to :doc:`quickstart`.
