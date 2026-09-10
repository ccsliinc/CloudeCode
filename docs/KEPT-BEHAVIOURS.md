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

The owner ruled on all of this on 2026-09-10 and the ruling is recorded in
`docs/DECISIONS.md` under "Neither party deletes the other's design; a contested
one ships as a plugin". That entry binds; everything below explains it and says
how it is checked.

## The policy, in full

**What counts as a kept behaviour, and who may add one.** Something a party
relies on and would notice losing. It does not have to be ruled on, elegant, or
agreed with. Each party writes its own file and only that party adds to, edits
or retires entries in it. No permission is needed to add one, and nobody may
touch someone else's file.

**Removing one is a stop-and-ask.** Removing a behaviour on another party's list
needs that party's agreement or the owner's ruling. Absent either, stop and
surface it, and work the parts that do not intersect meanwhile. THE OTHER SIDE'S
COMMIT INTENT IS NOT AUTHORITY OVER YOUR SIDE'S KEPT BEHAVIOURS. Both of this
week's incidents were that one mistake, and neither side is the villain:
adoom666's row menu removed three behaviours ccsliinc relies on, one of them
ruled on the day before; and ccsliinc's own merge nearly deleted the owner's
double-click rename purely because an incoming commit intended to, until he
stopped it with "i said merge not take everything".

**When two designs conflict, BOTH SHIP.** There is no default winner. One of
them ships as a plugin contribution on the surface registry
(`web/src/lib/plugins/`, four surfaces, build-time TypeScript modules only,
because `script-src 'self'` means "fetch a plugin and run it" has no
implementation here) or behind a plain setting, and each party defaults it to
its own preference. The manual mark-unread control is the worked example that
already shipped: `ui.show_mark_unread_control`, default true in `src/config.py`,
reported by `GET /api/v1/features`, so turning it off is a setting rather than a
deletion. Reading the two kept lists side by side is then what shows which
behaviours the core app owes everybody and which are one party's taste, which is
the reason for keeping both lists rather than arguing to one.

**The exit, in both directions.** A policy with no exit is a ratchet, so:

| move | who has to agree |
|---|---|
| plugin becomes core | the party that was defaulting it off. It changes its default and the entry moves to the core list. |
| core becomes plugin | the same agreement a removal needs, because it is a removal from the default screen. It lands as a setting defaulting to whatever the relying party had. |
| an entry is retired | its own party, alone, at any time. Dropping your own claim harms nobody. |

That last row is the pressure valve. Without it the list only ever grows, and a
list nobody finishes reading protects nothing.

## What this is NOT

**Themes are already extensible and are not part of this.** A theme is a JSON
manifest at `client/css/themes/<id>/theme.json`, 23 of them, measured the same
on this branch and on `feat/svelte-1.3-on-121` (the plugin registry's own
docstring says 26; 23 is what the tree holds), plus a user themes directory that
the themes endpoint scans, with an optional consent-gated `effects.js`. Anything that only
needs to recolour something is a theme manifest, not a plugin. Nobody should
rebuild that on the plugin registry.

**It is not a work tracker**, it has no status, no owner and no done state, and
every status stays derivable from PR state. See below.

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

## The format, and what an anchor is

Each entry under `## kept` is a `### ` heading followed by three fields, then
prose. A `## disliked` section is preference rather than a claim and is not
guarded, because a preference has nothing in the tree to point at.

    ### the behaviour, in a short phrase
    paths: client/js/one.js src/core/two.py
    anchors: someCallSite | data-some-attribute
    tests: tests/test_one.node.mjs
    <prose: what it is, why it is relied on, what breaks without it>

- `paths` is space separated. List every file the behaviour lives in, including
  ones on another branch; the guard only searches the ones that exist.
- `anchors` is PIPE separated, because an anchor can contain spaces. Each anchor
  must appear in at least one of the paths that exists.
- `tests` is space separated, or the single word `none`. `none` is the honest
  answer and is never a build failure. Naming a test that does not really cover
  the behaviour would be worse than the gap.

**AN ANCHOR NAMES A CALL SITE, NOT A WORD, and this was learned the expensive
way while building the guard.** The first anchors on the double-click rename
entry were `dblclick` and `beginEdit`. Replayed against `8898f07`, the commit
that actually deleted the gesture, NEITHER FIRED: the commit left prose about
double-click in the module header, and kept `beginEdit` because F2 still calls
it. An anchor that can match a comment reports a behaviour as alive because
someone wrote its name down. The anchors that work are `onDblClick`, the
exported handler, and `addEventListener('dblclick'`, the registration. Pick
something the behaviour cannot function without.

## The guard, and why this one

    ./venv/bin/python3 scripts/check_kept_behaviours.py
    ./venv/bin/python3 -m pytest tests/test_kept_behaviours_guard.py -q

Exit 0 clean, 1 findings, 2 could not scan. 2 IS NOT A PASS.

The retired `coord` protocol warned in BOTH directions on `wants/<party>.md`
before work started. `work.sh check` intersects a path list against open ISSUES
only, so a behaviour nobody has an open issue about is invisible to it, and both
of this week's incidents came through that hole with no open issue naming the
files involved. Three ways to close it were weighed:

- **CODEOWNERS on the behaviour paths.** Requests a review. `docs/DECISIONS.md`
  records that CloudeCodeDev runs an unprotected main by choice, so the request
  is advisory, and it cannot fire at all on a commit authored in the other
  developer's own clone. That is how the first incident arrived. Misses both.
- **A line in the issue template.** Only fires when the change was filed as an
  issue first, which neither incident was. The second was a merge, and a merge
  is never an issue. Misses both. Worth adding anyway as a prompt, but it is not
  the mechanism.
- **A check against the resulting TREE.** The only one that sees a merge and the
  only one that sees work that arrived from somewhere else. Built.

It is the same machinery as `tests/test_no_remote_assets.py`, run in the other
direction: that test fails when a forbidden string APPEARS, this one fails when
a required string DISAPPEARS.

**Measured, in both directions.** Against the tree of `8898f07` it names all
four behaviours the two incidents removed and says nothing about the other four
entries in the same file. Against this branch it reports zero fatal findings.
A guard that always finds something is worse than useless, so its silence is
tested as carefully as its noise: `tests/test_kept_behaviours_guard.py` mutates
one behaviour and demands the guard name that one and stay quiet about the
other.

**It is symmetric and it is cheap to join.** Every file in
`docs/kept-behaviours/` is read, so a new party's file is guarded the day it
lands with no code change. An entry that declares only `paths:` is REPORTED as
unguarded and fails nothing, so nobody's first commit breaks on a convention
they never agreed to. `--strict` turns those reports into failures and
ccsliinc's file is held to it, which is how one side takes the higher bar
without imposing it on the other.
