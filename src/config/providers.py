"""The OpenRouter provider catalog, its defaults and its host guard.

Carved out of the flat ``src/config.py`` by slice S5. Bodies byte-exact.
The default list stays module-level for the reason its own comment gives:
the pydantic default and the raw-JSON add/remove writers must seed from
ONE list or they drift the first time either moves."""

from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from src.models import MODEL_ID_PATTERN, is_valid_model_id


# Provider-selector modal (v3.1) default catalog - shown alongside the
# implicit "Claude" option. Module-level so both ``ProvidersConfig``'s
# pydantic default AND the raw-JSON add/remove methods below (which must
# seed from the same defaults when config.json has no "providers" block
# yet) stay in sync.
_DEFAULT_PROVIDER_MODELS: List[str] = [
    "qwen/qwen3.8-max",
    "moonshotai/kimi-k3",
    "openai/gpt-5.6-sol",
]


def _warn_bad_local_host(raw: str, why: str) -> None:
    """Log a rejected ``providers.local_host`` without echoing it blindly.

    Inputs: raw (str) - the offending value. why (str) - the reason.
    Output: None.
    """
    import structlog

    structlog.get_logger().warning(
        "dropped_invalid_local_host", value=raw[:120], reason=why
    )


class ProvidersConfig(BaseModel):
    """OpenRouter model catalog for the provider-selector modal.

    ``models`` is the add/remove-able list shown alongside the implicit
    "Claude" option (never stored here, never removable - the client
    always prepends it). A missing/absent "providers" block in
    config.json deserializes to the curated default trio via
    ``_DEFAULT_PROVIDER_MODELS``.
    """
    models: List[str] = Field(default_factory=lambda: list(_DEFAULT_PROVIDER_MODELS))

    # LM Studio's OpenAI-compatible server, as ``host:port``.
    #
    # CONFIG-ONLY, with no API setter, and that is deliberate. This value is
    # interpolated into a shell command and used as a fetch target, so an
    # endpoint that could set it would be an SSRF surface reachable with a
    # single authenticated POST. Editing config.json is already a
    # box-access-level operation; a route is not.
    #
    # EMPTY BY DEFAULT, not a guessed address. A default pointing at some
    # other network's box would make "local models unreachable" the normal
    # state for everyone who does not run LM Studio, which trains the reader
    # to ignore the row - and it makes the app probe a stranger's IP. Empty
    # reads as NOT CONFIGURED, which is a different fact from unreachable
    # and is reported as one.
    local_host: str = Field(
        default="",
        description="LM Studio server as host:port; empty means not configured",
    )

    @field_validator("local_host")
    @classmethod
    def _validate_local_host(cls, v: str) -> str:
        """Accept ``host:port`` only, or empty. Never a URL, never a path.

        Description: this string reaches a shell command (via CLDL_HOST)
          and an HTTP fetch target. Validating the SHAPE here means neither
          consumer has to trust a hand-edited config.json. A value that
          does not parse is dropped to empty with a warning rather than
          raising, matching how every other malformed sub-block in this
          config fails soft - but it is dropped to NOT CONFIGURED, never to
          a guess.
        Inputs: v (str) - the configured value.
        Output: str - a validated ``host:port``, or "".
        Example: _validate_local_host("10.0.1.5:1234")  # '10.0.1.5:1234'
        """
        raw = (v or "").strip()
        if not raw:
            return ""
        # Reject anything carrying a scheme, path, query or credentials -
        # those are the shapes that turn a host:port into an SSRF primitive
        # or a shell surprise.
        if any(c in raw for c in "/\\?#@ \t'\"`$;|&<>()"):
            _warn_bad_local_host(raw, "must be host:port with no scheme or path")
            return ""
        host, sep, port = raw.rpartition(":")
        if not sep or not host:
            _warn_bad_local_host(raw, "missing :port")
            return ""
        if not port.isdigit() or not (1 <= int(port) <= 65535):
            _warn_bad_local_host(raw, "port is not 1-65535")
            return ""
        # Bracketed IPv6 is fine; a bare one is ambiguous against the port
        # separator and is refused rather than guessed at.
        if ":" in host and not (host.startswith("[") and host.endswith("]")):
            _warn_bad_local_host(raw, "bare IPv6 host must be bracketed")
            return ""
        return raw

    @field_validator("models")
    @classmethod
    def _drop_invalid_model_ids(cls, v: List[str]) -> List[str]:
        """Defense-in-depth: ``add_provider_model`` / the POST route only
        guard entries added through the API. A hand-edited config.json
        bypasses that guard entirely, and this list is trusted downstream
        both server-side (``Settings.get_agent_command`` interpolates it
        into a shell command) and client-side (rendered into the provider
        modal's DOM, including the remove-confirm dialog). Validate here
        too, at load time, so a corrupted/tampered entry can't reach
        either surface unvalidated.

        Drop-with-a-warning-log rather than raise: this mirrors the
        fail-soft philosophy ``load_auth_config`` already applies to each
        malformed sub-block (session, auth_rate_limits, notifications,
        agents, uploads) - one bad entry should not hard-brick the whole
        app on startup or wipe out the rest of an otherwise-valid list.
        """
        valid: List[str] = []
        dropped: List[str] = []
        for m in v:
            if isinstance(m, str) and is_valid_model_id(m):
                valid.append(m)
            else:
                dropped.append(m)
        if dropped:
            import structlog
            structlog.get_logger().warning(
                "dropped_invalid_provider_model_ids",
                dropped=dropped,
                pattern=MODEL_ID_PATTERN,
            )
        return valid
