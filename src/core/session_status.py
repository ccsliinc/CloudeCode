"""Session activity-status resolution - single source of truth.

Both ``TmuxBackend`` (bulk pane query) and ``SessionManager`` (owned +
attachable session listings) resolve a session's activity state through
``resolve_pane_status()`` so the rule lives in exactly one place. The states
are deliberately small and honest: we only claim what tmux's pane-level
introspection can actually tell us.

- ``dead``    - ``#{pane_dead}`` is ``"1"``. The pane's foreground process
  exited; tmux is only holding the corpse open (``remain-on-exit``). This is
  the state the user most needs surfaced loudly (see ``CLAUDE.md`` hazard
  about staring at a dead pane while health checks stayed green).
- ``running`` - pane alive AND ``#{pane_current_command}`` is something
  other than a bare login/interactive shell. In practice this is the agent
  CLI (``claude``, ``codex``, ``hermes``, ``node`` running the CLI, etc.) or
  any other foreground process the user started, since tmux only reports the
  immediate child's command name, not whether it is literally "claude".
- ``idle``    - pane alive AND the foreground command is a known bare shell
  (``zsh``, ``bash``, ``sh``, ...). The agent isn't running; the user is
  sitting at a prompt.
- ``unknown`` - the underlying tmux query failed or returned nothing we can
  parse. We do NOT guess in this case.

We do not attempt to detect "waiting for user input" - tmux's pane-level
introspection cannot distinguish an agent that is thinking from one that is
blocked on a prompt, so claiming that state would be fabricated, not
detected.
"""

from __future__ import annotations

from typing import Optional

#: Reported activity states. Kept as plain strings (not an Enum) so they
#: serialize directly through Pydantic/JSON without an extra converter, and
#: so the frontend's string comparisons stay simple.
STATUS_RUNNING: str = "running"
STATUS_IDLE: str = "idle"
STATUS_DEAD: str = "dead"
STATUS_UNKNOWN: str = "unknown"

#: All valid values, for validation / tests.
ALL_STATUSES: frozenset[str] = frozenset(
    {STATUS_RUNNING, STATUS_IDLE, STATUS_DEAD, STATUS_UNKNOWN}
)

#: Foreground command names tmux reports for a bare interactive/login shell
#: with nothing else running in it. Anything NOT in this set (and not dead)
#: is treated as "running" - see module docstring for why we can't be more
#: specific than that without fabricating detail.
KNOWN_SHELL_COMMANDS: frozenset[str] = frozenset(
    {"zsh", "bash", "sh", "dash", "ksh", "fish", "tcsh", "csh"}
)


def resolve_pane_status(
    pane_dead: Optional[str], pane_current_command: Optional[str]
) -> str:
    """Classify a tmux pane's activity state from its raw format-string values.

    Description: Maps the two tmux pane-format values callers already query
        (``#{pane_dead}`` and ``#{pane_current_command}``) onto one of the
        four states this app reports. Pure function, no I/O - callers do the
        tmux query, this does the classification, so the rule is testable
        without a real tmux binary.

    Inputs:
        pane_dead: Raw ``#{pane_dead}`` value ("0" or "1"), or None if the
            query failed / the pane could not be found.
        pane_current_command: Raw ``#{pane_current_command}`` value (e.g.
            "zsh", "claude", "node"), or None if the query failed.

    Output:
        str: One of ``STATUS_RUNNING``, ``STATUS_IDLE``, ``STATUS_DEAD``,
            ``STATUS_UNKNOWN``.

    Example:
        >>> resolve_pane_status("0", "zsh")
        'idle'
        >>> resolve_pane_status("0", "claude")
        'running'
        >>> resolve_pane_status("1", "zsh")
        'dead'
        >>> resolve_pane_status(None, None)
        'unknown'
    """
    if pane_dead is None or pane_current_command is None:
        return STATUS_UNKNOWN

    if pane_dead.strip() == "1":
        return STATUS_DEAD

    cmd = pane_current_command.strip().lower()
    if not cmd:
        return STATUS_UNKNOWN

    if cmd in KNOWN_SHELL_COMMANDS:
        return STATUS_IDLE

    return STATUS_RUNNING
