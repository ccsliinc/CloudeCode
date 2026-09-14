"""Whether a session's notifications are muted, answered without touching disk.

WHAT THIS IS FOR. "mute notifications" on the session action menu is a
durable decision the user makes about ONE session, and two very different
kinds of code have to honour it: the hook route, which decides whether to
raise a web alert, and the push dispatcher, which decides whether to send
a phone notification. Both run where an SQLite open would be felt - the
hook route is on the critical path of a live working session, and the
dispatcher drains a queue on the event loop - so neither may read the
database to answer the question. This module is the in-memory projection
they read instead, hydrated ONCE from
:func:`src.core.session_store.notification_policy_rows` before the
notification producers start, and updated in place by the one writer.

THREE VALUES, AND ``unknown`` IS NOT A FLAVOUR OF ``unmuted``. That
distinction is the whole reason this file exists rather than a boolean on
``SessionManager``:

  ``muted``    the row was read and says the user muted this session.
  ``unmuted``  the row was read and says nothing is muted, OR there is no
               row at all. Both are DEFINITE: a mute can only ever be
               recorded on a session row (schema v26), so a session with
               no row has demonstrably never been muted.
  ``unknown``  the policy has never been read successfully. Nothing is
               known about ANY session, because hydration is one bulk
               query.

A FAILED READ MAY NOT ANSWER "NOT MUTED", and this is deliberately the
opposite posture from the sub-agent toast gate next to it in the hook
route. That gate FAILS TOWARD NOTIFYING, because silence there would be
bought with no evidence and a missed "your turn" is worse than a spurious
one. Here the user has made an explicit standing request to be left
alone, and answering "we could not check, so we assumed you did not mean
it" turns a database hiccup into a stream of pushes the user told us not
to send - to a phone, irreversibly. So ``unknown`` SUPPRESSES, and it says
so in the log every time (``notification_policy_unknown``) rather than
passing for a normal quiet moment.

THE BLAST RADIUS OF THAT IS BOUNDED AND WORTH STATING PLAINLY. ``unknown``
is reached only when the ONE bulk hydration query has never succeeded -
an install whose datastore cannot be opened or read at all. An install
with no datastore FILE is not that case: there are no rows, so nothing can
be muted, and hydration of an absent database succeeds with an empty
index. Callers are expected to retry hydration (see
:meth:`NotificationPolicyStore.needs_hydration`), so the first successful
read ends the condition for good.

THE GENERATION IS A COUNTER, NOT A CLOCK. Every policy change steps it by
one, mute and unmute alike. A queued notification carries the generation
it was stamped with, and :meth:`NotificationPolicyStore.allows_dispatch`
refuses anything whose generation is not the session's current one. That
is what stops an alert raised while the session was noisy from arriving
after the user muted it, and what stops a muted backlog from being
replayed the moment the user unmutes - the backlog is not held and
skipped, it was queued under a generation that no longer exists.

KEYED BY ``session_uuid``, WITH AN INSTANCE INDEX IN FRONT OF IT. The
durable identity of a session is its uuid; what a live caller has to hand
is a tmux name and, usually, a creation epoch. Both keys are built from
the same bulk read, so they can never disagree. The name-only fallback is
the lossy one and is used only when the epoch is genuinely unavailable -
see :meth:`NotificationPolicyStore.for_instance`.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Tuple

import structlog

logger = structlog.get_logger()

#: The row was read and the user has muted this session.
POLICY_MUTED = "muted"

#: The row was read and this session is not muted, or there is no row -
#: which is the same definite answer, because a mute can only live on a row.
POLICY_UNMUTED = "unmuted"

#: The policy has never been read successfully. NOT a flavour of
#: ``unmuted``: see the module docstring for why it suppresses.
POLICY_UNKNOWN = "unknown"

#: Every value :attr:`PolicyVerdict.verdict` can carry. A fourth is a bug.
ALL_POLICY_VERDICTS: Tuple[str, ...] = (
    POLICY_MUTED,
    POLICY_UNMUTED,
    POLICY_UNKNOWN,
)

#: ``allows_dispatch`` reasons. Each names a DIFFERENT fact, because
#: collapsing them would make a stale queue entry indistinguishable from a
#: muted session in the logs, and those want different fixes.
DISPATCH_ALLOWED = "allowed"
DISPATCH_REFUSED_MUTED = "muted"
DISPATCH_REFUSED_STALE_GENERATION = "stale_generation"
DISPATCH_REFUSED_POLICY_UNKNOWN = "policy_unknown"
DISPATCH_ALLOWED_UNSTAMPED = "unstamped"


@dataclass(frozen=True)
class PolicyVerdict:
    """One session's notification policy as it stands right now.

    Attributes:
        verdict: one of :data:`ALL_POLICY_VERDICTS`.
        session_uuid: the durable row identity this answer is about, or
            None when the caller's key resolved to no row. A None uuid
            with an ``unmuted`` verdict is the ordinary "this session has
            no stored row" case, not a failure.
        generation: the session's current notification-policy generation,
            or None when it is not known. Stamp this onto a queued
            notification; :meth:`NotificationPolicyStore.allows_dispatch`
            compares it back.
    """

    verdict: str
    session_uuid: Optional[str] = None
    generation: Optional[int] = None

    @property
    def suppresses(self) -> bool:
        """True when this verdict must stop an alert from being raised.

        Description: ``muted`` suppresses because the user asked for it,
            and ``unknown`` suppresses because answering "not muted"
            without having looked is the one failure this whole module
            exists to prevent. Only a MEASURED ``unmuted`` lets an alert
            through.
        Inputs: none.
        Output: bool.
        Example:
            >>> PolicyVerdict(POLICY_UNMUTED).suppresses
            False
        """
        return self.verdict != POLICY_UNMUTED

    @property
    def muted(self) -> bool:
        """True only when the row was READ and says muted.

        Description: the display-facing half of the verdict, kept
            separate from :attr:`suppresses` on purpose. A UI toggle may
            only paint "muted" when that is a fact about the row;
            ``unknown`` is not a fact about the row and paints as
            unmuted, while still suppressing. Those are different
            questions and one boolean cannot answer both.
        Inputs: none.
        Output: bool.
        Example:
            >>> PolicyVerdict(POLICY_UNKNOWN).muted
            False
        """
        return self.verdict == POLICY_MUTED


#: The verdict for a store that has never been hydrated. A module-level
#: constant so every refusal path hands back the same object.
UNKNOWN_VERDICT = PolicyVerdict(verdict=POLICY_UNKNOWN)


@dataclass(frozen=True)
class _PolicyRecord:
    """One row's stored policy, as held in memory."""

    session_uuid: str
    muted: bool
    generation: int


class NotificationPolicyStore:
    """In-memory projection of every session row's notification policy.

    Build one at boot, hydrate it from
    :func:`src.core.session_store.notification_policy_rows` BEFORE the
    notification producers start, then read it from the hook route and the
    push dispatcher. Every read is a dict lookup; nothing here opens a
    database.

    NOT LOCKED, AND THAT IS A DECISION. Hydration builds complete new
    index dicts and swaps them in with single attribute assignments, and
    :meth:`apply` replaces one key. Under CPython both are atomic with
    respect to other bytecode, so a reader either sees the whole old index
    or the whole new one and can never observe a half-built map. A lock
    would buy nothing and would put contention on a path whose entire
    purpose is to be free.
    """

    def __init__(self) -> None:
        """Create an empty, UNHYDRATED store.

        Description: an unhydrated store answers ``unknown`` for
            everything, which suppresses. That is the correct starting
            state: at construction time nothing has been read, and the
            producers are not running yet.
        Inputs: none.
        Output: None.
        Example: NotificationPolicyStore()
        """
        self._by_uuid: Dict[str, _PolicyRecord] = {}
        self._by_instance: Dict[Tuple[str, int], str] = {}
        self._by_name: Dict[str, str] = {}
        self._hydrated: bool = False

    @property
    def hydrated(self) -> bool:
        """Whether the policy has ever been read successfully.

        Inputs: none.
        Output: bool - False means every verdict is ``unknown``.
        Example:
            >>> NotificationPolicyStore().hydrated
            False
        """
        return self._hydrated

    def needs_hydration(self) -> bool:
        """Whether a caller should attempt (or re-attempt) a bulk read.

        Description: the recovery hook. A store that has never hydrated
            suppresses everything, so the caller is expected to keep
            trying rather than leave the install silent. Once a read has
            succeeded this answers False for good - a later read failure
            cannot downgrade what is already known, which is the second
            half of "a failed preference read must not default a muted
            session to unmuted": it must not default a KNOWN one to
            anything either.
        Inputs: none.
        Output: bool.
        Example:
            >>> NotificationPolicyStore().needs_hydration()
            True
        """
        return not self._hydrated

    def hydrate(self, rows: Iterable[Dict[str, Any]]) -> int:
        """Replace the whole projection from one bulk read. PURE.

        Description: takes exactly what
            :func:`src.core.session_store.notification_policy_rows`
            returns and builds three indexes from it: by uuid (the durable
            key), by ``(tmux_name, epoch)`` (the exact instance key), and
            by tmux name alone (the lossy fallback, which keeps the LAST
            entry seen for a name - the rows arrive in ascending epoch
            order, so that is the NEWEST instance, which for a live
            session is the right row by construction).

            CALLING THIS MARKS THE STORE HYDRATED even when ``rows`` is
            empty. An empty result from a successful query is a real
            answer - nothing is muted - and is exactly what a fresh
            install produces. A read that FAILED must raise before
            reaching here rather than passing ``[]``, or a database error
            would be laundered into "nothing is muted", which is the one
            outcome this module refuses to produce.
        Inputs: rows - dicts with ``session_uuid``, ``tmux_name``,
            ``tmux_created_epoch``, ``muted`` and ``generation``.
        Output: int - how many rows were indexed.
        Example: store.hydrate([{'session_uuid': 'a', 'muted': True,
            'generation': 1, 'tmux_name': 'cloude_a',
            'tmux_created_epoch': 7}])
        """
        by_uuid: Dict[str, _PolicyRecord] = {}
        by_instance: Dict[Tuple[str, int], str] = {}
        by_name: Dict[str, str] = {}
        for row in rows:
            session_uuid = row.get("session_uuid")
            if not session_uuid:
                continue
            record = _PolicyRecord(
                session_uuid=str(session_uuid),
                muted=bool(row.get("muted")),
                generation=int(row.get("generation") or 0),
            )
            by_uuid[record.session_uuid] = record
            name = row.get("tmux_name")
            epoch = row.get("tmux_created_epoch")
            if name:
                by_name[str(name)] = record.session_uuid
                if epoch is not None:
                    try:
                        by_instance[(str(name), int(epoch))] = record.session_uuid
                    except (TypeError, ValueError):
                        pass
        self._by_uuid = by_uuid
        self._by_instance = by_instance
        self._by_name = by_name
        self._hydrated = True
        return len(by_uuid)

    def apply(self, session_uuid: str, *, muted: bool, generation: int) -> None:
        """Record a policy change this process just COMMITTED to the row.

        Description: called by the write path after
            :func:`src.core.session_store.set_notification_mute` has
            returned, so the in-memory answer matches the durable one
            without waiting for the next hydration. It deliberately takes
            the committed values rather than recomputing them: the row is
            the authority on what the generation became, and a second
            author for that number would be free to disagree with it.

            A store that has never hydrated STAYS unhydrated. One row's
            policy is not knowledge of every other row's, and pretending
            otherwise would let a single mute turn an unreadable
            datastore into a confident "nothing else is muted".
        Inputs: session_uuid (str). muted (bool) and generation (int) -
            exactly what the write returned.
        Output: None.
        Example: store.apply('a1b2', muted=True, generation=3)
        """
        if not session_uuid:
            return
        record = _PolicyRecord(
            session_uuid=str(session_uuid),
            muted=bool(muted),
            generation=int(generation),
        )
        updated = dict(self._by_uuid)
        updated[record.session_uuid] = record
        self._by_uuid = updated

    def bind_instance(
        self,
        session_uuid: str,
        *,
        tmux_name: Optional[str],
        tmux_created_epoch: Optional[int],
    ) -> None:
        """Point a tmux instance at a uuid without re-reading the database.

        Description: a session created or adopted after hydration has a
            row the indexes do not know about yet. Binding it here keeps
            the instance lookup working until the next hydration, and the
            uuid it names simply has no policy record - which resolves to
            ``unmuted``, the correct answer for a session that was just
            created (new sessions and forks start unmuted).
        Inputs: session_uuid (str). tmux_name (str | None) and
            tmux_created_epoch (int | None) - the instance triple's two
            variable parts. A missing name binds nothing.
        Output: None.
        Example: store.bind_instance('a1b2', tmux_name='cloude_a',
            tmux_created_epoch=7)
        """
        if not session_uuid or not tmux_name:
            return
        names = dict(self._by_name)
        names[str(tmux_name)] = str(session_uuid)
        self._by_name = names
        if tmux_created_epoch is None:
            return
        try:
            key = (str(tmux_name), int(tmux_created_epoch))
        except (TypeError, ValueError):
            return
        instances = dict(self._by_instance)
        instances[key] = str(session_uuid)
        self._by_instance = instances

    def for_uuid(self, session_uuid: Optional[str]) -> PolicyVerdict:
        """The policy for one durable session row.

        Description: an unhydrated store answers ``unknown`` for every
            uuid. A hydrated store that does not hold the uuid answers
            ``unmuted``, because a mute can only ever be stored on a row
            and a uuid with no row therefore has demonstrably never been
            muted.
        Inputs: session_uuid (str | None). None answers ``unmuted`` on a
            hydrated store - there is no row, so there is no mute.
        Output: PolicyVerdict.
        Example: store.for_uuid('a1b2')
        """
        if not self._hydrated:
            return UNKNOWN_VERDICT
        if not session_uuid:
            return PolicyVerdict(verdict=POLICY_UNMUTED, generation=0)
        record = self._by_uuid.get(str(session_uuid))
        if record is None:
            return PolicyVerdict(
                verdict=POLICY_UNMUTED,
                session_uuid=str(session_uuid),
                generation=0,
            )
        return PolicyVerdict(
            verdict=POLICY_MUTED if record.muted else POLICY_UNMUTED,
            session_uuid=record.session_uuid,
            generation=record.generation,
        )

    def for_instance(
        self,
        tmux_name: Optional[str],
        tmux_created_epoch: Optional[int] = None,
    ) -> PolicyVerdict:
        """The policy for a LIVE tmux instance.

        Description: resolves the instance to its durable uuid and then
            defers to :meth:`for_uuid`. The exact key is
            ``(tmux_name, epoch)``.

            THE NAME-ONLY FALLBACK IS REACHED ONLY WHEN THE EPOCH IS
            GENUINELY UNAVAILABLE, and that restriction is the whole
            safety property. A tmux name is reusable, and this app
            re-mints them; if a name-keyed lookup ran whenever the exact
            key missed, a session created AFTER the last hydration would
            fall through to whatever row last carried its name - and
            inherit that dead session's mute. A mute applied to the wrong
            session is silent by construction: the user finds out by
            missing something. So a KNOWN epoch that is absent from the
            index answers about that instance and nothing else.

            With no epoch at all there is nothing to be exact about, and
            the newest instance of the name is the best available answer -
            the same weaker guarantee, for the same reason, as
            :func:`src.core.session_store.identity_for_live_name`.

            A name with no row at all answers ``unmuted`` on a hydrated
            store. That is the ordinary case for an external tmux session
            this app has never recorded, and for a session created since
            the last hydration - both of which have demonstrably never
            been muted, because a mute is only ever recorded on a row.
        Inputs: tmux_name (str | None). tmux_created_epoch (int | None).
        Output: PolicyVerdict.
        Example: store.for_instance('cloude_a', 7)
        """
        if not self._hydrated:
            return UNKNOWN_VERDICT
        if not tmux_name:
            return PolicyVerdict(verdict=POLICY_UNMUTED, generation=0)
        session_uuid: Optional[str] = None
        if tmux_created_epoch is not None:
            try:
                session_uuid = self._by_instance.get(
                    (str(tmux_name), int(tmux_created_epoch))
                )
            except (TypeError, ValueError):
                session_uuid = None
        else:
            session_uuid = self._by_name.get(str(tmux_name))
        return self.for_uuid(session_uuid)

    def allows_dispatch(
        self,
        session_uuid: Optional[str],
        generation: Optional[int],
    ) -> Tuple[bool, str]:
        """Whether a QUEUED notification may still be sent.

        Description: the gate the push dispatcher applies at drain time,
            after the event has sat in a queue for an unbounded interval.
            Three ways to refuse and they are reported apart, because a
            stale queue entry and a muted session want different fixes:

              * the session is muted NOW,
              * the entry was stamped under a generation that is no
                longer current, which means a policy change happened
                while it waited - in EITHER direction, so a mute cannot
                be escaped by an already-queued alert and an unmute
                cannot replay one,
              * the policy is not known at all, which suppresses (see the
                module docstring).

            AN UNSTAMPED EVENT IS ALLOWED. A producer that carries no
            session identity has no policy to violate, and dropping its
            events would silently retire a notification channel rather
            than mute a session. Stamping is what opts an event into this
            gate.
        Inputs: session_uuid (str | None) - the stamped durable identity.
            generation (int | None) - the stamped generation; None means
            the producer knew the session but not its generation, and
            only the mute half of the gate applies.
        Output: (bool, str) - whether to send, and one of the
            ``DISPATCH_*`` reasons.
        Example: store.allows_dispatch('a1b2', 3)  # (True, 'allowed')
        """
        if not session_uuid:
            return True, DISPATCH_ALLOWED_UNSTAMPED
        verdict = self.for_uuid(session_uuid)
        if verdict.verdict == POLICY_UNKNOWN:
            logger.warning(
                "notification_policy_unknown",
                session_uuid=session_uuid,
                detail=(
                    "the notification policy has never been read; refusing "
                    "to treat an unread mute as unmuted"
                ),
            )
            return False, DISPATCH_REFUSED_POLICY_UNKNOWN
        if verdict.verdict == POLICY_MUTED:
            return False, DISPATCH_REFUSED_MUTED
        if generation is not None and int(generation) != int(
            verdict.generation or 0
        ):
            return False, DISPATCH_REFUSED_STALE_GENERATION
        return True, DISPATCH_ALLOWED


def hydrate_from_datastore(
    store: NotificationPolicyStore, db_path
) -> bool:
    """Read every row's policy into ``store``. The ONE io seam.

    Description: kept apart from the store itself so every rule above
      stays testable without a database, and so there is exactly one
      place that decides what counts as a SUCCESSFUL read.

      A MISSING DATABASE FILE IS A SUCCESS, NOT A FAILURE, and the
      difference matters more than it looks. No file means no session
      rows, and no session rows means nothing can be muted - so "nothing
      is muted" is a measurement there, not an assumption, and a fresh
      install must not start life suppressing every notification it has.
      A file that exists and cannot be opened or queried is the opposite
      case: the answer is unavailable, the store stays unhydrated, and
      every verdict is ``unknown`` until a later attempt succeeds.

      NEVER RAISES. Boot must not fail because a policy could not be
      read, and the unhydrated state already reports the failure
      truthfully to every caller.
    Inputs: store (NotificationPolicyStore) - hydrated in place.
      db_path (pathlib.Path) - the datastore file.
    Output: bool - True when the store is now hydrated.
    Example: hydrate_from_datastore(store, Path('cloude.db'))
    """
    from contextlib import closing

    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect

    try:
        if db_path is None or not db_path.exists():
            # No rows exist anywhere, so nothing can be muted. See above:
            # this is a measurement, not a default.
            store.hydrate([])
            logger.info("notification_policy_hydrated", rows=0, datastore=False)
            return True
    except OSError as exc:
        logger.warning(
            "notification_policy_hydrate_failed",
            error=str(exc),
            stage="stat",
        )
        return False

    try:
        with closing(connect(db_path, create=False)) as conn:
            rows = session_store.notification_policy_rows(conn)
    except (DatastoreUnreadableError, sqlite3.Error, OSError) as exc:
        logger.warning(
            "notification_policy_hydrate_failed",
            error=str(exc),
            stage="read",
        )
        return False

    count = store.hydrate(rows)
    muted = sum(1 for row in rows if row.get("muted"))
    logger.info(
        "notification_policy_hydrated",
        rows=count,
        muted=muted,
        datastore=True,
    )
    return True
