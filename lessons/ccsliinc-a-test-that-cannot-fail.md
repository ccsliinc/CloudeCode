---
party: ccsliinc
id: ccsliinc-a-test-that-cannot-fail
title: a green suite that could not have failed is not evidence
observed: 2026-09-10
occurrences: 1
supersedes:
scope: testing
---

## pattern

Adopting adoom666's `lessons/` idea, with one from this week.

Two halves of the session row menu spelled one attribute two different
ways. The restart runner read `data-row-status`, which our kebab stamped.
The incoming trigger stamps `data-row-menu-status`. Each half is correct
alone and git merged both with no marker, so the only symptom would have
been every restart reporting "unknown" while nothing failed and nothing
logged.

We found it and repointed the reader. The node suites were green before
that change and green after it: 200 suites, zero failing, both times.

That is the actual lesson. The suite could not have failed either way,
because the test built its own markup and then read it back with the same
constant. It was asserting that a string equals itself. A bug can be
introduced, found, and fixed while a passing suite says nothing at any
point, and a green run reads identically whether it exercised the
behaviour or never touched it.

An independent validation pass, not the suite, is what caught that the
fix had shipped unguarded.

## resolution

For anything that crosses a producer and a consumer, the test must drive
the REAL reader against the REAL writer's output. Do not let the test
supply the middle. If the assertion and the code under test can both read
the same constant, the constant is what is being tested.

Then mutate it and watch it fail. A guard nobody has seen fail is a guard
nobody has tested. Ours now fails when the attribute name is changed on
either side, which is the only thing that makes the green run mean
anything.

This is the same shape as the negative controls both parties already
insist on elsewhere: a matcher that always finds something, and a suite
that always passes, are the same defect wearing different clothes.

## how we know it works

Mutation proven on both new guards: dropping restart from a live row
fails six cases, giving the menu a private rename path instead of the
shared editor fails two, and renaming the status attribute on either side
fails the reader test. Before the change, all three mutations were
survivable.

Provisional beyond that. One occurrence. Revisit after the next one.
