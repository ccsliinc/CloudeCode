/**
 * ONE CHAT BUBBLE, AS DATA: who spoke, the header chips, and the blocks
 * in `seq` order, each already turned into something renderable by
 * `chat-mask.ts`.
 *
 * Ported from `client/js/archive-chat-turn.js` and the non-masking half
 * of `client/js/archive-chat-block.js`, with the DOM lifted into
 * `ChatTurn.svelte` and `ChatBlock.svelte`.
 *
 * THE DEFAULT STATE OF A BUBBLE IS PROSE AND NOTHING ELSE. The brief,
 * verbatim: "in the conversation view it should read like a chat, and
 * each bubble should have icons for like an i for info about the chat
 * message, if it has sub agents it should be able to be opened to see
 * the run subagents ... not information overload, but the ability to
 * grab as much info as properly." So the envelope is behind the "i",
 * thinking and tool payloads are behind their own disclosures, and
 * subagents are behind a counted expander.
 *
 * ROLE IS NEVER SIGNALLED BY COLOUR ALONE, and that is not a
 * nice-to-have here. Three of this app's themes - terminal, gameboy,
 * legacy_apple - deliberately zero every radius token, so a bubble in
 * those themes is a rectangle and the chat metaphor cannot lean on
 * rounded corners either. Every turn carries the role as TEXT in its
 * header plus a `data-role` attribute for the stylesheet. Strip the CSS
 * entirely and the transcript still reads as a conversation.
 *
 * A VIEW IS A PURE FUNCTION OF (turn, openState). It holds nothing and
 * registers nothing: bubbles are recycled on every paint by the virtual
 * list, so a captured flag would render the wrong turn's open panel.
 *
 * PROGRESS RECORDS ARE NOT TURNS. They are 917,436 rows, 37.5 percent of
 * every body in the corpus, and they stay collapsed behind a count chip
 * exactly as the raw reader already does it.
 *
 * No DOM, no framework, no globals.
 */
import {
    COLLAPSED_BY_DEFAULT, NOT_KNOWN, ROLE_LABELS, TYPE_LABELS,
} from './chat-vocab';
import { blockText, type ChatBlockRaw, type ChatBlockText } from './chat-mask';
import { expanderFor, type Expander } from './chat-subagents';

/** One turn, as `/messages` sends it. */
export interface ChatTurnRaw {
    readonly kind?: unknown;
    readonly role?: unknown;
    readonly role_state?: unknown;
    readonly record_type?: unknown;
    readonly model?: unknown;
    readonly ts?: unknown;
    readonly line_no?: unknown;
    readonly body_id?: unknown;
    readonly blocks?: unknown;
    readonly blocks_state?: unknown;
    readonly secret_finding_count?: unknown;
    readonly subagents?: unknown;
    readonly subagents_state?: unknown;
    readonly [key: string]: unknown;
}

/** A folded run of progress records, produced by `chat-load.ts`. */
export interface ProgressRun {
    readonly kind: 'progress-run';
    readonly from: number;
    readonly to: number;
    readonly count: number;
}

/** One laid-out item: a turn or a folded run. */
export type ChatItem = ChatTurnRaw | ProgressRun;

/** Is this item a folded progress run rather than a bubble? */
export function isRun(item: ChatItem | null | undefined): item is ProgressRun {
    return !!item && (item as ProgressRun).kind === 'progress-run';
}

/** Which panels of one row are open. Sparse: an untouched row has none. */
export interface OpenState {
    readonly infoOpen?: boolean;
    readonly subOpen?: boolean;
    readonly progressExpanded?: boolean;
}

/**
 * The speaker's display name.
 *
 * Description: falls back to the RAW role, then to an explicit unknown,
 *   never to a default party.
 * Inputs: turn.
 * Output: what a person reads.
 * Example: roleLabel({role: 'user'}) // -> 'You'
 */
export function roleLabel(turn: ChatTurnRaw | null | undefined): string {
    const r = turn && turn.role;
    if (typeof r !== 'string' || r === '') return `SPEAKER ${NOT_KNOWN}`;
    return ROLE_LABELS[r] || r;
}

/** One rendered content block, with its text already through the masker. */
export interface ChatBlockView {
    readonly key: string;
    readonly seq: number | null;
    readonly type: string;
    readonly typeLabel: string;
    readonly toolName: string | null;
    readonly toolUseId: string | null;
    /** True ONLY when the server said so; `null` is not `false`. */
    readonly isError: boolean;
    readonly lengthLabel: string | null;
    /** Is this block behind a `<details>` by default. */
    readonly collapsed: boolean;
    /** `data-text-state` on the block root. */
    readonly dataState: string;
    /** What to paint, already decided by `chat-mask.blockText`. */
    readonly content: ChatBlockText;
}

/** What the turn body is: real blocks, an honest empty, or an unknown. */
export type TurnBody =
    | { readonly kind: 'blocks'; readonly blocks: readonly ChatBlockView[] }
    | { readonly kind: 'empty'; readonly sentence: string }
    | { readonly kind: 'unknown'; readonly sentence: string };

/** The whole bubble, as data. */
export interface ChatTurnView {
    readonly role: string;
    readonly roleText: string;
    /** Set when the server INFERRED the role rather than reading one. */
    readonly roleInferred: boolean;
    readonly roleState: string | null;
    readonly recordType: string;
    readonly ts: string;
    readonly model: string | null;
    readonly secretCount: number;
    readonly lineNo: string | null;
    readonly bodyId: string | null;
    readonly expander: Expander | null;
    readonly body: TurnBody;
    /** `data-blocks`: a count, or the word this view could not resolve. */
    readonly blocksData: string;
}

/**
 * The `blocks_state` values this view can interpret.
 *
 * Description: measured live 2026-09-01 the three states are `extracted`
 *   (a real content array), `content_string` (the content was a bare
 *   string, which is most user turns) and `no_message_content` (it
 *   looked; there is none). ANY OTHER VALUE - including one invented
 *   after this file was written - means this view cannot say what the
 *   empty array in front of it represents, so it says that instead of
 *   rendering "no content blocks" over an unevaluated lookup.
 */
const BLOCKS_STATE_KNOWN = new Set(['extracted', 'content_string', 'no_message_content']);

/** Is the server's `blocks_state` one this view can interpret? */
function blocksStateKnown(bs: unknown): boolean {
    if (bs === undefined || bs === null || bs === '') return true;
    return typeof bs === 'string' && BLOCKS_STATE_KNOWN.has(bs);
}

/** Shape one content block, masking its text on the way through. */
function blockView(block: ChatBlockRaw, turn: ChatTurnRaw, i: number): ChatBlockView {
    const type = String(block.type);
    const content = blockText(block, turn);
    return {
        key: Number.isInteger(block.seq) ? `seq:${block.seq}` : `pos:${i}`,
        seq: Number.isInteger(block.seq) ? block.seq as number : null,
        type,
        typeLabel: TYPE_LABELS[type] || type,
        toolName: block.tool_name ? String(block.tool_name) : null,
        toolUseId: block.tool_use_id ? String(block.tool_use_id) : null,
        // Passed through as a POSITIVE only. Measured, 1,075,007 blocks
        // carry `is_error` NULL, which means the key was absent from the
        // source JSON; rendering that as an error would assert something
        // the block never claimed.
        isError: block.is_error === true,
        lengthLabel: Number.isFinite(block.text_length)
            ? `${block.text_length} chars` : null,
        collapsed: COLLAPSED_BY_DEFAULT[type] === true,
        dataState: content.kind === 'text' ? 'included'
            : (content.kind === 'withheld' ? 'withheld'
                : (content.kind === 'refusal' ? 'mask-refused' : 'cannot-determine')),
        content,
    };
}

/**
 * The blocks of one turn, in `seq` order.
 *
 * Description: A TURN WITH NO BLOCKS IS TWO DIFFERENT FINDINGS and they
 *   are rendered as two different sentences. An empty ARRAY is the
 *   server saying this turn carried no content blocks, a real ordinary
 *   state for some record types. A MISSING array - or a `blocks_state`
 *   this view cannot interpret - is a could-not-evaluate.
 *
 *   Sorted on a COPY. `seq` is the server's declared order; rows without
 *   one keep their received position rather than being shuffled to the
 *   front by a NaN comparison.
 * Inputs: turn.
 * Output: a TurnBody.
 */
export function turnBody(turn: ChatTurnRaw): TurnBody {
    const blocks = turn.blocks;
    const bs = turn.blocks_state;
    const known = blocksStateKnown(bs);
    const line = turn.line_no !== undefined && turn.line_no !== null
        ? String(turn.line_no) : '?';

    if (!Array.isArray(blocks) || !known) {
        const why = known
            ? 'the server sent no content blocks array for this turn'
            : `the server reported blocks_state=${String(bs)}, which this view `
                + 'cannot interpret';
        return {
            kind: 'unknown',
            sentence: `blocks of line ${line}: ${why}, so what this turn said is `
                + `${NOT_KNOWN}. That is not the same as it having said nothing.`,
        };
    }

    const raw = blocks as ChatBlockRaw[];
    if (raw.length === 0) {
        return {
            kind: 'empty',
            sentence: `No content blocks. The server looked${bs ? ` (${String(bs)})` : ''}`
                + ' and this turn carries none.',
        };
    }

    const ordered = raw.slice().sort((a, b) => {
        const x = (a && Number.isInteger(a.seq)) ? a.seq as number : 0;
        const y = (b && Number.isInteger(b.seq)) ? b.seq as number : 0;
        return x - y;
    });
    return { kind: 'blocks', blocks: ordered.map((b, i) => blockView(b, turn, i)) };
}

/**
 * Shape one whole bubble.
 *
 * Inputs: turn - the server's turn shape.
 * Output: a ChatTurnView.
 * Example: turnView({role: 'user', blocks: []}).roleText // -> 'You'
 */
export function turnView(turn: ChatTurnRaw): ChatTurnView {
    const body = turnBody(turn);
    const roleState = typeof turn.role_state === 'string' ? turn.role_state : null;
    const count = Number.isInteger(turn.secret_finding_count)
        ? turn.secret_finding_count as number : 0;
    return {
        role: typeof turn.role === 'string' && turn.role ? turn.role : 'unknown',
        roleText: roleLabel(turn),
        // A role the server INFERRED from the record type is marked, in
        // text, so nobody reads a derivation as a declaration.
        roleInferred: roleState !== null && roleState !== 'role',
        roleState,
        recordType: String(turn.record_type),
        ts: turn.ts ? String(turn.ts) : NOT_KNOWN,
        // The model is shown inline ONLY when there is one. An "unknown
        // model" chip on every user turn is noise, and a user turn
        // genuinely has no model rather than an unmeasured one. The "i"
        // panel states it either way.
        model: turn.model ? String(turn.model) : null,
        secretCount: count > 0 ? count : 0,
        lineNo: turn.line_no !== undefined && turn.line_no !== null
            ? String(turn.line_no) : null,
        bodyId: turn.body_id !== undefined && turn.body_id !== null
            ? String(turn.body_id) : null,
        expander: expanderFor(turn),
        body,
        blocksData: body.kind === 'blocks' ? String(body.blocks.length)
            : (body.kind === 'empty' ? '0' : 'cannot-determine'),
    };
}

/**
 * The collapsed progress chip's label.
 *
 * Description: progress records are 37.5 percent of every body in this
 *   corpus; rendering them as bubbles would bury the conversation in its
 *   own telemetry. The chip states the count and the line range, which
 *   is what somebody actually needs from them.
 * Inputs: run, expanded.
 * Output: the label.
 * Example: progressChipLabel({kind: 'progress-run', from: 7110, to: 7123,
 *   count: 14}, false)
 */
export function progressChipLabel(run: ProgressRun, expanded: boolean): string {
    const n = Number.isFinite(run.count) ? `${run.count} progress records`
        : 'progress records';
    return `${n} (lines ${run.from} to ${run.to})${expanded ? ' - hide' : ' - show'}`;
}

/** A stable `{#each}` key for one laid-out item. */
export function itemKey(item: ChatItem): string {
    if (isRun(item)) return `run:${item.from}`;
    const line = (item as ChatTurnRaw).line_no;
    return `turn:${String(line)}`;
}
