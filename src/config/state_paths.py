"""Where every durable thing this app owns actually lives.

The state-directory half of ``Settings``, carved out by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. ``Settings`` is the
LOADER - it holds the env-backed fields and the pin cache - and this
module is the typed READER over them, so each function names exactly
which configuration it depends on instead of reaching into a settings
object for whatever it likes.

**THE PIN IS THE POINT OF THIS MODULE.** A name-keyed state file's
location is decided ONCE per process, on the first resolution, and then
sticks. It used to be re-derived from disk on every call, which made the
answer a function of whatever had just happened to the files:
``detach_session`` unlinked the resolved path and saved again, the save
re-resolved, the old location no longer existed, and the whole file
silently MOVED. A user who then downgraded found no session metadata at
all. The cache is passed in rather than held here, because it belongs to
the ``Settings`` instance whose configuration keys it.

**THE STATE DIR RESOLUTION MUST MATCH ``resolve_state_dir()`` IN
``scripts/upgrade_lib/upgrade_rollback_common.sh`` BYTE-FOR-BYTE**, and
``tests/test_state_dir_drift.py`` is what keeps the two from drifting.
"""

from __future__ import annotations

import socket
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from src.config.errors import StateDirUnavailableError

#: One decided location for one state file: where it is, and which of the
#: two candidate directories that is.
StateFilePin = Tuple[Path, str]

#: The keys ``get_state_file_location`` may answer with.
LOCATION_STATE_DIR = "state_dir"
LOCATION_LOG_DIRECTORY = "log_directory"


def allowed_origins(
    override: Optional[str], host: Optional[str], port: int
) -> List[str]:
    """Compute the CORS allowed-origins list.

    Description: an operator override is trusted verbatim; otherwise a
      safe allowlist is built from host and port plus loopback and mDNS
      hostname variants. It NEVER includes ``"*"``, because the CORS
      middleware is wired with ``allow_credentials=True`` and the
      wildcard-with-credentials combination lets any LAN neighbour fire
      credentialed XHRs at the API. When ``host`` is the bind-all
      ``0.0.0.0`` the literal is substituted rather than whitelisted, as
      no browser would ever send it as an ``Origin``.
    Inputs: override (str | None) - the ``ALLOWED_ORIGINS`` value, comma
      separated; host (str | None) - the bind address; port (int).
    Output: list[str] - origins, de-duplicated, order preserved.
    Example: allowed_origins(None, "0.0.0.0", 8000)
    """
    if override:
        parts = [p.strip() for p in override.split(",")]
        return [p for p in parts if p]

    origins: List[str] = []

    # Best-effort hostname lookup. ``socket.gethostname()`` is cheap and
    # doesn't hit DNS; tolerate failure and just skip those entries.
    try:
        hostname = socket.gethostname()
    except OSError:
        hostname = ""
    # Strip any trailing ".local" so we can emit bare-host + .local
    # variants deterministically.
    hostname_bare = hostname[:-6] if hostname.endswith(".local") else hostname

    if host and host != "0.0.0.0":
        origins.append(f"http://{host}:{port}")

    origins.append(f"http://localhost:{port}")
    origins.append(f"http://127.0.0.1:{port}")

    if hostname_bare:
        origins.append(f"http://{hostname_bare}:{port}")
        origins.append(f"http://{hostname_bare}.local:{port}")

    # De-dupe while preserving order.
    seen = set()
    deduped: List[str] = []
    for o in origins:
        if o not in seen:
            seen.add(o)
            deduped.append(o)
    return deduped


def working_dir(configured: str) -> Path:
    """The projects root, expanded and created if absent.

    Inputs: configured (str) - the ``DEFAULT_WORKING_DIR`` value.
    Output: Path - an existing directory.
    """
    path = Path(configured).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_dir(override: Optional[str]) -> Path:
    """Resolve and ensure the application's durable state directory.

    Description: single source of truth for where CloudeCode's durable
      state lives - session_metadata.json, pinned_themes.json,
      unread_state.json, refresh_tokens.db, agent_wrapper_scripts/,
      per-session tmux log files and cloude.db. It replaced an older
      default of putting state under ``log_directory``, whose
      ``.env.example`` default was ``/tmp/cloude-code-logs``, a directory
      macOS purges on every reboot, which is exactly wrong for data the
      user depends on.

      Precedence: the override if set to a non-empty value, trusted
      verbatim after ``~`` expansion; otherwise
      ``~/Library/Application Support/CloudeCode``. That is a DIFFERENT
      directory from ``~/Library/Application Support/cloude-code-menubar/``
      (see ``_resolve_user_themes_dir()`` in ``src/main.py``), which
      belongs to the separate menubar component and holds only
      user-authored theme assets. The two must never be merged.
    Inputs: override (str | None) - the ``CLOUDE_STATE_DIR`` value.
    Output: Path - the resolved, existing, writable state directory.
    Raises:
        StateDirUnavailableError: the directory does not exist and could
            not be created (permission denied, read-only volume, a path
            component that is a plain file). This NEVER silently
            substitutes a temp directory; the caller must treat it as
            fatal and surface it, which is what ``src/main.py`` does.
    Example: state_dir(None)
    """
    if override:
        path = Path(override).expanduser()
    else:
        path = Path.home() / "Library" / "Application Support" / "CloudeCode"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise StateDirUnavailableError(path, exc) from exc
    return path


def state_file_pin(
    filename: str,
    *,
    pins: Dict[tuple, StateFilePin],
    resolved_state_dir: Path,
    state_dir_override: Optional[str],
    log_directory: Optional[str],
) -> StateFilePin:
    """Decide ONCE where one name-keyed state file lives, then keep it.

    Description: the single authority behind :func:`resolve_state_file`
      and :func:`state_file_location`. Everything either of those returns
      comes from here, so no call site ever re-derives it.

      On the first resolution of a filename: present in BOTH locations is
      ambiguous, logged as a warning naming both, and the NEW path wins
      with the old file left on disk and NEVER deleted - the new path
      wins because it is the one this version WRITES to, and preferring
      the old copy would leave the app reading a file it is not updating,
      which is a guaranteed divergence rather than a possible one.
      Present in only one, use that one. Present in neither, use the new
      path, which is where a caller creating it will write.

      The pin is keyed on the CONFIGURED directories, so repointing
      ``CLOUDE_STATE_DIR`` or ``LOG_DIRECTORY`` re-asks the question - a
      different configuration is a different question - while a file
      appearing or disappearing does not.
    Inputs: filename (str) - bare filename, e.g. "pinned_themes.json";
      pins (dict) - the caller's cache, MUTATED here; resolved_state_dir
      (Path) - the answer from :func:`state_dir`; state_dir_override
      (str | None) and log_directory (str | None) - the two configured
      spellings the pin is keyed on.
    Output: tuple[Path, str] - the resolved path and its location, one of
      ``"state_dir"`` or ``"log_directory"``.
    Example: state_file_pin("unread_state.json", pins={}, ...)
    """
    state_key = state_dir_override or ""
    log_key = log_directory or ""
    key = (filename, state_key, log_key)

    pinned = pins.get(key)
    if pinned is not None:
        return pinned

    new_path = resolved_state_dir / filename
    decision: StateFilePin = (new_path, LOCATION_STATE_DIR)
    if log_key:
        old_path = Path(log_key).expanduser() / filename
        new_exists = new_path.exists()
        old_exists = old_path.exists()
        if new_exists and old_exists:
            import structlog
            structlog.get_logger().warning(
                "state_file_present_in_both_locations",
                filename=filename,
                using=str(new_path),
                old_path_retained=str(old_path),
            )
        elif old_exists:
            decision = (old_path, LOCATION_LOG_DIRECTORY)

    pins[key] = decision
    return decision
