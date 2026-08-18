"""Suite-wide safety fixtures.

The only job of this file is to make it impossible for the test suite to
touch the user's live tmux socket. See :mod:`tests.socket_guard` for the
policy and the three-outcome reasoning behind it.

Both fixtures here are autouse, so a newly written test inherits the
protection without knowing it exists. That is the point: the guarantee
must not depend on the next person remembering.
"""

from __future__ import annotations

from typing import Iterator

import pytest

from tests.socket_guard import (
    FORBIDDEN_SOCKET_NAME,
    TEST_SOCKET_NAME,
    TEST_SOCKET_PREFIX,
    default_redirect_is_installed,
    guard_is_installed,
    install_default_socket_redirect,
    install_subprocess_guard,
    kill_test_socket_server,
    remove_default_socket_redirect,
    remove_subprocess_guard,
)


@pytest.fixture(scope="session", autouse=True)
def tmux_socket_isolation() -> Iterator[str]:
    """Install the tmux socket guard for the whole session and clean up.

    Inputs:
        None.

    Outputs:
        Yields this run's test socket name, so a test can depend on the
        fixture directly when it needs the value.
    """
    install_default_socket_redirect()
    install_subprocess_guard()
    try:
        yield TEST_SOCKET_NAME
    finally:
        # Kill our own server first, while the guard is still installed
        # and can vouch for the socket name being ours.
        kill_test_socket_server()
        remove_subprocess_guard()
        remove_default_socket_redirect()


@pytest.fixture(autouse=True)
def assert_socket_guard_active(tmux_socket_isolation: str) -> None:
    """Fail any test that runs without a provably safe socket configured.

    Applies the three-outcome rule: the guard being absent, or the socket
    name being unverifiable, is a FAILURE. Only a positively verified
    test-socket name is a pass.

    Inputs:
        tmux_socket_isolation: The session fixture's socket name.

    Outputs:
        None. Raises via ``pytest.fail`` when the run is not safe.
    """
    if not guard_is_installed():
        pytest.fail(
            "tmux socket guard is NOT installed. The suite cannot prove it "
            "will stay off the production socket, so this is a failure, not "
            "a pass."
        )

    if not default_redirect_is_installed():
        pytest.fail(
            "the production default socket name was NOT redirected, so a "
            "test that names no socket would fall back to the live socket. "
            "That state cannot be shown to be safe, so it is a failure."
        )

    name = tmux_socket_isolation
    if not name:
        pytest.fail(
            "test tmux socket name is empty, so the target socket cannot be "
            "determined. Under the three-outcome rule that is a failure."
        )
    if name == FORBIDDEN_SOCKET_NAME:
        pytest.fail(
            f"test tmux socket resolved to the production socket "
            f"{FORBIDDEN_SOCKET_NAME!r}."
        )
    if not name.startswith(TEST_SOCKET_PREFIX):
        pytest.fail(
            f"test tmux socket {name!r} does not carry the required prefix "
            f"{TEST_SOCKET_PREFIX!r}, so it cannot be shown to be a "
            "throwaway socket."
        )


@pytest.fixture
def tmux_test_socket(tmux_socket_isolation: str) -> str:
    """Provide this run's tmux socket name to tests that spawn sessions.

    Inputs:
        tmux_socket_isolation: The session fixture's socket name.

    Outputs:
        The socket name string. This is the ONLY socket the guard permits.
    """
    return tmux_socket_isolation
