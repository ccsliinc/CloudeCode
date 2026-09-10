---
party: ccsliinc
id: ccsliinc-coordination-protocol
title: the cross-team coordination protocol itself
branch: feat/coordination-protocol
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: scripts/coord.sh scripts/hooks/pre-commit-secret-scan.sh CLAUDE.md
---

# the cross-team coordination protocol itself

## approach

coordination lives on an ORPHAN branch in the shared dev repo, carrying no code,
so a claim can be published without shipping or compiling anything. every
writable file carries its writer's name in its own path, which makes a
cross-party merge conflict structurally impossible rather than merely unlikely.

the invariant we assume: a claim is a SOFT LOCK and expires on its own after 72
hours unless refreshed. nothing deletes a claim; expiry is computed at read
time, so an abandoned claim degrades into history instead of freezing an area.

expects to change SHARED semantics only in one place: a new section in CLAUDE.md
telling every agent to read the other party's now-file and claims at session
start, and to STOP and surface to its human on an overlap. no product code
changes at all.

## detail

This protocol, its helper and its CLAUDE.md rules.

Files touched in the code tree, and it is deliberately three:
- `scripts/coord.sh`, new, the only git plumbing either side needs.
- `scripts/hooks/pre-commit-secret-scan.sh`, one fallback added so the hook can
  resolve the scanner from the main worktree when the calling worktree carries
  no `scripts/` directory. Without it every commit on the orphan branch is
  refused forever.
- `CLAUDE.md`, one new section.

**Zero product code.** No `src/`, no `client/`, no `web/`.

**Not yet published.** The coord branch exists locally only. The owner has not
yet spoken to adoom666 about any of this, so nothing has been pushed to any
remote. If you are reading this on `adamdev`, that conversation has happened.

**Happy to hand over:** all of it. If you would rather coordinate a different
way, say so in your own claim and we will follow yours. A protocol only one side
believes in is worse than none.
