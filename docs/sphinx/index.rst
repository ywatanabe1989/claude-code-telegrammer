.. claude-code-telegrammer documentation master file

claude-code-telegrammer - Telegram Agent for Claude Code
=========================================================

**claude-code-telegrammer** is a custom Telegram MCP server + TUI auto-responder for running Claude Code as an autonomous Telegram agent. Part of `SciTeX <https://scitex.ai>`_.

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

- **Telegram MCP Server**: Custom MCP server for Telegram message handling
- **TUI Auto-responder**: Terminal UI for monitoring and auto-responding
- **Watchdog**: Process monitoring and automatic restart
- **Guard**: Access control and security enforcement
- **Relay**: Message relay between Telegram and Claude Code
- **Hook Integration**: Claude Code hook-based message injection

Quick Example
-------------

.. code-block:: bash

    # Initialize configuration
    telegrammer-init

    # Start the watchdog (monitors and auto-restarts)
    telegrammer-watchdog

    # Start the relay
    telegrammer-relay

Indices and tables
==================

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
