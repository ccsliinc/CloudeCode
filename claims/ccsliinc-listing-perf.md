---
party: ccsliinc
id: ccsliinc-listing-perf
title: session listing performance on release/1.2.1
branch: release/1.2.1
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: src/core/session_manager.py src/core/session_instance_index.py src/core/pipe_wakeup.py src/core/session_status_map.py src/core/session_startup_gate.py src/core/session_startup_gate_ledger.py src/core/session_status_seed_read.py src/core/tmux_backend.py tests/test_listing_*.py tests/test_pipe_wakeup.py
---

# session listing performance on release/1.2.1

## approach

bulk the tmux reads: ONE listing per pass, indexed by the instance
triple, so every per-session decorator reads an in-memory row instead of
shelling out. the status seed and the startup gate both read that index rather
than issuing their own probe.
the invariant we assume, and it is the load-bearing one: A LISTING MAY ONLY
VOUCH FOR ITS OWN SOCKET. an absent row is evidence of absence only when the
listing was complete AND covered that socket. anything else is unknown, and
unknown is never idle and never dead.
expects to change: nothing in the status vocabulary and nothing in the LED
model. only where a row comes from. if your work makes absence from a bulk
listing mean 'gone', we contradict each other.

## detail

Five commits, c8ef6a8 a4eff35 2b1fcb9 402526f 3837f24, merging now as
release/1.2.1. Two of them (a4eff35, 2b1fcb9) are adoom666's, already merged in.

What this fixes: the per-poll listing was issuing a tmux subprocess per session
and blocking the event loop for about a second per poll.

New modules: src/core/session_instance_index.py, src/core/pipe_wakeup.py,
src/core/session_status_map.py.

**Happy to hand over:** the whole event-loop-offload direction in step 3 of the
webui plan. Moving blocking tmux, SQLite and filesystem work off the loop is
strictly bigger than what we did and we have no attachment to owning it.

**Would rather not have rewritten this week:** session_instance_index.py and the
socket-scope rule in session_status_map.py. Not because they are precious, but
because release/1.2.1 is mid-merge and a competing rewrite lands the humans a
third reconciliation in three days.
