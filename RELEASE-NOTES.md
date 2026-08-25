# Release notes

## v1.0.3

Measured against `v1.0.2`. Three fix branches plus the open PR that finally
brought the v1.0.x line onto `ship/round5`.

Test suite at the release sha: **2561 passed, 0 failed** (2561 collected),
run with `--ignore=tests/test_nuke_sandbox.py`, which executes the real
`nuke.sh`. That reconciles exactly against the branch baselines, measured
rather than reported: v1.0.2 collects 2529, and the three branches collect
2537, 2542 and 2540, so +8 +13 +11 = 2561. Node suite: 94 files, all green,
run per file (1665 assertions). JS syntax check: 97 files parsed cleanly
(95 at v1.0.2, plus the two new pure modules `macOS/setup-verdict.js` and
`macOS/published-url.js`).

### What shipped in this release

**The tray stops showing an address the server is not listening on.** The
bind row renders the MEASURED bind, never the configured aspiration, and
`src/config.py` no longer reports `effective_bind_host` as whatever was
configured - it reports what was actually bound, via the new
`record_bound_host` / `bind_report` pair.

**One answer to "is setup finished", and the server owns it.** The tray had
its own private notion of configured that required three `CLOUDFLARE_*`
environment variables belonging to a tunnel feature removed in plan v3.2.
Nothing writes them, so the condition was unsatisfiable by construction and
the menu offered "Run Setup Script" to a user who was already set up. The
verdict now comes from the server through the new `macOS/setup-verdict.js`,
with a local evaluation used only when there is no server to ask, reading
the same facts. A stopped server is not an unconfigured one and no longer
renders as one. The same dead gate is gone from `setup.sh` and from
`macOS/server-manager.js`.

**Tray status glyphs say more.** Undimmed; `stopped` is a grey filled dot,
`starting` an amber hollow ring, and `attention` moved from red to amber.

**Running setup again no longer destroys a paired TOTP secret.**
`setup_auth.py` preserves an existing secret by default. Rotation is now an
explicit, typed-confirmation act: `--rotate-totp` and `--rotate-jwt`. The
`.totp_paired` sentinel is cleared only when the secret actually changed.

**A fresh install opens onto a usable screen.** The create control moved out
of `#running-sessions-section` - whose `display:none` made a global control
disappear whenever there were no running sessions - into an always-present
`.launchpad-actions` row. `config.example.json` ships `projects: []` instead
of four invented demo projects pointing at paths that existed on nobody's
machine. Clicking a project whose folder is gone now explains itself by name
and path instead of doing nothing. `getPublishedUrl()` no longer falls back
to a LAN address when the bind is unmeasured, which during the setup lockdown
sent the browser to a port nothing was listening on. New
`src/core/tmux_discovery.py` stops tmux discovery depending on a single PATH
prepend in the launcher.

### Known and unchanged

`scripts/verify_home_mechanics.py` ITEM 48 fails, as it did at v1.0.2.
`scripts/verify_selection_apps.py`, `verify_selection_regressions.py` and
`verify_selection_scrolled.py` cannot be evaluated without a live-server
harness artifact; they behave identically at v1.0.2, so this is a
CANNOT DETERMINE, not a pass and not a regression.
`setup.sh` still PROMPTS for Cloudflare values further down the script. Only
the completeness GATE was removed. The prompts are dead code and were not in
scope here.

## v1.0.1

**This is the v1 release. `v1.0.0` was tagged and immediately superseded** -
its CI skip audit was red, and the tag is left in place rather than moved so
the record stays honest. Do not install `v1.0.0`.

What was wrong with it: removing the server reset endpoint emptied the
`ACCEPTED_UNDELIVERED` register in `tests/test_runtime_script_delivery.py`,
and a `parametrize` over an empty collection collects one placeholder case
that pytest SKIPS on every platform. The CI skip audit exists to refuse
exactly that - a test that cannot go red - and it did its job. The test now
iterates the register inside its body, so it RUNS against an empty register
and still fails the moment a thin exemption reason is added.

Measured against `v0.8.1`. This is the first 1.0 and it is a version-string
decision, not a claim that everything below is finished - the known issues
are real and listed.

Test suite at the release sha: **2528 passed, 0 skipped** (2528 collected),
run with `--ignore=tests/test_nuke_sandbox.py`, which executes the real
`nuke.sh`. Node suite: 91 files, all green, run per file. JS syntax check:
95 files parsed cleanly.

### What shipped in this release

**Workspace settings, in the app.** A settings screen with a development
root, a default shell, a default editor and an environment map, plus bind
and TLS preferences. Two additive blocks in `config.json` - `workspace` and
`server_prefs`. No config version bump, so an older build reads the file and
ignores what it does not know. The environment map actually reaches a newly
spawned terminal; that is measured, not assumed. The menu bar opens the
settings screen, and the Edit Config item no longer claims to do something
it did not.

**Downgrade got safer, in one specific way.** The state-file location is now
resolved once per filename and pinned, and `rollback.sh` restores each file
to where it found it rather than to wherever the current version would put
it. That closes the file-LOCATION half of the metadata-loss defect. It does
not close the other half - see the known issues.

**The in-app "reset server" control was withdrawn.** It called
`POST /api/v1/server/reset`, which ran a `reset.sh` that has never been in
the app bundle, so it returned a 500 on every packaged install. Shipping the
script would have been worse than the 500: in a packaged install its
fallback branch would have killed the python child the Electron app owns and
left a detached uvicorn holding the port after the app quit - a quiet wrong
state in place of a loud correct error. The endpoint and its UI control are
both gone. Restart the app from the tray menu, or `launchctl kickstart -k`
under launchd. Nothing that worked was removed: the mini never had the
script.

### Resolved earlier in this line, and you may still be exposed

These were fixed, but a machine that ran the broken version still carries
the damage. Read them even though they say RESOLVED.

**The uninstaller left your data on disk while reporting a full reset.**
"Nuke it from Orbit" reported a complete wipe and left `cloude.db`, the
migration trail and your stored refresh tokens in place. If you ever ran the
old uninstaller, **those files are still there** - this release removes them
when you run the current one, but it cannot retroactively undo the old
run's false report. Check the state directory yourself if that matters to
you.

**Rollback on Linux restored no state files while printing a success
count.** The count came from what it intended to restore, not from what it
wrote. A Linux rollback that told you it restored N files may have restored
none of them. If you rolled back on Linux and your app came back not
recognising its own sessions, this is why.

### Known issues

Each of these is real and shipping anyway. Read the consequence, not the
title.

**A config with object-form slash commands will not load on v0.8.1.** If any
slash command in your `config.json` carries a description, the older server
exits at startup rather than starting with a degraded config. New writes
normalize to bare strings when there is no description, which shrinks the
exposure without eliminating it. Check your slash commands before you
downgrade.

**A second downgrade defect is UNMEASURED.** Separate from the file-location
fix above, `v0.8.1` was observed to prune a live session from the owned set
and delete its metadata as stale. Consequence: after a downgrade the tmux
sessions keep running and the app presents them as strangers you must
re-adopt. The location fix does not address this and nobody has measured how
far it reaches. Recorded in `docs/upgrade-downgrade-roundtrip.md`.

**The login screen applies no theme variables.** The theme manifest is
fetched after authentication, so the login screen renders in default colours
no matter which theme you picked. Cosmetic, long-standing, unchanged here.

**Logging out with an active session may stack two confirmation dialogs.**
Found by reading the code path, not measured against the running app. If you
see two dialogs, that is this.

**The TLS preference is recorded but not enforced.** The settings screen
lets you express a TLS preference and stores it. There is no TLS terminator
in this build, so nothing acts on it. Setting it does not make anything
encrypted.

**`verify_home_mechanics` fails on ITEM 48.** The help panel does not move -
it stays the first child of its container. Pre-existing, confirmed identical
at the base commit, and this release took that harness from 6 failures to 3.
Not introduced here and not fixed here.

**Three verification harnesses could not be evaluated for this release.**
`verify_selection_apps`, `verify_selection_regressions` and
`verify_selection_scrolled` each need a live authenticated server and a TOTP
secret file that was not present. They are CANNOT DETERMINE, not passes.
`verify_lifecycle_reconcile` is a parameterised tool requiring `--db` and
`--listing` and was likewise not exercised.

**The type-NUKE confirmation window has been verified as rendered markup,
not as a live Electron window.** Its HTML was rendered at the window's real
dimensions: the confirm button is disabled on an empty field, still disabled
on the wrong word in the wrong case, and enables only on exactly `NUKE`.
Focus lands on the text field, not on the destructive control. The Electron
window that hosts it, and the wiring from its verdict to `nuke.sh`, are
covered by source-level tests only. Nobody has watched the real window open.


## v0.8.2

Measured against `v0.8.1`. 390 commits. Test suite at the release candidate:
2334 passed, 0 skipped. JS syntax check: 94 files parsed cleanly.

### The headline

**The uninstaller used to lie.** "Nuke it from Orbit" reported a complete
reset while leaving the session database and your stored refresh tokens on
disk. That is fixed. If you ever ran the old uninstaller, those files are
still there: `cloude.db`, the migration trail and the state directory's
token store. This release removes them; the old one did not, whatever it
printed.

This reaches upgraded installs, not just fresh ones. The release candidate
shipped the fixed script without shipping it to the place the app runs it
from; that delivery gap is closed here.

**The uninstaller fix now actually reaches an upgraded install.** This was
listed as a known issue in the release candidate and is fixed. `nuke.sh` was
excluded from the per-launch asset resync so that a customized copy would
survive, and the tray menu executes the copy in the derived server directory
- so every upgrade paired the NEW confirmation window with the OLD
destructive script, and looked fixed while behaving exactly as before.
`nuke.sh` is now resynced from the bundle on every launch like every other
build artifact. A test derives the set of scripts the app executes by path
straight from the source and fails if any of them is not covered by the
resync allowlist, so a script added later is caught without anyone
remembering to update a list.

**The uninstaller now makes you type the word NUKE.** The tray menu used to
show a message box with a "NUKE IT" button, one mis-aimed click away from an
irreversible wipe, on a menu that also holds ordinary items. It now opens a
confirmation window where the confirm control stays disabled until the field
contains exactly `NUKE`. A window closed any other way is a no, never a yes.
The dialog also names what it destroys, including the refresh tokens, which
the old one never mentioned. It no longer claims to delete a Cloudflare
tunnel and DNS records, which it stopped doing several versions ago.

### Also in this release

- **App state moved to `~/Library/Application Support/CloudeCode`**, with
  `CLOUDE_STATE_DIR` to override it.
- **A real datastore.** `cloude.db` plus a migration trail. Sessions,
  projects and adoption now persist instead of being re-guessed at launch.
  `cloude.db` is authoritative; `config.json` is the rollback artifact.
- **Home screen** is a two-level project-to-session tree with a RECENT
  group, session pinning, a user-defined order and a density control.
- **Setup wizard**, plus a bind lockdown so the server refuses to listen
  broadly while it is unconfigured.
- **Upgrade and rollback scripts** for from-source installs, tag-based, and
  rollback moves DATA with CODE or refuses and says why.
- **Themes** gained canvas background effects across the whole set, and
  session rows paint in their own session's theme.
- **Terminal**: translucent background over the theme effect, altscreen and
  transcript scrolling routed through one primitive, refit on resize.
- **File browser** is a dockable right-side drawer; the file editor is a
  full-screen modal.
- **Tray icon** carries a status light for server, sessions and updates, and
  the secure/insecure binding indicator now reports what is actually true
  rather than an address nothing is listening on.
- **CI now parses `macOS/`.** The Electron main process, the code that
  spawns the uninstaller, was the one JavaScript tree in this repo that no
  syntax check had ever looked at.

### Known issues

Each of these is real, reproduced, and shipping anyway. Read the
consequence, not just the title.

**Session metadata does not survive a downgrade. Confirmed unsafe.**
`detach_session` relocates the metadata file into the state directory, and
`rollback.sh` restores state files to the new location regardless of where
it found them. If you roll back to an earlier version, you lose the record
of which tmux sessions this app owns. The sessions keep running. The app
does not recognise them and presents them as strangers you have to re-adopt.
Not fixed in this release.

**A config with object-form slash commands will not load on v0.8.1.** If any
slash command in your `config.json` carries a description, the older server
exits at startup rather than starting with a degraded config. New writes
normalize to bare strings when there is no description, which shrinks the
exposure but does not eliminate it. If you plan to downgrade, check your
slash commands first.

**The login screen applies no theme variables.** The theme manifest is
fetched after authentication, so `document.documentElement.style.length` is
0 on the login screen and it renders in default colors no matter which theme
you have chosen. Cosmetic, long-standing, unchanged here.

**Logging out with an active session may stack two confirmation dialogs.**
Reported by inspection of the code path, not measured against the running
app. If you see two dialogs, that is this.

**RESOLVED: the in-app "reset server" control was removed.** It called
`POST /api/v1/server/reset`, which ran `reset.sh` from the server's own
directory, and `reset.sh` has never been in the app bundle - so the control
returned a 500 naming the missing file on every packaged install. Shipping
the script would not have fixed it. Restarting a process belongs to whatever
supervises that process, and this server never supervises itself: packaged,
`macOS/server-manager.js` owns the python child and already has `restart()`;
under launchd, `launchctl kickstart -k` is launchd's own job; from source,
`./reset.sh` is still in the tree. `reset.sh`'s fallback branch is
`stop.sh` + `start.sh`, which in a packaged install would kill the child the
app owns (the tray would report a crash that did not happen) and leave a
detached uvicorn holding the port after the app quits - a quiet wrong state
in place of a loud correct error. **Restart the app from the tray menu.**

**The type-NUKE confirmation window has been verified as rendered markup,
not as a live Electron window.** Its HTML was rendered in a browser at the
window's real dimensions and checked: the confirm button is disabled on an
empty field, still disabled on the wrong word in the wrong case, and enables
only on exactly `NUKE`. Focus lands on the text field, not on the
destructive control. The Electron window that hosts it, and the wiring from
its verdict to `nuke.sh`, are covered by source-level tests only. Nobody has
watched the real window open. Open it once and press Cancel if you want that
last bit of certainty.
