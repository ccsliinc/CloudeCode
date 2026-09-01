"""The merged tree envelope, and the unattributed count the rail hides on.

THE HIDE IS THE DANGEROUS PART. The rail removes the "no project" node
when the count is zero, and those transcripts are unreachable from the
project tree by construction - so a wrong hide is permanent and silent.
The server therefore has to make "0" and "I could not count" impossible
to confuse, which is what ``counted`` is for. Measured 2026-09-01:
corpus 1 has 0, corpus 2 has 5, corpus 3 has 0.
"""

from __future__ import annotations

import sqlite3

from src.core.archive_merged_tree import UNATTRIBUTED_HIDE_RULE, merged_projects


def _archive(unattributed_in_corpus_2: int = 5) -> sqlite3.Connection:
    """Build a two-host, three-corpus archive shaped like the real one.

    Description: mirrors the live topology - one project on both
      machines, one on each - so a merge that works here is evidence
      about the merge that runs live.
    Inputs: unattributed_in_corpus_2 (int).
    Output: sqlite3.Connection.
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE message_hosts (id INTEGER PRIMARY KEY, display_name TEXT);
        CREATE TABLE message_corpora (
            id INTEGER PRIMARY KEY, host_id INTEGER, corpus_key TEXT);
        CREATE TABLE message_projects (
            id INTEGER PRIMARY KEY, corpus_id INTEGER, slug TEXT, observed_cwd TEXT);
        CREATE TABLE message_transcripts (
            id INTEGER PRIMARY KEY, project_id INTEGER, corpus_id INTEGER);
        INSERT INTO message_hosts VALUES (1, 'Joe-MBP-M1'), (2, 'Mac mini');
        INSERT INTO message_corpora VALUES
            (1, 1, 'claude-projects'), (2, 1, 'agent-sessions'),
            (3, 2, 'claude-projects');
        INSERT INTO message_projects VALUES
            (1, 1, '-Users-j-Media', '/Users/j/Media'),
            (2, 3, '-Users-j-Media', '/Users/j/Media'),
            (3, 1, '-Users-j-Solo',  '/Users/j/Solo');
        INSERT INTO message_transcripts VALUES
            (1, 1, 1), (2, 1, 1), (3, 2, 3), (4, 3, 1);
        """
    )
    for n in range(unattributed_in_corpus_2):
        conn.execute(
            "INSERT INTO message_transcripts (project_id, corpus_id) VALUES (NULL, 2)"
        )
    return conn


def test_the_merged_list_collapses_the_cross_host_project():
    """3 project rows over 2 hosts become 2 nodes, one naming both."""
    env = merged_projects(_archive())
    assert env["result_status"] == "ok"
    assert env["meta"]["merge"]["project_rows"] == 3
    assert env["meta"]["merge"]["merged_nodes"] == 2
    assert env["meta"]["merge"]["nodes_on_more_than_one_host"] == 1
    media = [n for n in env["result"] if n["display_name"] == "Media"][0]
    assert media["hosts"] == ["Joe-MBP-M1", "Mac mini"]
    assert media["transcript_count"] == 3


def test_every_node_carries_the_contract_fields():
    """display_name, full_path and hosts are consumed by another agent."""
    env = merged_projects(_archive())
    for node in env["result"]:
        assert "display_name" in node
        assert "full_path" in node
        assert isinstance(node["hosts"], list)


def test_the_host_list_lets_a_client_filter_without_a_second_request():
    """The machine is a field now, so the filter's options ship with it."""
    meta = merged_projects(_archive())["meta"]
    assert [h["display_name"] for h in meta["hosts"]] == ["Joe-MBP-M1", "Mac mini"]
    assert {h["host_id"]: h["project_count"] for h in meta["hosts"]} == {1: 2, 2: 1}


def test_a_corpus_with_none_reports_zero_rather_than_being_absent():
    """Absence and zero are different findings; only zero may hide."""
    rows = merged_projects(_archive())["meta"]["unattributed"]["by_corpus"]
    assert [r["corpus_id"] for r in rows] == [1, 2, 3]
    by_id = {r["corpus_id"]: r for r in rows}
    assert by_id[1]["transcript_count"] == 0 and by_id[1]["counted"] is True
    assert by_id[2]["transcript_count"] == 5 and by_id[2]["counted"] is True
    assert by_id[3]["transcript_count"] == 0 and by_id[3]["counted"] is True


def test_an_uncountable_corpus_reports_null_and_counted_false():
    """THE THIRD OUTCOME, on the number a hide is decided from.

    A zero here would make the rail hide a node on a count nobody
    produced - the exact false green this API is written against.
    """
    conn = _archive()
    conn.execute("DROP TABLE message_transcripts")
    conn.executescript(
        "CREATE TABLE message_transcripts (id INTEGER PRIMARY KEY, project_id INTEGER);"
    )
    rows = merged_projects(conn)["meta"]["unattributed"]["by_corpus"]
    assert all(r["transcript_count"] is None for r in rows)
    assert all(r["counted"] is False for r in rows)


def test_the_hide_rule_travels_with_the_response():
    """The rail and the server cannot drift about when to hide."""
    meta = merged_projects(_archive())["meta"]
    assert meta["unattributed"]["hide_when"] == UNATTRIBUTED_HIDE_RULE
    assert "counted is false" in UNATTRIBUTED_HIDE_RULE


def test_each_unattributed_row_carries_a_reachable_href():
    """The node has to lead somewhere or it is only an accusation."""
    rows = merged_projects(_archive())["meta"]["unattributed"]["by_corpus"]
    assert rows[1]["href"].endswith("/corpora/2/unattributed")


def test_a_populated_archive_can_never_merge_to_an_empty_list():
    """The zero-row guard: nodes may only be empty when rows are.

    WHY THIS EXISTS. Every other test here asserts a SHAPE - the fields a
    node carries, the hosts it names, the counts beside it - and every
    one of them passes vacuously against an empty result, because a loop
    over nothing asserts nothing. So the suite could stay green while the
    endpoint returned `[]`, which a rail renders as the perfectly
    plausible "no projects in this view" rather than as a fault.

    The invariant is the one thing a shape assertion cannot express:
    merging is a fold, so it can only ever REDUCE the row count, never
    take it to zero. `merged_nodes == 0` therefore implies
    `project_rows == 0`, and any other combination is a merge that lost
    its input - which is the whole failure this guards.
    """
    env = merged_projects(_archive())
    merge = env["meta"]["merge"]

    assert merge["project_rows"] == 3
    assert len(env["result"]) > 0, (
        "3 project rows merged to an EMPTY list - a fold cannot reduce a "
        "non-empty input to nothing"
    )
    assert len(env["result"]) == merge["merged_nodes"]
    if merge["merged_nodes"] == 0:
        assert merge["project_rows"] == 0


def test_an_archive_with_no_projects_says_ok_and_empty_rather_than_failing():
    """The other half: a genuinely empty archive is not a fault.

    The guard above must not be satisfiable by making emptiness an
    error, because an archive with no projects is a real, healthy state.
    Empty-and-ok is correct here precisely BECAUSE `project_rows` is 0 -
    the number that makes the emptiness legible rather than ambiguous.
    """
    conn = _archive()
    conn.execute("DELETE FROM message_transcripts")
    conn.execute("DELETE FROM message_projects")

    env = merged_projects(conn)

    assert env["result"] == []
    assert env["result_status"] == "ok"
    assert env["meta"]["merge"]["project_rows"] == 0
    assert env["meta"]["merge"]["merged_nodes"] == 0


def test_every_underlying_project_id_is_reachable_from_some_node():
    """No project id may be unaddressable after the merge.

    A node carries `project_id` for its FIRST member only, so the ids of
    the folded-up rows survive nowhere except `members`. A deep link
    names one of THOSE ids just as legitimately, and on the live corpus
    exactly 3 of 80 are in that position - the 3 cross-machine projects.
    Losing them from `members` would strand a link with no error
    anywhere, so the reachable set is asserted against the table.
    """
    conn = _archive()
    env = merged_projects(conn)

    reachable = set()
    for node in env["result"]:
        reachable.add(node["project_id"])
        for member in node["members"]:
            reachable.add(member["project_id"])

    every_id = {r["id"] for r in conn.execute("SELECT id FROM message_projects")}
    assert reachable == every_id
    assert len(every_id) > len(env["result"]), "fixture must exercise a fold"
