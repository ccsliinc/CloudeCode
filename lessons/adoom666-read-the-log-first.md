---
party: adoom666
id: adoom666-read-the-log-first
title: both parties solved the same defect independently, twice
observed: 2026-09-10
occurrences: 2
supersedes:
scope: workflow
---

## pattern

Two parties fixed the same class of defect within a day of each other, with
neither aware of the other, twice.

First instance. ccsliinc landed `402526f`, titled "a bulk listing may only
vouch for its own socket". adoom666 landed `c8ef6a8`, which made the same
correction to the same reasoning: a listing that names a session proves it
exists, an absent name proves nothing. Same defect, two repos, same window.
ccsliinc's own README calls this out: "Same defect, two people, two repos, at
the same time."

Second instance. ccsliinc opened `claims/ccsliinc-session-row-menu.md` on
2026-09-10 to reseat the session row menu onto a typed plugin registry. On the
same day adoom666 landed `8898f07`, a session row action menu built as a
hardcoded list in `client/js/`. Four claimed paths collided exactly, including
a test file. Neither side knew until a human forwarded the branch by hand.

The common factor in both is not a merge conflict. In the 2026-09-10 merge
only two files conflicted and both were documentation; every code file merged
clean. The cost was two people doing the same work, and in the row menu case
one of the two implementations now has to be thrown away.

## resolution

Read `log/` before `claims/`, and read both before starting anything.

The reasoning: a claim tells you what someone INTENDS. A log tells you what
already EXISTS. Duplicate effort is prevented by the second, and both of these
incidents were duplicate effort rather than a contested area. `coord.py read`
prints now-files, claims and settled decisions; the log is the file to open
next and it is worth doing by hand until the tool prints it too.

Then run `check` with the paths you are about to touch rather than comparing
path lists by eye. In the row menu case one side wrote literals and the other
wrote globs; the strings look nothing alike and matched on expansion.

Then read every `## approach` paragraph, including for claims whose paths do
not intersect yours. The row menu collision WOULD have been caught by paths.
The listing collision would NOT have been: it was the same idea in two
different files, and only a paragraph would have surfaced it.

## how we know it works

Provisional. This lesson is written the same day as the second occurrence and
has not yet prevented a third. What it has already done is produce the reply
in `notes/adoom666-ccsliinc-menu-registry.md`, which is the first time either
party learned about an overlap before a merge rather than after one.

Revisit this entry after the next collision. If the next one is caught by the
log, raise `occurrences` and say so. If the next one is missed despite the
log, the resolution above is wrong and should be replaced rather than
appended to.
