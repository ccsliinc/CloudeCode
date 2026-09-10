/**
 * The agent-family pill: a THREE-OUTCOME rule about what is running in a
 * pane, and a rule about how sure we are.
 *
 * `agentFamily` is the resolved family name, or null when
 * `resolve_family_for_display` (src/core/agent_families.py) could not
 * determine it - NEVER a collapsed guess of "claude". A null family
 * renders literally as "unknown family", never as any family name, and
 * never silently as nothing.
 *
 * A GUESS AND A FACT MUST NOT LOOK IDENTICAL. A source of `fingerprint`,
 * `inferred_process` or `derived_deepest` means the value was REACHED BY
 * INFERENCE - a scrollback heuristic, a read of the pane's own process,
 * or an extra hop past a wrapper with no recorded family - rather than
 * read off a stored choice (`wrapper`, `reserved_name`). Those render
 * `family-pill--guess` (dashed) instead of `family-pill--fact` (solid),
 * so the two are distinguishable AT A GLANCE and not only in a title
 * attribute somebody has to hover to find.
 *
 * `inferred_process` KEEPS ITS OWN SENTENCE. It is a SIXTH family source
 * and the STRONGEST of the guesses - it is the one guess allowed to name
 * a wrapper, because a process read can tell `claude-chrome` from
 * `claude-skip-permissions` where a fingerprint cannot. It is still a
 * guess, so it paints dashed like the others; what it does not share is
 * the "guessed from session output" wording, which would be false.
 *
 * SLICE 4 PORTS IT BECAUSE THE TREE ROW DRAWS ONE. The legacy
 * `_renderFamilyPillHtml` returns an HTML string and there is no
 * `{@html}` anywhere in this migration, so the pill had to become a
 * component. Slice 5 deletes the legacy copy when the running-sessions
 * row follows; until then the two exist side by side and
 * ./agent-family-pill.test.ts holds them to the same verdicts.
 *
 * PURE. The copy lives in the catalog; this names keys.
 */

/** Catalog keys this pill can render. */
export const FAMILY_PILL_KEYS = {
    /** The LABEL when no family could be determined. Never a family name. */
    unknownLabel: 'session.agent.family.unknown',
    /** Hover for a stored choice: this is a recorded fact. */
    titleFact: 'session.agent.family.title.fact',
    /** Hover for a scrollback or wrapper-hop inference. */
    titleGuess: 'session.agent.family.title.guess',
    /** Hover for a read of the pane's own process. Its own sentence. */
    titleInferredProcess: 'session.agent.family.title.inferred_process',
    /** Hover when nothing could name the family at all. */
    titleUnknown: 'session.agent.family.title.unknown',
} as const;

/** The three visual kinds. Never two: a guess is not a fact. */
export type FamilyPillKind = 'fact' | 'guess' | 'unknown';

/** One pill, as the component reads it. */
export interface FamilyPillView {
    kind: FamilyPillKind;
    /** The class the stylesheet targets. Unchanged from the legacy markup. */
    className: string;
    /** The raw source token, which rides on `data-family-source`. */
    source: string;
    /**
     * The family name, or null when unknown. A null here is what makes
     * the component render `unknownLabel` instead - it never falls back
     * to a family name, which is the whole point of the third outcome.
     */
    label: string | null;
    /** The catalog key for the hover explanation. */
    titleKey: string;
    /**
     * Parameters for `titleKey`. Carries `family` for the fact case and
     * `source` for the guess case, because those sentences name them.
     */
    titleParams: Record<string, string>;
}

/** The three sources that mean the value was inferred, not recorded. */
const GUESS_SOURCES = new Set(['fingerprint', 'derived_deepest', 'inferred_process']);

/**
 * Decide what one family pill says and how sure it looks.
 *
 * Description: `known` requires BOTH a family name AND a source that is
 *   not `unknown`. A name with an `unknown` source is not a fact anybody
 *   recorded, so it paints as unknown rather than as a quiet fact - the
 *   asymmetry is deliberate and is ported verbatim.
 * Inputs: agentFamily - the resolved name, or null.
 *   agentFamilySource - one of wrapper, reserved_name, fingerprint,
 *     inferred_process, derived_deepest, unknown.
 * Output: FamilyPillView.
 * Example: familyPillView('codex', 'wrapper')
 *   // {kind: 'fact', label: 'codex', titleKey: '...title.fact'}
 */
export function familyPillView(
    agentFamily: string | null | undefined,
    agentFamilySource: string | null | undefined,
): FamilyPillView {
    const source = agentFamilySource || 'unknown';
    const isGuess = GUESS_SOURCES.has(source);
    const known = !!agentFamily && source !== 'unknown';

    if (!known) {
        return {
            kind: 'unknown',
            className: 'family-pill--unknown',
            source,
            label: null,
            titleKey: FAMILY_PILL_KEYS.titleUnknown,
            titleParams: {},
        };
    }
    if (isGuess) {
        return {
            kind: 'guess',
            className: 'family-pill--guess',
            source,
            label: agentFamily as string,
            titleKey: source === 'inferred_process'
                ? FAMILY_PILL_KEYS.titleInferredProcess
                : FAMILY_PILL_KEYS.titleGuess,
            titleParams: { source },
        };
    }
    return {
        kind: 'fact',
        className: 'family-pill--fact',
        source,
        label: agentFamily as string,
        titleKey: FAMILY_PILL_KEYS.titleFact,
        titleParams: { family: agentFamily as string },
    };
}
