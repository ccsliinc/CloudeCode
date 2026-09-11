"""The toast copy for one Claude Code hook event.

Lifted verbatim out of ``src/api/routes.py``'s hook endpoint by
decomposition slice S6. It is PURE: a kind and a payload dict in, a title
and an optional body out, no I/O and no session manager, so the copy the
user actually reads is testable without an HTTP request and without a
live pane.

The payload shape is not a formally stable contract across Claude Code
releases, so every read is defensive and a malformed payload yields
generic copy rather than raising. A raise here would turn a hook POST
into a 500 that the hook subprocess cannot act on.
"""

from __future__ import annotations

from typing import Optional


def hook_event_presentation(kind: str, payload: dict) -> tuple[str, Optional[str]]:
    """Map a hook event + payload into (title, body) for the toast.

    Inputs: ``kind``, one of the TOAST_EVENTS kinds; ``payload``, the raw
      JSON body Claude Code piped to the hook, already coerced to a dict.
    Output: ``(title, body)``. ``body`` is None when the payload carried
      nothing worth showing, which is a legitimate toast.
    Example::

        hook_event_presentation("Notification", {"message": "look at me"})
        # -> ("wants your attention", "look at me")

    Defensive ``.get()`` everywhere - Claude Code's payload shape is not
    a formally-stable contract across versions, and a malformed payload
    must NEVER raise here (it just yields a generic toast).

    Body strings are truncated to 200 chars so a rogue payload can't
    blow out the toast UI; the goal is "you have something to attend to",
    not a full transcript replay.
    """
    body: Optional[str] = None

    if kind == "Stop":
        # Documented base fields don't include the model's last message
        # directly, but several Claude Code releases surface
        # ``stop_reason`` or a ``transcript``-shaped field. Treat all as
        # optional. Fall through to a generic body when nothing useful
        # is present.
        title = "Your turn"
        transcript = payload.get("transcript") or payload.get("last_model_message")
        if isinstance(transcript, str) and transcript.strip():
            body = transcript.strip()[-200:]
        else:
            stop_reason = payload.get("stop_reason")
            if isinstance(stop_reason, str) and stop_reason.strip():
                body = f"stop_reason: {stop_reason.strip()[:180]}"

    elif kind == "PermissionRequest":
        # Lowercase plain copy, and it names WHICH kind of waiting this
        # is - the split that gave PermissionRequest and Notification
        # their own status states (``question`` vs ``notice``) is only
        # useful if the toast the user actually reads says it too.
        title = "needs your permission"
        # Prefer the tool-shape (tool_name + tool_input) since that's the
        # most useful single line for the user. Fall back to a `prompt`
        # field if Claude Code's payload uses that shape instead.
        tool_name = payload.get("tool_name")
        tool_input = payload.get("tool_input")
        if isinstance(tool_name, str) and tool_name:
            # Surface the most recognizable bit of tool_input - Bash =>
            # command, Edit/Write => file_path, else the tool name alone.
            detail = ""
            if isinstance(tool_input, dict):
                detail = (
                    tool_input.get("command")
                    or tool_input.get("file_path")
                    or ""
                )
            body = f"{tool_name}: {detail}".strip(": ").strip()[:200] or tool_name[:200]
        else:
            prompt = payload.get("prompt") or payload.get("message")
            if isinstance(prompt, str) and prompt.strip():
                body = prompt.strip()[:200]
        if not body:
            body = "Claude is asking for permission to act."
    elif kind == "Notification":
        # Deliberately NOT "is waiting": a Notification does not stop the
        # agent. See the PermissionRequest branch above.
        title = "wants your attention"
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            body = message.strip()[:200]
    else:  # pragma: no cover - only called for TOAST_EVENTS kinds
        title = "Claude event"

    return title, body

