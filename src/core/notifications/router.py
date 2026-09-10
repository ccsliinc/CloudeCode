"""Notification dispatcher - bounded queue, drop-oldest on overflow.

Design contract:
- ``emit()`` is SYNCHRONOUS and non-blocking. It is called from the
  WebSocket / PTY chunk handler (Item 7's IdleWatcher) and MUST NOT
  await or stall - that would back up the terminal stream.
- The worker task drains the queue async and hands each event to
  ``channel_dispatch.dispatch_channels``, which contacts ntfy, slack
  and pushover CONCURRENTLY under a per-channel bound. Send failures
  never propagate - each backend's ``send`` already catches and logs,
  and the dispatcher reports one outcome per channel on top of that.
  THE ORDER THE NETWORK IS CONTACTED IN IS NO LONGER GUARANTEED; the
  queue itself is still strictly sequential. See
  ``src/core/notifications/channel_dispatch.py``.
- Queue size 100. On overflow we drop the OLDEST event (best-effort:
  the most recent signal is usually most relevant) and log both the
  drop and the enqueue at WARN.

- The DURABLE PER-SESSION MUTE is checked twice, at ``emit()`` and again
  at drain. The second is the one that matters: an event can wait in the
  queue across a policy change, and only a check at the moment of sending
  can see that. See ``attach_policy_store`` / ``_policy_allows`` below and
  ``src/core/session_notification_policy.py`` for the three-value policy
  and why an unread one suppresses rather than passing.

Lifecycle: ``start()`` in the FastAPI lifespan, ``stop()`` on shutdown.
``ntfy.init()``, ``slack.init()``, and ``pushover.init()`` MUST be
called before ``start()`` so the worker has clients to dispatch through.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import structlog

from src.core.notifications import channel_dispatch
from src.core.notifications.channel_dispatch import CHANNEL_TIMEOUT_SECONDS
from src.core.notifications.events import NotificationEvent
from src.core.notifications.rate_limit import RateLimiter
from src.core.session_notification_policy import (
    DISPATCH_ALLOWED_UNSTAMPED,
    DISPATCH_REFUSED_POLICY_UNKNOWN,
    POLICY_UNKNOWN,
    NotificationPolicyStore,
)

logger = structlog.get_logger()


# Queue cap - 100 is plenty for human-paced terminal events. Burst
# pathology (a runaway stream of pattern matches) would drop oldest and
# log; the next IdleWatcher refactor (Item 8) adds rate-limiting on top.
_QUEUE_MAXSIZE = 100


class NotificationRouter:
    """Single-active-session notification dispatcher.

    Args:
        config: the ``AuthConfig.notifications`` block. Reads
            ``enabled``, ``ntfy_topic``, ``public_base_url``.
        loop: the running asyncio loop. Stored for potential future
            cross-thread emit support; current ``emit()`` is invoked
            from the same loop so this is a no-op today.
    """

    def __init__(self, config, loop: asyncio.AbstractEventLoop):
        self._config = config
        self._loop = loop
        self._queue: asyncio.Queue[NotificationEvent] = asyncio.Queue(
            maxsize=_QUEUE_MAXSIZE
        )
        self._worker_task: Optional[asyncio.Task] = None
        self._stopped = False
        # Cache the public_base_url at construction so we don't reach
        # back into config on every emit (and so a runtime config mutation
        # doesn't half-apply mid-burst).
        self._public_base_url: str = getattr(config, "public_base_url", "") or ""
        self._topic_warned: bool = False
        # Plan v3.1 Item 8 - rate limiter. Config-driven; defaults match plan.
        # NOT thread-safe by design: only the single async worker invokes it.
        self.rate_limiter = RateLimiter(
            global_cap=int(getattr(config, "rate_limit_global_cap", 10)),
            window_s=float(getattr(config, "rate_limit_window_seconds", 60.0)),
            per_kind_cooldown_s=float(
                getattr(config, "rate_limit_per_kind_cooldown_seconds", 10.0)
            ),
        )
        # DURABLE PER-SESSION MUTE. None until the lifespan attaches one,
        # and a None store lets everything through - a router built
        # without a policy store behaves exactly as it did before this
        # existed, which is what keeps every non-session producer and
        # every existing test unaffected. See ``attach_policy_store``.
        self._policy_store: Optional[NotificationPolicyStore] = None
        # Per-channel bound on one dispatch. Read through ``getattr``
        # like every other knob above so a config field can be added
        # without touching this line; the default is DERIVED from the
        # channels' own httpx budget and never fires on a healthy send.
        # See ``channel_dispatch.CHANNEL_TIMEOUT_SECONDS``.
        self._channel_timeout_s: float = float(
            getattr(
                config,
                "channel_dispatch_timeout_seconds",
                CHANNEL_TIMEOUT_SECONDS,
            )
        )

    def attach_policy_store(self, store: NotificationPolicyStore) -> None:
        """Give the router the durable notification-mute policy to obey.

        Description: MUST be called before ``start()``, because the whole
            point of resolving the policy at boot is that no producer ever
            runs against an unresolved one. Attaching it later would leave
            a window in which a muted session's pushes went out, and the
            user would have no way to know they had.
        Inputs: store (NotificationPolicyStore) - already hydrated, or at
            least attempted. An UNHYDRATED store suppresses every stamped
            event and says so in the log; that is the documented posture
            for "the policy could not be read", never a silent pass.
        Output: None.
        Example: router.attach_policy_store(store)
        """
        self._policy_store = store

    def _policy_allows(self, event: NotificationEvent) -> tuple:
        """Whether the mute policy permits this event, and why.

        Description: the single place both the enqueue and the drain
            consult, so the two can never disagree about what a mute
            means. It is applied TWICE on purpose:

              * at ``emit()``, so a muted session cannot fill the bounded
                queue and evict another session's alerts, and
              * at drain, so an event that was queued while the session
                was noisy is re-judged against the policy as it stands at
                the moment it would actually be SENT. That second check
                is the one the generation exists for.

            AN EVENT STAMPED ``unknown`` IS REFUSED BEFORE THE STORE IS
            EVEN CONSULTED. That stamp means the producer HAD a session
            and could not read its policy, which is a different fact from
            an event that carries no session at all - and only one of them
            may be read as "send it". Folding the two together would let
            an unreadable database deliver the pushes a muted session's
            owner explicitly asked not to receive.

            A router with no policy store attached allows everything.
        Inputs: event (NotificationEvent) - stamped or not.
        Output: (bool, str) - send or not, and the reason. See
            ``src.core.session_notification_policy`` for the vocabulary.
        Example: router._policy_allows(event)  # (True, 'allowed')
        """
        if event.policy_verdict == POLICY_UNKNOWN:
            return False, DISPATCH_REFUSED_POLICY_UNKNOWN
        store = self._policy_store
        if store is None:
            return True, DISPATCH_ALLOWED_UNSTAMPED
        return store.allows_dispatch(
            event.policy_key, event.policy_generation
        )

    async def start(self) -> None:
        """Spawn the background worker task.

        If the topic is empty we log once and DO NOT start the worker -
        the router will silently drop emits (via the ``_topic_warned``
        guard in ``emit``) until the user runs setup_auth.
        """
        if self._worker_task is not None:
            logger.warning("notifications.router_start_idempotent")
            return

        topic = getattr(self._config, "ntfy_topic", "") or ""
        if not topic:
            logger.warning("notifications.topic_missing")
            self._topic_warned = True
            # Still spin up the worker - emit() short-circuits on missing
            # topic. We want the router lifecycle to behave the same so
            # `stop()` is symmetric.

        self._worker_task = asyncio.create_task(
            self._run(), name="notifications.worker"
        )
        logger.info(
            "notifications.router_started",
            queue_maxsize=_QUEUE_MAXSIZE,
            enabled=getattr(self._config, "enabled", False),
            topic_set=bool(topic),
        )

        # Cold-start seed: primes every EventType's last-emit timestamp so
        # any notification storm racing startup (e.g., scrollback replay
        # that slips past the replay guard) gets swallowed by the per-kind
        # cooldown. Defense in depth.
        self.rate_limiter.seed_cold_start()

    async def stop(self) -> None:
        """Cancel the worker and let pending dispatches drain best-effort.

        We give the worker a brief window to finish in-flight sends
        before cancelling; on cancel, any queued events are abandoned
        (notifications are best-effort by contract).
        """
        if self._worker_task is None:
            return
        self._stopped = True
        # Send a sentinel by cancelling - drain semantics aren't worth
        # the complexity for fire-and-forget signals.
        self._worker_task.cancel()
        try:
            await self._worker_task
        except asyncio.CancelledError:
            pass
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("notifications.worker_stop_error", error=str(e))
        self._worker_task = None
        logger.info("notifications.router_stopped")

    def emit(self, event: NotificationEvent) -> None:
        """SYNCHRONOUS, non-blocking enqueue. Safe from PTY callbacks.

        Behavior on a full queue: drop the OLDEST event (consume one
        with ``get_nowait``), log the drop, then re-attempt the put.
        If the second put still fails (race with the worker), log the
        new event as dropped and return - never raise.

        Args:
            event: the typed notification to dispatch.
        """
        # Master enable flag. When false, emit is a strict no-op - no
        # log, no work. The router can still be wired into lifespan
        # cheaply.
        if not getattr(self._config, "enabled", False):
            return

        if self._stopped:
            return

        # v0.7.0 Part 4 - at least one channel must be configured for an
        # emit to be worth queueing. ntfy needs a topic; slack needs a
        # webhook URL; pushover needs BOTH a token and a user key. If
        # ALL are empty/incomplete, drop silently (we already warned at
        # start()).
        has_ntfy = bool(getattr(self._config, "ntfy_topic", ""))
        has_slack = bool(getattr(self._config, "slack_webhook_url", ""))
        has_pushover = bool(
            getattr(self._config, "pushover_token", "")
        ) and bool(getattr(self._config, "pushover_user_key", ""))
        if not (has_ntfy or has_slack or has_pushover):
            return

        # THE MUTE, AT THE DOOR. Refusing here as well as at the drain
        # keeps a muted session from consuming the bounded queue and
        # evicting an alert some OTHER session's user does want. The
        # drain repeats the check because the policy can change while an
        # event waits, and only the check at the moment of sending can
        # see that.
        allowed, reason = self._policy_allows(event)
        if not allowed:
            logger.info(
                "notify.policy_suppressed",
                stage="emit",
                kind=event.kind.value,
                reason=reason,
            )
            return

        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop-oldest strategy: pop one, retry once. We log BOTH
            # the drop and the new enqueue so a queue under sustained
            # pressure is visible in the log stream.
            try:
                dropped = self._queue.get_nowait()
                # task_done so the queue's accounting stays correct;
                # otherwise queue.join() would never resolve.
                self._queue.task_done()
                logger.warning(
                    "notify.dropped",
                    reason="queue_full",
                    dropped_kind=dropped.kind.value,
                )
            except asyncio.QueueEmpty:  # pragma: no cover - race window
                pass
            try:
                self._queue.put_nowait(event)
            except asyncio.QueueFull:
                # Worker is wedged - give up rather than spin.
                logger.warning(
                    "notify.dropped",
                    reason="queue_full_after_evict",
                    new_kind=event.kind.value,
                )

    async def _run(self) -> None:
        """Worker loop: pull, dispatch, mark done. Exits on cancel."""
        logger.info("notifications.worker_running")
        try:
            while True:
                event = await self._queue.get()
                # THE MUTE, AT THE MOMENT OF SENDING, AND THIS IS THE
                # CHECK THAT MATTERS. An event can sit in this queue for
                # an unbounded interval, so the policy it was enqueued
                # under is not necessarily the policy now. Three refusals
                # come out of here and they are different facts:
                #
                #   muted             the user muted the session while
                #                     this waited. Do not send it.
                #   stale_generation  a policy change happened while this
                #                     waited, in EITHER direction. That
                #                     is how a queued alert is stopped
                #                     from escaping a mute, and how an
                #                     unmute is stopped from replaying
                #                     the backlog it was holding.
                #   policy_unknown    the policy has never been read.
                #                     Suppresses, loudly - see
                #                     src/core/session_notification_policy.py
                #                     for why not knowing may not answer
                #                     "not muted" here.
                #
                # BEFORE THE RATE LIMITER, deliberately: a suppressed
                # event must not consume a session's rate-limit budget or
                # move its per-kind cooldown, or muting one session would
                # quietly throttle the notifications of another.
                policy_allowed, policy_reason = self._policy_allows(event)
                if not policy_allowed:
                    logger.info(
                        "notify.policy_suppressed",
                        stage="dispatch",
                        kind=event.kind.value,
                        reason=policy_reason,
                        queued_generation=event.policy_generation,
                    )
                    self._queue.task_done()
                    continue
                # Plan v3.1 Item 8 - rate-limit gate. Suppressed events
                # are logged + dropped; suppression is NOT an error so
                # we still mark the queue item done and move on.
                allowed, reason = self.rate_limiter.check(event)
                if not allowed:
                    logger.info(
                        "notify.suppressed",
                        kind=event.kind.value,
                        session_slug=event.session_slug,
                        reason=reason,
                    )
                    self._queue.task_done()
                    continue
                # ALL CHANNELS AT ONCE, EACH UNDER ITS OWN BOUND. This
                # used to be three sequential awaits, so a channel that
                # accepted the connection and never answered cost its
                # own 5s read timeout AND delayed the other two behind
                # it - and every entry behind THIS one by the sum.
                # ``dispatch_channels`` never raises for a channel-level
                # problem, so one channel failing or hanging can neither
                # cancel its siblings nor take the queue entry with it.
                try:
                    await channel_dispatch.dispatch_channels(
                        event,
                        public_base_url=self._public_base_url,
                        timeout_s=self._channel_timeout_s,
                    )
                except Exception as e:  # pragma: no cover - dispatcher catches
                    # Reachable only if the dispatcher itself broke.
                    # Logged with the event's own context rather than
                    # swallowed, and the entry is still marked done -
                    # a wedged worker would stop every later
                    # notification, which is the worse failure.
                    logger.warning(
                        "notifications.worker_dispatch_error",
                        error=str(e),
                        error_type=type(e).__name__,
                        kind=event.kind.value,
                    )
                finally:
                    # Always mark done so queue.join() in tests resolves.
                    self._queue.task_done()
        except asyncio.CancelledError:
            logger.info("notifications.worker_cancelled")
            raise
