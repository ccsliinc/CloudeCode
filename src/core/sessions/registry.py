"""The live session table, its output fan-out, log buffers and counters.

``SessionRegistry`` is the single owner of everything this application
knows about a session that is RUNNING RIGHT NOW: ``sessions`` (id to
:class:`~src.models.Session`), ``backends`` (id to its
:class:`~src.core.session_backend.SessionBackend`), ``subscribers`` (id
to the queues watching its bytes), ``last_session_id`` (which one is
"current"), ``log_buffers`` and ``command_counts``.

**IT LANDED IN TWO PIECES AND BOTH ARE HERE NOW.** Slice S4 of plan v1
moved the two containers with no external reader at all - the log
buffers and the command counters - deliberately putting the pattern
under test on the half that could not break a caller. Slice S4 of plan
v2 moved the rest. Nothing in this class forwards anywhere and
``SessionManager`` keeps no copy of any of it.

**ONE PANE IS ONE REGISTRATION, and
:meth:`registered_ids_for_tmux_name` is what lets a caller enforce
that.** A tmux pane bound under two session ids means two backends
tailing one FIFO, which is measurable from outside as
``GET /sessions/list`` returning 22 rows for 21 live tmux sessions. That
query has to run against the SAME ``backends`` dict the registration
path writes; a second dict holding a copy answers every equality
assertion correctly and still misses the second registration.

**THE CAP IS AN INJECTED CALLABLE, NOT AN IMPORT, AND THAT IS
LOAD-BEARING.** ``append_log`` trims to ``settings.log_buffer_size``,
which four test modules replace wholesale with a stub carrying their own
value. A registry that imported ``settings`` itself would not see those
substitutions, so the cap under test would silently be the real one -
the same hazard S2 caught before ``ThemeStore`` could read and write the
owner's real pin file during a pytest run. The cap is re-read per
append rather than captured at construction, because a settings reload
has to take effect on a live manager and did before this moved.

**THE TRIM IS ON APPEND AND NOWHERE ELSE.** A buffer only ever grows
through ``append_log``, so that is the one place a bound can be
enforced; checking anywhere else would be a second answer to a question
with one writer.
"""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime
from typing import Callable, Dict, List, Optional

import structlog

from src.core.session_backend import SessionBackend
from src.models import LogEntry, Session

logger = structlog.get_logger()

#: The bucket a subscriber lands in when there is no session to attach
#: it to. A caller that subscribes before anything exists (the auth-only
#: websocket test is the real one) gets a queue that is valid, empty and
#: never written to, rather than an exception it would have to special
#: case.
ORPHAN_BUCKET = "__orphan__"


class SessionRegistry:
    """Owns the live session table and everything keyed alongside it.

    Description: six containers with one lifetime. A session is born in
      :meth:`register`, is found through :meth:`get_session` /
      :meth:`get_backend` / :meth:`current_session`, accumulates log
      lines, command counts and output subscribers, and dies in
      :meth:`forget`. ``SessionManager`` holds ONE of these and keeps no
      copy of any container, so the two can never disagree.

    Example:
        >>> registry = SessionRegistry(log_cap=lambda: 2)
        >>> registry.append_log("ses_1", "hello").content
        'hello'
        >>> registry.count_command("ses_1")
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
        # Multiple sessions coexist; two browser tabs can each be attached
        # to a different session. Touching one session's entry NEVER
        # touches another's - that isolation is the whole point, and it is
        # why every one of these is a dict keyed by session id rather than
        # one shared container.
        #: session_id -> the live Session record.
        self.sessions: Dict[str, Session] = {}
        #: session_id -> the backend driving its pane.
        self.backends: Dict[str, SessionBackend] = {}
        #: session_id -> the queues watching its output bytes.
        self.subscribers: Dict[str, List[asyncio.Queue]] = {}
        #: session_id -> its log lines, oldest first, capped on append.
        self.log_buffers: Dict[str, List[LogEntry]] = {}
        #: session_id -> how many commands have been sent to it.
        self.command_counts: Dict[str, int] = {}
        #: Most recently registered session id, or None. Backs
        #: :meth:`current_session`.
        self.last_session_id: Optional[str] = None
        self._log_cap = log_cap

    # ---- lifecycle ------------------------------------------------------

    def register(
        self, session: Session, backend: Optional[SessionBackend]
    ) -> None:
        """Wire a session, and its backend if it has one, into every container.

        Description: the ONE registration path. The create path, the
          adopt path and the boot rehydrate path all land here, so a
          session reaching two of them keeps the containers the first
          one gave it. Marks the session current.
        Inputs: session (Session) - the record to hold. backend
          (SessionBackend | None) - None for a rehydrated pointer whose
          pane has not been attached yet.
        Output: None.
        Example: registry.register(session, backend)
        """
        self.sessions[session.id] = session
        if backend is not None:
            self.backends[session.id] = backend
        self.subscribers.setdefault(session.id, [])
        self.ensure(session.id)
        self.last_session_id = session.id

    def ensure(self, session_id: str) -> None:
        """Give a session empty log containers if it has none yet.

        Description: idempotent by construction, and reachable on its own
          because a session id can acquire log lines before it has a
          ``Session`` record to register.
        Inputs: session_id (str).
        Output: None.
        Example: registry.ensure("ses_1")
        """
        self.log_buffers.setdefault(session_id, [])
        self.command_counts.setdefault(session_id, 0)

    def forget(self, session_id: str) -> None:
        """Drop every container entry for one session, and repoint current.

        Description: the teardown half. Other sessions' entries are
          untouched. Subscribers for THIS session are dropped, and their
          websocket readers see the queue go quiet and exit on
          disconnect. When the session being dropped was the current one
          the pointer moves to the newest survivor, or to None - a stale
          pointer into a popped id would make :meth:`current_session`
          answer for a session that no longer exists.
        Inputs: session_id (str).
        Output: None.
        Example: registry.forget("ses_1")
        """
        self.sessions.pop(session_id, None)
        self.backends.pop(session_id, None)
        self.subscribers.pop(session_id, None)
        self.log_buffers.pop(session_id, None)
        self.command_counts.pop(session_id, None)
        if self.last_session_id == session_id:
            self.last_session_id = (
                next(reversed(self.sessions)) if self.sessions else None
            )

    # ---- lookup ---------------------------------------------------------

    def get_session(self, session_id: str) -> Optional[Session]:
        """The live ``Session`` for an id, or None.

        Inputs: session_id (str).
        Output: Session | None.
        """
        return self.sessions.get(session_id)

    def get_backend(self, session_id: str) -> Optional[SessionBackend]:
        """The backend driving an id's pane, or None.

        Description: None covers two different situations that this
          container cannot tell apart - no such session, and a session
          registered without a backend. A caller that needs to
          distinguish them asks :meth:`get_session` as well.
        Inputs: session_id (str).
        Output: SessionBackend | None.
        """
        return self.backends.get(session_id)

    def list_sessions(self) -> List[Session]:
        """Every live session, insertion order, oldest first.

        Description: a NEW list every call, so a caller iterating it
          cannot be tripped by a registration landing mid-iteration.
        Inputs: none.
        Output: list[Session].
        """
        return list(self.sessions.values())

    def current_session(self) -> Optional[Session]:
        """The most recently registered session, or None.

        Description: NOT a pure read. ``last_session_id`` goes stale the
          moment the session it names is destroyed, so this falls back to
          the newest surviving entry (dicts preserve insertion order) and
          REPAIRS the pointer on its way past. Legacy single-session
          callers that genuinely just want "a" session use this; a caller
          that knows the id uses :meth:`get_session`.
        Inputs: none.
        Output: Session | None - None only when nothing is registered.
        Example: registry.current_session()
        """
        if self.last_session_id and self.last_session_id in self.sessions:
            return self.sessions[self.last_session_id]
        if self.sessions:
            sid = next(reversed(self.sessions))
            self.last_session_id = sid
            return self.sessions[sid]
        self.last_session_id = None
        return None

    def current_backend(self) -> Optional[SessionBackend]:
        """The backend of :meth:`current_session`, or None.

        Inputs: none.
        Output: SessionBackend | None.
        """
        session = self.current_session()
        if session is None:
            return None
        return self.backends.get(session.id)

    def resolve_session_id(self, session_id: Optional[str]) -> Optional[str]:
        """Map an explicit id, or None meaning current, onto a live id.

        Description: an explicit id is VALIDATED rather than trusted -
          an id for a session that has gone answers None, so a caller
          cannot go on to address a container entry that is not there.
        Inputs: session_id (str | None) - None asks for the current one.
        Output: str | None.
        Example: registry.resolve_session_id(None)
        """
        if session_id is not None:
            return session_id if session_id in self.sessions else None
        session = self.current_session()
        return session.id if session is not None else None

    def registered_ids_for_tmux_name(
        self, name: str, also: Optional[str] = None
    ) -> List[str]:
        """Every registered session id currently bound to one tmux name.

        Description: ONE PANE IS ONE REGISTRATION, and this is what lets
          a caller enforce that. While an adoption's id was always
          ``adopted:<name>``, "the registration for this id" and "the
          registration for this pane" were the same question; once the
          id is RESOLVED they are not, and a pane can already be held
          under a different id (a rehydrated ``session_metadata.json``
          entry, or the boot re-adopt). Dropping only the id's own
          registration then leaves a second backend tailing the same
          FIFO - measured on live, 22 rows for 21 live sessions.

          ``also`` is included in the result whether or not it is bound
          to this name, so a caller tearing down before a fresh attach
          gets one list covering both reasons to drop a registration.
          The order is stable (backend insertion order, ``also`` last)
          so two calls over unchanged state agree.

          The ``getattr`` is polymorphism, not tolerance: ``tmux_session``
          is declared by ``TmuxBackend`` and by nothing else, so the
          legacy PTY backend genuinely has no such attribute and a plain
          read would raise on it.
        Inputs: name (str) - literal tmux session name. also (str|None)
          - an extra id to include, typically the id about to be
          registered.
        Output: list[str] - registered session ids, no duplicates.
        Example: registry.registered_ids_for_tmux_name('cloude_x', also='ses_1')
        """
        found = [
            sid
            for sid, backend in self.backends.items()
            if getattr(backend, "tmux_session", None) == name
        ]
        if also and also in self.backends and also not in found:
            found.append(also)
        return found

    # ---- output fan-out -------------------------------------------------

    def subscribe(self, session_id: Optional[str] = None) -> asyncio.Queue:
        """Hand back a queue receiving one session's output bytes.

        Description: the returned queue receives ONLY that session's
          bytes, as base64-encoded strings; a session's output never
          leaks into another's queue. ``session_id`` None means the
          current session, and an id that resolves to nothing lands in
          :data:`ORPHAN_BUCKET` rather than raising.
        Inputs: session_id (str | None).
        Output: asyncio.Queue.
        Example: queue = registry.subscribe("ses_1")
        """
        sid = self.resolve_session_id(session_id)
        key = sid if sid is not None else ORPHAN_BUCKET
        queue: asyncio.Queue = asyncio.Queue()
        self.subscribers.setdefault(key, []).append(queue)
        return queue

    def unsubscribe(
        self, queue: asyncio.Queue, session_id: Optional[str] = None
    ) -> None:
        """Detach a queue from a session's output stream. Idempotent.

        Description: ``session_id`` None searches every bucket, which
          covers callers that did not keep track of which session the
          queue belonged to.
        Inputs: queue (asyncio.Queue) - the one handed out by
          :meth:`subscribe`. session_id (str | None).
        Output: None.
        Example: registry.unsubscribe(queue, "ses_1")
        """
        if session_id is not None:
            subs = self.subscribers.get(session_id)
            if subs and queue in subs:
                subs.remove(queue)
            return
        for subs in self.subscribers.values():
            if queue in subs:
                subs.remove(queue)
                return

    async def publish(self, session_id: str, data: bytes) -> None:
        """Fan one chunk of a session's output out to its subscribers.

        Description: encodes once and delivers to every queue registered
          for THIS session id and no other. A queue that fails to accept
          the chunk is logged and DROPPED, because the alternative is
          letting one stuck viewer stop delivery to every other viewer of
          the same pane. The catch is deliberately broad for the same
          reason: the queue is a foreign object supplied by the websocket
          layer and this code cannot enumerate how it might fail. It does
          not swallow - it logs the error and removes the subscriber.
        Inputs: session_id (str); data (bytes) - the raw pane output.
        Output: None.
        Example: await registry.publish("ses_1", b"hello")
        """
        subs = self.subscribers.get(session_id)
        if not subs:
            return
        encoded = base64.b64encode(data).decode("utf-8")
        for queue in list(subs):
            try:
                await queue.put(encoded)
            except Exception as e:  # pragma: no cover - defensive
                logger.error("failed_to_send_to_subscriber", error=str(e))
                try:
                    subs.remove(queue)
                except ValueError:
                    pass

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
          session that skipped :meth:`ensure` is still counted rather than
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
