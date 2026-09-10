#!/usr/bin/env bash
#
# coord.sh - RETIRED 2026-09-10. The coordination protocol has one tool now and
# it is not this one.
#
# This file used to be 727 lines of git plumbing for the `coord` branch. adoom666
# built a Claude Code SKILL for the same protocol, we evaluated the two on merit,
# his won as the thing an agent actually reaches for, and shipping both would
# have been the dual-path problem this project keeps paying for.
#
# The four capabilities this script had and his did not were PORTED, not lost:
# the wants-versus-claim kept-behaviour warning, the forbidden-remote refusal,
# the explicit secret scan on the orphan branch, and the worktree lock. See the
# "what ccsliinc added" section at the bottom of .claude/skills/coord/SKILL.md.
#
# THIS STUB CARRIES NO LOGIC ON PURPOSE. A forwarder would have to map nine old
# subcommands onto five new ones, which is a third thing to maintain and a third
# thing to go stale. This only tells you where the tool went.
#
#   old                          new
#   coord.sh status              python3 .claude/skills/coord/coord.py read
#   coord.sh status (overlap)    python3 .claude/skills/coord/coord.py check PATH...
#   coord.sh now                 ... coord.py write now      < body
#   coord.sh claim --slug S      ... coord.py write claim S  < body
#   coord.sh log                 ... coord.py write log      < body
#   coord.sh note --slug S       ... coord.py write note S   < body
#   coord.sh settled             ... coord.py write settled  < body
#   coord.sh wants               ... coord.py write wants    < body
#   coord.sh sync                ... coord.py sync
#   coord.sh init                no longer needed; `write` creates the checkout
#   (new)                        ... coord.py lessons
#
# The claim, lesson and wants file formats are documented in SKILL.md. `write`
# takes the whole file body on stdin, so the header is composed by the caller.
#
# Exits 3, cannot determine, because it did not do what you asked.

cat >&2 <<'MSG'
scripts/coord.sh is retired. the coordination protocol is a skill now:

  python3 .claude/skills/coord/coord.py read
  python3 .claude/skills/coord/coord.py check <paths you are about to touch>
  python3 .claude/skills/coord/coord.py write <kind> [slug] < body
  python3 .claude/skills/coord/coord.py lessons
  python3 .claude/skills/coord/coord.py sync

the old-to-new subcommand map is in the comments at the top of this file.
the protocol itself is .claude/skills/coord/SKILL.md.
MSG
exit 3
