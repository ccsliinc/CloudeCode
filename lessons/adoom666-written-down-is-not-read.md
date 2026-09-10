---
party: adoom666
id: adoom666-written-down-is-not-read
title: a safeguard that is not on the read path is decorative
observed: 2026-09-10
occurrences: 2
supersedes:
scope: workflow
---

## pattern

A rule exists, is correct, and is written down. It is not on the path the
actor walks before acting. So it does not fire, and everyone who wrote it
believes the risk is covered.

Both parties found this in their own repo within ten minutes of each other,
having just agreed on the principle. Neither had checked.

**ccsliinc / ArgentSI, measured.** `berzerker` identifiers are deliberate and
must never be renamed. `docs/NAMING.md` exists and says so. `CLAUDE.md` does
not reference it. Neither does `AGENTS.md`. Neither does `CONTRIBUTING.md`.
Only `README.md` links it. `CLAUDE.md` carries zero warning against renaming
on its own. **1,196 files** contain the identifier. `CLAUDE.md` is the first
file every Claude Code agent loads, so an agent told to make naming
consistent reads the instruction file, sees nothing, and has 1,196 files of
apparent inconsistency in front of it.

Their words: "I wrote the file, felt covered, and never checked whether it
was on the path the dangerous agent actually walks."

**adoom666 / cloudecode, measured.** Worse in kind, smaller in blast radius.
"Cloude" is a deliberate misspelling across **55 files** in `src/`, `client/`
and `docs/`, covering the tmux socket name, the app bundle, the config paths
and the session prefix. It is documented as deliberate in **zero** places.
Not `CLAUDE.md`, not `README.md`, nowhere. The only two files in the repo
containing "not a typo" are a test about an archive overlay and the coord
skill written today.

**And the same repo, generalised past naming.** Of 23 files in `docs/`, only
**3** are referenced from `CLAUDE.md`: `secret-scanning.md`,
`session-status.md`, `upgrade-with-claude.md`. The other 20 are orphaned from
the entry point, including `alert-state-model.md`, `message-model-gate.md`,
`project-reconcile.md` and `test-artifact-cleanup.md`. Every one of them is
knowledge an agent could need and will not find.

## resolution

**Measure the read path, do not assume it.** The question is not "is it
documented", it is "is it reachable from the first file the actor loads,
before it acts". Those are different questions and only the second one
matters.

The check is mechanical and takes a minute:

    for f in docs/*.md; do
      grep -q "$(basename "$f")" CLAUDE.md || echo "ORPHANED $f"
    done

Not every document belongs on the read path. A deploy runbook can be
orphaned. **A prohibition cannot.** If a document exists to stop someone
doing something, and the entry-point file does not carry at least the
prohibition itself, the document is decorative.

**Put the prohibition inline, and the detail behind a link.** One line in
`CLAUDE.md` saying "the misspelling is deliberate, never correct it, see
docs/NAMING.md" is worth more than the whole document, because the line is
on the path and the document is not.

**The dangerous actor is often not a participant.** This is the boundary of
the coordination protocol itself and it is worth stating plainly: the coord
branch only constrains agents that read it. An agent asked to tidy naming
has no reason to read a coordination branch, will never see a claim, and can
do more damage in one pass than any collision this protocol was built to
prevent. Coverage of participants is not coverage of the repo.

## how we know it works

It does not yet. Both findings are hours old and neither fix has landed,
because in both repos `CLAUDE.md` belongs to the owner and neither agent
would edit it on the other's say-so. Both are surfaced to him with file
counts and the specific failure.

That delay is itself the correct behaviour and worth recording: a peer
session identifying a real hazard is not authorisation to change another
person's instruction file. The right move was to measure it, name it, and
hand it over.

Revisit when the fixes land. If an agent still renames something after the
prohibition is inline, the resolution above is wrong and the answer is
probably a test rather than a sentence.
