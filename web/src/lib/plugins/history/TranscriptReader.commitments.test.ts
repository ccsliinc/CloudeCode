/**
 * THE THREE PUBLIC COMMITMENTS FROM ISSUE #173, ASSERTED AGAINST THE
 * MOUNTED READER.
 *
 * @vitest-environment jsdom
 *
 * SEPARATE FROM `TranscriptReader.behaviour.test.ts` because it is a
 * different job, exactly as slice 5 and slice 6 split theirs. Behaviour
 * asks "does the reader do what the reader did". This asks "did the port
 * keep the promises made to Adam about his re-skin": no new class names,
 * not one line of the 12 archive stylesheets touched, and any forced
 * choice named rather than slipped in.
 *
 * COMMITMENT 3 IS NOT FULLY ASSERTABLE HERE and is not pretended to be.
 * A forced choice is named in the commit message and in the header of
 * the file that makes it; a test cannot check that prose exists. What it
 * CAN check is that the ONE mechanical half - the list of classes that
 * were already unstyled before this port - is a declared table rather
 * than a filter hidden in the assertion, which is what stops a fifth
 * joining quietly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TranscriptReader from './TranscriptReader.svelte';
import {
    CANARY, fakeClient, linesPage, outcome, spineRow, syncRaf,
} from './reader-harness';
import { ACTIONS, CLASS, FAMILY_MOD, PROGRESS_RUN_MOD, UNSTYLED_PRE_EXISTING } from './reader-vocab';
import { BODY_INLINE_MAX, BODY_RENDER_HARD_MAX } from './reader-gate';
import type { ArchiveClient } from './client';

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** Mount the reader. */
function mountReader(client: ArchiveClient): { open(): Promise<string> } {
    host = document.createElement('div');
    document.body.appendChild(host);
    mounted = mount(TranscriptReader, {
        target: host,
        props: { client, outcome, transcriptId: 5767, raf: syncRaf } as never,
    }) as Record<string, unknown>;
    return mounted as unknown as { open(): Promise<string> };
}

/** Run the reader's chain to completion. */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
        flushSync();
        await Promise.resolve();
    }
    flushSync();
}

/**
 * One source file with its comments removed.
 *
 * Description: A SOURCE SCAN THAT READS PROSE IS NOT A SOURCE SCAN. Every
 *   file in this slice DESCRIBES the things it refuses to do - "no
 *   `innerHTML`", "nothing here calls `closest()`" - so a bare substring
 *   search finds the promise and reports it as the violation. Stripping
 *   block comments, line comments and HTML comments first means the scan
 *   answers "does this file DO it", which is the question.
 * Inputs: src - the file text. Output: the code, comments blanked.
 */
function codeOnly(src: string): string {
    return src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every class name actually painted into the mounted reader. */
function emittedClasses(): Set<string> {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll(
        `.${CLASS.root}, .${CLASS.root} *`,
    )) {
        const cls = el.getAttribute('class');
        if (!cls) continue;
        for (const one of cls.split(/\s+/)) if (one) seen.add(one);
    }
    return seen;
}

/**
 * Mount and drive EVERY surface, so every class gets a chance to paint.
 *
 * Description: a class-name guard is only as good as its coverage. This
 *   deliberately produces, in one mount: a header, every record-type
 *   family, both badge kinds and the compact boundary, an expanded
 *   progress run WITH its children, a rendered body with a mask note, a
 *   soft gate, a hard gate, a server withholding, a body-less line, an
 *   incomplete spine with its sentinel and its pager, and a selected
 *   row. A family this never paints is a family whose modifier is
 *   untested, so the loop over `FAMILY_MOD` below is a second, blunter
 *   check on the same thing.
 */
async function paintEverything(): Promise<void> {
    const rows = [
        spineRow({ line_no: 1, record_type: 'user', role: 'user', body_id: 1,
            body_chars: 40 }),
        spineRow({ line_no: 2, record_type: 'result', role: null, body_id: 2,
            body_chars: 40, is_sidechain: true, agent_id: 'a877057',
            is_compact_boundary: true, compact_subtype: 'auto' }),
        spineRow({ line_no: 3, record_type: 'summary', body_id: 3, body_chars: 40 }),
        spineRow({ line_no: 4, record_type: 'a-27th-type', body_id: 4, body_chars: 40 }),
        // Two consecutive progress lines fold into a run.
        spineRow({ line_no: 5, record_type: 'progress', role: null, body_id: 5,
            body_chars: 40 }),
        spineRow({ line_no: 6, record_type: 'progress', role: null, body_id: 6,
            body_chars: 40 }),
        // The gates.
        spineRow({ line_no: 7, body_id: 7, body_chars: BODY_INLINE_MAX + 1 }),
        spineRow({ line_no: 8, body_id: 8, body_chars: BODY_RENDER_HARD_MAX + 1 }),
        spineRow({ line_no: 9, body_id: 9, body_chars: 40,
            body_state: 'withheld_too_large' }),
        spineRow({ line_no: 10, body_id: null, body_chars: null }),
        // A mask refusal, and a body that masks cleanly.
        spineRow({ line_no: 11, body_id: 11, body_chars: 60 }),
        spineRow({ line_no: 12, body_id: 12, body_chars: 60 }),
    ];
    // IMPORTED, NOT REDECLARED. A third copy of the canary is a third
    // thing to keep in step, and the one that drifted would be the one
    // proving a gate refuses.
    const secret = CANARY;
    const { client } = fakeClient({
        header: { transcript_id: 5767, session_ref: 'abc', line_count: 30805,
            raw_byte_length: 91950363 },
        // `true` so the sentinel AND the pager both paint.
        page: linesPage(rows, true),
        body: (id: unknown) => {
            if (id === 11) {
                return {
                    envelope: { result: { body_json: `k=${secret}`, secrets: null,
                        secret_finding_count: 1 }, result_status: 'ok', meta: {} },
                    httpStatus: 200, headers: null, transportError: null,
                } as never;
            }
            if (id === 12) {
                const body = `head ${secret} tail`;
                return {
                    envelope: { result: { body_json: body, secrets: [{
                        utf16_state: 'computed',
                        match_offset_utf16: body.indexOf(secret),
                        match_length_utf16: secret.length,
                    }], secret_finding_count: 1 }, result_status: 'ok', meta: {} },
                    httpStatus: 200, headers: null, transportError: null,
                } as never;
            }
            return {
                envelope: { result: { body_json: 'body text', secrets: [],
                    secret_finding_count: 0 }, result_status: 'ok', meta: {} },
                httpStatus: 200, headers: null, transportError: null,
            } as never;
        },
    });
    const api = mountReader(client);
    await api.open();
    await settle();
    // Expand the run so its children and their classes paint too.
    document.querySelector<HTMLButtonElement>(
        `[data-action="${ACTIONS.EXPAND}"]`,
    )?.click();
    await settle();
    // Select a row, so the roving tabindex and data-selected paint.
    (mounted as unknown as { selectIndex(i: number): number }).selectIndex(0);
    await settle();
}

describe('TranscriptReader: the three public commitments', () => {
    it('COMMITMENT 1: emits only class names the vocabulary declares', async () => {
        await paintEverything();
        const allowed = new Set<string>([
            ...Object.values(CLASS),
            ...Object.values(FAMILY_MOD),
            PROGRESS_RUN_MOD,
        ]);
        const seen = emittedClasses();
        // A guard over an empty set proves nothing.
        expect(seen.size).toBeGreaterThan(20);
        // NAMES THE OFFENDER. A bare `expect(false).toBe(true)` says a
        // class escaped and leaves the reader grepping for which one.
        expect([...seen].filter((c) => !allowed.has(c))).toEqual([]);
    });

    it('COMMITMENT 1, the other half: every class it emits already '
        + 'existed in the code this port replaces', async () => {
        // THE VOCABULARY COULD DECLARE ANYTHING. The test above checks the
        // reader emits only what the table declares; this checks the TABLE
        // against the code it was copied from, so a class invented for this
        // port and dutifully listed as "allowed" is still caught.
        //
        // TWO SOURCES, BECAUSE THE READER'S MARKUP HAS TWO AUTHORS. The row
        // and shell classes come from the four vanilla reader files. The
        // three HEADER classes come from `renderTranscriptHeader`, which
        // lives in `./format.ts` - slice 4, already ported - and never
        // appeared in the vanilla reader at all. Checking them against the
        // wrong file would report three false violations, and widening the
        // matcher until they passed would be the opposite mistake.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const jsDir = path.join(here, '..', '..', '..', '..', '..', 'client', 'js');
        const vanilla = [
            'archive-line-render.js', 'archive-reader-dom.js', 'archive-reader.js',
            'archive-reader-paging.js',
        ].map((f) => codeOnly(fs.readFileSync(path.join(jsDir, f), 'utf8')))
            .join('\n');
        expect(vanilla.length).toBeGreaterThan(5000);

        const header = codeOnly(fs.readFileSync(path.join(here, 'format.ts'), 'utf8'));

        // THE HEADER THREE, matched as QUOTED LITERALS, which is exact:
        // `format.ts` writes `rc + '__header-facts'` and the other two the
        // same way.
        for (const c of [CLASS.headerFacts, CLASS.title, CLASS.facts]) {
            const suffix = c.slice(CLASS.root.length);
            expect(header, c).toContain(`'${suffix}'`);
        }

        // THE REST, matched on the distinguishing word rather than on a
        // quoted literal, which is forced by how the vanilla builds its
        // classes: never as one string. `archive-row__badge` is written
        // `ROW_CLASS + '__badge '` (trailing space, a modifier follows) and
        // `archive-row--tool` is `ROW_CLASS + '--' + family` where `tool` is
        // an object KEY. Weaker than an exact match, and still the property
        // worth having: a class invented here, say
        // `archive-row__brand-new-thing`, has no such word anywhere.
        const headerThree = new Set<string>([
            CLASS.headerFacts, CLASS.title, CLASS.facts,
        ]);
        const roots = new Set<string>([CLASS.root, CLASS.row]);
        const declared = [
            ...Object.values(CLASS), ...Object.values(FAMILY_MOD), PROGRESS_RUN_MOD,
        ];
        const missing = declared.filter((c) => {
            if (roots.has(c) || headerThree.has(c)) return false;
            const suffix = c.startsWith(`${CLASS.root}__`)
                ? c.slice(CLASS.root.length)
                : c.slice(CLASS.row.length);
            const bare = suffix.replace(/^(__|--)/, '');
            return !vanilla.includes(suffix) && !vanilla.includes(bare);
        });
        expect(missing).toEqual([]);

        // THE NEGATIVE CONTROL FOR THIS MATCHER: an invented class must
        // NOT pass it, or the assertion above would be vacuous.
        expect(vanilla.includes('__brand-new-thing')).toBe(false);
        expect(vanilla.includes('brand-new-thing')).toBe(false);
    });

    it('COMMITMENT 2: every class it emits already has a rule in the '
        + 'untouched archive stylesheets, bar four that never did', async () => {
        // THE ANTIJOIN, carried across from slices 5 and 6, which carried
        // it from `tests/test_archive_tlist_styled.node.mjs`. That test
        // exists because a complete BEM tree once shipped matching ZERO
        // rules in any stylesheet and rendered in Chrome's user-agent
        // defaults in every theme. Nothing errored and no test failed.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const cssDir = path.join(here, '..', '..', '..', '..', '..', 'client', 'css');
        const css = fs.readdirSync(cssDir)
            .filter((f) => f.startsWith('archive') && f.endsWith('.css'))
            .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8'))
            .join('\n');
        expect(css.length).toBeGreaterThan(1000);

        await paintEverything();
        const unstyled = [...emittedClasses()].filter((c) => !css.includes(`.${c}`));
        // The four are emitted by the VANILLA reader today and match
        // nothing in any of the 12 stylesheets. Named in
        // `reader-vocab.ts` rather than quietly filtered here, so a fifth
        // cannot join them without somebody editing that list.
        expect(unstyled.slice().sort()).toEqual([...UNSTYLED_PRE_EXISTING].sort());
    });

    it('COMMITMENT 2, the other half: it touched no stylesheet, which is '
        + 'why the antijoin above is a real test', async () => {
        // The antijoin proves nothing if the stylesheets were edited to
        // agree with it. The 12 files are read from disk unmodified and
        // this asserts the family is intact and the size is the one the
        // commitment was made about: 4,444 lines, measured 2026-09-17.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const cssDir = path.join(here, '..', '..', '..', '..', '..', 'client', 'css');
        const files = fs.readdirSync(cssDir)
            .filter((f) => f.startsWith('archive') && f.endsWith('.css'));
        expect(files).toHaveLength(12);
        // COUNTED THE WAY THE COMMITMENT WAS: `wc -l`, which counts
        // NEWLINES. `split('\n').length` counts one more per file, for the
        // empty string after the final newline, and over twelve files that
        // is 4,456 - a number that would look like twelve lines of drift
        // and is nothing of the sort. Both readings are correct; only one
        // matches the figure issue #173 quotes.
        const lines = files
            .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')
                .split('\n').length - 1)
            .reduce((a, b) => a + b, 0);
        expect(lines).toBe(4444);
    });

    it('COMMITMENT 3, its mechanical half: the pre-existing unstyled '
        + 'classes are a DECLARED table, not a filter hidden in a test', () => {
        // Four, all of them emitted by the vanilla reader today. Their
        // being listed HERE is what makes adding a fifth a visible edit.
        expect([...UNSTYLED_PRE_EXISTING].sort()).toEqual([
            'archive-reader__header-facts',
            'archive-row__model',
            'archive-row__size',
            'archive-row__ts',
        ]);
    });

    it('DECLARES NO STYLES OF ITS OWN: the three components carry no '
        + '<style> block, so nothing can leak past the stylesheets',
    async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        for (const f of ['TranscriptReader.svelte', 'ReaderRow.svelte',
            'ReaderBody.svelte', 'ReaderProgressRun.svelte']) {
            const src = codeOnly(fs.readFileSync(path.join(here, f), 'utf8'));
            expect(src, f).not.toContain('<style');
            // AND NO `:global`, which would reach outside this subtree.
            expect(src, f).not.toContain(':global(');
        }
    });

    it('USES NO `{@html}` ANYWHERE: transcript bodies are arbitrary text '
        + 'from the corpus and must never be parsed as markup', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        for (const f of ['TranscriptReader.svelte', 'ReaderRow.svelte',
            'ReaderBody.svelte', 'ReaderProgressRun.svelte']) {
            const src = codeOnly(fs.readFileSync(path.join(here, f), 'utf8'));
            expect(src, f).not.toContain('{@html');
            expect(src, f).not.toContain('innerHTML');
        }
    });
});

describe('shell independence', () => {
    it('READS NOTHING OUTSIDE ITS OWN SUBTREE: no querySelector on the '
        + 'document, no closest(), no window measurement', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const files = ['TranscriptReader.svelte', 'ReaderRow.svelte',
            'ReaderBody.svelte', 'ReaderProgressRun.svelte',
            'reader-measure.svelte.ts', 'reader-body-policy.ts',
            'reader-virtual.ts', 'reader-rows.ts', 'reader-gate.ts',
            'reader-mask.ts', 'reader-body-cache.ts', 'reader-paging.ts',
            'reader-load.ts', 'reader-vocab.ts'];
        for (const f of files) {
            const src = codeOnly(fs.readFileSync(path.join(here, f), 'utf8'));
            expect(src, f).not.toContain('document.querySelector');
            expect(src, f).not.toContain('document.getElementById');
            expect(src, f).not.toContain('.closest(');
            expect(src, f).not.toContain('window.innerHeight');
            expect(src, f).not.toContain('window.innerWidth');
            // And no `100vh` or any other claim on the viewport.
            expect(src, f).not.toContain('vh;');
        }
    });

    it('MOUNTS INTO A BOX IT DOES NOT OWN, declaring no width, no height '
        + 'and no position of its own', async () => {
        await paintEverything();
        const root = document.querySelector<HTMLElement>(`.${CLASS.root}`);
        expect(root).not.toBeNull();
        // The only inline styles it writes are the spacer height and the
        // window translate, which are geometry it MEASURED, not chrome.
        const styled = [...document.querySelectorAll<HTMLElement>(
            `.${CLASS.root} [style]`,
        )];
        for (const el of styled) {
            const s = el.getAttribute('style') || '';
            expect(s).toMatch(/^(height:|transform:)/);
        }
        expect(root?.getAttribute('style')).toBeNull();
    });
});
