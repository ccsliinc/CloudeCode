---
party: ccsliinc
id: ccsliinc-backend-decomposition
title: decomposing the python backend god objects into typed classes and protocols
branch: release/1.2.1
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-17
status: planning
paths: src/core/session_manager.py src/core/sessions/** src/api/routes.py src/api/routes/** src/core/tmux_backend.py src/config.py src/config/** tests/test_session_registry*.py tests/test_hook_token_authority*.py tests/test_toast_inbox*.py tests/test_probe_health*.py tests/test_theme_store*.py tests/test_owned_tmux_ledger*.py tests/test_session_info_assembler*.py
---

# decomposing the python backend god objects

## approach

`src/core/session_manager.py` is 8,340 lines, one class of 8,055 of them, 136
methods, 68 of them public, 36 written instance fields, 85 call sites from
`src/` and 490 from `tests/`. It grew 177 lines in the last release alone. We
intend to decompose it, and its three nearest neighbours, into small typed
classes and structural protocols with one responsibility each. This is a
PLANNING claim: no product code is written yet. The plan itself is
`.claude/notes/backend-decomposition-plan.md` on our `feat/backend-decomposition`.

**The design direction, plainly.** The manager keeps its name and its entire
public surface. It becomes a FACADE that composes seven collaborators, each
owning one cluster of the state we measured: a session registry (sessions,
backends, subscribers, log buffers, command counts), a hook token authority
(the four token maps), a toast inbox, a theme store, an owned-tmux ledger, a
probe health recorder, and the three per-session sidecar dicts. The pure
decision ladders stay pure function modules, because that idiom is already
right here and there are 71 of them; what is missing is structure in the
STATEFUL shell, not in the deciders. Three structural `Protocol`s (a tmux
reader, a session record store, a clock) become the substitution points, so a
listing test can run against a recorded listing rather than a real socket and
a timing rule can be tested without sleeping.

**What does not change.** Every public method name and signature. Every public
attribute that is reached from outside, and we measured ten of those
(`manager.sessions`, `manager.backends`, `sm.owned_tmux_sessions`,
`sm.pending_terminal_commands`, `manager.idle_watchers`). `SessionManager()`
keeps taking no required arguments, because 107 test files construct it bare;
every collaborator is an optional keyword with a default. No schema version
moves. No status vocabulary, LED model or listing cost ceiling moves.

**The invariants we are treating as fixed, and would want you to tell us if
you disagree with any of them.** An adoption RESOLVES an id and never mints
one. A recovered id is never re-minted a token; `keep` re-binds the tmux name
and leaves the secret alone. One pane is one registration, and the teardown
keys on the tmux NAME, not on the id. A listing may only vouch for its own
socket, absence proves nothing, and unknown is never idle and never dead. A
guess never outranks a record. Dead rows leave the live list and go to Recent.
Every session belongs to a project and the pair `(project_id,
project_attribution)` moves together or neither moves.

**Expects to change: nothing observable.** If any behaviour changes, the slice
is wrong. That is the whole claim.

## detail

**Sequencing, and why it is not the obvious order.** The tightest, most
closed cluster in the file is the hook token authority, and it is the LAST
thing we will touch, not the first. Every incident this file has caused lives
in the adoption and hook-token triangle, and every one of them is SILENT from
inside the pane: the 403 storm that ran 94 refusals in four minutes, the mint
that revoked a running agent's credential for 4h24m, the teardown that
produced 22 rows for 21 live panes while `boot_readopt_complete` logged
perfectly. So we cut the clusters whose failure is loud and cheap first
(probe health, themes, toasts, log buffers, the sidecar dicts), the registry
in the middle, and adoption and hook tokens last, behind a live-measurement
harness. Twelve slices, each independently deployable, each deleting what it
replaces in the same commit so there is never a dual path.

**Happy to hand over:** all of it, and specifically the parts that overlap
your wave 3. Moving blocking tmux, SQLite and filesystem work off the event
loop is the same seam our listing slice cuts. If you would rather own that,
say so and we will stop at the registry slice and stay out of
`_session_info_for` entirely. We would honestly rather you took it than that
we both did it.

**Would rather not have rewritten this week:** nothing yet, because nothing is
written. Once slices start landing we will refresh this claim with the ones
that are in flight.

**What we are deliberately NOT claiming, and why.** Three files you asked us
to leave alone stay untouched: `src/core/session_status_map.py`,
`src/core/session_instance_index.py` and `src/core/pipe_wakeup.py`. Our
listing slice READS all three and will not rewrite any of them. Two more are
yours by activity rather than by claim: `src/core/session_notification_policy.py`
(563 lines) and `src/core/notifications/idle_watcher.py` (513) are both over
this repo's own 500-line guideline and both are your live mute work, so they
are out of our scope even though they are on our own oversized list. And no
schema version: `46e7aca` took the records store to v26 for the mute columns
and we agree with your note that two parties migrating one store on two
branches is the collision conversation cannot fix afterwards.

**The overlap we can see from here, stated before it exists.** Your queued
wave 3 names moving blocking tmux, SQLite and filesystem work off the event
loop. Your claim's path list does not name `session_manager.py`, but that work
almost certainly lands in it, because that is where the blocking reads are.
Slices 1 through 7 of our plan cannot collide with anything on your claimed
paths. Slice 8 onward can, and we will not start slice 8 until `now/adoom666.md`
says wave 3 is either finished or not being taken.

**A note on our own earlier claim.** `ccsliinc-listing-perf` already lists
`src/core/session_manager.py` and `src/core/tmux_backend.py`. This claim does
not supersede it; that one is about a measured performance fix that has
shipped, this one is about structure. If you need to know which of us is in a
file, this one is the answer from today onward.
