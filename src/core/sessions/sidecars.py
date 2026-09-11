"""The three per-session sidecars, and the one-shot rule two of them carry.

Slice S5 of the ``session_manager`` decomposition. ``AttachmentSidecars``
is the single owner of ``idle_watchers`` (session id to its live
``IdleWatcher``), ``adopt_fifo_offsets`` (session id to the byte offset its
WS tailer should seek to) and ``pending_terminal_commands`` (session id to
the configured terminal-command ID awaiting the first client attach).

**THEY ARE ONE CLUSTER BECAUSE THEY HAVE ONE LIFECYCLE**, not because they
are three dicts: each is written on the create or adopt path, read once
when a client shows up, and dropped when the session goes away. Three
clusters left ``_wipe_session_state``, the god method of the god object,
when this moved.

**TWO OF THEM ARE ONE-SHOT AND THE THIRD IS NOT, WHICH IS WHY THE VERBS
DIFFER.** ``take_fifo_offset`` and ``take_pending_command`` POP. That is
the whole safety property of both:

  - a reconnect that re-seeked to a stale offset would replay bytes
    against a FIFO that is much larger by then;
  - a reconnect that re-ran the terminal command would type a command the
    user did not ask for, into a pane they are looking at.

``watcher`` is a plain read, because a watcher is a live object the
session keeps for as long as it runs. ``peek_fifo_offset`` exists so the
back-compat ``adopt_fifo_start_offset`` property can REPORT the offset
without consuming it - a property whose getter had a side effect would
make an unrelated read destroy a session's replay position.

**``forget`` DELIBERATELY DOES NOT DROP THE PENDING COMMAND, and that is
preserved behaviour rather than an oversight.** Measured before the move:
``_wipe_session_state`` popped ``idle_watchers`` and
``adopt_fifo_offsets`` and never touched ``pending_terminal_commands``.
The command is popped on flush instead, and session ids are not reused,
so what is left behind is an entry nothing can ever read. Changing that is
a behaviour change and a different commit; the asymmetry is asserted in
``tests/test_attachment_sidecars.py`` so that a future change to it is a
decision somebody makes rather than a diff nobody notices.

**NOTHING HERE STOPS A WATCHER OR WRITES TO A PANE.** This class is
storage, on the same seam S3 drew for the toast inbox: the awaits, the
retry loop, the settings lookup and the backend write stay on the facade,
because they belong to other clusters. What moved is where the three
containers live and the pop-versus-read rule for each.
"""

from __future__ import annotations

from typing import Dict, Optional

import structlog

from src.core.notifications.idle_watcher import IdleWatcher

logger = structlog.get_logger()


class AttachmentSidecars:
    """Owns the three per-session containers filled at create or adopt time.

    Description: ``SessionManager`` holds one of these and keeps NO copy of
      any of the three - it reaches them through properties that alias
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
        """Start with three empty maps and no I/O of any kind.

        Description: everything in here is in-memory ONLY, deliberately.
          A pending terminal command that survived a restart would type
          itself into a pane on the next attach, which is the failure the
          pop in ``take_pending_command`` exists to prevent within one
          process and durability would reintroduce across them.
        Inputs: none.
        Output: None.
        Example: AttachmentSidecars()
        """
        #: session_id -> its live idle watcher, constructed at create or
        #: adopt so the notification router can be injected.
        self.idle_watchers: Dict[str, IdleWatcher] = {}
        #: session_id -> byte offset into an adopted session's pipe-pane
        #: FIFO at capture time. Consumed ONCE by the WS tailer.
        self.adopt_fifo_offsets: Dict[str, int] = {}
        #: session_id -> configured terminal-command ID awaiting the first
        #: client attach. Holds an ID, never a command string; the text is
        #: read from config.json at flush time.
        self.pending_terminal_commands: Dict[str, str] = {}

    # ---- idle watchers --------------------------------------------------

    def set_watcher(self, session_id: str, watcher: IdleWatcher) -> None:
        """Record a session's live idle watcher.

        Description: replaces any watcher already recorded for the id. The
          caller is responsible for having stopped the old one; this class
          does not await anything.
        Inputs: session_id (str); watcher (IdleWatcher) - already started.
        Output: None.
        Example: sidecars.set_watcher("ses_1", watcher)
        """
        self.idle_watchers[session_id] = watcher

    def watcher(self, session_id: str) -> Optional[IdleWatcher]:
        """A session's idle watcher, or None.

        Description: a plain read and NOT a pop, unlike the two one-shot
          takes below. A watcher lives as long as its session does, and
          the teardown paths read it to stop it before dropping it.
        Inputs: session_id (str).
        Output: IdleWatcher | None - None when the router was absent at
          create time, which is the normal case in tests.
        Example: sidecars.watcher("ses_1")
        """
        return self.idle_watchers.get(session_id)

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
        """Drop the watcher and the FIFO offset for one session.

        Description: the teardown half, called from
          ``_wipe_session_state``. It does NOT drop the pending terminal
          command, and that is the pre-move behaviour preserved verbatim -
          see the module docstring. It does not stop the watcher either;
          the teardown paths await that first and this only forgets the
          reference. Other sessions' entries are untouched.
        Inputs: session_id (str).
        Output: None.
        Example: sidecars.forget("ses_1")
        """
        self.idle_watchers.pop(session_id, None)
        self.adopt_fifo_offsets.pop(session_id, None)
