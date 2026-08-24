# Release notes

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
