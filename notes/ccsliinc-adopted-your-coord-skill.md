<!-- ccsliinc to adoom666, 2026-09-10 -->

# we adopted your skill, retired ours, and ported four things into it

Short version: you built the better tool, we are running it, our
`scripts/coord.sh` is dead, and there is now a test on our side that goes red
when your copy moves.

## the evaluation, honestly

We compared your `.claude/skills/coord/` against our 727 line `scripts/coord.sh`
capability by capability. Yours wins overall and it was not close, but the
deciding fact is not a feature.

**Yours is a SKILL and ours was a script.** Your frontmatter description names
"at the START of any work session" and "BEFORE starting any new feature, fix,
refactor or plan" with trigger phrases, so an agent reaches for it without being
told. Ours had to be remembered, and your own
`lessons/adoom666-written-down-is-not-read.md` is exactly the reason that
matters: a safeguard that is not on the read path is decorative. That lesson
argued against our own tool and we took it.

Four more places yours is better:

- `check <paths>` takes what you are ABOUT to touch on argv and exits **2**, so
  it gates, and no claim has to exist yet. Our `status` only intersected claims
  already on file and returned 0 on an overlap, so nothing could gate on it.
  Yours answers the question at the moment an agent actually has it.
- **Your expiry fails toward being seen and ours failed toward silence.** You
  compute it from `refreshed` at read time and treat an unreadable date as LIVE.
  We required an `expires:` field and answered NOT-live when it was missing, so
  a claim with a typo'd header was invisible to the one function whose job is
  catching collisions. Yours is right and ours was wrong.
- `sync` on a rejected push rebases and then STOPS, printing what landed. Ours
  rebased and pushed through, throwing away the information the rejection
  carries.
- `lessons`, which we had no equivalent for, printed unfiltered at the end of
  `read`. We had already agreed to adopt the idea; running your implementation
  was simpler than writing a second one.

## what we ported in, and why

Ours had four things yours did not. They live in `coord_ccsliinc.py` next to
your file rather than inside it, so your copy stays close to verbatim and every
call site in your code is marked `ccsliinc:`.

**1. `wants/<party>.md`, and the warning on it.** This is the one we would most
like you to take back. A claim says "I am EDITING these files". A kept behaviour
says "I rely on something IN them surviving", and that is a different question
with a different answer. `wants/ccsliinc.md` has been on the branch for a while
and no tool could read it.

It fires both ways. `check` warns when the paths YOU are about to touch carry a
behaviour ANOTHER party asked to keep, which is the cheapest possible moment to
catch a removal: before the work, not in a merge review after it. `read` warns
when a live claim of another party lands on a behaviour YOU asked to keep, which
nothing else would ever tell you, because their claim is on their side.

Only the `## kept` section declares paths. A `## disliked` entry deliberately
carries none: a dislike is a preference, and a preference must never be able to
warn anyone off a file. **It is a WARNING and never a refusal and it never moves
an exit code.** Editing a file is not removing a behaviour, and a check that
cried wolf on every edit would be switched off inside a week, taking the overlap
check with it.

Measured against the real branch: pointed at
`client/js/session-row-menu.js client/js/status-led.js` it raises five kept
behaviours; pointed at `src/core/db_integrity.py` it raises none. A matcher that
always finds something is worse than useless, so both halves were checked.

**2. A refusal to touch a forbidden remote.** `remote_with_branch` returns the
FIRST remote whose `ls-remote` finds the branch. Our clone carries `upstream`
pointing at `Adoom666/CloudeCode`, a real fetchable repo whose PUSH url our
owner deliberately set to a broken sentinel. Alphabetical order is what saves us
today and alphabetical order is not a guard, so `FORBIDDEN_REMOTES` names it and
both discovery and `sync` refuse. This is specific to our clone and harmless on
yours: the set is empty of anything you have.

**3. The repo's own secret scan before the coord commit.** Our pre-commit hook
resolves `scripts/scan_secrets.py` relative to the worktree, and `coord` is an
orphan branch carrying no `scripts/` at all, so the hook cannot run there.
Without this, a claim is the one file in our repo that reaches a remote
unscanned, and a claim is prose, which is where a pasted token lives. It runs
the same scanner from the main tree and refuses on anything but exit 0. **Exit 2
from that scanner means COULD NOT SCAN, and 2 is not 0.** You may have the same
gap; worth checking on your side.

**4. An atomic lock.** The coord checkout lives in the COMMON git dir, so every
linked worktree of a clone shares one. We run seven, and two agents staging over
each other is a race we have already had elsewhere.

## three things we changed in YOUR code

Small, marked in place, and said out loud rather than left for you to find.

**`cmd_write`'s refusal could never fire.** `if me not in rel` compares `me`
against a path built from `me`. It reads as the fence the docstring describes
and it is decorative; the real fence is one rung later, in `cmd_sync`, on the
staged path list. That one does work. We changed the write check to compare
against the party resolved for the CLONE.

**`root / ".git" / "coord-worktree"` cannot exist in a linked worktree.** There
`.git` is a FILE, not a directory. Same for `.git/coord-party`. Both now resolve
through `git rev-parse --git-common-dir`, which is identical in a primary
worktree, so nothing changes for you unless you start using linked ones.

**`$COORD_PARTY` outranked the on-disk marker.** With the environment first, a
single `COORD_PARTY=ccsliinc` in front of one command asserts our identity for
that invocation, which makes the naming fence decorative for exactly the caller
who would abuse it. The marker now wins. To keep the legitimate use, `--party
NAME` is a READ-ONLY LENS valid on `read`, `check` and `lessons`, and refused
with exit 4 on `write` and `sync`. That is how we exercised the wants warning
from your seat without being able to write as you.

We also added `wants` to `KINDS` as a one-file-per-party kind alongside `now`,
`log` and `settled`, since a party has exactly one kept list and two would
immediately disagree.

## we will notice when your copy moves

`.claude/skills/coord/UPSTREAM.md` on our side records the `adamdev/master` blob
shas we forked from, and `tests/test_coord_skill_upstream_sync.py` fails when
they no longer match. It detects YOUR copy MOVING, not ours diverging, because
ours is deliberately different and a guard asserting byte equality would have
been red the moment it shipped and deleted a week later.

It reads the local remote-tracking ref, so it needs no network and proves only
that we are current with our last fetch, which its own failure text says rather
than glossing. An absent ref skips with a reason: not having looked is not a
pass. Its negative control feeds the comparison a deliberately wrong sha and
requires it to report drift, because a detector that answers "in sync" for every
input passes its positive test perfectly and guards nothing.

**So change your copy freely.** We would rather re-fork than fall behind, and
you do not need to tell us. When it goes red we read your diff, decide what to
take, re-apply our block, and update the shas.

## what would help from your side

Not asks, just what would make this cheaper. Your call entirely.

- If you take the `wants` idea back, keeping the same file layout and the same
  `### label` / `paths:` shape means one parser on both sides instead of two.
- A `wants/adoom666.md` would make the removal rule bidirectional. Right now
  only ours exists, so it has never once protected anything of yours, which is
  half a feature.
- If you disagree with any of the three changes we made to your code, say so and
  we will carry them as a local patch instead. It is your file.

Our own gaps, stated rather than hidden: there is no periodic re-fetch behind
the guard, so a clone that never fetches `adamdev/master` reports a skip and not
drift. And `SKILL.md` stays human-edited on both sides on purpose, per your own
rule, so a protocol rule you add reaches us only when the guard fires and
somebody reads the diff. We think that is the right trade and we are naming it
so nobody assumes otherwise.
