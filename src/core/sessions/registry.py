"""The per-session log buffers and command counters, and who owns them.

Slice S4 of the ``session_manager`` decomposition. ``SessionRegistry`` is
the single owner of ``log_buffers`` (session id to its oldest-first list of
``LogEntry``) and ``command_counts`` (session id to how many commands have
been sent to it).

**THE REGISTRY LANDS IN TWO PIECES AND THIS IS THE FIRST.** The plan's
registry cluster is six fields; S4 moves the two with no external reader at
all, and S7 moves ``sessions``, ``backends``, ``_subscribers`` and
``_last_session_id``, which between them have 27 readers outside the facade.
Splitting on the reader count rather than on the heading is deliberate: it
puts the pattern under test on the half that cannot break a caller, before
the half that can. Until S7 lands, this class is HALF the registry, and
saying so here is cheaper than a reader inferring it from the field list.

**THE CAP IS AN INJECTED CALLABLE, NOT AN IMPORT, AND THAT IS
LOAD-BEARING.** ``add_log_entry`` trimmed to ``settings.log_buffer_size``,
resolved out of ``session_manager``'s module globals on every call. Four
test modules replace that whole ``settings`` object with a stub carrying
their own ``log_buffer_size``. A registry that imported ``settings`` itself
would not see those substitutions, so the cap under test would silently be
the real one - the same hazard S2 caught before ``ThemeStore`` could read
and write the owner's real pin file during a pytest run.

**THE TRIM IS ON APPEND AND NOWHERE ELSE.** A buffer only ever grows
through ``append_log``, so that is the one place a bound can be enforced;
checking anywhere else would be a second answer to a question with one
writer. The cap is re-read per append rather than captured at
construction, because a settings reload has to take effect on a live
manager and did before this moved.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable, List

import structlog

from src.models import LogEntry

logger = structlog.get_logger()


class SessionRegistry:
    """Owns the per-session log buffers and command counters.

    Description: the first half of the registry cluster. ``SessionManager``
      holds one of these and keeps NO copy of either container - it reaches
      both through properties that alias these very objects - so the two can
      never disagree.

    Example:
        >>> registry = SessionRegistry(log_cap=lambda: 2)
        >>> registry.ensure("ses_1")
        >>> registry.append_log("ses_1", "hello").content
        'hello'
        >>> registry.count_command("ses_1")
        1
        >>> registry.log_line_count("ses_1")
        1
    """

    def __init__(self, *, log_cap: Callable[[], int]) -> None:
        """Start with empty containers and a way to ask for the line cap.

        Description: takes no default for the cap on purpose. A default
          here would be a second copy of ``Settings.log_buffer_size``'s
          value, and two spellings of one number drift the first time
          either moves. A caller that wants a fixed cap passes
          ``lambda: 1000`` and says so at the call site.
        Inputs: log_cap (Callable[[], int]) - returns the maximum number of
          lines a single session's buffer may hold. Called on every append,
          never captured.
        Output: None.
        Example: SessionRegistry(log_cap=lambda: settings.log_buffer_size)
        """
        #: session_id -> its log lines, oldest first, capped on append.
        self.log_buffers: dict[str, List[LogEntry]] = {}
        #: session_id -> how many commands have been sent to it.
        self.command_counts: dict[str, int] = {}
        self._log_cap = log_cap

    # ---- lifecycle ------------------------------------------------------

    def ensure(self, session_id: str) -> None:
        """Give a session empty containers if it has none yet.

        Description: idempotent by construction, because registration runs
          on the create path, the adopt path AND the boot rehydrate path,
          and a session reaching two of them must not lose the buffer the
          first one gave it.
        Inputs: session_id (str).
        Output: None.
        Example: registry.ensure("ses_1")
        """
        self.log_buffers.setdefault(session_id, [])
        self.command_counts.setdefault(session_id, 0)

    def forget(self, session_id: str) -> None:
        """Drop both containers for one session.

        Description: the teardown half, called from
          ``_wipe_session_state``. Other sessions' entries are untouched -
          that isolation is the whole reason these are dicts keyed by id
          rather than one shared buffer.
        Inputs: session_id (str).
        Output: None.
        Example: registry.forget("ses_1")
        """
        self.log_buffers.pop(session_id, None)
        self.command_counts.pop(session_id, None)

    # ---- log buffer -----------------------------------------------------

    def append_log(
        self, session_id: str, content: str, log_type: str = "stdout"
    ) -> LogEntry:
        """Append one line to a session's buffer and enforce the cap.

        Description: creates the buffer if absent, appends, then trims the
          OLDEST lines until the buffer is within the cap the injected
          callable reports. Returns the entry it stored so a caller does
          not have to reach back into the container to find it.
        Inputs: session_id (str); content (str) - the line; log_type (str) -
          'stdout' by default, the stream label carried on the entry.
        Output: LogEntry - the record appended.
        Example: registry.append_log("ses_1", "boot ok", "stdout")
        """
        buf = self.log_buffers.setdefault(session_id, [])
        entry = LogEntry(
            timestamp=datetime.utcnow(),
            session_id=session_id,
            content=content,
            log_type=log_type,
        )
        buf.append(entry)
        cap = self._log_cap()
        if len(buf) > cap:
            del buf[: len(buf) - cap]
        return entry

    def recent_logs(self, session_id: str, limit: int) -> List[LogEntry]:
        """The newest ``limit`` lines for a session, oldest first.

        Description: a NEW list every call, deliberately. The caller
          hands this straight to a response model, and returning the live
          buffer would let a serializer iterate a container the output
          fan-out is appending to.
        Inputs: session_id (str); limit (int) - how many trailing lines.
        Output: list[LogEntry] - empty for a session with no buffer.
        Example: registry.recent_logs("ses_1", 100)
        """
        return self.log_buffers.get(session_id, [])[-limit:]

    def log_line_count(self, session_id: str) -> int:
        """How many lines a session's buffer currently holds.

        Inputs: session_id (str).
        Output: int - 0 for a session with no buffer.
        """
        return len(self.log_buffers.get(session_id, []))

    # ---- command counter ------------------------------------------------

    def count_command(self, session_id: str) -> int:
        """Record that one command was sent to a session.

        Description: creates the counter if absent, so a command sent to a
          session that skipped ``ensure`` is still counted rather than
          raising. Returns the new total because the one caller logs it.
        Inputs: session_id (str).
        Output: int - the count AFTER this increment.
        Example: registry.count_command("ses_1")
        """
        total = self.command_counts.get(session_id, 0) + 1
        self.command_counts[session_id] = total
        return total

    def command_count(self, session_id: str) -> int:
        """How many commands have been sent to a session.

        Inputs: session_id (str).
        Output: int - 0 for a session with no counter.
        """
        return self.command_counts.get(session_id, 0)
