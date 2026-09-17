/**
 * THE ROW MODEL: how a spine row becomes something a template can draw
 * without branching, and how consecutive `progress` lines fold into one
 * counted run.
 *
 * Ported from the PURE half of `client/js/archive-line-render.js`. The
 * DOM half of that file becomes `ReaderRow.svelte`, `ReaderBody.svelte`
 * and `ReaderProgressRun.svelte`; this is everything those three need to
 * be a table lookup rather than an if-chain.
 *
 * WHY A `BodyView` AND NOT `{#if}` PER STATE. There are eight body
 * states and each one differs in FOUR channels: its label, its sentence,
 * WHICH ACTIONS EXIST in its subtree, and its `data-body-state`. A
 * template branching on all four in eight arms is where the hard gate
 * quietly acquires a render button. Answering it here as data means the
 * dangerous property - "the hard gate offers no render action" - is a
 * row of a table a test can read, and its ABSENCE is structural rather
 * than a `disabled` attribute somebody can flip.
 *
 * ROLE IS NULL ON 44.93 PERCENT OF BODIES (measured 2026-08-31) and `ts`
 * is NULL on 33,480. A reader keyed on role blanks half its rows. The
 * fallback chain is role, then record_type, then the literal words "no
 * role recorded" - never a blank cell, because a blank cell is a
 * could-not-evaluate laundered into whitespace.
 *
 * `progress` IS 917,436 ROWS, 37.49 PERCENT OF ALL BODIES. A run of them
 * collapses to one counted chip that says how many are folded and over
 * which lines. NEVER hidden and never filtered out by default: a filter
 * that silently removes 37 percent of a byte-exact archive is a
 * client-side lie about the file's contents.
 *
 * MEANING IS NEVER CARRIED BY COLOUR OR BY BORDER-RADIUS ALONE. Three of
 * this app's 23 themes zero every radius token on purpose. Every state
 * here differs by its TEXT, its `data-body-state` and which actions
 * exist, before any styling is considered.
 *
 * Pure. No DOM, no framework.
 */
import {
    ACTIONS, BODY_STATE, FAMILIES, FAMILY_MOD, NO_ROLE_TEXT,
    NOT_REQUESTED, RECORD_FAMILY, ROW_CLASS,
    type BodyState, type Family, type ReaderAction,
} from './reader-vocab';
import type { BodyEntry } from './reader-body-cache';

/** One spine row, as the reader reads it. Everything is `unknown`. */
export interface SpineRow {
    readonly line_no?: unknown;
    readonly record_type?: unknown;
    readonly role?: unknown;
    readonly ts?: unknown;
    readonly model?: unknown;
    readonly body_id?: unknown;
    readonly body_chars?: unknown;
    readonly body_state?: unknown;
    readonly body_href?: unknown;
    readonly is_sidechain?: unknown;
    readonly agent_id?: unknown;
    readonly is_compact_boundary?: unknown;
    readonly compact_subtype?: unknown;
    readonly kind?: undefined;
}

/** A folded run of consecutive `progress` lines. */
export interface ProgressRun {
    readonly kind: 'progress-run';
    /** The first folded line's `line_no`. The run's STABLE identity. */
    readonly from: number;
    /** The last folded line's `line_no`. */
    readonly to: number;
    /** How many lines are folded. Always >= 2; see `groupRows`. */
    readonly count: number;
    /** The folded rows themselves. Nothing is discarded. */
    readonly rows: readonly SpineRow[];
}

/** Either a plain line or a folded run. What the reader lays out. */
export type ReaderItem = SpineRow | ProgressRun;

/** Is this item a folded progress run? A type guard, not a comparison. */
export function isRun(item: ReaderItem | null | undefined): item is ProgressRun {
    return !!item && (item as ProgressRun).kind === 'progress-run';
}

/**
 * The family a record type renders as.
 *
 * Description: anything not in the table renders as `meta`, which is a
 *   plain honest row rather than a crash. See `reader-vocab.ts`.
 * Inputs: recordType - the row's `record_type`.
 * Output: one of turn | tool | progress | note | meta.
 * Example: familyFor('assistant') // -> 'turn'
 */
export function familyFor(recordType: unknown): Family {
    if (typeof recordType !== 'string') return FAMILIES.META;
    return RECORD_FAMILY[recordType] ?? FAMILIES.META;
}

/**
 * The family MODIFIER CLASS for a record type, read from the literal
 * table rather than built by concatenation.
 *
 * Description: see `reader-vocab.ts` - a computed modifier is invisible
 *   to the stylesheet antijoin that enforces commitment 2.
 * Inputs: family - a family name.
 * Output: the modifier class.
 * Example: familyModFor('turn') // -> 'archive-row--turn'
 */
export function familyModFor(family: Family): string {
    return FAMILY_MOD[family] ?? `${ROW_CLASS}--meta`;
}

/** What `roleLabel` answers. `source` says WHICH rung produced it. */
export interface RoleLabel {
    readonly text: string;
    /** 'role' | 'record_type' | 'none'. */
    readonly source: string;
}

/**
 * What goes in the row's second column.
 *
 * Description: NORMATIVE fallback chain, see the file header. `source`
 *   is returned so a test can assert WHICH rung produced the label
 *   rather than just its text - a chain whose last rung is never
 *   exercised is unmeasured, not proven.
 * Inputs: row - a spine row.
 * Output: the label and its provenance.
 * Example: roleLabel({role: null, record_type: 'progress'})
 *   // -> {text: 'progress', source: 'record_type'}
 */
export function roleLabel(row: SpineRow | null | undefined): RoleLabel {
    if (row && typeof row.role === 'string' && row.role.length) {
        return { text: row.role, source: 'role' };
    }
    if (row && typeof row.record_type === 'string' && row.record_type.length) {
        return { text: row.record_type, source: 'record_type' };
    }
    return { text: NO_ROLE_TEXT, source: 'none' };
}

/**
 * Fold consecutive `progress` lines into runs, leaving every other line
 * alone.
 *
 * Description: RUNS OF ONE ARE LEFT AS ORDINARY LINES. A chip reading
 *   "progress x 1" costs a row and says less than the row it replaced.
 *   Nothing is discarded: a run carries its rows and is one action away
 *   from being expanded.
 * Inputs: spine - the raw spine rows.
 * Output: items, each either an original row or a ProgressRun.
 * Example: groupRows([a, p1, p2, p3, b])
 *   // -> [a, {kind: 'progress-run', count: 3, ...}, b]
 */
export function groupRows(spine: readonly SpineRow[] | null | undefined): ReaderItem[] {
    const out: ReaderItem[] = [];
    if (!Array.isArray(spine)) return out;
    /** Is the row at `k` a `progress` line? Out of range is false. */
    const isProgressAt = (k: number): boolean => spine[k]?.record_type === 'progress';

    let i = 0;
    while (i < spine.length) {
        const head = spine[i];
        if (head === undefined) { i += 1; continue; }
        if (isProgressAt(i)) {
            let j = i;
            while (j + 1 < spine.length && isProgressAt(j + 1)) j += 1;
            if (j > i) {
                out.push({
                    kind: 'progress-run',
                    from: head.line_no as number,
                    to: (spine[j] as SpineRow).line_no as number,
                    count: (j - i) + 1,
                    rows: spine.slice(i, j + 1),
                });
                i = j + 1;
                continue;
            }
        }
        out.push(head);
        i += 1;
    }
    return out;
}

/** One affordance a body region offers. */
export interface BodyAction {
    readonly action: ReaderAction;
    readonly label: string;
}

/**
 * Everything a template needs to draw one body region, as data.
 *
 * Description: `actions` is the channel that matters. THE HARD GATE'S
 *   GUARANTEE IS THAT `RENDER_ANYWAY` IS ABSENT FROM ITS LIST, which is
 *   a structural fact a test reads off this object rather than a
 *   `disabled` attribute.
 */
export interface BodyView {
    /** The `data-body-state` attribute value. */
    readonly dataState: string;
    /** Shown in the loud label position, or null when there is none. */
    readonly label: string | null;
    /** The sentence, or null. */
    readonly sentence: string | null;
    /** The masked, renderable text. Non-null ONLY when `kind` is 'text'. */
    readonly text: string | null;
    /** Which visual shape: text | placeholder | refusal | gate | loading | outcome. */
    readonly kind: string;
    /** The affordances that EXIST. Absence is the guarantee. */
    readonly actions: readonly BodyAction[];
    /** How many secrets the lens replaced. 0 renders no note. */
    readonly masked: number;
}

/** Nothing offered. Shared so an empty list is one object, not six. */
const NO_ACTIONS: readonly BodyAction[] = [];

/** The two actions a soft gate offers, in the vanilla order. */
const SOFT_GATE_ACTIONS: readonly BodyAction[] = [
    { action: ACTIONS.RENDER_ANYWAY, label: 'Render anyway' },
    { action: ACTIONS.DOWNLOAD_BODY, label: 'Download this body' },
];

/**
 * The ONE action a hard gate or a server withholding offers.
 *
 * Description: NOTE WHAT IS NOT HERE. `RENDER_ANYWAY` is absent, and its
 *   absence is the hard gate's whole guarantee - structural, not a flag.
 */
const DOWNLOAD_ONLY: readonly BodyAction[] = [
    { action: ACTIONS.DOWNLOAD_BODY, label: 'Download this body' },
];

/** The retry a refusal offers. */
const RETRY_ONLY: readonly BodyAction[] = [
    { action: ACTIONS.RETRY_BODY, label: 'Try loading it again' },
];

/**
 * Decide how one row's body region renders.
 *
 * Description: THE WHOLE REASON A 54 MB BODY CANNOT REACH THE DOM. There
 *   is no branch here that puts anything but `entry.text` into `text`,
 *   and `entry.text` is null in every state except `included`. This
 *   function does not read `body_json`, does not read `secrets`, and
 *   does not slice a string by offset - the masker already did, and a
 *   mask applied in a renderer is how a half-masked body ships looking
 *   like a success with a short hex tail.
 * Inputs: entry - the cache entry, or null meaning NOT REQUESTED.
 *   sizeText - the row's formatted size, or null when not known. The
 *   caller formats, so this module needs no formatter.
 * Output: a BodyView.
 * Example: bodyView(null, '960 chars').kind // -> 'placeholder'
 */
export function bodyView(
    entry: BodyEntry | null | undefined,
    sizeText: string | null,
): BodyView {
    // NOT REQUESTED. A sized placeholder, NEVER a spinner: nothing has
    // been asked for, so there is nothing to wait on.
    if (!entry) {
        return {
            dataState: NOT_REQUESTED,
            label: null,
            sentence: sizeText ? `${sizeText} not loaded yet` : 'body not loaded yet',
            text: null,
            kind: 'placeholder',
            actions: NO_ACTIONS,
            masked: 0,
        };
    }

    const base = { dataState: entry.state as string, masked: entry.masked || 0 };

    if (entry.state === BODY_STATE.OK) {
        return {
            ...base,
            label: null,
            sentence: null,
            text: entry.text,
            kind: 'text',
            actions: NO_ACTIONS,
        };
    }

    if (entry.state === BODY_STATE.MASK_REFUSED) {
        // NORMATIVE: the body is NOT rendered. Not truncated, not
        // partially masked, not shown behind a warning. A body with a
        // credential at an unknown position has no safe rendering.
        return {
            ...base,
            label: 'BODY WITHHELD BY THIS VIEW',
            sentence: `This body declares ${entry.findingCount} secret `
                + 'finding(s) that could not be located, so it cannot be masked '
                + `and is not shown. Reason: ${String(entry.reason)}`,
            text: null,
            kind: 'refusal',
            actions: RETRY_ONLY,
        };
    }

    if (entry.state === BODY_STATE.GATED_SOFT) {
        return {
            ...base,
            label: 'LARGE BODY',
            sentence: String(entry.reason),
            text: null,
            kind: 'gate',
            actions: SOFT_GATE_ACTIONS,
        };
    }

    if (entry.state === BODY_STATE.GATED_HARD) {
        return {
            ...base,
            label: 'TOO LARGE TO RENDER',
            sentence: String(entry.reason),
            text: null,
            kind: 'gate',
            actions: DOWNLOAD_ONLY,
        };
    }

    if (entry.state === BODY_STATE.WITHHELD) {
        return {
            ...base,
            label: 'WITHHELD BY THE SERVER',
            sentence: String(entry.reason),
            text: null,
            kind: 'gate',
            actions: DOWNLOAD_ONLY,
        };
    }

    if (entry.state === BODY_STATE.NO_BODY) {
        // A real, measured shape: an appearance row with a null body_id.
        // It is a fact about the file, not a failure.
        return {
            ...base,
            label: null,
            sentence: 'This line has no body row in the archive.',
            text: null,
            kind: 'placeholder',
            actions: NO_ACTIONS,
        };
    }

    if (entry.state === BODY_STATE.LOADING) {
        return {
            ...base,
            label: null,
            sentence: 'Loading body...',
            text: null,
            kind: 'loading',
            actions: NO_ACTIONS,
        };
    }

    // Everything else is a could-not-evaluate. It keeps its own shape so
    // it cannot drift into looking like an empty row.
    return {
        ...base,
        label: null,
        sentence: String(entry.reason || 'the body could not be read'),
        text: null,
        kind: 'outcome',
        actions: RETRY_ONLY,
    };
}

/**
 * The stable identity of one item, for the keyed `{#each}`.
 *
 * Description: a run is keyed by `from`, the same value expansion state
 *   is keyed on, because appending can reshape a run's `to` and `count`
 *   without moving its first row. A line is keyed by its own `line_no`,
 *   which is UNIQUE within one transcript's spine (see
 *   `src/core/archive_lines.py`); the reader holds one transcript at a
 *   time and clears on every switch, so a `line_no` cannot collide
 *   across transcripts.
 * Inputs: item - a reader item.
 * Output: a string key.
 * Example: itemKey({kind: 'progress-run', from: 7110, ...}) // -> 'run:7110'
 */
export function itemKey(item: ReaderItem): string {
    if (isRun(item)) return `run:${item.from}`;
    return `line:${String(item.line_no)}`;
}

/**
 * The line range a folded run covers, as a sentence.
 *
 * Description: a run of one never exists (see `groupRows`), but the
 *   single-line wording is kept so a future caller folding differently
 *   cannot produce "lines 7110-7110".
 * Inputs: run - a folded run.
 * Output: the sentence.
 * Example: rangeText({from: 7110, to: 7123, ...}) // -> 'lines 7110-7123'
 */
export function rangeText(run: ProgressRun): string {
    return run.from === run.to ? `line ${run.from}` : `lines ${run.from}-${run.to}`;
}

/**
 * Find the item index holding one line number, and whether it is folded
 * inside a run.
 *
 * Description: TWO SHAPES, AND THE RUN CASE MATTERS ON REAL DATA -
 *   transcript 5767's line 7,111 sits inside the run 7110..7123, so even
 *   a correct plain-row search would miss it. A deep link that landed on
 *   the run without expanding it would put the reader in the right place
 *   and show them a collapsed block instead of the line they asked for:
 *   a landing that measures as a success and is not one.
 * Inputs: items - the grouped items. lineNo - the line to find.
 * Output: the index and whether it is inside a run, or null when absent.
 * Example: indexOfLine(items, 7111) // -> {item: 9, inRun: true}
 */
export function indexOfLine(
    items: readonly ReaderItem[], lineNo: number,
): { readonly item: number; readonly inRun: boolean } | null {
    for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (!it) continue;
        if (!isRun(it) && it.line_no === lineNo) return { item: i, inRun: false };
        if (isRun(it)) {
            for (const child of it.rows) {
                if (child && child.line_no === lineNo) {
                    return { item: i, inRun: true };
                }
            }
        }
    }
    return null;
}

/** One row the render window puts in the DOM. */
export interface PaintedItem {
    readonly item: ReaderItem;
    /** Its index among the laid-out items. Drives the measurement read. */
    readonly index: number;
    /** Its stable `{#each}` key. */
    readonly key: string;
    /** Its cache entry, or null meaning NOT REQUESTED. */
    readonly entry: BodyEntry | null;
}

/**
 * The rows a window puts in the DOM, with their entries resolved.
 *
 * Description: PURE, so "which rows are rendered" is answerable by
 *   calling a function rather than by counting a render. It skips an
 *   index the items array does not hold rather than emitting a hole: a
 *   window can outlive the list it was computed against by one frame,
 *   and a null row would paint an empty article.
 * Inputs: items - the laid-out items. first/last - the window, `last`
 *   INCLUSIVE. entryFor - the body policy's reader.
 * Output: what to paint, in order.
 * Example: paintPlan(items, 0, 2, entryFor).length // -> 3
 */
export function paintPlan(
    items: readonly ReaderItem[],
    first: number,
    last: number,
    entryFor: (item: ReaderItem) => BodyEntry | null,
): PaintedItem[] {
    const out: PaintedItem[] = [];
    for (let i = first; i <= last; i += 1) {
        const item = items[i];
        if (!item) continue;
        out.push({ item, index: i, key: itemKey(item), entry: entryFor(item) });
    }
    return out;
}

/** Re-exported so a template needs one import for the state vocabulary. */
export { BODY_STATE, type BodyState };
