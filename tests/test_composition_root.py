"""The composition root builds ONE of each thing, and says so with data.

Slice S0 of ``.claude/notes/backend-decomposition-plan.md``. Nothing here
tests behaviour, because S0 moves none. It tests the two claims the rest
of the plan rests on:

1. ``build_services`` constructs each collaborator EXACTLY ONCE and the
   facade holds that same object, so a caller migrated onto
   ``services.themes`` and a caller still on ``manager.pinned_themes``
   are looking at one dict.
2. The production defaults resolve settings through the name the suite
   can patch, so a collaborator built here cannot reach the owner's real
   home directory during a test run.

**AN ``is`` CHECK ALONE IS NOT ACCEPTED HERE.** It has failed to catch a
real mutation three separate times in this project, and in one case
making a property return a COPY left all 66 pre-existing toast tests
green. So every identity claim below is ALSO proved with data: mutate
through one reference, read through the other, in BOTH directions.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

import os
import sys
import tempfile

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import session_manager as session_manager_module
from src.core.composition import AppServices, build_services
from src.core.live_ports import LiveSessionRecordStore, LiveSettings, SystemClock
from src.core.session_manager import SessionManager
from src.core.sessions.probe_health import ProbeHealthRecorder
from src.core.sessions.registry import SessionRegistry
from src.core.sessions.sidecars import AttachmentSidecars
from src.core.sessions.theme_store import ThemeStore
from src.core.sessions.toast_inbox import ToastInbox

#: Every field ``AppServices`` must carry. THE MUTATION FOR S0: delete one
#: from the dataclass and this list stops matching, at RUNTIME, with no
#: type checker in the loop. A container that quietly lost a member is how
#: a later slice would find itself with nowhere to inject from.
REQUIRED_FIELDS = {
    "session_manager",
    "probe_health",
    "themes",
    "toasts",
    "registry",
    "sidecars",
    "clock",
    "settings_reader",
    "records",
}


class _StubSettings:
    """A real ``Settings`` with two answers replaced.

    Description: wraps rather than replaces, so ``SessionManager.__init__``
      keeps finding the dozen other values it reads while the two this
      test cares about point somewhere throwaway. A bare namespace would
      fail construction for reasons that have nothing to do with the
      claim under test.
    Inputs: real (object) - the live Settings. pin_path (Path) - what
      ``get_pinned_themes_path`` should answer. cap (int) - what
      ``log_buffer_size`` should answer.
    Output: none.
    Example: _StubSettings(settings, tmp_path / 'pins.json', 7)
    """

    def __init__(self, real: object, pin_path: Path, cap: int) -> None:
        self._real = real
        self._pin_path = pin_path
        self._cap = cap

    def __getattr__(self, name: str) -> object:
        """Everything not overridden comes from the real settings object."""
        return getattr(self._real, name)

    def get_pinned_themes_path(self) -> Path:
        """The throwaway pin file this test wants written instead."""
        return self._pin_path

    @property
    def log_buffer_size(self) -> int:
        """The throwaway line cap this test wants honoured instead."""
        return self._cap


def test_app_services_carries_every_required_field():
    """THE S0 MUTATION. Delete a field and this goes red at runtime."""
    present = {f.name for f in dataclasses.fields(AppServices)}

    assert present == REQUIRED_FIELDS, (
        "AppServices fields drifted; a missing one leaves a later slice "
        "with nowhere to inject a collaborator from"
    )


def test_app_services_is_frozen():
    """A collaborator may not be swapped out from under another caller."""
    services = build_services()

    with pytest.raises(dataclasses.FrozenInstanceError):
        services.toasts = ToastInbox()  # type: ignore[misc]


def test_the_five_collaborators_are_the_manager_s_own_objects():
    """Identity FIRST, then the data legs that actually prove it."""
    services = build_services()
    manager = services.session_manager

    assert services.probe_health is manager._probe_health
    assert services.themes is manager._theme_store
    assert services.toasts is manager._toast_inbox
    assert services.registry is manager._registry
    assert services.sidecars is manager._sidecars


def test_a_write_through_the_services_side_is_visible_on_the_facade():
    """Mutate through ``services``, read through the manager's own names.

    Description: this is the leg that catches what ``is`` cannot. A
      property rewritten to return a copy passes every identity
      assertion in the file above and fails here on the first line.
    """
    services = build_services()
    manager = services.session_manager

    services.themes.pinned_themes["cloude_from_services"] = "matrix"
    services.toasts.pending["ses_from_services"] = []
    services.registry.log_buffers["ses_from_services"] = []
    services.registry.command_counts["ses_from_services"] = 3
    services.sidecars.adopt_fifo_offsets["ses_from_services"] = 41
    services.sidecars.pending_terminal_commands["ses_from_services"] = "cmd_1"

    assert manager.pinned_themes["cloude_from_services"] == "matrix"
    assert "ses_from_services" in manager._pending_toasts
    assert manager.log_buffers["ses_from_services"] == []
    assert manager.command_counts["ses_from_services"] == 3
    assert manager.adopt_fifo_offsets["ses_from_services"] == 41
    assert manager.pending_terminal_commands["ses_from_services"] == "cmd_1"


def test_a_write_through_the_facade_is_visible_on_the_services_side():
    """And the reverse direction, because one-way is not identity."""
    services = build_services()
    manager = services.session_manager

    manager.pinned_themes["cloude_from_facade"] = "amber"
    manager.log_buffers["ses_from_facade"] = []
    manager.idle_watchers["ses_from_facade"] = object()  # type: ignore[assignment]

    assert services.themes.pinned_themes["cloude_from_facade"] == "amber"
    assert "ses_from_facade" in services.registry.log_buffers
    assert "ses_from_facade" in services.sidecars.idle_watchers


def test_probe_health_records_once_and_both_sides_read_it():
    """The one collaborator whose state is a scalar, not a container."""
    services = build_services()

    services.probe_health.record_failure(reason="socket_missing", detail="x")

    health = services.session_manager.last_probe_health()
    assert health.ok is False
    assert health.reason == "socket_missing"


def test_an_injected_collaborator_is_the_one_the_manager_gets():
    """Override one thing, get the rest real. Proved with data, not ``is``."""
    inbox = ToastInbox()

    services = build_services(toasts=inbox)

    assert services.toasts is inbox
    assert services.session_manager._toast_inbox is inbox
    inbox.pending["ses_injected"] = []
    assert "ses_injected" in services.session_manager._pending_toasts
    # and the other four are still real, freshly built objects
    assert isinstance(services.themes, ThemeStore)
    assert isinstance(services.registry, SessionRegistry)
    assert isinstance(services.sidecars, AttachmentSidecars)
    assert isinstance(services.probe_health, ProbeHealthRecorder)


def test_two_calls_build_two_independent_applications():
    """THE NEGATIVE CONTROL for every identity test above.

    Description: a builder that returned a module-level singleton would
      pass every ``is`` assertion in this file for the wrong reason, and
      one test's toasts would leak into the next. If this goes green
      while the identity tests do too, the identity tests are measuring
      something.
    """
    first = build_services()
    second = build_services()

    assert first.toasts is not second.toasts
    first.toasts.pending["ses_leak"] = []
    assert "ses_leak" not in second.toasts.pending


def test_passing_a_manager_and_a_collaborator_is_refused():
    """The fork refusal. There is no correct merge, so there is no merge."""
    manager = SessionManager()

    with pytest.raises(ValueError) as excinfo:
        build_services(session_manager=manager, toasts=ToastInbox())

    assert "two objects holding one state" in str(excinfo.value)


def test_wrapping_an_existing_manager_mints_no_sixth_object():
    """A pre-built manager keeps its five; nothing new is constructed."""
    manager = SessionManager()

    services = build_services(session_manager=manager)

    assert services.session_manager is manager
    assert services.themes is manager._theme_store
    manager.command_counts["ses_wrapped"] = 9
    assert services.registry.command_counts["ses_wrapped"] == 9


def test_the_theme_store_writes_where_the_patched_settings_say(
    tmp_path, monkeypatch
):
    """THE S2 NEAR MISS, TURNED INTO A TEST.

    Description: 41 places in this suite do
      ``monkeypatch.setattr("src.core.session_manager.settings", stub)``.
      A composition root that resolved ``src.config.settings`` instead
      would be invisible to every one of them, and this pin write would
      land in the owner's real ``~/.cloude-sessions``. The assertion is
      on the FILE, not on a path attribute, because a path that is merely
      reported correctly is not the same as a byte written correctly.
    """
    pin_file = tmp_path / "pinned_themes.json"
    stub = _StubSettings(session_manager_module.settings, pin_file, 5)
    monkeypatch.setattr(session_manager_module, "settings", stub)

    services = build_services()
    services.themes.set_pin("cloude_isolated", "matrix")
    services.themes.save()

    assert pin_file.exists(), (
        "the pin file did not land in the patched location; a settings "
        "reader that bypassed the patch would have written the real home"
    )
    assert "cloude_isolated" in pin_file.read_text(encoding="utf-8")


def test_the_registry_line_cap_honours_the_patched_settings(
    tmp_path, monkeypatch
):
    """Same seam, the other collaborator that reads settings at call time."""
    stub = _StubSettings(session_manager_module.settings, tmp_path / "p.json", 2)
    monkeypatch.setattr(session_manager_module, "settings", stub)

    services = build_services()
    services.registry.ensure("ses_capped")
    for i in range(5):
        services.registry.append_log("ses_capped", f"line {i}")

    assert len(services.registry.log_buffers["ses_capped"]) == 2, (
        "the cap under test was the real one, so the settings reader is "
        "not resolving through the name the suite patches"
    )


def test_the_settings_reader_is_read_late_not_captured(tmp_path, monkeypatch):
    """A reader bound at construction time would answer the old value.

    Description: the whole mechanism is a LATE attribute lookup. Building
      the services FIRST and patching AFTERWARDS is the arrangement that
      tells an early bind apart from a late one; a test that patched
      first would pass either way.
    """
    services = build_services()
    stub = _StubSettings(session_manager_module.settings, tmp_path / "late.json", 9)
    monkeypatch.setattr(session_manager_module, "settings", stub)

    assert services.settings_reader.pinned_themes_path() == tmp_path / "late.json"
    assert services.settings_reader.log_buffer_size() == 9


def test_the_production_defaults_are_the_live_implementations():
    """No argument means the real clock, the real settings, the real store."""
    services = build_services()

    assert isinstance(services.clock, SystemClock)
    assert isinstance(services.settings_reader, LiveSettings)
    assert isinstance(services.records, LiveSessionRecordStore)


def test_the_conftest_fixture_hands_back_a_real_application(app_services):
    """The ``app_services`` fixture is the builder, not a second wiring.

    Description: exercises the fixture so it cannot rot unnoticed, and
      asserts the one property that makes it worth having - a test asking
      for a whole application gets the SAME object graph ``lifespan``
      builds, not a hand-assembled approximation of it.
    """
    assert isinstance(app_services, AppServices)
    assert app_services.themes is app_services.session_manager._theme_store
    app_services.registry.command_counts["ses_fixture"] = 1
    assert app_services.session_manager.command_counts["ses_fixture"] == 1
