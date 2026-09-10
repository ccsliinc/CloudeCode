---
party: adoom666
id: adoom666-unmeasured-is-not-absent
title: a detector that answers "nothing to see" on input it could not read
observed: 2026-09-10
occurrences: 7
supersedes:
scope: codebase
---

## pattern

A function whose job is to NOTICE something is handed input it cannot
interpret, or reads a source that is not ready, and returns the same answer
it returns when there is genuinely nothing to notice. The caller cannot tell
"I looked and found nothing" from "I could not look", so a failure to measure
is silently promoted to a measurement of absence.

Seven occurrences, across two repos and two teams, none of whom recognised it
as a repeat at the time.

1. **`coord.py expired()`.** An unreadable claim date returned "expired" and
   the overlap detector skips expired claims. A typo'd header made a claim
   invisible to the one function whose job is catching collisions.
2. **`listing_proves_alive`, `c8ef6a8`.** First version trusted a bulk
   listing's silence both ways. Four rename tests caught it dropping live
   sessions. Now asymmetric: a naming proves existence, an absence proves
   nothing and still pays `is_alive()`.
3. **`resolve_startup_gate`.** No tail captured refuses with `unknown`; tail
   read and nothing matched answers `ready`. Two answers, two reasons.
4. **`refuse_if_transcript_missing`.** `unchecked` never refuses. "Not having
   been able to look is not evidence a file is gone."
5. **The `unknown` status itself.** "A real answer and never `idle`." A tmux
   `running` pane maps to `unknown`, not `working`.
6. **The uuid matcher.** "A matcher that always finds something is worse than
   useless", with a mandatory negative control. Same failure, opposite sign.
7. **NEW, 2026-09-10, ccsliinc on ArgentSI, and the most instructive one.**
   GitHub's own API is not read-your-writes consistent. Immediately after
   `gh pr create`, `gh issue view N --json closedByPullRequestsReferences`
   returned `[]`. **Twelve seconds later the same call returned `[7]`.** An
   agent following the documented procedure reads the empty list as "no
   competition, the claim is mine". The defect had moved into the layer whose
   entire purpose is preventing two agents from taking the same work.

Number 7 matters because it is not a coding mistake. The code was correct,
the API was correct, and the eventual consistency window did the rest. The
pattern survives being careful.

**AND THE MEASUREMENT MAKES IT WORSE THAN A RACE.** ccsliinc timed the full
sequence against a live, idle repo with zero contention:

    issue create        : 1s
    develop+commit+push : 5s
    gh pr create        : 2s
    linkage confirm     : 7s   (2 attempts - the FIRST read came back empty)
    TOTAL               : 15s typical, 48s bounded

The first read returning empty is the NORMAL path, not an edge case. On an
idle repo. So this was never "a race that occasionally bites": it was a
command that returns the wrong answer on the first try, every time, and it
would have fired on the very first real claim.

That distinction is the reason to measure rather than reason. A race you
would test for by inducing contention, find nothing, and ship. Timing the
happy path found it immediately.

## resolution

**Give the unmeasured case its own answer.** Found, measured-absent,
could-not-measure. Collapsing the third into the second is the bug, every
time.

**Then choose the failure direction from what the consumer is FOR.** There is
no universal safe direction, only a universal requirement to know which case
you are in:

- The overlap detector REPORTS on unknown. Missing a collision is the cost.
- The sub-agent notification gate ALERTS on unknown. A missed alert is worse.
- The mute gate SUPPRESSES on unknown. The user asked for quiet; alerting
  them because a read failed breaks the thing they asked for.

**FOR AN EVENTUALLY CONSISTENT SOURCE, MAKE THE READ SELF-CHECKING.** This is
ccsliinc's fix for number 7 and it is the best answer any of the seven
produced, because it needs no guessed timeout. The agent already knows its
own PR number. So the read is only VALID once the response contains that
number. Absence of your own write means a stale index, not an uncontested
issue. Bounded retry, and on exhaustion it reports could-not-confirm rather
than concluding it won.

Generalised: **when polling a source you have just written to, validate the
response against your own write, not against emptiness.** Emptiness is
ambiguous. Your own record appearing is proof the index has caught up.

**And say in the procedure that the retry WILL loop.** An agent told the
claim takes a second, that then waits forty, concludes it hung and kills it.
Killing it mid-claim is its own hazard: the branch and the draft PR may
already exist, so a re-claim opens a second PR against your own issue and
loses your own tie-break to yourself. The recovery is to check what you
already own before retrying, not to start over.

## how we know it works

Items 2 through 6 are shipped and have held. Item 1 is fixed and verified
against six malformed inputs. Item 7 is ccsliinc's, fixed with the
self-checking retry described above and measured across a real twelve second
window.

The reason to write at two occurrences rather than seven: each of these was
found by a different person or agent, none recognised it as a repeat, and the
same defect was therefore re-derived six times across two codebases.

Updated after ccsliinc timed the sequence. The timing is what turned this
from "a race" into "wrong on every first call", and neither of us would have
learned that from reading the code.
