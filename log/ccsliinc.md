# ccsliinc landed

newest first. append only, never edit an entry once written.

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

