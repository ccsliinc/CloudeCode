# The 1.4.0 integration fold, and what shipped where

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## Where the 1.4.0 integration moved things

`integration/1.4.0` folded the other party's `adamdev/master` at `6012467`
into this line in full. **RE-MEASURED 2026-09-12, BECAUSE THIS FILE AND
`.claude/TODO.md` BOTH CARRIED A WRONG PAIR OF NUMBERS.** The range
`4d8aa76..6012467` holds **89** non-merge commits, of which **87 are his**
(84 `psyance`, 3 `Adoom666`) and **2 are ours**, carried back in by the two
merges of our line he took inside his own. So 87 and 89 are both right about
different questions and neither is a correction of the other; say which one
you mean. The tree diff over that range is **244 files, +48172 / -3761**
(`git diff --shortstat 4d8aa76 6012467`). The 245 files and +50446 this file
and the TODO both used to state are not reproducible by any spelling of that
diff; the per-commit sum, the one derivation that does run higher, reads
+49306 / -4297 over the same 244 files. The release-wide frame is different
again and is the one the published notes use: **87 of the 171 non-merge
commits between `v1.2.1` and `v1.4.0`**, 198 commits across 27 merges, 704
files changed. Most of it
merged with no conflict, and the interesting part of the round was the code
that merged CLEANLY AND WAS WRONG, because his tree reaches for seams this
line's decomposition had already moved. If you are porting anything else
across, this is the map.

| His spelling | This line |
|---|---|
| `session_manager.sessions` / `.backends` | `session_manager._registry.sessions` / `.backends` |
| `session_manager._subscribers` | `session_manager._registry.subscribers` |
| `session_manager.subscribe_output` / `unsubscribe_output` | `SessionRegistry.subscribe` / `.unsubscribe` |
| `session_manager._pending_toasts`, `ack_toast`, `get_toasts` | `session_manager._toast_inbox.pending` / `.ack` / `.get` |
| `session_manager._hook_tmux_names`, `_mint_hook_token` | `session_manager.hook_tokens.tmux_names` / `.mint` |
| `session_manager.pinned_themes`, `set_project_theme`, `resolve_project_theme` | `session_manager._theme_store.*` |
| `session_manager.pending_terminal_commands` | `session_manager._sidecars` |
| `session_manager._owned_instances_from_db`, `is_owned_tmux_name` | `session_manager._owned.instances_from_db` / `.is_owned_name` |
| `session_manager._last_probe_socket` | `session_manager._probe_health.socket` |
| `src/api/routes.py` handlers | the sibling module that owns the resource |
| `src/config.py`, `src/models.py` | the `src/config/` and `src/models/` packages |

**THE DANGEROUS HALF IS THE ONE THAT DOES NOT RAISE.** Three of those reads
arrived behind a `hasattr` or a `getattr(..., {})` default, so on this line
they would have answered falsy rather than failing: `_drain_viewer` would
have run with no idle watcher and no pattern detection on every session,
silently, with the whole suite green. `tests/test_listing_off_the_loop.py`'s
thread tripwire was worse - `setattr` on a name an object does not carry
SUCCEEDS, so it would have wrapped four decoy containers and passed while
measuring two of six.

**AND TWO MORE OF THAT EXACT SHAPE SURVIVED THE SWEEP AND REACHED
PRODUCTION.** Both were fixed in `c725905`, after the 1.4.0 deploy, and both
are the same mechanism one layer out: a name that moved, reached through
something that answers falsy or gets swallowed rather than raising where a
test can see it.

`src/api/websocket.py:270` passed `session_manager` into `_resolve_backend`
while lines 307 and 325 passed `registry`. The live session table moved to
`SessionRegistry`, so `SessionManager` carries no `get_backend` and the call
raised `AttributeError` - **and the whole handshake sits under one
`except Exception` that logs `ws_handshake_error` and falls through to the
streaming loop**, so the socket lived and bytes still streamed while the
NEGOTIATED RESIZE and the ATTACH PAINT were both skipped on every terminal
open. Measured on live: `ws_handshake_resize` 1, `ws_handshake_error` 1,
`ws_handshake_painted` 0. That is the documented mechanism behind this
project's wrong-grid and "input lag" symptom, arriving again by a new route.
`tests/test_ws_handshake_paint.py` is deliberately BEHAVIOURAL: it drives the
real handshake against a real `SessionRegistry` and a manager stand-in that
faithfully has no `get_backend`, and asserts the pane's screen REACHES the
client. A test asserting that line 270 passes a variable named `registry`
would pass forever while somebody renamed the variable and put the defect
back, and a test that merely opened a socket and checked it survived would
pass WITH the defect, because surviving is exactly what the swallow
guarantees.

`src/core/session_change_notice.py` had it twice over in one function.
`publish_hook_status` read `get_backend` off the manager through a `getattr`
and fell back to `_hook_tmux_names`, and BOTH of those moved - the first to
the registry, the second to `HookTokenAuthority.tmux_names`. Measured against
a real `SessionManager`, both answer falsy, so `tmux_session` was always
None, the `if tmux_session:` block never ran, and **every hook status notice
on `/ws/events` went out carrying neither a tmux name nor an unread flag**.
The tolerance is KEPT, because this runs on the hook critical path and must
never raise; it is pointed at the objects that now carry the members rather
than at the names that moved.

**THE SWEEP THAT FOUND THEM IS WORTH RE-RUNNING AFTER THE NEXT FOLD.** An
AST pass over every `self.<attr>` in `session_manager.py`, resolved against
the real class, plus every `from src.config import X` / `from src.models
import Y` resolved against the package. Static import plus an attribute
existence check beats reading diffs here, because the whole point is that
the diff looks fine.

**AND `src/api/routes.py` IS THE ONE TO WATCH ON A MERGE.** This line carved
it from 4,397 lines to 106 in `e859106`, slice S6 - the assembly and the
registration order, which is the route table's matching order - while his
line kept editing the flat file. The merge resolved that to his file plus his
additions, 4,593 lines, ZERO conflicts reported, the decomposition silently
reverted and every route declared twice: **51 route decorators in that one
file**, every one of them already declared by a sibling. Nothing would have
thrown; FastAPI takes the first match, so which handler answered would have
depended on include order. If a future merge touches that file, check its
LINE COUNT before you check anything else.

This paragraph said **4,387** until 2026-09-12 while "How we work here" next
door said **4,397**, so the file disagreed with itself about the one number
it tells you to check. 4,387 is the count at `release/1.2.1` and at the merge
base `4d8aa76`; the file grew ten lines before S6 ran. Measured:
`git show e859106^:src/api/routes.py | wc -l` is 4397 and
`git show e859106:src/api/routes.py | wc -l` is 106. **A number quoted in two
places drifts in one of them**, which is the general form of this and of the
commit counts above, and the only defence is to measure both when you touch
either.

### What shipped, and where it is published

Verified 2026-09-12 against git and the GitHub API, because "we released it"
is the kind of claim that decays quietly.

- **`v1.4.0` is an ANNOTATED TAG naming commit `7da2901`**, not `b5de919`.
  `b5de919`, the boot integrity gate, is one commit PAST the tag and is the
  tip of `integration/1.3.0` on both `origin` and `adamdev`. The branch keeps
  the name `integration/1.3.0`: it is already on both remotes and a name is a
  handle, not a declaration.
- **The release is published on `origin` (ccsliinc/CloudeCode)**, marked
  Latest, published 2026-09-11T22:29:38Z, one asset
  `Cloude.Code-1.4.0-arm64.dmg` (126,619,315 bytes) with its sha256 printed
  in the body beside the `shasum -a 256` line that checks it. `v1.2.0` and
  `v1.2.1` are still published there and are the stated downgrade path.
- **`adamdev` (Adoom666/CloudeCodeDev) HAS NO PUBLISHED RELEASE ON THIS
  LINE**, which is not the same as having none at all - a claim worth saying
  precisely because the loose version gets repeated. Its `v1.2.0`, `v1.0.36`
  and `v1.0.35` are DRAFTS; the newest thing actually published there is
  `v0.8.1` from 2026-08-04, and it still wears the Latest badge. That ruling
  is SUPERSEDED: from `v1.4.3` releases are published on
  `Adoom666/CloudeCodeDev` only, per "One repository: Adoom666/CloudeCodeDev"
  in `docs/DECISIONS.md`.
- **THE PUBLISHED RELEASE BODY CARRIES ONE WRONG NUMBER AND IT HAS NOT BEEN
  CORRECTED.** It says `src/api/routes.py` "drops from 1160 lines to 303".
  Measured, it is 4,387 at `v1.2.1` and 106 at `v1.4.0`; neither 1160 nor 303
  is the count of that file at either tag. Everything else in that body
  reproduces exactly: 87 of 171 non-merge commits (84 psyance, 3 Adoom666),
  198 commits over 27 merges, 704 files, 26 Svelte components, and python
  modules under `src/` going 264 to 377. The body is on GitHub rather than in
  this repo, so fixing it is an edit to the release, not a commit.
- **`RELEASE-NOTES.md` IN THIS REPO STOPS AT v1.0.9 AND IS NOT WHERE RELEASE
  NOTES LIVE ANY MORE.** Its newest heading is `## v1.0.9`; every release
  from v1.2.0 on is written in the GitHub release body. Do not "bring it up
  to date" without deciding which of the two is the record - two copies of a
  release note is the same drift this section exists to catch.
- **Deployed to the live mini and running.** Reported by the owner
  2026-09-11: deployed to mac-mini-m4, 19 sessions intact across four
  restarts. NOT re-verified by this documentation pass, which does not touch
  the live host; `scripts/deploy-mini.sh --verify-only` is what re-checks it.
