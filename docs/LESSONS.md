# Lessons

Defect shapes that have bitten this project more than once, and what to do
instead. Each was re-derived independently by different people or agents who
did not recognise it as a repeat, which is the cost this file exists to stop.

Add one when a pattern REPEATS. Once is an incident; twice is a pattern.
Cite the evidence: commits, dates, measurements. A guess written here reaches
every agent automatically, which makes it worse than nothing.

**This file is the whole record. Nothing is only on the `coord` branch any
more.** That branch carried six lesson files; four had been folded in here,
and the two that had not are now the "A dated record cannot overturn a later
ruling" and "Both lines keep having the same idea" sections below. The
originals stay readable at `git show origin/coord:lessons/<file>` as evidence,
and nothing new goes there.

**That gap is itself the reason this file exists on the path an agent walks.**
`coord` was superseded by `.claude/skills/work/` on 2026-09-10 and two of its
six lessons sat unmigrated for two days, visible only to someone who thought
to check out an orphan branch. A record that lives inside a mechanism dies
when the mechanism is replaced. `docs/` is not under `.gitignore`'s
`.claude/*` rule, so this file needs no `git add -f` and shows up in a plain
`git status` for both teams.

---

## Unmeasured is not absent

**Ten occurrences across two codebases and both teams' tooling.**

A function whose job is to NOTICE something is handed input it cannot read,
or reads a source that is not ready, and returns the same answer it gives
when there is genuinely nothing to notice. The caller cannot tell "I looked
and found nothing" from "I could not look".

- `coord.py expired()`: an unreadable date returned "expired", and the
  overlap detector skips expired claims, so a typo'd header was invisible to
  the one function whose job is catching collisions.
- `listing_proves_alive` (`c8ef6a8`): first version trusted a bulk listing's
  silence in both directions. Four rename tests caught it dropping live
  sessions. Now asymmetric: a naming proves existence, an absence proves
  nothing and still pays `is_alive()`.
- `resolve_startup_gate`: no tail captured refuses with `unknown`; tail read
  and nothing matched answers `ready`.
- `refuse_if_transcript_missing`: `unchecked` never refuses.
- The `unknown` status itself: a real answer, never `idle`.
- The uuid matcher: "a matcher that always finds something is worse than
  useless", with a mandatory negative control.
- **GitHub's linkage index.** Measured by ccsliinc on an idle repo with zero
  contention: `gh issue view N --json closedByPullRequestsReferences` returns
  `[]` on the FIRST read every time, and the link appears about twelve
  seconds later. Never a race; wrong on the first call, always.
- **A bare `dist/` in `.gitignore` swallowed `client/dist`** (ccsliinc,
  measured 2026-09-12). A pattern with no leading slash matches at ANY depth,
  so a rule aimed at setuptools output also ignored the vite bundle that
  `scripts/deploy-mini.sh` ships by tar. **Every hash check in the deploy
  still read green, because the file was absent on BOTH sides and absent
  compares equal to absent.** This is the shape one level up from a detector:
  a COMPARISON that cannot tell "equal and present" from "equal and missing".
  Verified in a throwaway `git init`: with `dist/` alone,
  `git check-ignore -v client/dist/app.js` exits 0; with `!client/dist/`
  added, it exits 1. Closed at `b5de919`.
- **`tmux list-sessions` over a non-interactive ssh** (ccsliinc, measured
  2026-09-12 against mac-mini-m4). `ssh host 'cmd'` does not run the login
  profile, so `$PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` and Homebrew's tmux
  is not on it. With stderr suppressed, `command not found` produces empty
  stdout, and code counting lines of output reports **zero sessions** about a
  host running many. `ssh host 'zsh -lc "command -v tmux"'` resolves it to
  `/opt/homebrew/bin/tmux`. An empty result from a remote command has three
  causes - it worked and found nothing, the binary does not exist, the
  connection failed - and they must not collapse into one.

**Do:** three states, not two. Found, measured-absent, could-not-measure.
Collapsing the third into the second is the bug every time.

**And the rule that generalises all ten: A GREEN CHECK MUST FIRST BE WATCHED
GOING RED.** Plant the thing the check exists to catch, watch it fail, then
remove the plant. A check that has never been observed failing is unmeasured,
not proven. This is the same discipline the product already encodes in
`StatusMap.complete`, `InstanceIndex.complete`, the recreate gate's `gone`
versus `unknown`, and `db_integrity`'s `cannot_determine` versus `failed`: a
reading that did not happen is kept apart from a reading of nothing. The
uncomfortable half of the ccsliinc round that produced four of these: two
were in DEPLOY tooling and two were in TEST tooling, because **nothing checks
a checker**.

**Then pick the failure direction from what the consumer is FOR.** There is
no universally safe direction:

- the overlap detector REPORTS on unknown, because missing a collision is the
  whole cost
- the sub-agent notification gate ALERTS on unknown (`0d1a12c`), because a
  missed alert is worse than a spurious one
- the mute gate SUPPRESSES on unknown (`46e7aca`), because the user asked for
  quiet and alerting them on a failed read breaks what they asked for

**For an eventually consistent source, make the read self-checking.** You
know your own write. Validate the response against IT, not against emptiness.
Emptiness is ambiguous; your own record appearing proves the index caught up.
Bounded retry, and on exhaustion report could-not-confirm rather than
concluding success.

## A test that cannot fail is not evidence

**Five occurrences, and three of them were guards that DERIVE what they
assert from the tree they are guarding.**

ccsliinc shipped an attribute rename with a green 200-suite run before and
after, because the test built its own markup and read it back with the same
constant. It was asserting a string equals itself.

I shipped a tie-break command whose `--jq '.[].number'` threw on every call,
populated or empty. It survived a live dry run because the dry run
hand-wrote the correct filter instead of copying the documented one.

**Do:** execute the artefact, not your understanding of it. Copy the command
out of the document verbatim. If a test constructs its input and its
expectation from one source, it proves nothing.

**Every acceptance gate needs a case that must FAIL.** A detector that always
fires passes every positive case and is worthless. The negative control is
the only test that distinguishes a working detector from one that says the
same thing regardless.

**THE VARIANT THAT IS HARDEST TO SEE: a guard that derives its expectation
by scanning the tree, whose SCANNER is narrower than the tree.** Both halves
of the assertion then compare empty to empty and pass in both directions.
Three ccsliinc instances, all measured:

- **A docs drift guard whose grammar could not express its own subject.**
  `tests/test_docs_operations_chart_drift.py` requires every `path::symbol`
  citation in `docs/session-project-operations.md` to resolve, but both its
  regexes matched only the `src|client|tests|macOS` roots and the `.py|.js`
  extensions. Svelte slice 7 deleted `client/js/launchpad.js` and moved those
  actions into `web/src/**/*.ts`. A citation repointed at the new home would
  have stopped matching the citation grammar entirely, **which does not fail,
  it reclassifies the line as ordinary prose.** The guard would have passed
  forever while holding nothing. Same commit, same shape:
  `test_client_called_routes_exist.py` scanned `client/js` only and went
  silent on the entire Svelte client. Fixed in `882073e`, and the fix added
  `test_the_web_src_arm_actually_fires`, which plants a call in a stand-in
  tree and was watched turning the guard red with the arm disabled.
- **A shim scanner blind to how its callers actually reach the shim**
  (`54fe58d`, 2026-09-12). `web/src/lib/launchpad/shim.test.ts` derives the
  required member list by grepping for the literal `window.Launchpad.<member>`
  in `client/js` and nothing else. It reported the shim COMPLETE while five
  callers reached members the shim did not carry, because they went through
  `const lp = ...Launchpad` and, in `project-tree-host.ts`, through a
  `function legacy()` that RETURNS the shim. Every caller guarded its lookup
  with a `typeof` and degraded to `console.error`, so nothing threw and 1342
  passing tests saw none of it. Measured in a real browser against the shipped
  bundle: a refused archive produced a console line and ZERO cards. The
  scanner now resolves aliases to a fixpoint, follows function returns, and
  scans the compiled tree as well as the legacy one; `aliasedUseFinds` names
  the three real files and fails if the resolver stops seeing them.
- **The over-match, which is the same defect wearing the opposite face.**
  The first fix for the above used a FIXED CHARACTER WINDOW: 600 characters
  from `function win` ran straight past that function's body into the
  `function legacy` beneath it, whose return does read `.Launchpad`, so `win`
  was registered as an alias and the scan reported members literally named
  `Launchpad`, `CloudeWeb` and `launchpad`. The body is brace matched instead,
  taking the first balanced block containing a `return`. **The over-match is
  now its own pinned control**, one of four resolver controls in that file,
  because a resolver that finds too much passes the same positive cases as one
  that finds nothing. Computed access (`lp[k]`) is REFUSED rather than chased:
  no static rule can resolve it, so the form is banned while still unused,
  with a test that measures the ban.

## Written down is not read

**Two occurrences, same day, both parties.**

ArgentSI: `berzerker` identifiers are deliberate across 1,196 files.
`docs/NAMING.md` says so. `CLAUDE.md` does not reference it, and `CLAUDE.md`
is the first file every agent loads.

Here: "Cloude" is deliberate across 55 files, covering the tmux socket name,
the app bundle and the config paths. It is documented as deliberate in ZERO
places. And 20 of 23 files in `docs/` are unreferenced from `CLAUDE.md`.

**Do:** measure the read path rather than assuming it.

    for f in docs/*.md; do
      grep -q "$(basename "$f")" CLAUDE.md || echo "ORPHANED $f"
    done

A runbook may be orphaned. **A prohibition may not.** Put the prohibition
inline where the actor reads before acting, and the detail behind a link.

**And the actor is often not a participant.** An agent told to tidy naming
has no reason to read an issue or a coordination branch, will never see a
claim, and can do more damage in one pass than any collision a protocol
prevents.

## Never pipe in a verification step

**Three occurrences, two of them the same day on both sides, every one green
while the thing under test had actually failed.**

I verified an overlap detector with `check <path> | head -3; echo "exit=$?"`.
That reads `head`'s status, not the tool's. A case that correctly returned 2
printed 0, and I nearly went hunting for a second bug that did not exist.

ccsliinc verified that branch protection rejected a push with
`git push 2>&1 | grep -iE "reject|denied" | head -6; echo "exit: $?"`. It
printed the `GH013` rejection AND `exit: 0` on adjacent lines, directly
contradicting each other, and both were published without the contradiction
registering.

**The bare `$?` reports the LAST command in the pipeline, not the one that
failed.** In both incidents that last command was `head`, which reads
whatever it is given and exits 0 regardless of what came before it. Verified
here (zsh 5.9, Darwin 25.5.0):

    zsh -c 'false | true; echo $?'   ->  0

**The third occurrence is the one to show a skeptic, because the command was
not even faintly ambiguous about failing.** ccsliinc, measured 2026-09-12:
macOS ships Apple openrsync ("protocol version 29, rsync 2.6.9 compatible"),
which has no `--no-compress`. Note the summary of this that circulated was
WRONG and is corrected here: rsync did NOT exit 0 and did NOT print to stdout.

    rsync --no-compress /dev/null /tmp/x
      -> exit 1, 0 bytes on stdout, 1392 bytes on STDERR, /tmp/x never created

It failed correctly and loudly. What made the deploy green was the pipeline
wrapped around it, which was there only to keep the log short:

    rsync --no-compress ... 2>&1 | tail -1    -> exit 0
    ( set -o pipefail; same command )          -> exit 1

**The fix is `set -o pipefail`, not a different rsync flag.** Redirecting a
command's stderr into a truncating filter discards the complaint AND the exit
code in one move.

**The standard bash fix, `PIPESTATUS`, does not exist in this shell.**

    zsh -c 'false | true; echo "[${PIPESTATUS[0]}]"'   ->  []
    bash -c 'false | true; echo "[${PIPESTATUS[0]}]"'   ->  [1]

It works in bash, which is why an engineer reaches for it. In zsh the array
is lowercase `pipestatus` and one-indexed instead
(`${pipestatus[1]}` -> `1`, the real status of the first command); the
capitalised bash name silently expands to nothing.

**A plain comparison against that empty value fails loudly, which is
honest:**

    zsh -c 'false | true; [ "${PIPESTATUS[0]}" = "0" ] && echo pass || echo fail'   ->  fail

Empty is not `"0"`, so the test correctly reports failure. Noisy, but right.

**The defensive-looking fix is what turns it silent.** An unset variable
inside a numeric test (`-eq`) is a syntax error, so a careful engineer
reaches for a default:

    zsh -c 'false | true; [ ${PIPESTATUS[0]:-0} -eq 0 ] && echo pass || echo fail'   ->  pass

on a pipeline whose first command actually exited 1. The `:-0` default is
exactly what a careful engineer adds to avoid the syntax error, and it is
exactly what manufactures the wrong answer. Same shape as a date-parsing
helper that returned `True` on an unreadable date (see "Unmeasured is not
absent" above): the defensive branch is the one that picked the reassuring
value instead of reporting that it could not tell.

**Do:** do not try to recover an exit status from a pipeline at all, in any
shell. Every recovery mechanism here has its own distinct failure: the bare
`$?` reads the wrong command, `PIPESTATUS` does not exist in zsh, and
defaulting the missing value manufactures a pass. Redirect the output to a
file and check `$?`, or capture the output into a variable and inspect it
afterwards. There is no correct way to read a status through a pipe, only
less-wrong ones.

## Global tool state is shared state

**One occurrence, both parties, and it was written INTO a protocol.**

`gh`'s active account is global per machine. Three accounts are authenticated
here and the active one could not see this repo, so every API call returned
404 as though the repo did not exist.

ccsliinc's coordination skill instructed every agent to assert its identity
and run `gh auth switch` if wrong. That is not a workaround for the problem,
it IS the problem written down as a standing instruction: each agent yanks
the account out from under every other agent on the box.

**Do:** pass the credential per command instead.

    GH_TOKEN=$(gh auth token --user <account>) gh api ...

`.claude/skills/work/work.sh` walks the authenticated accounts and uses
whichever token can actually reach the repo. Never `gh auth switch` in a
script or a documented procedure: it fixes your session by breaking
everyone else's.

## A probe with no identity in it proves only that something answered

**Two occurrences, one of them deliberately left unexplained.**

A check asks "is it up" when the question it is being trusted to answer is
"is the thing I just deployed up". Those differ whenever anything else can
hold the resource, and during a restart something else always can.

**The measured one (ccsliinc, 2026-09-12).** `scripts/deploy-mini.sh`
restarts the live server with a plain `kill` of the pid holding the port.
`kill` sends SIGTERM and RETURNS IMMEDIATELY. The very next statement is the
up-check loop:

    curl -s -o /dev/null --max-time 2 "http://$HEALTH_HOST:$PORT/"

That succeeds against ANY process answering on that host and port, so for the
window between the SIGTERM and the old process closing its listener, **the
process reporting the deploy healthy is the one being killed.** Verified by
reading the script at `b5de919`, lines 394 to 421; it is the only up-check
there and it is unchanged.

**Do:** ask the server WHICH BUILD it is, not whether it is up. The app
already exposes `GET /api/v1/version`; comparing that, or a deployed-commit
marker, against what was just shipped cannot pass against the outgoing
process. The deploy already applies this discipline to FILES - it re-hashes
the server directory AFTER the restart rather than trusting the pre-restart
hash - and simply never applied it to the PROCESS.

**The second occurrence is recorded as UNRESOLVED, on purpose.** The same
check was reported printing `- up` and exiting 0 while nothing was listening
on the port. **The mechanism for that has NOT been established.** The script
as committed at `b5de919` cannot produce it from a closed port: curl against
a closed TCP port exits 7, the `if` fails, the loop retries, and after 30
attempts `UP=0` takes the `say_failed` branch and exits 1. So either
something other than the freshly deployed server was answering at that moment
- which makes it the entry above rather than a distinct defect - or the
observation came from a different check. **Do not write a mechanism for this
until it has been reproduced.** An invented explanation would be worse than
the gap, because it would close an investigation that has not happened.

**And a refusal that a retry would have cleared is a FALSE red, which is its
own hazard.** `scripts/deploy-restart-check.sh` replaced the up-check and
exited 3 (CANNOT DETERMINE) on its first live use. Legs A, B and C passed;
only leg D, the working directory, failed to read, because it is read ONCE in
the same pass that discovers the pid - the earliest instant in the new
process's life, precisely when `lsof` is most likely to come back empty. By
hand a minute later it resolved immediately. Refusing rather than guessing is
the right instinct; taking the reading at the worst possible moment is not.
The fix is to poll legs D, E and F within the budget already being spent, and
to keep "read and came back empty" apart from "could not read". NOT DONE - do
not "fix" it by dropping leg D or by treating an unresolved cwd as a pass,
which would delete the only leg that catches a server started from the wrong
directory.

## A dated record cannot overturn a later ruling

**ccsliinc, 2026-09-10. One occurrence, recorded early because the blast
radius is unusually wide: it wrote an inversion into `docs/DECISIONS.md`,
which binds both teams, and the other developer was filing against it live.**

A record says what was true ON ITS DATE. Read without its date it reads as a
statement about now, and an OLDER record then silently overturns a NEWER
ruling. **Agreement between several stale sources is not corroboration: if
they all predate the decision, they are one source counted three times.**

Porting settled rulings into `docs/DECISIONS.md`, ccsliinc recorded "the outer
ring means activity and nothing else, unread rides the inner dot". That is the
exact inverse of the shipped behaviour, and it was written that way against an
explicit instruction saying unread rides the OUTER ring. Three records
disagreed with the instruction, so the instruction was overruled:
`settled/ccsliinc.md`, a `TODO.md` entry dated 2026-09-08, and a `CLAUDE.md`.

Every one of those three was real, and every one predated the ruling. The
first two describe the state BEFORE the owner chose; on 2026-09-08 unread
genuinely did ride the inner dot. The `CLAUDE.md` read was worse: it came from
whichever checkout happened to be open, `feat/svelte-web`, a divergent branch
carrying the LOSING model's text. The `CLAUDE.md` on `release/1.2.1` says the
opposite and warns about this exact error in those words.

**What makes it expensive rather than embarrassing: the source that would
have settled it in one command was never consulted.** `status-led.js` on the
branch being worked on says `const OUTER_STATES = ['active', 'steady',
'unread', 'off', 'dim']` and carries a header explaining the ruling. Notes
were read about the code instead of the code.

**Do:**

- **Date every record before you weigh it, and weigh recency before you weigh
  agreement.** The question is never "how many say this", it is "what is the
  newest thing that says anything".
- **Expect the losing branch's description to survive in writing.** Nothing
  rewrites an old note when a decision lands, so a superseded note stays on
  disk looking exactly like a current one.
- **Prefer the artefact to the description of it.** Shipped code, a config
  default, a migration cannot be stale relative to themselves; a document can.
  This is "execute the artefact, not your understanding of it" one level up.
- **Name WHICH REF you read a file from.** In a repo with several long-lived
  branches, `CLAUDE.md` is not one document.
- **`settled/` and `wants/` on `coord` are frozen** at the moment the work
  protocol superseded them. Anything ported out of them needs re-verifying
  against the code. One entry ported clean, one was inverted, and only the
  code told them apart.

## Both lines keep having the same idea

**adoom666, 2026-09-10. Two occurrences in one day, and the rewrite below is
the GitHub-era translation: the original resolution named `coord.py read` and
the `log/` directory, which the work protocol retired.**

Two parties fixed the same class of defect within a day of each other, twice,
neither aware of the other.

- ccsliinc landed `402526f`, "a bulk listing may only vouch for its own
  socket". adoom666 landed `c8ef6a8`, the same correction to the same
  reasoning. Same defect, two repos, same window.
- ccsliinc opened a claim to reseat the session row menu onto a typed plugin
  registry. The same day adoom666 landed `8898f07`, a session row action menu
  built as a hardcoded list. Four claimed paths collided exactly, including a
  test file. Neither side knew until a human forwarded the branch by hand.

**The common factor is not a merge conflict.** In the 2026-09-10 merge only
two files conflicted and both were documentation; every code file merged
clean. The cost was two people doing the same work, and in the row menu case
one of the two implementations had to be thrown away.

**Do, and this is the part that changed when `coord` was superseded:** a
claim tells you what someone INTENDS; merged history tells you what already
EXISTS, and duplicate effort is prevented by the second. Under
`.claude/skills/work/` that means reading **merged** PRs, not only open ones,
before starting:

    gh pr list -R Adoom666/CloudeCodeDev --state merged --limit 30

Then read every issue's **Approach** paragraph, including for issues whose
paths do not intersect yours. The row menu collision WOULD have been caught
by paths; the listing collision would NOT - it was the same idea in two
different files, and only a paragraph would have surfaced it. **A path
overlap tells you that you will both edit the same line. A design overlap
tells you that you are both building the same thing differently, and it
counts exactly the same even when you share no file at all.**

Comparing path lists by eye does not work either: in the row menu case one
side wrote literals and the other wrote globs. The strings look nothing alike
and matched on expansion.

## Two designs, two failure surfaces

Not a defect, a distinction worth keeping.

Our coordination tool extracted paths from issue bodies and computed an
intersection. It can be mechanically wrong, and was: it flattened a body to
one line and then parsed it line-wise, so it reported clean on a real
overlap.

ccsliinc's design never parses bodies at all. It hands the raw JSON to the
agent to read. That class of bug cannot occur there, because there is no
extraction step. It is worse in every other respect: no exit code, no
determinism, and it depends entirely on the agent reading rather than
skimming.

Neither dominates. A mechanical check answers about paths and is silent on a
design contradiction that shares no file; a human read catches the
contradiction and misses the glob. Keep both, and know which question each
one answers.
