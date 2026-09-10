"""``lifespan`` builds the application through the composition root.

Slice S0 of ``.claude/notes/backend-decomposition-plan.md``. One claim,
measured against a REAL boot rather than against the source text: after
startup, ``app.state.services`` carries the same object graph that
``app.state.session_manager`` does, so a route migrated onto a
collaborator and a route still on the facade cannot disagree.

**A GREP FOR ``build_services`` IN main.py WOULD NOT PROVE THIS.** The
call could be there and its result discarded, or a second
``SessionManager()`` could be constructed further down and win. Booting
the app is the only thing that answers what is actually on ``app.state``.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from src.core.composition import AppServices  # noqa: E402
from src.main import app  # noqa: E402


@pytest.fixture
def booted():
    """One real startup, torn down afterwards.

    Description: goes through the whole ``lifespan``, which is the point.
    Inputs: none.
    Output: the FastAPI app, with startup complete.
    Example: ``def test_x(booted): booted.state.services``
    """
    with TestClient(app):
        yield app


def test_the_services_container_is_on_app_state(booted):
    """``lifespan`` publishes an ``AppServices``, not a bare manager."""
    assert isinstance(booted.state.services, AppServices)


def test_both_app_state_entries_name_the_same_manager(booted):
    """The facade on ``app.state`` is the one the builder made.

    Description: if ``lifespan`` built services and then constructed a
      second manager for ``app.state.session_manager``, every route would
      keep working and every collaborator migrated in a later slice would
      be talking to a different application. That failure is silent by
      construction, so it gets an assertion rather than a convention.
    """
    assert booted.state.session_manager is booted.state.services.session_manager


def test_the_collaborators_on_app_state_are_the_manager_s_own(booted):
    """Identity, then the data leg, on a REAL boot.

    Description: the same both-directions rule the unit tests use. An
      ``is`` check alone has failed to catch a real mutation three times
      in this project.
    """
    services = booted.state.services
    manager = booted.state.session_manager

    assert services.themes is manager._theme_store
    assert services.toasts is manager._toast_inbox

    services.registry.command_counts["ses_booted"] = 4
    assert manager._registry.command_counts["ses_booted"] == 4
    manager._theme_store.pinned_themes["cloude_booted"] = "matrix"
    assert services.themes.pinned_themes["cloude_booted"] == "matrix"
