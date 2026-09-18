"""Decoration adds fields, removes no row, and never rewrites provenance.

TWO CLAIMS THIS FILE EXISTS TO HOLD. First, the archive's own
``display_name`` and ``title`` are measurements OF THE ARCHIVE and are
left alone: overwriting them would make ``title_source`` describe a value
it did not produce, and would strand a corpus collected on another
machine - which has no row in this machine's cloude.db - with no name at
all. Second, a naming failure degrades a LISTING'S NAMES and never its
ROWS, because a rail that drops sessions because a second database was
busy is a far worse bug than a rail showing slugs.
"""

from __future__ import annotations

from src.core.app_name_index import AppNameIndex, empty_index
from src.core.archive_display_names import MATCHED_CANNOT_DETERMINE, MATCHED_NONE
from src.core.archive_name_decorate import (
    SESSION_NAME_SOURCE,
    decorate_project_nodes,
    decorate_transcript_rows,
)
from src.core.claude_transcript_correlate import slugify_project_dir

ROOT = "/Users/x/Development/Media"
SLUG = slugify_project_dir(ROOT)


def _index(complete=True):
    return AppNameIndex(
        [
            {
                "id": 7,
                "root": ROOT,
                "raw_path": None,
                "display_name": "Media",
                "description": "Media pipeline (migrated)",
            }
        ],
        {"uuid-1": "Media Compression"},
        complete=complete,
    )


def _projects_envelope():
    return {
        "result": [
            {"full_path": SLUG, "display_name": None},
            {"full_path": "-Users-x-unmatched", "display_name": None},
        ],
        "meta": {},
    }


def _transcripts_envelope():
    return {
        "result": [
            {"session_ref": "uuid-1", "session_ref_scheme": "uuid", "title": None},
            {"session_ref": "uuid-9", "session_ref_scheme": "uuid", "title": None},
            {"session_ref": "agent-abc", "session_ref_scheme": "agent", "title": "x"},
        ],
        "meta": {},
    }


# --- projects -------------------------------------------------------------


def test_a_matched_node_gains_a_name_and_a_source():
    env = decorate_project_nodes(_projects_envelope(), _index())
    node = env["result"][0]
    assert node["app_display_name"] == "Media"
    assert node["app_description"] == "Media pipeline (migrated)"
    assert node["app_project_id"] == 7
    assert node["app_name_source"] == "as_written"


def test_an_unmatched_node_keeps_its_slug_and_claims_nothing():
    """NEGATIVE CONTROL on the seam, not just on the resolver."""
    env = decorate_project_nodes(_projects_envelope(), _index())
    node = env["result"][1]
    assert node["app_display_name"] is None
    assert node["app_name_source"] == MATCHED_NONE
    assert node["full_path"] == "-Users-x-unmatched"


def test_the_archives_own_display_name_is_never_overwritten():
    """Provenance. Two namings of one node, kept apart."""
    env = _projects_envelope()
    env["result"][0]["display_name"] = "archive-derived"
    decorate_project_nodes(env, _index())
    assert env["result"][0]["display_name"] == "archive-derived"
    assert env["result"][0]["app_display_name"] == "Media"


def test_an_unreadable_app_database_leaves_every_row_in_place():
    env = decorate_project_nodes(_projects_envelope(), empty_index())
    assert len(env["result"]) == 2
    assert all(n["app_display_name"] is None for n in env["result"])
    assert all(
        n["app_name_source"] == MATCHED_CANNOT_DETERMINE for n in env["result"]
    )
    assert env["meta"]["app_naming"]["app_database_read"] is False


def test_a_refusal_envelope_with_no_result_list_is_returned_untouched():
    env = {"result": None, "meta": {"result_status": "cannot_determine"}}
    assert decorate_project_nodes(env, _index())["result"] is None


def test_the_summary_reports_the_rate():
    env = decorate_project_nodes(_projects_envelope(), _index())
    naming = env["meta"]["app_naming"]
    assert naming["resolved"] == 1
    assert naming["slugs_considered"] == 2
    assert naming["app_project_rows"] == 1


# --- transcripts ----------------------------------------------------------


def test_an_own_conversation_gains_the_browsers_title():
    env = decorate_transcript_rows(_transcripts_envelope(), _index())
    assert env["result"][0]["app_session_title"] == "Media Compression"
    assert env["result"][0]["app_name_source"] == SESSION_NAME_SOURCE


def test_a_conversation_with_no_row_is_a_measured_absence():
    """NEGATIVE CONTROL. Not every uuid has a session row."""
    env = decorate_transcript_rows(_transcripts_envelope(), _index())
    assert env["result"][1]["app_session_title"] is None
    assert env["result"][1]["app_name_source"] == MATCHED_NONE


def test_an_agent_sidechain_is_never_looked_up():
    """A sidechain is a file a conversation spawned, not a conversation."""
    env = decorate_transcript_rows(_transcripts_envelope(), _index())
    assert env["result"][2]["app_session_title"] is None
    assert env["result"][2]["app_name_source"] == MATCHED_NONE
    assert env["result"][2]["title"] == "x", "the archive's own title survives"


def test_an_unreadable_database_refuses_before_reading_the_scheme():
    """cannot_determine, not none: nobody looked."""
    env = decorate_transcript_rows(_transcripts_envelope(), empty_index())
    assert len(env["result"]) == 3
    assert all(
        r["app_name_source"] == MATCHED_CANNOT_DETERMINE for r in env["result"]
    )


def test_the_transcript_summary_counts_what_it_named():
    env = decorate_transcript_rows(_transcripts_envelope(), _index())
    naming = env["meta"]["app_naming"]
    assert naming["rows_considered"] == 3
    assert naming["named"] == 1
    assert naming["app_database_read"] is True
