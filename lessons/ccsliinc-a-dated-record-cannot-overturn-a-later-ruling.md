---
party: ccsliinc
id: ccsliinc-a-dated-record-cannot-overturn-a-later-ruling
title: three agreeing sources were all older than the decision they contradicted
observed: 2026-09-10
occurrences: 1
supersedes:
scope: workflow
---

## pattern

A record says what was true ON ITS DATE. Read without its date it reads as a
statement about now, and an OLDER record then silently overturns a NEWER
ruling. Agreement between several stale sources is not corroboration: if they
all predate the decision, they are one source counted three times.

**The instance.** Porting settled rulings into `docs/DECISIONS.md`, which binds
both teams, ccsliinc recorded "the outer ring means activity and nothing else,
unread rides the inner dot". That is the exact inverse of the shipped behaviour.

It was recorded that way ON PURPOSE and against an explicit instruction. The
task said "unread rides the OUTER ring as a still green ring (2026-09-09, chose
his model over ours)" and also said to verify each ruling from the records
rather than trust the summary. Three records disagreed with it:
`settled/ccsliinc.md`, a `TODO.md` entry dated 2026-09-08, and a `CLAUDE.md`.
Three independent sources against one summary looked decisive, so the summary
was overruled and the inversion was written into the binding file and pushed.

Every one of those three was real, and every one predated the ruling.

- `settled/ccsliinc.md` and the 2026-09-08 `TODO.md` entry describe the state
  BEFORE the owner chose. On 2026-09-08 unread genuinely did ride the inner dot.
- The `CLAUDE.md` read was worse: it came from the checkout that happened to be
  open, `feat/svelte-web`, a divergent branch carrying the losing model's text.
  The `CLAUDE.md` on `release/1.2.1` says the opposite and warns about this
  exact error in those words: "Anything in this file or in
  `docs/session-status.md` that reads as though unread lives on the inner dot is
  describing the branch that lost; fix it rather than working around it."

The ruling itself was 2026-09-09: both lines fixed one report in opposite ways
within hours, the owner was shown both and answered "1. his".

**The thing that makes this expensive rather than embarrassing:** the source
that would have settled it in one command was never consulted. `status-led.js`
on the branch being worked on says `const OUTER_STATES = ['active', 'steady',
'unread', 'off', 'dim']` and carries a header explaining the ruling. Notes were
read about the code instead of the code.

## resolution

**Date every record before you weigh it, and weigh recency before you weigh
agreement.** Two stale sources agreeing say nothing that one stale source does
not. The question is never "how many say this", it is "what is the newest thing
that says anything".

**A ruling has a direction in time. Notes do not automatically follow it.**
Nothing rewrites `settled/` or an old `TODO.md` entry when a decision lands, so
a superseded note stays on disk looking exactly like a current one. Expect the
losing branch's description to survive in writing.

**Prefer the artefact to the description of it.** Shipped code, a config
default, a migration - these cannot be stale relative to themselves. A document
can. This is the same rule as "execute the artefact, not your understanding of
it" from `adoom666-test-the-documented-command`, one level up: read the
artefact, not the note about the artefact.

**Check WHICH CHECKOUT a file came from.** In a repo with several long-lived
branches, `CLAUDE.md` is not one document. Reading it from whichever worktree
was already open is how the losing branch's text got cited as authority. Name
the ref you read it from.

**And a specific one for this project: `settled/` and `wants/` on the `coord`
branch are frozen at the moment the work protocol superseded them.** Anything
ported out of them needs re-verifying against the code before it is written into
`docs/DECISIONS.md`, which binds both teams. One entry ported clean, one was
inverted, and only the code told them apart.

## how we know it works

It does not yet; one occurrence, and the fix is a habit. Recorded now rather
than at two because the blast radius is unusually wide for a documentation
error: `docs/DECISIONS.md` binds both parties and the other developer was filing
against it live, so a wrong entry there does not sit quietly, it gets built on.

Worth revisiting with a mechanism if it recurs. A cheap one exists: every entry
in `docs/DECISIONS.md` already carries a date, so an entry whose claim can be
expressed as a grep against shipped code could carry that grep beside it.
