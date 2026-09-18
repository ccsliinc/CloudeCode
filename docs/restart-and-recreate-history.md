# Restart, respawn and recreate: the full ladder and its gates

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## Restarting a session, and picking what it comes back as

`POST /sessions/respawn` revives a pane whose PROCESS exited. It can ALSO
replace a running one, but only when the request says so:
`resolve_respawn_plan` answers `RESPAWN_NOT_DEAD` for a live pane unless
`live_restart_confirmed=True`, and tmux itself refuses `respawn-pane`
without `-k`. See "Replacing what is running" below.

**The ladder gates on tmux's `#{pane_start_command}`, and the empty case is
the trap.** Empty means the pane was born a bare shell, so a restart lands on
`RESPAWN_SHELL` and hands back a LOGIN SHELL rather than the agent - silently,
for a real subset of the sessions on a working box, because
`sessions.agent_type` lands NULL for every session created with
`auto_start_claude:false` plus a hand-sent claude command.

| Piece | File |
|---|---|
| The ladder, the projection, and pane liveness | `src/core/session_respawn.py` |
| Which conversation it comes back on | `src/core/session_resume_target.py` |
| Shape the preview the picker reads | `src/core/session_restart_preview.py` |
| Validate an `agent_type` choice, and persist it | `src/core/session_agent_choice.py` |
| `GET /sessions/restart/preview` | `src/api/restart_routes.py` |
| The panel, and the reopen afterwards | `client/js/session-restart-picker.js`, `client/js/session-restart-return.js` |
| The option list, extracted so the picker stays under 500 lines | `client/js/session-restart-options.js` |
| Keep the row keyed on its instance after a kill | `src/core/session_instance_rekey.py` |
| The arm control and the kill confirmation | `client/js/session-restart-live.js` |
| What the user is told about the conversation | `client/js/session-restart-continuity.js` |
| Recreate a session whose tmux is GONE | `src/core/session_recreate.py` |
| Is the tmux session still on the socket | `src/core/session_recreate_presence.py` |
| `GET /sessions/recreate/preview`, `POST /sessions/recreate` | `src/api/recreate_routes.py` |

**A SESSION WHOSE TMUX IS GONE HAS NO PANE TO RESPAWN INTO, AND THAT WAS A
DEAD END UNTIL 2026-09-08.** The respawn ladder reads a PANE, so a row whose
tmux SESSION was killed outright - the server restarted, the machine rebooted,
the name is simply absent from `tmux -L cloude list-sessions` - answers
`cannot_determine`. Honest, and the only way back was a fresh session built by
hand, which loses the row and with it the project binding, the title, the pinned
theme, the unread key and the group filing. `src/core/session_recreate.py`
closes it as punchlist item 22's remaining half: a new tmux session, in the
conversation's own directory, under the wrapper the user picked, with
`--resume <uuid>`, recorded onto the EXISTING row through
`create_session(reuse_session_id=...)`. It decides only the one fact it owns -
presence - and calls `plan_imported_restart` for the transcript guard, the
directory spelling, the wrapper and the three conversation words, so the two
create-a-session paths cannot drift.

**THE GATE IS A MEASURED ABSENCE, AND `is_alive()` CANNOT PROVIDE ONE.** It
runs `has-session` and returns a bool, so "no such session" and "tmux is
missing, timed out, or errored" are the same False; recreating on that would
spawn a second tmux beside a healthy one and rebind the row onto the newcomer,
leaving the pane the user is talking to alive and unreferenced. So the
measurement is a LISTING (`discover_existing()`, whose `ok` and `complete`
already carry the discipline) and `session_recreate_presence.tmux_presence`
keeps three outcomes apart: `gone` only when a COMPLETE listing ran and the
name is not in it, `present` reported as the ladder's own `not_dead`, and
`unknown` for a listing that did not run, one that ran with rows the parser
refused, or a name outside the `cloude_` namespace the listing does not cover.
Only `gone` may act. `tests/test_recreate_gate_real_tmux.py` measures the
transition against a real throwaway socket, because a double agrees with
whatever it was built to agree with.

**ADDRESSED BY `session_uuid`, NOT BY THE TMUX NAME, and that was caught rather
than designed.** The first draft resolved the row by name plus greatest epoch;
`tests/test_no_name_keyed_session_identity.py` failed it, correctly - a name is
reusable and this app re-mints them, so "the newest row with this name" is a
recency guess, and a wrong answer rebinds a DIFFERENT session's row. The routes
now take the durable key and read the tmux name OFF the row. The client bridges
its own gap the same way: the sidebar addresses rows by name, so
`SessionRestartOptions.recreateTarget` returns a uuid only when EXACTLY ONE
record carries that name and null otherwise. A refusal costs the user the offer,
which is what they had before the feature existed; a guess would cost them a
session.

**THE ROW IS RE-KEYED, NOT REPLACED.** The new tmux session is a new instance,
so `session_restart.rebind_instance` moves the triple while holding
`sessions.id` fixed. Group filing rides along because `session_group_membership`
has keyed on `session_uuid` since v24 - the v8 table it replaced keyed on
`tmux_name`, which is the landmine an earlier design of this feature would have
walked into. The SAME tmux name is asked for so name-scoped per-device browser
state survives, and it is free by construction because the gate only passes on a
measured absence; the create path still uniquifies on collision, so the name
actually taken is REPORTED rather than assumed.

**A PREDICTION IS NEVER A PERMISSION, and that is why the preview reports the
rung twice.** `resolve_respawn_plan` short-circuits on `not_dead` BEFORE it
reads the start command, so on its own it can only tell you a running session
is running - not what it would come back AS, which is the only interesting
question about the idle-but-alive sessions a user actually wants to restart.
So the tail of the ladder is factored into `_rung_from_start_command` and
reached two ways: `resolve_respawn_plan` through the probe gate AND the
liveness gate, `project_restart_rung` through the probe gate only. There is
still ONE ladder. `unchanged` is what a restart does now, `projected` is what
it would come back as, `pane_state` (`dead` / `alive` / `unknown`) is liveness
on its own. A UI badge may read `projected`; only `unchanged` / `actionable_now`
may enable a button. Wire the badge to the button and every live session
becomes restartable.

**`agent_type` on the respawn request is an ID, never a command.** It is
validated against `agents.wrappers` and an unconfigured id is a 400.
`Settings.get_agent_command` deliberately falls back to the default wrapper for
an unknown type, which is right for a launch and wrong for a picker - a user
who asks for `claude-chrome` and silently gets `claude-skip-permissions` has
been lied to. Validate through `session_agent_choice.validate_agent_choice`
first; never call `get_agent_command` with a user-supplied id directly.

**An explicit choice outranks the `pane_start_command` gate; nothing else
does.** The gate exists because a STORED `agent_type` is not evidence of
intent. A wrapper picked in this request, after the user was shown what it
would do, is different evidence. It does NOT outrank `not_dead` or a probe that
did not answer. The verdict stays `RESPAWN_AGENT`; `RespawnPlan.chosen` and a
different sentence carry the distinction rather than a sixth kind.

**A RESTART MEANS A RESUME, ON EVERY RUNG THAT CAN.** The owner's
definition, 2026-09-07, verbatim: "restart on recent is really just
resume. restart on open is close and resume session so it loads a new
wrapper or new claude binary." ONE semantic, two mechanics: a dead row has
no process to kill so its restart IS a resume, and a live row has its pane
killed first, the kill existing only so the pane picks up a new wrapper or
a new claude binary. Both come back on the SAME conversation.

`f95a9ed` made that true only on the REPLAY rung, by accident of what tmux
had written down. The AGENT rung re-derives its command through
`Settings.get_agent_command`, which carries no `--resume`, so a restart
there started a FRESH conversation wearing the old session's name.
`sessions.claude_session_uuid` now reaches that command as
`extra_args=['--resume', <uuid>]`, built once by
`session_resume_target.resume_extra_args` and passed to all FOUR command
resolutions in a restart request - the stored agent's and every wrapper
offer's, on the action side and on the preview side. Building it in one
place is what makes the preview's predicted command and the action's
actual command the same string by construction. NEVER concatenate the flag
onto a resolved command: `get_agent_command` returns
`zsh -c 'source ~/.zshrc ...; cld'` and an appended argument lands outside
that quoting, handed to zsh instead of to claude.

**The resume drops claude's own `--name`, and that is a known gap, not a
bug fix waiting to be noticed.** `resume_extra_args` carries `--resume
<uuid>` only, so a restarted session comes back without whatever name
claude itself had been given (`--name`, `/rename`). The app's own row title
survives regardless, because it lives in `sessions.title`, not in claude's
argv. Open item: reuse `claude_title_sync`'s read of the transcript's last
`custom-title` to reapply the name on a resume the same way it already
detects one.

**A MISSING uuid IS A NAMED OUTCOME, NOT A SILENT FRESH START.**
`RespawnPlan.conversation` and the preview's `conversation` field carry
`resumed` / `none_recorded` / `unknown`, the SAME three words
`RestartSessionResponse.conversation` has used since the restart route
shipped, reused rather than re-invented. `none_recorded` means the row was
READ and holds no conversation, so the session comes back WITHOUT its
history - a legitimate restart, said out loud rather than performed
quietly. `unknown` means the row could not be read: no `--resume` is
injected and nothing claims a resume, because an unknown is never a yes.
The value is DERIVED FROM THE ARGV - a command carrying a `--resume` reads
`resumed` whatever the caller believed - so the claim can never outrun the
command. The rung sentence the picker renders verbatim carries the clause,
and `SessionRestartLive.liveConfirmCopy` names it before anything dies.

Note the asymmetry, it is deliberate: an unreadable ROW degrades the claim
and never refuses, while a MEASURED missing TRANSCRIPT refuses outright.
Not having looked is not evidence of absence; having looked and found
nothing is.

**A REPLAY CAN RESUME A CONVERSATION, and that is guarded.** `RESPAWN_REPLAY`
hands tmux back its own `#{pane_start_command}`, and measured on the owner's
box 2026-09-07, 3 of 19 live sessions carry an explicit `--resume <uuid>` in
theirs. So a replay can re-run a resume, and a resume against a deleted
transcript exits instantly, leaving a dead pane the row still calls running -
the incident this project already paid for. `resume_uuid_in` extracts the uuid,
`refuse_if_transcript_missing` turns a DEFINITE absence into
`RESPAWN_TRANSCRIPT_MISSING`, and the filesystem lookup lives in
`src/core/session_transcript_presence.py` so the ladder stays pure. THE
GUARD COVERS THE AGENT RUNG TOO now that it resumes, on the dead path as
well as the live one: the check in `TmuxBackend.respawn` keys on
`plan.resume_uuid` and is not gated on liveness. TWO CONVERSATIONS CAN BE
IN PLAY AT ONCE - the replay rung resumes what tmux recorded, the agent
rung resumes what the ROW says - so the preview passes presence verdicts
as `presence_by_uuid`, keyed by the uuid each was measured for. One
verdict applied to both would refuse a restart nobody measured.
`unchecked` NEVER refuses - not having been able to look is not evidence a file is gone, and
refusing on it would break restart on every machine whose corpus lives somewhere
the checker was not told about. The PREVIEW applies the same guard; a preview
that skipped it would promise a replay the restart then declines.

**Replacing what is running: `respawn-pane -k`, and the four gates in
front of it.** The owner's two calls (2026-09-07) were "same tmux should
be fine" and "yes resume the same session", so this is not
close-and-recreate. It kills the pane's process and respawns it in the
same pane, same tmux name, same row - and because no row is minted,
project attribution, pinned theme, unread state, group filing and
sidebar position all stay put without anything re-carrying them. It also
sidesteps rather than fixes the `session_group_members` primary-key
defect, which keys on `tmux_name`.

It is DESTRUCTIVE and irreversible, so it is gated four times and no
gate is derivable from a prediction. **ALL FOUR GATES ARE IN FORCE AND
THE CONTROL IS REACHABLE**, which is the owner's 2026-09-09 call: the
row's kebab menu stays and restart stays on it. One line of this project
folded the row's controls back to inline pin and close and removed
restart with the menu; that was not taken. See "The row's controls" under
the status lights.

1. `actionsFor` offers restart on a row whose status we POSITIVELY know
   is live. `unknown` still gets close alone.
2. The picker's arm checkbox (`SessionRestartLive.armHtml`, always
   emitted unchecked, takes no argument) is what unlocks the choices. `optionsHtml` derives
   `disabled` from `actionable_now` ALONE, so a live pane paints every
   radio locked whatever it projects.
3. `App.showConfirmModal` with `SessionRestartLive.liveConfirmCopy`,
   which names the
   bare-shell outcome AND what happens to the conversation. Measured
   2026-09-08: 18 of 22 live sessions have an empty `pane_start_command`,
   so an UNPICKED restart comes back a login shell for 82 percent of them
   (it read 15 of 19 on 2026-09-07; the population moves, re-measure
   rather than quoting either). That warning is what makes this safe to
   ship. Note the whole sentence: an explicit wrapper choice OVERRIDES
   the gate (`session_respawn.py:542`), so only an unpicked restart lands
   on the shell rung.
4. `confirm_restart_live` on the request. `RespawnPlan.kills_live_pane`
   is the ONLY thing that makes anything pass `-k`, and it is set only
   when the pane was measured alive AND the caller confirmed AND the
   rung is actionable. `project_restart_rung` has no liveness input, so
   a projection cannot set it. `refuse_if_transcript_missing` BUILDS its
   refusal rather than copying, so a missing transcript cannot kill.

`activity_status` informs all of this and refuses none of it - it reads
`working` for about four minutes after a resume.

**Identity is MEASURED across the kill, not assumed.** `#{session_created}`
belongs to the SESSION and `-k` replaces the pane's PROCESS, so on tmux
3.7c the instance triple does not move (measured 2026-09-07: same epoch,
same `pane_id`, new `pane_pid`). Fourteen queries in `src/core` key on
that triple exactly and all read the same column, so they break or hold
together. `TmuxBackend.respawn` therefore reads the epoch either side and
`session_instance_rekey.reconcile_instance_epoch` answers `unchanged` /
`rekeyed` / `cannot_determine`, re-keying the row on the OLD triple if it
ever does move. `cannot_determine` is not `unchanged`; a reading that did
not answer is not evidence nothing moved.

**Respawn writes exactly one column, and only when asked.** On a restart
verified alive with a picked wrapper, `sessions.agent_type` is updated on the
row keyed by the instance triple. Nothing else - a respawn is still not a fork
and never touches a lineage column. With no `agent_type` it issues no write at
all. A restart that FAILED records nothing, and `agent_type_persisted` says so
rather than letting a stuck choice look saved.
