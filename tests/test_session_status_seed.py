"""A resting claude must read idle, and a session with no evidence must not.

WHAT WAS MEASURED. On live 2026-09-08 22:24Z: 19 live panes, 15 of them
painting ``unknown``. ``SessionActivityTracker`` is in-memory and nothing
hydrates it at boot or at adopt, so after a restart every session falls to
``map_tmux_fallback``, which answers ``unknown`` for any pane running
claude. Ten of the 15 had NEVER fired a hook and never will - started by
hand without the hook environment, their last assistant turns dated
2026-07-16 and 2026-08-24, alive at an idle prompt for weeks. The owner's
complaint, verbatim: "on the homepage and sidebar many status unknown."

THE CLAIM UNDER TEST IS ASYMMETRIC, and every negative here defends that
asymmetry rather than merely covering a branch. The ladder may claim REST
from durable dated evidence. It may NEVER claim WORK, because a file
carries no heartbeat: a ``working`` seeded from one could never be
expired, so it would be permanent the moment it was wrong. That is the
identical defect that had a raw tmux ``running`` painting 15 sessions
busy on no evidence, and this suite exists to stop it being reintroduced
one rung lower down.

THE NEGATIVE CONTROLS ARE THE LOAD-BEARING TESTS. A ladder that always
finds something is worse than useless - it would pass every positive here
perfectly while painting a false green on the exact sessions the user
needs to act on. So:

  - a STALE ``working`` row must not seed working, while a stale ``idle``
    row must still seed idle (rest does not rot; a claim about now does)
  - a user prompt, and an assistant that stopped to call a tool, must
    seed NOTHING
  - an UNREADABLE transcript must refuse, never round down to idle
  - a MEASURED absent transcript must refuse for a DIFFERENT, named
    reason - "could not look" is not "looked and it is gone"
  - a SIDECHAIN end_turn must not seed idle: that is a subagent
    finishing inside a turn that is still running
  - the NEWEST decidable record must win, or an old end-of-turn would
    pin a busy session at idle forever

SAFETY. Hermetic. ``$HOME`` is redirected under ``tmp_path`` so nothing
here reads the developer's real transcript corpus, every database is
under ``tmp_path``, and no tmux socket is opened.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import tempfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import structlog

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sss_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sss_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.activity_persist import utc_now_iso, write_state
from src.core.claude_transcript_correlate import slugify_project_dir
from src.core.db import connect, db_path_for
from src.core.session_activity import EVENT_PRE_TOOL_USE
from src.core.session_status import (
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_QUESTION,
    STATUS_UNKNOWN,
    STATUS_WORKING,
)
from src.core.session_status_seed import (
    SEED_REFRESH_INTERVAL_SECONDS,
    SEED_RUNG_NONE,
    SEED_RUNG_ROW,
    SEED_RUNG_TRANSCRIPT,
    TAIL_ABSENT,
    TAIL_AT_REST,
    TAIL_IN_FLIGHT,
    TAIL_NO_MARKER,
    TAIL_UNREADABLE,
    StatusSeed,
    TranscriptRest,
    classify_record,
    classify_tail_records,
    display_state,
    resolve_status_seed,
)
from src.core.session_status_seed_read import (
    derive_seed,
    read_instance_row,
    read_transcript_rest,
    seed_live_sessions,
    seeded_status,
    seeds_for,
)
from src.core.session_status_seed_store import SessionStatusSeeds

NOW = datetime(2026, 9, 8, 22, 24, 0, tzinfo=timezone.utc)
UUID = "c2e5255b-bf71-449d-9799-57e5bd0371c1"


# --------------------------------------------------------------------- #
# record builders - the shapes verified against the live corpus
# --------------------------------------------------------------------- #


def turn_duration(ts="2026-09-04T19:39:04.864Z"):
    """A system record claude writes when a turn COMPLETES.

    Inputs: ts (str). Output: dict - one jsonl record.
    """
    return {"type": "system", "subtype": "turn_duration", "timestamp": ts,
            "isSidechain": False}


def stop_hook_summary(ts="2026-09-04T19:39:04.863Z"):
    """A system record claude writes once the Stop hook chain has run.

    Inputs: ts (str). Output: dict.
    """
    return {"type": "system", "subtype": "stop_hook_summary", "timestamp": ts,
            "isSidechain": False}


def assistant(stop_reason, ts="2026-09-04T19:38:58.240Z", sidechain=False):
    """An assistant record with a given ``message.stop_reason``.

    Inputs: stop_reason (str). ts (str). sidechain (bool).
    Output: dict.
    """
    return {
        "type": "assistant",
        "timestamp": ts,
        "isSidechain": sidechain,
        "message": {"role": "assistant", "stop_reason": stop_reason,
                    "content": [{"type": "text", "text": "hi"}]},
    }


def user_prompt(text="do the thing", ts="2026-09-04T19:38:00.000Z"):
    """A user record: the prompt that opens a turn.

    Inputs: text (str). ts (str). Output: dict.
    """
    return {
        "type": "user",
        "timestamp": ts,
        "isSidechain": False,
        "message": {"role": "user", "content": text},
    }


def tool_result(ts="2026-09-04T19:38:26.989Z"):
    """A user record carrying a tool_result: a turn mid-flight.

    Inputs: ts (str). Output: dict.
    """
    return {
        "type": "user",
        "timestamp": ts,
        "isSidechain": False,
        "message": {"role": "user",
                    "content": [{"type": "tool_result", "content": "ok"}]},
    }


def local_command(ts="2026-09-04T22:04:59.794Z"):
    """The system record claude writes for a slash command it handled itself.

    Inputs: ts (str). Output: dict.
    """
    return {"type": "system", "subtype": "local_command", "timestamp": ts,
            "isSidechain": False}


def command_envelope(ts="2026-09-04T22:04:59.792Z"):
    """The pseudo-user record claude writes ABOUT a slash command.

    Description: verbatim shape from the live corpus. The model never saw
      it - the caveat envelope beside it says "DO NOT respond to these
      messages" - so it is not a prompt.
    Inputs: ts (str). Output: dict.
    """
    return {
        "type": "user",
        "timestamp": ts,
        "isSidechain": False,
        "message": {"role": "user",
                    "content": "<command-name>/rename</command-name> foo"},
    }


def noise():
    """Records the ladder must find UNDECIDABLE, from the live corpus.

    Inputs: none. Output: list[dict].
    """
    return [
        {"type": "file-history-snapshot"},
        {"type": "attachment", "timestamp": "2026-09-04T19:38:26.999Z"},
        {"type": "queue-operation", "timestamp": "2026-09-04T19:38:27.000Z"},
        {"type": "last-prompt"},
        {"type": "mode"},
        {"type": "custom-title", "customTitle": "x"},
    ]


# --------------------------------------------------------------------- #
# 1. RUNG B - the transcript tail. Positive.
# --------------------------------------------------------------------- #


@pytest.mark.parametrize("closer", [turn_duration(), stop_hook_summary(),
                                    assistant("end_turn"),
                                    assistant("stop_sequence")])
def test_a_tail_that_ends_a_turn_reads_at_rest(closer):
    """Every shape claude uses to close a turn is read as rest."""
    verdict = classify_tail_records([user_prompt(), closer])
    assert verdict.verdict == TAIL_AT_REST
    assert verdict.at is not None
    assert verdict.at.tzinfo is not None


def test_at_rest_seeds_idle_dated_by_the_record_that_decided_it():
    """Rung B seeds ``idle``, and carries the evidence's own timestamp."""
    tail = classify_tail_records([turn_duration("2026-09-04T19:39:04.864Z")])
    seed = resolve_status_seed(row_state=None, row_state_at=None, tail=tail,
                               now=NOW)
    assert seed.state == STATUS_IDLE
    assert seed.rung == SEED_RUNG_TRANSCRIPT
    assert seed.at == datetime(2026, 9, 4, 19, 39, 4, 864000,
                               tzinfo=timezone.utc)


def test_undecidable_noise_after_a_closer_does_not_hide_the_rest():
    """Bookkeeping records are walked past, not read as an answer."""
    records = [user_prompt(), turn_duration()] + noise()
    assert classify_tail_records(records).verdict == TAIL_AT_REST


# --------------------------------------------------------------------- #
# 2. RUNG B - NEGATIVE CONTROLS. Work may never be claimed from a file.
# --------------------------------------------------------------------- #


def test_a_user_prompt_tail_seeds_nothing():
    """A live turn is the hook layer's to report, and it seeds NOTHING.

    Seeding ``working`` here would be unexpirable: a file carries no
    heartbeat, so the claim could never be taken back.
    """
    tail = classify_tail_records([turn_duration(), user_prompt()])
    assert tail.verdict == TAIL_IN_FLIGHT
    seed = resolve_status_seed(row_state=None, row_state_at=None, tail=tail,
                               now=NOW)
    assert seed.state is None
    assert seed.rung == SEED_RUNG_NONE


def test_an_assistant_that_stopped_to_call_a_tool_seeds_nothing():
    """``stop_reason='tool_use'`` is mid-turn, not the end of one."""
    tail = classify_tail_records([turn_duration(), assistant("tool_use")])
    assert tail.verdict == TAIL_IN_FLIGHT
    assert resolve_status_seed(row_state=None, row_state_at=None,
                               tail=tail).state is None


def test_a_tool_result_tail_seeds_nothing():
    """A ``tool_result`` user record continues a turn."""
    assert classify_tail_records([tool_result()]).verdict == TAIL_IN_FLIGHT


def test_the_newest_decidable_record_wins():
    """An OLD end-of-turn may never outrank a NEWER prompt.

    A ladder that met the closer first would pin a busy session at idle
    for the life of the process - the same stale-evidence trap the
    startup gate avoids by reading a hook before the scrollback.
    """
    records = [turn_duration("2026-09-01T00:00:00Z"),
               user_prompt(ts="2026-09-08T22:00:00Z")]
    assert classify_tail_records(records).verdict == TAIL_IN_FLIGHT


def test_a_subagent_finishing_is_not_the_conversation_finishing():
    """A sidechain ``end_turn`` must not seed idle.

    It reports a SUBAGENT completing inside a turn that is still
    running, which is the longest kind of work there is. Reading it as
    rest would paint idle over exactly that.
    """
    records = [user_prompt(), assistant("end_turn", sidechain=True)]
    assert classify_tail_records(records).verdict == TAIL_IN_FLIGHT
    assert classify_record(assistant("end_turn", sidechain=True)) is None


def test_an_empty_window_answers_no_marker_not_at_rest():
    """"I looked at 64 KB and saw nothing" is not "there is nothing"."""
    assert classify_tail_records([]).verdict == TAIL_NO_MARKER
    assert classify_tail_records(noise()).verdict == TAIL_NO_MARKER
    assert resolve_status_seed(row_state=None, row_state_at=None,
                               tail=classify_tail_records([])).state is None


def test_an_unreadable_transcript_refuses_rather_than_answering_idle():
    """The whole point: a failed read is never rounded down to rest."""
    seed = resolve_status_seed(
        row_state=None, row_state_at=None,
        tail=TranscriptRest(TAIL_UNREADABLE, detail="permission denied"),
    )
    assert seed.state is None
    assert TAIL_UNREADABLE in (seed.detail or "")


def test_a_measured_absent_transcript_is_named_apart_from_an_unreadable_one():
    """Two refusals, two reasons. Only one of them is a measurement."""
    absent = resolve_status_seed(row_state=None, row_state_at=None,
                                 tail=TranscriptRest(TAIL_ABSENT))
    unreadable = resolve_status_seed(row_state=None, row_state_at=None,
                                     tail=TranscriptRest(TAIL_UNREADABLE))
    assert absent.state is None and unreadable.state is None
    assert absent.detail != unreadable.detail


def test_a_transcript_that_was_not_consulted_is_not_an_absent_one():
    """``tail=None`` means "did not look", and says so."""
    seed = resolve_status_seed(row_state=None, row_state_at=None, tail=None)
    assert seed.state is None
    assert "not consulted" in (seed.detail or "")


# --------------------------------------------------------------------- #
# 3. RUNG B - the local-command envelope. Measured on live.
# --------------------------------------------------------------------- #


def test_a_slash_command_is_not_a_prompt_and_the_walk_continues_past_it():
    """The fix the live measurement forced.

    Both sessions this ladder refused on 2026-09-08 were parked at an
    empty prompt, and both were refused because their newest ``user``
    record was a ``/rename`` envelope. claude intercepts slash commands
    before they become prompts (CLAUDE.md: no hook event carries one), so
    the model never saw it. The walk continues to a boundary claude
    really wrote.
    """
    records = [assistant("end_turn", ts="2026-09-04T22:04:00Z"),
               command_envelope(), local_command()]
    assert classify_tail_records(records).verdict == TAIL_AT_REST


def test_the_envelope_is_undecidable_and_never_rest_on_its_own():
    """The conservative half: it may skip a record, never assert one.

    With nothing but the envelope in the window the answer is
    ``no_marker``, so a slash command can never manufacture an idle.
    """
    assert classify_record(command_envelope()) is None
    assert classify_record(local_command()) is None
    assert classify_tail_records(
        [command_envelope(), local_command()]
    ).verdict == TAIL_NO_MARKER


def test_a_prompt_that_merely_mentions_the_tag_is_still_a_prompt():
    """Only the HEAD of the text is an envelope marker."""
    quoting = user_prompt(text="why does <command-name> break the ladder?")
    assert classify_record(quoting) is False


# --------------------------------------------------------------------- #
# 4. RUNG A - the row.
# --------------------------------------------------------------------- #


def test_a_fresh_row_state_seeds_itself():
    """Rung A answers first, and it outranks the transcript."""
    stamp = (NOW - timedelta(seconds=30)).isoformat()
    seed = resolve_status_seed(
        row_state=STATUS_QUESTION, row_state_at=stamp,
        tail=classify_tail_records([turn_duration()]), now=NOW,
    )
    assert seed.state == STATUS_QUESTION
    assert seed.rung == SEED_RUNG_ROW


def test_a_stale_working_row_does_not_seed_working():
    """THE CENTRAL NEGATIVE. A claim about now goes stale; rest does not.

    The row is evidence of the LAST known state. ``working`` describes a
    process that may have exited hours ago, so it is refused and the
    ladder drops to the transcript, which can only ever say rest.
    """
    stamp = (NOW - timedelta(hours=6)).isoformat()
    seed = resolve_status_seed(row_state=STATUS_WORKING, row_state_at=stamp,
                               tail=None, now=NOW)
    assert seed.state is None

    # And with a transcript to fall through to, it lands on idle - never
    # on the working the row was holding.
    seeded = resolve_status_seed(
        row_state=STATUS_WORKING, row_state_at=stamp,
        tail=classify_tail_records([turn_duration()]), now=NOW,
    )
    assert seeded.state == STATUS_IDLE
    assert seeded.rung == SEED_RUNG_TRANSCRIPT


@pytest.mark.parametrize("resting", [STATUS_IDLE, STATUS_FINISHED_UNREAD])
def test_a_stale_resting_row_still_seeds_itself(resting):
    """A session at rest does not stop resting by sitting still."""
    stamp = (NOW - timedelta(days=4)).isoformat()
    seed = resolve_status_seed(row_state=resting, row_state_at=stamp,
                               tail=None, now=NOW)
    assert seed.state == resting
    assert seed.rung == SEED_RUNG_ROW


@pytest.mark.parametrize("refused", [STATUS_DEAD, STATUS_UNKNOWN, None, ""])
def test_a_row_may_never_seed_dead_or_unknown(refused):
    """Only tmux can see a pane die, and unknown is not evidence."""
    seed = resolve_status_seed(row_state=refused, row_state_at=utc_now_iso(),
                               tail=None, now=NOW)
    assert seed.state is None


def test_a_perishable_state_with_no_readable_date_is_refused():
    """A number nobody can date cannot be judged, so it is not trusted."""
    seed = resolve_status_seed(row_state=STATUS_WORKING,
                               row_state_at="not a timestamp", tail=None,
                               now=NOW)
    assert seed.state is None


# --------------------------------------------------------------------- #
# 5. What a seed RENDERS as. Unread is read, never written.
# --------------------------------------------------------------------- #


def test_an_unread_resting_session_renders_finished_unread():
    """Mirrors the tail of ``SessionActivityTracker.resolve`` exactly."""
    assert display_state(StatusSeed(STATUS_IDLE), unread=True) == (
        STATUS_FINISHED_UNREAD
    )
    assert display_state(StatusSeed(STATUS_IDLE), unread=False) == STATUS_IDLE


def test_a_refusal_renders_as_nothing_at_all():
    """None means "keep what you had", which is ``unknown``."""
    assert display_state(StatusSeed(), unread=True) is None


# --------------------------------------------------------------------- #
# 6. The store: idempotence and the refresh clock.
# --------------------------------------------------------------------- #


def test_seeding_twice_leaves_the_same_state():
    """A seed is a READING, not an event, so repetition cannot drift."""
    store = SessionStatusSeeds()
    seed = StatusSeed(STATUS_IDLE, rung=SEED_RUNG_TRANSCRIPT)
    store.remember("s1", seed, now=NOW)
    store.remember("s1", seed, now=NOW)
    store.remember("s1", seed, now=NOW)
    assert store.get("s1") == seed
    assert store.due("s1", now=NOW) is False


def test_a_never_seeded_session_is_due_and_a_fresh_one_is_not():
    """The refresh clock, and only the clock. It holds no policy."""
    store = SessionStatusSeeds()
    assert store.due("never", now=NOW) is True
    store.remember("s1", StatusSeed(), now=NOW)
    assert store.due("s1", now=NOW) is False
    later = NOW + timedelta(seconds=SEED_REFRESH_INTERVAL_SECONDS + 1)
    assert store.due("s1", now=later) is True


def test_a_clock_that_ran_backwards_still_reads_due():
    """Re-deriving costs one bounded read; never re-deriving is the bug."""
    store = SessionStatusSeeds()
    store.remember("s1", StatusSeed(), now=NOW)
    assert store.due("s1", now=NOW - timedelta(hours=1)) is True


def test_a_refusal_cached_with_no_epoch_is_due_the_instant_one_is_known():
    """A CACHED REFUSAL IS NOT PERMANENT.

    MEASURED on live boot 2026-09-08 (the PT-IMC finding): a session's
    epoch was unset when its seed was first attempted, so the refusal
    was cached correctly at the time. Waiting out a full refresh
    interval on those grounds would be wrong the moment an epoch became
    known - the reason for the refusal is gone, not merely old.
    """
    store = SessionStatusSeeds()
    store.remember("s1", StatusSeed(), now=NOW, epoch=None)
    assert store.due("s1", now=NOW) is False, (
        "no epoch offered yet - the ordinary clock still applies"
    )
    assert store.due("s1", now=NOW, epoch=42) is True


def test_a_seed_cached_with_a_known_epoch_is_not_forced_due_by_the_same_epoch():
    """The epoch-known rule fires once, not on every call with an epoch."""
    store = SessionStatusSeeds()
    store.remember("s1", StatusSeed(STATUS_IDLE), now=NOW, epoch=42)
    assert store.due("s1", now=NOW, epoch=42) is False


def test_prune_drops_only_the_sessions_that_are_gone():
    """The cache stays bounded by the LIVE population."""
    store = SessionStatusSeeds()
    store.remember("live", StatusSeed(STATUS_IDLE), now=NOW)
    store.remember("gone", StatusSeed(STATUS_IDLE), now=NOW)
    assert store.prune(["live"]) == 1
    assert store.get("live") is not None
    assert store.get("gone") is None


# --------------------------------------------------------------------- #
# 7. The reads, against real files under a redirected HOME.
# --------------------------------------------------------------------- #


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    """A throwaway ``~/.claude/projects`` nothing else can see.

    Description: ``default_projects_dir()`` reads ``$HOME`` at CALL time,
      so redirecting it here keeps this suite off the developer's real
      19,065-file corpus.
    Inputs: tmp_path, monkeypatch.
    Output: Path - the projects root.
    """
    home = tmp_path / "home"
    projects = home / ".claude" / "projects"
    projects.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    return projects


def write_transcript(corpus, working_dir, uuid, records, age_seconds=3600):
    """Write a transcript where ``conversation_presence`` will find it.

    THE MTIME IS BACKDATED BY DEFAULT, and that is load-bearing. Rung 0
    of the ladder (``session_transcript_status``) reads the file's mtime
    and answers ``working`` for anything touched inside the heartbeat
    window, so a transcript written by a test is, correctly, a
    transcript that was just appended to. Every test in this file that
    is about the TAIL therefore ages the file out of that window first;
    a test about rung 0 passes ``age_seconds=0`` and says so.

    Inputs: corpus (Path). working_dir (str). uuid (str). records
      (list[dict]). age_seconds (int) - how far in the past to stamp the
      file's mtime; 0 leaves it at now.
    Output: Path - the transcript.
    """
    directory = corpus / slugify_project_dir(working_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid}.jsonl"
    path.write_text(
        "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8"
    )
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
    return path


def test_a_real_resting_transcript_reads_at_rest(corpus, tmp_path):
    """End to end over a real file: locate it, read the tail, classify."""
    wd = str(tmp_path / "proj")
    write_transcript(corpus, wd, UUID, [user_prompt(), assistant("end_turn"),
                                        turn_duration()])
    assert read_transcript_rest(UUID, wd).verdict == TAIL_AT_REST


def test_a_real_busy_transcript_reads_in_flight(corpus, tmp_path):
    """The read path refuses too, not only the pure classifier."""
    wd = str(tmp_path / "proj")
    write_transcript(corpus, wd, UUID, [turn_duration(), user_prompt()])
    assert read_transcript_rest(UUID, wd).verdict == TAIL_IN_FLIGHT


def test_a_row_with_no_conversation_bound_reads_absent(corpus, tmp_path):
    """No uuid is a measured absence of a transcript to consult."""
    assert read_transcript_rest(None, str(tmp_path)).verdict == TAIL_ABSENT


def test_a_uuid_with_no_file_reads_absent_not_at_rest(corpus, tmp_path):
    """A recorded uuid is not evidence a transcript exists."""
    assert read_transcript_rest(UUID, str(tmp_path)).verdict == TAIL_ABSENT


def test_a_half_written_last_line_does_not_break_the_read(corpus, tmp_path):
    """A live writer's partial trailing line is normal, not an error."""
    wd = str(tmp_path / "proj")
    path = write_transcript(corpus, wd, UUID, [turn_duration()])
    with open(path, "a", encoding="utf-8") as handle:
        handle.write('{"type": "assist')
    assert read_transcript_rest(UUID, wd).verdict == TAIL_AT_REST


# --------------------------------------------------------------------- #
# 8. THE BOOT PASS. Hermetic, in the style of test_boot_readopt.py.
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_boot_seeds_a_resting_session_and_refuses_a_busy_one(
    tmp_path, monkeypatch, corpus
):
    """The whole point, through the real boot re-adopt.

    Two surviving sessions, neither with any hook signal - which is what
    a restart always produces. One's transcript ends a turn, the other's
    is mid-turn. The first must come back seeded ``idle``; the second
    must stay unseeded, so the row keeps reading ``unknown``.
    """
    from tests.test_boot_readopt import (
        EPOCH_A,
        EPOCH_B,
        _noop,
        install_backends,
        listing_rows,
        seed_row,
    )
    from src.config import settings
    from src.core.session_manager import SessionManager
    from src.core.tmux_listing import TmuxListing
    from tests.s7_helpers import migrated_connection

    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    resting_dir = str(tmp_path / "resting")
    busy_dir = str(tmp_path / "busy")
    resting_uuid = "11111111-1111-4111-8111-111111111111"
    busy_uuid = "22222222-2222-4222-8222-222222222222"
    write_transcript(corpus, resting_dir, resting_uuid,
                     [user_prompt(), assistant("end_turn"), turn_duration()])
    write_transcript(corpus, busy_dir, busy_uuid,
                     [turn_duration(), user_prompt(), assistant("tool_use")])

    mgr = SessionManager()
    monkeypatch.setattr(mgr, "_sweep_orphan_uploads", _noop)
    seed_row(state, mgr, name="cloude_resting", epoch=EPOCH_A,
             working_dir=resting_dir, agent_type="claude")
    seed_row(state, mgr, name="cloude_busy", epoch=EPOCH_B,
             working_dir=busy_dir, agent_type="claude")
    with closing(connect(db_path_for(state))) as conn:
        conn.execute(
            "UPDATE sessions SET claude_session_uuid = ? WHERE tmux_name = ?",
            (resting_uuid, "cloude_resting"),
        )
        conn.execute(
            "UPDATE sessions SET claude_session_uuid = ? WHERE tmux_name = ?",
            (busy_uuid, "cloude_busy"),
        )
        conn.commit()

    install_backends(
        monkeypatch,
        discover=TmuxListing.answered(["cloude_resting", "cloude_busy"]),
        attachable=listing_rows(("cloude_resting", EPOCH_A),
                                ("cloude_busy", EPOCH_B)),
    )

    await mgr.lifespan_startup()
    await mgr._boot_readopt_task

    store = seeds_for(mgr)
    by_name = {b.tmux_session: sid for sid, b in mgr._registry.backends.items()}
    resting_seed = store.get(by_name["cloude_resting"])
    busy_seed = store.get(by_name["cloude_busy"])

    assert resting_seed is not None and resting_seed.state == STATUS_IDLE
    assert resting_seed.rung == SEED_RUNG_TRANSCRIPT
    assert busy_seed is not None and busy_seed.state is None


@pytest.mark.asyncio
async def test_a_row_state_survives_the_restart_and_beats_the_transcript(
    tmp_path, monkeypatch, corpus
):
    """Rung A, through the manager, keyed on the INSTANCE triple.

    ``activity_persist.write_state`` writes on the full triple; this read
    must use the same one. A name-scoped read would answer for whichever
    epoch sorts newest, which is a different question.
    """
    from tests.test_boot_readopt import EPOCH_A, EPOCH_B, seed_row
    from src.config import settings
    from src.core.session_manager import SessionManager
    from tests.s7_helpers import migrated_connection

    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    mgr = SessionManager()
    # TWO rows, ONE name. The stale successor sorts newest and holds a
    # fresh ``working``; the pane we are asking about is the older epoch.
    seed_row(state, mgr, name="cloude_twin", epoch=EPOCH_A,
             working_dir=str(tmp_path), agent_type="claude")
    seed_row(state, mgr, name="cloude_twin", epoch=EPOCH_B,
             working_dir=str(tmp_path), agent_type="claude")
    with closing(connect(db_path_for(state))) as conn:
        write_state(conn, "cloude_twin", STATUS_IDLE, EPOCH_A,
                    tmux_socket=mgr._tmux_socket_name())
        write_state(conn, "cloude_twin", STATUS_WORKING, EPOCH_B,
                    tmux_socket=mgr._tmux_socket_name())
        conn.commit()

    seed = derive_seed(mgr, "ses_twin", "cloude_twin", epoch=EPOCH_A)
    assert seed.state == STATUS_IDLE
    assert seed.rung == SEED_RUNG_ROW


@pytest.mark.asyncio
async def test_a_session_with_live_hook_signal_is_never_seeded(
    tmp_path, monkeypatch, corpus
):
    """A HOOK OUTRANKS A SEED, immediately and with nothing to expire.

    The warm-up skips any session the tracker has seen an event for, and
    the seam is gated the same way, so the first hook of the process
    retires the seed for good.
    """
    from tests.test_boot_readopt import EPOCH_A, seed_row
    from src.config import settings
    from src.core.session_manager import SessionManager
    from src.models import Session
    from tests.s7_helpers import migrated_connection

    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    wd = str(tmp_path / "proj")
    write_transcript(corpus, wd, UUID, [turn_duration()])

    mgr = SessionManager()
    seed_row(state, mgr, name="cloude_hooked", epoch=EPOCH_A, working_dir=wd,
             agent_type="claude")
    with closing(connect(db_path_for(state))) as conn:
        conn.execute(
            "UPDATE sessions SET claude_session_uuid = ? WHERE tmux_name = ?",
            (UUID, "cloude_hooked"),
        )
        conn.commit()

    session = Session(id="ses_hooked", working_dir=wd)
    session.tmux_session = "cloude_hooked"
    mgr._registry.sessions["ses_hooked"] = session
    mgr._instance_epochs["ses_hooked"] = EPOCH_A

    # Without a hook, the warm-up seeds it.
    assert seed_live_sessions(mgr) == (1, 1)
    assert seeds_for(mgr).get("ses_hooked").state == STATUS_IDLE

    # With one, it is skipped outright - examined zero, seeded zero.
    mgr._activity_tracker.record_event("ses_hooked", EVENT_PRE_TOOL_USE)
    assert seed_live_sessions(mgr) == (0, 0)


@pytest.mark.asyncio
async def test_an_unidentifiable_instance_seeds_nothing(tmp_path, monkeypatch):
    """No epoch is no instance, and no instance is a refusal.

    The same refusal ``activity_persist.write_state`` already makes on
    the write side: guessing which of several same-named rows is live is
    the behaviour the triple exists to replace.
    """
    from src.config import settings
    from src.core.session_manager import SessionManager
    from tests.s7_helpers import migrated_connection

    state = tmp_path / "state"
    log_dir = tmp_path / "logs"
    state.mkdir()
    log_dir.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    mgr = SessionManager()
    seed = derive_seed(mgr, "ses_x", "cloude_x", epoch=None)
    assert seed.state is None
    assert seed.rung == SEED_RUNG_NONE
    assert "could not be identified" in (seed.detail or "")


# --------------------------------------------------------------------- #
# 7. THE PT-IMC FINDING - a refusal must not be permanent, and a
#    swallowed error must not be invisible.
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_seeded_status_retries_a_refusal_once_the_epoch_is_known(
    tmp_path, monkeypatch
):
    """The listing seam must heal the instant, not wait out the clock.

    Mirrors the PT-IMC boot race exactly: the first call to the seam has
    no epoch to offer (a boot pass raced the legacy reconcile and lost),
    so it caches "instance could not be identified". The epoch then
    becomes known - what ``session_boot_readopt.
    _record_epoch_for_already_registered`` now does for a session
    registered ahead of it - and the very next call, at the SAME
    instant, must re-derive rather than serve the stale refusal for a
    full ``SEED_REFRESH_INTERVAL_SECONDS``.
    """
    from tests.test_boot_readopt import EPOCH_A, seed_row
    from src.config import settings
    from src.core.session_manager import SessionManager
    from tests.s7_helpers import migrated_connection

    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    with closing(migrated_connection(state)):
        pass

    mgr = SessionManager()
    seed_row(state, mgr, name="cloude_PT-IMC", epoch=EPOCH_A,
              working_dir=str(tmp_path), agent_type="claude")
    with closing(connect(db_path_for(state))) as conn:
        write_state(conn, "cloude_PT-IMC", STATUS_IDLE, EPOCH_A,
                    tmux_socket=mgr._tmux_socket_name())
        conn.commit()

    # First call: no explicit epoch, and none recorded on the manager
    # yet - exactly the boot-race shape.
    refused = seeded_status(mgr, "ses_pt_imc", "cloude_PT-IMC", now=NOW)
    assert refused is None
    assert seeds_for(mgr).get("ses_pt_imc").rung == SEED_RUNG_NONE

    # The epoch becomes known.
    mgr._instance_epochs["ses_pt_imc"] = EPOCH_A

    # Same instant: an age-based clock alone would still say "not due"
    # for the next ~60 seconds.
    healed = seeded_status(mgr, "ses_pt_imc", "cloude_PT-IMC", now=NOW)
    assert healed == STATUS_IDLE


def test_a_broken_datastore_read_logs_at_warning_not_debug():
    """Debug-only visibility is exactly how the PT-IMC refusal went
    unnoticed - this server emits no debug lines. A read that fails must
    say so loudly enough to be seen, naming the session and the error.
    """

    class _BrokenConn:
        def execute(self, *_args, **_kwargs):
            raise sqlite3.OperationalError("no such table: sessions")

        def close(self):
            pass

    class _FakeManager:
        def _writable_datastore_connection(self):
            return _BrokenConn()

        def _tmux_socket_name(self):
            return "cloudetest"

    with structlog.testing.capture_logs() as logs:
        row = read_instance_row(
            _FakeManager(), "cloude_x", 123, session_id="ses_broken"
        )

    assert row is None
    failures = [
        entry for entry in logs
        if entry.get("event") == "status_seed_row_read_failed"
    ]
    assert len(failures) == 1, f"expected exactly one failure log, got {logs}"
    entry = failures[0]
    assert entry["log_level"] == "warning"
    assert entry["session_id"] == "ses_broken"
    assert entry["error_type"] == "OperationalError"
