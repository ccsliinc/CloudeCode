# The twelve gotchas, in full

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## Gotchas that have cost real time

1. **Wrapper vs `.session`.** Described above. When a field reads as missing,
   check which level you are on before you go looking in the backend.
2. **Hook events are unordered, duplicated and droppable.** A state machine that
   assumes ordering works on your machine and drifts in the field. Floor the
   counters, make every transition idempotent.
3. **An adopted session is not a launcher "project".** Deep-link resolution walks
   launcher projects first, then live/adopted sessions
   (`client/js/router.js`, `Launchpad.openProjectByName()`). Resolving only
   against projects made a deep link spawn a duplicate session next to the one
   the user was already in. Unresolvable targets go through `rejectTarget()`, one
   banner, one `replaceState` back to `/`, never a silent bounce.
4. **The tmux socket is load-bearing.** Anything that shells out to `tmux`
   without `-L cloude` is talking to the user's personal tmux server. That is how
   you kill someone else's work.
4b. **A session id is not a tmux name, and deriving one from the other loses
   sessions.** `build_backend` with no `session_name` rebuilds
   `cloude_<slug(session_id)>`, which for an adopted id yields
   `cloude_adopted_cloude_Foo` - a name no socket has ever carried. It then fails
   the liveness test and `_clear_stale_metadata` throws the pointer away (it
   keeps the owned set; see `OwnedTmuxLedger.drop_session_pointer`). Pass the
   STORED `tmux_session`, and keep the derivation as the fallback for pre-field
   metadata.
5. **A uuid on the row is not evidence a transcript exists, and a missing
   transcript is not evidence the conversation is gone.** Five rows on the
   developer's box hold a phantom uuid minted by `--fork-session` while the
   real conversation lives on an archived twin row. Check the twin before
   telling anyone their history is lost.
6. **cwd spelling splits a session in two.** `~/Development` is a symlink into
   iCloud and Claude Code derives its transcript directory from the LITERAL cwd
   string, so two spellings of one directory make two transcript directories,
   two project rows and, as above, two session rows. Always write the long
   iCloud spelling, in code and in documents. **Qualified 2026-09-08:** the
   historic split in the data is real, and claude 2.1.263 resolves symlinks
   before slugging its transcript path, so `--resume` now finds a transcript
   from either spelling of the cwd and a NEW split cannot originate from
   claude itself. It is not fully fixed, though - this app's own project
   creation kept WRITING the short symlinked spelling into `working_dir`
   until `a4eeef1` closed that path today.
7. **`if (pinned) apply()` with no else leaves the last session's theme on
   screen.** A pinned theme bled across session switches because three
   copy-pasted restores in `app.js` and two session-entry paths each applied a
   theme and never reset one. A missing else is not a missing feature, it is
   state left over from the previous thing. There is now ONE total function,
   `applyForTarget()` in `client/js/theme-navigation.js`, and every navigation
   goes through it. Fixed in `a6b6b91`.
8. **A stale doc is worse than no doc.** A missing doc sends the next agent to
   read the code; a confidently wrong one sends it to write a bug. If you change
   behavior this file describes, update this file in the same change. If you find
   a claim here that reality contradicts, fix it and say so in the commit.
9. **A bare `await requestAnimationFrame` never resolves in a hidden tab.**
   A browser does not paint a backgrounded tab, so it never runs that
   tab's rAF callbacks; anything awaiting one hangs there permanently, not
   just slowly. `waitForFontsAndLayout()` suspended `connectWebSocket()`
   before it ever opened a socket, and two other call sites
   (`reconnectToExistingSession`, the adopt path) carried their own copies
   of the same bare wait, so fixing the first one alone changed nothing -
   only a live re-check in an actually-backgrounded tab caught the other
   two. Anything that must happen for a background tab (a websocket
   connect, a state clear, a save) must not wait on a frame; race it
   against a timer instead, the way `client/js/terminal-layout-wait.js`
   does, so the wait can delay the work but never cancel it.
10. **A synthetic hook aimed at a row id can set a tracker flag the pane's
    own claude can never clear, when that claude holds an adopted id.**
    `cloude_Media_Compression`'s pane process presents
    `CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression` on every real
    hook it fires, because tmux fixed that env var into the process at
    spawn and cannot rewrite a running one. A test's synthetic
    `PermissionRequest` landed on `ses_949a8585` instead - the id
    `tmux show-environment` hands back, and the one a script naturally
    reads - with no `toast_session_id_remapped` line, because the toast
    path only remaps when it recognizes the split; every REAL clearing
    hook from that pane kept arriving under the adopted id and clearing a
    key nothing was set on. The row painted `question` over a pane with no
    dialog open, indefinitely. The fix in `dfddbdc` does not chase a
    second remap: it re-verifies an open `permission_open` against the
    PANE itself once it has sat open past 20 seconds, on the theory that
    two ids can drift apart but the pane cannot lie about its own screen.
    Any new tracker flag keyed on a session id needs the same question
    asked of it: can this id and the pane's own id ever diverge, and if
    they do, is there a way back to ground truth that does not depend on
    either id being the right one.

11. **A CHECK THAT PASSES BECAUSE IT LOOKED AT NOTHING. SIX OF THESE IN TWO
    DAYS, 2026-09-11 and 2026-09-12, which makes it the single most repeated
    failure shape in this project.** They are all one mechanism: the thing
    being measured went absent, and absent compared equal, or the tool that
    was meant to complain had its complaint routed somewhere nobody reads.
    A `dist/` line in `.gitignore` with no leading slash swallowed
    `client/dist`, so a deploy would have shipped no bundle and every hash
    check in `deploy-mini.sh` would have compared an absent file against an
    absent file and read green. A docs drift guard's citation regexes matched
    only `src|client|tests|macOS` roots and `.py|.js`, so every citation
    repointed at `web/src` `.ts` would have become invisible prose and the
    guard would have passed forever holding nothing. `rsync --no-compress` is
    rejected by macOS openrsync, which prints usage, copies zero bytes and
    exits 0, and the usage text went to a pipe into `tail`. `deploy-mini.sh`'s
    up-check curls `/` and nothing else, so it passed against the DYING OLD
    PROCESS, a 200 from the outgoing pid milliseconds before its SIGTERM -
    and on another run printed "up" and exited 0 with nothing listening at
    all. And `tmux -L cloude list-sessions` over a NON-INTERACTIVE ssh shell
    finds no tmux on PATH, and with stderr suppressed its "command not found"
    renders as "zero sessions".
    **THE GENERAL RULE THIS PROJECT NOW HOLDS: A GREEN CHECK MUST FIRST PROVE
    IT CAN GO RED.** Every one of these would have been caught by a negative
    control costing one line - plant the thing the check exists to catch and
    watch it fail. Ask of any check you write or trust: what does it do when
    its subject is ABSENT, when its tool is MISSING, and when its output goes
    to a pipe. And never read exit 0 from a command whose stderr you
    discarded. The worked examples in this codebase are `StatusMap.complete`,
    the recreate gate's `gone` versus `unknown`, `db_integrity`'s
    `cannot_determine` versus `failed`, and `InstanceIndex.complete`: in every
    one of them, a reading that did not happen is kept apart from a reading of
    nothing. Full write-up with each mechanism in
    `.claude/notes/troubleshooting.md`.

12. **A NAME THAT MOVED, REACHED THROUGH `getattr` OR `hasattr`, MERGES WITH
    ZERO CONFLICTS AND ANSWERS FALSY.** This is what made the 1.4.0 fold
    dangerous and it kept producing defects after the merge round closed: see
    "Where the 1.4.0 integration moved things" for the four found by the sweep
    and the two that reached production in `websocket.py` and
    `session_change_notice.py`. The defensive accessor is usually right and
    usually deliberate - it exists so a hook path cannot raise - which is
    exactly why it cannot be removed as the fix and exactly why nothing goes
    red. `setattr` on a name an object does not carry SUCCEEDS too, which is
    how a test tripwire wrapped four decoys and passed while measuring two of
    six. When a refactor moves a member, grep for a `getattr`, a `hasattr` and
    a `setattr` on its OLD name before you trust a green suite.
