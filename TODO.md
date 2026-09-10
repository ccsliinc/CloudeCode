# TODO — closing out the open issue board

Repo: Adoom666/CloudeCodeDev. 53 open at start, 48 now.
- 11 are ccsliinc's (their draft PRs) — not ours
- 8 carry `blocked` (waiting on ccsliinc PR #19, Adam's ruling): #31 #32 #35 #36 #37 #50 #51 #58
- the rest are ours

## Done and merged to master

- [x] #55 split toast.js -> toast-grouping / toast-render / toast-lifecycle (b932252)
- [x] #6  CLAUDE.md spelling prohibition + all 27 docs indexed (53ed219)
- [x] #56 perf harness can now measure settings open (53ed219)
- [x] #57 local server subsystem documented as retained dead code (53ed219)
- [x] #59 both stale test failures FIXED at root cause. Suite 5656/2 -> 5758/0 (53ed219)

## In flight

- [ ] #65 pinned theme overridden by folder .cc.theme
- [ ] #8 #9 #10 #16 navigation generation token chain (terminal.js)
- [ ] #30 file-tree scan off the event loop
- [ ] #42 inventory durable browser preferences (phase 5 prerequisite)

## Held — needs Adam

- #64 CI disabled deliberately. Adam's own comment on the issue says do not close it.
  Now documented in CLAUDE.md + docs/ci.md. Left open per his instruction.
- #66 home card overflow menu: touches client/js/launchpad.js, which ccsliinc's
  svelte migration (#11 PR#23, #76 PR#77) is actively rewriting. Real collision.

## Note for every agent from here on

docs/ are now PINNED by tests/test_docs_index.py in both directions. Any new doc
must get a row in CLAUDE.md's docs index or that test fails.

## Agent findings

(append below, format: [AGENT] [TIME]: finding)

[ORCH] 2026-09-10 19:07: full suite on merged master read 3 failed / 5769 passed.
All three drive the REAL tmux socket with a 6.0s wall-clock deadline in _wait_for.
Box was at load average 19.7 with 11 concurrent pytest processes from parallel
agents. Verified: the same two fail identically at base commit 53ed219, which was
measured 0 failed on a quiet box. test_tmux_backend_respawn passes in isolation.
This is contention, not a regression. A clean full-suite number is OWED on a quiet
box. Candidate follow-up: the real_tmux marker added for #59 should cover
tests/test_session_restart_wrapper_choice.py, whose 6s deadline is the tightest
in the real-tmux family.
