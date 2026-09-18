/**
 * THE THREE PUBLIC COMMITMENTS FROM ISSUE #173, ASSERTED AGAINST THE
 * MOUNTED SEARCH, EXPORT AND OUTCOME SURFACES.
 *
 * @vitest-environment jsdom
 *
 * SEPARATE FROM the behaviour tests, exactly as slices 5, 6 and 7 split
 * theirs. Behaviour asks "does this do what the vanilla did". This asks
 * "did the port keep the promises made to Adam about his re-skin": no
 * new class names, not one line of the 12 archive stylesheets touched,
 * and any forced choice NAMED rather than slipped in.
 *
 * COMMITMENT 3 IS NOT FULLY ASSERTABLE HERE and is not pretended to be.
 * A forced choice is named in the commit message and in the header of
 * the file that makes it; a test cannot check that prose exists. What it
 * CAN check is that the ONE mechanical half - the list of classes that
 * were already unstyled before this port - is a DECLARED TABLE rather
 * than a filter hidden in the assertion, which is what stops a further
 * one joining quietly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SearchPanel from './SearchPanel.svelte';
import ExportModal from './ExportModal.svelte';
import { CLASS as SEARCH_CLASS, UNSTYLED_PRE_EXISTING as SEARCH_UNSTYLED } from './search-vocab';
import { CLASS as EXPORT_CLASS, UNSTYLED_PRE_EXISTING as EXPORT_UNSTYLED } from './export-vocab';
import {
    CLASS as OUTCOME_CLASS, TOKEN_MOD, UNSTYLED_PRE_EXISTING as OUTCOME_UNSTYLED,
} from './outcome-vocab';

let mounted: Record<string, unknown>[] = [];
let hosts: HTMLElement[] = [];

afterEach(() => {
    for (const m of mounted) unmount(m);
    for (const h of hosts) h.remove();
    mounted = [];
    hosts = [];
});

/** One source file with its comments removed. Carried over from slice 7. */
function codeOnly(src: string): string {
    return src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Read the twelve archive stylesheets off disk, byte for byte. */
async function archiveCss(): Promise<{ css: string; files: string[]; dir: string }> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const dir = path.join(here, '..', '..', '..', '..', '..', 'client', 'css');
    const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith('archive') && f.endsWith('.css'));
    const css = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    return { css, files, dir };
}

/** Every class painted under a root. */
function emittedClasses(root: HTMLElement): Set<string> {
    const seen = new Set<string>();
    for (const el of root.querySelectorAll('*')) {
        const cls = el.getAttribute('class');
        if (!cls) continue;
        for (const one of cls.split(/\s+/)) if (one) seen.add(one);
    }
    return seen;
}

/** Mount a component and track it for teardown. */
function mountIt(Comp: unknown, props: Record<string, unknown>): {
    host: HTMLElement; api: Record<string, unknown>;
} {
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const api = mount(
        Comp as never, { target: host, props: props as never },
    ) as Record<string, unknown>;
    mounted.push(api);
    return { host, api };
}

/** Settle Svelte's queue and any resolved promises. */
async function settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i += 1) { flushSync(); await Promise.resolve(); }
    flushSync();
}

/**
 * Paint EVERY surface, so every class gets a chance to emit.
 *
 * Description: a class-name guard is only as good as its coverage. This
 *   produces, across three mounts: a hit with a rendered preview, a hit
 *   with a withheld preview, a hit with no preview at all, the coverage
 *   line, a kind-aware resume control, the export control, a non-ok
 *   outcome block with reasons AND a coverage row AND a disabled action,
 *   and an export modal in its UNVERIFIABLE state with its shasum block,
 *   its collision warning and its download blocker.
 */
async function paintEverything(): Promise<HTMLElement[]> {
    const rows = [
        { transcript_id: 4, session_ref: 'journal', line_no: 292, match_offset: 1,
          match_length: 2, snippet: 'a clean preview', snippet_state: 'included',
          secret_finding_count: 0 },
        { transcript_id: 5, session_ref: 'audit', line_no: 3, match_offset: 1,
          match_length: 2, snippet: 'poison', snippet_state: 'withheld_secret_bearing',
          secret_finding_count: 3 },
        { transcript_id: 6, session_ref: null, line_no: 4, match_offset: null,
          match_length: null, snippet: null, snippet_state: 'included',
          secret_finding_count: 0 },
    ];
    const client = {
        searchArchive: () => Promise.resolve({
            envelope: {
                result: rows,
                result_status: 'partial',
                unevaluated: [{ subject: 'scan', reason: 'budget spent' }],
                meta: {
                    scan: { status: 'budget_exhausted', transcripts_scanned: 801,
                            transcripts_not_scanned: 2615, bytes_scanned: 551648566,
                            resume_cursor: 'SCAN-CURSOR' },
                    scope: { kind: 'project', project_id: 12, transcripts_in_scope: 3416 },
                    paging: { next_cursor: null },
                },
            },
            transportError: null,
        }),
    };
    const outcome = {
        classify: (e: unknown) => ({
            token: (e as { result_status?: string } | null)?.result_status === 'partial'
                ? 'partial' : 'ok',
            reasons: (e as { unevaluated?: unknown } | null)?.unevaluated ?? [],
        }),
    };

    // 1 and 2: the panel, with a working export capability so its control
    // paints enabled.
    const panel = mountIt(SearchPanel, {
        client, outcome, copyText: () => Promise.resolve(true),
    });
    await (panel.api as unknown as { run(q: unknown): Promise<string> })
        .run({ q: 'restic', projectId: 12 });
    await settle();
    panel.host.querySelector<HTMLButtonElement>('[data-action="export-text"]')?.click();
    await settle();

    // 3: the export modal in its UNVERIFIABLE state, which is the one
    // that paints the most: shasum block, collision warning and blocker.
    const modal = mountIt(ExportModal, {
        client: {
            preflightArchiveExport: () => Promise.resolve({
                httpStatus: 200,
                headers: {
                    'x-archive-expected-sha256': 'a'.repeat(64),
                    'x-archive-trailer-unavailable': 'uvicorn implements no trailers',
                    'x-archive-expected-bytes': '91950363',
                    'content-disposition': 'attachment; filename="journal.jsonl"',
                },
            }),
        },
        transcriptId: 4,
        sameNameCount: 14,
    });
    await settle();

    return [panel.host, modal.host];
}

describe('search, export and outcome: the three public commitments', () => {
    it('COMMITMENT 1: emits only class names the vocabularies declare', async () => {
        const roots = await paintEverything();
        const allowed = new Set<string>([
            ...Object.values(SEARCH_CLASS),
            ...Object.values(EXPORT_CLASS),
            ...Object.values(OUTCOME_CLASS),
            ...Object.values(TOKEN_MOD),
        ]);
        const seen = new Set<string>();
        for (const r of roots) for (const c of emittedClasses(r)) seen.add(c);

        // A guard over an empty set proves nothing.
        expect(seen.size).toBeGreaterThan(20);
        // NAMES THE OFFENDER rather than asserting a bare false.
        expect([...seen].filter((c) => !allowed.has(c)).sort()).toEqual([]);
    });

    it('COMMITMENT 1, the other half: every class the vocabularies '
        + 'declare already existed in the code this port replaces', async () => {
        // THE VOCABULARY COULD DECLARE ANYTHING. The test above checks
        // the components emit only what the tables declare; this checks
        // the TABLES against the code they were copied from, so a class
        // invented for this port and dutifully listed as "allowed" is
        // still caught.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const jsDir = path.join(here, '..', '..', '..', '..', '..', 'client', 'js');
        const vanilla = [
            'archive-search.js', 'archive-search-render.js', 'archive-export.js',
            'archive-outcome-view.js',
        ].map((f) => codeOnly(fs.readFileSync(path.join(jsDir, f), 'utf8'))).join('\n');
        expect(vanilla.length).toBeGreaterThan(5000);

        // MATCHED ON THE DISTINGUISHING SUFFIX rather than on a quoted
        // literal, which is forced by how the vanilla builds its classes:
        // never as one string. `archive-search__hit-loc` is written
        // `ROOT_CLASS + '__hit-loc'`, and `archive-outcome--partial` is
        // `ROOT_CLASS + '--' + token` where `partial` is an object KEY.
        const roots = new Set<string>([
            SEARCH_CLASS.root, EXPORT_CLASS.root, OUTCOME_CLASS.root,
            // The three global modal classes come from the app shell, not
            // from these four files, so they are matched as literals
            // instead - which they are, in `archive-export.js`.
            EXPORT_CLASS.modalOverlay, EXPORT_CLASS.modalContent, EXPORT_CLASS.modalHeader,
        ]);
        const declared = [
            ...Object.values(SEARCH_CLASS), ...Object.values(EXPORT_CLASS),
            ...Object.values(OUTCOME_CLASS), ...Object.values(TOKEN_MOD),
        ];
        const missing = declared.filter((c) => {
            if (roots.has(c)) return !vanilla.includes(c);
            const suffix = c.replace(/^archive-(search|export|outcome)/, '');
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
        + 'untouched archive stylesheets, bar the declared pre-existing '
        + 'exceptions', async () => {
        // THE ANTIJOIN, carried across from slices 5, 6 and 7, which
        // carried it from `tests/test_archive_tlist_styled.node.mjs`.
        // That test exists because a complete BEM tree once shipped
        // matching ZERO rules in any stylesheet and rendered in Chrome's
        // user-agent defaults in every theme. Nothing errored and no test
        // failed.
        const { css } = await archiveCss();
        expect(css.length).toBeGreaterThan(1000);

        const roots = await paintEverything();
        const seen = new Set<string>();
        for (const r of roots) for (const c of emittedClasses(r)) seen.add(c);

        // A STRICTER MATCHER THAN SLICES 5 TO 7 USED, DELIBERATELY, and
        // the direction is the safe one: stricter reports MORE classes
        // unstyled, so more must be declared in a vocab file and fewer
        // slip through unnoticed. Their `css.includes('.' + c)` is wrong
        // in two ways this surface actually hits. It matches inside CSS
        // COMMENTS - `archive-export.css`'s header says in prose that
        // "the overlay and content reuse `.modal-overlay` and
        // `.modal-content`", which made two classes with no rule at all
        // report as styled. And it matches a LONGER SIBLING -
        // `.archive-outcome__reasons` and `.archive-outcome__reason-subject`
        // both contain `.archive-outcome__reason`, so a class with no
        // rule reported as styled because a different one does.
        const noComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
        const styled = (c: string): boolean => new RegExp(
            `\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`,
        ).test(noComments);

        // THE MATCHER'S OWN CONTROLS, because a matcher that answered
        // "unstyled" to everything would make the assertion below pass by
        // declaring everything, and one that answered "styled" to
        // everything would make it pass by declaring nothing.
        expect(styled('archive-search__hit')).toBe(true);
        expect(styled('archive-outcome__reason')).toBe(false);
        expect(styled('modal-overlay')).toBe(false);
        expect(styled('archive-brand-new-thing')).toBe(false);

        const unstyled = [...seen].filter((c) => !styled(c));
        const declaredUnstyled = [
            ...SEARCH_UNSTYLED, ...EXPORT_UNSTYLED, ...OUTCOME_UNSTYLED,
        ];
        // Named in the three vocab files rather than quietly filtered
        // here, so a further one cannot join them without somebody
        // editing those lists.
        expect(unstyled.sort()).toEqual(
            declaredUnstyled.filter((c) => seen.has(c)).sort(),
        );
    });

    it('COMMITMENT 2, the other half: it touched no stylesheet, which is '
        + 'why the antijoin above is a real test', async () => {
        // The antijoin proves nothing if the stylesheets were edited to
        // agree with it. The 12 files are read from disk unmodified and
        // this asserts the family is intact and the size is the one the
        // commitment was made about: 4,444 lines.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { files, dir } = await archiveCss();
        expect(files).toHaveLength(12);
        const lines = files.reduce((n, f) => {
            const body = fs.readFileSync(path.join(dir, f), 'utf8');
            return n + body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
        }, 0);
        expect(lines).toBe(4444);
    });

    it('COMMITMENT 3, the mechanical half: the pre-existing unstyled '
        + 'classes are a DECLARED TABLE, not a filter hidden in a test', () => {
        // Each list is non-empty, is a real array of strings, and every
        // entry is a class the matching vocabulary actually declares - so
        // a table cannot quietly excuse a class the component never emits
        // while letting a real one through.
        const pairs: [readonly string[], readonly string[]][] = [
            [SEARCH_UNSTYLED, Object.values(SEARCH_CLASS)],
            [EXPORT_UNSTYLED, Object.values(EXPORT_CLASS)],
            // The outcome family declares its modifiers in a SECOND
            // table, `TOKEN_MOD`, exactly as slice 7 keeps `FAMILY_MOD`
            // apart from `CLASS`, so both are in scope here.
            [OUTCOME_UNSTYLED,
                [...Object.values(OUTCOME_CLASS), ...Object.values(TOKEN_MOD)]],
        ];
        for (const [list, declared] of pairs) {
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBeGreaterThan(0);
            const values = new Set(declared);
            for (const c of list) expect(values.has(c), c).toBe(true);
        }
    });
});
