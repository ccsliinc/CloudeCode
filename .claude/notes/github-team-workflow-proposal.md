# Moving to Issues plus Projects: what it replaces, what it does not

Written 2026-09-10 against what this project measured this week, not against the
idea in the abstract. The owner has sent Adam a description of a GitHub team
workflow (Issues and sub-issues, a Project board, milestones, issue templates,
one accountable owner per issue, PR review, Actions, rulesets, CODEOWNERS,
`Closes #123`) and asked whether they work in one shared repository or several.
This is the evaluation. The repository choice is the owner's and Adam's.

## The measured ground this rests on

**Three repositories exist and only one of them has an audience.**

| Remote | Repo | Public | Fork of | Stars | Tags | Issues | Actions secrets |
|---|---|---|---|---|---|---|---|
| `origin` | ccsliinc/CloudeCode | yes | Adoom666/CloudeCode | 0 | 54 | **OFF** | none |
| `adamdev` | Adoom666/CloudeCodeDev | no (private) | not a fork | 0 | 20 | on | `CLAUDE_CODE_OAUTH_TOKEN` |
| `upstream` | Adoom666/CloudeCode | yes | not a fork | **9** | 19 | on | none |

Verified 2026-09-10 with `gh api repos/<r>`. Corrections to the brief: `origin`
is a FORK of `upstream` and its Issues tab is DISABLED (the GitHub default for a
fork); `adamdev` is PRIVATE. The `upstream` push URL is the sentinel
`DISABLED_do_not_push_to_Adoom666_CloudeCode` and must stay that way.

**No ruleset and no branch protection exists on any of the three, and all three
have zero open issues.** Nothing to migrate today and nothing to unpick, which
will not stay true and argues for deciding now rather than later.

**Fork divergence is the root cause of this week, and the merge conflicts were
the cheap half.** Two merges, two numbers, both real: 2026-09-09, `v1.1` against
`adamdev/master`, 25 overlapping files and **17 hard conflicts** per
`git merge-tree` (`.claude/TODO.md:5482`); then 2026-09-10, after the
reconciliation round, **two conflicting files, both documentation**, `CLAUDE.md`
and `README.md`, every code file auto-merging
(`.claude/notes/compare-1.2/adam-round-2.md:87`).

**The expensive failure was a DESIGN collision no merge tool could see.** Our
TypeScript port of the LED went silently stale because his rewrite touched a
DIFFERENT file. Nothing conflicted, the rebase looked clean, the port was wrong.
Only `web/src/lib/StatusLed.test.ts` caught it, because its last block loads the
real `client/js/status-led.js` in a `vm` sandbox and compares output string
against string. On three separate occasions this week each side learned what the
other had built by running `git fetch`.

## 1. What Issues plus Projects replaces, part by part

**Three of seven coord artifacts are replaced and improved, one maps partly, and
three have no home in a work-item tracker at all.**

| Coord artifact | Verdict | Detail |
|---|---|---|
| `now/<party>.md` | **Replaces** | "What that party is on right now" is the In-progress column filtered by assignee. Better than the file, because moving a card is the same gesture as doing the work, so it cannot go stale in silence. |
| `log/<party>.md` | **Replaces** | Newest-first shas and what shipped, versus closed issues linked by `Closes #123` and grouped by milestone. Same data with the commits attached for free. |
| `notes/<party>-*.md` | **Replaces** | Prose to the other party becomes an issue comment, which also notifies. |
| `claims/` | **Partly** | Owner maps to assignee, status to the column, the `## approach` paragraph to the issue body. What does NOT map: the 72 hour expiry (an issue never decays, so a dead claim becomes a permanently Open card), and the machine-checkable `paths` glob. `coord.py check src/core/foo.py` exits 2 BEFORE work starts, expanding both sides' globs against the real file list rather than comparing strings. No tracker computes that. |
| `settled/` | **Does not replace** | See below. |
| `wants/` | **Does not replace** | See below. |
| `lessons/` | **Does not replace** | See below. |

**The owner's read of the three cross-cutting pieces is correct, and the reason
is sharper than "no natural home": none of them is a work item.** A tracker
object has an owner, a lifecycle and a done state. A ruling has none of those.
Forced into a tracker it either goes invisible (closed) or sits Open forever,
which is how a board stops being read. What to do instead:

- **Do NOT fold them into `CLAUDE.md`.** That re-introduces the failure the
  coord naming rule was built to eliminate: no file is shared, proved by a
  negative control. `CLAUDE.md` is the one shared file, it already conflicted
  substantively on 2026-09-10, and a merge resolved by taking one side deletes
  the other side's ruling silently.
- **Move them onto the CODE branch, keeping the per-party partition proved to
  merge cleanly**: `docs/decisions/<party>.md`, `docs/kept-behaviours/<party>.md`,
  `docs/lessons/<party>.md`. That puts them on the branch agents check out and
  makes each change reviewable in a PR rather than published unreviewed.
- **`CLAUDE.md` carries one pointer paragraph** to that directory, so the read
  path survives. `lessons/adoom666-written-down-is-not-read.md` is why that
  clause is not optional.
- **The enforcement is a test, not a label.** For every kept behaviour, ask what
  test goes red if it is removed; the LED ring ruling is enforceable in
  `tests/test_status_led.node.mjs`. A ruling with a test behind it cannot be
  silently redesigned; one with a label behind it can be redesigned by anyone who
  did not read the label. Where no test exists, THAT is a legitimate issue:
  "kept behaviour X has no test". The three artifacts do generate issues, just
  not by being issues.

**One caveat that changes the whole table.** Coord's actual job is
cross-REPOSITORY visibility between two clones with no shared default branch. One
shared repo makes that job evaporate and most of the protocol redundant; two
repos means issues in one are invisible from the other and coord stays the only
thing that works. The mapping above is conditional on section 3.

## 2. Review: require the checks, buy the human back narrowly

**A required human review on this team is a queue with one server, and both
parties drive agents producing hours of change in an afternoon.** It either
bottlenecks or degrades into a rubber stamp, and the stamp is worse because it
looks like a control. `.github/workflows/claude-code-review.yml` already writes
the general form down: six of six runs failed for credential reasons, and "a
check that always fails teaches everyone to ignore every check, including the
tests and the secret scan". One that always passes teaches it faster.

**Required status checks.** All exist today, are fast, and need no secrets, so
they run identically on a fork PR:

1. `tests / python tests (ubuntu-latest)` and `(macos-latest)`. Both legs. One
   alone is a verdict it never measured: `restore_backup()` matched its manifest
   with `grep '^BACKED_UP\tstate\t'`, BSD grep reads `\t` as a tab and GNU grep as
   a literal `t`, so restore silently restored zero files on Linux and reported
   success. The cost ceilings ride here: `tests/test_listing_*_cost.py`.
2. `tests / skip audit`. **Easy to leave out, and load-bearing.** It fails the
   build if a test was skipped on BOTH platforms; require the two test legs
   without it and green can mean "never measured anywhere".
3. `tests / javascript syntax`. `node --check` over every client file plus every
   `tests/*.node.mjs` suite, globbed rather than listed (200 tracked on
   `release/1.2.1`; the workflow comment records an integration arriving with
   fifteen suites and a workflow running two).
4. `secret scan / gitleaks`. Pinned to 8.30.1 by version AND sha256, scans the
   working tree, uses no secrets so a fork push cannot bypass it.
5. **The web parity suite and the bundle drift check, once they reach the
   release line.** `Run the web/ vitest suite` and `Prove the committed bundle
   matches web/src` (`scripts/web-build-check.sh`) exist on
   `origin/feat/svelte-1.3` and are NOT in `release/1.2.1`'s `tests.yml`. The
   vitest suite caught the most expensive failure of the week. Closing that gap
   is the highest-value CI work available.

**Not required, deliberately: `Claude Code Review`.** It skips entirely on fork
PRs by design, and succeeds WITHOUT reviewing when the OAuth secret is absent,
the case on ccsliinc/CloudeCode right now (`gh secret list` is empty there; only
CloudeCodeDev holds the token). A required check that legitimately passes while
doing nothing is a rubber stamp wearing a green tick. Keep it advisory.

**CODEOWNERS, chosen from paths that have actually burned this project.** There
is no CODEOWNERS file today. Each entry below names its incident:

| Path | Why a human, and what it cost |
|---|---|
| `src/core/session_adopt_identity.py`, `src/core/hook_token_recovery.py`, `src/core/session_boot_readopt*.py`, `src/core/session_adopt_persist.py` | A mint landing on a running agent revoked a credential the pane could not be handed a replacement for. Minted 16:16:40.633984Z, first rejection 130 ms later, 4,325 rejections until a hand restart at 20:40:23Z. 4h24m of dead hooks, invisible from inside the pane, every log line reading correctly. 5,609 tests did not catch it. |
| `src/core/session_manager.py` | The file BOTH parties independently rewrote this week. It is on `ccsliinc-listing-perf`'s paths and inside adoom666's `src/core/*_manager.py` glob, and the coord detector named it as one of three overlaps. This entry is the direct substitute for that warning if coord goes away. |
| `src/main.py`, `.gitleaks.toml`, `src/core/message_model_secrets.py`, `scripts/scan_secrets.py`, `.github/workflows/**` | A CSP widening is a one-line diff no test but `test_no_remote_assets.py` can see; the CDN removal was a correctness fix because Brave Shields dropping `xterm.css` made FitAddon reflow the real tmux pane. Workflows are where a required check gets quietly deleted, so a PR that removes its own gate must be read by a person. |
| `src/config.py` | A half-written `config.json` costs the user their whole setup. The `.bak` then temp then `fsync` then `os.replace` order is easy to simplify away and nothing looks different until it fails once. |
| Schema and migration files | The v8 to v24 `session_group_membership` re-key (the old table keyed on the reusable `tmux_name`), and `claim_instance`'s "only when not None" half-write that stored `project_attribution` alone and left the row contradicting its own project. Irreversible against user data. |
| `client/js/status-led.js`, `client/js/session-status-ui.js` | The two files `web/src/lib/StatusLed.test.ts` proves equivalence against. This is where the silent staleness happened. |

**Deliberately NOT owned: `client/js/**` and `web/**` broadly.** Highest-churn
area, both agents in it constantly, and blanket ownership there is precisely how
a reviewer becomes a rubber stamp. **Two-person caveat:** an entry naming the
other person means every touch waits for them, so unless self-review is allowed
everywhere EXCEPT these paths, CODEOWNERS gets deleted within a week.

## 3. The repository question, laid out neutrally

**One shared repo means picking one, which decides who administers rulesets,
where releases live, and what happens to 54, 20 and 19 tags that may not agree
with each other.** Not recommending. Four options.

**Option A, Adoom666/CloudeCodeDev.** Already the meeting point; both parties
push there daily; Issues on; `CLAUDE_CODE_OAUTH_TOKEN` present; `coord` already
lives there. Costs: it is PRIVATE, so a public tracker is off the table; every
release on it is a DRAFT, so the published line lives elsewhere; `origin`'s 54
tags and its two published releases (v1.2.0 and v1.2.1, both dated today) have
to be pushed in or left behind; Adam administers.

**Option B, ccsliinc/CloudeCode.** Public, carries the current release line and
the newest tags. Costs: Issues must be switched on; it is a FORK, so a new PR
defaults its base to the parent (Adoom666/CloudeCode, the repo nobody may push
to), a live footgun rather than a theoretical one, and detaching a fork is a
GitHub support operation rather than a setting; no Actions secrets at all, so
Claude review runs in skip mode until one is added; Adam needs an invite; and
it is a fork with 0 stars while the audience sits at the parent.

**Option C, a new repo under a shared org.** The only option where administration
is genuinely shared and neither person's repo changes identity. Costs the most on
day one: push every branch and tag, re-create releases, re-add secrets, re-point
remotes in the main clone and all ten worktrees.

**Option D, stay on two repos and adopt Issues plus Projects in ONE of them
anyway, keeping `coord` for cross-repo visibility.** The reversible option, and
the honest baseline the other three should be measured against.

**Migration cost common to every option, stated once.** Open issues: zero
everywhere, so nothing to move today. Stars and forks do not transfer, and the
only ones that exist (9 stars, 1 fork) belong to the repo excluded from the
choice. Published releases are re-created rather than moved, and drafts do not
carry over meaningfully. Tags are the genuine risk: the same name may point at
different commits across the three, so compare before pushing and never force.
CI secrets are per-repo and there is exactly one.

**The deciding question, offered as a question and not an answer: does the
tracker need to be public?** If yes, Option A is out; if no, it is cheapest by
a wide margin.

## 4. What to do in the meantime, so this stays reversible

**Keep doing the parts that survive every outcome.**
- `now/` and `coord.py check` before starting work. Ten seconds, and the thing
  that would have prevented all three "found out by fetching" incidents. Under
  a shared repo the habit becomes a board column, so it transfers.
- The `## approach` paragraph on every claim. The only artifact that catches a
  DESIGN overlap, the class that cost the week. An issue body carries it
  verbatim, so writing them now is not wasted.
- `settled/`, `wants/` and `lessons/`. They migrate into `docs/`, not into a
  tracker, so every entry written now is one nobody reconstructs from memory.

**Stop investing here if a move is likely.**
- Tooling on `coord.py` and `coord.sh`: the overlap detector, expiry
  computation, the clone lock, the sync two-step. Machinery for coordinating
  across two repos with no shared tracker. We paid this once already this week,
  retiring 727 lines of our own `scripts/coord.sh` for Adam's skill.
- `tests/test_coord_skill_upstream_sync.py`. Correct today, but it is test
  surface on a component with a plausible end date.
- Further merge-safety simulation of the branch layout. Proved, working, and
  answering a question a shared repo does not ask.
- Any second implementation of what the tracker gives away: no priority field,
  no board rendering, no assignment mechanic, no notification layer.

## 5. Migration checklist, in order, if the answer is yes

Reversible and free steps first, irreversible last, so an abandoned migration
costs nothing.

1. Decide the repository. Nothing else can start.
2. Snapshot before touching anything: `git ls-remote --tags` and
   `gh release list` for all three, saved to a file. Same discipline as
   `scripts/upgrade-baseline.sh`: you cannot verify a migration without a record
   of what the data was, and that is the step everyone skips.
3. Enable Issues on the winner if it is ccsliinc/CloudeCode (currently off).
4. Add both people as admins.
5. Push every branch, then compare tags across repos BEFORE pushing them. Never
   force. A name colliding on two different commits is the failure to catch here.
6. Re-create published releases on the winner if the release line moves.
7. Add `CLAUDE_CODE_OAUTH_TOKEN` as an Actions secret.
8. Land CODEOWNERS, the issue templates and the `docs/decisions|kept-behaviours|lessons`
   move as one normal PR, so the first PR under the new rules is the one that
   creates them and both parties watch it work.
9. Open a throwaway PR and verify every intended required check appears and
   reports a name matching the ruleset string. A ruleset naming a check no
   workflow emits blocks every merge and looks like a broken repo.
10. Only now enable the ruleset. First irreversible-feeling step, last on purpose.
11. Re-point remotes in the main clone and all ten worktrees. Leave the
    `upstream` push sentinel exactly as it is.
12. Leave `coord` in place, read-only, with a final note. Do not delete it: it
    is the record of why any of this happened.

## What is not verified here

The two humans' preferences on administration and publicity, the whole of section
3. Whether Adam has admin beyond what `gh` shows this account. Whether any of the
54, 20 and 19 tags actually disagree; that is checklist step 5 and was not run.
Whether GitHub's fork PR base default is changeable per-repo rather than per-PR.
