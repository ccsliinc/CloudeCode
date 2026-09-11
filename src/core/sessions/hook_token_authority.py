"""The hook bearer tokens: who holds one, for which pane, and who may mint.

Slice S7 of ``.claude/notes/backend-decomposition-plan.md``. This module
holds ``HookTokenAuthority``, the single owner of the four pieces of state
that decide whether a Claude Code hook POST is authenticated: the token
per session id, the tmux name each token is bound to, whether the store is
durable, and the bounded ring of tokens this process minted and then
replaced.

**THE INVARIANT IS NOW STRUCTURAL, AND IT COST 4h24m OF DEAD HOOKS.**
tmux copies a pane's environment in at ``new-session`` time and cannot
rewrite a running process, so ``CLOUDECODE_HOOK_TOKEN`` is baked into the
agent the moment it spawns. A mint REPLACES the token the store holds, so
a mint that lands on an id whose agent is already running revokes a
credential that agent can never be handed a replacement for: every hook it
sends afterwards is answered 403, with no retry available from its side
and nothing downstream that reports its own absence. Traced to the
millisecond on 2026-09-08 - a derived-id adopt minted at 16:16:40.633984Z,
the first rejection landed 130 ms later at 16:16:40.763005Z, and 4,325
followed until the owner restarted the pane by hand at 20:40:23Z. The same
id had been ACCEPTED minutes earlier, so it was a rotation and not a
misconfiguration.

Three methods, three powers, and they do not overlap:

* :meth:`mint` is the ONLY writer of a secret. It records what it is about
  to replace, into the superseded ring, before the value is lost.
* :meth:`keep` re-binds a tmux name and CANNOT REACH THE SECRET. It is
  what a re-keyed adoption calls: the id was RECOVERED rather than
  invented, so the running agent is already holding a working credential
  and the only thing that needs correcting is which pane it belongs to.
* :meth:`recover` is the net under both. It accepts a value ONLY if this
  process minted it for THAT id on THAT pane and then superseded it, then
  re-binds the store to what the running process actually holds. **IT
  NEVER MINTS.** Minting is the defect being recovered from, and a
  recovery that minted would revoke the credential a second time while
  every log line read correctly.

**THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST.** A recovery that
accepted broadly would pass every positive test perfectly and would be a
credential bypass. ``RECOVERY_NO_MATCH`` (searched, not found) is kept
apart from ``RECOVERY_UNAVAILABLE`` (nothing to search, or the pane
binding is unknown); both refuse, but only the first says anything about
the token. An id whose tmux name is unknown yields ``unavailable`` and
stays rejected, because not having been able to scope the check is never a
pass.

**IN MEMORY ONLY IS DELIBERATE** for the superseded ring: a mint plus a
restart is not recoverable this way, and the restart already has its own
answer in the durable store this class loads at construction.

**NOTHING HERE IMPORTS ``settings`` OR ``session_manager``**, per the
package rules in ``tests/test_sessions_package_rules.py``. The state
directory arrives as a zero-argument callable resolved at CALL time, the
same shape ``OwnedTmuxLedger`` and ``ThemeStore`` take their paths in and
for the same measured reason: the suite redirects state away from the
owner's real ``~/.cloude-sessions`` by patching the ``settings`` NAME
inside the ``session_manager`` module, and a module that imported
``src.config`` itself would be invisible to every one of those patches and
would read and WRITE the owner's live token store during a plain pytest
run.

NO TOKEN VALUE IS EVER LOGGED, by any path in this file.
"""

from __future__ import annotations

import hmac
import json
import secrets
from pathlib import Path
from typing import Callable, Optional

import structlog

from src.core.hook_token_recovery import (
    RECOVERY_ACCEPTED,
    SupersededHookTokens,
)

logger = structlog.get_logger()

#: Bytes of entropy per token. ``secrets.token_urlsafe(32)`` yields a
#: 43-character string, which is why a forged value of any other length
#: is an unconditional refusal before ``compare_digest`` is reached.
TOKEN_BYTES = 32

#: The file inside the state directory that makes the table durable.
METADATA_FILENAME = "session_metadata.json"

#: The key inside that file holding the names this app created.
OWNED_KEY = "owned_tmux_sessions"


class HookTokenAuthority:
    """Owns the hook token table, its tmux bindings and its superseded ring.

    Description: one instance per ``SessionManager``. Constructing it
      LOADS the durable store, so a session that survived a restart is
      still authenticated; see the module docstring for why that is not
      optional.
    Inputs: ``state_dir`` - a zero-argument callable returning the state
      directory ``Path``, resolved at call time so a test that redirects
      state is obeyed. ``on_drop`` - optional, called with each session id
      the garbage collector drops, so the manager can forget its own
      per-session caches for the same ids under the same rule.
    Output: an instance.
    Example::

        authority = HookTokenAuthority(lambda: settings.get_state_dir())
        token = authority.mint("ses_ab12", tmux_name="cloude_x")
        assert authority.validate("ses_ab12", token)
    """

    def __init__(
        self,
        state_dir: Callable[[], Path],
        *,
        on_drop: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._state_dir = state_dir
        self._on_drop = on_drop
        #: session_id -> bearer token. DURABLE: backed by
        #: ``hook_tokens.json`` in the state dir, because the same value is
        #: baked into each pane's env at spawn and cannot be re-issued to a
        #: running agent.
        self.tokens: dict[str, str] = {}
        #: session_id -> tmux name, persisted beside the token. Surviving a
        #: restart needs BOTH: the token gets a hook past authentication,
        #: this is what says WHICH session it belongs to. Restoring only
        #: the token produces a hook that authenticates, returns 200 and
        #: resolves to nothing - measured, and from the agent's side
        #: indistinguishable from success.
        self.tmux_names: dict[str, str] = {}
        #: False once a read or a write has failed, so "the store is not
        #: durable" is KNOWN rather than merely suffered.
        self.durable: bool = True
        #: Tokens this process minted for an id and then REPLACED.
        self.superseded = SupersededHookTokens()
        self.load()

    # -- durability ------------------------------------------------------

    def load(self) -> None:
        """Rehydrate the token table from disk.

        Description: without this, every agent that survived a restart
          presents a token the server has never heard of and is rejected
          403 forever - silently, because nothing downstream of a hook
          reports its own absence. Never raises: a store that cannot be
          read leaves an empty table and sets ``durable`` False.
        Inputs: none. Output: None.
        """
        try:
            from src.core.hook_tokens import load_tokens

            result = load_tokens(self._state_dir())
            self.tokens = dict(result.tokens)
            self.tmux_names = dict(result.tmux_names)
            self.gc()
            self.durable = result.durable
            if not result.durable:
                logger.warning(
                    "hook_tokens_not_durable",
                    detail=result.detail,
                    note=(
                        "sessions that survive a restart will 403 on every "
                        "hook until they are recreated"
                    ),
                )
            elif result.tokens:
                logger.info("hook_tokens_restored", count=len(result.tokens))
        except Exception as exc:  # noqa: BLE001 - startup must not die here
            self.tokens = {}
            self.tmux_names = {}
            self.durable = False
            logger.warning("hook_tokens_load_threw", error=str(exc))

    def persist(self) -> None:
        """Write the token table out. Never raises, never logs a token.

        Inputs: none. Output: None.
        """
        try:
            from src.core.hook_tokens import save_tokens

            ok, reason = save_tokens(
                self._state_dir(), self.tokens, tmux_names=self.tmux_names
            )
            self.durable = ok
            if not ok:
                logger.warning("hook_tokens_not_persisted", reason=reason)
        except Exception as exc:  # noqa: BLE001 - see docstring
            self.durable = False
            logger.warning("hook_tokens_persist_threw", error=str(exc))

    def gc(self) -> list[str]:
        """Drop stored tokens whose tmux session is no longer owned.

        Description: the token's honest lifetime is "as long as a tmux
          session by that name is still ours". Bounding it that way -
          rather than by whether an id is in the in-memory table - is what
          lets a token survive a restart while still not accumulating for
          the life of the install.

          READS ``session_metadata.json`` DIRECTLY rather than the owned
          ledger, because this runs from construction, before that set is
          rehydrated.

          KNOWN: IT IS ONE RESTART BEHIND. The file is reconciled against
          live tmux LATER in startup, so a session killed since the last
          run is still listed as owned when this reads it, and its token
          survives until the restart after. Measured: after killing four
          sessions the store still held 7 entries; the next restart took
          it to 1. Left as is because the lag errs in the SAFE direction.
          Over-retention keeps a token nothing can present - a dead
          session has no process to send a hook. Over-deletion would
          revoke a LIVE agent that cannot be re-issued one, which is the
          bug this whole store exists to fix.

          AN UNREADABLE OR ABSENT METADATA FILE KEEPS EVERYTHING. "I could
          not find out which sessions are owned" must never be actioned as
          "none are".
        Inputs: none.
        Output: the session ids dropped, so a caller can forget its own
          per-session caches under the same rule. Empty when nothing was
          dropped, including every could-not-determine path.
        """
        if not self.tokens:
            return []
        try:
            meta = self._state_dir() / METADATA_FILENAME
            if not meta.exists():
                return []
            owned = set(json.loads(meta.read_text()).get(OWNED_KEY) or [])
        except (OSError, ValueError) as exc:
            logger.debug("hook_token_gc_skipped", error=str(exc))
            return []
        if not owned:
            return []

        # A token with NO recorded name is kept: it predates schema 2 and
        # cannot be judged, and discarding what cannot be evaluated is the
        # false-green move.
        dead = [sid for sid, name in self.tmux_names.items() if name not in owned]
        if not dead:
            return []
        for sid in dead:
            self.tokens.pop(sid, None)
            self.tmux_names.pop(sid, None)
            # The superseded ring outlives nothing the live token
            # outlives. Dropping it on the same rule keeps the two from
            # disagreeing about whether a session still exists.
            self.superseded.forget(sid)
            if self._on_drop is not None:
                self._on_drop(sid)
        logger.info("hook_tokens_gc", dropped=len(dead))
        self.persist()
        return dead

    # -- the three powers ------------------------------------------------

    def mint(self, session_id: str, tmux_name: Optional[str] = None) -> str:
        """Mint and store a fresh token for ``session_id``. THE ONLY WRITER.

        Description: replaces any existing token for the same id. See the
          module docstring for why that is dangerous over a running agent
          and why the replaced value is remembered here rather than lost.
          The value is NEVER logged.
        Inputs: session_id (str). tmux_name (str | None) - the pane the
          token is being bound to. IT MUST BE PASSED IN, not looked up:
          this is called BEFORE the tmux spawn, because the token has to
          exist to be injected into the pane's environment, so no live
          session table carries this id yet. Measured - the first store
          written without it recorded ``tmux_name: null`` for a session
          whose name was known to its own caller.
        Output: str - the new token.
        Example: ``authority.mint('ses_ab12', tmux_name='cloude_x')``
        """
        # WHAT IS BEING REPLACED IS REMEMBERED BEFORE IT IS LOST.
        previous = self.tokens.get(session_id)
        if previous:
            self.superseded.record(
                session_id,
                previous,
                # THE NAME THE OLD TOKEN WAS BOUND TO, not the one being
                # bound now. The scope rule is one pane, one credential,
                # so a token superseded while the id sat on a different
                # pane must not be recoverable against this one. The
                # argument is only a fallback for an id that had a token
                # and no recorded name (a v1 store entry).
                tmux_name=(self.tmux_names.get(session_id) or tmux_name),
            )
        token = secrets.token_urlsafe(TOKEN_BYTES)
        self.tokens[session_id] = token
        if tmux_name:
            self.tmux_names[session_id] = tmux_name
        self.persist()
        return token

    def keep(self, session_id: str, tmux_name: Optional[str] = None) -> Optional[str]:
        """Re-bind an EXISTING token's tmux name without rotating the token.

        Description: the counterpart to :meth:`mint` for a session whose id
          was RECOVERED rather than invented. IT CANNOT REACH THE SECRET
          and that is the point: the agent running inside an adopted pane
          is holding the old token in its environment with no way to be
          handed a new one, so minting there revokes a working credential
          and every subsequent hook POST answers 403. Idempotent.
        Inputs: session_id (str) - an id that already holds a token.
          tmux_name (str | None) - the live tmux session name to bind.
        Output: str | None - the UNCHANGED stored token, or None when the
          id holds none, in which case nothing was written and the caller
          should mint instead.
        Example: ``authority.keep('ses_ab12', tmux_name='cloude_x')``
        """
        existing = self.tokens.get(session_id)
        if existing is None:
            return None
        if tmux_name:
            self.tmux_names[session_id] = tmux_name
        self.persist()
        return existing

    def recover(self, session_id: str, token: str) -> str:
        """Accept a token this server superseded under a still-running agent.

        Description: the second chance for a hook POST that
          :meth:`validate` has ALREADY rejected, so a healthy hook never
          reaches it. It answers one question: is the presented value a
          token THIS PROCESS minted for THIS id, on THIS pane, and then
          replaced? If so the agent holds it because a mint revoked its
          credential mid-flight with no way to tell it, and the honest
          correction is to re-bind the store to what the running process
          actually holds. Done ONCE: the ring entry is consumed, so the
          next hook from the same agent validates through the ordinary
          path.

          IT NEVER MINTS. Minting is the defect being recovered from.

          The pane binding is a REFUSAL and not a relaxation: an id whose
          tmux name is unknown yields ``unavailable`` and stays rejected.
        Inputs: session_id (str), token (str) - as presented on the hook.
        Output: str - one of the ``RECOVERY_*`` outcomes from
          ``src.core.hook_token_recovery``. Only ``accepted`` authorises
          the caller to treat the request as authenticated.
        Example: ``authority.recover('ses_ab12', presented) == 'accepted'``
        """
        decision = self.superseded.decide(
            session_id,
            token,
            current_tmux_name=self.tmux_names.get(session_id),
        )
        if decision.outcome != RECOVERY_ACCEPTED or not decision.token:
            return decision.outcome

        # CONSUME FIRST. Two duplicate deliveries of the same hook can be
        # in flight at once (hook events are duplicated by design), and
        # ``consume`` returning False is how the second one learns it lost
        # the race. Both are still ACCEPTED - the token is genuine either
        # way - but only the winner re-binds and only the winner logs, so
        # a duplicate cannot produce a second rebind event describing a
        # change that already happened.
        first = self.superseded.consume(session_id, decision.token)
        if first:
            self.tokens[session_id] = decision.token
            self.persist()
            logger.warning(
                "hook_token_rebound_from_superseded",
                session_id=session_id,
                tmux_session=decision.tmux_name,
                note=(
                    "a mint replaced this pane's token while its agent "
                    "was running; the store has been re-bound to the "
                    "token the process actually holds and nothing was "
                    "minted"
                ),
            )
        return RECOVERY_ACCEPTED

    # -- reads -----------------------------------------------------------

    def get(self, session_id: str) -> Optional[str]:
        """Return the active token for ``session_id``, or None.

        Inputs: session_id (str). Output: str | None.
        """
        return self.tokens.get(session_id)

    def token_for_spawn(self, session_id: str) -> str:
        """The token to inject into a pane's environment, minting if absent.

        Description: minted LAZILY on first call so a backend that starts
          before the session is fully registered can still ask. The
          existing token is returned unchanged whenever there is one,
          which is what keeps this off the mint path for a session that
          already has an agent holding a credential.
        Inputs: session_id (str).
        Output: str.
        Example: ``env['CLOUDECODE_HOOK_TOKEN'] = a.token_for_spawn(sid)``
        """
        return self.tokens.get(session_id) or self.mint(session_id)

    def validate(self, session_id: str, token: str) -> bool:
        """Constant-time compare a presented token against the stored one.

        Description: False when the session is unknown, no token has been
          minted, or the value mismatches. ``hmac.compare_digest`` so a
          timing-leak attack cannot enumerate tokens from response-time
          deltas.
        Inputs: session_id (str), token (str).
        Output: bool.
        Example: ``authority.validate('ses_ab12', presented)``
        """
        if not session_id or not token:
            return False
        expected = self.tokens.get(session_id)
        if expected is None:
            return False
        # ``compare_digest`` requires equal-length byte/str inputs. The
        # length check itself is short-circuit, but since token_urlsafe(32)
        # always yields a 43-char string, length-mismatch from a forged
        # input is an unconditional False anyway.
        try:
            return hmac.compare_digest(expected, token)
        except (TypeError, ValueError):
            return False

    def name_for(self, session_id: str) -> Optional[str]:
        """The tmux name a session's token is bound to, or None.

        Inputs: session_id (str). Output: str | None.
        """
        return self.tmux_names.get(session_id)

    def bind_name(self, session_id: str, tmux_name: str) -> None:
        """Record a tmux binding for an id that does not already have one.

        Description: ``setdefault`` semantics on purpose. The boot
          re-adopt pass reverses this map to recover the id injected into
          a pane, so a first sighting may fill a gap and a later one must
          never overwrite a binding the store already holds.
        Inputs: session_id (str), tmux_name (str).
        Output: None.
        Example: ``authority.bind_name('ses_ab12', 'cloude_x')``
        """
        self.tmux_names.setdefault(session_id, tmux_name)
