"""QNotes companion plugin for Hermes Agent."""

from pathlib import Path

from .commands import make_help_handler, make_status_handler


def register(ctx):
    """Register only the QNotes guidance commands and opt-in skill."""
    help_handler = make_help_handler(ctx)
    status_handler = make_status_handler(ctx)
    skill_path = Path(__file__).parent / "skills" / "workflow" / "SKILL.md"

    ctx.register_skill(
        "workflow",
        skill_path,
        description="Use authorized QNotes and Vault tools safely.",
    )
    ctx.register_command(
        "qnotes",
        handler=help_handler,
        description="QNotes setup and workflow guidance",
    )
    ctx.register_command(
        "qnotes-help",
        handler=help_handler,
        description="Explain QNotes profiles and safe usage",
    )
    ctx.register_command(
        "qnotes-status",
        handler=status_handler,
        description="Check QNotes setup without revealing content",
        args_hint="[--check]",
    )
