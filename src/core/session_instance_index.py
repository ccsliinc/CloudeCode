"""Every stored fact a listing needs about a tmux instance, read ONCE.

WHY THIS FILE EXISTS. ``SessionManager.list_attachable_sessions`` decorates
each row it is about to return with three things that all live on the SAME
``sessions`` row, found by the SAME key - the instance triple
``(tmux_socket, tmux_name, tmux_created_epoch)``:

  * the user-facing title            (``session_label.label_for_instance``)
  * the durable row id and its parent (``session_store.identity_for_instance``)
  * what the app recorded launching   (``session_agent_provenance.stored_launch_for``)

Each of those OPENED ITS OWN SQLite CONNECTION, per row. Measured on the
owner's box 2026-09-09 with 11 attachable rows: **33 connections and
queries costing about 33 ms of a 55 ms pass** - roughly 60 percent of it,
and the largest remaining item once the per-session tmux subprocesses had
been removed from the sibling listing. Like every other listing cost in
this server it is paid synchronously on the event loop, so it is not a
database problem, it is terminal latency (see CLAUDE.md, "THE LISTING PASS
RUNS ON THE EVENT LOOP").

THE SHAPE IS THE SAME ONE ``session_status_map`` APPLIES TO TMUX: one bulk
read up front, then answer every row from it, instead of asking again per
row for something already fetched. Here it is one ``SELECT`` for all the
names in the listing rather than one bulk ``list-panes -a``.

THE TWO SELECTION RULES ARE NOT THE SAME AND BOTH ARE PRESERVED. Should a
triple ever carry more than one row, ``label_for_instance`` takes the
HIGHEST id (it asks for ``ORDER BY id DESC LIMIT 1``) while the other two
take whatever an unordered ``fetchone()`` hands back, which in practice is
the first row in table order. So this index keeps the FIRST row it sees
for identity and launch and the LAST for the title, having read them in
ascending id order. In the ordinary single-row case every rule agrees;
collapsing them to one would be a silent behaviour change in the case
nobody looks at, which is exactly where such changes hide.

THE PURE RULES ARE IMPORTED, NEVER RE-STATED. ``_clean_title`` and
``DEFINITE_LAUNCH_SOURCES`` decide what a title and a definite launch
ARE, and those decisions stay in the modules that own them - this file
only changes HOW MANY TIMES the row is fetched, never what the row means.
A second copy of either rule here would drift.

AND THE LISTING PATH USES IT TOO, WHICH IS WHY THE INDEX CARRIES FOUR
COLUMNS THE ATTACHABLE PATH NEVER READS. ``GET /sessions/list`` has the
same shape one layer down: ``session_status_seed_read.read_instance_row``
opens ITS OWN connection, per session, to read ``activity_state``,
``activity_state_at``, ``claude_session_uuid`` and ``working_dir`` off the
row found by the SAME instance triple. Those four therefore live on
:class:`InstanceFacts` beside the other five, and one query serves both
callers. The alternative - a second index for the second path - would be
two things keyed on one triple, which is how two readings of one row
become two answers the moment they disagree.

THE COST THERE IS A BURST, NOT A STEADY DRIP, and saying so accurately
matters. ``seeded_display`` re-derives at most once per
``SEED_REFRESH_INTERVAL_SECONDS`` (60s) per session, so on a 5s poll only
about one poll in twelve reaches the read at all. But the seeds are warmed
together at boot and therefore EXPIRE together, so the real shape is N
synchronous SQLite opens landing inside ONE pass - which is exactly what a
p99 is made of, and it matches the 270 ms p50 against 418 ms p99 measured
on live 2026-09-10 with 19 sessions.

A READING THAT DID NOT RUN IS NOT A READING OF NOTHING, so the index
carries ``complete``, the same discipline ``session_status_map.StatusMap``
applies to the tmux listing. For a DECORATION an empty index is harmless:
a missing title renders as nothing, which is what the per-row read already
produced when the datastore would not open. For the SEED it is not: an
index that could not be built would answer "no row" for every session and
silently blank the status ladder for the whole pass. So ``complete`` is
True only when a query actually RAN - including a real answer of zero rows
- and the seed seam reads the index only then, falling back to its own
per-row read otherwise. That makes the change strictly non-regressive: the
worst case is the cost that was already being paid.

FAILURE DEGRADES EXACTLY AS THE PER-ROW READS DID. A datastore that
cannot be opened or queried yields an EMPTY index, and an empty index
answers ``None`` / ``NOT_KNOWN`` for every row - which is what each of the
three functions already returned in that case. The one behavioural
difference worth naming: a transient error now costs the decorations for
the whole pass rather than for one row. These are decorations on a list
that repolls every five seconds, and the alternative is paying 33
connections forever to make a rare transient failure slightly narrower.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Tuple

from src.core.session_agent_provenance import (
    DEFINITE_LAUNCH_SOURCES,
    NOT_KNOWN,
    StoredLaunch,
)
from src.core.session_label import _clean_title

logger = logging.getLogger(__name__)

#: Key for one tmux instance within a socket: its name and creation epoch.
InstanceKey = Tuple[str, int]


@dataclass(frozen=True)
class InstanceFacts:
    """The stored columns a listing row is decorated with.

    One of these per tmux instance that HAS a row. A session with no row -
    an external tmux session this app never created - is simply absent
    from the index, which is a real answer and not a lookup failure.
    """

    title: Optional[str] = None
    row_id: Optional[int] = None
    parent_session_id: Optional[Any] = None
    agent_type: Optional[str] = None
    agent_family_source: Optional[str] = None
    #: The four the status seed ladder reads. They are on the SAME row
    #: under the SAME key as the five above, which is the whole reason
    #: one query can serve both callers.
    activity_state: Optional[str] = None
    activity_state_at: Optional[Any] = None
    claude_session_uuid: Optional[str] = None
    working_dir: Optional[str] = None


class InstanceIndex:
    """``{(tmux_name, epoch): InstanceFacts}`` for one socket, read once.

    Answers the same three questions the per-row reads answered, from
    memory. Build it with :func:`build_instance_index`; an instance with
    no stored row is absent, and every accessor degrades to the same
    "no record" value its per-row ancestor returned.
    """

    def __init__(
        self,
        facts: Optional[Dict[InstanceKey, InstanceFacts]] = None,
        *,
        complete: bool = False,
    ):
        """Wrap a prepared mapping.

        Inputs: facts - ``{(name, epoch): InstanceFacts}``; empty means
            "nothing on record", which every accessor reports honestly.
            complete - True only when a query actually RAN, including a
            real answer of zero rows. False is the default so every
            degraded construction below reads as "did not look", and a
            caller that cannot tell "no row" from "no reading" (the
            status seed) knows to do its own read instead.
        Output: None.
        Example: InstanceIndex({("cloude_a", 7): InstanceFacts(title="A")})
        """
        self._facts: Dict[InstanceKey, InstanceFacts] = dict(facts or {})
        self.complete: bool = bool(complete)

    def _get(self, name: Optional[str], epoch: Optional[int]) -> Optional[InstanceFacts]:
        """Look one instance up, tolerating the un-keyable cases.

        Inputs: name (str | None). epoch (int | None).
        Output: InstanceFacts | None. None when either half of the key is
            missing - a row with no epoch is not a live tmux instance,
            the same refusal the per-row reads made before touching the
            database at all.
        """
        if not name or epoch is None:
            return None
        try:
            return self._facts.get((name, int(epoch)))
        except (TypeError, ValueError):
            return None

    def label(self, name: Optional[str], epoch: Optional[int]) -> Optional[str]:
        """The cleaned user-facing title, or None if there is none.

        Inputs: name (str | None). epoch (int | None).
        Output: str | None - exactly what ``label_for_instance`` returned.
        Example: index.label("cloude_a", 1700000000)
        """
        facts = self._get(name, epoch)
        return facts.title if facts else None

    def identity(
        self, name: Optional[str], epoch: Optional[int]
    ) -> Optional[Dict[str, Any]]:
        """The durable row id and its parent, or None if there is no row.

        Inputs: name (str | None). epoch (int | None).
        Output: dict with ``id``, ``parent_session_id`` and
            ``agent_type``, or None - the same shape and the same None
            that ``identity_for_instance`` produced.
        Example: index.identity("cloude_a", 1700000000)
        """
        facts = self._get(name, epoch)
        if facts is None:
            return None
        return {
            "id": facts.row_id,
            "parent_session_id": facts.parent_session_id,
            "agent_type": facts.agent_type,
        }

    def stored_launch(
        self, name: Optional[str], epoch: Optional[int]
    ) -> StoredLaunch:
        """What the app RECORDED launching here, or NOT_KNOWN.

        Description: the gate is unchanged and is not restated here - a
            row only counts as a definite launch when its
            ``agent_family_source`` is in ``DEFINITE_LAUNCH_SOURCES``,
            which is what keeps a fingerprinted guess from being served
            as a launch fact.
        Inputs: name (str | None). epoch (int | None).
        Output: StoredLaunch - ``NOT_KNOWN`` whenever there is no row or
            its source is not a definite launch.
        Example: index.stored_launch("cloude_a", 1700000000)
        """
        facts = self._get(name, epoch)
        if facts is None:
            return NOT_KNOWN
        if facts.agent_family_source not in DEFINITE_LAUNCH_SOURCES:
            return NOT_KNOWN
        return StoredLaunch(
            known=True, agent_type=facts.agent_type, from_fingerprint=False
        )

    def seed_row(
        self, name: Optional[str], epoch: Optional[int]
    ) -> Optional[Dict[str, Any]]:
        """The four columns the STATUS SEED ladder reads, or None.

        Description: the in-memory answer to
            ``session_status_seed_read.read_instance_row``, returning the
            same dict under the same keys so the caller cannot tell which
            it got. None means "no row for this instance", which is what
            the per-row read returned for a triple it did not find.

            ONLY CALL THIS WHEN ``complete`` IS TRUE. On a False index
            every answer here is None, and None from a seed's point of
            view means "this session's instance could not be identified",
            which would blank the whole pass's status ladder rather than
            degrade one decoration. The seam enforces that; this method
            does not, because a method that silently substituted a
            different answer for an incomplete index would be hiding the
            distinction the flag exists to keep.
        Inputs: name (str | None). epoch (int | None).
        Output: dict | None - ``activity_state``, ``activity_state_at``,
            ``claude_session_uuid``, ``working_dir``.
        Example: index.seed_row("cloude_a", 1700000000)
        """
        facts = self._get(name, epoch)
        if facts is None:
            return None
        return {
            "activity_state": facts.activity_state,
            "activity_state_at": facts.activity_state_at,
            "claude_session_uuid": facts.claude_session_uuid,
            "working_dir": facts.working_dir,
        }


def build_instance_index(
    conn, *, socket: str, names: Iterable[str]
) -> InstanceIndex:
    """Read every listed instance's stored row in ONE query.

    Description: replaces three single-row lookups per listing row - each
        of which opened its own connection - with one ``SELECT`` over the
        names actually in the listing. Rows are read in ascending ``id``
        order so the two differing selection rules can both be honoured
        (see the module docstring): the FIRST row seen for a triple wins
        for identity and launch, the LAST wins for the title.

        NEVER RAISES. These values decorate a listing, and a decoration
        read must not be able to fail the payload it decorates - the same
        contract each per-row reader already had. Any datastore error
        yields an empty index, which answers "no record" for every row.
    Inputs:
        conn: an open sqlite3 connection, or None. None yields an empty
            index rather than an error.
        socket: the tmux socket the listing was taken from. The stored
            triple is scoped to it, so reading without it would match a
            same-named session on a different socket.
        names: the tmux session names in the listing. An empty iterable
            issues no query at all.
    Output:
        InstanceIndex - possibly empty, never None. ``complete`` is True
        only when a query actually ran (a real answer of zero rows
        included); False means nothing was looked at, and a caller that
        cannot tell those apart must do its own read.
    Example:
        build_instance_index(conn, socket='cloude', names=['cloude_a'])
    """
    wanted = [n for n in dict.fromkeys(names) if n]
    if conn is None or not socket:
        # NOT A READING. There was no connection (or no socket to scope
        # by), so nothing was looked at and ``complete`` stays False.
        return InstanceIndex()
    if not wanted:
        # A COMPLETE ANSWER TO AN EMPTY QUESTION. Nothing was asked
        # about, so nothing can be missed, and no query is issued.
        return InstanceIndex(complete=True)

    # Chunked so a listing with very many sessions cannot exceed SQLite's
    # variable limit (999 by default). One query is the point; several
    # bounded ones still beat three per row.
    chunk_size = 400
    facts: Dict[InstanceKey, InstanceFacts] = {}
    try:
        for start in range(0, len(wanted), chunk_size):
            chunk = wanted[start:start + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                "SELECT id, parent_session_id, agent_type, "
                "agent_family_source, title, tmux_name, tmux_created_epoch, "
                "activity_state, activity_state_at, claude_session_uuid, "
                "working_dir "
                "FROM sessions "
                f"WHERE tmux_socket = ? AND tmux_name IN ({placeholders}) "
                "AND tmux_created_epoch IS NOT NULL "
                "ORDER BY id ASC",
                (socket, *chunk),
            ).fetchall()
            for raw in rows:
                row = dict(raw)
                try:
                    key: InstanceKey = (
                        row["tmux_name"], int(row["tmux_created_epoch"])
                    )
                except (TypeError, ValueError, KeyError):
                    continue
                title = _clean_title(row.get("title"))
                existing = facts.get(key)
                if existing is None:
                    facts[key] = InstanceFacts(
                        title=title,
                        row_id=row.get("id"),
                        parent_session_id=row.get("parent_session_id"),
                        agent_type=row.get("agent_type"),
                        agent_family_source=row.get("agent_family_source"),
                        activity_state=row.get("activity_state"),
                        activity_state_at=row.get("activity_state_at"),
                        claude_session_uuid=row.get("claude_session_uuid"),
                        working_dir=row.get("working_dir"),
                    )
                else:
                    # A later row wins the TITLE only - label_for_instance
                    # asked for ORDER BY id DESC LIMIT 1 - while identity
                    # and launch keep the first row, which is what their
                    # unordered fetchone() returned. The four seed columns
                    # join the FIRST-row group for the same reason:
                    # read_instance_row also took an unordered fetchone().
                    facts[key] = InstanceFacts(
                        title=title,
                        row_id=existing.row_id,
                        parent_session_id=existing.parent_session_id,
                        agent_type=existing.agent_type,
                        agent_family_source=existing.agent_family_source,
                        activity_state=existing.activity_state,
                        activity_state_at=existing.activity_state_at,
                        claude_session_uuid=existing.claude_session_uuid,
                        working_dir=existing.working_dir,
                    )
    except (sqlite3.Error, TypeError, ValueError) as exc:
        logger.warning(
            "instance_index_read_failed",
            extra={"tmux_socket": socket, "error": str(exc)},
        )
        return InstanceIndex()
    return InstanceIndex(facts, complete=True)
