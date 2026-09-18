/**
 * THE CONTROL THAT FAILS IF THE CHAT VIEW EVER RENDERS AN UNMASKED BODY.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `chat-mask.test.ts`. That file
 * proves the masker refuses and that a refusal does not disclose. It
 * CANNOT prove that the renderer is reading the masker's output rather
 * than the block it was handed - a component that ignored `applyMask`
 * entirely and painted `block.text` would still pass every one of those
 * assertions for a block with NO declared secrets, which is the vast
 * majority of the corpus. The gap is exactly where a credential would
 * come through.
 *
 * SO THE MASKER IS REPLACED WITH A SENTINEL AND THE SCREEN IS READ. The
 * stub returns a string that appears in no fixture and could not be
 * produced by any other path, and the raw block text is a different
 * string that must appear NOWHERE. If the painted text is the sentinel,
 * the render path went through `applyMask`. If it is the raw text, it did
 * not. There is no third answer, and no wording to drift.
 *
 * WATCHED GO RED. Pointing `ChatBlock` at the raw block instead of
 * `view.content` fails the first assertion below with the raw string in
 * hand; that is the whole point of writing it this way rather than
 * asserting that a spy was called, which a renderer could satisfy while
 * still painting whatever it liked.
 *
 * `vi.mock` IS FILE-SCOPED AND HOISTED, which is why this is its own
 * file: a stubbed masker in the suite next door would silently disarm its
 * real-masker canary tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

/** Text no fixture contains and no code path can produce but the stub. */
const SENTINEL = 'MASKER-OUTPUT-SENTINEL-4f19';

/** Text the RAW block carries. Its presence on screen is the failure. */
const RAW = 'RAW-BLOCK-TEXT-THAT-MUST-NEVER-BE-PAINTED';

vi.mock('./reader-gate', async (importActual) => {
    const actual = await importActual<typeof import('./reader-gate')>();
    return {
        ...actual,
        // The ONE function the chat family is allowed to turn body text
        // into renderable text with. Everything else in the module is
        // left real, so nothing unrelated is being tested against a
        // double.
        applyMask: () => ({
            state: 'included' as const,
            text: SENTINEL,
            masked: 0,
            reason: null,
            findingCount: 0,
        }),
    };
});

const { default: ChatView } = await import('./ChatView.svelte');
const { block, fakeChatClient, outcome, syncRaf, turn, turnsPage } = await import('./chat-harness');
const { CLASS } = await import('./chat-vocab');
type ArchiveClient = import('./client').ArchiveClient;

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

describe('ChatView: rendered block text comes from applyMask and nowhere else', () => {
    it('PAINTS THE MASKER\'S OUTPUT, not the block it was handed', async () => {
        const t = turn({
            blocks: [block({ text: RAW, text_length: RAW.length })],
            secret_finding_count: 0,
        });
        const { client } = fakeChatClient({ page: turnsPage([t], false) });
        const api = mountView(client);
        await api.open();
        await settle();

        const painted = document.querySelector(`.${CLASS.bodyText}`);
        expect(painted).not.toBeNull();
        expect(painted?.textContent).toBe(SENTINEL);
        // THE HALF THAT MAKES IT A CONTROL. A renderer reading the raw
        // block would put this on screen, and the assertion above could
        // not tell that apart from a stub that simply was not called.
        expect(document.body.innerHTML).not.toContain(RAW);
    });

    it('AND DOES SO FOR A COLLAPSED BLOCK TOO, which renders through a '
        + 'different branch of the template', async () => {
        const t = turn({
            blocks: [block({ type: 'tool_result', text: RAW, text_length: RAW.length })],
            secret_finding_count: 0,
        });
        const { client } = fakeChatClient({ page: turnsPage([t], false) });
        const api = mountView(client);
        await api.open();
        await settle();

        // The disclosure exists and its content is the masker's output.
        expect(document.querySelector(`.${CLASS.disclosure}`)).not.toBeNull();
        expect(document.querySelector(`.${CLASS.bodyText}`)?.textContent).toBe(SENTINEL);
        expect(document.body.innerHTML).not.toContain(RAW);
    });

    it('AND FOR A TRUNCATED BLOCK, whose note wraps the same text node',
        async () => {
            const t = turn({
                blocks: [block({ text: RAW, text_length: 9000, text_truncated: true })],
                secret_finding_count: 0,
            });
            const { client } = fakeChatClient({ page: turnsPage([t], false) });
            const api = mountView(client);
            await api.open();
            await settle();

            expect(document.querySelector(`.${CLASS.truncated}`)).not.toBeNull();
            expect(document.querySelector(`.${CLASS.bodyText}`)?.textContent).toBe(SENTINEL);
            expect(document.body.innerHTML).not.toContain(RAW);
        });
});
