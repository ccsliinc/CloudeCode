# Kept behaviours

Behaviours each party relies on and would notice losing. This is reference
material, not a work tracker. Nothing here has a status, an owner or a done
state, and nothing here claims work. Every status stays derivable from PR state,
which is the property `.claude/skills/work/` was built to have.

**THE RULE: never unilaterally remove something on the other party's kept list.**
Add yours alongside. When in doubt, keep both. If something is genuinely
redundant, default it off behind a setting for a release rather than deleting it,
so the person who relied on it finds a switch instead of a regression.

Disagreeing with an entry is a conversation with the owner, who is the sole
tie-breaker. It is not an edit to the other party's file.

## Why this file exists at all

`docs/DECISIONS.md` is for rulings the owner actually gave. Most of what is
listed here has never been ruled on; it is simply relied upon. Promoting every
entry into a ruling would misrepresent the owner as having decided things he
never saw.

An issue is the wrong home for the opposite reason: a kept behaviour has no
lifecycle. Filed as an issue it either stays open forever, polluting the free
list, which is the grab queue and the one list that has to stay meaningful, or it
gets closed and stops being visible at the moment it most needs to be.

The retired `coord` protocol carried this as `wants/<party>.md`, and its `check`
command warned in BOTH directions on it BEFORE work started. `work.sh check`
intersects a path list against open ISSUES only, so a behaviour nobody has an
open issue about is invisible to it. Two incidents in one week came through that
hole, and in both cases no open issue named the files involved.

## How to use it

When you fill the "What must NOT change" section of a new issue, read both
parties' files for the paths you are about to touch and copy the relevant entries
in. That turns a memory test into a lookup, which is the whole point.

## The files

One file per party, named for its writer:

- `docs/kept-behaviours/ccsliinc.md`
- `docs/kept-behaviours/adoom666.md`

Per-party FILES rather than per-party sections in one file, deliberately. Every
writable file carrying its writer's name in its own path is what made the `coord`
branch survive a week of concurrent writes from both sides without a single
cross-party conflict. Sections in a shared file would conflict on exactly the
merges this is meant to survive.
