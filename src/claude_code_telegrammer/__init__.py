"""Claude Code Telegrammer -- screen-based auto-responder for Claude Code TUI."""

from __future__ import annotations

import pathlib

__version__ = "0.1.0"

# Package directory (works for both editable and regular installs)
_PKG_DIR = pathlib.Path(__file__).resolve().parent


def get_bin_path(script_name: str) -> str:
    """Return absolute path to an installed bash script in bin/.

    Searches two locations:
    1. <package>/bin/<script>  (symlinked or copied during install)
    2. <repo_root>/bin/<script>  (editable install fallback)
    """
    # Primary: inside package (symlink or copied)
    path = _PKG_DIR / "bin" / script_name
    if path.exists():
        return str(path)

    # Fallback: repo root (editable install, src layout)
    repo_root = _PKG_DIR.parent.parent
    path = repo_root / "bin" / script_name
    if path.exists():
        return str(path)

    raise FileNotFoundError(
        f"Script '{script_name}' not found in package bin/ or repo root bin/"
    )
