"""Hold the rename-retry ordering frames and budgets, durably.

WHY DURABLE AND NOT IN MEMORY. Two facts here have to survive a restart
and they fail in opposite directions if they do not.

The BUDGET is the obvious one: an in-memory counter refills on every
server start, so a permanently unreachable session would be retried five
times per restart forever, which is not a bound. The ORDERING FRAME is
the one that actually forced the decision: it is witnessed when the two
title columns are seen to agree, and on a healthy box that agreement is
observed once and then never again for the life of the name. Lose it on a
restart and every divergent row answers :data:`RETRY_UNORDERED` for ever
after, which would look exactly like the feature working correctly while
it quietly refused everything.

Note this is the opposite call from ``hook_token_recovery``, which is
deliberately memory-only. That module holds SECRETS and its recovery is a
credential decision, so forgetting is the safe direction. This one holds
two strings and two integers about names, and forgetting costs the user
their rename.

THE STORE IS A CACHE FIRST AND A FILE SECOND. ``sync_claude_title`` runs
on every transcript append for every live session, so a read or a write
of this file per pass would put filesystem work on a hot path - the
mistake this codebase has already paid for once with
``PRAGMA integrity_check`` on the version endpoint. The file is therefore
loaded ONCE per process and written ONLY when something actually changed,
which on a healthy box is never after the first agreement is witnessed.

AN UNREADABLE LEDGER FAILS CLOSED. An absent file, a corrupt file and a
state directory that cannot be resolved all yield an EMPTY set of marks,
which makes every divergent row answer :data:`RETRY_UNORDERED` and push
nothing. That is the correct direction: the failure mode of this module
is a rename that stays unsynced, never a name overwritten on no evidence.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Dict, Optional

import structlog

from src.core.claude_rename_retry import RenameMark
from src.core.json_artifact import atomic_write_json, read_json_object

logger = structlog.get_logger(__name__)

#: The subdirectory of the state directory these artifacts live in, in the
#: same ``var``-style shape ``corpus-ingest`` and the integrity verdict
#: already use.
LEDGER_DIRNAME: str = "rename-retry"

#: The file itself.
LEDGER_FILENAME: str = "marks.json"

#: Schema tag on the payload, so a future shape change can be recognised
#: rather than guessed at. An unrecognised version reads as no marks,
#: which fails closed exactly as an unreadable file does.
LEDGER_VERSION: int = 1

#: Hard cap on entries. One entry is four small fields per session row and
#: the sessions table holds under a thousand rows on the largest install
#: measured, so this is roughly half the fleet and cannot grow without
#: bound. Eviction drops the entries with no pending push first, because
#: losing a frame costs a refusal while losing a pending budget costs the
#: bound itself.
MAX_ENTRIES: int = 500

_LOCK = threading.Lock()
_MARKS: Optional[Dict[str, RenameMark]] = None
_LOADED_FROM: Optional[Path] = None


def ledger_path(state_dir: Path) -> Path:
    """Where the marks file sits under a state directory.

    Inputs: state_dir (Path) - as resolved by ``Settings.get_state_dir``.
    Output: Path - ``<state_dir>/rename-retry/marks.json`` (not created).
    Example: ledger_path(Path('/s')) -> Path('/s/rename-retry/marks.json')
    """
    return Path(state_dir) / LEDGER_DIRNAME / LEDGER_FILENAME


def resolve_state_dir() -> Optional[Path]:
    """The app's state directory, or None when it cannot be established.

    Description: tolerant on purpose. A title sync runs on the watcher's
      tick and a settings layer that refuses to load must not raise into
      it; None here simply means the retry has no ledger, which makes
      every row refuse. ``ImportError`` and the settings layer's own
      ``RuntimeError`` subclasses are caught together because from this
      function's point of view they are one fact: no directory could be
      named.
    Inputs: none.
    Output: Path | None.
    Example: resolve_state_dir() -> PosixPath('/Users/x/.../CloudeCode')
    """
    try:
        from src.config import settings

        return Path(settings.get_state_dir())
    except (ImportError, AttributeError, OSError, RuntimeError, ValueError) as exc:
        logger.debug("rename_retry_state_dir_unresolved", error=str(exc))
        return None


def _decode(payload: dict) -> Dict[str, RenameMark]:
    """Turn a read payload into marks, skipping anything malformed.

    Description: a single unreadable entry must not cost the whole
      ledger, so each is decoded on its own and a bad one is dropped.
      Dropping degrades that row to a refusal, which is safe.
    Inputs: payload (dict) - as written by :func:`save_marks`.
    Output: dict[str, RenameMark].
    Example: _decode({'version': 1, 'marks': {}}) -> {}
    """
    if payload.get("version") != LEDGER_VERSION:
        return {}
    raw = payload.get("marks")
    if not isinstance(raw, dict):
        return {}
    marks: Dict[str, RenameMark] = {}
    for key, entry in raw.items():
        if not isinstance(key, str) or not isinstance(entry, dict):
            continue
        agreed = entry.get("agreed_title")
        label = entry.get("attempted_label")
        attempts = entry.get("attempts")
        last = entry.get("last_attempt_at")
        if agreed is not None and not isinstance(agreed, str):
            continue
        if label is not None and not isinstance(label, str):
            continue
        if not isinstance(attempts, int) or attempts < 0:
            continue
        if last is not None and not isinstance(last, (int, float)):
            continue
        marks[key] = RenameMark(
            agreed_title=agreed,
            attempted_label=label,
            attempts=attempts,
            last_attempt_at=float(last) if last is not None else None,
        )
    return marks


def _encode(marks: Dict[str, RenameMark]) -> dict:
    """The payload for a set of marks.

    Inputs: marks (dict[str, RenameMark]).
    Output: dict - JSON-serialisable.
    Example: _encode({})['version'] -> 1
    """
    return {
        "version": LEDGER_VERSION,
        "marks": {
            key: {
                "agreed_title": mark.agreed_title,
                "attempted_label": mark.attempted_label,
                "attempts": int(mark.attempts or 0),
                "last_attempt_at": mark.last_attempt_at,
            }
            for key, mark in marks.items()
        },
    }


def _evict(marks: Dict[str, RenameMark]) -> Dict[str, RenameMark]:
    """Bring a set of marks back under :data:`MAX_ENTRIES`.

    Description: entries with NO pending push go first, oldest attempt
      last, because a dropped ordering frame costs one refusal while a
      dropped budget costs the bound. Returns the input unchanged when it
      already fits, so the common path allocates nothing.
    Inputs: marks (dict[str, RenameMark]).
    Output: dict[str, RenameMark] - at most MAX_ENTRIES entries.
    Example: _evict({}) -> {}
    """
    if len(marks) <= MAX_ENTRIES:
        return marks
    ordered = sorted(
        marks.items(),
        key=lambda item: (
            item[1].attempted_label is not None,
            item[1].last_attempt_at or 0.0,
        ),
        reverse=True,
    )
    return dict(ordered[:MAX_ENTRIES])


def load_marks(state_dir: Optional[Path]) -> Dict[str, RenameMark]:
    """Every mark on disk, memoised for the process.

    Description: reads the file once and serves the cache afterwards. An
      absent, corrupt or unrecognised file, and a state directory that
      could not be named, all answer an EMPTY dict - see the module
      docstring for why that is the safe direction rather than a
      disguised failure. Re-reads when the state directory CHANGES, which
      is what keeps a test's temporary directory from inheriting a cache
      built against a different one.
    Inputs: state_dir (Path | None).
    Output: dict[str, RenameMark] - the live cache; do not mutate.
    Example: load_marks(None) -> {}
    """
    global _MARKS, _LOADED_FROM
    resolved = Path(state_dir) if state_dir is not None else None
    with _LOCK:
        if _MARKS is not None and _LOADED_FROM == resolved:
            return _MARKS
        if resolved is None:
            _MARKS, _LOADED_FROM = {}, None
            return _MARKS
        payload = read_json_object(
            ledger_path(resolved), log_event="rename_retry_ledger_unreadable"
        )
        _MARKS = _decode(payload) if isinstance(payload, dict) else {}
        _LOADED_FROM = resolved
        return _MARKS


def save_mark(
    state_dir: Optional[Path], key: str, mark: RenameMark
) -> bool:
    """Record one row's mark, writing the file only when it changed.

    Description: the cache is updated first so the decision the caller
      just made is visible to the next pass even if the write fails; a
      failed write costs durability across a restart, not correctness
      within this process. A mark identical to the one already held
      writes NOTHING, which is what keeps this off the hot path: on a
      healthy box the agreement is witnessed once and every later pass is
      a comparison in memory.
    Inputs: state_dir (Path | None). key (str) - the row id as a string.
      mark (RenameMark).
    Output: bool - True when the bytes reached disk, False when the write
      was skipped or failed. NOT a claim the cache is unchanged.
    Example: save_mark(None, '1', RenameMark()) -> False
    """
    marks = load_marks(state_dir)
    with _LOCK:
        if marks.get(key) == mark:
            return False
        marks[key] = mark
        trimmed = _evict(marks)
        if trimmed is not marks:
            marks.clear()
            marks.update(trimmed)
        if state_dir is None:
            return False
        payload = _encode(marks)
    return atomic_write_json(
        ledger_path(Path(state_dir)),
        payload,
        log_event="rename_retry_ledger_write_failed",
    )


def mark_for(state_dir: Optional[Path], key: str) -> Optional[RenameMark]:
    """One row's mark, or None when none has ever been recorded.

    Inputs: state_dir (Path | None). key (str) - the row id as a string.
    Output: RenameMark | None.
    Example: mark_for(None, '1') is None -> True
    """
    return load_marks(state_dir).get(key)


def reset_cache() -> None:
    """Drop the in-process cache so the next read hits disk.

    Description: for tests and for a state directory that moves under a
      running process. Not called anywhere in the server: the file has
      exactly one writer and the cache is that writer's own view.
    Inputs: none.
    Output: None.
    Example: reset_cache()
    """
    global _MARKS, _LOADED_FROM
    with _LOCK:
        _MARKS, _LOADED_FROM = None, None
