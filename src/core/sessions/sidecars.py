"""The two per-session sidecars, and the one-shot rule both of them carry.

Slice S5 of the ``session_manager`` decomposition. ``AttachmentSidecars``
is the single owner of ``adopt_fifo_offsets`` (session id to the byte
offset its WS tailer should seek to) and ``pending_terminal_commands``
(session id to the configured terminal-command ID awaiting the first
client attach).

IT USED TO OWN A THIRD, ``idle_watchers``, holding one live pane-output
watcher per session. That whole subsystem went with the hooks on
2026-09-13: it guessed a session's state from the shape of the bytes
scrolling past, and the state now comes from what the harness writes to
disk (``src/core/attention/``). Its container, its setter, its reader and
its line in :meth:`AttachmentSidecars.forget` went with it.

**THEY ARE ONE CLUSTER BECAUSE THEY HAVE ONE LIFECYCLE**, not because they
are two dicts: each is written on the create or adopt path, read once
when a client shows up, and dropped when the session goes away. Three
clusters left ``_wipe_session_state``, the god method of the god object,
when this moved.

**BOTH ARE ONE-SHOT, WHICH IS WHY BOTH VERBS ARE TAKES.**
``take_fifo_offset`` and ``take_pending_command`` POP. That is the whole
safety property of both:

  - a reconnect that re-seeked to a stale offset would replay bytes
    against a FIFO that is much larger by then;
  - a reconnect that re-ran the terminal command would type a command the
    user did not ask for, into a pane they are looking at.

``peek_fifo_offset`` exists so the back-compat
``adopt_fifo_start_offset`` property can REPORT the offset
without consuming it - a property whose getter had a side effect would
make an unrelated read destroy a session's replay position.

**``forget`` DELIBERATELY DOES NOT DROP THE PENDING COMMAND, and that is
preserved behaviour rather than an oversight.** Measured before the move:
``_wipe_session_state`` popped ``adopt_fifo_offsets``
and never touched ``pending_terminal_commands``.
The command is popped on flush instead, and session ids are not reused,
so what is left behind is an entry nothing can ever read. Changing that is
a behaviour change and a different commit; the asymmetry is asserted in
``tests/test_attachment_sidecars.py`` so that a future change to it is a
decision somebody makes rather than a diff nobody notices.

**NOTHING HERE WRITES TO A PANE.** This class is
storage, on the same seam S3 drew for the toast inbox: the awaits, the
retry loop, the settings lookup and the backend write stay on the facade,
because they belong to other clusters. What moved is where the three
containers live and the pop-versus-read rule for each.
"""

from __future__ import annotations

from typing import Dict, Optional

import structlog

logger = structlog.get_logger()


class AttachmentSidecars:
    """Owns the two per-session containers filled at create or adopt time.

    Description: ``SessionManager`` holds one of these and keeps NO copy of
      either of the two - it reaches them through properties that alias
      these very objects - so the two can never disagree.

    Example:
        >>> sidecars = AttachmentSidecars()
        >>> sidecars.set_fifo_offset("ses_1", 4096)
        >>> sidecars.peek_fifo_offset("ses_1")
        4096
        >>> sidecars.take_fifo_offset("ses_1")
        4096
        >>> sidecars.take_fifo_offset("ses_1") is None
        True
    """

    def __init__(self) -> None:
        """Start with two empty maps and no I/O of any kind.

        Description: everything in here is in-memory ONLY, deliberately.
          A pending terminal command that survived a restart would type
          itself into a pane on the next attach, which is the failure the
          pop in ``take_pending_command`` exists to prevent within one
          process and durability would reintroduce across them.
        Inputs: none.
        Output: None.
        Example: AttachmentSidecars()
        """
        #: session_id -> byte offset into an adopted session's pipe-pane
        #: FIFO at capture time. Consumed ONCE by the WS tailer.
        self.adopt_fifo_offsets: Dict[str, int] = {}
        #: session_id -> configured terminal-command ID awaiting the first
        #: client attach. Holds an ID, never a command string; the text is
        #: read from config.json at flush time.
        self.pending_terminal_commands: Dict[str, str] = {}

    # ---- adopt FIFO offset ----------------------------------------------

    def set_fifo_offset(self, session_id: str, offset: int) -> None:
        """Stash the pipe-pane FIFO offset an adopted session starts from.

        Inputs: session_id (str); offset (int) - bytes into the FIFO at
          capture time.
        Output: None.
        Example: sidecars.set_fifo_offset("ses_1", 4096)
        """
        self.adopt_fifo_offsets[session_id] = offset

    def peek_fifo_offset(self, session_id: str) -> Optional[int]:
        """Report a session's FIFO offset WITHOUT consuming it.

        Description: exists so a read can be a read. The back-compat
          ``SessionManager.adopt_fifo_start_offset`` property answers from
          here, and a property getter that consumed would let an unrelated
          read destroy the replay position of a session nobody had
          attached to yet.
        Inputs: session_id (str).
        Output: int | None - None when unset or already consumed.
        Example: sidecars.peek_fifo_offset("ses_1")
        """
        return self.adopt_fifo_offsets.get(session_id)

    def take_fifo_offset(self, session_id: str) -> Optional[int]:
        """Consume a session's FIFO offset, exactly once.

        Description: the WS tailer calls this on connect. It POPS, so a
          later reconnect gets None and starts from the live end of the
          FIFO rather than re-seeking to an offset that is stale by
          however much output has landed since.
        Inputs: session_id (str).
        Output: int | None - the offset the first time, None thereafter.
        Example: sidecars.take_fifo_offset("ses_1")
        """
        return self.adopt_fifo_offsets.pop(session_id, None)

    # ---- pending terminal command ---------------------------------------

    def set_pending_command(self, session_id: str, command_id: str) -> None:
        """Record the terminal-command ID to type on this session's attach.

        Description: an ID, never a command string. The text is resolved
          from config.json at flush time, so a client cannot get a
          command of its own choosing typed into a pane by naming one
          here.
        Inputs: session_id (str); command_id (str) - a key into the
          configured terminal commands.
        Output: None.
        Example: sidecars.set_pending_command("ses_1", "top")
        """
        self.pending_terminal_commands[session_id] = command_id

    def take_pending_command(self, session_id: str) -> Optional[str]:
        """Consume a session's pending terminal-command ID, exactly once.

        Description: POPS BEFORE THE COMMAND IS RESOLVED OR TYPED, which
          is the ordering that matters. The flush that follows can fail on
          an unknown id, a missing backend or a write error, and a session
          whose command failed must still not have it retyped on the next
          reconnect.
        Inputs: session_id (str).
        Output: str | None - the id the first time, None thereafter.
        Example: sidecars.take_pending_command("ses_1")
        """
        return self.pending_terminal_commands.pop(session_id, None)

    # ---- teardown -------------------------------------------------------

    def forget(self, session_id: str) -> None:
        """Drop the FIFO offset for one session.

        Description: the teardown half, called from
          ``_wipe_session_state``. It does NOT drop the pending terminal
          command, and that is the pre-move behaviour preserved verbatim -
          see the module docstring. Other sessions' entries are untouched.
        Inputs: session_id (str).
        Output: None.
        Example: sidecars.forget("ses_1")
        """
        self.adopt_fifo_offsets.pop(session_id, None)
