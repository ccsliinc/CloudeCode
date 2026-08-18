"""The result type for every tmux enumeration in this app.

WHY THIS TYPE EXISTS. ``tmux list-sessions`` answers a question by
printing lines. It also fails to answer that question in at least four
ways, and every one of them exits non-zero with nothing on stdout. Code
that models the answer as ``List[str]`` has exactly one value available
to express all five outcomes, and it picks the empty list - so "tmux is
not installed", "the probe timed out", "tmux exited 2 with a socket
permission error" and "there are genuinely no sessions" all render as a
healthy machine with zero sessions.

That is the false-green class this repo's THREE-OUTCOME RULE exists to
kill: pass, fail, and COULD NOT EVALUATE, where the third is never a
flavour of the other two. An empty list is an ANSWER. A failed probe is
the ABSENCE of an answer. They need different values, so they get
different fields.

THE SHAPE.

    ok        True  -> the probe RAN and ``sessions`` is the complete,
                      trustworthy answer. ``sessions == []`` with
                      ``ok=True`` means genuinely zero sessions.
              False -> the probe did not produce an answer. ``sessions``
                      is always ``[]`` and carries NO information.
                      Callers MUST NOT transition, prune, or reconcile
                      any state against it.
    sessions  The rows. Element type is the producer's business:
              ``discover_existing`` yields ``str`` names,
              ``list_attachable_sessions`` and ``list_pane_status_all``
              yield ``dict`` rows.
    reason    A short machine-readable token, present on BOTH outcomes.
              On ``ok=True`` it explains why the answer is what it is
              (``no_server`` = tmux told us there is no server, which is
              a real, complete answer of zero). On ``ok=False`` it names
              what stopped us. ``None`` means "listed normally".
    detail    Optional human string (trimmed stderr, exception text) for
              the log line and the UI tooltip. Never parsed.

WHY ``no_server`` IS ``ok=True``. This is the whole crux of the type. A
tmux server exits when its last session ends, so "no server running" is
the NORMAL steady state of a machine with zero sessions - it is tmux
answering the question, not failing to. Collapsing it into ``ok=False``
would make the home screen shout CANNOT DETERMINE at every user who has
simply closed all their sessions, the alert would lose its credibility
within a day, and the type would be worthless. Collapsing the other way
- treating every rc=1 as ``no_server`` - is the original bug. The split
is made by :func:`classify_listing_failure` on the stderr text, and it
is the single place that decision is made.

DELIBERATELY NOT A COLLECTION. This class defines no ``__iter__``, no
``__len__`` and no ``__bool__``. That is on purpose: a call site that
was not updated fails loudly with a ``TypeError`` instead of silently
iterating, or silently testing truthy, and reintroducing the exact bug
this type was written to remove.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence

# ---- Reason vocabulary ------------------------------------------------------
# Kept as constants (not bare strings at each site) so a typo is an
# ImportError rather than a reason nobody ever matches on.

#: tmux listed normally. Used with ``ok=True``; ``reason`` is ``None``.
REASON_LISTED: Optional[str] = None

#: tmux ran and reported that no server is running. A COMPLETE answer of
#: zero sessions, so this pairs with ``ok=True``.
REASON_NO_SERVER = "no_server"

#: ``shutil.which("tmux")`` found nothing. We cannot answer at all.
REASON_TMUX_MISSING = "tmux_missing"

#: The subprocess exceeded its wall-clock budget and was killed.
REASON_TIMEOUT = "timeout"

#: An unexpected exception around the probe (OSError, decode failure).
REASON_PROBE_ERROR = "probe_error"

#: This backend does not have tmux sessions at all (PTYBackend). A real,
#: complete answer of zero, so it pairs with ``ok=True``.
REASON_NOT_APPLICABLE = "not_applicable"

#: Prefix for a non-zero exit we could not classify: ``exit_1``, ``exit_2``.
REASON_EXIT_PREFIX = "exit_"


def exit_reason(returncode: int) -> str:
    """Build the reason token for an unclassified non-zero tmux exit.

    Inputs:
        returncode (int): the process exit status.

    Output:
        str: ``"exit_<returncode>"``.

    Example:
        >>> exit_reason(2)
        'exit_2'
    """
    return f"{REASON_EXIT_PREFIX}{returncode}"


# ---- "no server" detection --------------------------------------------------
# tmux has no stable exit code for this: every one of these conditions is
# rc=1. The text is the only signal there is.
#
# THE ERRNO IS THE WHOLE DECISION, AND IT USED TO BE THROWN AWAY.
#
# tmux emits ``error connecting to <path> (<strerror>)`` for EVERY failure
# to reach the socket, and only ONE of those errnos means "there is no
# server". Matching the bare prefix ``error connecting to`` classified all
# of them as a complete answer of zero sessions. Measured against tmux
# 3.7b on macOS (and reported identically for 3.5a), rc=1 in every case:
#
#   error connecting to <path> (No such file or directory)   <- no server
#   error connecting to <path> (Permission denied)           <- COULD NOT LOOK
#   error connecting to <path> (Socket operation on non-socket)  <- COULD NOT LOOK
#   error connecting to <path> (File name too long)          <- COULD NOT LOOK
#
# The last three are the probe failing, not answering. Reporting them as
# zero sessions walks a caller straight through the first-run import gate
# and stamps a one-way latch over a user's whole session history.
#
# WHY RESTRICTING THIS IS SAFE, MEASURED RATHER THAN ASSUMED. The obvious
# worry is that the common "server died and left a socket behind" case
# now reports CANNOT DETERMINE forever, which would be the never-clearing
# check this repo calls furniture. It does not: tmux handles a stale
# socket internally (it connects, fails, unlinks) and reports
# ``no server running on <path>``, NOT a connect error. Verified on tmux
# 3.7b for both a clean ``kill-server`` and a ``kill -9`` of the server
# process - both produce ``no server running``. So the ONLY route to
# ``error connecting to ... (No such file or directory)`` is a socket path
# that was never there, which is genuinely no server.

#: Messages that unambiguously mean "no server", with no errno to read.
#: Substring + case-insensitive, so an appended path still classifies.
_NO_SERVER_MARKERS = (
    "no server running",
    "failed to connect to server",
    "no current server",
)

#: The one connect errno that means "no server", rather than "I could not
#: look". Compared case-insensitively against the parenthesised strerror.
_NO_SERVER_CONNECT_ERRNOS = frozenset({"no such file or directory"})

#: The prefix tmux uses for every socket-connection failure.
_CONNECT_ERROR_MARKER = "error connecting to"

#: Pulls the trailing ``(strerror)`` off a connect-error line. Anchored to
#: the END of the string because a socket PATH may itself contain
#: parentheses, and the errno is always last.
_CONNECT_ERRNO_RE = re.compile(r"\(([^()]*)\)\s*$")

# ---- The three outcomes of reading tmux's stderr ---------------------------
# Named constants rather than a bool, because the whole defect this
# replaces was a two-valued answer to a three-valued question.

#: stderr says, unambiguously, that no server is running. A COMPLETE
#: answer of zero sessions. Pairs with ``ok=True``.
STDERR_NO_SERVER = "no_server"

#: stderr names a failure to reach the socket that is NOT an absent
#: server (permission, non-socket, name too long). We did not look.
STDERR_CONNECT_FAILED = "connect_failed"

#: stderr is something else entirely, or a connect error whose errno we
#: could not parse or do not recognise. We did not look, and we will not
#: guess. This is the deliberate default.
STDERR_UNRECOGNISED = "unrecognised"

#: A socket we could not reach. ``ok=False``; distinct from ``exit_<rc>``
#: so the UI can say WHICH kind of not-looking happened.
REASON_CONNECT_FAILED = "connect_failed"


def classify_tmux_stderr(stderr_text: str) -> str:
    """Read tmux's stderr as one of three outcomes, never two.

    Description: the single place the no-server / could-not-look split is
      decided. An ``error connecting to`` line is resolved by its
      PARENTHESISED ERRNO and by nothing else; only
      ``No such file or directory`` is an absent server. An errno this
      function does not recognise, or a connect line with no readable
      errno at all, is ``STDERR_UNRECOGNISED`` - never ``STDERR_NO_SERVER``.
      That asymmetry is deliberate and is the entire safety property: a
      new tmux release inventing new wording degrades to CANNOT DETERMINE,
      which retries, rather than to a confident zero, which is permanent.
    Inputs:
        stderr_text (str): decoded stderr from a failed tmux invocation.
    Output:
        str: one of ``STDERR_NO_SERVER``, ``STDERR_CONNECT_FAILED``,
            ``STDERR_UNRECOGNISED``.
    Example:
        >>> classify_tmux_stderr("no server running on /tmp/x")
        'no_server'
        >>> classify_tmux_stderr("error connecting to /tmp/x (Permission denied)")
        'connect_failed'
    """
    text = (stderr_text or "").strip()
    lowered = text.lower()
    if not lowered:
        # A non-zero exit that said nothing is precisely the case we must
        # not guess about.
        return STDERR_UNRECOGNISED
    if any(marker in lowered for marker in _NO_SERVER_MARKERS):
        return STDERR_NO_SERVER
    if _CONNECT_ERROR_MARKER in lowered:
        match = _CONNECT_ERRNO_RE.search(text)
        if match is None:
            # A connect failure whose cause we cannot read. Not an answer.
            return STDERR_UNRECOGNISED
        errno_text = match.group(1).strip().lower()
        if errno_text in _NO_SERVER_CONNECT_ERRNOS:
            return STDERR_NO_SERVER
        return STDERR_CONNECT_FAILED
    return STDERR_UNRECOGNISED


def looks_like_no_server(stderr_text: str) -> bool:
    """Decide whether tmux's stderr means "there is no server", not "I failed".

    Description: the boolean face of :func:`classify_tmux_stderr`, kept
      for call sites that only need the one bit. True ONLY for
      ``STDERR_NO_SERVER``; both of the other outcomes are False, because
      from this function's caller's point of view "I could not look" and
      "I do not recognise this" have the same consequence - do not treat
      it as an answer.
    Inputs:
        stderr_text (str): decoded stderr from a failed tmux invocation.
    Output:
        bool: True when the text is a KNOWN no-server message, so the
            correct listing is a trustworthy EMPTY one. False for every
            other failure, including an empty stderr and including a
            connect error whose errno is anything but
            ``No such file or directory``.
    Example:
        >>> looks_like_no_server("no server running on /tmp/tmux-501/cloude")
        True
        >>> looks_like_no_server("error connecting to /x (Permission denied)")
        False
    """
    return classify_tmux_stderr(stderr_text) == STDERR_NO_SERVER


def classify_listing_failure(returncode: int, stderr_text: str) -> "TmuxListing":
    """Turn a non-zero tmux exit into the right one of the three outcomes.

    The single place the ``no_server`` / real-error split is decided, so
    all three enumeration methods cannot drift apart on it.

    Inputs:
        returncode (int): tmux's exit status (already known non-zero).
        stderr_text (str): decoded stderr.

    Output:
        TmuxListing: ``ok=True, sessions=[], reason='no_server'`` ONLY
            when tmux reported an absent server (a complete answer of
            zero). ``ok=False, reason='connect_failed'`` when the socket
            could not be reached for any other cause, and
            ``ok=False, reason='exit_<rc>'`` for anything unrecognised.

    Example:
        >>> classify_listing_failure(1, "no server running on /tmp/x").ok
        True
        >>> classify_listing_failure(1, "error connecting to /x (Permission denied)").ok
        False
    """
    verdict = classify_tmux_stderr(stderr_text)
    detail = (stderr_text or "").strip() or None
    if verdict == STDERR_NO_SERVER:
        return TmuxListing.answered([], reason=REASON_NO_SERVER, detail=detail)
    if verdict == STDERR_CONNECT_FAILED:
        return TmuxListing.unavailable(REASON_CONNECT_FAILED, detail=detail)
    return TmuxListing.unavailable(exit_reason(returncode), detail=detail)


@dataclass(frozen=True)
class TmuxListing:
    """The outcome of one tmux enumeration: an answer, or the lack of one.

    See the module docstring for the full contract. In one line: read
    ``ok`` BEFORE you read ``sessions``, and never let ``ok=False`` drive
    a state transition.

    Attributes:
        ok: True when ``sessions`` is a complete, trustworthy answer.
        sessions: the rows; always ``[]`` when ``ok`` is False.
        reason: short token explaining the outcome, or None for a plain
            successful listing.
        detail: optional human-readable text for logs and tooltips.
    """

    ok: bool
    sessions: List[Any] = field(default_factory=list)
    reason: Optional[str] = None
    detail: Optional[str] = None

    @classmethod
    def answered(
        cls,
        sessions: Sequence[Any],
        reason: Optional[str] = REASON_LISTED,
        detail: Optional[str] = None,
    ) -> "TmuxListing":
        """Build a trustworthy answer, possibly an empty one.

        Inputs:
            sessions: the rows tmux reported (may be empty - that is a
                real answer of zero, which is the point).
            reason: optional explanation token, e.g. ``no_server``.
            detail: optional human-readable text.

        Output:
            TmuxListing: with ``ok=True``.

        Example:
            >>> TmuxListing.answered(["cloude_a"]).ok
            True
        """
        return cls(ok=True, sessions=list(sessions), reason=reason, detail=detail)

    @classmethod
    def unavailable(cls, reason: str, detail: Optional[str] = None) -> "TmuxListing":
        """Build a "could not evaluate" result. Never carries rows.

        Inputs:
            reason (str): why we could not answer (``tmux_missing``,
                ``timeout``, ``exit_2``, ``probe_error``).
            detail (Optional[str]): human-readable text for the log.

        Output:
            TmuxListing: with ``ok=False`` and ``sessions=[]``.

        Example:
            >>> TmuxListing.unavailable('timeout').ok
            False
        """
        return cls(ok=False, sessions=[], reason=reason, detail=detail)

    @property
    def names(self) -> List[str]:
        """The session names, whether the rows are strings or dicts.

        Inputs: none.

        Output:
            List[str]: names from ``sessions``. Empty whenever ``ok`` is
                False, because an unavailable listing has no rows to
                name - callers must still check ``ok`` before acting on
                the emptiness.

        Example:
            >>> TmuxListing.answered([{'name': 'a'}]).names
            ['a']
        """
        out: List[str] = []
        for row in self.sessions:
            if isinstance(row, str):
                out.append(row)
            elif isinstance(row, dict):
                name = row.get("name")
                if isinstance(name, str) and name:
                    out.append(name)
        return out

    def status_payload(self) -> dict:
        """The wire form of the outcome, for API responses and the client.

        Inputs: none.

        Output:
            dict: ``{"listing_ok": bool, "listing_reason": str|None,
                "listing_detail": str|None}``.

        Example:
            >>> TmuxListing.unavailable('timeout').status_payload()
            {'listing_ok': False, 'listing_reason': 'timeout', 'listing_detail': None}
        """
        return {
            "listing_ok": self.ok,
            "listing_reason": self.reason,
            "listing_detail": self.detail,
        }


    def row_status_payload(self) -> dict:
        """The per-ROW provenance fields for the API response model.

        Narrower than :meth:`status_payload` on purpose: a row that
        exists came out of a listing that ran, so it carries only the
        two fields ``AttachableSession`` declares and never the stderr
        detail, which belongs to the listing and not to any one row.

        Inputs: none.

        Output:
            dict: ``{"listing_ok": bool, "listing_reason": str|None}``.

        Example:
            >>> TmuxListing.answered([], reason='no_server').row_status_payload()
            {'listing_ok': True, 'listing_reason': 'no_server'}
        """
        return {"listing_ok": self.ok, "listing_reason": self.reason}


def coerce_listing(value: Any) -> TmuxListing:
    """Accept a TmuxListing or a legacy bare list, return a TmuxListing.

    Consumers that duck-type a session manager (``status_routes`` probes
    with ``getattr``, and several test doubles return plain lists) would
    otherwise have to branch on the type at every call site. Coercing a
    bare list to ``ok=True`` is correct: a caller that hands us a literal
    list is asserting it HAS the answer. ``None`` is not an answer and
    becomes ``ok=False``.

    Inputs:
        value (Any): a ``TmuxListing``, a sequence of rows, or None.

    Output:
        TmuxListing: ``value`` unchanged when it already is one.

    Example:
        >>> coerce_listing([{'name': 'a'}]).ok
        True
        >>> coerce_listing(None).reason
        'probe_error'
    """
    if isinstance(value, TmuxListing):
        return value
    if value is None:
        return TmuxListing.unavailable(
            REASON_PROBE_ERROR, detail="listing source returned None"
        )
    if isinstance(value, (list, tuple)):
        return TmuxListing.answered(list(value))
    return TmuxListing.unavailable(
        REASON_PROBE_ERROR, detail=f"unusable listing type {type(value).__name__}"
    )
