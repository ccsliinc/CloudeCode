"""The per-project block of ``config.json``.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. The body is byte-exact;
only the imports above it are new."""

from typing import Literal, Optional

from pydantic import BaseModel


class ProjectConfig(BaseModel):
    """Configuration for a predefined project.

    Phase 6 - agent-type labeling. ``agent_type`` is the default agent CLI
    used when sessions for this project are created without an explicit
    override. Defaults to ``"claude"`` so existing config.json files (which
    have no agent_type field) continue to deserialize and behave exactly
    as before. Per-project override; the explicit ``agent_type`` on the
    create-session request still takes precedence.
    """
    name: str
    path: str
    description: Optional[str] = None
    agent_type: Literal["claude", "codex", "hermes", "openclaw"] = "claude"
