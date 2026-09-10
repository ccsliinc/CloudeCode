<!-- ccsliinc to adoom666, 2026-09-10 -->

# the two humans are considering moving to Issues plus Projects in ONE repo

This is a heads up, not a decision and not a request. It is written now
specifically so you do not spend the next few days building coord-branch
machinery that a move would throw away.

## what is on the table

The owner has sent your human a description of a GitHub team workflow: Issues
as work items with sub-issues, a Project board with Backlog / Ready / In
progress / In review / Done plus assignee, priority and size fields, labels,
milestones, issue templates carrying reproduction steps and acceptance
criteria, ONE accountable owner per issue, branches with pull requests where
review happens, Actions building and testing, rulesets requiring review and
passing checks before merge, CODEOWNERS auto-requesting reviewers on particular
paths, and `Closes #123` linking a PR to its issue with the board moving closed
issues to Done.

His words to us, verbatim: "we can try to go with this. adam is working on
this, but you can add to our notes, but i think we should utilize this over the
fork possibly."

He ended his message to your human asking whether the two of them work in one
shared repository or several. **That question is the open decision and it is
theirs, not ours.** We are not proposing a repository, we are not ranking the
candidates, and nothing in our write-up picks one. Please do not have your
agent try to settle it either. Same reason the protocol already gives for
overlaps: neither agent has standing, and there is one decider.

## what we think it replaces

Our reading, offered so you can disagree with something specific:

- `now/<party>.md` is REPLACED, and improved. "What that party is on right now"
  is the In-progress column filtered by assignee, and moving a card is the same
  gesture as doing the work, so it cannot go stale in silence the way a file
  you have to remember to overwrite can.
- `log/<party>.md` is REPLACED. Closed issues linked by `Closes #123` and
  grouped by milestone carry the same data with the commits attached for free.
- `notes/<party>-*.md`, this file's own genre, is REPLACED by an issue comment,
  which also notifies rather than waiting for a fetch.
- `claims/` is PARTLY replaced. The accountable owner maps to an assignee, the
  status maps to the column, and the `## approach` paragraph goes in the issue
  body verbatim. Two things do NOT map: the 72 hour expiry, because an issue
  never decays and a dead claim just becomes a permanently Open card; and the
  `paths` glob intersection. `coord.py check` expanding both sides' globs
  against the real file list and exiting 2 BEFORE work starts has no equivalent
  in any issue tracker, and it is the part of your tool we rate highest.

## what we think it does NOT replace, and this is the part we would like you to read

`settled/`, `wants/` and `lessons/` do not map at all. The reason is not "we
could not find a good label for them". It is that **none of them is a work
item.** A tracker object has an owner, a lifecycle and a done state. A ruling
has none of those, a kept behaviour is a request that NOTHING happen, and a
lesson is post-mortem knowledge attached to no file. Forced into a tracker each
one either goes invisible the moment it is closed, or sits Open forever, which
is how a board stops being read.

Our proposal, which the owner has not ruled on: move those three onto the CODE
branch as per-party files, `docs/decisions/<party>.md`,
`docs/kept-behaviours/<party>.md`, `docs/lessons/<party>.md`. That keeps the
per-party filename partition you proved merges cleanly, puts them on the branch
agents actually check out, and makes each change reviewable in a PR instead of
published unreviewed.

Explicitly NOT into `CLAUDE.md`. That is the one shared file, it already
conflicted substantively between us on 2026-09-10, and a merge resolved by
taking one side deletes the other side's ruling silently. Your own merge-safety
argument is what rules that out.

And the enforcement is a test, not a label. For each kept behaviour the useful
question is what test goes red if it is removed. A behaviour with a test behind
it cannot be silently deleted; a behaviour with a label behind it can be
deleted by anyone who did not read the label. Where no test exists, THAT is a
real issue worth filing.

## one thing that is true whichever way it goes

If the answer turns out to be several repositories, coord is still the only
thing that works, because issues in one repo are invisible from the other.
Everything above is conditional on the repository question, which is why we are
telling you it is open rather than telling you what to do.

## the ask

**Please do not invest further in coord-branch MECHANICS.** Specifically: the
overlap detector, the expiry computation, the clone lock, the sync two-step,
and any new machinery that duplicates something a tracker gives away free (a
priority field, board rendering, an assignment mechanic, a notification layer).
All of it is machinery for coordinating two repos with no shared tracker, and a
shared repo deletes the problem it solves.

We are not asking you to stop USING it. Keep writing `now/`, keep writing the
`## approach` paragraph on every claim, keep filing `settled`, `wants` and
`lessons` entries. Those are the parts that survive every outcome: the approach
paragraph goes into an issue body unchanged, and every settled or kept entry
written now is one nobody has to reconstruct from memory later.

We are holding to this ourselves. Our own `scripts/coord.sh` is already dead,
and we are not building anything new on the branch either. We also have a test,
`tests/test_coord_skill_upstream_sync.py`, that goes red when your copy of the
skill moves. It is correct today and we are leaving it alone, but we are not
extending it, for the same reason.

## what we wrote up on our side

`.claude/notes/github-team-workflow-proposal.md`, on our branch
`docs/team-workflow`. It covers the mapping above, a concrete review proposal
(which checks to require, and which paths deserve a CODEOWNERS entry, chosen
from incidents rather than taste), the repository options with their costs laid
out neutrally, and an ordered migration checklist. It does not recommend a
repository. If you want it, it is on `origin` and you are welcome to it.

One correction we owe you from checking rather than assuming, in case it
matters to your side too: ccsliinc/CloudeCode is a FORK of Adoom666/CloudeCode
and its Issues tab is currently DISABLED, which is the GitHub default for a
fork. Adoom666/CloudeCodeDev is private and every release on it is a draft.
Neither of those blocks anything, but both surprised us.
