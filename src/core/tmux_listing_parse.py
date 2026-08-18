"""Parsing one ``tmux list-sessions`` row, and deciding whether it is OURS.

Split out of src/core/tmux_backend.py for two reasons. The obvious one is
that the backend is 76K and already does too much. The load-bearing one is
that BOTH decisions in this file used to be made on a caller-controlled
string, inline, with no way to unit-test them without shelling out to
tmux - so neither was ever tested against a hostile input.

THE DELIMITER PROBLEM, AND WHY THE FIELD ORDER IS THE FIX.

The old format string was::

    #{session_name}|#{session_created}|#{session_windows}

parsed with ``line.split("|")`` taking fields 0, 1 and 2. tmux forbids
only ``.`` and ``:`` in a session name; ``|`` is legal. So a session
named ``victim|1755000000|1`` prints::

    victim|1755000000|1|1787070480|1

and fields 0, 1, 2 read back as name ``victim``, created ``1755000000``,
windows ``1`` - an instance triple the CALLER chose, not one tmux
reported. Both halves of the app's identity key were forgeable, and no
attacker was required: a project named ``api|prod`` does it by accident.

THE FIX IS STRUCTURAL, NOT A BLOCKLIST. Two properties together:

  1. THE VARIABLE-LENGTH FIELD GOES LAST. The format is now
     ``#{session_id}|#{session_created}|#{session_windows}|#{session_name}``
     and the row is split with ``split("|", 3)`` - a BOUNDED split. It
     stops after the third separator, so everything remaining, pipes and
     all, is the name, verbatim. The name can no longer reach the parser
     as more than one field, because the parser stops counting before it
     gets there.

  2. THE THREE LEADING FIELDS ARE TMUX-GENERATED AND STRICTLY VALIDATED.
     ``session_id`` is ``$`` followed by digits, ``session_created`` and
     ``session_windows`` are decimal integers. None of them can contain a
     ``|`` because tmux generates all three; none is caller-influenced in
     any way. Each is matched against an anchored pattern, and a row
     whose leading fields do not match is REJECTED, not guessed at.

Property 1 alone makes the name unforgeable. Property 2 is what makes the
rejection honest: it is the only reason a malformed row can be told apart
from a valid one, and it is also what would catch a wrapped or truncated
line, since a continuation could not begin with ``$<digits>|``.

WHY ``session_id`` IS A DISCRIMINATOR AND NOT THE IDENTITY. tmux's
``#{session_id}`` (``$0``, ``$1``, ...) is unique per SERVER LIFETIME and
is never reused while that server lives, which makes it strictly better
than a one-second timestamp at telling two sessions apart RIGHT NOW. It
is strictly WORSE as a durable key, because the counter restarts at
``$0`` when the server does - so ``$3`` today and ``$3`` after a reboot
are different sessions with the same id. The stored identity therefore
stays the instance triple (socket, name, created epoch), which survives a
restart, and ``session_id`` is carried alongside it as a discriminator
that can only ever REFUSE a match, never widen one. See
src/core/session_identity.py for where that refusal is enforced.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Set, Tuple

import structlog

logger = structlog.get_logger()

#: The tmux ``-F`` format this module parses. The caller-controlled field
#: is LAST, which is what makes the bounded split below unambiguous.
#: Changing this string without changing :func:`parse_listing_row` in the
#: same edit is a parse the format no longer describes, so
#: tests/test_tmux_listing_parse.py asserts the two agree.
LISTING_FORMAT = "#{session_id}|#{session_created}|#{session_windows}|#{session_name}"

#: The delimiter. Present in exactly one place so the format string and
#: the split cannot drift apart.
FIELD_SEPARATOR = "|"

#: Number of separators to consume before the remainder is the name. One
#: fewer than the field count, by definition of ``str.split(sep, maxsplit)``.
_MAXSPLIT = 3

#: ``#{session_id}`` is tmux-generated: a literal ``$`` and a decimal
#: counter. Anchored, so nothing else is accepted as one.
_SESSION_ID_RE = re.compile(r"^\$\d+$")

#: ``#{session_created}`` and ``#{session_windows}`` are decimal integers.
_INTEGER_RE = re.compile(r"^\d+$")


def parse_listing_row(line: str) -> Optional[Dict[str, Any]]:
    """Parse one ``tmux list-sessions`` line into a row, or reject it.

    Description: the bounded-split parser described in the module
      docstring. Returns None rather than a partially-trusted row for any
      line it cannot fully validate, which is the three-outcome rule
      applied to a parser: parsed, absent, and NEVER a guess. A rejected
      row is logged by the caller, not silently dropped here, so that a
      format change shows up as rows going missing WITH a log line rather
      than as a quietly shorter list.
    Inputs:
        line (str): one line of ``tmux -F LISTING_FORMAT`` output, with
            or without its line terminator. Untrusted: the trailing
            name field may contain the separator, spaces, unicode, or
            anything else tmux permits in a session name.
    Output:
        dict | None: ``{"session_id": str, "created_at_epoch": int,
            "window_count": int, "name": str}`` when every leading field
            validated and the name is non-empty; None otherwise.
    Example:
        >>> parse_listing_row("$3|1755000000|2|api|prod")["name"]
        'api|prod'
        >>> parse_listing_row("garbage") is None
        True
    """
    # Only the LINE TERMINATOR is stripped, not all whitespace: tmux
    # permits leading and trailing spaces in a session name, and this
    # parser must return the name tmux actually holds. Rejecting the row
    # for an empty remainder is handled by the name check below.
    stripped = (line or "").rstrip("\r\n")
    if not stripped.strip():
        return None

    parts = stripped.split(FIELD_SEPARATOR, _MAXSPLIT)
    if len(parts) != _MAXSPLIT + 1:
        return None

    session_id, created_raw, windows_raw, name = parts

    # Every leading field is tmux-generated. A value that does not match
    # its anchored pattern means we are not looking at the format we
    # asked for, and the safe response is to refuse the whole row.
    if not _SESSION_ID_RE.match(session_id):
        return None
    if not _INTEGER_RE.match(created_raw):
        return None
    if not _INTEGER_RE.match(windows_raw):
        return None
    if not name:
        return None

    return {
        "session_id": session_id,
        "created_at_epoch": int(created_raw),
        "window_count": int(windows_raw),
        "name": name,
    }


def resolve_ownership(
    name: str,
    created_at_epoch: int,
    owned_instances: Optional[Set[Tuple[str, int]]],
    owned_names: Optional[Set[str]],
    prefix: str = "",
) -> bool:
    """Decide whether one live tmux session was created by this app.

    Description: the ownership badge, in one place, with an explicit
      precedence order. The tier that matters is the SECOND one, and it
      is what closes the wildcard hole.

      1. INSTANCE MATCH. ``(name, epoch)`` is in ``owned_instances``.
         This is an identity match and it is the only positive answer
         backed by evidence about THIS process.

      2. NEGATIVE DB OPINION. The name appears in ``owned_instances``
         under a DIFFERENT epoch. The datastore has a specific,
         epoch-keyed opinion about this name and THIS INSTANCE IS NOT
         IT - so the answer is False and the lower tiers are never
         consulted. Previously the legacy name set was folded into
         ``owned_instances`` as a ``(name, None)`` wildcard which matched
         here instead, which meant the epoch was ignored for every
         session the app had created since the last restart - exactly the
         sessions the epoch was added to protect. A dead ``cloude_work``
         replaced by the user's own unrelated ``cloude_work`` badged as
         ours.

      3. LEGACY NAME SET. The datastore has no opinion about this name at
         all, and the in-memory ``owned_tmux_sessions`` holds it. This is
         a DEGRADED, name-only tier and it is lossy in the documented
         way: a name owned as one instance and now reused by a different
         one reads as owned. It is reached only when the DB is silent
         about the name, so it cannot override tier 2.

      4. PREFIX HEURISTIC. Only when neither owned argument was supplied
         at all. Spoofable, and the live app path should always pass an
         owned set.
    Inputs:
        name (str): the tmux session name, as parsed.
        created_at_epoch (int): ``#{session_created}``.
        owned_instances (set[tuple[str, int]] | None): ``(name, epoch)``
            pairs from ``sessions.origin``. None means the datastore had
            NO opinion (pre-v2, unreadable); an EMPTY SET is a real
            answer of "the app owns nothing" and is not the same thing.
            Entries must carry an integer epoch; a None epoch is not a
            wildcard and is ignored.
        owned_names (set[str] | None): the legacy in-memory name set.
        prefix (str): session-name prefix for the tier-4 heuristic.
    Output:
        bool: True when this instance badges as OURS.
    Example:
        >>> resolve_ownership("a", 2, {("a", 1)}, {"a"})
        False
    """
    if owned_instances is not None:
        if (name, created_at_epoch) in owned_instances:
            return True
        # Tier 2. Any stored instance for this name is a specific opinion
        # keyed on an epoch, and this instance did not match it.
        if any(
            owned_name == name and owned_epoch is not None
            for owned_name, owned_epoch in owned_instances
        ):
            return False

    if owned_names is not None:
        return name in owned_names

    if owned_instances is not None:
        # An owned-instance set was supplied and had nothing to say about
        # this name. That is a real answer, not a reason to guess.
        return False

    return bool(prefix) and name.startswith(prefix)
