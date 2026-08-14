"""
Claude-config file tree + editor — server-side business logic.

Scope is deliberately narrow: this is a browser/editor for CLAUDE's OWN
config, not a general filesystem browser. Two roots only:

    - "user"    ``~/.claude``            (CLAUDE_HOME, reused from
                                           ``slash_command_discovery`` —
                                           single source of truth for that
                                           path rather than a second
                                           hardcoded ``Path.home()``)
    - "project" ``<project_path>/.claude`` (the active session's working
                                           directory, passed in per call —
                                           there is no server-side
                                           "current project" state)

ALLOWED_TOP_LEVEL_FILES / ALLOWED_TOP_LEVEL_DIRS / HIDE_NAMES /
HIDE_PREFIXES below are the single source of truth for what this feature
shows. Every list/read/write call re-derives its answer from these
constants — nothing is duplicated in the routes layer.

Security posture (the client is assumed hostile, per the API layer):
    - every relative path is resolved with ``Path.resolve()`` and checked
      for containment inside the resolved root before any filesystem call
      touches it (blocks ``../`` traversal AND symlink escapes, since
      resolve() follows symlinks).
    - ``.env*`` and ``.credentials.json`` are refused even if a caller
      guesses the exact relative path — enforcement lives here, not just
      in what the tree listing omits.
    - every write is backed up first (``<name>.bak``, one generation,
      same convention as ``Settings.update_settings_config()``), and a
      ``.json`` write is parsed before it touches disk — a parse failure
      raises and nothing is written.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import structlog

from src.core.slash_command_discovery import CLAUDE_HOME

logger = structlog.get_logger()

# ---- single source of truth: what this feature shows -----------------

ALLOWED_TOP_LEVEL_FILES = frozenset({
    "CLAUDE.md",
    "CONFIGURATION_NOTES.md",
    "settings.json",
    "settings.local.json",
})

ALLOWED_TOP_LEVEL_DIRS = frozenset({
    "hooks",
    "rules",
    "commands",
    "skills",
    "agents",
    "scheduled-tasks",
    "scripts",
    "_scripts",
    "superclaude",
})

# 1075 files / 41MB on record — shown, but collapsed by default and
# read-only. Not part of ALLOWED_TOP_LEVEL_DIRS's "expand freely" set.
READONLY_COLLAPSED_DIRS = frozenset({"plugins"})

# Exact names hidden outright — churn/state, not config. Enforced at the
# listing layer AND at resolve_safe_path() so a client can't reach them
# by guessing the relative path either.
HIDE_NAMES = frozenset({
    "projects",
    "backups",
    "cache",
    "debug",
    "paste-cache",
    "session-env",
    "statsig",
    "todos",
    "shell-snapshots",
    "file-history",
    "history.jsonl",
    "stats-cache.json",
    ".credentials.json",
})

# Prefix match (not exact) — catches .env, .env.local, .env.production, etc.
HIDE_PREFIXES = (".env",)

# Executable file types under hooks/ and scripts/ — code Claude Code RUNS
# automatically, so these get extra handling (marker, mandatory backup —
# already true for everything, mandatory confirm).
EXECUTABLE_EXTENSIONS = frozenset({".py", ".cjs", ".js", ".sh"})
EXECUTABLE_DIRS = frozenset({"hooks", "scripts"})

MAX_READ_BYTES = 2 * 1024 * 1024  # 2MB — a config file bigger than this is not what this editor is for.


class ConfigFileError(ValueError):
    """Raised for any client-caused failure: bad root, disallowed path,
    traversal attempt, hidden file, or oversized read. Routes layer maps
    this to HTTP 400/403 — never a 500, since these are all "the request
    was invalid", not server faults."""


@dataclass
class TreeNode:
    """One entry in the rendered file tree.

    Inputs (fields): name (str) - basename; rel_path (str) - path
      relative to the root, forward-slash separated; is_dir (bool);
      is_executable (bool) - True for a .py/.cjs/.js/.sh file under
      hooks/ or scripts/; read_only (bool) - True for anything under a
      READONLY_COLLAPSED_DIRS root; collapsed (bool) - hint to the
      frontend to render this subtree closed by default; children
      (list[TreeNode]) - populated for directories.
    """
    name: str
    rel_path: str
    is_dir: bool
    is_executable: bool = False
    read_only: bool = False
    collapsed: bool = False
    children: list = field(default_factory=list)


def _is_hidden(name: str) -> bool:
    """
    Description: True if a filesystem entry name matches the hide-list
      (exact name or a hidden prefix like ``.env*``).
    Inputs: name (str) - a single path component (basename).
    Output: bool.
    Example: _is_hidden(".env.local") -> True
    """
    if name in HIDE_NAMES:
        return True
    return any(name.startswith(p) for p in HIDE_PREFIXES)


def resolve_roots(project_path: Optional[str]) -> dict:
    """
    Description: resolve the "user" root always, and the "project" root
      only when a working project_path is given AND it has a ``.claude``
      directory on disk.
    Inputs: project_path (str|None) - absolute path to a project's
      working directory, as tracked by the session (not client-supplied
      free text used directly — callers must have gotten this from a
      real session, never trust it as arbitrary).
    Output: dict[str, Path] - keyed "user" (always present) and
      "project" (present only when applicable).
    """
    roots = {"user": CLAUDE_HOME.resolve()}
    if project_path:
        candidate = (Path(project_path) / ".claude")
        if candidate.is_dir():
            roots["project"] = candidate.resolve()
    return roots


def resolve_safe_path(root_id: str, rel_path: str, project_path: Optional[str]) -> Path:
    """
    Description: turn a client-supplied (root_id, rel_path) pair into a
      verified-contained absolute Path. This is the ONE function every
      read/write call must go through — the security boundary for path
      traversal and the hide-list both live here, not just in what
      list_tree() chooses to enumerate.
    Inputs:
      root_id (str) - "user" or "project".
      rel_path (str) - forward-slash relative path from the tree listing;
        may be "" for the root itself.
      project_path (str|None) - required when root_id == "project".
    Output: Path - resolved, absolute, verified inside the root.
    Raises: ConfigFileError - unknown root, empty rel_path components
      ("..", absolute path smuggled in, etc.), path escapes the root
      after resolve(), any path component is hidden, or (for a
      non-empty rel_path) the top-level component isn't in
      ALLOWED_TOP_LEVEL_FILES/ALLOWED_TOP_LEVEL_DIRS.
    Example: resolve_safe_path("user", "hooks/op-readonly-guard.py", None)
      -> Path("/Users/x/.claude/hooks/op-readonly-guard.py")
    """
    roots = resolve_roots(project_path)
    root = roots.get(root_id)
    if root is None:
        raise ConfigFileError(f"unknown or unavailable root: {root_id}")

    rel_path = (rel_path or "").strip().strip("/")
    if rel_path in ("", "."):
        return root

    parts = rel_path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ConfigFileError("invalid path")

    top = parts[0]
    if top not in ALLOWED_TOP_LEVEL_FILES and top not in ALLOWED_TOP_LEVEL_DIRS and top not in READONLY_COLLAPSED_DIRS:
        raise ConfigFileError(f"'{top}' is not an allowed claude-config entry")

    for p in parts:
        if _is_hidden(p):
            raise ConfigFileError("path refers to a hidden/state entry, not config")

    candidate = (root / Path(*parts)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise ConfigFileError("path escapes the allowed root")

    return candidate


def _classify(root: Path, path: Path) -> tuple:
    """
    Description: compute (is_executable, read_only) for one path relative
      to its root.
    Inputs: root (Path); path (Path) - must be inside root.
    Output: tuple[bool, bool].
    """
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError:
        rel_parts = ()
    top = rel_parts[0] if rel_parts else ""
    read_only = top in READONLY_COLLAPSED_DIRS
    is_executable = (
        path.is_file()
        and path.suffix in EXECUTABLE_EXTENSIONS
        and any(part in EXECUTABLE_DIRS for part in rel_parts[:-1])
    )
    return is_executable, read_only


def _build_node(root: Path, path: Path, depth: int, max_depth: int) -> Optional[TreeNode]:
    """
    Description: recursively build one TreeNode for a path, applying the
      hide-list and (for depth 0, the root's direct children) the
      allow-list. Depth-limited so a pathological directory (or a
      surprise symlink loop) can't hang a request.
    Inputs: root (Path); path (Path); depth (int) - current recursion
      depth; max_depth (int) - hard cap.
    Output: TreeNode|None - None if this path should not be shown at all.
    """
    name = path.name
    if _is_hidden(name):
        return None
    if depth == 0:
        if path.is_dir() and name not in ALLOWED_TOP_LEVEL_DIRS and name not in READONLY_COLLAPSED_DIRS:
            return None
        if path.is_file() and name not in ALLOWED_TOP_LEVEL_FILES:
            return None

    is_executable, read_only = _classify(root, path)
    rel = str(path.relative_to(root)).replace(os.sep, "/")
    collapsed = read_only  # plugins/ (and any future read-only root) starts collapsed.
    node = TreeNode(
        name=name,
        rel_path=rel,
        is_dir=path.is_dir(),
        is_executable=is_executable,
        read_only=read_only,
        collapsed=collapsed,
    )

    if path.is_dir() and depth < max_depth:
        try:
            entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError as exc:
            logger.warning("config_files_listdir_failed", path=str(path), error=str(exc))
            entries = []
        for child in entries:
            child_node = _build_node(root, child, depth + 1, max_depth)
            if child_node is not None:
                node.children.append(child_node)

    return node


def list_tree(root_id: str, project_path: Optional[str], max_depth: int = 6) -> list:
    """
    Description: build the full allow-listed, hide-list-filtered file
      tree for one root.
    Inputs:
      root_id (str) - "user" or "project".
      project_path (str|None) - required for "project".
      max_depth (int) - recursion cap (default 6 — deep enough for
        skills/<name>/SKILL.md, shallow enough to bound one request).
    Output: list[dict] - top-level TreeNode entries, JSON-serializable
      (dataclasses.asdict shape) in the order ALLOWED_TOP_LEVEL_FILES
      then ALLOWED_TOP_LEVEL_DIRS then READONLY_COLLAPSED_DIRS, each
      sorted alphabetically within its group.
    Raises: ConfigFileError - unknown/unavailable root.
    """
    roots = resolve_roots(project_path)
    root = roots.get(root_id)
    if root is None:
        raise ConfigFileError(f"unknown or unavailable root: {root_id}")
    if not root.is_dir():
        return []

    nodes = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError as exc:
        logger.warning("config_files_list_root_failed", path=str(root), error=str(exc))
        return []
    for entry in entries:
        node = _build_node(root, entry, depth=0, max_depth=max_depth)
        if node is not None:
            nodes.append(node)

    def _to_dict(n: TreeNode) -> dict:
        return {
            "name": n.name,
            "rel_path": n.rel_path,
            "is_dir": n.is_dir,
            "is_executable": n.is_executable,
            "read_only": n.read_only,
            "collapsed": n.collapsed,
            "children": [_to_dict(c) for c in n.children],
        }

    return [_to_dict(n) for n in nodes]


def read_file(root_id: str, rel_path: str, project_path: Optional[str]) -> dict:
    """
    Description: read one allow-listed config file's contents.
    Inputs: root_id, rel_path, project_path - see resolve_safe_path().
    Output: dict - {"content": str, "is_executable": bool,
      "read_only": bool, "size": int}.
    Raises: ConfigFileError - invalid path (via resolve_safe_path), not a
      file, too large, or a decode error (binary file).
    Security: caller (routes layer) must never log the returned content.
    """
    roots = resolve_roots(project_path)
    root = roots[root_id] if root_id in roots else None
    path = resolve_safe_path(root_id, rel_path, project_path)
    if not path.is_file():
        raise ConfigFileError("not a file")
    size = path.stat().st_size
    if size > MAX_READ_BYTES:
        raise ConfigFileError(f"file too large to edit here ({size} bytes)")
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise ConfigFileError("file is not text/utf-8 - not editable here")

    is_executable, read_only = _classify(root or path.parent, path)
    return {
        "content": content,
        "is_executable": is_executable,
        "read_only": read_only,
        "size": size,
    }


def write_file(
    root_id: str,
    rel_path: str,
    content: str,
    project_path: Optional[str],
    acknowledge_executable: bool = False,
) -> dict:
    """
    Description: write one allow-listed config file, always backing up
      the previous bytes first (atomic tmp-file + fsync + os.replace,
      same convention as ``Settings.update_settings_config()``).
      ``.json``/``.json``-suffixed files (settings.json,
      settings.local.json) are parsed with ``json.loads`` before
      anything touches disk - a parse failure raises and nothing is
      written. A write to an executable file (see EXECUTABLE_DIRS /
      EXECUTABLE_EXTENSIONS) additionally REQUIRES
      ``acknowledge_executable=True`` - the routes layer only sets this
      after the client's confirm modal returned true; this is the
      server-side half of that confirmation, not just a UI nicety.
    Inputs:
      root_id (str); rel_path (str); project_path (str|None) - see
        resolve_safe_path().
      content (str) - new file contents.
      acknowledge_executable (bool) - must be True to write an
        executable file; ignored (no effect) for non-executable files.
    Output: dict - {"backed_up": bool, "is_executable": bool}.
    Raises: ConfigFileError - invalid/read-only path, malformed JSON for
      a .json file, or an executable write without acknowledgement.
    """
    path = resolve_safe_path(root_id, rel_path, project_path)
    roots = resolve_roots(project_path)
    root = roots[root_id]

    is_executable, read_only = _classify(root, path)
    if read_only:
        raise ConfigFileError("this file is under a read-only root (plugins/)")
    if is_executable and not acknowledge_executable:
        raise ConfigFileError(
            "this file is executed automatically by claude code - "
            "write refused without explicit confirmation"
        )

    if path.suffix == ".json":
        try:
            json.loads(content)
        except json.JSONDecodeError as exc:
            raise ConfigFileError(f"invalid json: {exc.msg} (line {exc.lineno}, col {exc.colno})")

    backed_up = False
    if path.exists():
        try:
            backup_path = path.with_suffix(path.suffix + ".bak")
            backup_path.write_bytes(path.read_bytes())
            backed_up = True
        except OSError as exc:
            logger.warning("config_files_backup_failed", path=str(path), error=str(exc))

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)

    logger.info(
        "config_files_write",
        root=root_id,
        rel_path=rel_path,
        is_executable=is_executable,
        backed_up=backed_up,
        bytes=len(content),
    )
    return {"backed_up": backed_up, "is_executable": is_executable}
