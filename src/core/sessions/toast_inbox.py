"""The per-session toast records, and who owns the two pending maps.

Slice S3 of the ``session_manager`` decomposition. ``ToastInbox`` is the
single owner of ``_pending_toasts`` (session id to its newest-first list
of ``Toast``) and ``_pending_startup_toasts`` (the queue the SYNC listing
pass fills and the ASYNC one drains).

**THE CAP BOUNDS ONLY THE ACKED TAIL, AND THAT ASYMMETRY IS THE DESIGN.**
``prune`` keeps every unacked record and at most ``ACKED_CAP`` acked ones.
A cap on the unacked half would drop a notification the user has not seen,
which is the one thing this store may never do. The unacked list is kept
small at the SOURCE instead: a kind whose older unacked record is strictly
superseded by a newer one is REPLACED IN PLACE rather than appended.
Before that rule existed, a session that ran 200 assistant turns without
the user dismissing anything held 200 identical "Your turn" records and
replayed all 200 on every attach backfill.

**THIS CLASS IS STORAGE ONLY, ON PURPOSE.** It resolves no session, reads
no theme, stamps no label and emits nothing to the notification router.
Those live on the facade because they belong to other clusters, and the
split is what lets every rule here be exercised against plain ``Toast``
objects with no manager, no tmux and no database. What it DOES own is
every rule about which record wins, which record may be rewritten and
which record may be dropped - the three questions a toast store gets
wrong.

**IDEMPOTENCE IS A HARD REQUIREMENT, NOT A NICETY.** Hook events arrive
unordered, duplicated and droppable (see CLAUDE.md), so ``ack`` reports
whether it CHANGED anything rather than whether it found anything, and it
refuses to re-stamp a record that was already acknowledged. A duplicate
event must not be able to rewrite the history of an act the user
performed.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional, Sequence, Tuple

import structlog

from src.models import Toast

logger = structlog.get_logger()


class ToastInbox:
    """Owns the pending toast records and the startup-toast queue.

    Description: the single owner of the toast cluster. ``SessionManager``
      holds one of these and keeps NO copy of either container - it reads
      both through properties that alias these very objects - so the two
      can never disagree.

    Example:
        >>> inbox = ToastInbox()
        >>> t, superseded = inbox.store(
        ...     "ses_1", kind="Stop", title="Your turn", body=None,
        ...     color=None, session_label=None, session_name=None,
        ... )
        >>> superseded
        False
        >>> inbox.get("ses_1", unacked_only=True) == [t]
        True
    """

    #: How many ACKED records a session keeps. The unacked half has no cap
    #: and cannot have one - see the module docstring.
    ACKED_CAP = 50

    #: Kinds whose older UNACKED record is strictly superseded by a newer
    #: one. Deliberately a one-element set, and the exclusions are the
    #: point:
    #:
    #:   Stop      - matcher "*", no throttle, one per assistant turn,
    #:               title always the literal "Your turn". Every older
    #:               unacked Stop says the same thing the newest one says,
    #:               because "your turn" has been continuously true since
    #:               the first of them fired. Nothing is lost.
    #:   Notification - the BODY is the message. Two Notifications are two
    #:               things to read; collapsing them destroys one.
    #:   PermissionRequest - each is a distinct decision about a distinct
    #:               command. Superseding one would silently discard a
    #:               command the user was never shown. Never collapse a
    #:               decision.
    #:
    #: This mirrors client/js/toast.js COALESCE_KEY exactly, including the
    #: keying on title, so server storage and client rendering partition
    #: the same set the same way.
    SUPERSEDING_KINDS = frozenset({"Stop"})

    def __init__(self) -> None:
        """Start with an empty inbox and an empty startup queue.

        Description: purely in-memory. Toasts are deliberately not
          persisted; a restart legitimately forgets them and the client
          backfills unacked records on attach.
        Inputs: none.
        Output: None.
        """
        #: Session id to that session's records, NEWEST FIRST. THE ONE AND
        #: ONLY COPY; the facade's ``_pending_toasts`` property aliases
        #: this object rather than duplicating it. Note
        #: ``src/core/toast_history.py`` reaches it with a tolerant
        #: ``getattr`` that answers ``{}`` for anything that is not a
        #: Mapping, so a facade that stopped exposing it would show an
        #: EMPTY history rather than raising.
        self.pending: dict[str, List[Toast]] = {}
        #: Toasts raised by the SYNC ``_session_info_for`` and drained by
        #: the ASYNC ``list_session_infos``, which is the only caller able
        #: to await the WS broadcast. Each entry is (session_id, Toast).
        self.pending_startup: List[Tuple[str, Toast]] = []

    # ---- reads ---------------------------------------------------------

    def has(self, session_id: str) -> bool:
        """Whether this session has a bucket at all.

        Description: distinct from "has any toasts": a session whose
          records were all pruned still has an (empty) bucket. The
          auto-ack path uses this to decide whether an id needs the
          stale-id remap before it gives up.
        Inputs: session_id (str).
        Output: bool.
        Example: inbox.has("ses_1")
        """
        return session_id in self.pending

    def bucket(self, session_id: str) -> List[Toast]:
        """This session's live list, or an empty one.

        Description: returns the LIVE list when the session has a bucket,
          so a caller mutating a record in it is mutating the stored
          record. Returns a fresh empty list otherwise, which is
          deliberately NOT inserted - a read must not create a bucket.
        Inputs: session_id (str).
        Output: list[Toast] - newest first.
        Example: inbox.bucket("ses_1")[0].kind
        """
        return self.pending.get(session_id, [])

    def get(self, session_id: str, unacked_only: bool = False) -> List[Toast]:
        """Records for a session, optionally filtered to unacked.

        Description: newest-first, and always a COPY of the list so a
          caller iterating it cannot be tripped by a concurrent ack. An
          empty list, never None, so callers iterate without a None check.
        Inputs: session_id (str), unacked_only (bool).
        Output: list[Toast].
        Example: inbox.get("ses_1", unacked_only=True)
        """
        bucket = self.pending.get(session_id, [])
        if unacked_only:
            return [t for t in bucket if not t.acknowledged]
        return list(bucket)

    def find_supersedable(
        self, bucket: Sequence[Toast], kind: str, title: str
    ) -> Optional[Toast]:
        """The record a new ``(kind, title)`` toast should replace.

        Description: scans for an UNACKED record of a superseding kind
          carrying the same title. Returns None when the kind does not
          supersede, when nothing matches, or when the only matches are
          acknowledged.

          ACKNOWLEDGED RECORDS ARE NEVER RETURNED. An acked toast is one
          the user dismissed; reusing its id and clearing nothing would
          still leave a record the backfill has already stopped serving,
          and mutating its body would rewrite history the user acted on.
          A new turn after a dismissal is a genuinely new notification
          and gets a new id.
        Inputs: bucket (Sequence[Toast]) - newest-first records. kind
          (str) and title (str) - the incoming event's match key, which
          partitions identically to the client's coalesce key.
        Output: Toast | None - the record to replace in place.
        Example: inbox.find_supersedable([], "Stop", "Your turn")
        """
        if kind not in self.SUPERSEDING_KINDS:
            return None
        for existing in bucket:
            if (
                existing.kind == kind
                and not existing.acknowledged
                and existing.title == title
            ):
                return existing
        return None

    # ---- writes --------------------------------------------------------

    def store(
        self,
        session_id: str,
        *,
        kind: str,
        title: str,
        body: Optional[str],
        color: Optional[str],
        session_label: Optional[str],
        session_name: Optional[str],
        now: Optional[datetime] = None,
    ) -> Tuple[Toast, bool]:
        """Record a toast, superseding an older unacked twin where the rule says.

        Description: prepends to the session's newest-first list, or
          REPLACES a supersedable record in place and moves it to the
          front. THE ID IS DELIBERATELY PRESERVED on a supersession:

            - The client dedupes by id and a coalesced card acks EVERY
              member id on dismiss. A fresh id per turn would leave the
              browser holding ids the server no longer has (their acks
              land on nothing) while the server holds an id the browser
              never saw, which comes straight back on the next attach
              backfill.
            - The caller broadcasts the returned Toast either way, so the
              client sees one id for one card and the count it renders
              matches the number of records the server actually holds. A
              card reading "x12" over a single stored record is the same
              class of lie as twelve cards over twelve records, just
              pointing the other way.

          Prunes before returning. Every field the caller had to resolve
          elsewhere (colour, label, name) arrives as an argument, because
          this class owns no session and reads no theme.
        Inputs: session_id (str) - MUST already be resolved to a live id
          by the caller; this class does no remapping. kind, title, body,
          color, session_label, session_name - the record's fields, all
          keyword-only so none can be swapped for another. now (datetime
          | None) - the timestamp, defaulting to naive UTC now.
        Output: tuple[Toast, bool] - the stored record, and whether it
          superseded an existing one rather than being newly created. The
          flag exists so the caller can log the two cases apart; the
          returned Toast is NOT always new, and callers must not assume
          ``toast.id`` is unseen.
        Example: inbox.store("ses_1", kind="Stop", title="Your turn",
            body=None, color=None, session_label=None, session_name=None)
        """
        import uuid as _uuid

        stamp = now if now is not None else datetime.utcnow()
        bucket = self.pending.setdefault(session_id, [])
        superseded = self.find_supersedable(bucket, kind, title)
        if superseded is not None:
            # REPLACE IN PLACE, KEEPING THE ID, AND MOVE THE VERSION ONLY
            # ON A REAL CHANGE (issue #39, arriving with the 1.4.0
            # integration). Compare BEFORE mutating: a duplicated hook
            # event re-supersedes with identical content ("your turn"
            # fired twice with nothing new to say) and must not bump the
            # version, or every client holding this record re-renders for
            # nothing, which is the exact waste the version exists to
            # remove. ``created_at`` is excluded because a timestamp is
            # not content; ``session_name`` IS counted, because a rename
            # between two Stops is a real fact about the same
            # notification. ``title`` is never compared - it is part of
            # the match key ``find_supersedable`` already applied, so it
            # is always equal here.
            content_changed = (
                superseded.body != body
                or superseded.color != color
                or superseded.session_label != session_label
                or superseded.session_name != session_name
            )
            superseded.body = body
            superseded.color = color
            superseded.session_label = session_label
            superseded.session_name = session_name
            superseded.created_at = stamp
            if content_changed:
                superseded.version += 1
            bucket.remove(superseded)
            bucket.insert(0, superseded)  # newest-first
            toast = superseded
            was_superseded = True
            logger.info(
                "toast_superseded",
                session_id=session_id,
                toast_id=toast.id,
                kind=kind,
                version=toast.version,
            )
        else:
            toast = Toast(
                id=_uuid.uuid4().hex,
                session_id=session_id,
                kind=kind,
                title=title,
                body=body,
                color=color,
                session_label=session_label,
                session_name=session_name,
                created_at=stamp,
                acknowledged=False,
            )
            bucket.insert(0, toast)  # newest-first
            was_superseded = False
            logger.info(
                "toast_recorded",
                session_id=session_id,
                toast_id=toast.id,
                kind=kind,
                color=color,
            )
        self.prune(session_id)
        return toast, was_superseded

    def ack(self, session_id: str, toast_id: str, reason: str) -> bool:
        """Mark a record acknowledged, recording WHY. Idempotent.

        Description: THE REASON IS STAMPED ONLY ON THE TRANSITION, never
          on a record that was already acked, so a duplicated hook event
          cannot rewrite the history of an act the user performed. The
          session scoping is real: a toast id from another session is
          simply not found here, which is what keeps dismissal per
          session.
        Inputs: session_id (str) - whose bucket to walk. toast_id (str) -
          the record. reason (str) - one of
          ``toast_auto_ack.ACK_REASON_*``; passed in rather than defaulted
          here so a caller cannot silently record the wrong one.
        Output: bool - True ONLY when this call changed state. False both
          when the record was not found and when it was already acked,
          which is what lets the route layer skip the WS broadcast on a
          no-op double click.
        Example: inbox.ack("ses_1", "abc", reason="answered")
        """
        bucket = self.pending.get(session_id)
        if not bucket:
            return False
        for t in bucket:
            if t.id == toast_id:
                if t.acknowledged:
                    return False
                t.acknowledged = True
                t.ack_reason = reason
                # A REAL TRANSITION, BUMPED ONCE. Guarded by the same
                # ``if t.acknowledged: return False`` above that makes
                # this whole method idempotent, so a duplicated ack event
                # for an already-acked record returns before reaching
                # this line and the version cannot move twice for one
                # fact.
                t.version += 1
                self.prune(session_id)
                logger.info(
                    "toast_acked",
                    session_id=session_id,
                    toast_id=toast_id,
                    reason=reason,
                    version=t.version,
                )
                return True
        return False

    def prune(self, session_id: str) -> None:
        """Trim the ACKED tail past ``ACKED_CAP``. Unacked records survive.

        Description: newest-first ordering means the tail is the OLDEST
          acked, so those are what fall off. EVERY UNACKED RECORD IS KEPT
          UNCONDITIONALLY - each is potentially surfaceable to a
          re-attaching browser, and dropping one loses a notification the
          user never saw.
        Inputs: session_id (str).
        Output: None.
        Example: inbox.prune("ses_1")
        """
        toasts = self.pending.get(session_id)
        if not toasts:
            return
        acked_count = 0
        keep: List[Toast] = []
        for t in toasts:
            if t.acknowledged:
                if acked_count < self.ACKED_CAP:
                    keep.append(t)
                    acked_count += 1
                # else: drop - past the cap
            else:
                keep.append(t)
        self.pending[session_id] = keep

    def drop_session(self, session_id: str) -> None:
        """Forget one session's records entirely.

        Description: called from ``_wipe_session_state``. Other sessions'
          lists are untouched, which is the isolation the whole
          per-session keying exists for.
        Inputs: session_id (str).
        Output: None.
        Example: inbox.drop_session("ses_gone")
        """
        self.pending.pop(session_id, None)

    # ---- the startup-toast queue ---------------------------------------

    def queue_startup(self, session_id: str, toast: Toast) -> None:
        """Queue a startup-prompt toast for the async pass to broadcast.

        Description: the sync listing pass can RECORD a toast but cannot
          await a websocket send, so it parks the pair here.
        Inputs: session_id (str), toast (Toast).
        Output: None.
        Example: inbox.queue_startup("ses_1", toast)
        """
        self.pending_startup.append((session_id, toast))

    def drain_startup(self) -> List[Tuple[str, Toast]]:
        """Take everything queued, leaving the queue empty.

        Description: DRAINS BEFORE THE CALLER SENDS, deliberately. A
          broadcast that raises must not leave the entry behind to be
          re-sent on the next poll - the toast is already recorded and
          the client backfills unacked toasts on attach, which is the
          recovery path. A failed broadcast must never turn a
          once-per-instance toast into a once-per-poll one.
        Inputs: none.
        Output: list[tuple[str, Toast]] - possibly empty.
        Example: for sid, toast in inbox.drain_startup(): ...
        """
        pending = self.pending_startup
        self.pending_startup = []
        return pending
