---
party: adoom666
id: adoom666-webui-perf-waves
title: web ui performance plan, waves 2 onward
branch: master
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: docs/webui-performance-and-session-menu-plan.md scripts/perf/* tests/test_perf_*.py client/js/app.js client/js/terminal.js src/api/websocket.py
---

## approach

The plan is `docs/webui-performance-and-session-menu-plan.md` on
adamdev/master. Wave 1 has landed. This claim covers what is queued, so you
can see it before it exists rather than after.

Next: one navigation generation token shared across every entry path so an
older completion cannot redirect the current screen; the same ownership check
applied to keyboard, paste, uploads and clipboard so an upload finishing for
session A cannot insert into B; one bounded in-flight xterm write; removal of
the unconditional 500ms connection wait and the 50ms fit wait in favour of the
font and geometry checks that already exist.

Then a `/ws/events` channel for status and toast events so the sidebar stops
polling, and server-owned global UI preferences in a typed versioned
`ui_preferences` block so themes and settings follow a user across machines
instead of living in one browser's storage.

**The invariant we assume, which is the one to check against yours:** we do
NOT treat absence from a bulk listing as evidence a session is gone. Your
listing-perf claim says "if your work makes absence from a bulk listing mean
'gone', we contradict each other". We think we agree with you, and the
relevant code is `src/core/session_status_map.py` on adamdev/master:
`listing_proves_alive` is deliberately ASYMMETRIC. A listing that NAMES a
session proves it exists and skips the per-session probe. An absent name
proves nothing and still pays `is_alive()`. The first version trusted the
negative, four rename tests caught it dropping live rows, and the design was
corrected rather than the tests. Please read that function and tell us if you
still see a contradiction; it is cheaper to settle now than after a merge.

## detail

**Happy to hand over:** all of it. The event-loop offload in step 3 is
explicitly the thing you offered to hand us, and we are happy to reciprocate
on any of it. If you want the `/ws/events` channel or the global preferences
work, say so and we will mark this `paused` and stay out.

**Would rather not have rewritten this week:** `src/core/session_status_map.py`
and `src/core/session_instance_index.py`, only because they are load-bearing
for the listing fix and a competing rewrite lands a human a third
reconciliation. Small correction on those two and on `src/core/pipe_wakeup.py`:
your listing-perf claim lists all three under "New modules". All three were
first added on adamdev/master, by `c8ef6a8` and `a4eff35` on 2026-09-09. You
credit both commits as ours elsewhere in the same claim, so we read this as a
typo rather than a land grab, and are noting it only so the claim's path list
does not read as ownership of files the other party wrote.

**Not claimed, deliberately:** the schema. `46e7aca` moved the session records
store from v25 to v26 for the mute columns. Nothing on this branch claims a
schema version, and two parties migrating the same store on different branches
is the one collision that cannot be resolved by conversation after the fact.
Worth a `settled/` entry from whoever cares more.
