/**
 * THE SECURITY PROPERTY OF THE CONVERSATION VIEW, asserted against the
 * REAL masker and then against the MOUNTED component.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS IS A SEPARATE SUITE FROM THE BEHAVIOUR ONE. Behaviour asks
 * "does the chat view do what the chat view did". This asks the one
 * question whose wrong answer puts a credential on somebody's screen:
 * does every byte of block text on screen come out of
 * `reader-gate.applyMask`, and does a refusal actually withhold?
 *
 * THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF. A view that rendered
 * nothing at all would pass every disclosure assertion here perfectly, so
 * `maskableTurn` is mounted too and its masked prose MUST appear. A
 * matcher that always refuses is worse than useless.
 *
 * NOTHING IN THIS FILE ASSERTS ON A SUBSTRING OF A REASON STRING. The
 * masker's reasons carry counts, offsets and states only, never matched
 * text, and a test keyed on their wording would fail on a reword rather
 * than on a disclosure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatView from './ChatView.svelte';
import { blockText, declaredSecrets, textState, TEXT_STATE } from './chat-mask';
import { SECRET_MARKER } from './reader-mask';
import { CLASS } from './chat-vocab';
import {
    CANARY, block, fakeChatClient, maskableTurn, outcome, refusedTurn, syncRaf,
    turn, turnsPage,
} from './chat-harness';
import type { ArchiveClient } from './client';

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** Mount the view against a double. */
function mountView(client: ArchiveClient): { open(): Promise<string> } {
    host = document.createElement('div');
    document.body.appendChild(host);
    mounted = mount(ChatView, {
        target: host,
        props: { client, outcome, transcriptId: 4, raf: syncRaf } as never,
    }) as Record<string, unknown>;
    return mounted as unknown as { open(): Promise<string> };
}

/** Run the view's chain to completion. */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
        flushSync();
        await Promise.resolve();
    }
    flushSync();
}

describe('chat-mask: the pure rules', () => {
    it('READS THE SERVER\'S OWN WORD before trusting the text', () => {
        expect(textState(block({ text_state: 'withheld_secret_bearing', text: null })))
            .toBe(TEXT_STATE.WITHHELD);
        expect(textState(block({ text_state: 'included' }))).toBe(TEXT_STATE.INCLUDED);
        // A state invented after this file was written is a third
        // outcome, not a guess in either direction.
        expect(textState(block({ text_state: 'some_future_word', text: null })))
            .toBe(TEXT_STATE.UNKNOWN);
    });

    it('POISONS EVERY BLOCK OF A TURN whose declared secrets the server '
        + 'has NOT located', () => {
        const t = { secret_finding_count: 3, blocks: [block(), block({ seq: 1 })] };
        expect(declaredSecrets(t.blocks[0] as never, t)).toBe(3);
    });

    it('AND POISONS NONE OF THEM once the server has located them by '
        + 'withholding the flagged block', () => {
        // Measured live: this server withholds the text of any block it
        // flagged, reporting `withheld_secret_bearing`. When it has done
        // that it has told us exactly where the secrets are, so refusing
        // the turn's other blocks would withhold prose for no safety gain.
        const flagged = block({ seq: 1, text: null, text_state: 'withheld_secret_bearing' });
        const t = { secret_finding_count: 3, blocks: [block(), flagged] };
        expect(declaredSecrets(t.blocks[0] as never, t)).toBe(0);
    });

    it('REFUSES a block whose declared secrets have no findings array, '
        + 'and the refusal carries no text at all', () => {
        const t = refusedTurn();
        const out = blockText((t.blocks as never[])[0], t as never);
        expect(out.kind).toBe('refusal');
        expect(JSON.stringify(out)).not.toContain(CANARY);
    });

    it('MASKS a block whose finding carries a usable UTF-16 window', () => {
        const t = maskableTurn();
        const out = blockText((t.blocks as never[])[0], t as never);
        expect(out.kind).toBe('text');
        if (out.kind !== 'text') return;
        expect(out.safe).toContain(SECRET_MARKER);
        expect(out.safe).not.toContain(CANARY);
        expect(out.masked).toBe(1);
    });
});

describe('ChatView: the canary never reaches the DOM', () => {
    it('A REFUSED BLOCK RENDERS ITS REFUSAL AND NOT ONE BYTE OF ITS TEXT',
        async () => {
            const { client } = fakeChatClient({ page: turnsPage([refusedTurn()], false) });
            const api = mountView(client);
            await api.open();
            await settle();

            const painted = document.body.textContent || '';
            expect(painted).not.toContain(CANARY);
            expect(document.querySelector(`.${CLASS.refused}`)).not.toBeNull();
            // AND NOTHING ANYWHERE IN THE SUBTREE'S ATTRIBUTES EITHER: a
            // title, an aria-label or a data attribute would disclose it
            // just as thoroughly as a text node.
            expect(document.body.innerHTML).not.toContain(CANARY);
        });

    it('THE POSITIVE CONTROL: a maskable block DOES render, with the '
        + 'marker in place of the secret', async () => {
        const { client } = fakeChatClient({ page: turnsPage([maskableTurn()], false) });
        const api = mountView(client);
        await api.open();
        await settle();

        const painted = document.body.textContent || '';
        expect(painted).toContain(SECRET_MARKER);
        expect(painted).toContain('head');
        expect(painted).toContain('tail');
        expect(painted).not.toContain(CANARY);
        expect(document.body.innerHTML).not.toContain(CANARY);
    });

    it('A WITHHELD BLOCK NAMES ITS LENGTH rather than rendering as empty',
        async () => {
            const t = turn({
                blocks: [block({
                    text: null, text_state: 'withheld_secret_bearing', text_length: 4096,
                })],
            });
            const { client } = fakeChatClient({ page: turnsPage([t], false) });
            const api = mountView(client);
            await api.open();
            await settle();

            const box = document.querySelector(`.${CLASS.withheld}`);
            expect(box).not.toBeNull();
            expect(box?.getAttribute('data-text-state')).toBe('withheld');
            expect(box?.textContent).toContain('4096');
            expect(box?.textContent).toContain('withheld_secret_bearing');
        });
});
