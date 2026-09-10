"""S1: the probe health cluster, and the rule that it moved rather than copied.

Three parts, and they fail for three different reasons on purpose.

PART 1 is the recorder on its own - no doubles at all, because it does no
I/O and calls nothing. The load-bearing one is the three-outcome rule: a
probe that never ran must report "cannot determine" and must NEVER read
as ok.

PART 2 is THE NO-COPY RULE, which is the whole reason this slice exists
and the thing a future slice will get wrong. The state MOVED to the
recorder; ``SessionManager`` must not keep a second copy that can drift.
Because this cluster is four SCALARS rather than a shared dict, an
identity assertion on the VALUES would prove nothing (rebinding an int on
the facade is invisible through any other object, and two equal frozen
dataclasses are never ``is``). So the proof has three legs, and all three
are needed:

  (a) the fields DO NOT EXIST on the facade - you cannot drift from a
      field that is not there;
  (b) the injected recorder IS the object the manager holds, asserted
      with ``is`` on the thing that legitimately has identity;
  (c) delegation is live in BOTH directions - a write on the recorder is
      visible through the facade, AND driving the facade's REAL probe
      path is visible on the recorder. Leg (c) is what catches a facade
      that snapshots the recorder once at construction, which legs (a)
      and (b) would both happily pass.

PART 3 is the contract that may not move: the re-exported name and the
no-argument constructor that 104 test files depend on.

Run with:
    ./venv/bin/python3 -m pytest tests/test_probe_health_recorder.py -v
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
from pathlib import Path

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ph_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ph_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.sessions.probe_health import ProbeHealth, ProbeHealthRecorder
from src.core.tmux_listing import REASON_TIMEOUT, TmuxListing

#: The four scalars this slice moved OFF ``SessionManager``. Named once so
#: the no-copy test and this docstring cannot disagree about the list.
MOVED_FIELDS = (
    "_last_probe_ok",
    "_last_probe_reason",
    "_last_probe_detail",
    "_last_probe_socket",
)


class _ProbeBackend:
    """Stub probe backend answering one canned listing.

    Inputs (constructor): listing (TmuxListing) - what the probe answers.
      socket_name (str | None) - the socket the backend claims to be
      bound to, so the "no socket exposed" case is reachable.
    Output: an object with the methods ``list_attachable_sessions`` calls.
    """

    def __init__(self, listing, socket_name="cloude-test-s1"):
        self._listing = listing
        self.socket_name = socket_name

    def list_attachable_sessions(self, owned_names=None, owned_instances=None):
        """Inputs: owned_names, owned_instances (ignored). Output: TmuxListing."""
        return self._listing

    def list_pane_status_all(self):
        """Inputs: none. Output: TmuxListing."""
        return TmuxListing.answered([])


def _manager_with_probe(monkeypatch, listing, *, recorder=None, socket_name="cloude-test-s1"):
    """A real SessionManager whose probe backend answers a canned listing.

    Description: patches only ``build_backend``, so everything else on the
      real ``list_attachable_sessions`` path runs for real. That matters:
      a test that stubbed the method itself would be asserting its own
      arrangement rather than the code.
    Inputs: monkeypatch. listing (TmuxListing). recorder
      (ProbeHealthRecorder | None) - injected when given. socket_name
      (str | None) - what the probe backend exposes.
    Output: tuple[SessionManager, ProbeHealthRecorder].
    Example: mgr, rec = _manager_with_probe(mp, TmuxListing.answered([]))
    """
    from src.core.session_manager import SessionManager

    monkeypatch.setattr(
        "src.core.session_manager.build_backend",
        lambda *a, **k: _ProbeBackend(listing, socket_name=socket_name),
    )
    rec = recorder if recorder is not None else ProbeHealthRecorder()
    mgr = SessionManager(probe_health=rec)
    return mgr, rec


# ===========================================================================
# PART 1 - the recorder on its own
# ===========================================================================


def test_a_probe_that_never_ran_cannot_determine_and_never_reads_ok():
    """THE THREE-OUTCOME RULE. "Never probed" is its own answer.

    This is the false-green class CLAUDE.md names as the recurring defect:
    a caller that reads "no answer yet" as "healthy" offers RESTART
    against a row it cannot currently confirm is stopped.
    """
    rec = ProbeHealthRecorder()

    assert rec.health.ok is None, "never probed must be None"
    # Said the other two ways round as well, because `is None` alone would
    # still pass if `ok` were made a falsy-but-not-None sentinel.
    assert rec.health.ok is not True, "never probed must NEVER read as ok"
    assert rec.health.ok is not False, "never probed is not a failure either"
    assert rec.health.reason is None
    assert rec.health.detail is None


def test_a_failure_carries_the_listings_reason_and_detail_verbatim():
    """The badge must be able to say WHAT went wrong, not just "unavailable"."""
    rec = ProbeHealthRecorder()

    rec.record_failure(reason=REASON_TIMEOUT, detail="tmux busy")

    assert rec.health.ok is False
    assert rec.health.reason == REASON_TIMEOUT
    assert rec.health.detail == "tmux busy"


def test_a_success_clears_the_previous_failures_reason_and_detail():
    """A recovered probe must not keep rendering the old failure's text."""
    rec = ProbeHealthRecorder()
    rec.record_failure(reason=REASON_TIMEOUT, detail="tmux busy")

    rec.record_success()

    assert rec.health.ok is True
    assert rec.health.reason is None, "a success must not carry a stale reason"
    assert rec.health.detail is None


def test_record_success_cannot_be_handed_a_reason_at_all():
    """THE RULE IS STRUCTURAL, NOT REMEMBERED.

    ``record_success`` takes no arguments, so "a success carrying a stale
    failure reason" is not expressible rather than merely discouraged.
    Asserted on the signature because the docstring saying so is what
    would rot.
    """
    params = list(inspect.signature(ProbeHealthRecorder.record_success).parameters)

    assert params == ["self"], f"record_success must take nothing but self, got {params}"


def test_record_failure_is_keyword_only_so_reason_and_detail_cannot_be_swapped():
    """Two adjacent optional strings are exactly the pair a call site transposes."""
    sig = inspect.signature(ProbeHealthRecorder.record_failure)
    kinds = {
        name: p.kind
        for name, p in sig.parameters.items()
        if name != "self"
    }

    assert kinds == {
        "reason": inspect.Parameter.KEYWORD_ONLY,
        "detail": inspect.Parameter.KEYWORD_ONLY,
    }


def test_the_configured_socket_answers_until_a_probe_binds_one():
    """Before any probe, settings is the only thing that can answer."""
    rec = ProbeHealthRecorder()

    assert rec.socket is None
    assert rec.socket_name(configured="cloude") == "cloude"


def test_the_probed_socket_wins_over_the_configured_one():
    """THE PROBE WINS OVER SETTINGS.

    Writer and reader must stay on one key AND that key must equal
    reality. A row written keyed on the socket the probe saw, then read
    back keyed on what settings claims, is answered from a socket nothing
    was written to and every adopted session reads as external.
    """
    rec = ProbeHealthRecorder()

    rec.record_socket("cloude-pinned")

    assert rec.socket == "cloude-pinned"
    assert rec.socket_name(configured="cloude") == "cloude-pinned"


def test_a_probe_exposing_no_socket_falls_back_to_the_configured_one():
    """A backend without a ``socket_name`` must not blank the key."""
    rec = ProbeHealthRecorder()

    rec.record_socket(None)

    assert rec.socket_name(configured="cloude") == "cloude"


def test_the_socket_is_recorded_independently_of_the_health():
    """A probe that FAILED still bound to a socket, and still describes it."""
    rec = ProbeHealthRecorder()

    rec.record_socket("cloude-pinned")
    rec.record_failure(reason=REASON_TIMEOUT, detail=None)

    assert rec.health.ok is False
    assert rec.socket_name(configured="cloude") == "cloude-pinned"


# ===========================================================================
# PART 2 - THE NO-COPY RULE, in three legs
# ===========================================================================


def test_the_facade_keeps_no_copy_of_the_moved_probe_fields():
    """LEG (a). You cannot drift from a field that does not exist.

    The negative control for this whole slice. A decomposition that leaves
    the old scalars in place beside the recorder passes every value
    assertion in this file and is still wrong, because the two can
    silently disagree from the first write onward.
    """
    from src.core.session_manager import SessionManager

    mgr = SessionManager()

    survivors = [f for f in MOVED_FIELDS if hasattr(mgr, f)]
    assert survivors == [], (
        f"the facade kept its own copy of {survivors}; the state must MOVE, "
        "not copy"
    )


def test_the_injected_recorder_is_the_object_the_manager_holds():
    """LEG (b). ``is``, on the thing that legitimately has identity."""
    from src.core.session_manager import SessionManager

    rec = ProbeHealthRecorder()
    mgr = SessionManager(probe_health=rec)

    assert mgr._probe_health is rec, "the manager must hold the injected object"


def test_a_write_on_the_recorder_is_visible_through_the_facade():
    """LEG (c), recorder to facade. Catches a facade that snapshots."""
    from src.core.session_manager import SessionManager

    rec = ProbeHealthRecorder()
    mgr = SessionManager(probe_health=rec)
    assert mgr.last_probe_health().ok is None

    rec.record_failure(reason=REASON_TIMEOUT, detail="tmux busy")

    health = mgr.last_probe_health()
    assert health.ok is False, "the facade must READ THROUGH, not cache"
    assert health.reason == REASON_TIMEOUT
    assert health.detail == "tmux busy"


def test_a_write_on_the_recorders_socket_is_visible_through_the_facade():
    """LEG (c) again, for the socket half of the cluster.

    ``_tmux_socket_name`` is read by 20-odd call sites across ``src`` and
    was the field with the defensive ``getattr`` on it, so a silent
    regression here would look like "the probe never wins" and nothing
    would raise.
    """
    from src.core.session_manager import SessionManager

    rec = ProbeHealthRecorder()
    mgr = SessionManager(probe_health=rec)

    rec.record_socket("cloude-pinned")

    assert mgr._tmux_socket_name() == "cloude-pinned"
    assert mgr.tmux_socket_name() == "cloude-pinned"


def test_the_real_failed_probe_path_writes_through_to_the_injected_recorder(
    monkeypatch,
):
    """LEG (c), facade to recorder, through the REAL listing method.

    Drives ``list_attachable_sessions`` itself rather than poking the
    recorder, so a facade that kept writing its own scalars would be
    caught here even if it also happened to hold a recorder.
    """
    mgr, rec = _manager_with_probe(
        monkeypatch, TmuxListing.unavailable(REASON_TIMEOUT)
    )
    assert rec.health.ok is None

    listing = mgr.list_attachable_sessions()

    assert listing.ok is False
    assert rec.health.ok is False, "the real probe path must record on the recorder"
    assert rec.health.reason == REASON_TIMEOUT
    assert rec.socket == "cloude-test-s1", "the bound socket must be recorded too"
    assert mgr.last_probe_health() == rec.health


def test_the_real_successful_probe_path_writes_through_to_the_injected_recorder(
    monkeypatch,
):
    """LEG (c) for the success half. An empty tmux server is still a probe."""
    mgr, rec = _manager_with_probe(monkeypatch, TmuxListing.answered([]))
    rec.record_failure(reason=REASON_TIMEOUT, detail="stale")

    listing = mgr.list_attachable_sessions()

    assert listing.ok is True
    assert rec.health.ok is True
    assert rec.health.reason is None, "a success must clear the stale failure"
    assert rec.health.detail is None


# ===========================================================================
# PART 3 - the contract that may not move
# ===========================================================================


def test_probe_health_is_still_importable_from_session_manager():
    """NO CALLER MOVES. The re-export keeps the old spelling resolving.

    ``tests/test_s9_recent_and_pills.py`` and any future reader import the
    name from the facade. It must be the SAME class object, not a
    look-alike, or an isinstance check somewhere would start failing for
    a reason nobody could see.
    """
    from src.core.session_manager import ProbeHealth as ReExported

    assert ReExported is ProbeHealth
    assert ReExported(ok=None).ok is None


def test_session_manager_still_constructs_with_no_arguments():
    """RULE B. 104 test files construct it bare; the signature may not change."""
    from src.core.session_manager import SessionManager

    mgr = SessionManager()

    assert isinstance(mgr.last_probe_health(), ProbeHealth)
    assert mgr.last_probe_health().ok is None


def test_every_collaborator_argument_is_keyword_only_and_optional():
    """A positional optional would let a later slice land in this one's slot."""
    from src.core.session_manager import SessionManager

    sig = inspect.signature(SessionManager.__init__)
    for name, p in sig.parameters.items():
        if name == "self":
            continue
        assert p.kind is inspect.Parameter.KEYWORD_ONLY, f"{name} must be keyword-only"
        assert p.default is not inspect.Parameter.empty, f"{name} must be optional"


def test_list_attachable_sessions_with_socket_names_the_probed_socket(monkeypatch):
    """The adopt path keys its rows on the socket the LISTING came from."""
    mgr, _rec = _manager_with_probe(
        monkeypatch, TmuxListing.unavailable(REASON_TIMEOUT)
    )

    socket, listing = mgr.list_attachable_sessions_with_socket()

    assert socket == "cloude-test-s1"
    assert listing.ok is False
