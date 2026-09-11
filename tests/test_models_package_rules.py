"""The rules that hold for every module under ``src/models/``.

Slice S2 of ``.claude/notes/backend-decomposition-plan.md`` filed 2,495
lines of 75 pydantic classes into a package. It is the safest change in
that document precisely because nothing in it has behaviour, which is
also why it can go wrong SILENTLY: a package split can drop a name, or
define one twice, and the only symptom is an import that resolves to the
wrong object somewhere nobody looked.

Four things are checked here, and they catch four different failures.

1. **The public surface is frozen.** 78 names left the old flat module
   and 78 names must leave the package. A dropped re-export is an
   ``ImportError`` in one route on one machine.
2. **One name, one definition, one object.** A split that COPIES a class
   into two modules leaves both importable and mutually unrecognisable.
   The legs below are chosen for that: an ``is`` check ALONE has failed
   to catch a real mutation four times in this project, so identity is
   backed by a construction that reads the object back through the OTHER
   import path, and by the annotation ``SessionInfo`` resolves.
3. **``SessionInfo`` still has TWO levels.** Reading ``info.id`` returns
   nothing and looks exactly like a backend that sent nothing. It is the
   single most repeated bug in this project (CLAUDE.md, gotcha 1), and a
   package split is the ideal place to flatten it by accident.
4. **No module grows the way the file this replaces grew.**

Run with:
    ./venv/bin/python3 -m pytest tests/test_models_package_rules.py -v
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

import pytest

from src import models

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src" / "models"

#: The guideline from CLAUDE.md's "How we work here", as a number.
MAX_LINES = 500

#: The re-export shim's own budget, from the plan's stopping condition.
MAX_INIT_LINES = 200

#: Every name the flat ``src/models.py`` exported at commit 1cc7046, read
#: off that file with an AST walk before it was split. This list is the
#: contract: a name may be ADDED here when a model is added, and removing
#: one is a deliberate deletion that has to be argued for, not a split
#: that quietly lost something.
PUBLIC_SURFACE = frozenset({
    "AddProviderModelRequest", "AdoptSessionRequest", "AdoptSessionResponse",
    "AgentCommandsUpdate", "AttachableListingStatus", "AttachableSession",
    "AttributionDeclineRequest", "AttributionDeclineResponse", "AuthTokenResponse",
    "BrowseResponse", "CloneProjectRequest", "CommandRequest",
    "ConfigSettingsUpdateRequest", "CreateProjectRequest", "CreateSessionRequest",
    "CreateToastRequest", "DirectoryEntry", "ErrorResponse", "ForkSessionResponse",
    "HealthResponse", "LocalModelsResponse", "LocalServerInfo", "LogEntry",
    "MODEL_ID_PATTERN", "MkdirRequest", "MuteNotificationsRequest",
    "NotificationPolicyResponse", "NotificationSecretsUpdate", "ProjectResponse",
    "ProviderModelsResponse", "RecentSessionsResponse", "RenameSessionRequest",
    "ReplaceTerminalCommandsRequest", "RespawnSessionRequest", "RespawnSessionResponse",
    "RestartPlanPreview", "RestartPreviewOption", "RestartPreviewResponse",
    "RestartSessionResponse", "ServerPrefsUpdate", "Session",
    "SessionAttributionPrompt", "SessionImportStatus", "SessionInfo", "SessionRecord",
    "SessionRenamedMessage", "SessionStats", "SessionStatus", "SetUnreadRequest",
    "SuccessResponse", "TerminalCommandListResponse", "ThemeAudioManifest",
    "ThemeManifest", "Toast", "ToastAckMessage", "ToastNewMessage",
    "ToggleFavoriteCommandRequest", "UnattributedSession", "UpdatePinnedThemeRequest",
    "UpdateProjectRequest", "UpdateThemeRequest", "UploadImageResponse",
    "VerifyTOTPRequest", "WSCommandMessage", "WSErrorMessage",
    "WSLocalServerDetectedMessage", "WSLocalServerLostMessage", "WSLogMessage",
    "WSMessageType", "WSPTYDataMessage", "WSPTYInputMessage", "WSPTYResizeMessage",
    "WSSessionStatusMessage", "WorkspaceUpdate", "WrapperExamplesResponse",
    "WrapperListResponse", "describe_model_id_rejection", "is_valid_model_id",
})

#: Fields that live ONLY on the ``SessionInfo`` wrapper.
WRAPPER_ONLY = frozenset({
    "session", "recent_logs", "local_servers", "stats", "session_backend",
    "session_row_id", "parent_session_id", "label", "agent_family",
    "agent_family_source", "agent_wrapper_label", "initial_scrollback_b64",
    "activity_status", "unread", "created_by_cloude", "startup_gate",
    "notifications_muted", "status_source",
})

#: Fields that live ONLY on the nested ``.session``.
SESSION_ONLY = frozenset({
    "id", "pty_pid", "working_dir", "status", "created_at", "last_activity",
    "agent_type_via_fingerprint", "model",
})

#: Fields that genuinely live on BOTH levels, so a reader has to know
#: which one it wants. Named rather than left out, because "it is on both"
#: is the fact, and a test that only listed the exclusive sets would let a
#: field silently join or leave this one.
BOTH_LEVELS = frozenset({"agent_type", "pinned_theme", "tmux_session"})


def _package_modules() -> list[Path]:
    """Every Python module in the models package.

    Description: sorted so a failure names files in a stable order.
      ``__init__.py`` is included; it has its own tighter budget below and
      is checked against both.
    Inputs: none.
    Output: list[Path], never empty (see the guard test).
    """
    return sorted(PACKAGE.glob("*.py"))


def _defined_names(module: Path) -> set[str]:
    """The top-level names a module DEFINES, ignoring what it imports.

    Description: an import is how a sibling's class is reached; a
      ``ClassDef`` is a definition. Only the second kind may be duplicated
      across modules, which is what the duplication test asks about.
    Inputs: module (Path) - a file inside the package.
    Output: set[str] of class, function and assignment target names.
    Example: ``_defined_names(PACKAGE / "sessions.py")`` contains
      ``"Session"`` and not ``"Toast"``.
    """
    tree = ast.parse(module.read_text())
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            out.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.add(node.target.id)
    return out


def test_the_package_exists_and_holds_modules():
    """An empty glob would make every parametrised test below vacuous."""
    modules = _package_modules()
    assert len(modules) > 2, f"expected a package, found {modules}"
    assert (PACKAGE / "__init__.py").exists()
    assert not (ROOT / "src" / "models.py").exists(), (
        "src/models.py still exists beside src/models/. A module and a "
        "package of one name is a dual path, and which one wins depends "
        "on the finder rather than on anything a reader can see."
    )


def test_every_public_name_the_flat_module_exported_still_resolves():
    """The frozen surface, name by name, through the package root."""
    missing = sorted(n for n in PUBLIC_SURFACE if not hasattr(models, n))
    assert not missing, f"names lost in the split: {missing}"


def test_the_declared_all_is_exactly_the_frozen_surface():
    """``__all__`` is the contract, so it may not drift from it silently."""
    assert set(models.__all__) == PUBLIC_SURFACE
    assert len(models.__all__) == len(PUBLIC_SURFACE), "duplicate in __all__"


@pytest.mark.parametrize("name", sorted(PUBLIC_SURFACE))
def test_each_public_name_is_defined_in_exactly_one_module(name: str):
    """One definition, so there is no second copy to diverge from.

    A split that pasted a class into two modules leaves both importable
    and NOT the same object, and every ``isinstance`` across that seam
    answers False for reasons no traceback explains.
    """
    owners = [m.name for m in _package_modules()
              if m.name != "__init__.py" and name in _defined_names(m)]
    assert len(owners) == 1, f"{name} defined in {owners or 'no module'}"


@pytest.mark.parametrize("name", sorted(PUBLIC_SURFACE))
def test_the_re_export_is_the_same_object_the_module_defines(name: str):
    """Identity leg: the root name and the module name are one object."""
    owner = next(m for m in _package_modules()
                 if m.name != "__init__.py" and name in _defined_names(m))
    submodule = importlib.import_module(f"src.models.{owner.stem}")
    assert getattr(models, name) is getattr(submodule, name)


def test_a_session_built_through_the_module_is_the_root_class():
    """Data leg, forward: construct through one path, read through the other.

    This is the leg an ``is`` check does not give. A root name rebound to
    a SUBCLASS of the real model passes ``issubclass`` and passes a
    ``isinstance(root_instance, module_class)`` check in the OTHER
    direction, and fails only here.
    """
    from src.models import sessions as sessions_module

    built = sessions_module.Session(id="ses_1", working_dir="/tmp/x")
    assert isinstance(built, models.Session)
    assert type(built) is models.Session


def test_a_session_built_through_the_root_is_the_module_class():
    """Data leg, reverse. One direction of data flow is not enough.

    Measured in slice S1: a property that returned a COPY left both the
    identity leg and the forward data leg green, and only the reverse
    direction went red.
    """
    from src.models import sessions as sessions_module

    built = models.Session(id="ses_1", working_dir="/tmp/x")
    assert isinstance(built, sessions_module.Session)
    assert type(built) is sessions_module.Session


def test_the_nested_session_survives_validation_as_the_same_class():
    """Data leg through pydantic, which is what actually re-materialises.

    ``SessionInfo`` validates its ``session`` field against whatever class
    its annotation resolves to. If the annotation points at a COPY,
    pydantic silently rebuilds the object as that copy and hands it back,
    so the value looks right and its identity is wrong. Assert the class
    that comes OUT, not the one that went in.
    """
    from src.models import sessions as sessions_module

    info = models.SessionInfo(
        session=sessions_module.Session(id="ses_1", working_dir="/tmp/x")
    )
    assert type(info.session) is models.Session
    assert models.SessionInfo.model_fields["session"].annotation is models.Session


def test_session_info_still_puts_its_fields_on_two_levels():
    """The trap the plan names for this slice, asserted in both directions.

    A flatten in either direction is silent: reading a field off the level
    it is not on returns nothing and reads exactly like a backend that
    sent nothing.
    """
    wrapper = set(models.SessionInfo.model_fields)
    nested = set(models.Session.model_fields)

    assert WRAPPER_ONLY <= wrapper, f"left the wrapper: {sorted(WRAPPER_ONLY - wrapper)}"
    assert not (WRAPPER_ONLY & nested), (
        f"flattened DOWN onto Session: {sorted(WRAPPER_ONLY & nested)}"
    )
    assert SESSION_ONLY <= nested, f"left Session: {sorted(SESSION_ONLY - nested)}"
    assert not (SESSION_ONLY & wrapper), (
        f"flattened UP onto SessionInfo: {sorted(SESSION_ONLY & wrapper)}"
    )
    assert BOTH_LEVELS <= wrapper and BOTH_LEVELS <= nested, (
        "a field that was on both levels is now on one"
    )


@pytest.mark.parametrize("module", _package_modules(), ids=lambda p: p.name)
def test_no_module_exceeds_the_line_guideline(module: Path):
    """The file this package replaces reached 2,495 lines unopposed."""
    count = len(module.read_text().splitlines())
    assert count <= MAX_LINES, f"{module.name} is {count} lines"


def test_the_re_export_shim_stays_a_shim():
    """The plan's stopping condition for this file, as a number."""
    count = len((PACKAGE / "__init__.py").read_text().splitlines())
    assert count <= MAX_INIT_LINES, f"__init__.py is {count} lines"


@pytest.mark.parametrize("module", _package_modules(), ids=lambda p: p.name)
def test_no_module_imports_the_package_root(module: Path):
    """A submodule reaching back through ``src.models`` is a cycle.

    It resolves at runtime whenever the root happens to be imported
    first, so the design rots with a green suite.
    """
    if module.name == "__init__.py":
        pytest.skip("the root is allowed to be the root")
    tree = ast.parse(module.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert node.module != "src.models", f"{module.name} imports the root"
            assert not (node.level == 1 and node.module is None), (
                f"{module.name} does a bare relative import of the package"
            )
        elif isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name != "src.models", f"{module.name} imports the root"
