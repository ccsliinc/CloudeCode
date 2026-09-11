"""``HookTokenAuthority``: the no-copy proof, and the refusals.

Slice S7 of ``.claude/notes/backend-decomposition-plan.md`` moved the four
pieces of hook-token state off ``SessionManager``. Two classes of claim
are made here and they fail differently.

**THE STATE MOVED, IT DID NOT COPY**, and an identity assertion alone does
not prove that. ``x is y`` has now failed to catch a real mutation five
times in this project - most recently in slice S4, where a method writing
into ``dict(self.sessions)`` left the identity leg perfectly green and was
caught only by reading a write back through the other reference. So the
proof has four legs chosen for THIS data: identity, a FORWARD read, a
DELETION read, and the tmux-name map checked separately, because ``keep``
re-binds a name without touching a secret and a copied name map would look
correct on every token assertion.

**THE SEPARATION OF POWERS IS THE SECURITY PROPERTY.** ``mint`` is the
only writer of a secret, ``keep`` cannot reach one, ``recover`` accepts a
superseded value once and never mints. The negative controls are the
load-bearing half: a recovery that accepted broadly would pass every
positive test perfectly and BE a credential bypass, and that is not a
hypothetical shape - it is the same class of defect as the 4,325 rejected
hooks this machinery exists to recover from.
"""

from __future__ import annotations

import os
import secrets
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_hta_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_hta_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.hook_token_recovery import (
    RECOVERY_ACCEPTED,
    RECOVERY_NO_MATCH,
    RECOVERY_UNAVAILABLE,
)
from src.core.session_manager import SessionManager
from src.core.sessions.hook_token_authority import HookTokenAuthority

SESSION = "ses_probe"
PANE = "cloude_probe"


@pytest.fixture()
def authority(tmp_path: Path) -> HookTokenAuthority:
    """A real authority pointed at a throwaway state directory."""
    return HookTokenAuthority(lambda: tmp_path)


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__``.

    Deliberately NOT a strict double that raises on every other name: the
    point of this file is the token cluster, and a stub that fails on an
    unrelated getter would report a fixture problem as a token problem.
    """

    def __init__(self, state: Path) -> None:
        self._state = state
        self.port = 5001

    def get_state_dir(self) -> Path:
        return self._state

    def get_pinned_themes_path(self) -> Path:
        return self._state / "pinned_themes.json"

    def get_unread_state_path(self) -> Path:
        return self._state / "unread_state.json"

    def get_session_metadata_path(self) -> Path:
        return self._state / "session_metadata.json"

    @property
    def log_directory(self) -> str:
        return str(self._state / "logs")


@pytest.fixture()
def manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A real SessionManager whose state directory is redirected.

    Patched by the ``settings`` NAME inside ``session_manager``, which is
    how the rest of this suite redirects state and exactly why the
    collaborator takes its path as a zero-argument callable: a module that
    imported ``src.config`` itself would not see this and would read and
    WRITE the owner's real token store.
    """
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings", _StubSettings(tmp_path)
    )
    return SessionManager()


# --- Rule A: the state MOVED, on four legs -----------------------------


def test_the_manager_holds_no_second_copy_of_the_token_table(manager):
    """LEG 1, identity. Necessary, and on its own not sufficient."""
    assert isinstance(manager.hook_tokens, HookTokenAuthority)
    for name in (
        "_hook_tokens",
        "_hook_tmux_names",
        "_hook_tokens_durable",
        "_superseded_hook_tokens",
    ):
        assert not hasattr(manager, name), (
            f"SessionManager still carries {name}; the state was copied, "
            "not moved, and the two will disagree the moment one is written"
        )


def test_a_mint_through_the_authority_is_visible_through_the_manager(manager):
    """LEG 2, FORWARD. Write on the collaborator, read through the facade.

    This is the leg S4's failure would have been caught by: a method that
    wrote into a COPY left identity green and the forward read red.
    """
    token = manager.hook_tokens.mint(SESSION, tmux_name=PANE)
    assert manager.hook_tokens.tokens[SESSION] == token
    assert manager.hook_tokens.get(SESSION) == token
    assert manager.hook_tokens.validate(SESSION, token) is True


def test_a_deletion_through_one_reference_is_visible_through_the_other(manager):
    """LEG 3, DELETION. The leg that actually caught S4.

    A write into a copy still leaves the ORIGINAL key present, so a test
    that only ever adds cannot tell the two apart. Removing is what
    separates one table from two.
    """
    table = manager.hook_tokens.tokens
    manager.hook_tokens.mint(SESSION, tmux_name=PANE)
    assert SESSION in table

    table.pop(SESSION)
    assert manager.hook_tokens.get(SESSION) is None
    assert manager.hook_tokens.validate(SESSION, "anything") is False


def test_the_tmux_name_map_is_one_object_too(manager):
    """LEG 4, the OTHER map, checked separately.

    ``keep`` re-binds a name without touching a secret, so a copied name
    map would pass every assertion about tokens while silently losing the
    only durable record of which pane an id was injected into - which is
    what stops the hook route answering 410 after a restart.
    """
    names = manager.hook_tokens.tmux_names
    manager.hook_tokens.mint(SESSION, tmux_name=PANE)
    assert names.get(SESSION) == PANE

    manager.hook_tokens.keep(SESSION, tmux_name="cloude_moved")
    assert names.get(SESSION) == "cloude_moved"
    assert manager.hook_tokens.name_for(SESSION) == "cloude_moved"


# --- the separation of powers ------------------------------------------


def test_keep_does_not_rotate_the_secret(authority):
    """THE RULE THAT ENDED A 4h24m OUTAGE.

    A mint over a running agent revokes a credential that agent cannot be
    handed a replacement for. ``keep`` exists so a re-keyed adoption can
    correct the pane binding without touching the value the process in
    that pane is holding.
    """
    original = authority.mint(SESSION, tmux_name=PANE)
    kept = authority.keep(SESSION, tmux_name="cloude_other")
    assert kept == original
    assert authority.get(SESSION) == original
    assert authority.validate(SESSION, original) is True


def test_keep_refuses_an_id_that_holds_no_token(authority):
    """It reports rather than inventing, so the caller knows to mint."""
    assert authority.keep("ses_never_seen", tmux_name=PANE) is None
    assert authority.get("ses_never_seen") is None


def test_a_mint_replaces_and_remembers_what_it_replaced(authority):
    """The defect and its net, in one place."""
    first = authority.mint(SESSION, tmux_name=PANE)
    second = authority.mint(SESSION, tmux_name=PANE)
    assert first != second
    assert authority.get(SESSION) == second
    assert authority.superseded.size(SESSION) == 1


# --- the negative controls. THESE ARE THE LOAD-BEARING HALF. -----------


def test_a_bogus_token_of_the_right_length_is_refused(authority):
    """A forgery that gets the SHAPE right must still fail.

    A 43-character value is what a real token looks like, so a check that
    only rejected obviously-wrong lengths would pass this suite and refuse
    nothing that matters.
    """
    authority.mint(SESSION, tmux_name=PANE)
    forged = secrets.token_urlsafe(32)
    assert len(forged) == len(authority.get(SESSION))
    assert authority.validate(SESSION, forged) is False


def test_recover_refuses_a_token_this_process_never_minted(authority):
    """THE credential bypass this control exists to prevent.

    A recovery that accepted broadly would pass every positive test
    perfectly. The value below was never minted here, so the answer is a
    refusal that says it SEARCHED and found nothing.
    """
    authority.mint(SESSION, tmux_name=PANE)
    authority.mint(SESSION, tmux_name=PANE)  # supersede one, so the ring is not empty
    outcome = authority.recover(SESSION, "tok_nobody_ever_minted_this_value")
    assert outcome != RECOVERY_ACCEPTED
    assert outcome == RECOVERY_NO_MATCH


def test_recover_refuses_a_superseded_token_against_a_DIFFERENT_pane(authority):
    """One pane, one credential. A token is not portable between panes."""
    first = authority.mint(SESSION, tmux_name=PANE)
    authority.mint(SESSION, tmux_name=PANE)
    # The id moves to another pane. The old token is still in the ring,
    # but it was bound to the pane it was superseded on.
    authority.tmux_names[SESSION] = "cloude_somewhere_else"
    assert authority.recover(SESSION, first) != RECOVERY_ACCEPTED


def test_recover_refuses_when_there_is_nothing_to_search(authority):
    """``unavailable`` is not ``no_match``, and the difference is reported.

    A check that could not run must never read as one that ran and
    cleared, so the two refusals keep different names even though both
    refuse.
    """
    authority.mint("ses_brand_new", tmux_name=PANE)
    assert authority.recover("ses_brand_new", "anything") == RECOVERY_UNAVAILABLE


def test_recover_accepts_once_and_NEVER_MINTS(authority):
    """The whole point: it re-binds to what the agent holds, and stops.

    A recovery that minted would revoke the running agent's credential a
    second time while logging that it had fixed something.
    """
    carried = authority.mint(SESSION, tmux_name=PANE)
    replacement = authority.mint(SESSION, tmux_name=PANE)
    assert authority.get(SESSION) == replacement

    assert authority.recover(SESSION, carried) == RECOVERY_ACCEPTED
    assert authority.get(SESSION) == carried, (
        "recover must re-bind the store to the token the running process "
        "holds; anything else and it minted"
    )
    assert authority.validate(SESSION, carried) is True
    # ONCE. The ring entry is consumed, so a later replay finds nothing.
    assert authority.superseded.size(SESSION) == 0


# --- durability and the garbage collector ------------------------------


def test_an_unreadable_owned_list_keeps_every_token(authority, tmp_path):
    """"I could not find out which sessions are owned" is not "none are".

    Pruning on that reading would delete every token on every start and
    reinstate the exact bug the durable store exists to fix.
    """
    authority.mint(SESSION, tmux_name=PANE)
    (tmp_path / "session_metadata.json").write_text("{ this is not json")
    assert authority.gc() == []
    assert authority.get(SESSION) is not None


def test_the_gc_drops_a_token_whose_pane_is_no_longer_owned(authority, tmp_path):
    """The bound that keeps the store from growing for the install's life."""
    authority.mint(SESSION, tmux_name=PANE)
    authority.mint("ses_still_here", tmux_name="cloude_live")
    (tmp_path / "session_metadata.json").write_text(
        '{"owned_tmux_sessions": ["cloude_live"]}'
    )
    assert authority.gc() == [SESSION]
    assert authority.get(SESSION) is None
    assert authority.get("ses_still_here") is not None


def test_a_token_with_no_recorded_pane_is_kept(authority, tmp_path):
    """What cannot be judged is not discarded; that is the false-green move."""
    authority.mint("ses_no_name")
    (tmp_path / "session_metadata.json").write_text(
        '{"owned_tmux_sessions": ["cloude_live"]}'
    )
    assert authority.gc() == []
    assert authority.get("ses_no_name") is not None


def test_a_token_survives_a_restart(tmp_path):
    """The reason the store is durable at all.

    The same value is baked into the pane's environment at spawn and
    cannot be re-issued to a running agent, so forgetting the table across
    a restart 403s every surviving session forever.
    """
    first = HookTokenAuthority(lambda: tmp_path)
    token = first.mint(SESSION, tmux_name=PANE)

    second = HookTokenAuthority(lambda: tmp_path)
    assert second.get(SESSION) == token
    assert second.name_for(SESSION) == PANE
    assert second.validate(SESSION, token) is True
