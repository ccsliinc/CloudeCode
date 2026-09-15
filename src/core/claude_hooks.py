"""Removing cloudecode's managed hook block from ``~/.claude/settings.json``.

THIS MODULE USED TO INSTALL HOOKS. IT NOW ONLY TAKES THEM BACK OUT.

CloudeCode learned a session's state by making Claude Code POST every
lifecycle event to a loopback endpoint. That was measured wrong nine
times in ten, because ``CLOUDECODE_SESSION_ID`` is a PANE-WIDE
environment variable: the parent agent and every background agent it
spawned posted under one session id, so a sub-agent's own tool call
looked exactly like the user's turn resuming. The whole subsystem is
gone, replaced by passive detection that reads what the harness already
writes to disk (``src/core/attention/``).

So the one job left here is CLEANING UP AFTER THE OLD VERSION. An install
that ran any earlier build has our block sitting in the user's settings
file, pointing at an endpoint that no longer exists, making Claude Code
pay for a curl on every single event forever. :func:`strip_managed_hooks`
is called once at startup and removes it.

What it must never do:

- **Touch a hook the user wrote.** Every managed command carries the
  literal marker ``# cloudecode-managed``. Only entries bearing it are
  dropped; everything else is written back byte-for-byte.
- **Clobber a file it could not parse.** A read error or a syntax error
  LOGS and BAILS, exactly as the old merge did.
- **Leave litter behind.** An event key whose matcher list is emptied by
  the strip is removed, and a ``hooks`` key emptied by that is removed
  too, so a user who never had hooks of their own is left with the file
  they would have had if CloudeCode had never run.
- **Skip anyone.** There is deliberately NO opt-out check. The old
  ``disable_claude_hooks`` setting is gone, and honouring it here would
  skip the cleanup for exactly the users who asked not to have the block
  in the first place - the ones most likely to still be carrying one
  from before they set the flag.

The write is atomic: write-to-tmp + rename. The file is left untouched
when there was nothing of ours in it, so a steady-state boot does not
rewrite the user's settings at all.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import structlog

from src.core.test_write_guard import assert_test_write_allowed

logger = structlog.get_logger()


# Literal marker embedded into every managed hook's command string. Used
# to identify (and replace) cloudecode's own hooks on re-run without
# touching anything the user added by hand or via another tool.
CLOUDECODE_HOOKS_MARKER = "# cloudecode-managed"

# feat/hook-driven-status - events that are worth interrupting the user
# for (a toast). Unchanged from the original three; kept as its own tuple
# (rather than folded into ACTIVITY_ONLY_EVENTS below) because the hook
# endpoint (src/api/routes.py) branches on this exact set to decide
# whether to call ``SessionManager.record_toast`` + broadcast, in addition
# to always updating the activity tracker.
TOAST_EVENTS = ("Stop", "Notification", "PermissionRequest")

# feat/hook-driven-status - events that feed ONLY the activity-status state
# machine (src/core/session_activity.py), never a toast. PreToolUse and
# PostToolUse in particular fire on every single tool call - turning those
# into toasts would spam the user; they exist purely as the "working"
# heartbeat and the SubagentStart/SubagentStop pair.
ACTIVITY_ONLY_EVENTS = (
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
)

# feat/session-lineage - events that report WHICH CLAUDE CONVERSATION is
# running in this tmux session, and when it ended. Neither is a toast and
# neither feeds the activity state machine: they exist only to write
# ``sessions.claude_session_uuid`` / ``parent_session_id`` / ``fork_kind``
# (src/core/session_lineage.py).
#
# Kept as its own tuple for the same reason TOAST_EVENTS is: the endpoint
# branches on this exact set to decide whether to run the lineage write,
# so the routing cannot drift from what gets installed.
#
# PAYLOAD SHAPE, VERIFIED AGAINST THE SHIPPED BINARY (2.1.236) rather
# than taken from prose. Common to both: ``session_id``,
# ``transcript_path``, ``cwd``, ``hook_event_name``, ``permission_mode``.
# SessionStart additionally carries ``source``, whose enum is literally
# ["startup", "resume", "clear", "compact", "fork"], plus ``agent_type``,
# ``model`` and ``session_title`` - the last three are undocumented and
# are therefore read defensively, never required. SessionEnd additionally
# carries ``reason``.
LIFECYCLE_EVENTS = ("SessionStart", "SessionEnd")

# WORK, as opposed to BROWSING. The events that mean the conversation
# itself did something: a prompt was submitted, a tool ran, a subagent ran,
# a turn stopped, permission was asked for, a notification was raised.
# ``sessions.last_work_at`` is stamped from these and from nothing else,
# and the session and project lists are ordered by it - so this tuple is
# the definition of what is allowed to move a row up the list.
#
# WHY LIFECYCLE_EVENTS ARE EXCLUDED, and it is the whole point of the
# tuple existing. ``SessionStart`` fires with ``source`` in
# ["startup", "resume", "clear", "compact", "fork"], and ``resume`` is
# emitted when a user REJOINS a conversation - i.e. exactly when he
# clicked a row to look at it. Counting that as work would reintroduce
# the defect this ordering exists to remove, through the one event that
# looks least like browsing from the endpoint's side. ``SessionEnd`` is
# excluded for the mirror-image reason: a session ending is not the
# session working, and stamping it would float every dead session to the
# top of a list whose whole job is to say what is live and recent.
#
# Notification / PermissionRequest ARE included and that is deliberate:
# both mean a turn is in flight and waiting on the user. A session that
# is blocked asking for permission is the single most work-in-progress
# state there is, and burying it would be the opposite of useful.
WORK_EVENTS = TOAST_EVENTS + ACTIVITY_ONLY_EVENTS


def _is_managed_command(cmd: Any) -> bool:
    """True iff a hook command string carries the cloudecode marker.

    Tolerates non-string ``command`` values (just returns False rather
    than raising) so a user's custom hook with an unexpected shape can't
    crash the strip.
    """
    return isinstance(cmd, str) and CLOUDECODE_HOOKS_MARKER in cmd


def _filter_user_matchers(
    matchers: list[Any], event: str
) -> list[Any]:
    """Drop every cloudecode-managed entry from a matcher list.

    A matcher entry is the ``{"matcher": "*", "hooks": [...]}`` dict.
    We classify it as managed if AT LEAST ONE of its inner ``hooks``
    bears our marker. (Mixed user/managed matcher dicts shouldn't
    happen if everyone respects the marker convention, but if they do
    we err on the side of letting the user's entry through: keeping a
    hook the user wrote is recoverable, deleting one is not.)
    """
    keep: list[Any] = []
    for matcher_entry in matchers:
        if not isinstance(matcher_entry, dict):
            keep.append(matcher_entry)
            continue
        inner_hooks = matcher_entry.get("hooks", [])
        if not isinstance(inner_hooks, list):
            keep.append(matcher_entry)
            continue
        # If ANY hook in this matcher is managed, drop the whole entry.
        # Every hook we ever wrote lived alone in its own matcher, so
        # this cannot take a user's hook down with it.
        if any(
            isinstance(h, dict) and _is_managed_command(h.get("command"))
            for h in inner_hooks
        ):
            continue
        keep.append(matcher_entry)
    return keep


#: Env var that overrides the production settings destination. Exists so
#: ``tests/conftest.py`` can point the DEFAULT at a temp file, which makes
#: the ordinary path safe as well as guarded. Production leaves it unset.
SETTINGS_PATH_ENV_VAR = "CLOUDE_CLAUDE_SETTINGS_PATH"


def default_settings_path() -> Path:
    """Resolve the settings file the production caller means.

    This used to be an inline ``or`` fallback inside the old
    ``ensure_hook_settings``, which meant a caller that passed
    nothing INHERITED the developer's real ``~/.claude/settings.json``
    without ever saying so. A plain ``pytest`` run then merged
    CloudeCode's managed hook block into the developer's live Claude Code
    configuration, silently and successfully.

    Making it a named function with no caller-side default turns that
    into a decision somebody has to write down.

    Inputs:
        None. Reads :data:`SETTINGS_PATH_ENV_VAR` from the environment.
    Outputs:
        Path - the override when set, otherwise
        ``~/.claude/settings.json``.
    Example:
        >>> default_settings_path()
        PosixPath('/Users/someone/.claude/settings.json')
    """
    override = os.environ.get(SETTINGS_PATH_ENV_VAR)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".claude" / "settings.json"


def strip_managed_hooks(settings_path: Path) -> bool:
    """Remove cloudecode's managed hook block from a settings file.

    Description: the successor to the old ``ensure_hook_settings``, which
      INSTALLED the block this now deletes. Called once at FastAPI
      startup so an install upgraded from any earlier build stops paying
      for a curl on every Claude Code lifecycle event, aimed at an
      endpoint that no longer exists.

      IT IS THE ONLY THING LEFT THAT TOUCHES THE USER'S SETTINGS FILE,
      and it only ever subtracts. An entry is removed if and only if one
      of its commands carries the literal ``# cloudecode-managed``
      marker; anything else is written back unchanged, in place, in
      order.

      THREE LEVELS OF EMPTINESS ARE CLEANED UP, and the reason is that
      stopping halfway leaves litter that reads like configuration. A
      matcher list emptied by the strip removes its event key; a
      ``hooks`` object emptied by that removes itself. A user who never
      wrote a hook is left with exactly the file they would have had if
      CloudeCode had never run.

      NOTHING IS WRITTEN WHEN NOTHING OF OURS WAS FOUND. A steady-state
      boot, and every boot for a user who never had the block, does not
      rewrite the file at all - so this cannot churn mtimes, cannot lose
      a concurrent edit it had no reason to touch, and cannot reformat a
      file it has no business reformatting.

      THERE IS DELIBERATELY NO OPT-OUT CHECK. The old
      ``notifications.disable_claude_hooks`` flag is gone. Consulting one
      here would skip the cleanup for precisely the users who asked not
      to have the block - the ones most likely to still be carrying one
      installed before they set the flag.
    Inputs:
      settings_path: the settings file to strip. REQUIRED and with no
        default, for the reason :func:`default_settings_path` gives.
    Output:
      bool - True when the file is clean of our block, whether this call
      removed one, found none, or found no file at all. False on any
      handled failure (unparseable JSON, a read error, a write error),
      where the file is left exactly as it was and the caller should LOG
      AND CONTINUE: cleanup is best-effort and must never block boot.
    Raises:
      OutsideTempWriteError: only during a test run, and only for a
        destination outside every temp root. Deliberately NOT caught and
        deliberately NOT folded into the ``False`` return - a harness
        violation must fail the test loudly rather than degrade into a
        handled failure nobody reads.
    Example:
      strip_managed_hooks(default_settings_path())
    """
    path = settings_path

    # Blast-radius control. Inert in production; under pytest this
    # refuses any destination outside a temp root, which is the only
    # check that survives a caller importing this module directly, a
    # test building its own app, or a subprocess.
    assert_test_write_allowed(path)

    if not path.exists():
        return True

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning(
            "claude_settings_read_failed", path=str(path), error=str(exc)
        )
        return False

    if not raw.strip():
        return True

    try:
        existing = json.loads(raw)
    except json.JSONDecodeError as exc:
        # The user's file is corrupted or unparseable. We CANNOT safely
        # rewrite it - bail loud rather than clobber.
        logger.warning(
            "claude_settings_unparseable", path=str(path), error=str(exc)
        )
        return False

    if not isinstance(existing, dict):
        logger.warning(
            "claude_settings_not_object",
            path=str(path),
            type=type(existing).__name__,
        )
        return False

    hooks_block = existing.get("hooks")
    if not isinstance(hooks_block, dict):
        # No hooks object at all, or one of a shape we did not write.
        # Either way there is nothing of ours in it to take out.
        return True

    stripped: dict[str, Any] = {}
    removed: list[str] = []
    for event, matchers in hooks_block.items():
        if not isinstance(matchers, list):
            # A shape we never wrote. Preserve it verbatim.
            stripped[event] = matchers
            continue
        kept = _filter_user_matchers(matchers, event)
        if len(kept) != len(matchers):
            removed.append(event)
        # AN EVENT KEY WHOSE LIST WE EMPTIED IS DROPPED, but one that was
        # ALREADY empty before we looked is preserved: that empty list is
        # the user's, and deleting it would be this function editing
        # something it did not write.
        if not kept and matchers:
            continue
        stripped[event] = kept

    if not removed:
        return True

    merged = dict(existing)
    if stripped:
        merged["hooks"] = stripped
    else:
        merged.pop("hooks", None)

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".cloudecode-tmp")
        tmp.write_text(
            json.dumps(merged, indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
        tmp.replace(path)
        logger.info(
            "claude_hooks_settings_stripped",
            path=str(path),
            events=removed,
        )
        return True
    except OSError as exc:
        logger.warning(
            "claude_hooks_settings_strip_failed",
            path=str(path),
            error=str(exc),
        )
        return False
