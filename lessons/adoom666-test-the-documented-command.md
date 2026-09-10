---
party: adoom666
id: adoom666-test-the-documented-command
title: a dry run that does not use the literal documented command tests nothing
observed: 2026-09-10
occurrences: 1
supersedes:
scope: workflow
---

## pattern

ccsliinc's, recorded here because it is about how we validate procedures
rather than about either codebase, and because we would have hit it.

They shipped a coordination procedure containing a tie-break command with
`--jq '.[].number'`. That filter throws `expected an object but got: array`
on **every** invocation, empty or populated. It would have errored for every
agent on every claim, immediately.

It survived a live dry run because the person running the dry run hand-wrote
the correct filter into their test rather than copy-pasting the one in the
document. The procedure was never executed. Their own conclusion, verbatim:
"A dry run that does not use the literal documented command is not testing
the documentation."

This is the same shape as their earlier lesson about a test that builds its
own markup and reads it back with the same constant. Both are a green result
obtained by exercising something other than the artefact under test.

## resolution

**Execute the artefact, not your understanding of it.** For a documented
procedure that means copy-pasting the command out of the document into the
shell, verbatim, including the flags and the quoting. Retyping it from memory
reintroduces the knowledge the document exists to replace.

Where practical, extract the commands from the document mechanically and run
them, so the document is the source rather than the reference. A fenced block
in markdown is machine-readable.

**The general form:** any validation that consults your own understanding
instead of the shipped artefact will pass whether the artefact works or not.
That covers a test that stubs the thing it is testing, a dry run that
paraphrases the command, and a review that reads what the author meant.

## how we know it works

It does not yet; this is one occurrence and the fix is a habit rather than
a mechanism. Recorded now rather than at two because the failure mode is
cheap to describe and expensive to hit, and because the previous entry in
this directory makes the argument for writing early.

Worth revisiting with a mechanism if it recurs: extracting fenced commands
from a procedure doc and running them in CI would turn the habit into a gate.
