"""Where a restored transcript is allowed to land, and where it is not.

THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. A target resolver that
always says yes would pass every positive test here and be a data-loss
tool, so each refusal has a test that fails if the refusal stops firing,
and :func:`test_a_resolver_that_always_allowed_would_fail_this_file`
states that in one place.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_trt_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_trt_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

from src.core.transcript_restore_outcomes import (
    ALL_TARGET_OUTCOMES,
    ESCAPES_CORPUS_ROOT,
    PARENT_MISSING,
    SOURCE_IS_LONGER_THAN_ARCHIVE,
    TARGET_EXISTS,
    TARGET_READY,
)
from src.core.transcript_restore_target import (
    CORROBORATION_AGREES,
    CORROBORATION_DISAGREES,
    CORROBORATION_NO_CWD,
    compose_target,
    corroborate_directory,
    resolve_target,
)


@pytest.fixture()
def corpus(tmp_path: Path) -> Path:
    """A throwaway corpus root with one project directory in it."""
    root = tmp_path / "projects"
    (root / "-Users-x-Proj").mkdir(parents=True)
    return root


def test_the_destination_is_the_recorded_source_path(corpus: Path) -> None:
    """The stored source_path is joined onto the corpus root verbatim."""
    decision = resolve_target("-Users-x-Proj/abc.jsonl", 10, corpus_root=corpus)
    assert decision.outcome == TARGET_READY
    assert decision.path == corpus / "-Users-x-Proj" / "abc.jsonl"


def test_an_existing_transcript_is_refused_by_default(corpus: Path) -> None:
    """THE DEFAULT REFUSAL. claude may be appending to that file."""
    target = corpus / "-Users-x-Proj" / "abc.jsonl"
    target.write_bytes(b"live conversation\n")
    decision = resolve_target("-Users-x-Proj/abc.jsonl", 10, corpus_root=corpus)
    assert decision.outcome == TARGET_EXISTS
    assert decision.path == target
    assert decision.existing_byte_length == len(b"live conversation\n")
    # The file is untouched: deciding must not write.
    assert target.read_bytes() == b"live conversation\n"


def test_overwrite_is_what_unlocks_an_existing_target(corpus: Path) -> None:
    """The opt-in exists, and it is the ONLY thing that clears TARGET_EXISTS."""
    target = corpus / "-Users-x-Proj" / "abc.jsonl"
    target.write_bytes(b"short\n")
    assert resolve_target(
        "-Users-x-Proj/abc.jsonl", 100, corpus_root=corpus
    ).outcome == TARGET_EXISTS
    assert resolve_target(
        "-Users-x-Proj/abc.jsonl", 100, corpus_root=corpus, overwrite=True
    ).outcome == TARGET_READY


def test_overwrite_still_refuses_to_shorten_a_conversation(corpus: Path) -> None:
    """NEGATIVE CONTROL. --overwrite is not permission to truncate.

    A file on disk longer than the reconstruction means the archive is
    BEHIND the live file. Writing would destroy the tail of a real
    conversation, which is the worst failure this feature can have, so
    the opt-in does not reach it.
    """
    target = corpus / "-Users-x-Proj" / "abc.jsonl"
    target.write_bytes(b"x" * 500)
    decision = resolve_target(
        "-Users-x-Proj/abc.jsonl", 100, corpus_root=corpus, overwrite=True
    )
    assert decision.outcome == SOURCE_IS_LONGER_THAN_ARCHIVE
    assert decision.existing_byte_length == 500
    assert target.read_bytes() == b"x" * 500


def test_equal_length_is_allowed_under_overwrite(corpus: Path) -> None:
    """The refusal is STRICTLY longer, not longer-or-equal.

    A re-ingest of the same file is the ordinary case and must not be
    refused, or the overwrite path would be unusable for the thing it is
    for.
    """
    target = corpus / "-Users-x-Proj" / "abc.jsonl"
    target.write_bytes(b"x" * 100)
    assert resolve_target(
        "-Users-x-Proj/abc.jsonl", 100, corpus_root=corpus, overwrite=True
    ).outcome == TARGET_READY


def test_a_missing_project_directory_refuses_without_create_dirs(corpus: Path) -> None:
    """A named refusal, not a crash, and not a silent mkdir."""
    decision = resolve_target("-Users-x-Gone/abc.jsonl", 10, corpus_root=corpus)
    assert decision.outcome == PARENT_MISSING
    assert decision.path is not None
    assert not decision.path.parent.exists()
    assert resolve_target(
        "-Users-x-Gone/abc.jsonl", 10, corpus_root=corpus, create_dirs=True
    ).outcome == TARGET_READY


@pytest.mark.parametrize(
    "hostile",
    [
        "../escape.jsonl",
        "-Users-x-Proj/../../escape.jsonl",
        "/etc/passwd",
        "-Users-x-Proj/../../../../../../tmp/escape.jsonl",
    ],
)
def test_a_source_path_cannot_steer_a_write_out_of_the_corpus(
    corpus: Path, hostile: str
) -> None:
    """NEGATIVE CONTROL. source_path is a DATABASE value, so it is data."""
    assert resolve_target(hostile, 10, corpus_root=corpus).outcome == (
        ESCAPES_CORPUS_ROOT
    )
    assert compose_target(hostile, corpus_root=corpus) is None


def test_containment_is_component_wise_not_a_prefix_match(tmp_path: Path) -> None:
    """NEGATIVE CONTROL for the /Users/jsugamelevil trap.

    A sibling directory whose NAME starts with the corpus root's name is
    not inside it, and a ``str.startswith`` check would say it was.
    """
    root = tmp_path / "projects"
    root.mkdir()
    (tmp_path / "projectsevil").mkdir()
    assert compose_target("../projectsevil/a.jsonl", corpus_root=root) is None


def test_a_symlinked_parent_pointing_out_of_the_tree_is_refused(
    tmp_path: Path,
) -> None:
    """A directory inside the corpus that is really somewhere else."""
    root = tmp_path / "projects"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "-sneaky").symlink_to(outside, target_is_directory=True)
    assert compose_target("-sneaky/a.jsonl", corpus_root=root) is None


def test_the_slug_rule_corroborates_the_recorded_directory() -> None:
    """The cross-check agrees when the directory really is the cwd's slug."""
    data = b'{"type":"user","cwd":"/Users/x/Proj"}\n'
    result = corroborate_directory(data, "-Users-x-Proj/abc.jsonl")
    assert result.verdict == CORROBORATION_AGREES
    assert result.cwd == "/Users/x/Proj"
    assert "-Users-x-Proj" in result.derived_dirs


def test_a_disagreeing_slug_is_reported_and_never_refuses() -> None:
    """A cwd that moved after startup is a MEASURED real shape.

    11 of 919 live transcripts sit in a directory that disagrees with
    their own recorded cwd. Refusing on that would refuse real
    transcripts, so the cross-check reports and the target decision is
    taken independently of it.
    """
    data = b'{"type":"user","cwd":"/Users/x/Somewhere/Else"}\n'
    result = corroborate_directory(data, "-Users-x-Proj/abc.jsonl")
    assert result.verdict == CORROBORATION_DISAGREES
    assert result.recorded_dir == "-Users-x-Proj"


def test_a_transcript_with_no_cwd_is_its_own_verdict() -> None:
    """Three outcomes, not two: no cwd recorded is not a disagreement.

    319 files in the live corpus carry no cwd anywhere.
    """
    data = b'{"type":"file-history-snapshot"}\n'
    assert corroborate_directory(data, "-a/x.jsonl").verdict == CORROBORATION_NO_CWD


def test_invalid_json_lines_are_stepped_over_not_fatal() -> None:
    """The archive preserves invalid JSON byte-exactly, so meeting one is normal."""
    data = b"not json at all\n\x80\x81 binary\n" + b'{"cwd":"/Users/x/Proj"}\n'
    assert corroborate_directory(data, "-Users-x-Proj/a.jsonl").verdict == (
        CORROBORATION_AGREES
    )


def test_every_outcome_this_module_emits_is_in_the_vocabulary(corpus: Path) -> None:
    """No module may invent an outcome the shared vocabulary does not carry."""
    seen = {
        resolve_target("-Users-x-Proj/a.jsonl", 1, corpus_root=corpus).outcome,
        resolve_target("../x.jsonl", 1, corpus_root=corpus).outcome,
        resolve_target("-Users-x-Gone/a.jsonl", 1, corpus_root=corpus).outcome,
    }
    assert seen <= set(ALL_TARGET_OUTCOMES)


def test_a_resolver_that_always_allowed_would_fail_this_file(corpus: Path) -> None:
    """The load-bearing assertion: this module can and does say no.

    Watched go red by making ``resolve_target`` return TARGET_READY
    unconditionally; four tests in this file fail immediately. Kept as a
    single statement so the property is asserted rather than only implied
    by the other cases.
    """
    target = corpus / "-Users-x-Proj" / "abc.jsonl"
    target.write_bytes(b"x" * 500)
    refusals = [
        resolve_target("-Users-x-Proj/abc.jsonl", 1, corpus_root=corpus).outcome,
        resolve_target(
            "-Users-x-Proj/abc.jsonl", 1, corpus_root=corpus, overwrite=True
        ).outcome,
        resolve_target("../a.jsonl", 1, corpus_root=corpus).outcome,
        resolve_target("-Users-x-Gone/a.jsonl", 1, corpus_root=corpus).outcome,
    ]
    assert TARGET_READY not in refusals
    assert len(set(refusals)) == 4, "each refusal must have its own name"
