"""
What ONE ``GET /config-files/tree`` request is asking for - the pure rules,
with no filesystem and no HTTP in them.

The endpoint answers two shapes of question with one handler: "give me the
whole tree for this root" (what it has always done, and what a client that
sends neither new parameter still gets, byte for byte) and "give me just
this directory's next level, because the user just expanded it". Deciding
which is which is a small set of rules with real edge cases in it, so it
lives here as a total function over the two query parameters rather than as
branching inside the route.

WHY THE FULL TREE IS THE DEFAULT, AND MUST STAY THE DEFAULT. The server half
of this change ships and is verifiable before the client half exists, and an
older client - a phone with a cached page, a browser tab open since before
the deploy - keeps working with no negotiation, because it sends no ``depth``
and therefore selects exactly the previous behaviour. A new parameter that
changes what an omitted parameter means is not an additive change.

VALIDATION RAISES ``ValueError``, WHICH THE ROUTE TRANSLATES TO 400. That is
deliberate and it preserves this endpoint's three-outcome error contract: a
malformed request is 400 ("you asked wrongly"), a root that exists but could
not be enumerated is 503 ("I could not evaluate this"), and a successful read
of an empty directory is 200 with an empty list ("there is genuinely nothing
here"). Folding a bad ``depth`` into the 503 branch, or letting it reach the
filesystem and surface as something else, would blur the one distinction this
endpoint's client relies on to decide whether to show an error row or show
nothing at all.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from src.core.config_files_constants import TREE_MAX_DEPTH

# The number of LEVELS of nodes a full-tree request returns. Derived from the
# recursion cap rather than written out again: a root's direct children sit at
# depth 0, so a cap of N permits N + 1 levels. Two literals here would let a
# shallow request and a full request disagree about how deep the tree goes.
FULL_TREE_LEVELS = TREE_MAX_DEPTH + 1


@dataclass(frozen=True)
class TreeRequest:
    """One resolved tree request.

    Inputs (fields):
      rel_path (str) - the directory to list, relative to the root, "" for
        the root itself. Never None, so callers need no second check.
      levels (int) - how many levels of nodes to return, always >= 1.
      shallow (bool) - True when the caller asked for a bounded depth.
        Reporting-only: ``rel_path`` and ``levels`` fully determine what is
        read. It exists so a log line or a test can say which shape of
        request was served without re-deriving it from the numbers.
    """
    rel_path: str
    levels: int
    shallow: bool


def plan_tree_request(path: Optional[str], depth: Optional[int]) -> TreeRequest:
    """
    Description: turn the two optional query parameters into the one
      directory to read and the one depth to read it to.
    Inputs:
      path (str|None) - directory to list, relative to the root. None or
        "" means the root itself, which is the only thing a pre-existing
        client ever asks for.
      depth (int|None) - how many levels to return. None means the full
        tree, which is what every request made before this parameter
        existed is asking for.
    Output: TreeRequest.
    Raises: ValueError - ``depth`` is below 1 or above FULL_TREE_LEVELS.
      The route translates this to HTTP 400; see the module docstring for
      why it must not become a 503.
    Example: plan_tree_request("hooks", 1)
      -> TreeRequest(rel_path="hooks", levels=1, shallow=True)
    """
    if depth is not None:
        if depth < 1:
            raise ValueError("depth must be at least 1")
        if depth > FULL_TREE_LEVELS:
            raise ValueError(f"depth must be at most {FULL_TREE_LEVELS}")

    # A path with no depth is still a legitimate request - "give me
    # everything under this directory" - so it takes the full depth rather
    # than being quietly treated as shallow. Only an explicit depth bounds
    # the read, which keeps "what did the caller actually ask for" readable
    # from the parameters alone.
    return TreeRequest(
        rel_path=(path or ""),
        levels=(FULL_TREE_LEVELS if depth is None else depth),
        shallow=depth is not None,
    )
