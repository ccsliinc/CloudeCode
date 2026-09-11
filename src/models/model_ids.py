"""Model-id validation, shared by the create-session body and the
provider-model routes. This is the shell-injection gate.
"""

import re


# Provider-selector modal (v3.1) - model id validation shared by
# ``CreateSessionRequest.model`` and ``POST /api/v1/providers/models``.
# This IS the shell-injection guard: ``Settings.get_agent_command()``
# interpolates the model into a ``zsh -c '...'`` command string handed to
# tmux (double shlex-quoted there as defense-in-depth - see
# ``render_wrapper_invocation`` in ``src/core/agent_wrappers.py`` and
# ``get_agent_command`` in ``src/core/agent_families.py``, both of which
# wrap the model in ``shlex.quote`` before it reaches a shell), but this
# regex is the primary gate - anything outside this shape is rejected
# before it ever reaches a shell. Keep in sync with the TODO.md contract
# regex if one is added there.
#
# The ``(?!-)`` negative lookahead blocks a leading ``-``: without it, a
# model id like ``--continue`` or ``-p`` would pass the charset check, sail
# past ``cldor``'s own ``[[ "$1" != -* ]]`` guard (which just skips
# consuming it as the model and forwards it into ``"$@"``), and land as an
# injected flag on ``claude --dangerously-skip-permissions``.
#
# ``:`` is allowed for real OpenRouter model-variant ids
# (``vendor/model:free``, ``:nitro``, ``:online``, ``:extended``,
# ``:beta``), but only in one specific shape: exactly one colon, never
# leading, never trailing, with at least one allowed character on both
# sides. That is expressed as two required, non-colon "segments" joined by
# an optional single ``:segment`` - not by adding ``:`` to the flat
# charset - so a leading colon, a trailing colon, and a doubled colon are
# all structurally unreachable rather than merely undesired. ``(?!.*\.\.)``
# additionally refuses any ``..`` substring (defence against path
# traversal if a future call site ever builds a filesystem path from this
# value; no such call site exists today - grepped and confirmed at time of
# writing - but the id shape should not depend on that staying true), and
# ``(?=.{1,120}$)`` keeps the original overall length cap now that the
# match is no longer expressed as one flat ``{1,120}`` repetition.
MODEL_ID_PATTERN = (
    r"^(?!-)(?!.*\.\.)(?=.{1,120}$)"
    r"[A-Za-z0-9._~/-]+(?::[A-Za-z0-9._~/-]+)?$"
)
_MODEL_ID_RE = re.compile(MODEL_ID_PATTERN)

# Charset used only by ``describe_model_id_rejection`` to name a stray
# disallowed character once the structural checks above it have already
# ruled out the colon-position and ".." cases. Deliberately includes ":"
# (unlike the segments in ``MODEL_ID_PATTERN``) because by the time this
# runs, a bad colon placement has already been reported specifically -
# any colon still present here is a validly-placed one, not the culprit.
_ALLOWED_CHAR_RE = re.compile(r"[A-Za-z0-9._~/:-]")


def is_valid_model_id(v: str) -> bool:
    """Single source of truth for OpenRouter model-id validation.

    Used by both ``CreateSessionRequest.model`` (field_validator below) and
    the ``POST /api/v1/providers/models`` route handler
    (``src/api/routes.py``) - every call site MUST go through this
    function rather than calling ``_MODEL_ID_RE`` directly, so the
    validation rule only ever lives in one place.

    ``fullmatch`` (not ``match``) is required: Python's ``$`` matches
    immediately before a trailing newline even in non-MULTILINE mode, so
    ``_MODEL_ID_RE.match("openai/gpt-4\\n")`` would incorrectly succeed and
    let a newline-suffixed id get persisted to config.json.
    """
    return bool(_MODEL_ID_RE.fullmatch(v))


def describe_model_id_rejection(v: str) -> str:
    """Explain WHY a model id failed ``is_valid_model_id``, distinguishably.

    Description: a rejected model id must say why it was rejected rather
      than reporting one collapsed "invalid" message for every cause - a
      leading hyphen (shell-flag injection), a stray shell metacharacter,
      and a malformed colon-variant suffix are different failure classes
      with different fixes for the caller, and collapsing them into a
      single "model must match {pattern}" makes every 400 equally
      uninformative. Checks run in a fixed priority order (empty, leading
      hyphen, colon placement, ``..``, other disallowed characters, length)
      so a string that trips more than one rule still gets one clear
      answer rather than a random one. Only called on a value that has
      already failed ``is_valid_model_id`` - it does not re-derive
      validity, it explains an already-established rejection.
    Inputs: v (str) - the rejected candidate model id.
    Output: str - a human-readable reason, safe to put in an HTTP 400
      ``detail`` (never echoes back more than the offending characters).
    Example: describe_model_id_rejection("-x") ->
      "model id must not start with '-' (would be parsed as a shell flag)"
    """
    if not v:
        return "model id must not be empty"
    if v.startswith("-"):
        return "model id must not start with '-' (would be parsed as a shell flag)"
    if v.startswith(":") or v.endswith(":"):
        return "model id must not start or end with ':'"
    if v.count(":") > 1:
        return "model id must contain at most one ':' variant separator"
    if ".." in v:
        return "model id must not contain '..'"
    bad_chars = sorted(set(ch for ch in v if not _ALLOWED_CHAR_RE.match(ch)))
    if bad_chars:
        return f"model id contains disallowed character(s): {''.join(bad_chars)!r}"
    if len(v) > 120:
        return "model id exceeds the 120 character limit"
    return f"model id does not match required format {MODEL_ID_PATTERN}"
