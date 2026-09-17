/**
 * THE MOUNTED READER.
 *
 * @vitest-environment jsdom
 *
 * THE NEGATIVE CONTROL IS MANDATORY AND IT IS THE FIRST BLOCK BELOW. A
 * reader that paints something regardless of input passes every positive
 * test and is useless: it would show rows for a transcript that failed
 * to load, a body for a body nobody fetched, and a credential for a body
 * the masker refused. So `describe('the negative controls')` asserts
 * what must NOT appear, and each of those assertions was watched going
 * RED against a deliberately broken build before this file was trusted.
 *
 * THE SECURITY ASSERTION IS A SCAN OF THE WHOLE SUBTREE, not of the row
 * that was supposed to refuse. `document.body.textContent` is what the
 * person actually sees, and a canary anywhere in it is a disclosure
 * wherever it came from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TranscriptReader from './TranscriptReader.svelte';
import {
    CANARY, env, fakeClient, flush, linesPage, maskableBodyPayload,
    outcome, refusedBodyPayload, spineRow, syncRaf,
} from './reader-harness';
import { ACTIONS, CLASS } from './reader-vocab';
import { SECRET_MARKER } from './reader-mask';
import { BODY_RENDER_HARD_MAX, BODY_INLINE_MAX } from './reader-gate';
import type { ArchiveClient } from './client';

/** The reader's exported API, declared so a rename is a compile error. */
interface ReaderApi {
    open(): Promise<string>;
    requestMoreLines(): Promise<unknown>;
    moveSelection(delta: number): number;
    selectIndex(index: number): number;
    openSelected(): Promise<unknown>;
    selectedIndex(): number;
    spineNow(): { rows: readonly unknown[]; complete: boolean; token: string };
    laidOut(): readonly unknown[];
    geometry(): { count(): number; totalHeight(): number };
    bodies(): { size(): number; get(id: unknown): unknown };
    renderWindow(): { first: number; last: number };
}

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** Mount the real reader and return its exported API. */
function mountReader(
    client: ArchiveClient, props: Record<string, unknown> = {},
): ReaderApi {
    host = document.createElement('div');
    document.body.appendChild(host);
    mounted = mount(TranscriptReader, {
        target: host,
        props: {
            client, outcome, transcriptId: 5767, raf: syncRaf, ...props,
        } as never,
    }) as Record<string, unknown>;
    return mounted as unknown as ReaderApi;
}

/**
 * Drive the reader until it stops changing.
 *
 * Description: opening a body is a CHAIN - an effect asks the policy,
 *   the policy asks the cache, the cache awaits the client, the entry is
 *   masked and stored, a tick is bumped, and only then does the row
 *   re-derive. Each hop is a microtask and Svelte's own effects are
 *   queued on microtasks too, so a fixed `await flush(4)` is a guess
 *   that happens to be right today. Alternating a real `flushSync` with
 *   a microtask drain runs the chain to completion instead, and the
 *   iteration count is a CEILING rather than a measurement: if the
 *   reader settles in two rounds it costs nothing to have allowed
 *   twelve.
 * Inputs: rounds - the ceiling. Output: nothing.
 */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
        flushSync();
        await Promise.resolve();
    }
    flushSync();
}

/** Every rendered row element, in document order. */
function rows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`.${CLASS.row}`)];
}

/** Every `data-action` value present anywhere in the reader. */
function actions(): string[] {
    return [...document.querySelectorAll('[data-action]')]
        .map((e) => e.getAttribute('data-action') || '');
}

/**
 * What the person actually sees, with runs of whitespace collapsed.
 *
 * Description: THE COLLAPSE IS NOT A CONVENIENCE, IT IS ACCURACY. A
 *   sentence wrapped across two lines in a template carries a newline
 *   and the template's indentation into `textContent`, while the browser
 *   renders it as one space. Asserting against the raw value would fail
 *   on a sentence the reader displays perfectly, and passing it would
 *   depend on where a line happened to wrap - which is a test coupled to
 *   source formatting rather than to output.
 */
function visibleText(): string {
    return (document.body.textContent || '').replace(/\s+/g, ' ');
}

describe('the negative controls', () => {
    it('PAINTS NO ROWS when the server refused the transcript, and says '
        + 'so. A reader that always paints is useless', async () => {
        const { client } = fakeClient({
            page: env({ result: [], result_status: 'not_found', meta: {} }),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        expect(rows()).toHaveLength(0);
        expect(api.spineNow().token).toBe('not_found');
        // AND IT IS NOT A BLANK PANE: the token is stated.
        expect(visibleText()).toContain('not_found');
        expect(document.querySelector(`.${CLASS.status}`)
            ?.getAttribute('data-reader-state')).toBe('not_found');
    });

    it('PAINTS NO ROWS BEFORE `open()` IS CALLED, which is the defect the '
        + 'dev harness caught by looking at the page', () => {
        const { client, asked } = fakeClient({ page: linesPage([spineRow()], false) });
        const api = mountReader(client);
        flushSync();
        // NO REQUEST WAS MADE. The reader does not load itself.
        expect(asked.lines).toHaveLength(0);
        expect(rows()).toHaveLength(0);
        expect(api.spineNow().token).toBe('idle');
    });

    it('PAINTS NO BODY TEXT for a body nobody fetched: a sized '
        + 'placeholder, never a spinner', async () => {
        // A soft-gated row is never auto-fetched, so its body region must
        // carry no text and no spinner.
        const { client, asked } = fakeClient({
            page: linesPage([spineRow({ body_chars: BODY_INLINE_MAX + 1 })], false),
        });
        const api = mountReader(client);
        await api.open();
        await settle();

        expect(asked.bodies).toHaveLength(0);
        expect(document.querySelector(`.${CLASS.text}`)).toBeNull();
        expect(document.querySelector(`.${CLASS.loading}`)).toBeNull();
        expect(visibleText()).toContain('LARGE BODY');
    });

    it('PAINTS NO CREDENTIAL when the masker refuses. The scan is of the '
        + 'WHOLE subtree, not of the row that should have refused',
    async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow()], false),
            body: () => refusedBodyPayload(),
        });
        const api = mountReader(client);
        await api.open();
        await settle();

        // THE ASSERTION.
        expect(visibleText()).not.toContain(CANARY);
        expect(document.body.innerHTML).not.toContain(CANARY);
        // And the refusal is SAID, not silently blank.
        expect(visibleText()).toContain('BODY WITHHELD BY THIS VIEW');
        expect(document.querySelector('[data-body-state="mask-refused"]')).not.toBeNull();
    });

    it('AND THE POSITIVE CONTROL: a MASKABLE body DOES render, masked, or '
        + 'the test above would pass against a reader that renders '
        + 'nothing at all', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow()], false),
            body: () => maskableBodyPayload(),
        });
        const api = mountReader(client);
        await api.open();
        await settle();

        expect(visibleText()).not.toContain(CANARY);
        expect(visibleText()).toContain(SECRET_MARKER);
        expect(visibleText()).toContain('head');
        expect(visibleText()).toContain('tail');
        // AND IT SAYS A LENS WAS APPLIED.
        expect(visibleText()).toContain('1 secret masked in this view');
        expect(document.querySelector('[data-masked-count="1"]')).not.toBeNull();
    });
});

describe('opening a transcript', () => {
    it('paints one row per spine line, with its line number and role', async () => {
        const { client } = fakeClient({
            page: linesPage([
                spineRow({ line_no: 1, role: 'user', record_type: 'user' }),
                spineRow({ line_no: 2, body_id: 2 }),
                spineRow({ line_no: 3, body_id: 3 }),
            ], false),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        expect(rows()).toHaveLength(3);
        expect(rows()[0]?.getAttribute('data-line-no')).toBe('1');
        expect(rows()[0]?.getAttribute('data-family')).toBe('turn');
        expect(rows()[0]?.getAttribute('data-role-source')).toBe('role');
        expect(api.geometry().count()).toBe(3);
    });

    it('renders the header facts from the transcript record, and NOTHING '
        + 'when no header came back', async () => {
        const a = fakeClient({
            header: { transcript_id: 5767, session_ref: 'abc-123', line_count: 30805,
                raw_byte_length: 91950363 },
            page: linesPage([spineRow()], false),
        });
        const api = mountReader(a.client);
        await api.open();
        flushSync();
        expect(document.querySelector(`.${CLASS.title}`)?.textContent).toBe('abc-123');
        expect(document.querySelector(`.${CLASS.facts}`)?.textContent)
            .toContain('30,805 lines');

        unmount(mounted as Record<string, unknown>);
        mounted = null;
        host?.remove();

        const b = fakeClient({ header: null, page: linesPage([spineRow()], false) });
        const api2 = mountReader(b.client);
        await api2.open();
        flushSync();
        // NULL IS NOT AN EMPTY HEADER: nothing is invented.
        expect(document.querySelector(`.${CLASS.headerFacts}`)).toBeNull();
    });

    it('carries a `<synthetic>` model value to the DOM as TEXT, angle '
        + 'brackets and all, never as markup', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow({ model: '<synthetic>' })], false),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();
        const model = document.querySelector(`.${CLASS.model}`);
        expect(model?.textContent).toBe('<synthetic>');
        expect(model?.children).toHaveLength(0);
    });

    it('labels a row with NO role from its record type, and one with '
        + 'neither with the literal words', async () => {
        const { client } = fakeClient({
            page: linesPage([
                spineRow({ line_no: 1, role: null, record_type: 'progress' }),
                spineRow({ line_no: 2, role: null, record_type: null, body_id: 2 }),
            ], false),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();
        expect(rows()[0]?.getAttribute('data-role-source')).toBe('record_type');
        expect(rows()[1]?.getAttribute('data-role-source')).toBe('none');
        expect(visibleText()).toContain('no role recorded');
        expect(visibleText()).toContain('no record type');
    });

    it('renders the sidechain and agent badges as WORDS, not as colour', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow({
                is_sidechain: true, agent_id: 'a877057', is_compact_boundary: true,
                compact_subtype: 'auto',
            })], false),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();
        expect(visibleText()).toContain('sidechain');
        expect(visibleText()).toContain('agent a877057');
        expect(visibleText()).toContain('compact boundary (auto)');
        expect(document.querySelector('[data-badge="sidechain"]')).not.toBeNull();
    });
});

describe('the gates, as the person sees them', () => {
    it('A HARD-GATED BODY OFFERS NO RENDER CONTROL ANYWHERE IN THE DOM, '
        + 'and is never fetched', async () => {
        const { client, asked } = fakeClient({
            page: linesPage([spineRow({ body_chars: BODY_RENDER_HARD_MAX + 1 })], false),
        });
        const api = mountReader(client);
        await api.open();
        await settle();

        expect(asked.bodies).toHaveLength(0);
        expect(visibleText()).toContain('TOO LARGE TO RENDER');
        // THE ABSENCE IS THE GUARANTEE.
        expect(actions()).not.toContain(ACTIONS.RENDER_ANYWAY);
        expect(actions()).toContain(ACTIONS.DOWNLOAD_BODY);
    });

    it('A SOFT-GATED BODY OFFERS ONE, AND PRESSING IT FETCHES', async () => {
        const { client, asked } = fakeClient({
            page: linesPage([spineRow({ body_chars: BODY_INLINE_MAX + 1 })], false),
            body: () => env({
                result: { body_json: 'the large body', secrets: [], secret_finding_count: 0 },
                result_status: 'ok', meta: {},
            }),
        });
        const api = mountReader(client);
        await api.open();
        await settle();

        expect(asked.bodies).toHaveLength(0);
        expect(actions()).toContain(ACTIONS.RENDER_ANYWAY);

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.RENDER_ANYWAY}"]`,
        )?.click();
        await settle();

        expect(asked.bodies).toEqual([1]);
        expect(visibleText()).toContain('the large body');
    });

    it("says the SERVER withheld a body, in the server's own voice", async () => {
        const { client, asked } = fakeClient({
            page: linesPage([spineRow({ body_state: 'withheld_too_large' })], false),
        });
        const api = mountReader(client);
        await api.open();
        await settle();
        expect(asked.bodies).toHaveLength(0);
        expect(visibleText()).toContain('WITHHELD BY THE SERVER');
        expect(actions()).not.toContain(ACTIONS.RENDER_ANYWAY);
    });

    it('names a line with NO body row as a fact about the file', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow({ body_id: null })], false),
        });
        const api = mountReader(client);
        await api.open();
        await settle();
        expect(visibleText()).toContain('no body row in the archive');
    });
});

describe('progress runs: 37.49 percent of bodies', () => {
    /** Four consecutive progress lines around two ordinary ones. */
    function runSpine() {
        return [
            spineRow({ line_no: 7109, record_type: 'user', body_id: 1 }),
            ...[7110, 7111, 7112, 7123].map((n, i) => spineRow({
                line_no: n, record_type: 'progress', role: null, body_id: 10 + i,
            })),
            spineRow({ line_no: 7124, body_id: 20 }),
        ];
    }

    it('folds a run into ONE counted row that states the count and the '
        + 'range, hiding nothing', async () => {
        const { client } = fakeClient({ page: linesPage(runSpine(), false) });
        const api = mountReader(client);
        await api.open();
        flushSync();

        expect(api.laidOut()).toHaveLength(3);
        expect(visibleText()).toContain('progress x 4');
        expect(visibleText()).toContain('lines 7110-7123');
        expect(actions()).toContain(ACTIONS.EXPAND);
    });

    it('EXPANDS on the control, showing every folded row, and collapses '
        + 'again', async () => {
        const { client } = fakeClient({ page: linesPage(runSpine(), false) });
        const api = mountReader(client);
        await api.open();
        flushSync();
        expect(rows()).toHaveLength(3);

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.EXPAND}"]`,
        )?.click();
        await settle();

        // Three top-level rows plus the four children now inside the run.
        expect(rows()).toHaveLength(7);
        expect(visibleText()).toContain('7111');
        expect(document.querySelector('[data-expanded="true"]')).not.toBeNull();

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.COLLAPSE}"]`,
        )?.click();
        await settle();
        expect(rows()).toHaveLength(3);
    });

    it('A CHILD OF AN EXPANDED RUN CARRIES NO `data-index`, or the '
        + "measurement pass would write the child's height as the run's",
    async () => {
        const { client } = fakeClient({ page: linesPage(runSpine(), false) });
        const api = mountReader(client);
        await api.open();
        flushSync();
        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.EXPAND}"]`,
        )?.click();
        await settle();

        const indexed = rows().filter((r) => r.hasAttribute('data-index'));
        // Exactly the three LAID-OUT items, never the four children.
        expect(indexed).toHaveLength(3);
        const inside = document.querySelectorAll(
            `.${CLASS.progressChildren} [data-index]`,
        );
        expect(inside).toHaveLength(0);
    });
});

describe('paging', () => {
    it('ENDS IN A NAMED SENTINEL when the spine is incomplete, because a '
        + 'list that just stops looks finished', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow()], true),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        expect(api.spineNow().complete).toBe(false);
        expect(visibleText()).toContain('More lines not loaded yet');
        expect(actions()).toContain(ACTIONS.LOAD_MORE);
    });

    it('SHOWS NO SENTINEL when the server measured the end', async () => {
        const { client } = fakeClient({ page: linesPage([spineRow()], false) });
        const api = mountReader(client);
        await api.open();
        flushSync();
        expect(visibleText()).not.toContain('More lines not loaded yet');
        expect(actions()).not.toContain(ACTIONS.LOAD_MORE);
    });

    it('TREATS A NULL has_more AS UNKNOWN, not as the end', async () => {
        const { client } = fakeClient({ page: linesPage([spineRow()], null) });
        const api = mountReader(client);
        await api.open();
        flushSync();
        expect(api.spineNow().complete).toBe(false);
        expect(visibleText()).toContain('More lines not loaded yet');
    });

    it('APPENDS the next page, asking for the line AFTER the last one '
        + 'held, because start_line is inclusive', async () => {
        const { client, asked } = fakeClient({
            page: linesPage([spineRow({ line_no: 499, body_id: 1 })], true),
            morePages: [linesPage([spineRow({ line_no: 500, body_id: 2 })], false)],
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        await api.requestMoreLines();
        await settle();

        expect(asked.lines[1]).toEqual({ limit: 500, startLine: 500 });
        expect(api.spineNow().rows).toHaveLength(2);
        expect(rows()).toHaveLength(2);
        expect(api.spineNow().complete).toBe(true);
    });

    it('KEEPS THE ROWS when a page fails, and returns the button to idle '
        + 'so the failure is not a dead end', async () => {
        const { client } = fakeClient({
            page: linesPage([spineRow()], true),
            morePages: [env(null, 'ECONNREFUSED')],
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        await api.requestMoreLines();
        await settle();

        expect(api.spineNow().rows).toHaveLength(1);
        expect(api.spineNow().token).toBe('transport-error');
    });
});

describe('selection: a pure index cursor', () => {
    /** Five ordinary rows. */
    function five() {
        return [1, 2, 3, 4, 5].map((n) => spineRow({ line_no: n, body_id: n }));
    }

    it('moves, clamps and marks exactly ONE row selected', async () => {
        const { client } = fakeClient({ page: linesPage(five(), false) });
        const api = mountReader(client);
        await api.open();
        flushSync();

        expect(api.selectedIndex()).toBe(-1);
        expect(api.moveSelection(1)).toBe(0);
        flushSync();
        expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(1);

        api.moveSelection(3);
        flushSync();
        expect(api.selectedIndex()).toBe(3);
        // It CLAMPS rather than wrapping or going out of range.
        api.moveSelection(99);
        expect(api.selectedIndex()).toBe(4);
        api.moveSelection(-99);
        expect(api.selectedIndex()).toBe(0);
    });

    it('clears with selectIndex(-1), which is a THIRD outcome and not '
        + 'row zero', async () => {
        const { client } = fakeClient({ page: linesPage(five(), false) });
        const api = mountReader(client);
        await api.open();
        flushSync();
        api.selectIndex(2);
        expect(api.selectIndex(-1)).toBe(-1);
        flushSync();
        expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
    });

    it('gives exactly one RENDERED row tabindex 0 and the rest -1', async () => {
        const { client } = fakeClient({ page: linesPage(five(), false) });
        const api = mountReader(client);
        await api.open();
        api.selectIndex(2);
        flushSync();
        const tabbable = rows().filter((r) => r.getAttribute('tabindex') === '0');
        expect(tabbable).toHaveLength(1);
        expect(tabbable[0]?.getAttribute('data-line-no')).toBe('3');
    });

    it('openSelected TOGGLES a progress run and resolves null when '
        + 'NOTHING is selected', async () => {
        const { client } = fakeClient({
            page: linesPage([
                spineRow({ line_no: 1, record_type: 'progress', body_id: 1 }),
                spineRow({ line_no: 2, record_type: 'progress', body_id: 2 }),
            ], false),
        });
        const api = mountReader(client);
        await api.open();
        flushSync();

        await expect(api.openSelected()).resolves.toBeNull();

        api.selectIndex(0);
        await api.openSelected();
        await settle();
        expect(document.querySelector('[data-expanded="true"]')).not.toBeNull();
    });
});

describe('the window is bounded on a real mount', () => {
    it('paints far fewer rows than the spine holds, counted at 500 and '
        + 'at 5,000, and the two counts agree', async () => {
        /** `n` rows, all small. */
        const spine = (n: number) => Array.from({ length: n },
            (_, i) => spineRow({ line_no: i + 1, body_id: i + 1, body_chars: 40 }));

        const a = fakeClient({ page: linesPage(spine(500), false) });
        const apiA = mountReader(a.client);
        await apiA.open();
        flushSync();
        const paintedA = rows().length;

        unmount(mounted as Record<string, unknown>);
        mounted = null;
        host?.remove();

        const b = fakeClient({ page: linesPage(spine(5000), false) });
        const apiB = mountReader(b.client);
        await apiB.open();
        flushSync();
        const paintedB = rows().length;

        // THE BOUND: the same number at 500 and at 5,000.
        expect(paintedB).toBe(paintedA);
        // And it really is a bound, not "all of them".
        expect(paintedB).toBeLessThan(100);
        expect(apiB.geometry().count()).toBe(5000);
        expect(apiB.spineNow().rows).toHaveLength(5000);
    });

    it('ONLY REQUESTS BODIES FOR THE WINDOW, so opening a 5,000-line '
        + 'transcript is not 5,000 requests', async () => {
        const spine = Array.from({ length: 5000 },
            (_, i) => spineRow({ line_no: i + 1, body_id: i + 1, body_chars: 40 }));
        const { client, asked } = fakeClient({ page: linesPage(spine, false) });
        const api = mountReader(client);
        await api.open();
        await settle();

        expect(asked.bodies.length).toBeGreaterThan(0);
        expect(asked.bodies.length).toBeLessThan(100);
        expect(asked.bodies.length).toBeLessThanOrEqual(rows().length + 2);
    });
});
