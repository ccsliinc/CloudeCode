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


# --- the cwd rung, which runs only BELOW the app database --------------


def _cwd_index(mapping):
    """A complete ArchiveCwdIndex over literal {slug: {cwd: count}}."""
    from src.core.archive_cwd_evidence import ArchiveCwdIndex

    return ArchiveCwdIndex(
        mapping, {s: sum(v.values()) for s, v in mapping.items()}, (),
        complete=True,
    )


def _app_index(projects):
    """An AppNameIndex over literal (id, root, display_name) rows."""
    from src.core.app_name_index import AppNameIndex

    return AppNameIndex(
        [
            {"id": rid, "root": root, "raw_path": None,
             "display_name": name, "description": None}
            for rid, root, name in projects
        ],
        {},
        complete=True,
    )


def test_unnamed_slugs_is_exactly_the_population_the_cwd_rung_exists_for():
    """Read BEFORE the archive is opened, so a fully named listing opens nothing."""
    from src.core.archive_name_decorate import (
        decorate_project_nodes,
        unnamed_slugs,
    )

    index = _app_index([(1, "/w/Known", "Known")])
    envelope = {"result": [
        {"full_path": "-w-Known"},
        {"full_path": "-w-Unknown"},
        {"full_path": "-w-Unknown"},
    ]}
    decorate_project_nodes(envelope, index)
    assert unnamed_slugs(envelope) == ["-w-Unknown"]


def test_the_cwd_rung_never_overwrites_a_name_the_app_database_recorded():
    """A recorded name outranks a derived one, or the ladder is pointless."""
    from src.core.archive_name_decorate import (
        decorate_project_nodes,
        decorate_project_nodes_from_cwd,
    )

    index = _app_index([(1, "/w/Known", "Known")])
    envelope = {"result": [{"full_path": "-w-Known"}]}
    decorate_project_nodes(envelope, index)
    # Evidence that would name it something else entirely, if consulted.
    cwds = _cwd_index({"-w-Known": {"/w/Known": 9}})
    decorate_project_nodes_from_cwd(envelope, index, cwds)
    node = envelope["result"][0]
    assert node["app_display_name"] == "Known"
    assert node["app_name_source"] == "as_written"
    assert node["app_name_evidence"] is None


def test_a_derived_name_lands_with_its_provenance_beside_it():
    """The client gates on app_name_source and can show WHERE it came from."""
    from src.core.archive_name_decorate import (
        decorate_project_nodes,
        decorate_project_nodes_from_cwd,
    )

    index = _app_index([(1, "/w/Production", "Production")])
    slug = "-w-Production-dev-tools-scripts"
    envelope = {"result": [{"full_path": slug}]}
    decorate_project_nodes(envelope, index)
    assert envelope["result"][0]["app_name_source"] == "none"
    decorate_project_nodes_from_cwd(
        envelope, index,
        _cwd_index({slug: {"/w/Production/dev_tools/scripts": 3}}),
    )
    node = envelope["result"][0]
    assert node["app_name_source"] == "derived_cwd"
    assert node["app_display_name"] == "Production / dev_tools/scripts"
    assert node["app_name_evidence"] == "cwd_path_match"
    assert node["app_name_cwd"] == "/w/Production/dev_tools/scripts"
    # The anchor is NOT app_project_id: that field means "this slug IS
    # project N", and a client navigating on it would open Production
    # when the row is a folder inside Production.
    assert node["app_name_anchor_project_id"] == 1
    assert node["app_project_id"] is None


def test_every_node_declares_the_new_fields_even_when_the_rung_never_runs():
    """A field present on some rows reads to a client as a backend that forgot."""
    from src.core.archive_name_decorate import decorate_project_nodes

    envelope = {"result": [{"full_path": "-w-Known"}]}
    decorate_project_nodes(envelope, _app_index([(1, "/w/Known", "Known")]))
    node = envelope["result"][0]
    for field in ("app_name_evidence", "app_name_cwd",
                  "app_name_anchor_project_id"):
        assert field in node


def test_an_unreadable_archive_leaves_the_measured_none_alone():
    """The app database WAS read and really did answer 'no project'.

    Downgrading that to cannot_determine because a SECOND source failed
    would report the wrong refusal about the wrong database.
    """
    from src.core.archive_cwd_evidence import empty_cwd_index
    from src.core.archive_name_decorate import (
        decorate_project_nodes,
        decorate_project_nodes_from_cwd,
    )

    index = _app_index([(1, "/w/Known", "Known")])
    envelope = {"result": [{"full_path": "-w-Unknown"}]}
    decorate_project_nodes(envelope, index)
    decorate_project_nodes_from_cwd(envelope, index, empty_cwd_index())
    node = envelope["result"][0]
    assert node["app_name_source"] == "none"
    assert envelope["meta"]["app_naming"]["archive_read"] is False


def test_the_meta_counts_every_derived_outcome_including_the_zeros():
    """A rung that fired nothing must be visible, not inferred from an absent key."""
    from src.core.archive_name_decorate import (
        decorate_project_nodes,
        decorate_project_nodes_from_cwd,
    )

    index = _app_index([])
    slug = "-private-tmp-probe"
    envelope = {"result": [{"full_path": slug}]}
    decorate_project_nodes(envelope, index)
    decorate_project_nodes_from_cwd(
        envelope, index, _cwd_index({slug: {"/private/tmp/probe": 1}})
    )
    counts = envelope["meta"]["app_naming"]["by_derived_kind"]
    assert counts["scratch_path"] == 1
    assert counts["derived_cwd"] == 0
    assert counts["cwd_conflict"] == 0
