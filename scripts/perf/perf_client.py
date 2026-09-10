"""A thin, real HTTP client for the isolated perf server, plus OS sampling.

Every call in here goes over real loopback HTTP/JSON against the real
``src.main:app`` routes - nothing is mocked or called in-process. The one
exception is ``sample_process``, which shells out to ``ps`` (stdlib
``subprocess`` only - this harness intentionally adds no new pip
dependency such as ``psutil`` to ``requirements.txt``, which is outside
this file's fence anyway).
"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from typing import Callable, Optional

import httpx
import pyotp


@dataclass
class ProcessSample:
    """One point-in-time OS-level reading of a process and its children.

    Inputs: none at construction beyond the fields below.
    Output: ``cpu_percent`` (float, as ``ps`` reports it - see caveat on
      ``sample_process``), ``rss_kb`` (int), ``child_count`` (int) - live
      children at sample time, mostly transient tmux subprocesses.
    """

    cpu_percent: float
    rss_kb: int
    child_count: int


def sample_process(pid: int) -> Optional[ProcessSample]:
    """Read one process's CPU%, RSS and live child count via ``ps``.

    Description: ``ps -o %cpu=,rss=`` gives a CPU percentage that is an
      AVERAGE OVER THE PROCESS'S WHOLE LIFETIME on macOS/BSD ps, not an
      instantaneous rate - fine for "is this server pegged at idle",
      wrong for "what did the last 200ms cost". Idle-CPU reporting in the
      baseline doc says so explicitly rather than implying a finer
      granularity than this call can back up.
    Inputs: pid (int).
    Output: Optional[ProcessSample] - None when the pid is gone.
    """
    proc = subprocess.run(
        ["ps", "-o", "%cpu=,rss=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    parts = proc.stdout.split()
    cpu = float(parts[0])
    rss_kb = int(parts[1])
    children = subprocess.run(
        ["pgrep", "-P", str(pid)], capture_output=True, text=True, check=False
    )
    child_count = len([ln for ln in children.stdout.splitlines() if ln.strip()])
    return ProcessSample(cpu_percent=cpu, rss_kb=rss_kb, child_count=child_count)


def count_descendants(pid: int) -> int:
    """Count every live descendant (children, grandchildren, ...) of ``pid``.

    Description: used to attribute a burst of transient tmux subprocesses
      (each ``tmux`` CLI invocation forks, runs briefly, and exits) to one
      interaction window - poll this across the window and take the max,
      or diff before/after, rather than trusting a single snapshot to
      catch a subprocess that lived for only a few milliseconds.
    Inputs: pid (int).
    Output: int - 0 when the pid has no live children (or is gone).
    """
    direct = subprocess.run(
        ["pgrep", "-P", str(pid)], capture_output=True, text=True, check=False
    )
    kids = [ln for ln in direct.stdout.splitlines() if ln.strip()]
    total = len(kids)
    for kid in kids:
        total += count_descendants(int(kid))
    return total


class PerfClient:
    """Authenticated REST client against one isolated perf server.

    Inputs: base_url (str) - e.g. ``http://127.0.0.1:5231``; totp_secret
      (str) - this run's fresh TOTP secret (see ``perf_env.PerfServer``).
    Output: call ``login()`` once, then use ``create_session`` /
      ``list_sessions`` / ``create_toast`` / ``close`` as needed.
    """

    def __init__(self, base_url: str, totp_secret: str) -> None:
        self.base_url = base_url
        self._totp_secret = totp_secret
        self._http = httpx.Client(base_url=base_url, timeout=20.0)
        self.token: Optional[str] = None

    def login(self) -> str:
        """Real TOTP login: compute a valid code, POST it, keep the JWT.

        Description: this is the SAME endpoint and the SAME verification
          path (``pyotp.TOTP.verify``, rate limiting, replay dedup) a real
          browser's login form drives - the code is computed locally with
          the run's own secret rather than typed, but nothing about the
          server-side check is bypassed.
        Inputs: none.
        Output: str - the bearer access token, also stored on ``self`` and
          attached to every subsequent request this client makes.
        Raises: RuntimeError - the server refused the code.
        """
        code = pyotp.TOTP(self._totp_secret).now()
        resp = self._http.post("/api/v1/auth/verify", json={"code": code})
        if resp.status_code != 200:
            raise RuntimeError(f"perf login refused: {resp.status_code} {resp.text[:300]}")
        self.token = resp.json()["access_token"]
        self._http.headers["Authorization"] = f"Bearer {self.token}"
        return self.token

    def create_session(self, working_dir: str, label: str) -> dict:
        """Create one ``agent_type=shell`` session through the real API.

        Inputs: working_dir (str) - an existing directory under this
          run's isolated work root; label (str) - the session's birth
          name.
        Output: dict - the created ``Session`` JSON body (includes
          ``id`` and, once the backend has settled, ``tmux_session``).
        Raises: RuntimeError - the create was refused.
        """
        resp = self._http.post(
            "/api/v1/sessions",
            json={
                "working_dir": working_dir,
                "auto_start_claude": True,
                "agent_type": "shell",
                "label": label,
            },
        )
        if resp.status_code != 201:
            raise RuntimeError(f"create refused: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def list_sessions(self) -> list[dict]:
        """``GET /sessions/list`` - the WRAPPER-level rows, verbatim.

        Inputs: none.
        Output: list[dict] - each carries ``session`` nested plus the
          wrapper-level fields (``activity_status``, ``tmux_session``, ...).
        """
        resp = self._http.get("/api/v1/sessions/list")
        resp.raise_for_status()
        return resp.json()

    def row_for(self, session_id: str) -> Optional[dict]:
        """This session's ``/sessions/list`` row, or None if not listed.

        Inputs: session_id (str).
        Output: Optional[dict].
        """
        for row in self.list_sessions():
            if (row.get("session") or {}).get("id") == session_id:
                return row
        return None

    def create_toast(self, session_id: str, kind: str, title: str, body: str) -> dict:
        """POST the documented canonical synthetic-toast entry point.

        Description: ``POST /sessions/{id}/toasts`` is named in this
          project's own route docstring as "the canonical entry point for
          synthetic-load tests" - it runs the same
          ``record_toast`` + ``broadcast_to_session`` pair the real
          hook-driven route runs, differing only in how the request is
          authenticated (JWT here, loopback+HMAC token for a real hook).
          The measured span is POST-issued to toast-broadcast, not
          hook-hmac-validated to toast-broadcast; the difference is a few
          header comparisons and is noted in the baseline doc rather than
          claimed away.
        Inputs: session_id (str); kind (str) - 'Stop'|'PermissionRequest'|
          'Notification'; title (str); body (str).
        Output: dict - the created toast.
        Raises: RuntimeError - refused (e.g. unknown session id).
        """
        resp = self._http.post(
            f"/api/v1/sessions/{session_id}/toasts",
            json={"kind": kind, "title": title, "body": body},
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"toast refused: {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def close(self) -> None:
        """Close the underlying HTTP client. Inputs/Output: none."""
        self._http.close()


def wait_until(predicate: Callable[[], object], timeout: float, interval: float = 0.05) -> bool:
    """Poll ``predicate()`` until it is truthy or ``timeout`` elapses.

    Inputs: predicate (Callable[[], object]); timeout (float) - seconds;
      interval (float) - seconds between polls.
    Output: bool - True if ``predicate`` became truthy in time.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return bool(predicate())
