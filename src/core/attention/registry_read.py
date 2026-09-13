"""Read Claude Code's own session registry, ``~/.claude/sessions/<pid>.json``.

STOCK CLAUDE CODE WRITES THIS FILE. We install nothing to get it, which is
the whole point: the app asks the harness nothing and posts nothing back.
It is rewritten on every change of ``(status, waitingFor)`` with no
throttle, unlinked on a clean exit, and left behind by a crash for the
next claude's startup sweep. Verified in the 2.1.266 binary on 2026-09-13;
the documented ``claude agents --json`` prints the same data, which is the
cross-check this module can be judged against.

IT IS UNDOCUMENTED, SO THIS READER REFUSES IN THREE WAYS AND NEVER
GUESSES. Every wrong answer here becomes a toast on a phone. Four
verdicts, and only ONE of them is knowledge:

    REG_OK          a record was read and it is about the session asked for
    REG_ABSENT      we looked and there is no record for this session
    REG_STALE       a record exists but it is about a DIFFERENT run
    REG_UNREADABLE  something was there and it could not be trusted

The three refusals stay apart for the reason ``claude_title_sync`` keeps
its ``TAIL_*`` outcomes apart: "looked and found nothing" and "could not
look" are different facts, and spelling them the same way is how a false
green ships.

UNMEASURED IS NOT DEAD. :func:`pid_is_running` is tri-state, the same
discipline ``PaneDeadError`` carries for panes: a probe that RAN and said
gone is a measured death, a probe that could not run is None, and a pid we
are not allowed to signal EXISTS.

WRITE-ON-CHANGE MEANS STALE-BUT-TRUE. A two-day-old ``statusUpdatedAt`` is
a session that genuinely has not changed status in two days, so age is NOT
a refusal here. :data:`REGISTRY_STALE_AFTER_SECONDS` is exported for the
resolver, which applies it one-way: an old record may SUSTAIN a verdict,
never ORIGINATE "done". A reader that downgraded it quietly would take
that choice away from the only layer that can make it.

TWO LIVE RECORDS ON ONE PANE ARE A REFUSAL, NOT A TIE-BREAK. There is no
honest way to pick one, so the key answers :data:`REG_UNREADABLE` naming
both pids. Picking the newer would be right most of the time, and the
times it was wrong would be invisible.

AN UNKNOWN ``status`` STRING IS KEPT VERBATIM. Four values have been seen
and a future claude may write a fifth. Coercing it would invent a state
and dropping it would lose the news, so it is carried through with the
verdict still :data:`REG_OK` and the resolver decides what it means.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

# ---------------------------------------------------------------------
# Verdicts. FOUR, three of them refusals, never collapsed into a bool.
# ---------------------------------------------------------------------

#: A record was read, parsed, and belongs to the session asked about. The
#: ONLY verdict under which any other field may be believed.
REG_OK: str = "ok"

#: The registry was read and holds no record for this session. A DEFINITE
#: negative, and not a claim the session is dead: a claude parked on its
#: folder-trust dialog has not registered yet.
REG_ABSENT: str = "absent"

#: A record exists but is about a DIFFERENT run of this pane: pid
#: measurably gone, started before the tmux session we asked about, or
#: naming a conversation that is not ours.
REG_STALE: str = "stale"

#: Something was there and could not be trusted: unreadable bytes, json
#: that does not parse, an object with no pid or no status, or two live
#: records claiming one pane. NEVER a synonym for absent.
REG_UNREADABLE: str = "unreadable"

# ---------------------------------------------------------------------
# The status values claude writes, read out of the 2.1.266 binary:
# ``waitingFor !== undefined -> "waiting"``, else
# ``isLoading || delegatedActive ? "busy" : "idle"``; ``shell`` is idle
# plus a non-terminal ``local_bash`` task.
# ---------------------------------------------------------------------

#: At the prompt with nothing running.
REG_IDLE: str = "idle"

#: Streaming, running a tool, or waiting on its own delegated agents. It
#: HOLDS while only background agents run, which is the single fact this
#: whole feature was built to get.
REG_BUSY: str = "busy"

#: Blocked on a dialog the user has to answer. ``waiting_for`` says which
#: family: ``input needed``, ``permission prompt``, ``sandbox request``,
#: ``worker request``, ``dialog open``.
REG_WAITING: str = "waiting"

#: Idle apart from a shell command the user started.
REG_SHELL: str = "shell"

# ---------------------------------------------------------------------
# Bounds and floors.
# ---------------------------------------------------------------------

#: The first claude that writes ``pendingBackgroundAgentCount`` into the
#: turn-end record. Below this the field is not absent, it is not written
#: at all, and reading its absence as zero is the exact false green this
#: feature exists to remove. See :attr:`RegistryRecord.trusts_pending_count`.
MIN_PENDING_VERSION: Tuple[int, int, int] = (2, 1, 241)

#: How old a ``statusUpdatedAt`` has to be before the RESOLVER treats the
#: record as stale-but-true. NOT applied here: see the module docstring.
REGISTRY_STALE_AFTER_SECONDS: int = 900

#: Where claude writes the registry, relative to the home directory.
REGISTRY_DIRNAME: str = os.path.join(".claude", "sessions")

#: How many ``*.json`` files one scan opens. The real directory holds ten
#: sub-1KB files; the bound keeps a directory that has gone wrong costing
#: a bounded amount of time.
DEFAULT_SCAN_LIMIT: int = 128

#: How much of one registry file is read. Real files are under 1 KB. A
#: bigger one reads as truncated json and lands on :data:`REG_UNREADABLE`,
#: the right answer for a file that is not the shape we were promised.
MAX_REGISTRY_FILE_BYTES: int = 64 * 1024

#: Prefix for the synthetic index keys carrying a file we could not parse.
#: tmux forbids ``:`` in a session name, so these can never be hit by a
#: real lookup or shadow one. They exist so a caller that iterates SEES
#: the refusals instead of a scan that quietly returned fewer rows than
#: there were files.
UNREADABLE_KEY_PREFIX: str = "?unreadable:"


@dataclass(frozen=True)
class RegistryRecord:
    """One answer about one session's registry entry, verdict first.

    Every field other than ``verdict`` and ``detail`` is ``Optional``, and
    ``None`` means "not known", never "zero" and never "no". Nothing here
    may be believed unless ``verdict`` is :data:`REG_OK`, which is what
    :attr:`known` is for: reading ``record.status`` without checking the
    verdict is how a refusal becomes a confident wrong answer.
    """

    #: :data:`REG_OK`, :data:`REG_ABSENT`, :data:`REG_STALE` or
    #: :data:`REG_UNREADABLE`.
    verdict: str

    #: ``status`` verbatim. An unrecognised string is KEPT, not coerced.
    status: Optional[str]

    #: ``waitingFor`` verbatim, present only while ``status`` is waiting.
    waiting_for: Optional[str]

    #: The claude process id, from the file's own ``pid`` when that is an
    #: int, otherwise from the filename.
    pid: Optional[int]

    #: ``sessionId``, the conversation uuid: the value
    #: ``sessions.claude_session_uuid`` holds and ``--resume`` takes.
    session_uuid: Optional[str]

    #: The tmux SESSION name, already split off the ``tmux`` pane target.
    tmux_name: Optional[str]

    #: ``cwd`` verbatim, NOT realpath-ed: canonicalising is the caller's
    #: join rule, and doing it here would hide which spelling was on disk
    #: (gotcha 6).
    cwd: Optional[str]

    #: ``statusUpdatedAt`` as an aware UTC datetime.
    status_updated_at: Optional[datetime]

    #: ``startedAt`` as an aware UTC datetime: when THIS claude process
    #: registered, which is the instance floor.
    started_at: Optional[datetime]

    #: ``version`` as a comparable tuple, e.g. ``(2, 1, 266)``.
    version: Optional[Tuple[int, ...]]

    #: Why this verdict, in plain words, for logs and test failures.
    #: Empty on the happy path.
    detail: str

    @property
    def known(self) -> bool:
        """Is anything in this record safe to read?

        Description: the one guard every consumer goes through, true for
            exactly one of the four verdicts.
        Inputs: none beyond ``self``.
        Output: bool - True only when ``verdict`` is :data:`REG_OK`.
        Example:
            >>> _empty_record(REG_ABSENT, "").known
            False
        """
        return self.verdict == REG_OK

    @property
    def trusts_pending_count(self) -> bool:
        """May the transcript's background-agent count be believed?

        Description: the version gate. Below :data:`MIN_PENDING_VERSION`
            the turn-end record carries no ``pendingBackgroundAgentCount``
            at all, so its absence says nothing; a version we could not
            parse is not evidence of a new enough claude. Both answer
            False, sending the resolver to the async ledger instead of to
            a count that is not there.
        Inputs: none beyond ``self``.
        Output: bool - True only for a parsed version at or above the
            floor.
        Example:
            >>> parse_registry_record(
            ...     {"pid": 1, "status": "idle", "version": "2.1.240"},
            ...     path_pid=None).trusts_pending_count
            False
        """
        if self.version is None:
            return False
        return self.version >= MIN_PENDING_VERSION


def _empty_record(
    verdict: str, detail: str, *, tmux_name: Optional[str] = None
) -> RegistryRecord:
    """Build a record carrying a refusal and no facts.

    Description: the single constructor for every non-OK answer, so a
        refusal can never ship a half-populated field a caller then reads.
    Inputs:
        verdict: one of the three refusal verdicts.
        detail: why, in plain words.
        tmux_name: the key that was asked about, when there is one. An
            echo of the QUESTION, not a fact read off disk.
    Output: RegistryRecord with every fact None.
    """
    return RegistryRecord(
        verdict=verdict,
        status=None,
        waiting_for=None,
        pid=None,
        session_uuid=None,
        tmux_name=tmux_name,
        cwd=None,
        status_updated_at=None,
        started_at=None,
        version=None,
        detail=detail,
    )


def tmux_session_of(target: Optional[str]) -> Optional[str]:
    """Split the tmux SESSION name off a pane target.

    Description: the registry writes ``tmux`` as
        ``<session>:@<window>.%<pane>`` and the app stores the bare
        session name in ``sessions.tmux_session``. The join is an exact
        string match on this, not a prefix or a fuzzy compare. tmux
        forbids ``:`` in a session name, so the LAST colon is
        unambiguously the separator; ``rpartition`` rather than ``split``
        so a shape we have never seen cannot silently become its own
        first fragment.
    Inputs:
        target: the ``tmux`` field, or None when the record has none (a
            claude not running under tmux at all).
    Output:
        str | None - the session name, or None when there is no target,
        it is empty, or it carries no colon and so is not a pane target
        in the shape we were promised.
    Example:
        >>> tmux_session_of("cloude_foo:@205.%205")
        'cloude_foo'
        >>> tmux_session_of("no-colon-here") is None
        True
    """
    if not isinstance(target, str):
        return None
    head, separator, _tail = target.rpartition(":")
    if not separator:
        return None
    head = head.strip()
    return head or None


def _epoch_millis_to_datetime(value: Any) -> Optional[datetime]:
    """Convert one of claude's millisecond timestamps to an aware UTC datetime.

    Description: covers ``startedAt``, ``updatedAt`` and
        ``statusUpdatedAt``, all epoch MILLISECONDS ints. ``procStart`` is
        a human string like ``Mon Aug 24 16:06:45 2026`` and is
        deliberately NOT parsed anywhere here: it is locale- and
        timezone-shaped, and the one job it could do (telling pid reuse
        apart) is named in the plan as a future upgrade rather than
        something to guess at now. ``bool`` is rejected explicitly
        because it is an ``int`` subclass and ``True`` would become 1970.
    Inputs:
        value: whatever was on the key, of any type.
    Output:
        datetime | None - aware UTC, or None when missing, not an int, or
        out of range for a datetime.
    Example:
        >>> _epoch_millis_to_datetime(1789095742551).year
        2026
        >>> _epoch_millis_to_datetime("nope") is None
        True
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    try:
        return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _parse_version(value: Any) -> Optional[Tuple[int, ...]]:
    """Turn ``"2.1.266"`` into ``(2, 1, 266)``.

    Description: strict on purpose. Every segment must be all digits, so
        a pre-release or a shape we have not seen answers None rather
        than a tuple that sorts somewhere arbitrary, and None is a
        refusal the version gate already knows how to handle.
    Inputs:
        value: the ``version`` field, of any type.
    Output:
        tuple[int, ...] | None - None when missing, not a string, empty,
        or carrying a non-numeric segment.
    Example:
        >>> _parse_version("2.1.266")
        (2, 1, 266)
        >>> _parse_version("2.1.266-beta.1") is None
        True
    """
    if not isinstance(value, str):
        return None
    parts = value.strip().split(".")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _optional_text(value: Any) -> Optional[str]:
    """Keep a non-empty string, refuse everything else.

    Description: ABSENT IS NOT A DEFAULT. A missing key, a null, a number
        and a whitespace-only string all answer None, and none of them
        becomes ``""`` - an empty string reads like a value the caller
        can compare, and it is not one.
    Inputs:
        value: whatever was on the key, of any type.
    Output: str | None - the stripped string, or None.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def parse_registry_record(raw: Any, *, path_pid: Optional[int]) -> RegistryRecord:
    """Turn one decoded registry file into a record. Pure, never raises.

    Description: every key is optional and every type is doubted, because
        the file's shape is a fact about a binary we do not control. Two
        rules decide whether there is a record here at all.

        THE PID IS THE ANCHOR. Without one there is no liveness to
        measure, so a file with no usable pid is :data:`REG_UNREADABLE`.
        The file's own ``pid`` WINS over the filename when it is an int,
        because the content is what the writer meant; they have never
        been seen to disagree, and if they ever do the disagreement is
        recorded in ``detail`` rather than hidden.

        THE STATUS IS THE NEWS. A file with no ``status`` string carries
        nothing this feature can use, so it too is
        :data:`REG_UNREADABLE`. That is what makes the all-fields-missing
        case a refusal instead of an accidental ``idle``, which would be
        the worst failure available: a confident "done" about a session
        we know nothing about.

        An unrecognised ``status`` string is NOT one of those cases. It
        is kept verbatim, the verdict stays :data:`REG_OK`, and the
        resolver decides what it means.
    Inputs:
        raw: the decoded json, which SHOULD be a dict and may be anything.
        path_pid: the pid parsed out of the filename, or None when the
            filename was not a number. Used only as a fallback.
    Output:
        RegistryRecord - :data:`REG_OK` with fields populated, or
        :data:`REG_UNREADABLE` with every fact None and a detail saying
        what was missing. Never :data:`REG_ABSENT` or :data:`REG_STALE`:
        those are judgements about a session, and this function is only
        looking at bytes.
    Example:
        >>> parse_registry_record({}, path_pid=None).verdict == REG_UNREADABLE
        True
        >>> parse_registry_record({"pid": 7, "status": "idle"},
        ...                       path_pid=None).status
        'idle'
    """
    if not isinstance(raw, dict):
        return _empty_record(
            REG_UNREADABLE,
            "registry file is not a json object, it is " + type(raw).__name__,
        )

    file_pid = raw.get("pid")
    pid: Optional[int]
    pid_note = ""
    if isinstance(file_pid, int) and not isinstance(file_pid, bool):
        pid = file_pid
        if path_pid is not None and path_pid != file_pid:
            pid_note = (
                "pid in the file (%d) disagrees with the filename (%d), "
                "the file wins" % (file_pid, path_pid)
            )
    else:
        pid = path_pid

    if pid is None:
        return _empty_record(
            REG_UNREADABLE,
            "registry file carries no usable pid, in its content or its name",
        )

    status = _optional_text(raw.get("status"))
    if status is None:
        return _empty_record(
            REG_UNREADABLE, "registry file for pid %d carries no status" % pid
        )

    return RegistryRecord(
        verdict=REG_OK,
        status=status,
        waiting_for=_optional_text(raw.get("waitingFor")),
        pid=pid,
        session_uuid=_optional_text(raw.get("sessionId")),
        tmux_name=tmux_session_of(raw.get("tmux")),
        cwd=_optional_text(raw.get("cwd")),
        status_updated_at=_epoch_millis_to_datetime(raw.get("statusUpdatedAt")),
        started_at=_epoch_millis_to_datetime(raw.get("startedAt")),
        version=_parse_version(raw.get("version")),
        detail=pid_note,
    )


def pid_is_running(pid: Optional[int]) -> Optional[bool]:
    """Is this process alive? TRI-STATE, because unmeasured is not dead.

    Description: signal 0 performs the permission and existence checks
        and delivers nothing.

        ``PermissionError`` means the process EXISTS and belongs to
        somebody else, which is True, not False. The legacy
        ``PTYSession.is_alive`` folds that case into False and can afford
        to, because it only ever asks about its own children; this one
        reads other users' claudes, so folding it would report a running
        session as dead and paint a red light over live work.

        A pid at or below zero is refused WITHOUT calling ``os.kill``: 0
        means every process in my process group and a negative value
        means a process group, so a garbage pid must never reach the
        syscall.
    Inputs:
        pid: the process id, or None when there is none to check.
    Output:
        bool | None - True when the process exists, False when the probe
        RAN and the process is gone, None when there was nothing to
        measure or the measurement itself failed. None is never a synonym
        for False and the caller must not treat it as one.
    Example:
        >>> pid_is_running(os.getpid())
        True
        >>> pid_is_running(None) is None
        True
    """
    if pid is None or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # EINVAL and friends: a probe that could not answer. Refuse
        # rather than guess, per the docstring.
        return None
    return True


def default_registry_directory() -> str:
    """Where claude writes the registry on this machine.

    Description: split out so tests never touch the real directory and a
        caller can override it without a monkeypatch.
    Inputs: none.
    Output: str - ``~/.claude/sessions``, expanded.
    """
    return os.path.join(os.path.expanduser("~"), REGISTRY_DIRNAME)


def _pid_from_filename(name: str) -> Optional[int]:
    """Read the pid out of a ``<pid>.json`` filename.

    Description: the fallback anchor when the file's own ``pid`` is
        missing or the wrong type.
    Inputs:
        name: the basename, e.g. ``"51292.json"``.
    Output: int | None - None when the stem is not all digits.
    """
    stem = name[: -len(".json")]
    return int(stem) if stem.isdigit() else None


def _load_registry_file(path: str, name: str) -> RegistryRecord:
    """Read and parse one registry file, refusing rather than raising.

    Description: the I/O half, kept separate from
        :func:`parse_registry_record` so the parsing rules can be tested
        on dicts alone. Every failure a file has - gone between the
        scandir and the open, unreadable bytes, torn or truncated json, a
        file past the bound - lands on :data:`REG_UNREADABLE` with a
        detail naming which, and none of them stops the scan.
    Inputs:
        path: absolute path to the file.
        name: its basename, for the pid fallback and the detail text.
    Output: RegistryRecord, :data:`REG_OK` or :data:`REG_UNREADABLE`.
    """
    try:
        with open(path, "rb") as handle:
            blob = handle.read(MAX_REGISTRY_FILE_BYTES)
    except OSError as exc:
        return _empty_record(REG_UNREADABLE, "cannot read %s: %s" % (name, exc))

    try:
        raw = json.loads(blob.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        # A torn write is normal: claude rewrites this file on every
        # status change and we read it without a lock. The NEXT scan gets
        # the whole file, so one bad read is a refusal, not an error.
        return _empty_record(REG_UNREADABLE, "cannot parse %s: %s" % (name, exc))

    return parse_registry_record(raw, path_pid=_pid_from_filename(name))


def read_registry_index(
    directory: Optional[str] = None,
    *,
    limit: int = DEFAULT_SCAN_LIMIT,
) -> Mapping[str, RegistryRecord]:
    """Scan the registry directory and key every record by tmux session name.

    Description: one bounded scandir plus one small read per file, and no
        raise on any path.

        DECIDED HERE: a record whose pid is measurably gone is
        :data:`REG_STALE`, the one refusal settleable without knowing
        which session is being asked about. A pid we could not measure
        stays :data:`REG_OK` - unmeasured is not dead.

        DECIDED HERE: two records that are both live and name one tmux
        session collapse to a single :data:`REG_UNREADABLE` entry naming
        every pid involved. The resolver's rung 1 refuses on it and
        raises nothing.

        NOT DECIDED HERE: age. An old ``statusUpdatedAt`` is recorded as
        :data:`REG_OK` and left to the caller, because claude writes this
        file on change and an old timestamp is a true statement about a
        session that has not moved.

        NOT DECIDED HERE: whose session it is. A record belonging to
        somebody else's tmux server is keyed under whatever name it
        carries and simply never matches a lookup. A record with no
        parseable tmux target has no key and is dropped: it cannot be
        about a session this app owns.

        Files we could not parse are keyed under
        :data:`UNREADABLE_KEY_PREFIX` plus their filename so an iterating
        caller sees them. Those keys contain a colon, which tmux forbids
        in a session name, so they can never collide with a real one.
    Inputs:
        directory: the registry directory. Defaults to
            :func:`default_registry_directory`.
        limit: how many ``*.json`` files to open, sorted by filename so
            the bound is deterministic rather than filesystem-ordered.
    Output:
        Mapping[str, RegistryRecord] - possibly empty. A missing,
        unreadable or not-a-directory path answers an EMPTY MAPPING and
        raises nothing; every lookup against it then answers
        :data:`REG_ABSENT`, which is already a refusal the resolver
        cannot turn into "done".
    Example:
        >>> dict(read_registry_index("/nonexistent/registry/path"))
        {}
    """
    base = directory if directory is not None else default_registry_directory()

    try:
        names = sorted(
            entry.name
            for entry in os.scandir(base)
            if entry.name.endswith(".json") and entry.is_file()
        )
    except OSError:
        # Missing, not a directory, or not ours to list. The contract is
        # an empty mapping, not an exception: see the docstring.
        return {}

    index: Dict[str, RegistryRecord] = {}
    live_pids: Dict[str, List[Optional[int]]] = {}

    for name in names[:limit]:
        record = _load_registry_file(os.path.join(base, name), name)

        if record.verdict == REG_UNREADABLE:
            index[UNREADABLE_KEY_PREFIX + name] = record
            continue

        if pid_is_running(record.pid) is False:
            record = _empty_record(
                REG_STALE,
                "pid %s in %s is not running" % (record.pid, name),
                tmux_name=record.tmux_name,
            )

        key = record.tmux_name
        if key is None:
            # Not under tmux, so nothing in this app can ever ask about it.
            continue

        if record.verdict == REG_OK:
            seen = live_pids.setdefault(key, [])
            seen.append(record.pid)
            if len(seen) > 1:
                index[key] = _empty_record(
                    REG_UNREADABLE,
                    "two or more live registry records name tmux session %s: pids %s"
                    % (key, ", ".join(str(pid) for pid in seen)),
                    tmux_name=key,
                )
                continue

        existing = index.get(key)
        if existing is None or (record.verdict == REG_OK and existing.verdict != REG_OK):
            index[key] = record

    return index


def registry_for_session(
    *,
    tmux_name: Optional[str],
    index: Optional[Mapping[str, RegistryRecord]] = None,
    directory: Optional[str] = None,
    session_started_epoch: Optional[int] = None,
    claude_session_uuid: Optional[str] = None,
) -> RegistryRecord:
    """What does the registry say about THIS session, and may we believe it?

    Description: the lookup plus the two identity gates that turn "a
        record exists under this name" into "a record about this run".
        tmux names are reused, so neither gate is optional.

        THE INSTANCE FLOOR. ``session_started_epoch`` is the tmux
        session's own ``#{session_created}``, in SECONDS, the identity
        ``UnreadStore.compose_key`` and ``sessions.tmux_created_epoch``
        already use. A registry record that started BEFORE the tmux
        session it claims to be in cannot be about this run, so it is
        :data:`REG_STALE`. A restart in place does not move the tmux
        epoch and does make a newer claude, so this gate passes exactly
        the case the user calls "restart" and rejects exactly the case
        where a name came back on a new session.

        THE CONVERSATION GATE, AND WHY IT IS ONE-SIDED. Our
        ``claude_session_uuid`` column may be empty or behind, since
        until this feature it had a single one-shot writer, so a record
        whose ``sessionId`` we cannot compare is NOT refused. Only two
        non-empty values that DISAGREE are a refusal, and that is
        unambiguous: two conversations cannot both be the one in this
        pane.

        A refusal that arrived from the index - stale pid, ambiguous
        pane, unparseable file - is returned unchanged. It is already an
        answer, and re-judging it here could only make it weaker.
    Inputs:
        tmux_name: the bare tmux session name from
            ``sessions.tmux_session``. None or empty answers
            :data:`REG_ABSENT`.
        index: a mapping from a previous :func:`read_registry_index`,
            when one scan is shared across many sessions. When None, one
            scan is done here.
        directory: passed to :func:`read_registry_index` when ``index``
            is None.
        session_started_epoch: the tmux session's creation time in epoch
            SECONDS, or None to skip the instance floor.
        claude_session_uuid: the conversation uuid the app has on this
            row, or None to skip the conversation gate.
    Output:
        RegistryRecord - :data:`REG_OK` only when a record was found
        under this name AND survived both gates. Never None.
    Example:
        >>> registry_for_session(tmux_name=None).verdict == REG_ABSENT
        True
    """
    if not tmux_name:
        return _empty_record(REG_ABSENT, "no tmux session name to look up")

    table = index if index is not None else read_registry_index(directory)
    record = table.get(tmux_name)
    if record is None:
        return _empty_record(
            REG_ABSENT,
            "no registry record names tmux session %s" % tmux_name,
            tmux_name=tmux_name,
        )

    if record.verdict != REG_OK:
        return record

    if session_started_epoch is not None and record.started_at is not None:
        floor = _epoch_millis_to_datetime(int(session_started_epoch) * 1000)
        if floor is not None and record.started_at < floor:
            return _empty_record(
                REG_STALE,
                "registry record for %s started %s, before the tmux session it "
                "claims (%s), so it belongs to a previous instance"
                % (tmux_name, record.started_at.isoformat(), floor.isoformat()),
                tmux_name=tmux_name,
            )

    if claude_session_uuid and record.session_uuid:
        if claude_session_uuid != record.session_uuid:
            return _empty_record(
                REG_STALE,
                "registry record for %s names conversation %s, the row holds %s"
                % (tmux_name, record.session_uuid, claude_session_uuid),
                tmux_name=tmux_name,
            )

    return record
