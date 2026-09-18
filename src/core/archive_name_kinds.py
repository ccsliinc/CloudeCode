"""Every value ``app_name_source`` can carry, and nothing else.

ONE PUBLISHED VOCABULARY, BECAUSE IT NOW HAS TWO PRODUCERS. The field
started life owned entirely by :mod:`src.core.archive_display_names`,
which names an archive slug from the app database's ``projects`` rows.
:mod:`src.core.archive_cwd_names` is a second rung below it, naming a
slug from the working directory the transcripts themselves recorded, and
it reports into the SAME field. A contract with two producers belongs in
a module neither of them owns: left in either one, the other grows its
own copy of the strings and a client eventually learns a value the
server never sends.

THE TWO "MAY RENDER A NAME" TUPLES ARE THE WHOLE POINT OF SPLITTING
THEM. :data:`MATCH_KINDS_NAMED` is what shipped, and a client already
renders a name for exactly those two. Adding the derived rung to it
would make every existing client start showing a DERIVED name it never
agreed to trust, silently, which is the widening this file exists to
prevent. :data:`MATCH_KINDS_NAMED_WITH_DERIVED` is the opt-in.

NO MODULE HERE IMPORTS ANYTHING. That is deliberate: a vocabulary that
depends on a resolver cannot be imported by the resolver.
"""

from __future__ import annotations

from typing import Tuple

#: A project row's own ``root`` or ``raw_path`` slugifies to this slug.
#: The strongest rung: the app recorded the very spelling Claude Code was
#: started in.
MATCHED_AS_WRITTEN = "as_written"

#: The slug was produced by a RESOLVED or ALIASED spelling of a project's
#: root - the symlink case. Still exact, still measured; it simply came
#: from a spelling the row does not literally store.
MATCHED_CANONICAL_SPELLING = "canonical_spelling"

#: No project row produces this slug. A MEASURED ABSENCE: the index was
#: read and nothing in it matches. The caller renders the slug.
MATCHED_NONE = "none"

#: Two or more projects at DIFFERENT real directories produce this slug,
#: and nothing here can say which the archive meant. Refuses rather than
#: picking, because a confident wrong name is worse than a slug.
MATCHED_AMBIGUOUS = "ambiguous"

#: The app database could not be read, so no question was asked. NEVER
#: collapsed into :data:`MATCHED_NONE` - "nothing matched" and "nobody
#: looked" render identically and mean opposite things.
MATCHED_CANNOT_DETERMINE = "cannot_determine"

#: A name was DERIVED from the working directory the transcripts
#: themselves recorded, because NO project row produces this slug. Added
#: 2026-09-18 and it is the reason ``app_name_source`` grew: it is not a
#: ``projects.display_name`` and must never be presented as one. The
#: derivation lives in :mod:`src.core.archive_cwd_names`; the constant
#: lives here so there is ONE published vocabulary.
MATCHED_DERIVED_CWD = "derived_cwd"

#: The recorded working directory is a per-run scratch directory
#: (``/private/tmp``, ``/tmp``, ``/var/folders``), so there is no project
#: name to have. A MEASURED outcome, deliberately NOT folded into
#: :data:`MATCHED_NONE` - "this is a temp directory" and "nothing
#: matched" are different things to tell a reader.
MATCHED_SCRATCH_PATH = "scratch_path"

#: Two or more DIFFERENT real directories were recorded under one slug.
#: Kept apart from :data:`MATCHED_AMBIGUOUS`, which is the app-database
#: rung's refusal, so a reader can tell WHICH layer could not decide.
MATCHED_CWD_CONFLICT = "cwd_conflict"

#: Every value an ``app_name_source`` field can carry, for a client that
#: wants to assert it understands the vocabulary before trusting a name.
MATCH_KINDS: Tuple[str, ...] = (
    MATCHED_AS_WRITTEN,
    MATCHED_CANONICAL_SPELLING,
    MATCHED_DERIVED_CWD,
    MATCHED_NONE,
    MATCHED_AMBIGUOUS,
    MATCHED_CWD_CONFLICT,
    MATCHED_SCRATCH_PATH,
    MATCHED_CANNOT_DETERMINE,
)

#: The rungs on which a RECORDED name may be shown. UNCHANGED by the cwd
#: work on purpose: a client already renders a name for exactly these,
#: and quietly adding the derived rung here would make every existing
#: client start showing a derived name it never agreed to trust.
MATCH_KINDS_NAMED: Tuple[str, ...] = (
    MATCHED_AS_WRITTEN,
    MATCHED_CANONICAL_SPELLING,
)

#: What a client that HAS opted in to derived names should render. The
#: opt-in is the whole point of it being a second constant.
MATCH_KINDS_NAMED_WITH_DERIVED: Tuple[str, ...] = (
    MATCHED_AS_WRITTEN,
    MATCHED_CANONICAL_SPELLING,
    MATCHED_DERIVED_CWD,
)

