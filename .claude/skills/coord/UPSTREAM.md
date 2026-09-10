# where this skill came from, and how we notice when it moves

adoom666 wrote this skill. ccsliinc adopted it on 2026-09-10 after evaluating
it against our own `scripts/coord.sh`, which is retired.

**Upstream is `adamdev/master:.claude/skills/coord/`** (adamdev is
`git@github.com:Adoom666/CloudeCodeDev.git`). Upstream ships two files,
`SKILL.md` and `coord.py`. `coord_ccsliinc.py` and this file are ccsliinc's and
have NO upstream, which is why the guard does not track them. Our copy of his
two files is NOT byte-identical:
see the "what ccsliinc added" section at the bottom of `SKILL.md` for every
difference, all of which are additive and marked in place.

## the fork point

Recorded so a guard can tell HIS copy moving from OUR copy diverging. These are
git blob shas, not file hashes: read them with `git rev-parse`, not `shasum`.

```
upstream-commit: ee242110d6384cdfdb34757ebf9c61dd77b5d2b3
SKILL.md:        9dae64a50f9f7a3df2c0ae6ce1c37a8d42df0598
coord.py:        ed5c7081348726fc421cc56228151c89d95f2cfb
```

## the guard

`tests/test_coord_skill_upstream_sync.py` compares those recorded blob shas
against `adamdev/master` and FAILS when they differ. It reads the local
remote-tracking ref, so it needs no network and proves only that we are current
with the LAST FETCH. That is stated in the failure text rather than glossed: a
guard that overclaimed what it measured would be worse than none.

When `adamdev/master` carries no such ref at all, the test SKIPS with a reason
naming what went unmeasured. **Not having looked is not a pass.**

## when it fails

1. `git fetch adamdev master`
2. `git diff <recorded sha> adamdev/master:.claude/skills/coord/coord.py`
   and the same for SKILL.md. Read what he changed.
3. Decide what to take. This is a judgement call and it is why the guard is a
   test rather than an auto-merge: his change may conflict with something we
   ported, and a silent overwrite would drop a capability we added on purpose.
4. Re-apply the ccsliinc block if it was disturbed, run the skill's own
   `check` both ways (it must FIRE on a real intersection and stay QUIET on
   none), then update the shas above in the same commit.
5. Tell him on the coord branch, in a file named `ccsliinc-*`.

## refreshing the shas

```
git rev-parse adamdev/master
git rev-parse adamdev/master:.claude/skills/coord/SKILL.md
git rev-parse adamdev/master:.claude/skills/coord/coord.py
```
