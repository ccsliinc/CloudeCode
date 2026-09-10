# Non-overlap inventory: his-only (97 files) vs ours-only (120 files)

Base ba2aa5d, ours = v1.1 (d392aeb), his = adamdev/master (0d1a12c), 28 first-parent
commits judged (118-commit graft ignored). Overlap files (28, both.txt) belong to
another worker; this covers only what one side alone touched.

## HIS-ONLY, grouped by feature

**Attach/scrollback/cursor rework in tmux_backend.py: biggest and riskiest group.**
Files: `tmux_backend.py`, `session_backend.py`, `agent_wrappers.py`, `websocket.py`,
`ws_startup_paint.py`, `config.py`, `config.example.json`. 7 files, 413/-107 across
946e1a1 (+revert c21be26 +reapply d407fa1), 9f01c6c, 230bad8, 3366257. Tests: yes,
7 files (`test_agent_wrappers.py`, `test_attach_paint.py`, `test_tmux_history_limit.py`,
`test_ws_startup_paint.py`, `test_capture_cursor_real_tmux.py`,
`test_boot_readopt_real_tmux.py`, `test_respawn_refreshes_pane_env.py`). Owner sees:
claude renders on the normal screen not the alt screen so scrollback survives
reconnects, `HISTORY_LIMIT` raised 10000 to 50000 to match xterm's own
`scrollback: 50000` (already 50000 on both lines, so this closes a real mismatch),
and the pane's cursor is appended to every attach capture so typed text lands where
the cursor actually is. COLLISION CHECK: our `session_recreate.py` and
`session_boot_readopt.py` call `attach_existing()`/`ensure_pipe_pane()` on this same
class. His change is additive to that exact guard our CLAUDE.md documents (same
docstring phrase, "THE THIRD WAY TO SATISFY THE GUARD"), adding a RuntimeError
fallback rather than removing anything, so the contract our code relies on holds.
Low code-collision risk; run a real-tmux test after merge since both sides evolved
the same guard independently.

**Toast core: dedupe, session-grouping, subagent suppression.**
Files: `toast.js`, `toast-session-group.js` (new), `session_activity.py`,
`routes.py`. ~690 lines across 68cb19c, 65faa8c, 0d1a12c. Tests: yes
(`test_toast_dismiss.node.mjs`, `test_toast_stacking.node.mjs`,
`test_hook_toast_subagent_suppression.py`, manual harnesses). Owner sees: dismissing
a stacked toast dismisses the whole count card, one toast card per session picked
by attention order, no toast fires while the session's own sub-agents are still
running. Purely additive to `session_activity.py` (new floored `subagent_depth()`
getter) and `routes.py` (new block, no deletions), so it should not fight our
`toast_auto_ack.py`/`session_view_clears.py` as long as both land after merge.

**Status LED + status key: five colours, one lit diameter, unread folded into the ring, new legend.**
His-only new: `session-status-key.css`, `session-status-key.js`,
`verify_status_led_geometry.py`, `status-light-key-harness.html`,
`test_status_key.node.mjs` (721 lines). He also rewrites `status-led.css`/`.js`
(both.txt) across 1f1706d, b1bd4bd, fb25276, 59e0ef9, 13a665b. Tests: yes. Owner
sees: a legend naming each light, uniform dot sizing, and his direction puts unread
back on the ring. FLAG - BEHAVIOUR COLLISION: our CLAUDE.md is explicit the outer
ring means activity ONLY, unread retired to the inner dot (owner's own words,
2026-09-09: "i dont think those few have any background tasks"). His line moves the
opposite way. The status-led.css/js merge decides which model ships; his legend
file describes HIS model and needs rewriting or dropping if ours wins. Do not add
the legend file before that decision.

**Mobile terminal tools FAB, session editor into header, slash-commands FAB hidden on desktop.**
Files: `session-editor-header.css`, `terminal-tools.css`, `fab-menu.js`,
`header-menu.js`, `session-editor-menu.js`, `terminal-tools-menu.js`,
`slash-commands-fab.css`. 7 files, 207/-55 across 07a202b, 4435edb. Tests: yes, 5
node specs. Owner sees: phone-only terminal-tools FAB, session editor moved into
the header, slash-commands FAB/modal hidden on desktop. No ours-only equivalent;
independent. Clean, only needs `index.html`/`styles.css` (both.txt) to carry the
markup through.

**Row menu removal, inline controls, kebab icon, inline pin/reorder.**
12 files (`session-row-inline-controls.css` new, `session-row-menu.css`/`.js`
deleted then recreated, `session-row-menu-gestures.js` deleted,
`session-transport.js` new, plus `kebab-icon.js`, `project-list-render-guard.js`,
`session-row-actions.js`, `session-sidebar-pin.js`, `session-sidebar-reorder.js`,
density css). 316/-1100 across ad359bc then 13a665b. Tests: yes, several node
specs churn across the two commits. Owner sees: pin/close moved inline onto the
row, three-dot menu removed then partly recreated a commit later. No ours-only
file touches this UI area. Judge only the end state (13a665b), not ad359bc.

**Version footer.** `version-footer.css`, `version-footer.js`, `home-bar.css`. 226
lines, self-contained. Tests: yes. Owner sees: app version at the foot of sidebar
and home bar. No overlap. Clean, drops in as-is.

**Attachment receipt toast with thumbnail.** `attachment-toast.js` (new),
`clipboard.js`, `toast.css`. 614 lines. Tests: yes. Owner sees: a real toast with a
thumbnail on paste/drop instead of a plain message. Independent; touches
`toast.js`/`terminal.js`/`index.html` (both.txt) only for wiring.

**Terminal frame guard.** `terminal-frame-guard.js` (new), 89 lines, wired into
`terminal.js`. Tests: yes. Owner sees: one session's bytes can no longer bleed into
another session's terminal (bd9a2b2). Same subsystem as our tail-loop work; worth a
manual multi-session check post-merge since we have no equivalent guard.

**CI hardening and test-infra additions.** `.github/workflows/tests.yml` (pinned
gitleaks install, skip-audit exemption), `pytest.ini` (exclude `.claude`),
`scripts/ci/skip-audit.py` + exempt list (new), `tests/conftest.py` (+53 lines, new
`nonscratch_tmp_path` fixture), `real_hook_harness.py`. 263 lines, purely additive.
COLLISION: our CLAUDE.md quotes a hand-measured pytest baseline
(5609 passed / 3 failed / 21 skipped, `dfddbdc`). His exempt mechanism and the
`.claude` collection exclusion both change what the suite reports; re-measure the
baseline after this merges rather than trust either side's stale number.

**Housekeeping, no feature.** `.gitignore` + delete `.cc.theme` (4cc6187): stop
tracking a file the app rewrites at runtime, zero risk, matches our own
atomic-write discipline in spirit. `README.md` + `macOS/package.json` + release
commits: version bump to 1.0.35, no logic. `config.example.json` rides with the
tmux group above.

## OURS-ONLY, coarse grouping (side-by-side reference only)

- Boot re-adopt fleet pass + instance-id recovery/rekey (`session_boot_readopt.py`, `session_agent_evidence.py`, `session_store.py`)
- Session recreate when tmux is gone (`session_recreate.py`, `session_recreate_presence.py`, `recreate_routes.py`)
- Restart/respawn resume-target + agent inference from pane process (`session_agent_infer*.py`, `claude_resume_argv.py`, `restart_routes.py`)
- Status seed + transcript-status ladder, hookless sessions read their own transcript (`session_status_seed*.py`, `session_transcript_status*.py`, `session_status*.py`)
- Permission-vs-notice split and pane re-verification (`session_permission_verify*.py`)
- Unread keyed on tmux instance, single source of truth (`unread_identity.py`, `unread_store.py`)
- Toast history panel + global poll + auto-ack (`toast_history*.js`, `toast_auto_ack.py`, `toast_global_poll.js`)
- Away bar / away report (`terminal-away-bar.js`, `terminal-away-gap.js`, `session_away_report.py`)
- Session header LED, band menu, sidebar fetch split (`session-header-led.*`, `session-sidebar-band-menu.js`, `session-sidebar-fetch.js`)
- Restart picker UI (`session-restart-options.js`, `session-restart-picker.js`)
- Terminal layout-wait race-against-timer fix (`terminal-layout-wait.js`)
- Verify-script archive: ~20 old `scripts/verify_*.py` moved to `scripts/archive/verify/`
- Docs: `docs/notifications.md`, `docs/reconnect.md`, TODO/HANDOFF updates

## His 4 manual files + macOS file

`tests/manual/sidebar-sessions-geometry-harness.html`,
`status-light-key-harness.html`, `toast-dismiss-harness.html`,
`toast-stacking-harness.html`: standalone browser pages opened by hand to eyeball
geometry/toast-stacking/status-key rendering. Not automated, no assertions,
manual-QA aids for the features named above. `macOS/package.json`: version bump
1.0.33 to 1.0.35, no logic change.

## Merge-order recommendation

**CLEAN, merge as-is:** version footer, attachment-receipt toast, terminal frame
guard, mobile terminal-tools FAB/editor header, slash-commands-fab hide-on-desktop,
subagent-toast-suppression, toast dismiss-all-cards fix, `.cc.theme` untracking,
`.gitignore`, the tmux attach/cursor/scrollback group (verify with real tmux, but
nothing to decide).

**DECIDE:** status-key legend waits on the status-led ring-semantics decision
(both.txt) since it encodes the losing model if ours wins; row-menu-removal
(ad359bc + 13a665b) needs one owner look at the end state since it deletes ~1100
lines of UI we never touched with nothing on our side to compare against; CI
skip-audit-exempt + pytest.ini `.claude` exclusion changes the count our CLAUDE.md
baseline depends on, re-measure rather than trust either number.

**SUPERSEDED by ours:** none outright, since ours never touched his subsystems. The
only real risk is `scripts/verify_*.py` placement: his line keeps adding live
top-level verify scripts while ours archived that whole pattern to
`scripts/archive/verify/`. Keep the archival convention going forward; land his 3
new verify scripts there, not top-level.
