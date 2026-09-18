/**
 * THE "i" PANEL: the envelope of one chat turn, on demand.
 *
 * Ported from `client/js/archive-chat-info.js`, field for field, with
 * the DOM half lifted into `ChatInfo.svelte`.
 *
 * WHY THE ENVELOPE IS HIDDEN BY DEFAULT AND WHY IT IS NOT DELETED. The
 * complaint that produced this whole view was "im looking at a bunch of
 * raw json so it does not read properly". The fix is not to throw the
 * uuids and token counts away - they are how you correlate a turn with a
 * subagent, with a log line, or with a bug report. The fix is to move
 * them behind one affordance per turn.
 *
 * EVERY FIELD IS ALWAYS RENDERED, EVEN WHEN ABSENT. A field the server
 * did not send renders as NOT KNOWN, never as a blank cell and never by
 * being omitted. A missing row and a row with no value look identical to
 * a reader and mean different things: one is "this turn has no model",
 * the other is "nobody told me". This panel is where people come when
 * something is confusing, so it is the last place that may quietly drop
 * a fact.
 *
 * NOTHING HERE IS MASKED, BECAUSE NOTHING HERE IS BODY TEXT. The fields
 * are identifiers, timestamps, a model name and integer counts. THE ONE
 * PLACE THAT COULD CHANGE is the extra-keys branch, which renders
 * whatever unfamiliar keys `info` grew. If the server ever puts free
 * text there it must be routed through `chat-mask.ts` like every other
 * renderable string; see the branch's own note.
 *
 * No DOM, no framework, no globals.
 */
import { NOT_KNOWN } from './chat-vocab';

/** One labelled field of the envelope. */
export interface InfoField {
    readonly key: string;
    readonly label: string;
}

/**
 * The envelope fields, in the order a person reads them: what this turn
 * IS, then where it sits, then what it cost.
 *
 * Description: `key` is looked up on the turn first and on `turn.info`
 *   second, so the server may put a field in either place without this
 *   file caring. `role_state` sits beside `role` because measured live
 *   2026-09-01 this server reports `role_state: 'record_type_fallback'`
 *   for records carrying no role of their own and fills the role in from
 *   the record type; a reader who thinks "system" was declared when it
 *   was inferred is being told something nobody measured.
 */
export const FIELDS: readonly InfoField[] = [
    { key: 'message_uuid', label: 'uuid' },
    { key: 'parent_uuid', label: 'parent uuid' },
    { key: 'role', label: 'role' },
    { key: 'role_state', label: 'role came from' },
    { key: 'record_type', label: 'record type' },
    { key: 'model', label: 'model' },
    { key: 'ts', label: 'timestamp' },
    { key: 'line_no', label: 'line number' },
    { key: 'seq_in_file', label: 'sequence in file' },
    { key: 'body_id', label: 'body id' },
    { key: 'body_chars', label: 'body characters' },
    { key: 'line_status', label: 'line status' },
    { key: 'fidelity_outcome', label: 'fidelity' },
    { key: 'origin_session_ref', label: 'origin session' },
    { key: 'agent_id', label: 'agent id' },
    { key: 'is_sidechain', label: 'is a sidechain' },
    { key: 'blocks_state', label: 'blocks came from' },
    { key: 'subagents_state', label: 'subagent lookup' },
    { key: 'secret_finding_count', label: 'flagged secrets' },
];

/**
 * Token accounting, its own group.
 *
 * Description: it answers a different question from the identifiers
 *   above, and a cache-read count sitting in a list of uuids reads as
 *   noise. `state` and `reason` come FIRST because they are what makes a
 *   row of nulls readable: the server reports `usage.state:
 *   'not_recorded'` with a reason in words for every message carrying no
 *   usage object, and four blank counts with no explanation would read
 *   as a bug in this panel.
 */
export const USAGE_FIELDS: readonly InfoField[] = [
    { key: 'state', label: 'usage recorded' },
    { key: 'reason', label: 'why not' },
    { key: 'input_tokens', label: 'input tokens' },
    { key: 'output_tokens', label: 'output tokens' },
    { key: 'cache_creation_input_tokens', label: 'cache write tokens' },
    { key: 'cache_read_input_tokens', label: 'cache read tokens' },
];

/** The nests the server groups envelope fields under. */
const NESTS = ['usage', 'line', 'body'] as const;

/** A turn, as this module reads it. */
export interface InfoTurn {
    readonly info?: unknown;
    readonly [key: string]: unknown;
}

/**
 * Read one field off the turn, then off `turn.info`, then off its nests.
 *
 * Description: THE ENVELOPE IS NESTED AND EVERY NEST IS SEARCHED.
 *   Measured live 2026-09-01, this server groups the fields under
 *   `info.usage`, `info.line` and `info.body`. A lookup reading only the
 *   top level would render two thirds of the envelope as NOT KNOWN while
 *   the server had sent every one of them - a gap manufactured by this
 *   file and reported as a gap in the data.
 * Inputs: turn, key.
 * Output: the raw value, or undefined.
 * Example: pick({info: {model: 'x'}}, 'model') // -> 'x'
 */
export function pick(turn: InfoTurn | null | undefined, key: string): unknown {
    if (!turn || typeof turn !== 'object') return undefined;
    if (turn[key] !== undefined && turn[key] !== null) return turn[key];
    const info = turn.info as Record<string, unknown> | undefined;
    if (info && typeof info === 'object' && info[key] !== undefined
        && info[key] !== null) {
        return info[key];
    }
    for (const nestKey of NESTS) {
        const nest = info && typeof info === 'object'
            ? info[nestKey] as Record<string, unknown> | undefined : undefined;
        if (nest && typeof nest === 'object' && nest[key] !== undefined
            && nest[key] !== null) {
            return nest[key];
        }
    }
    return undefined;
}

/**
 * Render a value for display.
 *
 * Description: an object or array becomes JSON, because `[object
 *   Object]` in an info panel is a fact destroyed rather than shown.
 * Inputs: v - any value.
 * Output: a string, NOT KNOWN when there is nothing.
 * Example: display(undefined) // -> 'NOT KNOWN'
 */
export function display(v: unknown): string {
    if (v === undefined || v === null || v === '') return NOT_KNOWN;
    if (typeof v === 'object') {
        try {
            return JSON.stringify(v);
        } catch {
            // Circular, or a BigInt. The value is unrenderable rather
            // than absent, and saying which is the whole point of this
            // panel.
            return `${NOT_KNOWN} (value could not be serialised)`;
        }
    }
    return String(v);
}

/** One rendered definition-list row. */
export interface InfoRow {
    readonly label: string;
    readonly value: string;
    /** `data-known`: tells a fact from a gap without parsing the copy. */
    readonly known: boolean;
}

/** Turn one field table into rows. */
function rowsFrom(turn: InfoTurn, fields: readonly InfoField[]): InfoRow[] {
    return fields.map((f) => {
        const v = pick(turn, f.key);
        const known = v !== undefined && v !== null && v !== '';
        return { label: f.label, value: display(v), known };
    });
}

/**
 * Keys on `turn.info` this file has no row for.
 *
 * Description: SHOWN RATHER THAN DROPPED. A server that grows a field
 *   must not have it silently disappear, which is how a fact becomes
 *   invisible for a year. The three nests are excluded because their
 *   contents are rendered above under their own names, so listing them
 *   again as raw JSON would be the same facts twice.
 *
 *   IF THE SERVER EVER PUTS FREE TEXT HERE it must be routed through
 *   `chat-mask.ts`, exactly like a block's text. Today every value in
 *   this branch is an identifier, a count or a state word.
 * Inputs: turn.
 * Output: sorted key names, so the panel is stable.
 */
export function extraKeys(turn: InfoTurn | null | undefined): string[] {
    const info = turn && turn.info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) return [];
    const named = new Set<string>([...NESTS]);
    for (const f of FIELDS) named.add(f.key);
    for (const f of USAGE_FIELDS) named.add(f.key);
    return Object.keys(info as Record<string, unknown>)
        .filter((k) => !named.has(k))
        .sort();
}

/** The whole panel, as data. */
export interface InfoPanel {
    /** Null when the turn is absent; the panel renders a sentence then. */
    readonly rows: readonly InfoRow[];
    readonly usage: readonly InfoRow[];
    readonly extra: readonly InfoRow[];
    /** True when there is no turn to describe at all. */
    readonly missing: boolean;
}

/**
 * Build the envelope panel for one turn.
 *
 * Inputs: turn - `null` is a real input: it means the panel was asked
 *   for and there is no turn, which renders as a sentence rather than as
 *   an empty box.
 * Output: an InfoPanel.
 * Example: infoPanel({model: 'claude-opus-5'}).rows.length // -> 19
 */
export function infoPanel(turn: InfoTurn | null | undefined): InfoPanel {
    if (!turn || typeof turn !== 'object') {
        return { rows: [], usage: [], extra: [], missing: true };
    }
    const info = turn.info as Record<string, unknown> | undefined;
    const extra = extraKeys(turn).map((k) => {
        const v = info ? info[k] : undefined;
        return {
            label: k,
            value: display(v),
            known: v !== undefined && v !== null && v !== '',
        };
    });
    return {
        rows: rowsFrom(turn, FIELDS),
        usage: rowsFrom(turn, USAGE_FIELDS),
        extra,
        missing: false,
    };
}
