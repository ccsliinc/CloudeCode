"""``terminal.ready``: the one positive statement that the pane can hear.

WHAT IS BEING PROVED, AND WHY IT IS NOT OBVIOUS. The attach handshake in
``src/api/websocket.py`` opens the socket, asks the client for its dims,
and sits in a receive loop that DISCARDS every binary frame arriving
before that reply. So "the socket is open" and "the pane can take input"
have never been the same fact, and there was nothing on the wire saying
which one you had. This message is that statement, and these tests pin
the three things about it that could silently go wrong:

1. IT IS SENT LAST. After the dims handshake, after the settle, after the
   attach paint, and after any configured startup command. Sent earlier
   it would be exactly as useless as no message at all, and it would look
   like it worked.
2. IT IS NEVER WITHHELD. A startup command that failed does not make the
   pane unable to receive input. Withholding on a failure would strand a
   client that is correctly waiting for permission to send.
3. IT IS ADDITIVE. Nothing waits for a reply, nothing is gated on it, so
   a client that never reads it behaves exactly as every client did
   before it existed. That is the compatibility gate and it is the one
   most likely to be skipped.

The flush's own outcome word is proved here too, because the readiness
message CARRIES it: ``flush_pending_terminal_command`` used to return
None and swallow its failures, so a command that never reached the pane
was a log line and nothing more.
"""

from __future__ import annotations

import ast
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_trm_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_trm_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

from src.core.terminal_commands import TerminalCommand  # noqa: E402
from src.models import WSMessageType, WSTerminalReadyMessage  # noqa: E402

WEBSOCKET_SRC = (ROOT / "src" / "api" / "websocket.py").read_text()


# --------------------------------------------------------------- the model


def test_the_type_string_lives_in_the_one_message_enum() -> None:
    """One message vocabulary, not two. The dot matches ``toast.*``."""
    assert WSMessageType.TERMINAL_READY == "terminal.ready"


def test_the_message_serialises_to_the_wire_shape_the_client_reads() -> None:
    msg = WSTerminalReadyMessage(startup_command="none")
    assert msg.model_dump() == {
        "type": "terminal.ready",
        "startup_command": "none",
    }


def test_an_unstated_startup_outcome_defaults_to_unknown_not_none() -> None:
    """A reading that did not happen is not a reading of nothing.

    ``none`` is a positive claim - nothing was configured, so the pane is
    at a bare prompt. Defaulting to it would let a flush that could not be
    run report a fact nobody established.
    """
    assert WSTerminalReadyMessage().startup_command == "unknown"


# ------------------------------------------------- the flush's own answer


class _FakeBackend:
    """Records what would have been typed into the pane."""

    def __init__(self, fail_times: int = 0) -> None:
        self.writes: list = []
        self.fail_times = fail_times

    async def write(self, data: bytes) -> None:
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("tmux send-keys -l failed: can't find window: 0")
        self.writes.append(data)


def _manager(monkeypatch, command, backend, pending=True):
    from src.config import Settings
    from src.core.session_manager import SessionManager

    sm = SessionManager.__new__(SessionManager)          # no real lifecycle
    sm.pending_terminal_commands = {"s1": "top"} if pending else {}
    sm.backends = {"s1": backend}
    monkeypatch.setattr(
        Settings, "get_terminal_command", lambda self, cid: command, raising=False
    )
    return sm


def test_flush_reports_issued_when_the_bytes_went(monkeypatch) -> None:
    backend = _FakeBackend()
    sm = _manager(monkeypatch, TerminalCommand(id="top", label="top", command="htop"),
                  backend)
    assert asyncio.run(sm.flush_pending_terminal_command("s1")) == "issued"
    assert backend.writes == [b"htop\n"]


def test_flush_reports_none_when_nothing_was_configured(monkeypatch) -> None:
    backend = _FakeBackend()
    sm = _manager(monkeypatch, None, backend, pending=False)
    assert asyncio.run(sm.flush_pending_terminal_command("s1")) == "none"


def test_flush_reports_none_for_a_stale_id(monkeypatch) -> None:
    """The entry was deleted in another tab. A plain console, said out loud."""
    backend = _FakeBackend()
    sm = _manager(monkeypatch, None, backend)
    assert asyncio.run(sm.flush_pending_terminal_command("s1")) == "none"


def test_flush_reports_failed_RATHER_THAN_none_when_the_pane_never_took_it(
        monkeypatch) -> None:
    """THE CASE THE RETURN VALUE EXISTS FOR.

    A command WAS configured and none of its bytes reached the pane. The
    user is at a prompt they did not ask for, and before this the only
    trace was a log line on the server. ``failed`` and ``none`` must never
    collapse into one word: one means the pane is bare because nothing was
    asked for, the other means it is bare because what was asked for did
    not happen.
    """
    backend = _FakeBackend(fail_times=10_000)
    sm = _manager(monkeypatch, TerminalCommand(id="top", label="top", command="htop"),
                  backend)
    monkeypatch.setattr(
        "src.core.session_manager._TERMINAL_COMMAND_WRITE_DELAY_SECONDS", 0)
    assert asyncio.run(sm.flush_pending_terminal_command("s1")) == "failed"
    assert backend.writes == []


# ------------------------------------------------------ where it is sent


def _handler_source() -> str:
    """The websocket endpoint's own body, so the ORDER can be read."""
    tree = ast.parse(WEBSOCKET_SRC)
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and "websocket" in node.name:
            seg = ast.get_source_segment(WEBSOCKET_SRC, node)
            if seg and "REQUEST_DIMS" in seg:
                return seg
    raise AssertionError("no websocket endpoint carrying the dims handshake")


def test_ready_is_sent_AFTER_the_paint_and_AFTER_the_startup_command() -> None:
    """ORDER IS THE WHOLE CLAIM.

    Sent before the paint, a client would flush its held keystrokes into a
    screen about to be overwritten. Sent before the startup command, the
    user's typing would race the command the app itself is issuing. Both
    would look completely healthy from the outside.
    """
    body = _handler_source()
    ready = body.index("WSTerminalReadyMessage(")
    assert body.index("paint_on_attach(") < ready, (
        "readiness must not be claimed before the pane's screen is painted")
    assert body.index("flush_pending_terminal_command") < ready, (
        "readiness must not be claimed before the configured command is issued")


def test_ready_is_sent_exactly_once_per_socket() -> None:
    """Two sends would flush a buffer twice, running a command twice."""
    assert WEBSOCKET_SRC.count("WSTerminalReadyMessage(") == 1


def test_ready_is_sent_on_every_startup_outcome_including_the_failures() -> None:
    """IT IS NEVER WITHHELD.

    A startup command that failed does not make the pane unable to take
    input. The send must not sit inside the branch that ran the flush, or
    a session with no configured command - the overwhelming majority -
    would never be told it was ready at all.
    """
    # Read the TREE, not the indentation: what decides this is whether
    # the send is a descendant of the flush guard, and only the parser
    # knows that once a try/except sits in between.
    body = _handler_source()
    guards = [
        node for node in ast.walk(ast.parse(body))
        if isinstance(node, ast.If)
        and "flush_pending_terminal_command" in (
            ast.get_source_segment(body, node.test) or "")
    ]
    assert len(guards) == 1, "the startup-command guard moved or was duplicated"
    inside = ast.get_source_segment(body, guards[0]) or ""
    assert "WSTerminalReadyMessage(" not in inside, (
        "the readiness send is nested inside the startup-command guard, so a "
        "session with no configured command - the overwhelming majority - is "
        "never told it can take input")


def test_the_ADDITIVE_contract_holds_nothing_waits_on_the_client() -> None:
    """THE COMPATIBILITY GATE.

    An older client that ignores ``terminal.ready`` must keep working.
    That is true only while the server neither waits for an
    acknowledgement nor gates anything on one, so the proof is that no
    receive, and no new message type, sits between the send and the live
    stream loop.
    """
    body = _handler_source()
    after = body[body.index("WSTerminalReadyMessage("):]
    tail = after[:after.index("asyncio.create_task(")]
    assert "websocket.receive" not in tail, (
        "the server waits for something after announcing readiness, which "
        "would hang every client that does not know to answer")
    assert "wait_for" not in tail


def test_a_client_that_left_mid_paint_does_not_break_the_handler() -> None:
    """The send is guarded, and the guard names its exceptions.

    A blanket ``except Exception`` here would swallow a real defect in the
    message itself; the disconnect is the only thing being tolerated.
    """
    body = _handler_source()
    after = body[body.index("WSTerminalReadyMessage("):]
    guard = after[:after.index("except WebSocketDisconnect") + 200]
    assert "except WebSocketDisconnect" in guard
    assert "except Exception" not in guard, (
        "a blanket catch around the readiness send would hide a broken message")
