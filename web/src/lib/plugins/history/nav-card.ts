/**
 * THE PROJECT CARD'S RULES: the two counts, and the presentation overlay.
 *
 * THE TWO COUNTS ARE NOT TWO NUMBERS. THEY ARE ONE SENTENCE. The rail
 * used to render `transcript_count` and call it the project's size. It
 * is not: 19,588 of 21,039 transcripts corpus-wide (93.1 percent,
 * measured 2026-08-31) are AGENT SIDECHAIN files written by subagents,
 * not conversations anybody had. So a card read "718" while the
 * transcript list beside it showed 27 for the same project. Two numbers
 * that disagreed, side by side, with nothing explaining why. The card
 * renders ONE SENTENCE instead:
 *
 *     27 sessions   of 718 total
 *
 * The word `of` does the whole job: it makes the total read as the SET
 * THE SESSIONS ARE DRAWN FROM rather than as a competing measure of the
 * same thing. THE TWO ARE NEVER DISTINGUISHED BY COLOUR ALONE - they
 * carry different NOUNS and the connective sits between them - because
 * three themes zero every radius token and a fourth may flatten the
 * accent.
 *
 * THE SESSION COUNT MAY BE ABSENT, AND THE CARD SAYS SO RATHER THAN
 * SUBSTITUTING THE ONE THAT IS THERE. Three outcomes, not two: measured,
 * never reported, and reported-as-unmeasurable. The last two both render
 * NOT KNOWN - a person cannot act differently on them - but they carry
 * different `data-session-state` values and different tooltips, so the
 * distinction survives into anything that inspects it. A substituted
 * number is a verdict nobody measured.
 *
 * THE OVERLAY ARRIVES ON THE ROW, not from a client-side store.
 * `GET /api/v1/archive/overlay/projects` returns the merged nodes with
 * `display_name` ALREADY overridden, the archive's own derived name
 * preserved as `archive_display_name`, and an `overlay` block carrying
 * {status, group, hidden, applied}. Nothing here invents that storage
 * and nothing here writes it.
 *
 * Ported from the pure half of client/js/archive-nav-card.js.
 */
import { NODE_KINDS } from './nav-vocab';
import { appNameFor, scratchFaceFor, type AppName } from './nav-app-name';
import { countFor, labelFor, renderCount, type NavRowData } from './nav-row';
import { NOT_KNOWN } from './format';

/**
 * The field names a merged project node may carry its OWN-SESSION count
 * under, strongest first. THE ONE PLACE a server field name for that
 * count lands, so wiring the server up is an edit to this array and to
 * nothing else.
 *
 * `session_count` is the canonical name. `session_transcript_count` is
 * accepted as an alias only because it follows the existing
 * `transcript_count` / `unattributed_transcript_count` convention, and
 * guessing wrong between the two would otherwise cost a rewrite rather
 * than a one-line change.
 */
export const SESSION_COUNT_FIELDS: readonly string[] = [
    'session_count',
    'session_transcript_count',
];

/**
 * The field a server sets FALSE to say it tried and could not count.
 * Mirrors `counted` on the unattributed rows.
 */
export const SESSION_COUNTED_FIELD = 'session_counted';

/** The three states a session count can be in. */
export const SESSION_STATES = {
    KNOWN: 'known',
    NOT_REPORTED: 'not-reported',
    CANNOT_DETERMINE: 'cannot-determine',
} as const;

/** One of the three session-count states. */
export type SessionState = (typeof SESSION_STATES)[keyof typeof SESSION_STATES];

/** What each non-known state says in the card's tooltip. */
export const SESSION_REASONS: Readonly<Record<string, string>> = {
    [SESSION_STATES.NOT_REPORTED]:
        'The server did not report a session count for this project. The total '
        + 'beside it counts EVERY transcript, including agent sidechains, so it '
        + 'is not a stand-in for this number.',
    [SESSION_STATES.CANNOT_DETERMINE]:
        'The server reported that it could not count the sessions in this '
        + 'project. That is not the same as there being none.',
};

/** A resolved session count: a number only in the `known` state. */
export interface SessionCount {
    readonly state: SessionState;
    readonly value: number | null;
}

/**
 * Resolve a project's own-session count into one of three outcomes.
 *
 * Description: the only reader of the server's field names for this
 *   count. `value` is a number ONLY in the `known` state; it is null in
 *   both others so a caller cannot accidentally render a substitute.
 * Inputs: row - a merged project node.
 * Output: the state and the value.
 * Example: sessionCountFor({session_count: 27})
 *   // -> {state: 'known', value: 27}
 * Example: sessionCountFor({transcript_count: 718})
 *   // -> {state: 'not-reported', value: null}
 */
export function sessionCountFor(row: NavRowData | null | undefined): SessionCount {
    const r = row || {};
    if (r[SESSION_COUNTED_FIELD] === false) {
        return { state: SESSION_STATES.CANNOT_DETERMINE, value: null };
    }
    for (const name of SESSION_COUNT_FIELDS) {
        const v = r[name];
        if (typeof v === 'number' && isFinite(v)) {
            return { state: SESSION_STATES.KNOWN, value: v };
        }
        // A field that is PRESENT and explicitly null is the server
        // saying it has the slot and no value for it. That is a
        // could-not-determine, not an absence - and it must not fall
        // through to the next alias, which would let a stale second
        // field answer for a first one that said "I do not know".
        if (v === null) return { state: SESSION_STATES.CANNOT_DETERMINE, value: null };
    }
    return { state: SESSION_STATES.NOT_REPORTED, value: null };
}

/**
 * The sentence the counts block carries on hover, which is the only
 * place there is room to say what the two numbers are.
 *
 * Inputs: session - a sessionCountFor result. total - the transcript count.
 * Output: the tooltip text.
 * Example: countsTitle({state: 'known', value: 27}, 718)
 */
export function countsTitle(session: SessionCount, total: number | null): string {
    const head = session.state === SESSION_STATES.KNOWN
        ? `${renderCount(session.value)} top-level sessions `
            + `(session_ref_scheme = uuid), out of ${renderCount(total)} `
            + 'transcripts in total.'
        : `Sessions: ${NOT_KNOWN}. ${SESSION_REASONS[session.state] || ''} `
            + `Total transcripts: ${renderCount(total)}.`;
    return `${head}\nThe total includes agent sidechain files, which are about `
        + '93 percent of this archive and are not conversations anybody had.';
}

/** A client-side overlay fallback, for a build with no overlay endpoint. */
export interface OverlayFallback {
    for?(row: NavRowData): Record<string, unknown> | null;
    readonly [key: string]: unknown;
}

/** What a project card renders, after the presentation overlay. */
export interface Presentation {
    /** The name to show. The override when there is one. */
    readonly name: string;
    /** The archive's own derived name, kept beside the override. */
    readonly serverName: string;
    readonly group: string | null;
    readonly hidden: boolean;
    /**
     * The OWNER renamed this project. It is NOT set by the app-database
     * name landing on the face: that is a lookup, not a label somebody
     * wrote, and conflating the two would make the info modal's "Your
     * labels" section claim 73 renames nobody performed.
     */
    readonly renamed: boolean;
    /** 'none' | 'applied' | 'cannot_determine' | 'absent'. */
    readonly overlayStatus: string;
    /** The app database's answer, refusal and all. Never null. */
    readonly app: AppName;
    /** True when `name` above IS the app database's name. */
    readonly fromApp: boolean;
    /**
     * True when `name` above is the SCRATCH label rather than a name or
     * a path. Never true at the same time as `fromApp`: a throwaway
     * directory has no name to have borrowed. Kept as its own flag
     * because the card styles a scratch row down and a test asserts the
     * classification rather than reading the string.
     */
    readonly scratch: boolean;
}

/**
 * The presentation facts a project card renders.
 *
 * Description: `status` HAS THREE VALUES AND THE THIRD IS NOT A FLAVOUR
 *   OF THE FIRST. 'none' means the owner has said nothing; 'applied'
 *   means a row was found; 'cannot_determine' means the project is not
 *   addressable, so nothing CAN be said about it. The server's own
 *   contract note is explicit that a client must not infer 'none' from
 *   an unchanged name, because renaming a project to its own folder name
 *   is a thing a person may do - so `renamed` is read off `applied`,
 *   never off a string comparison. A row with NO overlay block at all is
 *   the third case one level up: this build is talking to
 *   `/archive/projects`, which does not carry one. That is `absent`, not
 *   'none'.
 *
 *   THE NAME LADDER HAS FIVE RUNGS AND THE ORDER IS THE WHOLE DECISION.
 *   An OWNER'S OWN RENAME wins outright - it is the one value here a
 *   person typed, and a database lookup may not overrule it. Under that
 *   sits the APP DATABASE'S name, drawn only on the three approved
 *   match kinds (see `nav-app-name.ts`, which is where this client opts
 *   in to the derived rung); under that the SCRATCH label, which is not
 *   a name and is not a path but a measured throwaway directory said
 *   plainly; under that the ARCHIVE's own derived name, which is null
 *   for 100 of 100 projects on this install because `observed_cwd` is
 *   null for all of them; and under that the slug. A refused match kind
 *   - `none`, `ambiguous`, `cwd_conflict`, `cannot_determine` - falls
 *   straight through to the fourth rung, which is exactly what the card
 *   drew before this field existed.
 * Inputs: row - the project node. overlay - a client-side fallback,
 *   consulted ONLY when the row carries no overlay block.
 * Output: the presentation.
 * Example: presentationFor(node, null).overlayStatus   // -> 'absent'
 */
export function presentationFor(
    row: NavRowData | null | undefined,
    overlay: OverlayFallback | null | undefined,
): Presentation {
    const r = row || {};
    const raw = r.overlay;
    const block = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
    const archiveName = typeof r.archive_display_name === 'string' && r.archive_display_name
        ? r.archive_display_name
        : labelFor(NODE_KINDS.PROJECT, r);

    const app = appNameFor(r);

    if (block) {
        const applied = Array.isArray(block.applied) ? block.applied : [];
        const renamed = applied.indexOf('display_name') !== -1;
        const serverSide = labelFor(NODE_KINDS.PROJECT, r);
        // An owner's rename is already ON `display_name` here, applied by
        // the overlay endpoint. Only when there is no rename may the app
        // database's name take the face.
        const fromApp = !renamed && app.named;
        const scratchFace = renamed || fromApp ? null : scratchFaceFor(app);
        return {
            name: fromApp
                ? (app.name as string)
                : scratchFace !== null ? scratchFace : serverSide,
            serverName: archiveName,
            group: typeof block.group === 'string' && block.group ? block.group : null,
            hidden: block.hidden === true,
            renamed,
            overlayStatus: String(block.status || 'cannot_determine'),
            app,
            fromApp,
            scratch: scratchFace !== null,
        };
    }

    let patch: Record<string, unknown> | null = null;
    if (overlay && typeof overlay.for === 'function') {
        patch = overlay.for(r);
    } else if (overlay && typeof overlay === 'object') {
        const hit = overlay[String(r.project_id)];
        patch = hit && typeof hit === 'object' ? hit as Record<string, unknown> : null;
    }
    const p = patch || {};
    const override = typeof p.display_name === 'string' && p.display_name
        ? p.display_name
        : null;
    const fromApp = override === null && app.named;
    const scratchFace = override !== null || fromApp ? null : scratchFaceFor(app);
    const name = override !== null
        ? override
        : fromApp ? (app.name as string)
        : scratchFace !== null ? scratchFace : archiveName;
    return {
        name,
        serverName: archiveName,
        group: typeof p.group === 'string' && p.group ? p.group : null,
        hidden: p.hidden === true,
        // READ OFF THE OVERRIDE, NOT OFF A STRING COMPARISON. It used to
        // be `name !== archiveName`, which the app-database name now
        // satisfies for 73 of 100 projects without anybody having
        // renamed anything.
        renamed: override !== null && override !== archiveName,
        overlayStatus: 'absent',
        app,
        fromApp,
        scratch: scratchFace !== null,
    };
}

/** The two halves of the counts line, resolved for a template. */
export interface CountsLine {
    readonly session: SessionCount;
    readonly sessionText: string;
    readonly total: number | null;
    readonly totalText: string;
    readonly title: string;
}

/**
 * Everything the counts block needs, resolved once.
 *
 * Description: exists so the template holds no logic and a test can
 *   assert the wording without a DOM. The nouns are literals in the
 *   template; only the numbers and the tooltip come from here.
 *
 *   `total`, NOT `transcripts`, is the second noun, and that choice is a
 *   measurement. The rail gives the counts line about 198px. "NOT KNOWN
 *   sessions of 718 transcripts" needs about 207px and ellipsised the
 *   noun away on every one of the 77 cards, so the word that named what
 *   the total counts was never actually readable. Nothing is lost: the
 *   tooltip spells out "transcripts" and says they include sidechains.
 * Inputs: row - a merged project node.
 * Output: both halves and the tooltip.
 * Example: countsLine(node).sessionText   // -> 'NOT KNOWN'
 */
export function countsLine(row: NavRowData | null | undefined): CountsLine {
    const session = sessionCountFor(row);
    const total = countFor(NODE_KINDS.PROJECT, row);
    return {
        session,
        sessionText: session.state === SESSION_STATES.KNOWN
            ? renderCount(session.value)
            : NOT_KNOWN,
        total,
        totalText: renderCount(total),
        title: countsTitle(session, total),
    };
}
