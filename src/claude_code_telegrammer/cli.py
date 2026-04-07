"""Thin CLI wrappers that exec the real bash scripts."""

from __future__ import annotations

import os
import sys


def _exec_script(name: str) -> None:
    """Find and exec a bash script from the package's bin/ directory."""
    from . import get_bin_path

    script = get_bin_path(name)
    os.execv("/bin/bash", ["bash", script] + sys.argv[1:])


def telegrammer() -> None:
    _exec_script("telegrammer")


def telegrammer_watchdog() -> None:
    _exec_script("telegrammer-watchdog")


def telegrammer_guard() -> None:
    _exec_script("telegrammer-guard")


def telegrammer_init() -> None:
    _exec_script("telegrammer-init")
