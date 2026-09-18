/**
 * THE CONTROL. It fails if a rendered snippet or a composed export can
 * carry a value the server's gate declared.
 *
 * @vitest-environment jsdom
 *
 * THIS IS THE MOST IMPORTANT TEST IN SLICE 9 and it is written the way
 * slice 7 wrote its mask tests: with a CANARY string that is never a
 * plausible credential, so that finding it anywhere is unambiguous, and
 * with NEGATIVE CONTROLS that are load-bearing rather than decorative.
 *
 * WHY A NEGATIVE CONTROL IS MANDATORY HERE. A gate that withheld
 * EVERYTHING would pass every disclosure assertion in this file
 * perfectly and ship a search panel that never shows a preview. So every
 * refusal block below is paired with a POSITIVE control proving the same
 * code path renders real text when the server cleared it. A matcher that
 * always finds something is worse than useless, and so is a gate that
 * always refuses.
 *
 * IT ASSERTS ON THREE LAYERS, because a leak at any one of them is a
 * leak:
 *
 *   1. THE DOOR. `snippetEgress` over the full cross product of every
 *      snippet state the SERVER declares and every finding count shape.
 *   2. THE EXPORT. `composeExport` over the same, asserting the canary
 *      is absent from the composed bytes in both formats.
 *   3. THE RENDERED DOM. `SearchPanel` mounted against a poisoned client,
 *      asserting the canary is in no text node and no attribute.
 *
 * AND A FOURTH, STRUCTURAL ONE: no file in the `search-*`, `export-*` or
 * `outcome-*` families may read a `snippet` field at all. That is the
 * assertion that survives somebody adding a new renderer next year,
 * because it fails on the IMPORT rather than on the output.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SearchPanel from './SearchPanel.svelte';
import {
    EGRESS_NONE, EGRESS_TEXT, EGRESS_WITHHELD, exportLine, snippetEgress,
} from './mask-egress';
import { SNIPPET_INCLUDED } from './mask-vocab';
import { hitView } from './search-hit';
import { composeExport } from './export-compose';
import { COMPOSED_FORMATS } from './export-vocab';

/**
 * The canary.
 *
 * Description: DELIBERATELY NOT A PLAUSIBLE CREDENTIAL. Nothing in this
 *   file needs realism - every rung of the gate is driven by
 *   `snippet_state` and `secret_finding_count`, never by the shape of
 *   the text - so the canary says what it is instead. Finding it on
 *   screen or in a file is unambiguous.
 */
const CANARY = 'CANARY-IF-YOU-SEE-THIS-A-GATE-FAILED-OPEN';

/**
 * EVERY snippet state the server declares, read off
 * `src/core/archive_snippet_gate.py` and checked against it by
 * `search-vocab` consumers. FIVE of these six must withhold.
 */
const SERVER_STATES = [
    'included',
    'withheld_secret_bearing',
    'withheld_window_detector',
    'withheld_known_secret_value',
    'withheld_gate_unavailable',
    'withheld_by_request',
] as const;

/**
 * States the server does NOT declare today.
 *
 * Description: the future-proofing half. A deny-list renders every one
 *   of these as safe; an allow-list withholds them without anybody
 *   editing anything, which is the property the inversion was for.
 */
const UNDECLARED_STATES = [
    'withheld_new_detector_2027', 'included_but_actually_not', 'ok', '', 'INCLUDED',
];

/** One poisoned hit: the canary present, with the given gate verdict. */
function poisoned(state: unknown, count: unknown): Record<string, unknown> {
    return {
        transcript_id: 4, session_ref: 'journal', line_no: 292,
        match_offset: 10, match_length: 40,
        snippet: `api_key=${CANARY}`,
        snippet_state: state,
        secret_finding_count: count,
    };
}

/** The one shape that must render: cleared by the gate, clean body. */
function cleared(text: string): Record<string, unknown> {
    return {
        transcript_id: 7, session_ref: 'audit', line_no: 3,
        match_offset: 0, match_length: 5,
        snippet: text, snippet_state: SNIPPET_INCLUDED, secret_finding_count: 0,
    };
}

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

describe('the egress door: no declared finding reaches a snippet', () => {
    it('renders text for the ONE cleared shape - the positive control '
        + 'without which every refusal below is vacuous', () => {
        const v = snippetEgress(cleared('a clean preview'));
        expect(v.kind).toBe(EGRESS_TEXT);
        expect(v.kind === EGRESS_TEXT && v.text).toBe('a clean preview');
    });

    it('withholds under every withholding state the SERVER declares, '
        + 'including the three the vanilla deny-list never named', () => {
        for (const state of SERVER_STATES) {
            if (state === SNIPPET_INCLUDED) continue;
            const v = snippetEgress(poisoned(state, 0));
            expect(v.kind, state).toBe(EGRESS_WITHHELD);
            expect(JSON.stringify(v), state).not.toContain(CANARY);
        }
    });

    it('REPRODUCES THE VANILLA RULE INLINE and proves this one differs, '
        + 'so the test fails if the deny-list ever comes back', () => {
        // The vanilla's own list, retyped here rather than imported, so
        // that deleting it from the source cannot make this pass.
        const vanillaWithheld = ['withheld_secret_bearing', 'withheld_known_secret_value'];
        const missedByVanilla = SERVER_STATES.filter(
            (s) => s !== SNIPPET_INCLUDED && !vanillaWithheld.includes(s),
        );
        // Three states the old rule would have rendered.
        expect(missedByVanilla).toEqual([
            'withheld_window_detector', 'withheld_gate_unavailable', 'withheld_by_request',
        ]);
        for (const state of missedByVanilla) {
            expect(snippetEgress(poisoned(state, 0)).kind, state).toBe(EGRESS_WITHHELD);
        }
    });

    it('withholds a state it has never seen, which is what an allow-list '
        + 'buys and a deny-list cannot', () => {
        for (const state of UNDECLARED_STATES) {
            const v = snippetEgress(poisoned(state, 0));
            expect(v.kind, state).toBe(EGRESS_WITHHELD);
        }
        for (const state of [null, undefined, 42, {}, []]) {
            expect(snippetEgress(poisoned(state, 0)).kind, String(state))
                .toBe(EGRESS_WITHHELD);
        }
    });

    it('withholds an `included` window whose BODY declares findings - the '
        + 'rung the server gate structurally cannot cover', () => {
        // This is the 1,211-of-12,522 case: the window scan is
        // contextual, the window is cut at the query rather than at a
        // finding, and 9.7 percent of real findings survive it carrying
        // 16 or more characters of a credential.
        for (const count of [1, 3, 762]) {
            const v = snippetEgress(poisoned(SNIPPET_INCLUDED, count));
            expect(v.kind, String(count)).toBe(EGRESS_WITHHELD);
            expect(v.kind === EGRESS_WITHHELD && v.findingCount).toBe(count);
        }
        // AND THE POSITIVE HALF: a stated ZERO still renders, or the rung
        // above would just be "withhold everything" wearing a reason.
        expect(snippetEgress(poisoned(SNIPPET_INCLUDED, 0)).kind).toBe(EGRESS_TEXT);
    });

    it('treats an UNSTATED finding count as not-evidence, not as zero, '
        + 'and still clears it - a count is not the only gate', () => {
        // An unstated count cannot refuse on its own: `snippet_state`
        // already carries the gate's verdict, and refusing on a missing
        // integer would withhold every hit from a server that does not
        // send that column. The refusal above needs a POSITIVE count.
        for (const count of [null, undefined, 'three', 1.5, NaN]) {
            expect(snippetEgress(poisoned(SNIPPET_INCLUDED, count)).kind, String(count))
                .toBe(EGRESS_TEXT);
        }
    });

    it('answers `none`, not `text`, when a cleared hit carries no string', () => {
        for (const s of [null, undefined, 42, {}]) {
            const hit = { ...cleared('x'), snippet: s };
            expect(snippetEgress(hit).kind, String(s)).toBe(EGRESS_NONE);
        }
    });

    it('never puts matched text into a reason, a state or any other field', () => {
        for (const state of SERVER_STATES) {
            for (const count of [0, 1, 99]) {
                const v = snippetEgress(poisoned(state, count));
                if (v.kind === EGRESS_TEXT) continue;
                expect(JSON.stringify(v), `${state}/${count}`).not.toContain(CANARY);
            }
        }
    });
});

describe('the export: the same door, and it cannot be walked around', () => {
    it('substitutes a stated line for every refused preview and omits no hit', () => {
        const views = SERVER_STATES.map((s) => hitView(poisoned(s, 1) as never));
        const composed = composeExport(
            views,
            { query: 'restic', coverage: 'coverage: 1 of 3416', scan: 'limit_reached' },
            COMPOSED_FORMATS.TEXT,
        );
        // EVERY hit is present. Dropping a withheld one under-reports
        // what the search found, which is the same false green in a file.
        expect(composed.hits).toBe(SERVER_STATES.length);
        expect(composed.substituted).toBe(SERVER_STATES.length);
        expect(composed.text).not.toContain(CANARY);
        // It carries its own honesty note out of the app with it.
        expect(composed.text).toContain('limit_reached');
        expect(composed.text).toContain('coverage: 1 of 3416');
    });

    it('carries no canary in EITHER format, including the JSON one where '
        + 'a richer object would have put the raw snippet back', () => {
        // THE ONE COMBINATION DELIBERATELY EXCLUDED, and stating why is
        // the point. `(included, 0)` is a hit the server's gate RAN on,
        // passed, and whose body declares no findings. This client holds
        // no evidence against it, so it renders and it exports - that is
        // the server gate's own documented BEST-EFFORT limit, not a hole
        // in this door. Asserting the canary is absent there would be
        // asserting that the panel never shows a preview at all, which
        // is the vacuous-gate failure this file exists to avoid. It IS
        // asserted present, below, as the positive control.
        const views = SERVER_STATES.flatMap((s) => [
            hitView(poisoned(s, 1) as never),
            ...(s === SNIPPET_INCLUDED ? [] : [hitView(poisoned(s, 0) as never)]),
        ]);
        for (const format of Object.values(COMPOSED_FORMATS)) {
            const composed = composeExport(
                views, { query: 'q', coverage: 'c', scan: 'complete' }, format,
            );
            expect(composed.text, format).not.toContain(CANARY);
        }
    });

    it('DOES export a cleared preview, so the assertions above are not '
        + 'passing because nothing is ever exported', () => {
        const composed = composeExport(
            [hitView(cleared('a clean preview') as never)],
            { query: 'q', coverage: 'c', scan: 'complete' },
            COMPOSED_FORMATS.TEXT,
        );
        expect(composed.text).toContain('a clean preview');
        expect(composed.substituted).toBe(0);
    });

    it('never wears the archive\'s own extension, so a composed file '
        + 'cannot be mistaken for the byte-exact transcript export', () => {
        for (const format of Object.values(COMPOSED_FORMATS)) {
            const composed = composeExport(
                [], { query: 'q', coverage: 'c', scan: 'complete' }, format,
            );
            expect(composed.filename, format).not.toMatch(/\.jsonl$/);
            expect(composed.text, format).toContain('NOT a byte-exact transcript');
        }
    });

    it('takes a VERDICT and not a hit, so the file and the screen cannot '
        + 'disagree about one preview', () => {
        const hit = poisoned(SNIPPET_INCLUDED, 2);
        const verdict = snippetEgress(hit);
        // The SAME object the list paints from is what the export reads.
        expect(exportLine('loc', verdict).text).not.toContain(CANARY);
        expect(exportLine('loc', verdict).substituted).toBe(true);
    });
});

describe('the rendered DOM: a poisoned response paints no canary', () => {
    /** A client that answers one poisoned page. */
    function poisonedClient(rows: readonly unknown[]) {
        return {
            searchArchive: () => Promise.resolve({
                envelope: {
                    result: rows,
                    result_status: 'ok',
                    meta: {
                        scan: { status: 'limit_reached', transcripts_scanned: 1 },
                        scope: { kind: 'project', project_id: 12,
                                 transcripts_in_scope: 3416 },
                        paging: { next_cursor: 'abc' },
                    },
                },
                transportError: null,
            }),
        };
    }

    /** The injected classifier, standing in for the vanilla one. */
    const outcome = {
        classify: (e: unknown) => ({
            token: (e as { result_status?: string } | null)?.result_status === 'ok'
                ? 'ok' : 'cannot-determine',
            reasons: [],
        }),
    };

    /** Mount the panel and run one search. */
    async function paint(rows: readonly unknown[]): Promise<HTMLElement> {
        host = document.createElement('div');
        document.body.appendChild(host);
        mounted = mount(SearchPanel, {
            target: host,
            props: { client: poisonedClient(rows), outcome } as never,
        }) as Record<string, unknown>;
        await (mounted as unknown as { run(q: unknown): Promise<string> })
            .run({ q: 'restic', projectId: 12 });
        for (let i = 0; i < 6; i += 1) { flushSync(); await Promise.resolve(); }
        flushSync();
        return host;
    }

    it('paints every hit and NOT ONE canary, over the full cross product '
        + 'of states and finding counts', async () => {
        // `(included, 0)` is excluded for the reason stated in the export
        // block above: it is the one combination this client has no
        // evidence against, and it is asserted to RENDER in the next test.
        const rows = SERVER_STATES.flatMap((s) => [
            ...(s === SNIPPET_INCLUDED ? [] : [poisoned(s, 0)]),
            poisoned(s, 1), poisoned(s, 99),
        ]);
        const el = await paint(rows);
        // The hits are all there. A panel that rendered nothing would
        // pass the disclosure assertion and be useless.
        expect(el.querySelectorAll('.archive-search__hit')).toHaveLength(rows.length);
        // NOT A TEXT NODE. `textContent` walks every descendant.
        expect(el.textContent ?? '').not.toContain(CANARY);
        // AND NOT AN ATTRIBUTE. `textContent` cannot see one, and an
        // attribute is every bit as readable to a person with devtools
        // or to a page-scraping extension.
        expect(el.innerHTML).not.toContain(CANARY);
    });

    it('DOES paint a cleared preview, the positive control for the DOM '
        + 'assertions above', async () => {
        const el = await paint([cleared('a clean preview')]);
        expect(el.textContent ?? '').toContain('a clean preview');
    });

    it('paints a withheld hit with the SAME locating facts as any other, '
        + 'because a withheld preview is still a real hit', async () => {
        const el = await paint([poisoned('withheld_gate_unavailable', 3)]);
        const hit = el.querySelector('.archive-search__hit');
        expect(hit?.getAttribute('data-preview')).toBe('withheld');
        // The server's own word is on the DOM even though this client
        // refused it - the operator needs to see what was actually sent.
        expect(hit?.getAttribute('data-snippet-state')).toBe('withheld_gate_unavailable');
        expect(el.textContent ?? '').toContain('transcript 4');
        expect(el.textContent ?? '').toContain('line 292');
        expect(el.textContent ?? '').toContain('PREVIEW WITHHELD');
    });

    it('shows the gate\'s own verdict beside a refusal this client made, '
        + 'so the 9.7-percent case is VISIBLE and not silently swallowed',
    async () => {
        const el = await paint([poisoned(SNIPPET_INCLUDED, 3)]);
        const hit = el.querySelector('.archive-search__hit');
        // The server said `included`. This client withheld anyway. Both
        // facts are on the row.
        expect(hit?.getAttribute('data-snippet-state')).toBe('included');
        expect(hit?.getAttribute('data-preview')).toBe('withheld');
        expect(el.textContent ?? '').not.toContain(CANARY);
    });
});

describe('the structural control: nothing reaches around the door', () => {
    /**
     * One source file with its comments removed.
     *
     * Description: A SOURCE SCAN THAT READS PROSE IS NOT A SOURCE SCAN.
     *   Every file in this slice DESCRIBES what it refuses to do, so a
     *   bare substring search finds the promise and reports it as the
     *   violation. Carried over from slice 7's `codeOnly`.
     * Inputs: src - the file text. Output: the code, comments blanked.
     */
    function codeOnly(src: string): string {
        return src
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    }

    it('reads a `snippet` field in EXACTLY ONE file, the door itself',
    async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const mine = fs.readdirSync(here).filter(
            (f) => /^(search|export|outcome|mask)-/.test(f)
                || /^(SearchPanel|SearchHit|ExportModal|OutcomeBlock)\./.test(f),
        ).filter((f) => !f.endsWith('.test.ts'));

        // The guard is worthless over an empty set.
        expect(mine.length).toBeGreaterThan(8);

        const offenders: string[] = [];
        for (const f of mine) {
            const code = codeOnly(fs.readFileSync(path.join(here, f), 'utf8'));
            // `.snippet` as a property read, and `snippet:` / `snippet =`
            // as a field write. `snippet_state` is deliberately NOT a
            // violation: it is the gate's verdict, not the text.
            const reads = /\.snippet\b(?!_state)/.test(code)
                || /\bsnippet\s*[:=](?!=)/.test(code.replace(/snippet_state\s*[:=]/g, ''));
            if (reads) offenders.push(f);
        }
        // NAMES THE OFFENDER rather than asserting a bare false.
        expect(offenders).toEqual(['mask-egress.ts']);
    });

    it('the scan above is not vacuous: it finds a planted read', () => {
        const planted = codeOnly('const x = hit.snippet; // a comment about .snippet');
        expect(/\.snippet\b(?!_state)/.test(planted)).toBe(true);
        // And it does NOT fire on the prose it just stripped, nor on the
        // gate's verdict field, which every renderer legitimately reads.
        expect(/\.snippet\b(?!_state)/.test(codeOnly('// hit.snippet in prose'))).toBe(false);
        expect(/\.snippet\b(?!_state)/.test('h.snippet_state')).toBe(false);
    });
});
