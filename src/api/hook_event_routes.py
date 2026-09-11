"""The Claude Code lifecycle hook endpoint.

``POST /hooks/claude-event``, and it INTENTIONALLY does not use
``Depends(require_auth)``: the hook subprocess is spawned by Claude Code
inside a tmux pane on this machine and has no place for a JWT. Two
orthogonal layers authenticate it and both must pass - loopback only
(127.0.0.1, ::1 or localhost), and a per-session bearer token minted at
session create, injected as ``CLOUDECODE_HOOK_TOKEN`` and compared with
``hmac.compare_digest``.

A MINT THAT LANDS ON A RUNNING AGENT IS RECOVERABLE ONCE, which is the
only reason a rejected token gets a second look: a mint replaces the
credential a running process holds and cannot be handed a replacement
for, so it 403s forever with no retry available from its side - measured
2026-09-08, 4,325 rejections over 4h24m from one such mint.
``HookTokenAuthority.recover`` accepts ONLY a token this process itself minted
for THAT id on THAT pane and then superseded, and it NEVER mints.

EVENTS ARRIVE UNORDERED, DUPLICATED AND DROPPABLE, so every consumer
this endpoint reaches is idempotent. The two decision halves it used to
carry inline are pure modules with their own tests:
``src/core/hook_event_presentation.py`` for the toast copy, and
``src/core/hook_toast_gate.py`` for whether the toast may interrupt.
"""

import json
import structlog
from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from src.api.websocket import connection_manager
from src.core import claude_hooks, claude_title_sync_apply, debug_trace
from src.core import session_change_notice
from src.core.hook_event_presentation import hook_event_presentation
from src.api.hook_event_signals import read_suppression_signals
from src.core.hook_toast_gate import resolve_toast_gate
from src.core.hook_token_recovery import (
    RECOVERY_ACCEPTED as HOOK_RECOVERY_ACCEPTED,
    RECOVERY_UNAVAILABLE as HOOK_RECOVERY_UNAVAILABLE,
)
from src.core.session_lineage import LINEAGE_UNRESOLVED
from src.models import SessionRenamedMessage, ToastAckMessage, ToastNewMessage

logger = structlog.get_logger()
router = APIRouter()


# feat/hook-driven-status - the endpoint now accepts every managed event,
# not just the three toast-worthy ones. TOAST_EVENTS still get a toast +
# WS broadcast (unchanged behavior); ACTIVITY_ONLY_EVENTS update ONLY the
# activity-status state machine (src/core/session_activity.py) - no toast,
# no broadcast, since PreToolUse/PostToolUse fire on every tool call and
# would spam the toast UI. Single source of truth for both sets lives in
# claude_hooks.py (also consulted by ``ensure_hook_settings`` to decide
# which hooks to install), so the whitelist here can never drift from what
# actually gets installed.
_VALID_HOOK_EVENTS = (
    claude_hooks.TOAST_EVENTS
    + claude_hooks.ACTIVITY_ONLY_EVENTS
    # feat/session-lineage - SessionStart / SessionEnd. Same derivation
    # rule as the two tuples above: read off claude_hooks so the set the
    # endpoint ACCEPTS can never drift from the set
    # ``ensure_hook_settings`` INSTALLS. A hook installed but rejected
    # here would 400 forever and look, from the session side, exactly
    # like a hook that was never installed at all.
    + claude_hooks.LIFECYCLE_EVENTS
)
_LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


@router.post("/hooks/claude-event", include_in_schema=False)
async def claude_event_hook(request: Request):
    """Receive a Claude Code lifecycle hook POST.

    NO JWT. Auth = loopback + HMAC token in the ``X-Cloudecode-Token``
    header. See the section header above for the full security model.

    Required headers:
        X-Cloudecode-Session: cloudecode session id
        X-Cloudecode-Token:   the HMAC bearer minted at session create
        X-Cloudecode-Event:   one of ``_VALID_HOOK_EVENTS`` (TOAST_EVENTS
                               ``Stop``/``PermissionRequest``/``Notification``,
                               or ACTIVITY_ONLY_EVENTS
                               ``UserPromptSubmit``/``PreToolUse``/
                               ``PostToolUse``/``SubagentStart``/
                               ``SubagentStop`` - feat/hook-driven-status)

    Body: the raw JSON Claude Code's hook would normally pipe to a
    shell command's stdin (we just forward stdin → curl --data-binary @-).
    Schema is per-event and tolerated defensively - see
    ``hook_event_presentation``.

    On success: EVERY event kind updates the activity-status state machine
    (``SessionManager.record_hook_event`` - see
    ``src/core/session_activity.py``). TOAST_EVENTS additionally record a
    toast (existing Part 2 storage) and broadcast ``toast.new`` to the
    session's WS subscribers; ACTIVITY_ONLY_EVENTS do neither (PreToolUse/
    PostToolUse fire on every tool call - a toast per call would spam the
    UI) and return ``{"ok": true}`` with no ``toast_id``.
    """
    # THE EVENT'S OWN INSTANT, CAPTURED BEFORE ANYTHING IS MUTATED.
    # Hook events are unordered, duplicated and droppable, so the moment
    # this handler RUNS says nothing about when the thing it describes
    # HAPPENED. The auto-ack pass below compares a toast's own
    # ``created_at`` against this, so a record raised after the user
    # acted is never cleared by that act, however late or however many
    # times this POST is delivered. Naive UTC to match
    # ``Toast.created_at``. See src/core/toast_auto_ack.py.
    received_at = datetime.utcnow()

    # Layer 1 - loopback only. Even a token leak shouldn't let a LAN
    # attacker fire toasts at someone else's cloudecode.
    client_host = request.client.host if request.client else ""
    if client_host not in _LOOPBACK_HOSTS:
        logger.warning("hook_post_rejected_non_loopback", client_host=client_host)
        raise HTTPException(status_code=403, detail="loopback only")

    # Header extraction (FastAPI normalizes header keys to canonical
    # case but the .get is case-insensitive on starlette's Headers).
    session_id = request.headers.get("X-Cloudecode-Session", "")
    token = request.headers.get("X-Cloudecode-Token", "")
    event_kind = request.headers.get("X-Cloudecode-Event", "")
    if not (session_id and token and event_kind):
        raise HTTPException(status_code=400, detail="missing required headers")

    if event_kind not in _VALID_HOOK_EVENTS:
        raise HTTPException(status_code=400, detail="unknown event kind")

    session_manager = request.app.state.session_manager

    # Layer 2 - HMAC token validation, constant time.
    if not session_manager.hook_tokens.validate(session_id, token):
        # SECOND CHANCE FOR OUR OWN MISTAKE, AND ONLY FOR THAT. A mint
        # that lands on an id whose agent is already running revokes a
        # credential the agent cannot be handed a replacement for, so it
        # 403s forever with no retry available from its side - measured
        # 2026-09-08, 4,325 rejections over 4h24m from a single such
        # mint. ``HookTokenAuthority.recover`` accepts ONLY a token this process
        # itself minted for this id, on this pane, and then superseded;
        # it re-binds the store to what the running process holds, once,
        # and NEVER mints. Anything else still rejects.
        # ``getattr`` because a caller may inject a session-manager
        # double predating this method, and a missing recovery must
        # refuse exactly as it always did.
        authority = getattr(session_manager, "hook_tokens", None)
        recover = getattr(authority, "recover", None)
        recovery = (
            recover(session_id, token)
            if callable(recover)
            else HOOK_RECOVERY_UNAVAILABLE
        )
        if recovery != HOOK_RECOVERY_ACCEPTED:
            # NEVER log the token value. We log session_id + event_kind so
            # operators can spot brute-force attempts without leaking the
            # secret. ``recovery`` says whether a superseded token was
            # searched for and not found, or whether there was nothing to
            # search - a check that could not run must not read as one
            # that ran and cleared.
            logger.warning(
                "hook_post_rejected_invalid_token",
                session_id=session_id,
                event_kind=event_kind,
                recovery=recovery,
            )
            raise HTTPException(status_code=403, detail="invalid token")

    # Tolerate empty / malformed body - the title/body resolver is
    # defensive and falls through to generic copy when fields are absent.
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}

    # READ BEFORE THE EVENT IS APPLIED, because ``Stop`` itself resets the
    # count to 0 (session_activity.record_event). The question the toast
    # gate below asks is "were sub-agents running when this event fired",
    # and for a Stop the only moment that is answerable is BEFORE it
    # lands. Reading it afterwards would answer 0 every time and the gate
    # would never fire. It is read here for every kind rather than only
    # for Stop so that one value means one thing.
    #
    # This is also why the gate cannot be built on ``SubagentStop``:
    # claude fires one of those about 1.5s AFTER the ``Stop`` on a turn
    # that had no subagent in it (measured - see CLAUDE.md), so an event
    # that has not arrived yet can neither confirm nor deny anything. The
    # depth as it stood at this event is the only thing available at the
    # moment the decision has to be made.
    #
    # THE THREE PRE-GATE SIGNALS, read BEFORE ``record_hook_event`` so an
    # event can never be judged by the state it just wrote, and every one
    # of them failing toward NOTIFYING. The rules and the refusals live in
    # src/api/hook_event_signals.py.
    (
        subagent_depth_at_event,
        subagent_wait_at_event,
        idle_notification_suppressed_at_event,
    ) = read_suppression_signals(session_manager, session_id, event_kind)

    # feat/hook-driven-status - EVERY valid event kind updates the
    # activity-status state machine, not just the toast-worthy ones.
    # Best-effort: record_hook_event never raises (see its docstring), so
    # this can't turn an activity-only event into a 410/500 for a session
    # that's mid-teardown - only the toast path below (which DOES need to
    # know the session still exists to attach a color/router emit) raises.
    try:
        session_manager.record_hook_event(session_id, event_kind, payload)
    except Exception as exc:  # pragma: no cover - defensive, see docstring
        logger.warning(
            "hook_activity_record_failed",
            session_id=session_id,
            event_kind=event_kind,
            error=str(exc),
        )

    # THE LIGHT MOVED, SO SAY SO WITHOUT WAITING FOR A POLL. A compact
    # status notice on /ws/events reaches a browser sitting on the home
    # screen or looking at a different session, which the per-session
    # terminal socket cannot. It is published HERE, before the gates
    # below, because a mute suppresses the INTERRUPTION and never what a
    # row is allowed to say: a muted session's light updates on the poll
    # today and would be visibly stale if this refused to report it. The
    # TOAST notice is the gated one, and it is published past the gate.
    # Never awaits, never raises, and publishes nothing when no browser
    # is connected - see src/core/session_change_notice.py.
    session_change_notice.publish_hook_status(
        request.app.state, session_manager, session_id
    )

    # THE USER TURNED UP, SO THE SESSION'S NOTIFICATIONS ARE ANSWERED.
    # The owner's ask: a toast that is waiting on him should clear when
    # he types into the session, from the browser terminal, a remote
    # control session, or the keyboard on the Mac - all three submit a
    # prompt, and a prompt fires ``UserPromptSubmit``. ``PreToolUse``
    # answers a permission (a tool is about to run, so it was granted)
    # and ``Stop`` answers a permission or a notice but NEVER a "your
    # turn". The rules, and why each set is the size it is, live in
    # src/core/toast_auto_ack.py.
    #
    # THIS SEAM AND NOT ANOTHER: ``UserPromptSubmit`` and ``PreToolUse``
    # are ACTIVITY_ONLY_EVENTS and return before the toast block below,
    # while ``Stop`` continues into it, so this is the one point all
    # three pass through. It is deliberately NOT relying on sitting
    # ahead of ``record_toast`` to spare a Stop's own toast - that is
    # guaranteed by KIND, so it survives a reordering and a duplicate.
    #
    # BEST-EFFORT, like its neighbours: clearing a notification must
    # never change the status code a hook subprocess sees.
    try:
        auto_acked = session_manager.auto_ack_toasts(
            session_id, event_kind, received_at
        )
        for acked_id in auto_acked:
            # THE SAME FRAME A CLICK PRODUCES, from the same fan-out, so
            # an attached terminal drops the card instantly and every
            # other surface picks it up on its next poll. One path, not
            # a second dismissal protocol.
            await connection_manager.broadcast_to_session(
                session_id,
                ToastAckMessage(toast_id=acked_id).model_dump_json(),
            )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.warning(
            "toast_auto_ack_failed",
            session_id=session_id,
            event_kind=event_kind,
            error=str(exc),
        )

    # THE ONLY WAY THE APP CAN LEARN ABOUT `/rename` TYPED INTO A PANE.
    # No hook event carries it - Claude intercepts slash commands before
    # they become prompts, and there is no SessionRename event - so the
    # name is only ever readable out of the transcript. Every event kind
    # passes through here, which makes this the one seam where a pull can
    # be hung without inventing a poller.
    #
    # BEST-EFFORT AND CHEAP. One SELECT plus a bounded 64 KB tail read
    # (measured at 0.274 ms median against a 244 MB transcript) and NO
    # write unless a name actually changed. It is wrapped for the same
    # reason the lineage write below is: this runs on the critical path of
    # a live working session and a title is telemetry, so nothing here may
    # change the status code the hook sees.
    try:
        title_sync = claude_title_sync_apply.sync_claude_title(
            session_manager, session_id
        )
        if title_sync.broadcast_title:
            # Same message the browser rename broadcasts, so a name typed
            # in the terminal and one typed in the browser update every
            # attached tab through one code path rather than two.
            await connection_manager.broadcast_to_session(
                session_id,
                SessionRenamedMessage(
                    session_id=session_id, new_name=title_sync.broadcast_title
                ).model_dump_json(),
            )
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.warning(
            "claude_title_sync_failed",
            session_id=session_id,
            event_kind=event_kind,
            error=str(exc),
        )

    # feat/session-lineage - SessionStart carries the Claude conversation
    # uuid and the ``source`` that says how it began; SessionEnd carries
    # the reason it stopped. This is the ONLY place the app learns which
    # conversation is inside a tmux session.
    #
    # BEST-EFFORT, LOUDLY. ``record_claude_lifecycle_event`` is documented
    # never to raise and returns a named outcome for every failure, but it
    # is wrapped anyway: this endpoint runs on the critical path of a live
    # working session, and lineage is telemetry. Nothing about a lineage
    # write may change the status code the hook sees.
    if event_kind in claude_hooks.LIFECYCLE_EVENTS:
        # DEBUG TRACE. This is the exact point where a hook that "fired
        # successfully" can still deliver nothing useful, and the only
        # place the app can see what Claude actually sent. Off unless
        # CLOUDE_DEBUG=1. See src/core/debug_trace.py for why the ordinary
        # logs could not answer this.
        debug_trace.trace(
            "hook.lifecycle.received",
            session_id=session_id,
            event_kind=event_kind,
            payload_keys=sorted(payload.keys()) if isinstance(payload, dict) else None,
            payload_type=type(payload).__name__,
            claude_session_id=(
                payload.get("session_id") if isinstance(payload, dict) else None
            ),
            source=payload.get("source") if isinstance(payload, dict) else None,
            body_empty=not payload,
        )
        try:
            outcome = session_manager.record_claude_lifecycle_event(
                session_id, event_kind, payload
            )
            debug_trace.trace(
                "hook.lifecycle.outcome",
                session_id=session_id,
                event_kind=event_kind,
                outcome=getattr(outcome, "outcome", None),
                detail=getattr(outcome, "detail", None),
                row_id=getattr(outcome, "row_id", None),
            )
            if outcome.outcome == LINEAGE_UNRESOLVED:
                # THE THIRD OUTCOME REACHES A LOG, never a silent pass.
                # "We were told about a Claude session and could not work
                # out which row it belongs to" is a real finding; folding
                # it into the success path is how missing lineage becomes
                # invisible missing lineage.
                logger.info(
                    "claude_lineage_unresolved",
                    session_id=session_id,
                    event_kind=event_kind,
                    detail=outcome.detail,
                )
        except Exception as exc:  # pragma: no cover - defensive, see above
            logger.warning(
                "claude_lineage_hook_failed",
                session_id=session_id,
                event_kind=event_kind,
                error=str(exc),
            )
            debug_trace.trace(
                "hook.lifecycle.threw",
                session_id=session_id,
                event_kind=event_kind,
                error=str(exc),
                error_type=type(exc).__name__,
            )
        return {"ok": True}

    if event_kind not in claude_hooks.TOAST_EVENTS:
        # ACTIVITY_ONLY_EVENTS - state machine already updated above, no
        # toast to create or broadcast.
        return {"ok": True}

    # THE TWO GATES THAT CAN SILENCE A TOAST LIVE IN
    # src/core/hook_toast_gate.py, AS A PURE LADDER. The read is here
    # because it needs the session manager; the decision is there
    # because it needs nothing. Its module docstring carries the whole
    # account: why mute is asked first, why mute covers
    # ``PermissionRequest`` and the sub-agent gate does not, why an
    # unreadable policy suppresses while an unknown sub-agent count does
    # not, and why suppressing a toast never acknowledges anything.
    #
    # THE POLICY READ IS SKIPPED ENTIRELY when no policy store is
    # attached, so a build without the feature behaves exactly as before.
    policy = None
    policy_store_attached = (
        getattr(session_manager, "_notification_policy_store", None) is not None
    )
    if policy_store_attached:
        try:
            policy = session_manager.notification_policy_for(session_id)
        except Exception as exc:  # pragma: no cover - defensive
            # A read that THREW is a read that did not answer, and an
            # unanswered mute may not be read as "not muted".
            logger.warning(
                "hook_notification_policy_unreadable",
                session_id=session_id,
                event_kind=event_kind,
                error=str(exc),
            )
            policy = None

    gate = resolve_toast_gate(
        event_kind,
        policy_store_attached=policy_store_attached,
        policy=policy,
        subagent_depth=subagent_depth_at_event,
        subagent_wait_active=subagent_wait_at_event,
        idle_notification_suppressed=idle_notification_suppressed_at_event,
    )
    if not gate.raises_toast:
        logger.info(
            gate.log_event,
            session_id=session_id,
            event_kind=event_kind,
            **gate.log_fields,
        )
        return {"ok": True, "toast_suppressed": gate.suppressed_by}

    title, body = hook_event_presentation(event_kind, payload)

    try:
        toast = session_manager.record_toast(
            session_id=session_id,
            kind=event_kind,
            title=title,
            body=body,
        )
    except ValueError as exc:
        # Race: session got destroyed between the token mint and now.
        # 410 Gone signals "this session is no longer accepting hooks"
        # so the hook subprocess (which can't retry sensibly) just exits.
        raise HTTPException(status_code=410, detail=str(exc))

    # Fan out to every browser bound to this session - matches the
    # Part 2 POST /sessions/{id}/toasts behavior so hook-originated and
    # synthetic toasts present identically.
    try:
        await connection_manager.broadcast_to_session(
            session_id,
            ToastNewMessage(toast=toast).model_dump_json(),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "hook_toast_broadcast_failed",
            session_id=session_id,
            error=str(exc),
        )

    # AND THE SAME TOAST ONTO THE PER-BROWSER CHANNEL, so a client that
    # holds no terminal socket for this session still sees the card. The
    # MUTE GATE IS SATISFIED BY CONSTRUCTION rather than by a second copy
    # of the rule: a suppressed toast returns above and never reaches this
    # line, so this cannot disagree with the notification policy. The
    # frame is the SAME ``toast.new`` shape the terminal socket carries,
    # so the client has one handler and not two.
    session_change_notice.publish(
        request.app.state,
        json.loads(ToastNewMessage(toast=toast).model_dump_json()),
    )

    return {"ok": True, "toast_id": toast.id}
