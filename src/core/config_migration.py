"""One-shot, idempotent config.json migration: hardcoded cld/cldor -> wrappers.

feat/launch-wrappers — introduces ``config_version`` (absent from every
prior config.json; treated as ``0``) and migrates a pre-wrappers config to
the wrapper shape described in ``src/core/agent_wrappers.py``, WITHOUT ever
touching or removing the legacy ``agents.claude_command`` /
``codex_command`` / ``hermes_command`` / ``openclaw_command`` keys — those
remain permanently supported by ``Settings.get_agent_command`` as the
fallback path for anyone who never adopts wrappers.

Design constraints (all load-bearing — see CLAUDE.md's doc-protocol and the
task brief this module was written against):

1. NEVER destructive. ``migrate_config_file`` backs up the pre-write bytes
   to ``config.json.bak`` (reusing the exact tmp-file + fsync + os.replace
   convention ``Settings.update_settings_config`` already uses — no second
   atomic-write convention introduced) before writing anything.
2. Idempotent. A config already at ``config_version >= CURRENT_CONFIG_VERSION``
   is returned completely unchanged (``changed=False``); running the
   migration twice in a row is a no-op the second time.
3. Environment-aware. ``probe_shell_function`` shells out to ``zsh -ic
   'type <name>'`` to check whether ``cld`` / ``cldor`` actually resolve in
   THIS user's interactive shell — mirrors exactly the resolution tmux's
   spawned pane needs (see ``Settings.get_agent_command``'s docstring on
   why ``zsh -c 'source ~/.zshrc; ...'`` is required at all). Only seeds a
   wrapper for a function that was actually detected; never guesses.
4. Fail-safe. ``migrate_config_dict`` is a pure function: any input it
   can't confidently interpret (malformed ``agents`` block, unexpected
   type) makes it return the ORIGINAL data completely unchanged with
   ``changed=False`` and, critically, ``config_version`` NOT stamped — so
   a future run (e.g. after the user fixes their config.json by hand) can
   still retry the migration instead of being permanently skipped by a
   half-written version marker.

Rollback: restore ``config.json`` from ``config.json.bak`` (see
``migrate_config_file``'s docstring for the exact command). The code-level
rollback point is git tag ``baseline/adoom-2026-08-14`` (commit 6392124) —
`git checkout baseline/adoom-2026-08-14 -- src/` restores the pre-wrappers
resolver entirely if a config-level rollback isn't enough. See also the
README section "rolling back the launch-wrappers migration".
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger()

# Bump when the migration shape changes. 0 = no config_version key present
# at all (every config.json that predates this feature).
CURRENT_CONFIG_VERSION = 1

# Thin, migration-seeded wrapper scripts. Deliberately NOT the real
# multi-line cld/cldor function bodies (those live only in the user's own
# ~/.zshrc, which we don't read or copy) — each one-liner simply forwards
# to the already-defined shell function, exactly matching what the old
# hardcoded ``zsh -ic 'cld'`` / ``zsh -ic 'cldor <model>'`` fallback did.
# `entry` is left unset: the line IS the runnable command (see
# agent_wrappers.render_wrapper_invocation's source-only mode).
_SEED_SCRIPT_CLD = 'cld "$@"'
_SEED_SCRIPT_CLDOR = 'cldor "$@"'


def probe_shell_function(
    name: str, runner: Optional[Callable[[List[str]], subprocess.CompletedProcess]] = None
) -> bool:
    """Check whether a zsh function/command named ``name`` resolves.

    Description: runs ``zsh -ic 'type <name>'`` (interactive shell, so
      ``~/.zshrc`` is sourced — same requirement tmux's own spawned pane
      has, see module docstring point 3) and treats exit code 0 as
      "resolves". Never raises — a missing ``zsh`` binary, a timeout, or
      any subprocess error is treated as "not found" (fail toward NOT
      seeding rather than guessing).
    Inputs:
      name (str) - function/command name to probe, e.g. "cld".
      runner (callable | None) - injected for tests; defaults to
        ``subprocess.run``. Signature: ``(argv: list[str]) ->
        subprocess.CompletedProcess``.
    Output: bool - True if the shell reports it resolves.
    Example: probe_shell_function("cld") -> True on a machine whose
      ~/.zshrc defines a `cld` function; False on one that doesn't.
    """
    run = runner or (
        lambda argv: subprocess.run(argv, capture_output=True, timeout=10)
    )
    try:
        result = run(["zsh", "-ic", f"type {name}"])
        return result.returncode == 0
    except Exception as e:
        logger.warning("probe_shell_function_failed", name=name, error=str(e))
        return False


def build_seed_wrappers(has_cld: bool, has_cldor: bool) -> List[Dict]:
    """Build the list of wrapper dicts to seed from environment detection.

    Description: a plain "claude" wrapper (the safe, universal default —
      marked ``default: true`` so a freshly migrated config with NEITHER
      cld nor cldor detected still launches Claude directly, never a
      function that doesn't exist) plus one entry per detected function.
      When cld is detected, IT becomes default instead (matches today's
      actual fallback behavior: the author's untouched config launches
      via cld, not plain claude).
    Inputs: has_cld (bool); has_cldor (bool) - probe results.
    Output: list[dict] - AgentWrapper-shaped dicts, ready for
      ``AgentWrapper(**d)`` or direct JSON serialization.
    Example: build_seed_wrappers(True, True) -> [claude(default=False),
      cld(default=True), cldor(default=False)]
    """
    wrappers: List[Dict] = [
        {
            "id": "claude",
            "label": "claude",
            "script": "claude --dangerously-skip-permissions",
            "entry": None,
            "description": "plain Claude Code CLI, no wrapper",
            "default": not has_cld,
        }
    ]
    if has_cld:
        wrappers.append(
            {
                "id": "cld",
                "label": "cld (subscription)",
                "script": _SEED_SCRIPT_CLD,
                "entry": None,
                "description": (
                    "forwards to the cld shell function already defined in "
                    "~/.zshrc (subscription OAuth via macOS Keychain)"
                ),
                "default": True,
            }
        )
    if has_cldor:
        wrappers.append(
            {
                "id": "cldor",
                "label": "cldor (openrouter)",
                "script": _SEED_SCRIPT_CLDOR,
                "entry": None,
                "description": (
                    "forwards to the cldor shell function already defined in "
                    "~/.zshrc (OpenRouter-routed, model as first argument)"
                ),
                "default": False,
            }
        )
    return wrappers


def migrate_config_dict(
    data: Dict, has_cld: bool, has_cldor: bool
) -> Tuple[Dict, bool]:
    """Pure migration step: old-shape config dict -> versioned + wrappers.

    Description: fail-safe by construction — every branch that can't
      confidently proceed returns ``(data, False)`` with the input
      completely untouched (no partial mutation, no config_version
      stamped), never raises. Legacy ``*_command`` keys are NEVER
      modified or removed, only read (for validation) and left in place.
    Inputs:
      data (dict) - the parsed config.json.
      has_cld (bool) / has_cldor (bool) - environment probe results (see
        ``probe_shell_function``); pass explicitly so this function stays
        pure/deterministic and trivially testable without shelling out.
    Output: (dict, bool) - (possibly-new dict, whether anything changed).
      The returned dict is always a NEW object when changed=True (the
      input ``data`` is never mutated in place), so a caller holding a
      reference to the original can still inspect the pre-migration
      state.
    Raises: never — logs a warning and returns (data, False) instead.
    Example: migrate_config_dict({"agents": {}}, True, False) ->
      ({..., "agents": {..., "wrappers": [claude, cld]}, "config_version": 1}, True)
    """
    try:
        existing_version = data.get("config_version", 0)
        if not isinstance(existing_version, int):
            logger.warning(
                "config_migration_skipped_bad_version_type",
                raw=existing_version,
            )
            return data, False

        if existing_version >= CURRENT_CONFIG_VERSION:
            return data, False  # already migrated — idempotent no-op

        agents_block = data.get("agents")
        if agents_block is None:
            agents_block = {}
        if not isinstance(agents_block, dict):
            logger.warning(
                "config_migration_skipped_bad_agents_block",
                raw_type=type(agents_block).__name__,
            )
            return data, False

        # An explicit non-empty claude_command means the user already
        # opted out of the cld/cldor fallback — don't second-guess that
        # by also seeding cld/cldor wrappers (they'd sit unused, and a
        # non-empty claude_command already takes precedence in
        # get_agent_command's resolution order regardless of wrappers
        # being present or not... but once ANY wrapper list is present
        # it becomes the FIRST-checked source for agent_type=="claude",
        # which would silently stop honoring their custom command). Skip
        # wrapper-seeding entirely in this case — the existing
        # claude_command fallback keeps working exactly as today.
        existing_claude_command = agents_block.get("claude_command", "")
        if existing_claude_command and str(existing_claude_command).strip():
            new_data = dict(data)
            new_data["agents"] = dict(agents_block)
            new_data["config_version"] = CURRENT_CONFIG_VERSION
            logger.info(
                "config_migration_version_stamped_no_wrappers",
                reason="explicit_claude_command_present",
            )
            return new_data, True

        existing_wrappers = agents_block.get("wrappers")
        if existing_wrappers:
            # Already has wrappers (hand-authored or a partial prior
            # migration) — just stamp the version, don't touch the list.
            new_data = dict(data)
            new_data["agents"] = dict(agents_block)
            new_data["config_version"] = CURRENT_CONFIG_VERSION
            return new_data, True

        seed = build_seed_wrappers(has_cld, has_cldor)

        new_agents_block = dict(agents_block)
        new_agents_block["wrappers"] = seed

        new_data = dict(data)
        new_data["agents"] = new_agents_block
        new_data["config_version"] = CURRENT_CONFIG_VERSION

        logger.info(
            "config_migration_seeded_wrappers",
            wrapper_ids=[w["id"] for w in seed],
            has_cld=has_cld,
            has_cldor=has_cldor,
        )
        return new_data, True

    except Exception as e:  # pragma: no cover - defensive, fail-safe path
        logger.warning("config_migration_unexpected_error", error=str(e))
        return data, False


def migrate_config_file(config_path: Path) -> Dict:
    """Run the migration against a real config.json on disk, idempotently.

    Description: reads, probes the environment, calls
      ``migrate_config_dict``, and — only if it reports a change — backs
      up the pre-write bytes to ``config.json.bak`` (overwritten each
      call, same one-generation-of-history convention as
      ``Settings.update_settings_config``) then writes atomically via
      tmp-file + fsync + os.replace. A no-op migration (already current,
      or the fail-safe path) touches NEITHER the config file NOR the
      backup file at all.
    Inputs: config_path (Path) - path to config.json.
    Output: dict - ``{"migrated": bool, "changed": bool, "wrapper_ids":
      list[str]}``. ``migrated`` mirrors ``changed`` (kept as a separate,
      clearly-named key for callers that don't want to read the wrapper
      list to know whether anything happened).
    Raises:
      FileNotFoundError: if config_path doesn't exist.
      ValueError: invalid JSON in config_path.

    ROLLBACK: ``cp config.json.bak config.json`` restores the exact
    pre-migration bytes (delete config.json.bak afterward if you want a
    clean slate for a re-run). The code-level rollback point is git tag
    ``baseline/adoom-2026-08-14`` (commit 6392124).
    """
    if not config_path.exists():
        raise FileNotFoundError(f"config.json not found: {config_path}")

    with open(config_path) as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {config_path}: {e}")

    has_cld = probe_shell_function("cld")
    has_cldor = probe_shell_function("cldor")

    new_data, changed = migrate_config_dict(data, has_cld, has_cldor)

    if not changed:
        return {"migrated": False, "changed": False, "wrapper_ids": []}

    backup_path = config_path.with_suffix(config_path.suffix + ".bak")
    try:
        backup_path.write_text(raw)
    except OSError as e:
        logger.warning("config_migration_backup_failed", error=str(e))
        # Fail-safe: don't write the migrated config if we couldn't
        # secure a rollback path first.
        return {"migrated": False, "changed": False, "wrapper_ids": []}

    tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
    with open(tmp_path, "w") as f:
        json.dump(new_data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, config_path)

    wrapper_ids = [
        w["id"] for w in (new_data.get("agents", {}) or {}).get("wrappers", []) or []
    ]
    logger.info("config_migration_applied", wrapper_ids=wrapper_ids)
    return {"migrated": True, "changed": True, "wrapper_ids": wrapper_ids}


def ensure_config_migrated(config_path: Path) -> None:
    """Best-effort migration entry point for app startup.

    Description: wraps ``migrate_config_file`` so a migration failure of
      any kind (missing file, bad JSON, unexpected exception) NEVER
      blocks server startup — same fail-soft posture as
      ``claude_hooks.ensure_hook_settings()`` in ``src/main.py``'s
      lifespan. Errors are logged, not raised.
    Inputs: config_path (Path).
    Output: None.
    """
    try:
        result = migrate_config_file(config_path)
        if result["changed"]:
            logger.info(
                "config_migration_startup_applied",
                wrapper_ids=result["wrapper_ids"],
            )
    except FileNotFoundError:
        pass  # setup_auth.py hasn't run yet — nothing to migrate
    except Exception as e:
        logger.warning("config_migration_startup_failed", error=str(e))
