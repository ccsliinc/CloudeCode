"""The derived name refuses far more often than it answers, on purpose.

THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST IN THIS FILE. A matcher
that always finds something is worse than useless, and this one reads the
working directory out of transcripts that a session may have changed
directory inside - measured on the owner's corpus, 32 of 99 slugs record
more than one distinct cwd, and ``Developer`` records a directory
belonging to an entirely different project. So
``test_the_slug_is_the_control_and_without_it_this_names_strangers``
reproduces the no-control version INLINE and watches it name a stranger,
rather than only checking that the real one behaves. Without that, a
regression that dropped the anchor gate would pass every positive test in
this file.
"""

from __future__ import annotations

import pytest

from src.core.archive_cwd_evidence import ArchiveCwdIndex, empty_cwd_index
from src.core.archive_cwd_names import (
    EVIDENCE_LEAF_MATCH,
    EVIDENCE_PATH_MATCH,
    NAME_SEPARATOR,
    compose_name,
    derive_name_from_cwd,
)
from src.core.archive_display_names import (
    MATCHED_CANNOT_DETERMINE,
    MATCHED_CWD_CONFLICT,
    MATCHED_DERIVED_CWD,
    MATCHED_NONE,
    MATCHED_SCRATCH_PATH,
    MATCH_KINDS,
    MATCH_KINDS_NAMED,
    MATCH_KINDS_NAMED_WITH_DERIVED,
    ProjectNameIndex,
)

#: No ``$HOME`` symlink table, so every test states its own paths and the
#: result cannot depend on the developer's home directory.
NO_ALIASES: tuple = ()


def _projects(rows):
    """A project index over literal (id, root, display_name) rows."""
    return ProjectNameIndex(
        [
            {"id": rid, "root": root, "raw_path": None,
             "display_name": name, "description": None}
            for rid, root, name in rows
        ],
        complete=True,
        aliases=NO_ALIASES,
    )


def _cwds(mapping):
    """A complete cwd index over literal {slug: {cwd: count}}."""
    return ArchiveCwdIndex(
        mapping, {slug: sum(v.values()) for slug, v in mapping.items()},
        (), complete=True,
    )


def _derive(projects, cwds, slug):
    return derive_name_from_cwd(projects, cwds, slug, aliases=NO_ALIASES)


# --- the names it actually produces -----------------------------------


def test_a_subdirectory_is_qualified_by_the_project_that_contains_it():
    """``scripts`` alone tells the owner nothing; the anchor is the point."""
    projects = _projects([(1, "/w/Production", "Production")])
    cwds = _cwds({"-w-Production-dev-tools-scripts":
                  {"/w/Production/dev_tools/scripts": 3}})
    out = _derive(projects, cwds, "-w-Production-dev-tools-scripts")
    assert out["matched_by"] == MATCHED_DERIVED_CWD
    assert out["display_name"] == "Production" + NAME_SEPARATOR + "dev_tools/scripts"
    assert out["evidence"] == EVIDENCE_PATH_MATCH
    assert out["anchor_project_id"] == 1


def test_the_underscore_survives_because_the_slug_is_never_parsed():
    """The whole reason the cwd is read rather than the slug decoded."""
    projects = _projects([(1, "/w/Production", "Production")])
    cwds = _cwds({"-w-Production-unifi-tunnel-reset":
                  {"/w/Production/unifi_tunnel_reset": 2}})
    out = _derive(projects, cwds, "-w-Production-unifi-tunnel-reset")
    assert out["display_name"].endswith("unifi_tunnel_reset")


def test_a_worktree_keeps_its_whole_subpath_under_the_project():
    """Its leaf is generated word salad; the anchor is the meaning.

    No special case is written for ``.claude/worktrees``: the general
    rule already puts ``Media`` first, which is the part that means
    something, and then says plainly what kind of thing it is.
    """
    projects = _projects([(1, "/w/Media", "Media")])
    slug = "-w-Media--claude-worktrees-vibrant-leakey-ea30bb"
    cwds = _cwds({slug: {"/w/Media/.claude/worktrees/vibrant-leakey-ea30bb": 1}})
    out = _derive(projects, cwds, slug)
    assert out["display_name"] == (
        "Media" + NAME_SEPARATOR + ".claude/worktrees/vibrant-leakey-ea30bb"
    )


def test_two_folders_sharing_a_parent_do_not_read_as_strangers():
    """``setup`` and ``.claude`` say nothing; ``.dotfiles / setup`` does."""
    projects = _projects([(1, "/w/.dotfiles", ".dotfiles")])
    a = _derive(projects, _cwds({"-w--dotfiles-setup": {"/w/.dotfiles/setup": 1}}),
                "-w--dotfiles-setup")
    b = _derive(projects, _cwds({"-w--dotfiles--claude": {"/w/.dotfiles/.claude": 1}}),
                "-w--dotfiles--claude")
    assert a["display_name"] == ".dotfiles" + NAME_SEPARATOR + "setup"
    assert b["display_name"] == ".dotfiles" + NAME_SEPARATOR + ".claude"


def test_the_deepest_project_wins_so_a_home_rooted_row_cannot_swallow_everything():
    """A row rooted at $HOME is real evidence and the weakest possible anchor."""
    projects = _projects([
        (1, "/w", "home"),
        (2, "/w/Assistants/Media", "Media"),
    ])
    slug = "-w-Assistants-Media-dashboard"
    out = _derive(projects, _cwds({slug: {"/w/Assistants/Media/dashboard": 1}}), slug)
    assert out["display_name"] == "Media" + NAME_SEPARATOR + "dashboard"
    assert out["anchor_project_id"] == 2


# --- the refusals ------------------------------------------------------


def test_scratch_has_no_project_name_and_says_so_rather_than_inventing_one():
    """``T / cc_rht_work_ko0irget`` is noise, not a name."""
    slug = "-private-var-folders-p6-abc-T-cc-rht-work-ko0irget"
    cwds = _cwds({slug: {"/private/var/folders/p6/abc/T/cc_rht_work_ko0irget": 1}})
    out = _derive(_projects([]), cwds, slug)
    assert out["matched_by"] == MATCHED_SCRATCH_PATH
    assert out["display_name"] is None
    # The cwd is still reported, so a reader can see WHAT was refused.
    assert out["observed_cwd"].startswith("/private/var/folders")


def test_the_private_spelling_of_var_folders_is_scratch_too():
    """``realpath`` resolves ``/var`` TO ``/private/var`` and never back.

    So the canonical spelling of the family was the one the shared
    prefix list missed, and 10 live slugs read as real project roots.
    """
    from src.core.transcript_import_paths import is_scratch

    assert is_scratch("/private/var/folders/p6/x/T/y") is True
    assert is_scratch("/var/folders/p6/x/T/y") is True
    assert is_scratch("/Users/x/varfolders") is False


def test_two_different_real_directories_under_one_slug_refuse():
    """The slug cannot adjudicate, so neither may this."""
    slug = "-w-p-my-project"
    cwds = _cwds({slug: {"/w/p/my_project": 9, "/w/p/my-project": 4}})
    out = _derive(_projects([(1, "/w/p", "P")]), cwds, slug)
    assert out["matched_by"] == MATCHED_CWD_CONFLICT
    assert out["display_name"] is None


def test_a_symlink_pair_is_one_directory_and_must_not_read_as_a_conflict(
    tmp_path, monkeypatch
):
    """Measured on live: 8 slugs are supported by two spellings, all folding.

    Uses a REAL symlink rather than asserting the fold, because the fold
    is ``os.path.realpath`` and a double would only agree with itself.

    ``is_scratch`` is neutralised for this test and ONLY this test:
    pytest's ``tmp_path`` lives under ``/private/var/folders``, which the
    scratch rule correctly classifies, so without this the fixture would
    be refused before the fold was ever reached. That refusal is itself
    the scratch rule working and is asserted in its own test above.
    """
    import src.core.archive_cwd_names as names
    from src.core.claude_transcript_correlate import slugify_project_dir
    from src.core.transcript_import_paths import canonical

    real = tmp_path / "long" / "Media"
    real.mkdir(parents=True)
    (tmp_path / "short").symlink_to(tmp_path / "long")
    short = tmp_path / "short" / "Media"
    assert canonical(str(short)) == canonical(str(real)) != str(short)

    monkeypatch.setattr(names, "is_scratch", lambda _path: False)
    slug = slugify_project_dir(str(real))
    seen = {str(real): 1344, str(short): 20}
    index = ArchiveCwdIndex({slug: seen}, {slug: 2}, (), complete=True)
    out = derive_name_from_cwd(
        _projects([(1, str(tmp_path), "root")]), index, slug, aliases=NO_ALIASES
    )
    assert out["matched_by"] == MATCHED_DERIVED_CWD
    # The spelling SHOWN is the one the transcripts most often wrote.
    assert out["observed_cwd"] == str(real)


def test_no_recorded_cwd_is_none_and_an_unreadable_archive_is_not():
    """Nothing matched and nobody looked render identically and are opposite."""
    empty = _derive(_projects([]), _cwds({}), "-w-nothing")
    assert empty["matched_by"] == MATCHED_NONE
    blind = derive_name_from_cwd(
        _projects([]), empty_cwd_index(), "-w-nothing", aliases=NO_ALIASES
    )
    assert blind["matched_by"] == MATCHED_CANNOT_DETERMINE


def test_a_filesystem_root_names_no_folder():
    """Showing '/' would be a name nobody could act on."""
    assert compose_name(_projects([]), "/") == (None, None)


# --- the control that makes all of the above worth anything ------------


def test_the_slug_is_the_control_and_without_it_this_names_strangers():
    """THE NEGATIVE CONTROL. Watch the no-anchor version answer, wrongly.

    A session that changes directory writes the new cwd into the same
    transcript, so a slug's evidence routinely contains a directory that
    is not its own. The real resolver refuses that; this reproduces the
    version WITHOUT the control inline and shows it confidently naming a
    completely unrelated project, so the file fails if the gate is ever
    dropped rather than only passing when it is present.
    """
    projects = _projects([(1, "/w/Web", "Web"), (2, "/w/Developer", "Developer")])
    slug = "-w-Developer"
    # What the transcripts under -w-Developer actually recorded: mostly
    # their own directory, plus a spell spent inside another project.
    stranger = {"/w/Web/imc-support/docs": 24}
    out = _derive(projects, _cwds({slug: stranger}), slug)
    assert out["matched_by"] == MATCHED_NONE, (
        "the stranger's directory was accepted as this slug's name"
    )

    # The no-control version: take the most-recorded cwd and name it.
    no_control_name, _ = compose_name(projects, "/w/Web/imc-support/docs")
    assert no_control_name == "Web" + NAME_SEPARATOR + "imc-support/docs"
    assert no_control_name != out["display_name"]


def test_a_leaf_match_needs_a_separator_boundary():
    """Without it any leaf matches any slug ending in its letters."""
    projects = _projects([(1, "/w/P", "P")])
    # The recorded path and the slug disagree by an interior component,
    # which is the real ``Production/tools/`` case; the leaf still ties
    # them together.
    good = _cwds({"-w-P-msp-dashboard": {"/w/P/web/msp-dashboard": 1}})
    assert _derive(projects, good, "-w-P-msp-dashboard")["evidence"] == (
        EVIDENCE_LEAF_MATCH
    )
    # A slug whose tail merely ENDS in those letters is not a match.
    bad = _cwds({"-w-P-supermsp-dashboard": {"/w/P/web/msp-dashboard": 1}})
    assert _derive(projects, bad, "-w-P-supermsp-dashboard")["matched_by"] == (
        MATCHED_NONE
    )


def test_a_path_match_is_never_diluted_by_a_mid_session_directory_change():
    """The strong rung is tried across every cwd before the weak one."""
    projects = _projects([(1, "/w/P", "P")])
    slug = "-w-P-vault-cleanup"
    cwds = _cwds({slug: {
        "/w/P/vault-cleanup": 50,
        "/w/P/vault-cleanup/reports/2026-05-26": 2,
    }})
    out = _derive(projects, cwds, slug)
    assert out["evidence"] == EVIDENCE_PATH_MATCH
    assert out["observed_cwd"] == "/w/P/vault-cleanup"


# --- the published vocabulary -----------------------------------------


def test_the_derived_rung_is_opt_in_and_does_not_widen_the_old_contract():
    """A client already renders a name for MATCH_KINDS_NAMED.

    Adding the derived rung to that tuple would make every existing
    client start showing a derived name it never agreed to trust, which
    is exactly what the second constant exists to prevent.
    """
    assert MATCHED_DERIVED_CWD not in MATCH_KINDS_NAMED
    assert MATCHED_DERIVED_CWD in MATCH_KINDS_NAMED_WITH_DERIVED
    for kind in (MATCHED_DERIVED_CWD, MATCHED_SCRATCH_PATH, MATCHED_CWD_CONFLICT):
        assert kind in MATCH_KINDS


@pytest.mark.parametrize("kind,index,slug", [
    (MATCHED_CANNOT_DETERMINE, empty_cwd_index(), "-w-p"),
    (MATCHED_NONE, _cwds({}), "-w-p"),
])
def test_no_refusing_rung_may_carry_a_name(kind, index, slug):
    """One place builds the result, so a refusal cannot smuggle one out."""
    out = derive_name_from_cwd(_projects([]), index, slug, aliases=NO_ALIASES)
    assert out["matched_by"] == kind
    assert out["display_name"] is None
    assert out["evidence"] is None
    assert out["anchor_project_id"] is None


# --- the fallback rung the owner's data does not exercise --------------


def test_an_unanchored_directory_falls_back_to_its_own_parent():
    """UNEXERCISED on the owner's data: all 8 of his land on a real anchor.

    It exists for a corpus collected on another machine, or a project
    deleted from cloude.db. Covered here rather than left to hope,
    because a rung nobody has watched fire is unmeasured, not proven.
    """
    out = _derive(_projects([]), _cwds({"-w-orphan-leaf": {"/w/orphan/leaf": 1}}),
                  "-w-orphan-leaf")
    assert out["matched_by"] == MATCHED_DERIVED_CWD
    assert out["display_name"] == "orphan" + NAME_SEPARATOR + "leaf"
    assert out["anchor_project_id"] is None


def test_a_top_level_directory_stands_alone():
    """There is no parent to qualify it with, and '/ name' would be noise."""
    out = _derive(_projects([]), _cwds({"-top": {"/top": 1}}), "-top")
    assert out["display_name"] == "top"
