"""The OpenRouter model list in ``config.json``, added to and removed from.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``.

**FORMAT VALIDATION IS THE CALLER'S JOB AND THAT IS DELIBERATE.** A model
id is interpolated into a shell command downstream, so the guard is
``MODEL_ID_PATTERN`` at the route handler for
``POST /api/v1/providers/models``, which runs BEFORE anything here. These
two functions enforce only uniqueness and presence.

**THE DEFAULT LIST IS SEEDED ONLY WHEN THE KEY IS ABSENT.** ``.get("models",
_DEFAULT_PROVIDER_MODELS)`` mirrors ``ProvidersConfig``'s own
``default_factory`` semantics exactly: an explicit ``"models": []`` is
honoured verbatim and is NOT refilled with the curated trio. A user who
cleared the list meant to clear it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

from src.config.config_file import read_config, require_config_file
from src.config.providers import _DEFAULT_PROVIDER_MODELS


def _persisted_models(config_path: Path) -> tuple[dict, dict, List[str]]:
    """The document, its providers block, and the model list inside it.

    Description: the shared read half of :func:`add` and :func:`remove`.
      Returns all three because a writer needs the outer document to
      write back, the block to update, and the list to change.
    Inputs: config_path (Path).
    Output: tuple[dict, dict, list[str]].
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: config.json is not valid JSON.
    """
    data = read_config(config_path)
    providers_data = data.get("providers") or {}
    return data, providers_data, list(
        providers_data.get("models", _DEFAULT_PROVIDER_MODELS)
    )


def _write(config_path: Path, data: dict, providers_data: dict, models: List[str]) -> None:
    """Put the updated model list back into config.json.

    Description: a plain overwrite rather than the tmp-plus-rename used
      by :mod:`src.config.config_file`, which is what this path has
      always done. Changing it would be a behaviour change wearing a
      refactor's clothes; it is recorded here so the difference is
      visible rather than accidental.
    Inputs: config_path (Path); data (dict) - the whole document;
      providers_data (dict) - its providers block; models (list[str]).
    Output: None.
    """
    providers_data["models"] = models
    data["providers"] = providers_data
    with open(config_path, "w") as f:
        json.dump(data, f, indent=2)


def add(config_path: Path, model: str) -> List[str]:
    """Add an OpenRouter model id to ``providers.models``.

    Inputs: config_path (Path); model (str) - already format-validated
      by the caller, see the module docstring.
    Output: list[str] - the updated list. Never includes "Claude", which
      is implicit and prepended by whoever renders the picker.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: the model is already present, or invalid JSON.
    Example: add(path, "qwen/qwen3.8-max")
    """
    require_config_file(config_path)
    data, providers_data, models = _persisted_models(config_path)

    if model in models:
        raise ValueError(f"Model '{model}' already exists")

    models.append(model)
    _write(config_path, data, providers_data, models)
    return models


def remove(config_path: Path, model: str) -> List[str]:
    """Remove an OpenRouter model id from ``providers.models``.

    Inputs: config_path (Path); model (str).
    Output: list[str] - the updated list.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: the model is not present, or invalid JSON.
    Example: remove(path, "qwen/qwen3.8-max")
    """
    require_config_file(config_path)
    data, providers_data, models = _persisted_models(config_path)

    if model not in models:
        raise ValueError(f"Model '{model}' not found")

    models.remove(model)
    _write(config_path, data, providers_data, models)
    return models
