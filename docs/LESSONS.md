# Lessons

Defect shapes that have bitten this project more than once, and what to do
instead. Each was re-derived independently by different people or agents who
did not recognise it as a repeat, which is the cost this file exists to stop.

Add one when a pattern REPEATS. Once is an incident; twice is a pattern.
Cite the evidence: commits, dates, measurements. A guess written here reaches
every agent automatically, which makes it worse than nothing.

Longer write-ups of the first four live on the `coord` branch under
`lessons/`, readable with `git show origin/coord:lessons/<file>`. That branch
is superseded and nothing new goes there; new entries go here, because this
file is on the path an agent actually walks.

---

## Unmeasured is not absent

**Seven occurrences across two codebases.**

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

**Do:** three states, not two. Found, measured-absent, could-not-measure.
Collapsing the third into the second is the bug every time.

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

**Two occurrences.**

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

**Two occurrences, same day, both parties, both went green while the thing
under test had actually failed.**

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
