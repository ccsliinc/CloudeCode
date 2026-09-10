"""What agent is ACTUALLY running in a pane the app did not launch one into.

PUNCHLIST 3. A session created with ``auto_start_claude:false`` and then
given a hand-typed ``claude`` command lands with ``sessions.agent_type``
NULL and ``agent_family_source='not_launched'``. Both of those are FACTS
about the LAUNCH - the app really did open a bare shell and really did
start no agent - and the row is right to say so. What the row cannot say
is what the human typed into the pane afterwards, so the session renders
"unknown family" while a claude is plainly running in it. Measured on the
owner's box: 27 of 40 rows.

The rule this module obeys, from the repo CLAUDE.md, verbatim: fixing that
means filling ``agent_type`` FROM EVIDENCE, never defaulting the resolver
to claude. A resolver that always finds something is worse than useless.

THE TRIGGER IS A HOOK; THE EVIDENCE IS THE PROCESS. Only claude fires
Claude Code lifecycle hooks, so a hook arriving for a session is what
makes a process read worth taking at all - it is the cheap signal that
says "there is something here to measure". It is NOT the measurement.
The measurement is the pane's own process tree, because that is the only
thing that can tell ``claude-chrome`` from ``claude-skip-permissions``:
they fire identical hooks and print identical banners, and they differ
only in the flags on the claude command line. A hook that arrives while
the pane's tree contains no claude at all is a contradiction, and this
module writes nothing on a contradiction.

THE ANCHOR GATE, WHICH IS WHY THIS CANNOT ALWAYS FIND SOMETHING. A
wrapper is named ONLY when the observed claude argv carries at least one
distinguishing flag AND exactly one configured claude-family wrapper
passes that same flag set to claude. An argv with no distinguishing flags
(a bare ``claude``) matches every flag-less wrapper equally, so it names
NONE of them and falls to the bare family ``claude`` instead. Empty
agreeing with empty is the absence of evidence, not two facts agreeing -
the same rule ``session_uuid_backfill_rules`` enforces for timing and
title corroboration.

WHY EQUALITY AND NOT SUBSET. A wrapper that passes
``--dangerously-skip-permissions`` and a wrapper that passes
``--dangerously-skip-permissions --chrome`` are different launches, and
subset matching would let the first claim a pane running the second.
Equality over the DISTINGUISHING set (per-run flags removed from both
sides) is what keeps one wrapper from swallowing another's sessions.

WHAT COMES OUT IS A GUESS AND MUST RENDER AS ONE. The value is persisted
with ``agent_family_source='inferred_process'``
(:data:`~src.core.db_models.SESSION_FAMILY_SOURCE_INFERRED_PROCESS`),
which resolves at display time to the dashed pill, never the solid one -
see ``agent_family_display.FAMILY_SOURCE_INFERRED_PROCESS``. It is a
stronger guess than a scrollback fingerprint (a direct read of what the
process was told to do, versus banner text), which is why it may name a
wrapper where a fingerprint may not, and it is still a guess.

AN INFERENCE IS NOT INTENT. Nothing here makes a restart start an agent.
``session_respawn``'s ladder is unchanged and its ``RESPAWN_SHELL`` rung
still fires for a pane tmux recorded no start command for, which is
exactly this population; the restart picker's explicit choice remains the
only thing that overrides it. ``restart_agent_type`` in this module is
what keeps a value written here out of that ladder entirely.

The impure half - the row gate, the tmux/ps reads and the write - lives
in ``session_agent_infer_apply.py``. Everything in this file is pure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import FrozenSet, List, Optional, Sequence, Tuple

from src.core.agent_families import DEFAULT_FAMILY
from src.core.db_models import SESSION_FAMILY_SOURCE_INFERRED_PROCESS

#: Outcome: nothing was measured that could support any claim. WRITE
#: NOTHING. Distinct from :data:`INFER_NOT_CLAUDE` on purpose - "the
#: process table could not be read" is not "no claude is running".
INFER_UNAVAILABLE: str = "unavailable"

#: Outcome: the pane WAS read and no claude process is in it. A
#: measurement, and the negative control this module is judged by: a pane
#: running a plain login shell must land here and write nothing.
INFER_NOT_CLAUDE: str = "not_claude"

#: Outcome: a claude is proven and exactly one configured wrapper's flag
#: set matches the one it is running with. ``agent_type`` is that
#: wrapper's id.
INFER_WRAPPER: str = "wrapper"

#: Outcome: a claude is proven and no single wrapper can be named - the
#: argv carries no distinguishing flag, or zero wrappers match it, or
#: several do. ``agent_type`` is the bare family ``claude``.
INFER_FAMILY: str = "family"

#: Every outcome :func:`resolve_agent_inference` can return. A tuple so a
#: test can assert nothing outside this set ever reaches the writer.
INFER_OUTCOMES: Tuple[str, ...] = (
    INFER_UNAVAILABLE,
    INFER_NOT_CLAUDE,
    INFER_WRAPPER,
    INFER_FAMILY,
)

#: Flags supplied PER RUN rather than by a wrapper, removed from both
#: sides of the comparison so they can neither create a match nor break
#: one. ``--resume`` / ``--fork-session`` / ``--name`` are injected by
#: this app (see ``session_resume_target.resume_extra_args`` and
#: ``CreateSessionRequest.label``); ``--model`` is forwarded as the outer
#: shell's ``$1`` for a model-capable wrapper and belongs to the session,
#: not to the wrapper; ``--continue`` is something a human types.
PER_RUN_FLAGS: FrozenSet[str] = frozenset(
    {"--resume", "--fork-session", "--name", "--model", "--continue"}
)

#: A long option, with or without an ``=value`` tail. Short options are
#: deliberately NOT collected: a single letter is far too weak to
#: distinguish two wrappers and would let noise create matches.
_FLAG_RE = re.compile(r"--[A-Za-z][A-Za-z0-9-]*")

#: Where a claude invocation starts inside a line of wrapper script. The
#: leading boundary keeps ``foo-claude`` and ``$CLAUDE_CODE_OAUTH_TOKEN``
#: from matching, and the optional ``command`` prefix is the exact shape
#: the owner's own ``cld`` uses (``command claude --... "$@"``).
_CLAUDE_INVOCATION_RE = re.compile(r"(?:^|[;&|(`\s])(?:command\s+)?claude\b")

#: The family a wrapper must belong to before its flags are compared
#: against a claude process. A codex wrapper cannot have started the
#: claude binary, so it is never a candidate.
CLAUDE_FAMILY: str = DEFAULT_FAMILY


@dataclass(frozen=True)
class AgentInference:
    """What the ladder concluded, and how strong the claim is.

    Description: read ``outcome`` first. ``agent_type`` is non-None only
      for :data:`INFER_WRAPPER` and :data:`INFER_FAMILY`; for the two
      refusals it is None and NOTHING may be written.
    Inputs (constructor): outcome (str) - one of :data:`INFER_OUTCOMES`.
      agent_type (str | None) - a configured wrapper id, or the bare
      family name ``"claude"``, or None. family_source (str | None) - the
      ``sessions.agent_family_source`` to store alongside it, always
      :data:`~src.core.db_models.SESSION_FAMILY_SOURCE_INFERRED_PROCESS`
      when a value is written. candidates (tuple[str, ...]) - every
      wrapper id whose flags matched, for logging and for a test that
      needs to prove WHY a match was refused rather than only that it
      was. detail (str) - a plain sentence naming the reason.
    Output: an AgentInference instance.
    Example: AgentInference(INFER_FAMILY, "claude", ...).agent_type
    """

    outcome: str
    agent_type: Optional[str] = None
    family_source: Optional[str] = None
    candidates: Tuple[str, ...] = ()
    detail: str = ""


#: The one refusal object for "nothing could be measured". A single
#: instance so no branch can return a subtly different shape of it.
UNAVAILABLE = AgentInference(
    INFER_UNAVAILABLE,
    detail="no process evidence could be read for this pane",
)


def flag_signature(command_line: Optional[str]) -> FrozenSet[str]:
    """The distinguishing long flags on one command line.

    Description: every ``--flag`` in the string, lower-cased, with
      :data:`PER_RUN_FLAGS` removed. An ``=value`` tail is dropped, so
      ``--model=x`` and ``--model x`` reduce to the same token before the
      per-run filter sees either. Returns an EMPTY set both for a command
      with no flags and for one carrying only per-run flags; the caller
      must treat empty as "nothing distinguishing was found", never as a
      match against another empty set.
    Inputs: command_line (str | None) - a full argv line, or a fragment
      of wrapper script starting at a claude invocation.
    Output: frozenset[str] - lower-cased flag tokens including the
      leading ``--``.
    Example: flag_signature("claude --chrome --resume abc")
      -> frozenset({'--chrome'})
    """
    if not command_line:
        return frozenset()
    found = {match.group(0).lower() for match in _FLAG_RE.finditer(command_line)}
    return frozenset(found - PER_RUN_FLAGS)


def wrapper_flag_signature(wrapper) -> FrozenSet[str]:
    """The flags a configured wrapper passes to the claude binary.

    Description: scans the wrapper's ``script`` line by line and collects
      flags ONLY from the part of a line at or after a claude invocation.
      A wrapper script is arbitrary shell - the owner's own ``cld`` reads
      the Keychain and exports two environment variables before it ever
      runs claude - so collecting every ``--flag`` in the file would mix
      another command's options into the signature and let noise create a
      match. A thin wrapper that merely calls a function defined in the
      user's ``~/.zshrc`` (``cld "$@"``) therefore has an EMPTY
      signature, which is correct and honest: this app cannot see inside
      that function, and an empty signature can never name a wrapper.
    Inputs: wrapper - an ``AgentWrapper`` or an AgentWrapper-shaped dict
      (the same dual-type contract ``resolve_family_for_display``
      accepts).
    Output: frozenset[str] - the same shape :func:`flag_signature`
      returns.
    Example: wrapper_flag_signature({"script": "claude --chrome \\"$@\\""})
      -> frozenset({'--chrome'})
    """
    if isinstance(wrapper, dict):
        script = wrapper.get("script")
    else:
        script = getattr(wrapper, "script", None)
    if not script:
        return frozenset()

    flags: set = set()
    for line in str(script).splitlines():
        match = _CLAUDE_INVOCATION_RE.search(line)
        if match is None:
            continue
        flags |= flag_signature(line[match.start():])
    return frozenset(flags)


def _wrapper_id(wrapper) -> Optional[str]:
    """A wrapper's configured id, from either supported shape.

    Inputs: wrapper - AgentWrapper or AgentWrapper-shaped dict.
    Output: str | None - the id, stripped, or None when it has none.
    """
    raw = wrapper.get("id") if isinstance(wrapper, dict) else getattr(wrapper, "id", None)
    text = str(raw).strip() if raw else ""
    return text or None


def _is_claude_family(wrapper) -> bool:
    """Does this wrapper wrap the claude binary?

    Description: a wrapper's ``family`` is explicit and validated (see
      ``agent_wrappers.AgentWrapper``), and a pre-migration wrapper with
      no family recorded falls back to the additive default, which is the
      claude family - the same convention ``resolve_family_for_display``
      applies for its ``derived_deepest`` rung. A codex or shell wrapper
      cannot have started a claude process and is never a candidate.
    Inputs: wrapper - AgentWrapper or AgentWrapper-shaped dict.
    Output: bool.
    """
    if isinstance(wrapper, dict):
        family = wrapper.get("family")
    else:
        family = getattr(wrapper, "family", None)
    name = str(family).strip().lower() if family else ""
    return (name or CLAUDE_FAMILY) == CLAUDE_FAMILY


def matching_wrapper_ids(
    observed: FrozenSet[str], wrappers: Sequence
) -> Tuple[str, ...]:
    """Every claude-family wrapper whose flag set equals the observed one.

    Description: EQUALITY, not containment - see the module docstring for
      why a subset rule would let one wrapper claim another's sessions.
      An empty ``observed`` returns nothing at all, before any wrapper is
      considered: that is the anchor gate, and it is the reason this
      function cannot always find something.
    Inputs: observed (frozenset[str]) - :func:`flag_signature` of the
      claude argv actually running. wrappers (Sequence) - every
      configured wrapper.
    Output: tuple[str, ...] - matching wrapper ids, in config order.
      Empty for no match AND for an unusable observation; the caller
      distinguishes those two by testing ``observed`` itself.
    Example: matching_wrapper_ids(frozenset({'--chrome'}), cfg.wrappers)
      -> ('claude-chrome',)
    """
    if not observed:
        return ()
    matched: List[str] = []
    for wrapper in wrappers or ():
        wid = _wrapper_id(wrapper)
        if not wid or not _is_claude_family(wrapper):
            continue
        if wrapper_flag_signature(wrapper) == observed:
            matched.append(wid)
    return tuple(matched)


def resolve_agent_inference(
    *,
    claude_argv: Optional[str],
    pane_current_command: Optional[str],
    process_table_read: bool,
    wrappers: Sequence,
) -> AgentInference:
    """The whole ladder, pure: what may be claimed about this pane.

    Description: four rungs, refusals first.

      1. ``process_table_read`` False - ``ps`` did not answer, so nothing
         about this pane was measured. :data:`INFER_UNAVAILABLE`, write
         nothing. Not having looked is never evidence of absence.
      2. No claude process in the pane's tree. The pane WAS read, so this
         is a measurement: :data:`INFER_NOT_CLAUDE`, write nothing.
         ``pane_current_command`` may CORROBORATE here - a pane whose own
         foreground command is literally ``claude`` while the tree walk
         found no argv is still a proven claude, and answers
         :data:`INFER_FAMILY` with no wrapper named. It may never CREATE
         a claim: any other value it carries (a version string, a shell
         name) selects no rung at all.
      3. A claude argv, and exactly one configured claude-family wrapper
         passes that same distinguishing flag set: :data:`INFER_WRAPPER`
         with that wrapper's id.
      4. A claude argv with nothing distinguishing on it, or zero
         wrappers matching, or two or more: :data:`INFER_FAMILY` with the
         bare family ``"claude"``. A wrapper id would be a coin flip and
         a refusal would throw away a fact the hook and the process both
         support, so the honest answer is the family without the wrapper.
    Inputs:
      claude_argv (str | None) - the full command line of the claude
        process found in the pane's process tree, or None when the walk
        found none.
      pane_current_command (str | None) - tmux's ``#{pane_current_command}``
        for the pane. Corroboration only.
      process_table_read (bool) - True iff the process table was actually
        snapshotted. False means ``ps`` failed, which is not a finding.
      wrappers (Sequence) - every configured wrapper.
    Output: AgentInference.
    Example:
      resolve_agent_inference(claude_argv='claude --chrome',
          pane_current_command='claude', process_table_read=True,
          wrappers=cfg.wrappers).outcome  # 'wrapper'
    """
    if not process_table_read:
        return UNAVAILABLE

    if not claude_argv:
        current = (pane_current_command or "").strip()
        # CORROBORATION, NEVER CREATION. Only the literal binary name
        # counts. tmux reports a claude VERSION STRING here for most live
        # panes on the owner's box, and a version-shaped string is not
        # proof of anything - matching it would be a rung that fires on
        # noise.
        if current.rsplit("/", 1)[-1].lower() == "claude":
            return AgentInference(
                INFER_FAMILY,
                agent_type=CLAUDE_FAMILY,
                family_source=SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
                detail=(
                    "the pane's own foreground command is claude, but no "
                    "command line was readable, so no wrapper can be named"
                ),
            )
        return AgentInference(
            INFER_NOT_CLAUDE,
            detail=(
                "the process table was read and this pane's tree contains "
                "no claude process"
            ),
        )

    observed = flag_signature(claude_argv)
    matched = matching_wrapper_ids(observed, wrappers)

    if len(matched) == 1:
        return AgentInference(
            INFER_WRAPPER,
            agent_type=matched[0],
            family_source=SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
            candidates=matched,
            detail=(
                f"the running claude passes exactly the flags wrapper "
                f"{matched[0]!r} passes"
            ),
        )

    if not observed:
        why = (
            "the running claude carries no distinguishing flag, so no "
            "wrapper can be told from any other"
        )
    elif not matched:
        why = (
            "the running claude's flags match no configured wrapper, so "
            "only the family can be claimed"
        )
    else:
        why = (
            f"{len(matched)} configured wrappers pass exactly these flags, "
            f"so naming one would be a coin flip"
        )
    return AgentInference(
        INFER_FAMILY,
        agent_type=CLAUDE_FAMILY,
        family_source=SESSION_FAMILY_SOURCE_INFERRED_PROCESS,
        candidates=matched,
        detail=why,
    )


def restart_agent_type(
    agent_type: Optional[str], agent_family_source: Optional[str]
) -> Optional[str]:
    """The ``agent_type`` the RESTART ladder is allowed to read.

    Description: an inference is not intent, and ``session_respawn``'s
      ``RESPAWN_AGENT`` rung re-derives a command through
      ``Settings.get_agent_command`` and runs it. Letting a value this
      module wrote reach that rung would turn a guess about what a pane
      is running into a decision about what to start in it - and would
      silently move an adopted session off ``RESPAWN_REPLAY``, which
      hands tmux back its own recorded command. So a row whose source is
      ``inferred_process`` answers None here: the restart ladder sees
      exactly what it saw before this feature existed, and the picker's
      explicit choice remains the only thing that overrides its gate.
    Inputs: agent_type (str | None) - ``sessions.agent_type``.
      agent_family_source (str | None) - ``sessions.agent_family_source``
      on the SAME row. A None source is treated as not-inferred, because
      only this module ever writes the inferred value.
    Output: str | None - the value, or None when it must not be used.
    Example: restart_agent_type('claude-chrome', 'inferred_process') -> None
    """
    source = (agent_family_source or "").strip()
    if source == SESSION_FAMILY_SOURCE_INFERRED_PROCESS:
        return None
    return agent_type
