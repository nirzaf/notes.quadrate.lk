"""Native Hermes commands for the QNotes companion plugin."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NOTES_PROFILES = frozenset({"read", "share", "write"})
VAULT_PROFILES = frozenset({"none", "metadata", "reveal", "write"})


def _read_settings(ctx: Any) -> tuple[str, str, str] | None:
    """Read and validate only this plugin's non-secret settings."""
    try:
        server = ctx.get_config("server_name", "qnotes_read")
        notes = ctx.get_config("notes_profile", "read")
        vault = ctx.get_config("vault_profile", "none")
    except Exception:
        return None
    if (
        not isinstance(server, str)
        or SERVER_NAME.fullmatch(server) is None
        or not isinstance(notes, str)
        or notes not in NOTES_PROFILES
        or not isinstance(vault, str)
        or vault not in VAULT_PROFILES
    ):
        return None
    return server, notes, vault


def _help_server_name(ctx: Any) -> str:
    try:
        value = ctx.get_config("server_name", "qnotes_read")
    except Exception:
        return "qnotes_read"
    return value if isinstance(value, str) and SERVER_NAME.fullmatch(value) else "qnotes_read"


def _contains_structured_failure(value: Any, depth: int = 0) -> bool:
    """Reject known nested MCP failure/truncation envelopes without logging data."""
    if depth > 4 or not isinstance(value, dict):
        return False
    if value.get("isError") is True or value.get("ok") is False:
        return True
    if value.get("truncated") is True or "error" in value:
        return True
    for key in ("result", "structuredContent", "data"):
        if key in value and _contains_structured_failure(value[key], depth + 1):
            return True
    return False


def _probe_succeeded(result: Any) -> bool:
    if not isinstance(result, dict) or result.get("ok") is not True:
        return False
    return not _contains_structured_failure(result)


def make_help_handler(ctx: Any) -> Callable[[str], str]:
    def handle(raw_args: str) -> str:
        if not isinstance(raw_args, str) or raw_args.strip():
            return "Usage: /qnotes-help"
        server = _help_server_name(ctx)
        return (
            "QNotes is a companion plugin; its knowledge and Vault operations "
            "come from the configured MCP server.\n"
            f"Configured MCP server: {server}\n"
            "Load qnotes:workflow explicitly before using the workflow.\n"
            "Use /qnotes-status for local configuration; add --check for one "
            "bounded, metadata-only probe.\n"
            "Notes writes, public sharing, and Vault metadata/reveal/write "
            "are separate opt-ins enforced by QNotes."
        )

    return handle


def make_status_handler(ctx: Any) -> Callable[[str], str]:
    def handle(raw_args: str) -> str:
        mode = raw_args.strip() if isinstance(raw_args, str) else None
        if mode not in {"", "--check"}:
            return "Usage: /qnotes-status [--check]"

        settings = _read_settings(ctx)
        if settings is None:
            return "QNotes plugin settings are invalid. Review local setup."
        server, notes, vault = settings
        summary = (
            f"Configured MCP server: {server}\n"
            f"Configured Notes profile: {notes}\n"
            f"Configured Vault profile: {vault}\n"
            "These settings do not prove connectivity or backend grants."
        )
        if mode == "":
            return summary

        call_mcp = getattr(ctx, "call_mcp", None)
        if not callable(call_mcp):
            return summary + "\nThis Hermes build does not support the probe API."
        try:
            result = call_mcp(server, "list_notebooks", {}, timeout=10)
        except PermissionError:
            return summary + (
                "\nPlugin MCP access is not granted. Review "
                "plugins.entries.qnotes.mcp_allowlist."
            )
        except Exception:
            return summary + "\nMetadata check failed. Review local setup."
        if not _probe_succeeded(result):
            return summary + "\nMetadata check did not succeed."
        return summary + "\nNotes metadata check succeeded. No Vault secret was requested."

    return handle
