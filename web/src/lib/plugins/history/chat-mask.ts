/**
 * THE ONLY PLACE IN THE CONVERSATION VIEW WHERE A STORED BLOCK'S TEXT IS
 * READ, and therefore the only place this feature could disclose a
 * credential.
 *
 * Ported from the masking half of `client/js/archive-chat-block.js`,
 * rule for rule. WHAT CHANGED IS THE SHAPE, NOT THE POLICY: the vanilla
 * read `block.text` inside the renderer and masked it there; this
 * returns a `ChatBlockText` whose renderable string is produced ONLY by
 * `applyMask`, so the component that paints it never holds the raw
 * block at all.
 *
 * IT GOES THROUGH SLICE 7's PATH, NOT AROUND IT. `applyMask` (and under
 * it `maskBody`) is a HARD IMPORT with no optional path and no injected
 * seam, for the reason `reader-mask.ts`'s own header gives: an injected
 * masker a composition root forgets to supply is a fail-OPEN gate - the
 * text renders, unmasked, with the credential on screen, and every
 * rendering test passes. The chat view renders the SAME stored bytes in
 * a different shape, so it inherits the same rule and the same refusal.
 * There is no second masker here, no second set of thresholds, and no
 * "chat variant" of the contract.
 *
 * `.text` APPEARS IN THIS FILE AND NOWHERE ELSE IN THE CHAT FAMILY, and
 * that is asserted rather than promised - see
 * `ChatView.commitments.test.ts`. The vanilla stated the same rule as a
 * grep somebody had to remember to run.
 *
 * THE PESSIMISTIC DIRECTION IS DELIBERATE. A turn declares
 * `secret_finding_count`; a block carries no `secrets` array at all on
 * this server (measured: `src/core/message_block_preview.py` withholds
 * the whole preview instead). So when a turn declares secrets and the
 * server has NOT located them by withholding a block, every block of
 * that turn is poisoned and refuses. That withholds more prose than
 * strictly necessary, and it is the correct direction to be wrong in:
 * half-masked output does not look like a failure, it looks like a
 * success with a short hex tail that reads as prose.
 *
 * NO DOM, NO FRAMEWORK, NO FETCH.
 */
import { applyMask } from './reader-gate';
import { BODY_STATE } from './reader-vocab';
import type { SecretFinding } from './reader-mask';
import { NOT_KNOWN } from './chat-vocab';

/**
 * One entry of a turn's `blocks`, as the server sends it.
 *
 * Description: every field is `unknown` on purpose. This module is fed
 *   straight off the wire and may not assume the server kept its shape;
 *   each reader below narrows exactly what it needs.
 */
export interface ChatBlockRaw {
    readonly seq?: unknown;
    readonly type?: unknown;
    readonly text?: unknown;
    readonly text_state?: unknown;
    readonly state?: unknown;
    readonly body_state?: unknown;
    readonly text_length?: unknown;
    readonly text_truncated?: unknown;
    readonly tool_name?: unknown;
    readonly tool_use_id?: unknown;
    readonly is_error?: unknown;
    readonly secrets?: unknown;
    readonly secret_finding_count?: unknown;
}

/** The turn fields this module reads. It reads nothing else, ever. */
export interface ChatTurnSecrets {
    readonly blocks?: unknown;
    readonly secrets?: unknown;
    readonly secret_finding_count?: unknown;
}

/** The three text states this module can put a block in. */
export const TEXT_STATE = {
    INCLUDED: 'included',
    WITHHELD: 'withheld',
    UNKNOWN: 'cannot-determine',
} as const;

/** One text state. */
export type TextState = (typeof TEXT_STATE)[keyof typeof TEXT_STATE];

/** Text the masker approved. The `safe` field is ALWAYS a string. */
export interface ChatTextSafe {
    readonly kind: 'text';
    /**
     * The renderable string.
     *
     * NAMED `safe`, NOT `text`, ON PURPOSE. The commitments test asserts
     * that `.text` appears nowhere in the chat family outside this file,
     * which makes "did anything read the raw block" a mechanical
     * question. A field called `text` on the OUTPUT would defeat that
     * check by matching it everywhere the output is rendered.
     */
    readonly safe: string;
    /** How many windows the masker replaced. */
    readonly masked: number;
    /** Set when the SERVER truncated the preview; null otherwise. */
    readonly truncated: { readonly shown: number | null; readonly full: number | null } | null;
}

/** The masker refused. No text is carried, by construction. */
export interface ChatTextRefused {
    readonly kind: 'refusal';
    readonly head: string;
    readonly why: string;
    readonly findingCount: number;
}

/** The server holds this block's text and chose not to send it. */
export interface ChatTextWithheld {
    readonly kind: 'withheld';
    readonly head: string;
    readonly size: string;
    readonly why: string;
}

/** Whether there is content here at all could not be determined. */
export interface ChatTextUnknown {
    readonly kind: 'unknown';
    readonly head: string;
    readonly size: string;
    readonly why: string;
}

/** What `blockText` answers. There is no fifth shape. */
export type ChatBlockText =
    | ChatTextSafe | ChatTextRefused | ChatTextWithheld | ChatTextUnknown;

/**
 * Decide, from whatever the server sent, whether this block's text was
 * INCLUDED, WITHHELD, or cannot be determined.
 *
 * Description: tolerant of the field NAME because the contract names the
 *   field only by its meaning; intolerant of guessing, because a wrong
 *   guess renders a withheld block as an empty one.
 * Inputs: block - one entry from a turn's `blocks`.
 * Output: one of TEXT_STATE.
 * Example: textState({text: 'hi'}) // -> 'included'
 */
export function textState(block: ChatBlockRaw | null | undefined): TextState {
    if (!block || typeof block !== 'object') return TEXT_STATE.UNKNOWN;
    const raw = rawStateOf(block);
    if (typeof raw === 'string') {
        if (raw === 'included') return TEXT_STATE.INCLUDED;
        // Every withheld_* spelling the archive uses means the same
        // thing to a reader: the server has it and chose not to send it.
        // The REASON is rendered from the raw value.
        if (raw.indexOf('withheld') === 0) return TEXT_STATE.WITHHELD;
        if (raw === 'not_requested') return TEXT_STATE.WITHHELD;
        return TEXT_STATE.UNKNOWN;
    }
    // No state field. Derive only where the derivation is total.
    if (typeof block.text === 'string') return TEXT_STATE.INCLUDED;
    const n = block.text_length;
    if (Number.isFinite(n) && (n as number) > 0) return TEXT_STATE.WITHHELD;
    if (n === 0) return TEXT_STATE.INCLUDED;
    return TEXT_STATE.UNKNOWN;
}

/** The server's own word for this block's text state, whatever it called it. */
function rawStateOf(block: ChatBlockRaw): unknown {
    if (block.text_state !== undefined && block.text_state !== null) return block.text_state;
    if (block.state !== undefined && block.state !== null) return block.state;
    return block.body_state;
}

/**
 * Has the server already withheld a block of this turn BECAUSE it was
 * secret-bearing?
 *
 * Description: that is the server LOCATING the secrets for us, which is
 *   what makes it safe not to poison the turn's other blocks.
 * Inputs: turn - the owning turn.
 * Output: true when at least one block was withheld for a secret reason.
 */
function turnWithholdsForSecrets(turn: ChatTurnSecrets): boolean {
    const blocks = turn.blocks;
    if (!Array.isArray(blocks)) return false;
    for (const b of blocks as ChatBlockRaw[]) {
        const raw = b ? rawStateOf(b) : null;
        if (typeof raw === 'string' && raw.indexOf('secret') !== -1
            && raw.indexOf('withheld') === 0) {
            return true;
        }
    }
    return false;
}

/**
 * How many secret findings are believed to be in this block's text.
 *
 * Description: a BLOCK-level count wins; otherwise the TURN's count is
 *   used, which is the pessimistic choice explained in the file header.
 *   Measured live 2026-09-01: this server WITHHOLDS the text of any
 *   block it flagged, reporting `text_state: withheld_secret_bearing`
 *   and the full length. When it has done that, it has told us exactly
 *   where the secrets are and the turn's other blocks are not carrying
 *   an unlocated one, so refusing them too would withhold prose for no
 *   safety gain. When NO block is withheld for that reason, the count is
 *   a credential at an unknown position and every block in the turn is
 *   refused.
 * Inputs: block, turn.
 * Output: an integer, never NaN.
 * Example: declaredSecrets({}, {secret_finding_count: 3}) // -> 3
 */
export function declaredSecrets(
    block: ChatBlockRaw, turn: ChatTurnSecrets | null | undefined,
): number {
    if (Number.isInteger(block.secret_finding_count)) {
        return block.secret_finding_count as number;
    }
    if (!turn || !Number.isInteger(turn.secret_finding_count)
        || (turn.secret_finding_count as number) <= 0) {
        return 0;
    }
    if (turnWithholdsForSecrets(turn)) return 0;
    return turn.secret_finding_count as number;
}

/**
 * The findings array to mask this block with, if any.
 *
 * Description: block-level first, then the turn's. `null` and `[]` are
 *   NOT the same to `maskBody` - case 1 against case 2 of its contract -
 *   and are passed through unflattened.
 * Inputs: block, turn.
 * Output: the array, or null.
 */
export function findingsFor(
    block: ChatBlockRaw, turn: ChatTurnSecrets | null | undefined,
): readonly SecretFinding[] | null {
    if (Array.isArray(block.secrets)) return block.secrets as SecretFinding[];
    if (turn && Array.isArray(turn.secrets)) return turn.secrets as SecretFinding[];
    return null;
}

/**
 * Turn one block into something renderable, through the masker.
 *
 * Description: THE SEAM. Everything a chat template ever paints as block
 *   content comes out of here, and the only branch that produces a
 *   string calls `applyMask` first. A refusal, a withhold and a
 *   could-not-determine each carry their own sentences and no text at
 *   all.
 * Inputs: block - one entry of a turn's `blocks`. turn - the owning
 *   turn, read ONLY for its secret count and findings.
 * Output: a ChatBlockText.
 * Example: blockText({type: 'text', text: 'hi'}, null).kind // -> 'text'
 */
export function blockText(
    block: ChatBlockRaw | null | undefined,
    turn: ChatTurnSecrets | null | undefined,
): ChatBlockText {
    const b: ChatBlockRaw = (block && typeof block === 'object') ? block : {};
    const state = textState(b);
    if (state === TEXT_STATE.WITHHELD) return withheldText(b);
    if (state === TEXT_STATE.UNKNOWN) return unknownText(b);

    const masked = applyMask(b.text, findingsFor(b, turn), declaredSecrets(b, turn));
    if (masked.state === BODY_STATE.MASK_REFUSED || masked.text === null) {
        return {
            kind: 'refusal',
            head: `NOT SHOWN. This text carries ${masked.findingCount} flagged `
                + 'secret(s) that could not be masked safely, so none of it is '
                + 'rendered.',
            why: `Reason: ${masked.reason ?? NOT_KNOWN}`,
            findingCount: masked.findingCount,
        };
    }

    // TRUNCATION IS A PARTIAL ANSWER AND MUST SAY SO. Measured live
    // 2026-09-01 on transcript 4: 143 of 400 blocks came back truncated
    // at the server's 400-character preview gate. Text that simply
    // stops, with no marker, reads as the whole thing.
    const truncated = b.text_truncated === true
        ? {
            shown: masked.text.length,
            full: Number.isFinite(b.text_length) ? b.text_length as number : null,
        }
        : null;
    return { kind: 'text', safe: masked.text, masked: masked.masked, truncated };
}

/** The WITHHELD sentences. Names the length and the server's own reason. */
function withheldText(block: ChatBlockRaw): ChatTextWithheld {
    const n = block.text_length;
    const raw = rawStateOf(block);
    return {
        kind: 'withheld',
        head: 'WITHHELD BY THE SERVER. Not empty: this block has content that '
            + 'was not sent.',
        size: Number.isFinite(n) ? `Length: ${n} characters.` : `Length: ${NOT_KNOWN}.`,
        why: `Server reason: ${raw ? String(raw) : 'NOT STATED'}`,
    };
}

/**
 * The could-not-determine sentences.
 *
 * Description: A FORCED CHOICE, NAMED. The vanilla rendered this state
 *   through `archive-outcome-view.js`, which is slice 9's port; reaching
 *   for that global here would be the injected-seam anti-pattern this
 *   slice's masker deliberately avoids. So the same finding is stated in
 *   words inside the block family's own `__withheld` box, distinguished
 *   from a real withhold by `data-text-state="cannot-determine"` and by
 *   the sentences themselves. No class name is invented.
 * Inputs: block. Output: a ChatTextUnknown.
 */
function unknownText(block: ChatBlockRaw): ChatTextUnknown {
    const seq = Number.isInteger(block.seq) ? String(block.seq) : '?';
    return {
        kind: 'unknown',
        head: `${NOT_KNOWN}. Whether block ${seq} carries content could not be `
            + 'established.',
        size: Number.isFinite(block.text_length)
            ? `Length: ${block.text_length} characters.`
            : `Length: ${NOT_KNOWN}.`,
        why: 'The server did not say whether this block\'s text was included or '
            + 'withheld, and the block carries no text, so whether there is '
            + 'content here is NOT KNOWN. That is not the same as it being empty.',
    };
}
