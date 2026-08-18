"""Read-only access layer for the Claude Code conversation archive.

This module owns two things and nothing else: opening the archive
STRUCTURALLY read-only, and deciding whether it can be reached at all.
Freshness lives in ``src/core/history_freshness.py``, query shapes in ``src/core/history_queries.py``, HTTP shapes in
``src/api/history.py``.

READ-ONLY IS ENFORCED, NOT PROMISED. Five independent mechanisms, because a
convention is not a control:

1. The SQLite file is opened through a URI with ``mode=ro``. The kernel-side
   handle cannot write. ``immutable=1`` would be WRONG here: the archive is
   WAL and the ingestion hooks append to it live, so ``immutable`` would
   hand back stale reads with no error.
2. ``PRAGMA query_only=1`` on every connection, applied from the engine's
   ``connect`` event so a connection created by any code path gets it.
3. The router that consumes this module defines GET handlers only.
4. This engine is built here and cached here. It is a SEPARATE engine from
   anything Cloude Code writes (nothing else in the app uses SQLAlchemy at
   all), so no application ORM session can flush into the archive.
5. ``tests/test_history_readonly.py`` asserts that an INSERT through this
   engine RAISES.

EVERY FAILURE IS A THIRD OUTCOME. "I could not look" is never rendered as
"nothing found". Each way of failing to reach the archive maps to a named
reason (see :data:`REASON_*`) that reaches the caller intact.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from typing import Any, Optional
from urllib.parse import quote

import structlog

from src.config import HistoryConfig, settings

logger = structlog.get_logger()


# --- Reasons an archive read could not be evaluated -------------------------
# These strings are part of the API contract; the client renders a sentence
# per reason. Keep them stable.
REASON_DISABLED = "disabled"
REASON_NOT_CONFIGURED = "db_not_configured"
REASON_DB_MISSING = "db_missing"
REASON_DEPENDENCY_MISSING = "dependency_missing"
REASON_DB_LOCKED = "db_locked"
REASON_DB_UNREADABLE = "db_unreadable"
REASON_FTS_MISSING = "fts_missing"
REASON_INDEX_STALE = "index_stale"
REASON_QUERY_SYNTAX_ERROR = "query_syntax_error"

#: Human sentence per reason. The API returns both: the reason is for code,
#: the message is for the person reading the screen at 2am.
REASON_MESSAGES: dict[str, str] = {
    REASON_DISABLED: (
        "The conversation archive viewer is disabled. Set history.enabled "
        "to true in config.json to turn it on."
    ),
    REASON_NOT_CONFIGURED: (
        "The conversation archive viewer is enabled but history.db_path is "
        "empty, so there is no database to read."
    ),
    REASON_DB_MISSING: (
        "The configured archive database file does not exist on this host."
    ),
    REASON_DEPENDENCY_MISSING: (
        "The archive reader needs the optional sqlalchemy and claude_history "
        "packages, and at least one of them is not installed."
    ),
    REASON_DB_LOCKED: (
        "The archive database could not be read right now; it is locked by "
        "another writer. This is a transient condition, retry."
    ),
    REASON_DB_UNREADABLE: (
        "The archive database exists but could not be opened or queried."
    ),
    REASON_FTS_MISSING: (
        "The archive has no messages_fts full-text index, so search cannot "
        "run. Nothing was searched."
    ),
    REASON_INDEX_STALE: (
        "The archive has not been ingested recently enough to answer "
        "confidently; results would omit an unknown amount of recent work."
    ),
    REASON_QUERY_SYNTAX_ERROR: (
        "The search expression is not valid FTS5 syntax, so no search ran."
    ),
}


class HistoryUnavailable(Exception):
    """Raised when an archive read cannot be evaluated at all.

    Carries the machine-readable ``reason`` and a human ``message`` so the
    API layer can turn it into a third-outcome response without inventing
    either. Never use this for "the query ran and matched nothing"; that is
    a successful evaluation with an empty result.
    """

    def __init__(self, reason: str, message: Optional[str] = None) -> None:
        """Build an unavailability signal.

        Args:
            reason: One of the ``REASON_*`` constants in this module.
            message: Human sentence. Defaults to ``REASON_MESSAGES[reason]``.
        """
        self.reason: str = reason
        self.message: str = message or REASON_MESSAGES.get(
            reason, "The archive could not be read."
        )
        super().__init__(f"{reason}: {self.message}")


# Module-level engine cache. One engine per (db_path) for the process; the
# lock keeps two concurrent first-requests from building two engines.
_engine_lock = threading.Lock()
_engine_cache: dict[str, Any] = {}


def get_history_config() -> HistoryConfig:
    """Read the current ``history`` config block.

    Returns:
        HistoryConfig: the loaded block, or a default (disabled) block when
        the app config cannot be loaded at all. Config failure must never
        be reported as an enabled-and-healthy archive.
    """
    try:
        return settings.load_auth_config().history
    except (FileNotFoundError, ValueError, OSError) as exc:
        logger.warning("history_config_unavailable", error=str(exc))
        return HistoryConfig()


def resolve_db_path(config: HistoryConfig) -> str:
    """Expand and absolutise the configured archive path.

    Args:
        config: the ``history`` config block.

    Returns:
        str: an absolute filesystem path, or "" when nothing is configured.
    """
    raw = (config.db_path or "").strip()
    if not raw:
        return ""
    return os.path.abspath(os.path.expanduser(raw))


def _sqlite_ro_url(db_path: str) -> str:
    """Build the SQLAlchemy URL that opens ``db_path`` read-only.

    ``mode=ro`` is the whole point. ``immutable=1`` is deliberately absent:
    the archive is WAL and written live, and immutable would silently serve
    a pre-WAL snapshot.

    Args:
        db_path: absolute path to the SQLite file.

    Returns:
        str: a ``sqlite:///file:...?mode=ro&uri=true`` URL.
    """
    return f"sqlite:///file:{quote(db_path)}?mode=ro&uri=true"


def build_readonly_engine(db_path: str, busy_timeout_ms: int = 5000) -> Any:
    """Create a read-only SQLAlchemy engine over the archive.

    Args:
        db_path: absolute path to the archive SQLite file.
        busy_timeout_ms: how long a reader waits on a locked database
            before failing. The archive is written live by ingest hooks.

    Returns:
        sqlalchemy.engine.Engine: an engine whose every connection is
        opened ``mode=ro`` and pinned ``PRAGMA query_only=1``.

    Raises:
        HistoryUnavailable: when sqlalchemy is not installed.
    """
    try:
        from sqlalchemy import create_engine, event, text as sa_text
    except ImportError as exc:
        raise HistoryUnavailable(REASON_DEPENDENCY_MISSING, str(exc)) from exc

    engine = create_engine(
        _sqlite_ro_url(db_path),
        future=True,
        # FastAPI runs sync endpoints in a worker thread pool, so a pooled
        # connection legitimately moves between threads.
        connect_args={"check_same_thread": False, "uri": True},
    )

    @event.listens_for(engine, "connect")
    def _pin_readonly(dbapi_connection, _record):  # pragma: no cover - event hook
        """Pin query_only and a busy timeout on every new connection."""
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA query_only=1")
            cursor.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
        finally:
            cursor.close()

    # Prove the handle works and is genuinely read-only before handing it
    # out. A broken engine discovered here becomes a named reason; a broken
    # engine discovered later becomes a 500.
    with engine.connect() as connection:
        only = connection.execute(sa_text("PRAGMA query_only")).scalar()
        if not only:
            engine.dispose()
            raise HistoryUnavailable(
                REASON_DB_UNREADABLE,
                "PRAGMA query_only did not take effect; refusing to serve "
                "reads from a connection that could write.",
            )
    return engine


def get_engine(config: Optional[HistoryConfig] = None) -> Any:
    """Return the cached read-only engine for the configured archive.

    Args:
        config: the ``history`` block. Read from settings when omitted.

    Returns:
        sqlalchemy.engine.Engine: cached per database path.

    Raises:
        HistoryUnavailable: disabled, unconfigured, file missing, optional
            dependency missing, or the database will not open.
    """
    config = config or get_history_config()
    if not config.enabled:
        raise HistoryUnavailable(REASON_DISABLED)

    db_path = resolve_db_path(config)
    if not db_path:
        raise HistoryUnavailable(REASON_NOT_CONFIGURED)
    if not os.path.isfile(db_path):
        raise HistoryUnavailable(
            REASON_DB_MISSING,
            f"{REASON_MESSAGES[REASON_DB_MISSING]} Configured path: {db_path}",
        )

    cached = _engine_cache.get(db_path)
    if cached is not None:
        return cached

    with _engine_lock:
        cached = _engine_cache.get(db_path)
        if cached is not None:
            return cached
        try:
            engine = build_readonly_engine(db_path, config.busy_timeout_ms)
        except sqlite3.OperationalError as exc:
            raise _operational_to_unavailable(exc) from exc
        else:
            _engine_cache[db_path] = engine
            return engine


def reset_engine_cache() -> None:
    """Dispose and forget every cached engine.

    Used by tests and by any future config-reload path so a changed
    ``db_path`` is honoured instead of silently serving the old file.

    Returns:
        None.
    """
    with _engine_lock:
        for engine in _engine_cache.values():
            try:
                engine.dispose()
            except Exception as exc:  # noqa: BLE001 - dispose must never mask a reload
                logger.warning("history_engine_dispose_failed", error=str(exc))
        _engine_cache.clear()


def _operational_to_unavailable(exc: Exception) -> HistoryUnavailable:
    """Classify a SQLite operational error into a named reason.

    Args:
        exc: the exception raised by SQLite or SQLAlchemy.

    Returns:
        HistoryUnavailable: ``db_locked`` for a lock/busy condition,
        ``db_missing`` for a vanished file, ``db_unreadable`` otherwise.
        Deliberately three outcomes rather than one catch-all, because
        "retry in a second" and "your path is wrong" are different answers.
    """
    text_form = str(exc).lower()
    if "locked" in text_form or "busy" in text_form:
        return HistoryUnavailable(REASON_DB_LOCKED, str(exc))
    if "unable to open database" in text_form:
        return HistoryUnavailable(REASON_DB_MISSING, str(exc))
    return HistoryUnavailable(REASON_DB_UNREADABLE, str(exc))


class _ReadOnlyConnection:
    """Context manager yielding an archive ORM session, errors classified.

    Wraps SQLAlchemy's session so callers never have to decide what a raw
    ``OperationalError`` means; it arrives as a ``HistoryUnavailable`` with
    a reason instead.
    """

    def __init__(self, config: HistoryConfig) -> None:
        """Bind to a config block.

        Args:
            config: the ``history`` block.
        """
        self._config = config
        self._session: Any = None

    def __enter__(self) -> Any:
        """Open the session.

        Returns:
            sqlalchemy.orm.Session: bound to the read-only engine.

        Raises:
            HistoryUnavailable: on any failure to reach the archive.
        """
        engine = get_engine(self._config)
        try:
            from sqlalchemy.exc import OperationalError
            from sqlalchemy.orm import Session as OrmSession
        except ImportError as exc:
            raise HistoryUnavailable(REASON_DEPENDENCY_MISSING, str(exc)) from exc
        try:
            self._session = OrmSession(bind=engine, future=True)
        except OperationalError as exc:
            raise _operational_to_unavailable(exc) from exc
        return self._session

    def __exit__(self, exc_type, exc, tb) -> bool:
        """Close the session; never commit, there is nothing to commit."""
        if self._session is not None:
            self._session.close()
        return False


def open_archive(config: Optional[HistoryConfig] = None) -> _ReadOnlyConnection:
    """Open a read-only session against the archive.

    Args:
        config: the ``history`` block. Read from settings when omitted.

    Returns:
        _ReadOnlyConnection: context manager yielding a SQLAlchemy session.

    Example:
        with open_archive() as db:
            db.execute(sa_text("SELECT count(*) FROM sessions")).scalar()
    """
    return _ReadOnlyConnection(config or get_history_config())

def has_fts_index(db: Any) -> bool:
    """Report whether the ``messages_fts`` full-text index exists.

    Args:
        db: an open read-only SQLAlchemy session.

    Returns:
        bool: True when the virtual table is present.
    """
    from sqlalchemy import text as sa_text

    row = db.execute(
        sa_text("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
    ).first()
    return row is not None
