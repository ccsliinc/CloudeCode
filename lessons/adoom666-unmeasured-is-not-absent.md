---
party: adoom666
id: adoom666-unmeasured-is-not-absent
title: a detector that answers "nothing to see" on input it could not read
observed: 2026-09-10
occurrences: 6
supersedes:
scope: codebase
---

## pattern

A function whose job is to NOTICE something is handed input it cannot
interpret, and returns the same answer it returns when there is genuinely
nothing to notice. The caller cannot tell "I looked and found nothing" from
"I could not look", so a failure to measure is silently promoted to a
measurement of absence.

ADAM-Docs asked whether this was worth a lesson at two occurrences. It is at
least six, and this codebase has independently arrived at the same principle
in five separate modules without anyone writing it down.

1. **`coord.py expired()`, 2026-09-10, today.** An unreadable claim date
   returned "expired", and `cmd_check` skips expired claims. A claim with a
   typo in its header was invisible to the overlap detector. In the one
   function whose entire job is catching collisions. Found while another
   party was reading the file before adopting it.
2. **`listing_proves_alive`, `c8ef6a8`.** The first version trusted a bulk
   listing's silence in BOTH directions. Four cases in `test_session_rename`
   caught it dropping live sessions. Corrected to be asymmetric: a listing
   that NAMES a session proves it exists, an absent name proves nothing and
   still pays `is_alive()`.
3. **`resolve_startup_gate`.** Rung 5, no tail captured, refuses with
   `unknown`. Rung 7, tail read and nothing matched, answers `ready`. Two
   different answers for two different reasons, deliberately.
4. **`refuse_if_transcript_missing`.** `unchecked` never refuses. CLAUDE.md,
   verbatim: "not having been able to look is not evidence a file is gone."
5. **The `unknown` status itself.** CLAUDE.md: "everything else is `unknown`,
   which is a real answer and never `idle`." A tmux `running` pane maps to
   `unknown`, NOT `working`, because it means only "not a bare shell".
6. **The matcher family.** CLAUDE.md, on the uuid backfill: "A matcher that
   always finds something is worse than useless", with a mandatory negative
   control. Same failure wearing the opposite sign.

## resolution

**Give the unmeasured case its own answer.** Three states, not two: found,
measured-absent, could-not-measure. Collapsing the third into the second is
the bug, every time.

**Then choose the failure direction from what the consumer is FOR, not from
a general preference.** This is the part that is easy to get wrong by
applying a slogan. Three from tonight, all correct, all different:

- **The overlap detector reports on unknown.** Missing a collision is the
  whole cost; a spurious report costs a glance.
- **The sub-agent notification gate alerts on unknown** (`0d1a12c`). A missed
  notification is worse than a spurious one.
- **The mute gate SUPPRESSES on unknown** (`46e7aca`), logging
  `notification_policy_unknown`. Opposite direction, and correct: the user
  explicitly asked for quiet, so alerting them because a read failed breaks
  the thing they asked for.

So there is no universal safe direction. There is a universal requirement to
KNOW which case you are in.

**Write the negative control.** Every one of these was caught by a test that
fails when the detector goes blind, or was not caught at all. Item 2 was
caught by four rename tests. Item 1 was caught by a human reading the file.
A green suite that could not have failed proves nothing, which is the point
ccsliinc makes in `lessons/ccsliinc-a-test-that-cannot-fail.md` from the
other direction.

## how we know it works

Items 2 through 6 are shipped and have held. Item 1 is fixed today and
verified against six malformed inputs: an impossible month, garbage, a short
date, empty, today, and a genuinely old date. Only the last reports expired.

The reason this is written now rather than after a seventh occurrence: the
first six were each found by a different person or agent, none of them
recognised it as a repeat, and the same defect was therefore re-derived five
times. That is the cost this entry exists to stop.
