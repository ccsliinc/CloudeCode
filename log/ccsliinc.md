# ccsliinc landed

newest first. append only, never edit an entry once written.

## 2026-09-10 release/1.2.1 assembled: adoom666's four merged, and one row menu

**Assembled, NOT tagged and NOT deployed at the time of writing.** Tip is
`546443e` on `release/1.2.1`. `v1.2.0` is still the newest tag.

From adoom666, merged in: `4ae4b71` the web ui plan, `46e7aca` durable
session mute, `6f79e90` terminal theme restoration, `8898f07` the session
row action menu, plus the five listing commits already logged below.

Ours on top:
- `402526f` a bulk listing may only vouch for its own socket. Adds a
  `backend_socket` scope to his `listing_proves_alive`; a completed
  listing taken from a different socket no longer vouches, because a tmux
  name is not unique across sockets and we mint names from project slugs.
- `3837f24` the status seed reads its row from the pass's bulk index.
- `489d9df` throttle the permission re-look, never the first look.
- `94ecc85` the merge of `8898f07`, row menu held for the owner.
- `546443e` one row action menu, the superset the owner ruled. His three
  modules are the base. Ours restored beside his: live-row restart, the
  mark-unread control behind `ui.show_mark_unread_control`, group filing,
  and the right-click and long-press gestures. Double-click rename kept,
  F2 added, menu rename added, all three into one editor.

The trap in that merge, recorded because it would have compiled and lied:
his trigger stamps `data-row-menu-status` and our restart runner read
`data-row-status`. Every restart would have reported "unknown" with
nothing failing. Repointed, then test-guarded properly on a second pass.
See `lessons/ccsliinc-a-test-that-cannot-fail.md`.

pytest 5708 passed / 2 failed / 19 skipped, the two environmental and
unchanged from the merge baseline. Node 200 suites, zero failing.
`scan_secrets` exit 0.

## 2026-09-10 feat/svelte-1.3 published to both remotes

`d6801cb` is now on `adamdev` and on `origin`. It was on neither, which is
why adoom666 could not read `web/` and correctly declined to revert a
working menu for an invisible one. That gap was ours.

## 2026-09-10 1.2.1 in progress: adoom666's five commits merged, listing performance on top

**IN PROGRESS at time of writing, not shipped.** Another agent is actively
merging in the `release-1.2.1` worktree.

`release/1.2.1` currently carries, past `release/1.2`:
- `7e4f09b` sha256 for the rebuilt v1.0.36 dmg (adoom666)
- `202de53` dismiss a toast card on name-click, never show one for the active
  session (adoom666)
- `c8ef6a8` stop the session listing blocking the event loop for a second a poll
- `a4eff35` read the stored row once, and wake the pipe on the append (adoom666)
- `2b1fcb9` skip the index read entirely when the listing has no rows (adoom666)
- `aea1bb8` the merge of `adamdev/master` 2b1fcb9, docs resolved additively
- `402526f` a bulk listing may only vouch for its own socket
- `3837f24` the status seed reads its row from the pass's bulk index

**Not yet merged from adamdev/master:** `4ae4b71` (the web ui performance and
session menu plan) and `46e7aca` (durable session mute). Both landed while
1.2.1 was being assembled. That is the third time in two days we learned about
work by fetching, and it is why this coordination branch exists.

## 2026-09-10 gitleaks 8.30.1 installed as the second secret gate

Documented in `344da42`. The pre-commit hook has always had two gates; only the
first (`scripts/scan_secrets.py`) was running locally on the mini, because
gitleaks was not installed there. It now is, at 8.30.1, with the repo's own
`.gitleaks.toml`, which is the same scanner and the same config CI runs.

Why both, measured 2026-08-31 and not assumed: the python scanner catches a
1Password `ops_` service account token, which gitleaks 8.30.1 has no rule for at
all, and that is the credential class this fleet has actually leaked. gitleaks
names about 170 vendor formats the python scanner only ever sees through a
generic entropy heuristic. Neither is a superset of the other.

Closes the open TODO item "gitleaks is not installed on the mini".

## 2026-09-10 the electron bundle rebuilt at 1.2.0 and installed on live

Recorded in `543ed99`. The menubar app bundle was rebuilt against 1.2.0 and
installed on mac-mini-m4, so the tray app and the served client are the same
build rather than a 1.0.x shell around a 1.2 server.

## 2026-09-10 v1.2.0 released: both lines merged, deployed, tagged, pushed to both repos

`release/1.2` assembled off `v1.1`, with adoom666's `adamdev/master` at
`887b8fc` merged in as `0afd132`.

- Tag `v1.2.0` at `ecd0669`.
- Deploy record at `ecd0669`, live on mac-mini-m4 running `6768dcc`.
- Pushed to both `origin` and `adamdev`. Nothing pushed to `upstream`.
- Late fixes on top of the merge: `67990f3` (a ui-flags `ensure()` that had no
  caller, so the setting shipped dead) and `6768dcc` (CLAUDE.md states the
  shipped LED model on first encounter).

What came in from adoom666 in that merge: the DMG brand work (`887b8fc`,
`8e7f8b9`) and the v1.0.36 release commit.

