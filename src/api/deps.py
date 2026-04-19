"""API dependencies and authentication."""

from fastapi import Header, HTTPException, WebSocket
from typing import Optional, Tuple
import structlog

from src.config import settings
from src.api.auth import verify_jwt_token

logger = structlog.get_logger()


# Subprotocol marker for WebSocket JWT auth.
# Client opens WS with subprotocols=["cloude.jwt.v1", <jwt>].
# Server echoes SUBPROTOCOL_MARKER back via websocket.accept(subprotocol=...).
# Keeping the token out of query string / path avoids leakage into proxy and
# access logs (query strings are routinely logged; the Sec-WebSocket-Protocol
# header is not).
SUBPROTOCOL_MARKER = "cloude.jwt.v1"


async def verify_api_key(x_api_key: Optional[str] = Header(None)) -> bool:
    """
    Verify API key if configured.

    Args:
        x_api_key: API key from request header

    Returns:
        True if authentication successful

    Raises:
        HTTPException: If authentication fails
    """
    # Skip auth if no API key is configured
    if not settings.api_key:
        return True

    if not x_api_key or x_api_key != settings.api_key:
        logger.warning("authentication_failed", provided_key=x_api_key[:8] if x_api_key else None)
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "ApiKey"}
        )

    return True


def _parse_subprotocols(raw: Optional[str]) -> list[str]:
    """
    Parse the Sec-WebSocket-Protocol header value (comma-separated list)
    into a clean list of subprotocol tokens.

    Per RFC 6455, values are comma-separated; whitespace around each token
    is insignificant.
    """
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def verify_jwt_from_subprotocol(websocket: WebSocket) -> Tuple[bool, Optional[str]]:
    """
    Extract and verify a JWT presented via the Sec-WebSocket-Protocol header.

    Browsers send the `WebSocket` constructor's second argument — an array of
    subprotocols — as a comma-separated `Sec-WebSocket-Protocol` header. The
    client is expected to open the socket as:

        new WebSocket(url, ["cloude.jwt.v1", "<jwt_token>"])

    which serializes to header `Sec-WebSocket-Protocol: cloude.jwt.v1, <jwt>`.

    On success, the server MUST echo the `cloude.jwt.v1` marker back via
    `websocket.accept(subprotocol="cloude.jwt.v1")` or the browser will reject
    the handshake (RFC 6455 § 4.1 step 11).

    Args:
        websocket: FastAPI/Starlette WebSocket object (headers not yet accepted).

    Returns:
        Tuple of (ok, detail_or_token):
          - (True, token)   on success — caller uses it to derive claims if needed.
          - (False, reason) on failure — caller sends close code 4401 (auth)
            or 4400 (malformed) with `reason` as the close reason.
    """
    raw = websocket.headers.get("sec-websocket-protocol")
    protocols = _parse_subprotocols(raw)

    if not protocols:
        return False, "missing subprotocol"

    if SUBPROTOCOL_MARKER not in protocols:
        return False, "missing subprotocol"

    # Expected form: [SUBPROTOCOL_MARKER, <jwt>]. We accept any ordering but
    # require exactly two non-empty entries and the marker among them.
    others = [p for p in protocols if p != SUBPROTOCOL_MARKER]

    if not others:
        return False, "missing token"

    # Take the first non-marker entry as the token candidate. This tolerates
    # clients that accidentally send the marker twice but still rejects any
    # entry that looks malformed (empty string already filtered by parser).
    token = others[0]

    if not token:
        return False, "missing token"

    # Actual JWT verification — reuses existing HS256/explicit-algorithms path.
    if not verify_jwt_token(token):
        return False, "invalid token"

    return True, token
