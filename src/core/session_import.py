"""First-run import of sessions into cloude.db (design doc section 5.3).

THE MOST DANGEROUS CODE IN THIS SUBSYSTEM, AND WHY.

``meta.imported_from_json_at`` is a ONE-WAY LATCH over an input that
disappears. Once it is stamped, this import never runs again on that
install, ever. The live tmux session list it reads is not a file we can
go back to - it is a process table, and by tomorrow it is different.

So the failure mode is not "an error". It is SILENCE. If the tmux probe
fails and the latch is stamped anyway, the user boots to an empty RECENT
list, sees no error, and the import NEVER RETRIES. His session history is
permanently gone while every screen looks correct. The JSON files still
sit on disk and nothing ever reads them again.

THE RULE THAT PREVENTS IT, stated once so it can be checked:

    THE LATCH IS STAMPED ONLY ON THE ``listing.ok is True`` PATH.

THE LATCH IS TWO KEYS, NOT ONE, AND BOTH ARE GUARDED.

``meta.imported_from_json_at`` is what GET /sessions/import-status
reports. ``meta.imported_from_json_result[sessions_imported_at]`` is what
:func:`sessions_stage_done` actually READS to decide whether to run. Only
the first used to be structurally proved, so writing only the SECOND one
early latched the import shut forever while every reader said it had
never completed - and both AST assertions passed on that mutant.

Both writes now live in :func:`_latch_sessions_stage`, which is called
from exactly one place: the last statement of the success path, textually
after the ``if not listing.ok`` guard returns. tests/test_session_import.py
walks this module's AST and asserts that neither key is written anywhere
outside that helper, that the helper has exactly one call site, and that
the call site is after the gate. A future edit that adds a second latch
write, or hoists this one above the guard, fails a test instead of
quietly costing a user his history.

WHAT A FAILED PROBE PRODUCES INSTEAD. Zero session rows, the latch left
unset, ``meta.session_import_pending_reason`` set to the probe's own
reason token, and a PENDING result the home screen renders as "session
import could not run because tmux could not be listed". The next start
retries. That is the third outcome: not pass, not fail, COULD NOT
EVALUATE - and it reaches the roll-up rather than being folded into
either neighbour.

WHAT IS NEVER IMPORTED AS ``adopted``. Past adoptions were never
persisted anywhere (the old adopt path deliberately did not add to
``owned_tmux_sessions``), so there is no evidence on this machine that
any given session was adopted. Importing one as ``adopted`` would be
inventing a fact. Live sessions import as ``created`` when the legacy
owned set names them, and ``observed`` otherwise. The user re-adopts
once, and from then on it sticks because it is a row on disk.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set

import structlog

from src.core.db import get_meta, set_meta
from src.core.db_models import (
    DEFAULT_TMUX_SOCKET,
    META_IMPORTED_FROM_JSON_AT,
    META_IMPORTED_FROM_JSON_RESULT,
    META_SESSION_IMPORT_PENDING_REASON,
    SESSION_ATTRIBUTION_UNKNOWN,
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_SOURCE_IMPORT,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_ORIGIN_OBSERVED,
)
from src.core.session_import_mapping import (
    attribute_working_dir,
    _merge_fields,
    _persisted_session_id,
    _project_roots,
    _row_fields,
    _stopped_epoch,
)
from src.core.project_reconcile import ReconcileResult, reconcile_projects
from src.core.session_identity import RECORD_INSERTED, record_instance
from src.core.session_store import count_sessions, observed_origin_for
from src.core.tmux_listing import TmuxListing
from src.core.trail_entry import utc_now

logger = structlog.get_logger()

#: Import outcomes. THREE, and the third is the whole point of the file.
IMPORT_COMPLETED = "completed"
IMPORT_ALREADY_DONE = "already_done"
IMPORT_PENDING_LISTING_UNAVAILABLE = "pending_listing_unavailable"

#: Key inside ``meta.imported_from_json_result`` marking the SESSIONS
#: stage as finished. Held separately from the top-level latch so an
#: install stamped by the projects-only S3 code still gets its sessions
#: imported instead of being locked out by a latch that described a
#: different, smaller job.
RESULT_KEY_SESSIONS_STAGE = "sessions_imported_at"
RESULT_KEY_SESSIONS_DETAIL = "sessions_import_detail"


@dataclass(frozen=True)
class FirstRunImportResult:
    """What one :func:`run_first_run_import` call did, and what it could not.

    Inputs (constructor): outcome (str) - one of ``IMPORT_COMPLETED``,
      ``IMPORT_ALREADY_DONE``, ``IMPORT_PENDING_LISTING_UNAVAILABLE``.
      sessions_imported (int). projects (ReconcileResult | None) - what
      the config-projects reconcile did on THIS start. Never None on a
      completed or already-done outcome: the projects stage runs on every
      start, so a caller that sees None is looking at a pass that could
      not reach it at all.
      listing_reason (str | None) - the tmux probe's own reason token,
      carried verbatim on the pending outcome so the UI can say WHAT
      could not be measured rather than showing a blank. refusals
      (list[dict]) - instance triples the store refused to merge.
      unmatched (list[dict]) - JSON artifact entries with no live tmux
      row, recorded rather than silently dropped.
    Output: a FirstRunImportResult instance.
    """

    outcome: str
    sessions_imported: int = 0
    projects: Optional[ReconcileResult] = None
    listing_reason: Optional[str] = None
    refusals: List[Dict[str, Any]] = field(default_factory=list)
    unmatched: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def pending(self) -> bool:
        """True when the import could not run and MUST be retried.

        Inputs: none.
        Output: bool.
        """
        return self.outcome == IMPORT_PENDING_LISTING_UNAVAILABLE

    def home_screen_notice(self) -> Optional[str]:
        """The sentence the home screen shows when the import is pending.

        Description: names what could not be measured, per the
          three-outcome rule's fourth line. Returns None on every other
          outcome, so the presence of a notice means "act".
        Inputs: none.
        Output: str | None.
        Example:
          FirstRunImportResult(IMPORT_PENDING_LISTING_UNAVAILABLE,
                               listing_reason='timeout').home_screen_notice()
        """
        if not self.pending:
            return None
        reason = self.listing_reason or "unknown"
        return (
            "Session import is PENDING: tmux could not be listed "
            f"(reason: {reason}). No sessions were imported and none were "
            "lost. This retries automatically on the next start."
        )


class ImportLatchUnreadable(RuntimeError):
    """The once-only latch record exists but cannot be read.

    Description: raised rather than returning an empty dict, because
      "the stage record is corrupt" and "the stage never ran" are
      different facts and only one of them means it is safe to run the
      import again. Treating the first as the second re-runs a once-only
      job AND makes ``_merge_result_blob`` overwrite the blob, discarding
      every key the unreadable value held - including other stages'
      records. A caller that genuinely wants to proceed must clear the
      key deliberately.
    Inputs (constructor): message (str).
    Output: an ImportLatchUnreadable instance.
    """


def _load_result_blob(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Read ``meta.imported_from_json_result`` as a dict.

    Description: the value is a single JSON object so each import stage
      owns its own key without overwriting another stage's history.

      AN UNREADABLE VALUE RAISES. It is not absent. Absent means the
      stage never ran and the import should proceed; unreadable means we
      CANNOT TELL, which is the third outcome and must never be reported
      as either neighbour. The old behaviour - log and return {} - made
      a garbled blob look like proof the stage had not run, re-ran the
      once-only import, and then clobbered every other stage's key on
      the way out.
    Inputs: conn (sqlite3.Connection).
    Output: dict - empty ONLY when the key is genuinely absent or empty.
    Raises: ImportLatchUnreadable - the stored value is present but is
      not parseable JSON, or parses to something other than an object.
    """
    raw = get_meta(conn, META_IMPORTED_FROM_JSON_RESULT)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError) as exc:
        logger.error(
            "import_result_blob_unparseable",
            raw=raw[:200],
            error=str(exc),
            note=(
                "the once-only import latch record cannot be read, so "
                "whether the sessions stage has run CANNOT BE DETERMINED; "
                "refusing to proceed rather than re-running it and "
                "discarding the other stages' keys"
            ),
        )
        raise ImportLatchUnreadable(
            "meta.imported_from_json_result is present but unparseable; "
            "cannot determine whether the sessions import already ran"
        ) from exc
    if not isinstance(parsed, dict):
        logger.error(
            "import_result_blob_not_an_object",
            raw=raw[:200],
            parsed_type=type(parsed).__name__,
        )
        raise ImportLatchUnreadable(
            "meta.imported_from_json_result parsed to "
            f"{type(parsed).__name__}, expected a JSON object"
        )
    return parsed


def _merge_result_blob(conn: sqlite3.Connection, patch: Dict[str, Any]) -> None:
    """Merge a patch into ``meta.imported_from_json_result``.

    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      patch (dict) - keys to set or overwrite.
    Output: None.
    """
    blob = _load_result_blob(conn)
    blob.update(patch)
    set_meta(conn, META_IMPORTED_FROM_JSON_RESULT, json.dumps(blob, sort_keys=True))


def sessions_stage_done(conn: sqlite3.Connection) -> bool:
    """Report whether the SESSIONS half of the first-run import has run.

    Description: the guard that makes this import once-only. Read from
      ``meta.imported_from_json_result`` rather than from the top-level
      latch, because an install upgraded through the projects-only S3
      code already has the latch set for a job that never touched
      sessions - locking it out would be the same silent-loss failure
      this module exists to prevent, arriving by a different door.
    Inputs: conn (sqlite3.Connection).
    Output: bool - True when the stage is recorded as done.
    Raises: ImportLatchUnreadable - the latch record is present but
      unreadable, so this question CANNOT BE ANSWERED. Deliberately not
      collapsed into False, which would re-run a once-only import on the
      strength of a verdict nobody measured.
    """
    return bool(_load_result_blob(conn).get(RESULT_KEY_SESSIONS_STAGE))


def _latch_sessions_stage(
    conn: sqlite3.Connection, stamp: str, detail: Dict[str, Any]
) -> None:
    """Write BOTH latch records for the sessions stage. The only site that may.

    Description: the single, auditable place where this module marks the
      import complete. Both writes live here for one reason: there are
      TWO of them and only one used to be guarded.

      ``meta.imported_from_json_at`` is what GET /sessions/import-status
      reports. ``imported_from_json_result[sessions_imported_at]`` is what
      :func:`sessions_stage_done` actually reads to decide whether to run.
      They are not the same key, and the structural proof in
      tests/test_session_import.py used to constrain only the first - so
      hoisting the SECOND above the failed-probe gate latched the import
      shut permanently while every reader reported it had never completed,
      and both AST assertions still passed.

      Collapsing both writes into one function makes the pair a single
      thing to locate, and the structural test now asserts that this
      function has exactly one call site and that the call site is after
      the gate. Adding a third latch write anywhere else in this module
      fails that test.
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      stamp (str) - ISO-8601 completion time, written to both records.
      detail (dict) - the sessions-stage detail blob.
    Output: None.
    """
    _merge_result_blob(
        conn,
        {
            RESULT_KEY_SESSIONS_STAGE: stamp,
            RESULT_KEY_SESSIONS_DETAIL: detail,
        },
    )
    set_meta(conn, META_IMPORTED_FROM_JSON_AT, stamp)


def run_first_run_import(
    conn: sqlite3.Connection,
    *,
    projects: Iterable[Any],
    listing: TmuxListing,
    owned_tmux_names: Optional[Set[str]] = None,
    persisted_sessions: Optional[Sequence[Dict[str, Any]]] = None,
    socket: str = DEFAULT_TMUX_SOCKET,
    now: Optional[str] = None,
    working_dir_probe: Optional[Callable[[str], Optional[str]]] = None,
) -> FirstRunImportResult:
    """Import config projects and live tmux sessions, once per install, ever.

    Description: design section 5.3, steps 2 through 8, with step 3 as the
      hard gate. Runs inside the caller's transaction, so a failure
      anywhere rolls the whole import back and - critically - leaves the
      latch unstamped, which is what makes the retry honest rather than a
      partial import wearing a completion badge.

      THE ORDER MATTERS AND IS NOT REARRANGEABLE:

        step 2  config projects (idempotent - ``import_from_config``
                dedupes against rows already present, so a retry after a
                failed probe does not double them).
        step 3  THE GATE. ``listing.ok is False`` returns PENDING right
                here: zero session rows, latch untouched, reason
                recorded. Every statement below is unreachable on that
                path.
        step 4  one row per live tmux session, ``origin`` from
                :func:`session_store.observed_origin_for` - ``created``
                or ``observed``, never ``adopted``.
        step 5  persisted session metadata merged onto its live row by
                name, or imported ``stopped`` when nothing matches,
                which is what gives RECENT its first row.
        step 7  project attribution, deepest match, ``unknown`` when the
                cwd could not be probed.
        step 8  stamp the latch. The ONLY stamp site in this module.
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      projects (Iterable) - ``AuthConfig.projects`` entries.
      listing (TmuxListing) - ONE ``tmux list-sessions`` result; read
      ``ok`` before anything else. owned_tmux_names (set[str] | None) -
      the legacy ``SessionManager.owned_tmux_sessions``. persisted_sessions
      (Sequence[dict] | None) - entries from ``session_metadata.json``,
      each with at least ``tmux_session``. socket (str). now (str | None).
      working_dir_probe (callable | None) - name -> cwd, or None when it
      cannot answer; absent probe means every row without an inline
      ``working_dir`` gets attribution ``unknown``, never a guess.
    Output: FirstRunImportResult.
    Example: run_first_run_import(conn, projects=[], listing=listing).outcome
    """
    stamp = now or utc_now()
    owned = set(owned_tmux_names or ())

    # --- step 2: config projects. RUNS ON EVERY START, ABOVE THE LATCH. ---
    #
    # It used to sit BELOW the sessions gate, so a project the OLD version
    # created while the user was downgraded never reached the table on
    # re-upgrade and the next snapshot_projects() then deleted it from
    # config.json too. Silent, and unrecoverable one write later.
    #
    # The latch is correct for SESSIONS and wrong for PROJECTS, and the
    # difference is the input, not the caller: sessions come from a live
    # tmux process table that is gone by tomorrow, projects come from a
    # durable file that says the same thing every time it is read. So the
    # sessions latch below is untouched and this stage moved out from
    # behind it. See src/core/project_reconcile.py for how the reconcile
    # tells "never imported" from "the user deleted it" - and for the
    # third answer, when it can tell neither.
    project_result = reconcile_projects(conn, projects, now=stamp)

    if sessions_stage_done(conn):
        return FirstRunImportResult(
            outcome=IMPORT_ALREADY_DONE, projects=project_result
        )

    # --- step 3: THE GATE ------------------------------------------------
    # ok=False is the ABSENCE of an answer. It carries no rows and must
    # not drive a single write below. Return before anything else runs.
    if not listing.ok:
        set_meta(
            conn,
            META_SESSION_IMPORT_PENDING_REASON,
            str(listing.reason or "unknown"),
        )
        logger.warning(
            "session_import_pending_listing_unavailable",
            listing_reason=listing.reason,
            listing_detail=listing.detail,
            sessions_imported=0,
            latch_stamped=False,
            note=(
                "imported_from_json_at deliberately left UNSET so the next "
                "start retries; importing an empty session list from a "
                "failed probe would destroy session history silently"
            ),
        )
        return FirstRunImportResult(
            outcome=IMPORT_PENDING_LISTING_UNAVAILABLE,
            sessions_imported=0,
            projects=project_result,
            listing_reason=listing.reason,
        )

    # --- steps 4 and 7: live tmux sessions -------------------------------
    roots = _project_roots(conn)
    persisted_by_name = {
        str(entry.get("tmux_session")): entry
        for entry in (persisted_sessions or ())
        if entry.get("tmux_session")
    }
    matched_names: Set[str] = set()
    refusals: List[Dict[str, Any]] = []
    imported = 0

    for raw in listing.sessions:
        row = _row_fields(raw)
        name = row.get("name")
        if not name:
            continue
        epoch = row["tmux_created_epoch"]
        working_dir = row.get("working_dir")
        if working_dir is None and working_dir_probe is not None:
            working_dir = working_dir_probe(name)
        project_id, attribution = attribute_working_dir(working_dir, roots)

        extra = _merge_fields(persisted_by_name.get(name))
        if name in persisted_by_name:
            matched_names.add(name)

        result = record_instance(
            conn,
            socket=socket,
            name=name,
            epoch=epoch,
            origin=observed_origin_for(name, owned),
            lifecycle=SESSION_LIFECYCLE_RUNNING,
            lifecycle_source=SESSION_LIFECYCLE_SOURCE_IMPORT,
            session_id=row.get("tmux_session_id"),
            now=stamp,
            project_id=project_id,
            project_attribution=attribution,
            working_dir=working_dir,
            **extra,
        )
        if result.refused:
            refusals.append(
                {
                    "tmux_socket": socket,
                    "tmux_name": name,
                    "tmux_created_epoch": epoch,
                    "detail": result.detail,
                }
            )
        elif result.outcome == RECORD_INSERTED:
            imported += 1

    # --- step 5: persisted sessions with no live tmux row ----------------
    unmatched: List[Dict[str, Any]] = []
    for name, entry in persisted_by_name.items():
        if name in matched_names:
            continue
        unmatched.append({"tmux_session": name, "reason": "no_live_tmux_row"})
        # ORIGIN COMES FROM THE SAME RESOLVER STEP 4 USES. This used to
        # hardcode SESSION_ORIGIN_OBSERVED, which badged the user's own
        # session EXTERNAL on the very upgrade this import exists to
        # protect: session_metadata.json holds exactly ONE session, the
        # most recently active, which for an app user is almost always
        # one the app created. It is still never ``adopted`` - past
        # adoptions were persisted nowhere, so importing one would be
        # inventing a fact.
        # Discriminator and epoch are both passed EXPLICITLY, so a NULL in
        # either is a measured absence, not a forgotten argument. A NULL
        # discriminator can never cause a refusal, so omitting it silently
        # unarms the instance-mismatch guard for this row. See
        # session_import_mapping for what each reads and why.
        result = record_instance(
            conn,
            socket=socket,
            name=name,
            epoch=_stopped_epoch(entry),
            origin=observed_origin_for(name, owned),
            lifecycle=SESSION_LIFECYCLE_STOPPED,
            lifecycle_source=SESSION_LIFECYCLE_SOURCE_IMPORT,
            session_id=_persisted_session_id(entry),
            now=stamp,
            project_attribution=SESSION_ATTRIBUTION_UNKNOWN,
            **_merge_fields(entry),
        )
        if result.outcome == RECORD_INSERTED:
            imported += 1

    # --- step 8: the latch. THE ONLY STAMP SITE IN THIS MODULE. ----------
    # Reachable only from the listing.ok is True path above.
    _latch_sessions_stage(
        conn,
        stamp,
        {
            "sessions_imported": imported,
            "epoch_collisions_refused": refusals,
            "persisted_without_live_tmux": unmatched,
            "listing_reason": listing.reason,
        },
    )
    logger.info(
        "session_import_completed",
        sessions_imported=imported,
        projects_imported=len(project_result.imported),
        refusals=len(refusals),
        total_rows=count_sessions(conn),
    )
    return FirstRunImportResult(
        outcome=IMPORT_COMPLETED,
        sessions_imported=imported,
        projects=project_result,
        listing_reason=listing.reason,
        refusals=refusals,
        unmatched=unmatched,
    )


