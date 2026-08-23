"""The evidence ladder: did WE create this tmux session, or did someone else?

Design doc ``docs/session-attribution-import.md``, Stage B. This module is
pure - it reads no disk, runs no tmux, opens no database. Everything it
needs arrives as a :class:`LadderEvidence`, which
``session_import_evidence`` gathers. That split is deliberate: the rules
below are the part that must be auditable, and a rule you can only
exercise by standing up a filesystem does not get exercised.

THREE OUTCOMES, NEVER A DEFAULT. Every live session resolves to OURS,
THEIRS or UNKNOWN. UNKNOWN is not a flavour of THEIRS - the whole defect
this migration corrects is a codebase that turned "we have no record"
into "it belongs to someone else" and badged the user's own work
EXTERNAL. UNKNOWN is further split by REASON, because "we looked and
found nothing" and "we could not look" are different facts:

    REASON_NO_EVIDENCE          every tier was evaluated and none hit
    REASON_COULD_NOT_EVALUATE   at least one tier could not be measured

Both go to the user, but only the second one names a broken measurement.

WHY THERE IS NO PATH TO THEIRS TODAY. Not an omission. Tiers 1, 3 and 4
prove OURS; no admissible tier proves THEIRS, because the only artifact
that ever asserted "external" is tier 2, and tier 2 is inadmissible (see
below). The constant exists so a future admissible THEIRS tier has a name
to return, and :func:`classify` reports the bucket so it can never be
silently folded into another. A test asserts that no current evidence
combination reaches it.

TIER 2 IS INADMISSIBLE AND THIS MODULE ENFORCES IT STRUCTURALLY.
A ``tmux_ext_<name>.pipe`` records the APP'S OWN VERDICT that a session
was external - and that verdict was produced by the bug under
investigation. Reading it as evidence of THEIRS would launder the defect
into the migration built to correct it, and would do so invisibly,
because the file looks like an independent measurement. On the install
this was measured against, the five ``ext_`` pipes map five-for-five onto
the five rows still sitting at ``origin='observed'`` and predate the
database by a day: the DB did not decide those were external, it
inherited a verdict the pre-DB code had already made for the same wrong
reason.

:class:`TierOutcome` REFUSES to be constructed with ``tier=2``. An edit
that "improves" the ladder by trusting ``ext_`` pipes raises instead of
shipping. The one admissible use of an ``ext_`` pipe is the BOTH-PIPES
case - a session with a created pipe AND an ext pipe was created by us
and later re-adopted - and there the proof is the created pipe (tier 3);
the ext pipe only sets :attr:`SessionVerdict.readopted` so the history
can be explained. Never tier 2 alone.

TIERS 5 AND 6 NEVER DECIDE. Name shape and working directory are display
hints that order and annotate the UNKNOWN list. They are produced by
:func:`collect_hints`, whose output is NOT an input to :func:`decide` -
so folding them into the verdict requires changing a signature that a
test pins. Writing tier 5 into ``origin`` would be exactly the invented
verdict this codebase keeps re-learning not to write.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import structlog

logger = structlog.get_logger()

#: Verdicts. Exactly three, and the third is not a flavour of the others.
LADDER_OURS = "ours"
LADDER_THEIRS = "theirs"
LADDER_UNKNOWN = "unknown"

#: Why an UNKNOWN is unknown. The distinction is the point of the split.
REASON_NO_EVIDENCE = "no_admissible_evidence"
REASON_COULD_NOT_EVALUATE = "could_not_evaluate"

#: One tier's result. UNEVALUATED is the third outcome at tier level and
#: propagates upward: a session with any unevaluated tier can never be
#: reported as "we looked and found nothing".
TIER_HIT = "hit"
TIER_MISS = "miss"
TIER_UNEVALUATED = "unevaluated"

#: Tiers that may NEVER appear in a verdict. See the module docstring.
INADMISSIBLE_TIERS: Tuple[int, ...] = (2,)

#: The tmux namespace prefix every session on our socket carries. Kept
#: here rather than imported from tmux_backend so this module stays free
#: of that import graph; a test pins the two together.
SESSION_PREFIX = "cloude_"

#: The app's auto-generated session-name form, ``cloude_ses_<8 hex>``.
#: TIER 5 ONLY - a hint, never a verdict. A user can type this.
AUTO_NAME_RE = re.compile(r"^cloude_ses_[0-9a-f]{8}$")

#: The marker value tier 4 accepts. Anything else is not our stamp.
ORIGIN_MARKER_CREATED = "created"


@dataclass(frozen=True)
class LiveSession:
    """One live tmux session on our socket, as the ladder sees it.

    Inputs (constructor): tmux_name (str). epoch (int | None) -
      ``#{session_created}``; None means the instance cannot be dated,
      which makes tier 4's epoch gate unevaluable rather than passable.
      working_dir (str | None) - tier 6 hint input only.
    Output: a LiveSession instance.
    """

    tmux_name: str
    epoch: Optional[int] = None
    working_dir: Optional[str] = None


@dataclass(frozen=True)
class TierOutcome:
    """What one tier measured, for one session.

    Description: refuses construction for an inadmissible tier. That is
      the structural half of the tier-2 rule - the prose half is in the
      module docstring, and prose does not fail a build.
    Inputs (constructor): tier (int). name (str) - stable token used in
      reasons and in the unevaluated list. result (str) - TIER_HIT,
      TIER_MISS or TIER_UNEVALUATED. detail (str | None) - what was
      measured, or what could not be.
    Output: a TierOutcome instance.
    Raises: ValueError - tier is in INADMISSIBLE_TIERS.
    Example: TierOutcome(tier=1, name='owned_set', result=TIER_HIT)
    """

    tier: int
    name: str
    result: str
    detail: Optional[str] = None

    def __post_init__(self) -> None:
        if self.tier in INADMISSIBLE_TIERS:
            raise ValueError(
                f"tier {self.tier} is INADMISSIBLE and may never appear in a "
                "verdict: it records the app's own verdict, produced by the "
                "bug this import exists to correct. See the module docstring."
            )


@dataclass(frozen=True)
class LadderEvidence:
    """Everything the ladder is allowed to reason from, already gathered.

    Description: every "could not read it" is a None or an explicit
      failure set, NEVER an empty collection - an empty owned set and an
      unreadable one are the exact pair whose collapse causes today's
      bug.
    Inputs (constructor): owned_tmux_names (frozenset | None) - tier 1;
      None means the owned-set file could not be read. created_pipe_slugs
      (frozenset | None) - tier 3; slugs parsed out of
      ``tmux_<slug>.pipe``; None means the log directory could not be
      read. ext_pipe_names (frozenset) - tier 2, recorded for history and
      admissible for nothing. origin_markers (Mapping[str, str]) - tier 4;
      tmux name -> ``CLOUDECODE_ORIGIN`` value actually read.
      origin_probe_failures (frozenset) - names whose env probe could not
      be run. stage_a_boundary_epoch (int | None) - the unix epoch at or
      after which a tier-4 marker is admissible on this install; None
      means CANNOT DETERMINE and makes tier 4 inadmissible.
      project_roots (tuple[str, ...]) - tier 6 hint input only.
    Output: a LadderEvidence instance.
    """

    owned_tmux_names: Optional[frozenset] = None
    created_pipe_slugs: Optional[frozenset] = None
    ext_pipe_names: frozenset = frozenset()
    origin_markers: Mapping[str, str] = field(default_factory=dict)
    origin_probe_failures: frozenset = frozenset()
    stage_a_boundary_epoch: Optional[int] = None
    project_roots: Tuple[str, ...] = ()


@dataclass(frozen=True)
class SessionVerdict:
    """The ladder's answer for one session, with its whole working shown.

    Inputs (constructor): tmux_name (str). epoch (int | None). verdict
      (str) - LADDER_OURS, LADDER_THEIRS or LADDER_UNKNOWN. reason (str) -
      the winning tier's name on OURS, otherwise REASON_NO_EVIDENCE or
      REASON_COULD_NOT_EVALUATE. tiers (tuple[TierOutcome, ...]) - every
      tier evaluated, in order. hints (tuple[str, ...]) - tier 5/6
      sentences, display only. unevaluated (tuple[str, ...]) - names of
      the tiers that could not be measured. readopted (bool) - a created
      pipe AND an ext pipe both exist, so this was ours and later
      re-adopted.
    Output: a SessionVerdict instance.
    """

    tmux_name: str
    epoch: Optional[int]
    verdict: str
    reason: str
    tiers: Tuple[TierOutcome, ...] = ()
    hints: Tuple[str, ...] = ()
    unevaluated: Tuple[str, ...] = ()
    readopted: bool = False

    @property
    def could_not_evaluate(self) -> bool:
        """True when at least one tier could not be measured."""
        return self.reason == REASON_COULD_NOT_EVALUATE

    def as_unattributed_record(self) -> Dict[str, Any]:
        """The ``session_import_unattributed`` record for this session.

        Inputs: none.
        Output: dict with exactly tmux_name, epoch, hints, reason - the
          shape the design doc names, and the shape the prompt renders.
        """
        return {
            "tmux_name": self.tmux_name,
            "epoch": self.epoch,
            "hints": list(self.hints),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class LadderReport:
    """Every verdict from one run, bucketed so no bucket can absorb another.

    Inputs (constructor): verdicts (tuple[SessionVerdict, ...]).
    Output: a LadderReport instance.
    """

    verdicts: Tuple[SessionVerdict, ...] = ()

    @property
    def ours(self) -> List[SessionVerdict]:
        """Sessions tiers 1-4 proved we created."""
        return [v for v in self.verdicts if v.verdict == LADDER_OURS]

    @property
    def theirs(self) -> List[SessionVerdict]:
        """Sessions proved to belong to someone else.

        Description: empty under every current tier, by construction, and
          reported as its own bucket so it can never be silently merged
          into UNKNOWN if an admissible THEIRS tier is ever added.
        """
        return [v for v in self.verdicts if v.verdict == LADDER_THEIRS]

    @property
    def unknown(self) -> List[SessionVerdict]:
        """Everything the ladder could not resolve, both reasons."""
        return [v for v in self.verdicts if v.verdict == LADDER_UNKNOWN]

    @property
    def unknown_no_evidence(self) -> List[SessionVerdict]:
        """We looked at every tier and none of them hit."""
        return [v for v in self.unknown if v.reason == REASON_NO_EVIDENCE]

    @property
    def unknown_unevaluated(self) -> List[SessionVerdict]:
        """We could not look. NEVER folded into the bucket above."""
        return [v for v in self.unknown if v.could_not_evaluate]

    def unattributed_records(self) -> List[Dict[str, Any]]:
        """Records for ``meta.session_import_unattributed``, in order."""
        return [v.as_unattributed_record() for v in self.unknown]


def _tier1_owned_set(
    session: LiveSession, evidence: LadderEvidence
) -> TierOutcome:
    """Tier 1: the persisted owned set names this session.

    Description: our file, in our directory, written by us - not forgeable
      by anything outside the app. An UNREADABLE owned set is UNEVALUATED
      and not a miss, because today's defect is precisely that collapse.
    Inputs: session (LiveSession). evidence (LadderEvidence).
    Output: TierOutcome.
    """
    if evidence.owned_tmux_names is None:
        return TierOutcome(
            tier=1,
            name="owned_set",
            result=TIER_UNEVALUATED,
            detail="the owned-set file could not be read",
        )
    try:
        hit = session.tmux_name in evidence.owned_tmux_names
    except (OSError, ValueError, TypeError) as exc:
        return TierOutcome(
            tier=1,
            name="owned_set",
            result=TIER_UNEVALUATED,
            detail=f"the owned set could not be searched: {exc}",
        )
    return TierOutcome(
        tier=1,
        name="owned_set",
        result=TIER_HIT if hit else TIER_MISS,
        detail="named in the persisted owned set" if hit else "not in the owned set",
    )


def created_pipe_slug_for(tmux_name: str) -> Optional[str]:
    """Map a live tmux name back to the created-pipe slug, or None.

    Description: the created pipe is ``tmux_<slug>.pipe`` where slug is
      the INTERNAL session id, and the tmux name is ``cloude_<slug>``
      ONLY when the app auto-named it. A user-typed name overrides the
      derivation, so no slug can be recovered from it - this returns None
      and the tier misses. That asymmetry is documented in the design doc
      and is the reason some sessions are unrecoverable rather than a gap
      to be papered over with a guess.
    Inputs: tmux_name (str).
    Output: str | None.
    Example: created_pipe_slug_for('cloude_ses_1a2b3c4d')  # 'ses_1a2b3c4d'
    """
    if not tmux_name.startswith(SESSION_PREFIX):
        return None
    slug = tmux_name[len(SESSION_PREFIX):]
    return slug or None


def _tier3_created_pipe(
    session: LiveSession, evidence: LadderEvidence
) -> TierOutcome:
    """Tier 3: a ``tmux_<slug>.pipe`` exists whose slug is this session.

    Description: the app writes that filename ONLY when it created the
      backend, so its presence is a statement about authorship it made
      about itself at creation time - unlike tier 2, which is a statement
      it made about a session it had already misclassified.
    Inputs: session (LiveSession). evidence (LadderEvidence).
    Output: TierOutcome.
    """
    if evidence.created_pipe_slugs is None:
        return TierOutcome(
            tier=3,
            name="created_pipe",
            result=TIER_UNEVALUATED,
            detail="the log directory could not be read",
        )
    slug = created_pipe_slug_for(session.tmux_name)
    if slug is None:
        return TierOutcome(
            tier=3,
            name="created_pipe",
            result=TIER_MISS,
            detail="the name carries no recoverable slug (user-typed name)",
        )
    try:
        hit = slug in evidence.created_pipe_slugs
    except (OSError, ValueError, TypeError) as exc:
        return TierOutcome(
            tier=3,
            name="created_pipe",
            result=TIER_UNEVALUATED,
            detail=f"the pipe set could not be searched: {exc}",
        )
    return TierOutcome(
        tier=3,
        name="created_pipe",
        result=TIER_HIT if hit else TIER_MISS,
        detail=(
            f"tmux_{slug}.pipe exists, which only the create path writes"
            if hit
            else f"no tmux_{slug}.pipe"
        ),
    )


def _tier4_origin_marker(
    session: LiveSession, evidence: LadderEvidence
) -> TierOutcome:
    """Tier 4: the tmux env marker ``CLOUDECODE_ORIGIN``, EPOCH GATED.

    Description: the marker only proves anything on a session created
      AFTER Stage A shipped on this install. On anything older it is
      evidence of nothing and is IGNORED - not trusted, and not quietly
      treated as absent either: the miss says why. When the install's
      Stage-A boundary cannot be determined the tier is UNEVALUATED
      rather than assumed valid.

      A session with NO marker misses regardless of the boundary. There
      is nothing to date, so an unknown boundary is not a failed
      measurement - collapsing that into UNEVALUATED would put every
      session on every pre-Stage-A install into could-not-evaluate and
      drown the real signal.
    Inputs: session (LiveSession). evidence (LadderEvidence).
    Output: TierOutcome.
    """
    name = "origin_marker"
    if session.tmux_name in evidence.origin_probe_failures:
        return TierOutcome(
            tier=4,
            name=name,
            result=TIER_UNEVALUATED,
            detail="the tmux environment could not be read for this session",
        )
    marker = evidence.origin_markers.get(session.tmux_name)
    if marker != ORIGIN_MARKER_CREATED:
        return TierOutcome(
            tier=4,
            name=name,
            result=TIER_MISS,
            detail=(
                "no CLOUDECODE_ORIGIN=created in the session environment"
                if marker is None
                else f"CLOUDECODE_ORIGIN is {marker!r}, not 'created'"
            ),
        )
    if evidence.stage_a_boundary_epoch is None:
        return TierOutcome(
            tier=4,
            name=name,
            result=TIER_UNEVALUATED,
            detail=(
                "a CLOUDECODE_ORIGIN marker is present but this install's "
                "Stage-A boundary is unknown, so the marker cannot be dated "
                "and is INADMISSIBLE rather than assumed valid"
            ),
        )
    if session.epoch is None:
        return TierOutcome(
            tier=4,
            name=name,
            result=TIER_UNEVALUATED,
            detail=(
                "a marker is present but the session has no creation epoch, "
                "so it cannot be placed relative to the Stage-A boundary"
            ),
        )
    if int(session.epoch) < int(evidence.stage_a_boundary_epoch):
        return TierOutcome(
            tier=4,
            name=name,
            result=TIER_MISS,
            detail=(
                f"a marker is present but the session epoch {session.epoch} "
                f"predates this install's Stage-A boundary "
                f"{evidence.stage_a_boundary_epoch}, so it is IGNORED"
            ),
        )
    return TierOutcome(
        tier=4,
        name=name,
        result=TIER_HIT,
        detail="CLOUDECODE_ORIGIN=created, stamped after this install's Stage-A boundary",
    )


#: Admissible tiers, in the order they are evaluated and in the order a
#: hit wins. Tier 2 is absent BY CONSTRUCTION, not by omission.
_ADMISSIBLE_TIERS = (_tier1_owned_set, _tier3_created_pipe, _tier4_origin_marker)


def collect_hints(
    session: LiveSession, evidence: LadderEvidence
) -> Tuple[str, ...]:
    """Tiers 5 and 6, as SENTENCES. Display only, and never a verdict input.

    Description: the prompt spells these out in words rather than folding
      them into a score, so the user can weigh what we actually saw. This
      function's output is deliberately not a parameter of :func:`decide`.
    Inputs: session (LiveSession). evidence (LadderEvidence).
    Output: tuple[str, ...] - possibly empty.
    Example: collect_hints(LiveSession('cloude_ses_deadbeef'), ev)
    """
    hints: List[str] = []
    if AUTO_NAME_RE.match(session.tmux_name):
        hints.append(
            "its name matches the auto-generated form Cloude Code uses "
            "when you do not type one"
        )
    wd = session.working_dir
    if wd:
        for root in evidence.project_roots:
            if wd == root or wd.startswith(root.rstrip("/") + "/"):
                hints.append(f"it is running in your project folder {root}")
                break
    return tuple(hints)


def decide(session: LiveSession, evidence: LadderEvidence) -> SessionVerdict:
    """Run the admissible ladder for one session. OURS, THEIRS or UNKNOWN.

    Description: the whole decision, and the only place a verdict is
      minted. It takes exactly two parameters and one of them is not
      hints - see the module docstring for why that signature is load
      bearing and pinned by a test.

      A HIT ANYWHERE WINS, even when a higher tier could not be measured:
      proof is proof, and an unmeasured tier cannot contradict it. With
      no hit, an unevaluated tier means REASON_COULD_NOT_EVALUATE and
      only a fully-evaluated all-miss means REASON_NO_EVIDENCE.
    Inputs: session (LiveSession). evidence (LadderEvidence).
    Output: SessionVerdict.
    Example: decide(LiveSession('cloude_a'), LadderEvidence()).verdict
    """
    outcomes: List[TierOutcome] = [fn(session, evidence) for fn in _ADMISSIBLE_TIERS]
    hints = collect_hints(session, evidence)
    try:
        readopted = session.tmux_name in evidence.ext_pipe_names
    except (OSError, ValueError, TypeError):
        readopted = False

    hit = next((o for o in outcomes if o.result == TIER_HIT), None)
    unevaluated = tuple(o.name for o in outcomes if o.result == TIER_UNEVALUATED)

    if hit is not None:
        # The ext_ pipe is admissible for EXPLANATION only, and only
        # alongside a created pipe. It never reaches the verdict.
        readopted = readopted and hit.name == "created_pipe"
        return SessionVerdict(
            tmux_name=session.tmux_name,
            epoch=session.epoch,
            verdict=LADDER_OURS,
            reason=hit.name,
            tiers=tuple(outcomes),
            hints=hints,
            unevaluated=unevaluated,
            readopted=readopted,
        )

    return SessionVerdict(
        tmux_name=session.tmux_name,
        epoch=session.epoch,
        verdict=LADDER_UNKNOWN,
        reason=(
            REASON_COULD_NOT_EVALUATE if unevaluated else REASON_NO_EVIDENCE
        ),
        tiers=tuple(outcomes),
        hints=hints,
        unevaluated=unevaluated,
        readopted=False,
    )


def classify(
    sessions: Sequence[LiveSession], evidence: LadderEvidence
) -> LadderReport:
    """Run the ladder over every live session and bucket the results.

    Inputs: sessions (Sequence[LiveSession]). evidence (LadderEvidence).
    Output: LadderReport.
    Example: classify([LiveSession('cloude_a')], LadderEvidence()).unknown
    """
    verdicts = tuple(decide(s, evidence) for s in sessions)
    report = LadderReport(verdicts=verdicts)
    logger.info(
        "session_import_ladder_classified",
        total=len(verdicts),
        ours=len(report.ours),
        theirs=len(report.theirs),
        unknown_no_evidence=len(report.unknown_no_evidence),
        unknown_could_not_evaluate=len(report.unknown_unevaluated),
    )
    return report
