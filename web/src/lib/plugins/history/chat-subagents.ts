/**
 * THE SUBAGENT LIST HANGING OFF ONE TURN, in the order they ran.
 *
 * Ported from `client/js/archive-chat-subagents.js`, rule for rule, with
 * the DOM half lifted out into `ChatSubagents.svelte`. Everything here
 * is arithmetic over the server's shape and is testable under plain
 * node.
 *
 * HOW A SUBAGENT RUN IS IDENTIFIED AT ALL, because it is not obvious and
 * the obvious answer is wrong. There is NO stored foreign key from a
 * spawning message to the run it started
 * (`src/core/archive_turn_subagents.py`): `message_appearances.agent_id`
 * is not a `tool_use_id` - measured over the whole corpus, 18,271
 * distinct agent ids and ZERO of them equal any `tool_use_id` - and
 * `origin_session_ref` names the ROOT session, never the immediate
 * parent. What links them is a string in prose: the `tool_result` paired
 * to an Agent/Task `tool_use` carries `agentId: <id>`, and `agent-<id>`
 * is the `session_ref` of the subagent's own transcript. That resolves
 * 96.04 percent of the corpus's 19,629 spawn blocks. SO THE FILE LAYOUT
 * NEVER REACHES THIS VIEW: whether the run's jsonl sat inside a
 * `subagents/` directory or flat beside its parent, ingestion already
 * normalised it into a `message_transcripts` row, and this view links by
 * `transcript_id`. A spawn may resolve to MORE than one transcript (the
 * same run collected from two machines), which is why `transcripts` is a
 * LIST and why one spawn can carry several controls under one ordinal.
 *
 * AN ORDINAL IS A CLAIM. Printing "1st" asserts that this run started
 * before the other two. The server knows on what basis it ordered them
 * and SAYS SO in `order_basis`, so this view renders that word rather
 * than inventing a confidence of its own: `start_ts` is a real timestamp
 * and `file_position` is the order the spawns were written, which is NOT
 * the same claim. A view printing identical ordinals for both would be
 * upgrading a file offset into a clock.
 *
 * "NO SUBAGENTS", "SOME I COULD NOT IDENTIFY" AND "I COULD NOT LOOK" ARE
 * THREE DIFFERENT FINDINGS and the server distinguishes all three, so
 * this view must not flatten them. An unresolved entry is LISTED,
 * COUNTED and given a disabled control naming why it cannot open,
 * because the server's own meta says an unresolved entry means the run
 * is real and unidentified, never that no run happened.
 *
 * No DOM, no framework, no globals.
 */
import { NOT_KNOWN } from './chat-vocab';

/** Ordering bases this VIEW can produce when the server names none. */
export const ORDER_DECLARED = 'declared';
/** This view sorted by start time itself. */
export const ORDER_DERIVED = 'derived-from-start-time';
/** Neither an order nor a full set of start times was available. */
export const ORDER_UNKNOWN = 'cannot-determine';

/** The server looked and answered. */
export const LOOKUP_KNOWN = 'known';
/** The server could not look. NOT the same as "spawned none". */
export const LOOKUP_FAILED = 'cannot-determine';

/**
 * How each server-declared `order_basis` is explained to a person.
 *
 * Description: a basis NOT in this table is still rendered, under its
 *   own raw name, prefixed so nobody reads an unfamiliar word as a
 *   guarantee.
 */
export const BASIS_PROSE: Readonly<Record<string, string>> = {
    start_ts: 'ordered by START TIME, as the server recorded it',
    file_position: 'ordered by POSITION IN THE TRANSCRIPT, which is the order '
        + 'the spawns were written, NOT a measured clock',
    declared: 'in the order the server declared they ran',
    'derived-from-start-time': 'sorted by START TIME by this view. The server '
        + 'declared no order, so these ordinals are derived rather than stated',
};

/** One transcript a spawn resolved to. */
export interface SubagentTranscript {
    readonly transcript_id?: unknown;
    readonly session_ref?: unknown;
    readonly line_count?: unknown;
    readonly start_ts?: unknown;
}

/** One spawn entry, as `/messages` sends it. */
export interface SubagentRow {
    readonly order?: unknown;
    readonly order_basis?: unknown;
    readonly link_state?: unknown;
    readonly agent_ids?: unknown;
    readonly start_ts?: unknown;
    readonly started_at?: unknown;
    readonly start_time?: unknown;
    readonly ts?: unknown;
    readonly transcripts?: unknown;
    readonly transcript_id?: unknown;
    readonly spawned_by?: { readonly tool_name?: unknown; readonly line_no?: unknown };
}

/** The turn fields this module reads. */
export interface SubagentTurn {
    readonly subagents?: unknown;
    readonly subagents_state?: unknown;
    readonly subagent_status?: unknown;
    readonly subagent_reason?: unknown;
    readonly line_no?: unknown;
}

/**
 * Did the server actually look for this turn's subagents?
 *
 * Description: structural first, then the server's own word. AN EMPTY
 *   ARRAY IS NOT EVIDENCE ON ITS OWN - a server sending `[]` alongside
 *   `subagents_state: 'cannot_determine'` is telling us the array means
 *   nothing, and that state wins. The allow-list is deliberate: a value
 *   invented after this file was written fails toward the third outcome
 *   rather than toward success.
 * Inputs: turn.
 * Output: LOOKUP_KNOWN or LOOKUP_FAILED.
 * Example: lookupState({subagents: [], subagents_state: 'none_spawned'})
 *   // -> 'known'
 */
export function lookupState(turn: SubagentTurn | null | undefined): string {
    if (!turn || typeof turn !== 'object') return LOOKUP_FAILED;
    const st = turn.subagents_state ?? turn.subagent_status;
    if (typeof st === 'string' && st !== '') {
        const ok = st === 'none_spawned' || st === 'resolved' || st === 'ok'
            || st === 'partial' || st === 'partial_resolution';
        if (!ok) return LOOKUP_FAILED;
    }
    return Array.isArray(turn.subagents) ? LOOKUP_KNOWN : LOOKUP_FAILED;
}

/**
 * The start time of one row, whatever the server called it.
 *
 * Description: null is not zero, and a row with no time must not sort as
 *   the earliest.
 * Inputs: row.
 * Output: the raw timestamp string, or null.
 */
export function startOf(row: SubagentRow | null | undefined): string | null {
    if (!row || typeof row !== 'object') return null;
    const v = row.start_ts || row.started_at || row.start_time || row.ts || null;
    return (typeof v === 'string' && v !== '') ? v : null;
}

/**
 * The transcripts one spawn resolved to. Always an array, possibly empty.
 *
 * Description: a spawn with none is a REAL RUN THAT WAS NOT IDENTIFIED,
 *   never a spawn that did not happen. A flat `transcript_id` is
 *   tolerated so a server that later sends one id per row does not
 *   silently render as unlinked.
 * Inputs: row.
 * Output: an array of transcript entries.
 */
export function transcriptsOf(row: SubagentRow | null | undefined): SubagentTranscript[] {
    if (!row || typeof row !== 'object') return [];
    if (Array.isArray(row.transcripts)) return row.transcripts as SubagentTranscript[];
    if (row.transcript_id !== undefined && row.transcript_id !== null) {
        return [{ transcript_id: row.transcript_id }];
    }
    return [];
}

/** What `order` answers: the rows, and the basis of their ordinals. */
export interface OrderedRows {
    readonly rows: SubagentRow[];
    readonly basis: string;
}

/**
 * Put the rows in the order they ran, and say on what basis.
 *
 * Description: the SERVER'S basis wins when it names one; this function
 *   only decides when it does not. The input is never mutated, because
 *   it belongs to the caller's data.
 * Inputs: rows - a turn's `subagents`.
 * Output: a new array and the basis.
 * Example: order([{order: 2, order_basis: 'start_ts'},
 *   {order: 1, order_basis: 'start_ts'}]).basis // -> 'start_ts'
 */
export function order(rows: readonly SubagentRow[] | null | undefined): OrderedRows {
    const list = Array.isArray(rows) ? rows.slice() : [];
    if (list.length === 0) return { rows: list, basis: ORDER_DECLARED };

    const allDeclared = list.every(
        (r) => !!r && Number.isInteger(r.order) && (r.order as number) >= 1,
    );
    if (allDeclared) {
        list.sort((a, b) => (a.order as number) - (b.order as number));
        // ONE basis, or none. Rows that disagree about how they were
        // ordered cannot be summarised by either of their answers.
        const names = [...new Set(
            list.map((r) => r.order_basis)
                .filter((b): b is string => typeof b === 'string' && b !== ''),
        )];
        return { rows: list, basis: names.length === 1 ? (names[0] as string) : ORDER_DECLARED };
    }

    if (list.every((r) => startOf(r) !== null)) {
        // String comparison, deliberately: these are ISO-8601 timestamps
        // and ISO-8601 sorts lexicographically in the same order it
        // sorts chronologically. Parsing them into Date objects would
        // introduce a timezone interpretation this view has no business
        // making.
        list.sort((a, b) => {
            const x = startOf(a) as string;
            const y = startOf(b) as string;
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        return { rows: list, basis: ORDER_DERIVED };
    }

    return { rows: list, basis: ORDER_UNKNOWN };
}

/**
 * The ordinal shown against one row.
 *
 * Description: a known ordering prints a rank; an unknown one prints NOT
 *   KNOWN in the same column, so the gap sits exactly where the claim
 *   would have been.
 * Inputs: basis, i - zero-based position.
 * Output: the ordinal, or NOT KNOWN.
 * Example: ordinalFor('start_ts', 2) // -> '3rd'
 */
export function ordinalFor(basis: string, i: number): string {
    if (basis === ORDER_UNKNOWN) return NOT_KNOWN;
    const n = i + 1;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    const mod10 = n % 10;
    if (mod10 === 1) return `${n}st`;
    if (mod10 === 2) return `${n}nd`;
    if (mod10 === 3) return `${n}rd`;
    return `${n}th`;
}

/**
 * The sentence above the list, naming the count AND the basis.
 *
 * Inputs: n - how many spawns. basis.
 * Output: the sentence.
 * Example: basisProse(2, 'start_ts')
 */
export function basisProse(n: number, basis: string): string {
    if (basis === ORDER_UNKNOWN) {
        return `${n} subagent(s). RUN ORDER NOT KNOWN: the server declared `
            + 'neither an order nor a start time for every one, so these are '
            + 'listed as received and the ordinals are withheld.';
    }
    const how = BASIS_PROSE[basis]
        || `ordered on a basis this view does not have a name for, which the `
            + `server calls "${basis}"`;
    return `${n} subagent(s), ${how}.`;
}

/**
 * A readable name for one spawn.
 *
 * Description: built from what the server actually sent, in descending
 *   order of usefulness, and never invented: a spawn with nothing
 *   identifying is called what it is.
 * Inputs: row, ts - transcriptsOf(row).
 * Output: a name.
 */
export function nameFor(row: SubagentRow, ts: readonly SubagentTranscript[]): string {
    const only = ts.length === 1 ? ts[0] : undefined;
    if (only && only.session_ref) return String(only.session_ref);
    const ids = row.agent_ids;
    if (Array.isArray(ids) && ids.length) return `agent ${ids.join(', ')}`;
    const by = row.spawned_by;
    if (by && by.tool_name) {
        const at = by.line_no !== undefined && by.line_no !== null
            ? ` at line ${by.line_no}` : '';
        return `${String(by.tool_name)} spawn${at}`;
    }
    return 'subagent';
}

/** One control in the rendered list: openable, or explained. */
export interface SubagentControl {
    /** Stable key for the `{#each}`. */
    readonly key: string;
    readonly ordinal: string;
    /** `data-ordinal`: the rank, or the word unknown. */
    readonly ordinalData: string;
    readonly name: string;
    readonly started: string;
    /** May this control drill in. */
    readonly openable: boolean;
    /** The transcript to open, when openable. */
    readonly transcriptId: string | null;
    /** The first agent id, for `data-agent-id`. */
    readonly agentId: string | null;
    /** The trailing line: a size, or why this run cannot be opened. */
    readonly tail: string;
    /** The server's own word for why, when not openable. */
    readonly linkState: string | null;
}

/** One spawn's row: an ordinal and one control per resolved transcript. */
export interface SubagentRowView {
    readonly key: string;
    readonly controls: readonly SubagentControl[];
    /** Set only when ONE spawn resolved to several transcripts. */
    readonly multi: string | null;
}

/** The whole panel for one turn. */
export interface SubagentPanel {
    /** `known` renders the list; `cannot-determine` renders the refusal. */
    readonly state: string;
    readonly basis: string;
    readonly count: number;
    /** The sentence above the list, or the refusal's reason. */
    readonly sentence: string;
    readonly rows: readonly SubagentRowView[];
    /** Counted out loud when some runs could not be linked. */
    readonly unlinked: string | null;
}

/** One control, from one spawn and one (possibly absent) transcript. */
function controlFor(
    row: SubagentRow, t: SubagentTranscript | null, basis: string, i: number, k: number,
): SubagentControl {
    const ts = transcriptsOf(row);
    const ids = Array.isArray(row.agent_ids) ? row.agent_ids : [];
    const started = (t && t.start_ts) || startOf(row);
    const openable = !!t && t.transcript_id !== undefined && t.transcript_id !== null;
    const tail = openable
        ? (Number.isFinite(t?.line_count)
            ? `${t?.line_count} lines` : `transcript ${t?.transcript_id}`)
        // THE RUN HAPPENED. It could not be linked to a stored
        // transcript, which is a different fact from it not existing,
        // and the server's own word for why is rendered verbatim.
        : `NOT OPENABLE: this run is real and was not linked to a stored `
            + `transcript (${String(row.link_state)}). That is not the same as `
            + 'no run happening.';
    return {
        key: `${i}:${k}`,
        ordinal: ordinalFor(basis, i),
        ordinalData: basis === ORDER_UNKNOWN ? 'unknown' : String(i + 1),
        name: t && t.session_ref ? String(t.session_ref) : nameFor(row, ts),
        started: started ? `started ${started}` : `started: ${NOT_KNOWN}`,
        openable,
        transcriptId: openable ? String(t?.transcript_id) : null,
        agentId: ids.length ? String(ids[0]) : null,
        tail,
        linkState: openable ? null : String(row.link_state),
    };
}

/**
 * Shape the whole subagent panel for one turn.
 *
 * Description: RETURNS A PANEL EVEN WHEN THE LOOKUP FAILED, because a
 *   failed lookup is a finding to render. It returns null ONLY for the
 *   known-and-empty case, which is the one state with no affordance and
 *   the reason a turn that spawned nothing looks like an ordinary turn.
 * Inputs: turn.
 * Output: a SubagentPanel, or null when the server looked and found none.
 * Example: panelFor({subagents: [], subagents_state: 'none_spawned'})
 *   // -> null
 */
export function panelFor(turn: SubagentTurn | null | undefined): SubagentPanel | null {
    const state = lookupState(turn);
    if (state === LOOKUP_FAILED) {
        const raw = turn && (turn.subagents_state ?? turn.subagent_status);
        const why = (turn && typeof turn.subagent_reason === 'string')
            ? turn.subagent_reason
            : `the server reported subagents_state=${String(raw)} for this turn, `
                + `so whether it spawned any is ${NOT_KNOWN}. This is not the same `
                + 'as it having spawned none.';
        const line = turn && turn.line_no !== undefined ? String(turn.line_no) : '?';
        return {
            state,
            basis: ORDER_UNKNOWN,
            count: 0,
            sentence: `subagents of line ${line}: ${why}`,
            rows: [],
            unlinked: null,
        };
    }

    const raw = (turn as SubagentTurn).subagents as SubagentRow[];
    if (raw.length === 0) return null;

    const ordered = order(raw);
    const rows: SubagentRowView[] = [];
    let unlinked = 0;
    ordered.rows.forEach((row, i) => {
        const ts = transcriptsOf(row);
        if (ts.length === 0) unlinked += 1;
        const controls = ts.length === 0
            ? [controlFor(row, null, ordered.basis, i, 0)]
            : ts.map((t, k) => controlFor(row, t, ordered.basis, i, k));
        rows.push({
            key: String(i),
            controls,
            // A spawn that resolved to SEVERAL transcripts gets one
            // control each, under one ordinal, because collapsing them
            // would hide runs and picking one would be a choice nobody
            // made.
            multi: ts.length > 1
                ? `This one spawn resolved to ${ts.length} transcripts. All of `
                    + 'them are listed; none was picked for you.'
                : null,
        });
    });

    return {
        state,
        basis: ordered.basis,
        count: ordered.rows.length,
        sentence: basisProse(ordered.rows.length, ordered.basis),
        rows,
        // COUNTED OUT LOUD, not left for the reader to notice by
        // scanning for disabled buttons.
        unlinked: unlinked > 0
            ? `${unlinked} of these ${ordered.rows.length} run(s) could not be `
                + 'linked to a stored transcript and cannot be opened. They still ran.'
            : null,
    };
}

/** What the turn header's subagent expander says, or null for no expander. */
export interface Expander {
    readonly label: string;
    readonly state: string;
}

/**
 * The label for the expander on a turn, or null when it carries none.
 *
 * Description: kept beside `panelFor` rather than in the turn renderer
 *   so the count and the list can never disagree.
 * Inputs: turn.
 * Output: an Expander, or null.
 * Example: expanderFor({subagents: [{}, {}], subagents_state: 'resolved'})
 *   // -> {label: '2 subagents', state: 'known'}
 */
export function expanderFor(turn: SubagentTurn | null | undefined): Expander | null {
    const state = lookupState(turn);
    if (state === LOOKUP_FAILED) {
        return { label: `Subagents: ${NOT_KNOWN}`, state: LOOKUP_FAILED };
    }
    const n = ((turn as SubagentTurn).subagents as unknown[]).length;
    if (n === 0) return null;
    return { label: n === 1 ? '1 subagent' : `${n} subagents`, state: LOOKUP_KNOWN };
}
