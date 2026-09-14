"""Ask which project an unattributed session belongs to, and decline.

EVERY SESSION BELONGS TO A PROJECT. These endpoints are the human seam
for the rows where the binding could not be resolved automatically; the
ladder itself, and the rule that the project id and its attribution MOVE
TOGETHER OR NEITHER MOVES, live in
``src/core/session_project_binding.py``. A row carrying an id beside an
attribution of ``none`` renders under "no project" while holding a
perfectly good one, which is the half-write this seam must never
recreate.
"""

import json
import sqlite3
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from src.api.auth import require_auth
from src.config import settings
from src.models import (
    AttributionDeclineRequest,
    AttributionDeclineResponse,
    SessionAttributionPrompt,
    UnattributedSession,
)

# MODULE SCOPE, DELIBERATELY. run_in_threadpool was imported inside
# individual handlers, so any NEW handler in the same module that used
# it raised ``NameError: name 'run_in_threadpool' is not defined`` -
# which FastAPI turns into a bare 500 with no body. Two routes shipped
# that way and both failed with three digits and nothing to act on.
# tests/test_route_names_resolve.py fails the build if a module uses
# this name without binding it here.
from fastapi.concurrency import run_in_threadpool

logger = structlog.get_logger()
router = APIRouter()


@router.get(
    "/sessions/attribution-prompt",
    response_model=SessionAttributionPrompt,
    dependencies=[Depends(require_auth)],
)
async def session_attribution_prompt(request: Request):
    """The sessions the evidence ladder could not attribute, itemised.

    Description: STAGE C. The import decides silently only where tiers 1
      to 4 PROVE a session is ours. Everything else lands here, with the
      hints spelled out in words, and the user answers once.

      WHY THIS IS NOT FOLDED INTO GET /sessions/import-status. That route
      answers "has the import run"; this one answers "is there anything
      left to ask you". They can disagree in both directions - a
      completed import can still leave questions, and a pending one
      leaves none because it has not looked yet - so collapsing them
      would make one of the two answers unreadable.

      THE STORED RECORD IS THE CANDIDATE SET, NOT THE ANSWER. It is a
      snapshot written once, at import time, and every answer the user
      gives happens afterwards on ``sessions``. Reading it back verbatim
      is what made "adopt all" leave the card on screen: the five rows
      were genuinely ``adopted``, stamped at the second he clicked, and
      the prompt re-rendered the snapshot that could not know it. So the
      list is re-derived on every request against
      ``attribution_settled_instances``, and no future path that answers
      an attribution question has to remember to prune anything.

      WHAT IS NOT PRUNED, deliberately. A candidate we cannot cross
      reference - no epoch in the record, no rows table to ask, or no row
      at all - stays in the list. None of those is evidence the question
      was answered, and dropping one would trade a card that will not
      clear for a question that vanished unanswered, which is the same
      defect pointed the other way.

      A row the user has already declined never appears here: the decline
      route writes ``user_declined_at``, which takes it out of the
      derivation above, so the prompt does not return on every boot.
    Inputs: request (Request) - unused beyond auth.
    Output: SessionAttributionPrompt. ``unavailable`` when the datastore
      could not be read, which is NEVER rendered as an empty prompt: an
      empty question set and an unreadable one look identical to a user
      and mean opposite things.
    """
    import json as _json
    from contextlib import closing


    from src.core.db import DatastoreUnreadableError, connect, db_path_for, get_meta
    from src.core.db_models import META_SESSION_IMPORT_UNATTRIBUTED
    from src.core.session_import_promote import attribution_settled_instances
    from src.core.session_label import label_for_instance

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        return SessionAttributionPrompt(state="none")

    socket = request.app.state.session_manager.tmux_socket_name()

    def _read():
        """Read the snapshot AND the live answers on one pooled thread.

        Output: tuple[str | None, set | None, callable] - the stored
          record, the instances whose question is settled (None when that
          could not be determined at all), and a label lookup closed over
          nothing (the labels are read here, on this same connection, so
          the render pass below needs no second open).
        """
        with closing(connect(db_path, create=False)) as conn:
            record = get_meta(conn, META_SESSION_IMPORT_UNATTRIBUTED)
            settled_now = attribution_settled_instances(conn, socket=socket)
            # Read every candidate's label on this connection. Parsing the
            # record here would duplicate the validation below, so the
            # lookup is deferred by handing back a reader bound to a live
            # connection - which cannot outlive this block, hence the
            # eager dict instead.
            labels = {}
            try:
                parsed = json.loads(record) if record else None
            except (TypeError, ValueError):
                parsed = None
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    nm = item.get("tmux_name")
                    ep = item.get("epoch")
                    if not nm:
                        continue
                    labels[(str(nm), ep)] = label_for_instance(
                        conn, socket=socket, name=str(nm), epoch=ep
                    )
            return record, settled_now, labels

    try:
        raw, settled, labels = await run_in_threadpool(_read)
    except DatastoreUnreadableError as exc:
        return SessionAttributionPrompt(
            state="unavailable",
            notice=(
                "Whether any sessions need attributing CANNOT BE "
                f"DETERMINED: the datastore could not be read ({exc})."
            ),
        )

    if not raw:
        # ABSENT means the ladder has never run here, which is not the
        # same as "it ran and found nothing" - but neither one has a
        # question for the user, so both render as 'none'.
        return SessionAttributionPrompt(state="none")

    try:
        records = _json.loads(raw)
    except (TypeError, ValueError):
        return SessionAttributionPrompt(
            state="unavailable",
            notice=(
                "Whether any sessions need attributing CANNOT BE "
                "DETERMINED: the stored record could not be parsed."
            ),
        )
    if not isinstance(records, list) or not records:
        return SessionAttributionPrompt(state="none")

    def _still_open(record) -> bool:
        """Whether this candidate is still an unanswered question.

        Inputs: record (Any) - one stored candidate.
        Output: bool - True unless the row it names has PROVABLY moved
          out of 'observed and not declined'. Anything we could not
          cross-reference returns True, because not knowing is not an
          answer.
        """
        if not isinstance(record, dict) or settled is None:
            return True
        epoch = record.get("epoch")
        if epoch is None:
            return True
        try:
            key = (str(record.get("tmux_name", "")), int(epoch))
        except (TypeError, ValueError):
            return True
        return key not in settled

    records = [r for r in records if _still_open(r)]
    if not records:
        return SessionAttributionPrompt(state="none")

    sessions = [
        UnattributedSession(
            tmux_name=str(r.get("tmux_name", "")),
            epoch=r.get("epoch"),
            # Keyed on the full instance triple in ``_read`` above, so a
            # different instance that once shared this tmux name cannot
            # lend its label to the row the user is being asked about.
            label=labels.get((str(r.get("tmux_name", "")), r.get("epoch"))),
            hints=[str(h) for h in (r.get("hints") or [])],
            reason=str(r.get("reason", "no_admissible_evidence")),
        )
        for r in records
        if r.get("tmux_name")
    ]
    if not sessions:
        return SessionAttributionPrompt(state="none")

    count = len(sessions)
    plural = "session" if count == 1 else "sessions"
    return SessionAttributionPrompt(
        state="pending",
        sessions=sessions,
        notice=(
            f"{count} {plural} we could not attribute. "
            f"{'This was' if count == 1 else 'These were'} running on the "
            "tmux socket when Cloude Code upgraded, and we have no record "
            "of whether we started "
            f"{'it' if count == 1 else 'them'}. Adopting a session lets "
            "Cloude Code manage it; it does not change or restart "
            "anything inside it."
        ),
    )


@router.post(
    "/sessions/attribution-decline",
    response_model=AttributionDeclineResponse,
    dependencies=[Depends(require_auth)],
)
async def session_attribution_decline(
    request: Request, body: AttributionDeclineRequest
):
    """Record "leave these as external" so the prompt does not come back.

    Description: STAGE C's third answer, and the one that is easiest to
      get wrong. It writes ``user_declined_at`` and leaves ``origin``
      alone - the row already says ``observed``, so without the stamp
      this answer is indistinguishable from never having been asked and
      the prompt returns on every boot.

      IT REPORTS PER SESSION, NOT AS A COUNT. A name whose row is not
      ``observed``, or that has no row at all, comes back in its own list
      rather than being counted as a success nobody measured.
    Inputs: request (Request). body (AttributionDeclineRequest).
    Output: AttributionDeclineResponse.
    Raises: HTTPException 503 - the datastore could not be read or
      written, so the answer WAS NOT RECORDED and must not be reported
      as if it had been.
    """
    import json as _json
    from contextlib import closing


    from src.core.db import (
        DatastoreUnreadableError,
        connect,
        db_path_for,
        get_meta,
        set_meta,
        transaction,
    )
    from src.core.db_models import META_SESSION_IMPORT_UNATTRIBUTED
    from src.core.session_import_promote import (
        PROMOTE_APPLIED,
        PROMOTE_NO_ROW,
        record_decline,
    )
    from src.core.trail_entry import utc_now

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "the datastore does not exist, so this answer WAS NOT "
                "recorded"
            ),
        )
    socket = request.app.state.session_manager.tmux_socket_name()
    names = [str(n) for n in body.tmux_names if str(n).strip()]
    stamp = utc_now()

    def _write():
        """Record every decline in ONE transaction, then rebuild the list."""
        declined, not_eligible, unknown = [], [], []
        with closing(connect(db_path, create=False)) as conn:
            raw = get_meta(conn, META_SESSION_IMPORT_UNATTRIBUTED)
            try:
                records = _json.loads(raw) if raw else []
            except (TypeError, ValueError):
                records = []
            epochs = {
                str(r.get("tmux_name")): r.get("epoch")
                for r in records
                if isinstance(r, dict)
            }
            with transaction(conn):
                for name in names:
                    outcome = record_decline(
                        conn,
                        socket=socket,
                        name=name,
                        epoch=epochs.get(name),
                        now=stamp,
                    )
                    if outcome == PROMOTE_APPLIED:
                        declined.append(name)
                    elif outcome == PROMOTE_NO_ROW:
                        unknown.append(name)
                    else:
                        not_eligible.append(name)
                remaining = [
                    r
                    for r in records
                    if isinstance(r, dict)
                    and str(r.get("tmux_name")) not in set(declined)
                ]
                set_meta(
                    conn,
                    META_SESSION_IMPORT_UNATTRIBUTED,
                    _json.dumps(remaining, sort_keys=True),
                )
        return declined, not_eligible, unknown

    try:
        declined, not_eligible, unknown = await run_in_threadpool(_write)
    except (DatastoreUnreadableError, sqlite3.Error) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"this answer WAS NOT recorded: {exc}",
        )
    logger.info(
        "api_attribution_declined",
        declined=len(declined),
        not_eligible=len(not_eligible),
        unknown=len(unknown),
    )
    return AttributionDeclineResponse(
        declined=declined, not_eligible=not_eligible, unknown=unknown
    )
