/**
 * THE THREE PUBLIC COMMITMENTS FROM ISSUE #173, ASSERTED AGAINST THE
 * MOUNTED CONVERSATION VIEW, plus the ONE-FILE RULE that makes the
 * masking seam checkable.
 *
 * @vitest-environment jsdom
 *
 * SEPARATE FROM `ChatView.behaviour.test.ts` because it is a different
 * job, exactly as slices 5, 6 and 7 split theirs. Behaviour asks "does
 * the chat view do what the chat view did". This asks "did the port keep
 * the promises made to Adam about his re-skin": no new class names, not
 * one line of the 12 archive stylesheets touched, and any forced choice
 * named rather than slipped in.
 *
 * COMMITMENT 3 IS NOT FULLY ASSERTABLE HERE and is not pretended to be.
 * A forced choice is named in the commit message and in the header of the
 * file that makes it; a test cannot check that prose exists. What it CAN
 * check is that the one MECHANICAL half - the list of classes already
 * unstyled before this port - is a declared table rather than a filter
 * hidden in the assertion, which is what stops a thirteenth joining
 * quietly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatView from './ChatView.svelte';
import {
    ACTIONS, CLASS, MOD, UNSTYLED_PRE_EXISTING,
} from './chat-vocab';
import {
    block, fakeChatClient, maskableTurn, outcome, refusedTurn, syncRaf, turn,
    turnsPage,
} from './chat-harness';
import type { ArchiveClient } from './client';

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** Mount the view. */
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

/**
 * One source file with its comments removed.
 *
 * Description: A SOURCE SCAN THAT READS PROSE IS NOT A SOURCE SCAN.
 *   Every file in this slice DESCRIBES the things it refuses to do - "no
 *   `innerHTML`", "this component does not read `text`" - so a bare
 *   substring search finds the promise and reports it as the violation.
 *   Stripping block comments, line comments and HTML comments first means
 *   the scan answers "does this file DO it", which is the question.
 * Inputs: src - the file text. Output: the code, comments blanked.
 */
function codeOnly(src: string): string {
    return src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every class name actually painted into the mounted view. */
function emittedClasses(): Set<string> {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll(`.${CLASS.root}, .${CLASS.root} *`)) {
        const cls = el.getAttribute('class');
        if (!cls) continue;
        for (const one of cls.split(/\s+/)) if (one) seen.add(one);
    }
    return seen;
}

/** This directory, resolved once. */
async function here(): Promise<string> {
    const path = await import('node:path');
    const url = await import('node:url');
    return path.dirname(url.fileURLToPath(import.meta.url));
}

/** Every chat file this slice owns. */
const CHAT_MODULES = [
    'chat-vocab.ts', 'chat-mask.ts', 'chat-turn.ts', 'chat-info.ts',
    'chat-subagents.ts', 'chat-stack.ts', 'chat-estimate.ts', 'chat-load.ts',
    'chat-open.ts', 'chat-props.ts',
];

/** Every chat component this slice owns. */
const CHAT_COMPONENTS = [
    'ChatView.svelte', 'ChatTurn.svelte', 'ChatBlock.svelte', 'ChatInfo.svelte',
    'ChatSubagents.svelte', 'ChatChain.svelte', 'ChatStatus.svelte',
];

/**
 * Mount and drive EVERY surface, so every class gets a chance to paint.
 *
 * Description: a class-name guard is only as good as its coverage. This
 *   deliberately produces, in one mount: a breadcrumb, a bubble with a
 *   model chip and a secret chip, both header toggles, an open envelope
 *   panel with a gap row and an extra key, an open subagent list with a
 *   resolved control, an unresolved one and a spawn resolving to two
 *   transcripts, a plain text block, a collapsed disclosure carrying an
 *   errored tool result, a truncated block, a mask refusal, a withheld
 *   block, an unevaluated block, a turn with no blocks, a folded progress
 *   run, and an incomplete conversation with its sentinel and its pager.
 */
async function paintEverything(): Promise<void> {
    const wide = turn({
        line_no: 1,
        role: 'user',
        role_state: 'record_type_fallback',
        model: 'claude-opus-5',
        secret_finding_count: 2,
        info: { a_field_this_view_has_no_row_for: 'x', usage: { state: 'not_recorded' } },
        blocks_state: 'extracted',
        blocks: [
            block({ seq: 0, type: 'text', text: 'the prose' }),
            block({ seq: 1, type: 'tool_result', text: 'payload', tool_name: 'Bash',
                tool_use_id: 'toolu_1', is_error: true }),
            block({ seq: 2, type: 'text', text: 'short', text_length: 9000,
                text_truncated: true }),
            block({ seq: 3, type: 'text', text: null, text_length: 4096,
                text_state: 'withheld_secret_bearing' }),
            block({ seq: 4, type: 'text', text: null, text_state: 'a_future_word' }),
        ],
        subagents_state: 'partial',
        subagents: [
            { order: 1, order_basis: 'start_ts', link_state: 'resolved',
                start_ts: '2026-01-01T00:00:00Z', agent_ids: ['a1'],
                transcripts: [
                    { transcript_id: 91, session_ref: 'agent-a1', line_count: 12 },
                    { transcript_id: 92, session_ref: 'agent-a1', line_count: 12 },
                ] },
            { order: 2, order_basis: 'start_ts',
                link_state: 'tool_result_carries_no_agent_id',
                agent_ids: [], transcripts: [],
                spawned_by: { tool_name: 'Agent', line_no: 7 } },
        ],
    });
    const p = (n: number) => turn({
        line_no: n, record_type: 'progress', role: null, blocks: [],
        blocks_state: 'no_message_content',
    });
    const rows = [
        wide,
        refusedTurn({ line_no: 2 }),
        maskableTurn({ line_no: 3 }),
        turn({ line_no: 8, blocks: [], blocks_state: 'no_message_content' }),
        // A turn whose subagent lookup FAILED, so the `--unknown`
        // modifier paints too. Its expander is the second one on screen.
        turn({ line_no: 9, subagents: [], subagents_state: 'cannot_determine' }),
        p(10), p(11),
    ];
    // `true` with a cursor so the sentinel AND the pager both paint.
    const { client } = fakeChatClient({ page: turnsPage(rows, true, 'c1') });
    const api = mountView(client);
    await api.open();
    await settle();

    // Open both panels on the first bubble.
    document.querySelector<HTMLButtonElement>(`[data-action="${ACTIONS.INFO}"]`)?.click();
    await settle();
    for (const t of document.querySelectorAll<HTMLButtonElement>(
        `[data-action="${ACTIONS.SUBAGENTS}"]`,
    )) { t.click(); }
    await settle();
}

/**
 * The two declared classes no interaction can reach.
 *
 * Description: NAMED RATHER THAN SILENTLY SUBTRACTED. Both are GUARDS.
 *   `archive-chat-chain__none` renders only for a chain with no root,
 *   which `open()` always establishes before anything paints;
 *   `archive-chat-info__none` renders only when the envelope panel is
 *   asked for a turn the view does not hold, which the template cannot
 *   produce because it builds the panel from the turn it is painting.
 *   They are kept because deleting a guard to satisfy a coverage count
 *   is how a crash gets shipped, and they are listed here so "the
 *   antijoin did not cover this one" is a stated fact rather than a gap
 *   in a set difference nobody reads.
 */
const UNREACHABLE_THROUGH_THE_UI: readonly string[] = [
    'archive-chat-chain__none',
    'archive-chat-info__none',
];

describe('ChatView: the three public commitments', () => {
    it('COMMITMENT 1: emits only class names the vocabulary declares', async () => {
        await paintEverything();
        const allowed = new Set<string>([
            ...Object.values(CLASS), ...Object.values(MOD),
        ]);
        const seen = emittedClasses();
        // A guard over an empty set proves nothing.
        expect(seen.size).toBeGreaterThan(25);
        // NAMES THE OFFENDER. A bare `expect(false).toBe(true)` says a
        // class escaped and leaves the reader grepping for which one.
        expect([...seen].filter((c) => !allowed.has(c))).toEqual([]);
    });

    it('COMMITMENT 1, the other half: every class it emits already '
        + 'existed in the code this port replaces', async () => {
        // THE VOCABULARY COULD DECLARE ANYTHING. The test above checks
        // the view emits only what the table declares; this checks the
        // TABLE against the code it was copied from, so a class invented
        // for this port and dutifully listed as "allowed" is still caught.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join(await here(), '..', '..', '..', '..', '..', 'client', 'js');
        const vanilla = [
            'archive-chat-view.js', 'archive-chat-turn.js', 'archive-chat-block.js',
            'archive-chat-info.js', 'archive-chat-subagents.js',
            'archive-chat-stack.js', 'archive-chat-clicks.js',
            'archive-chat-estimate.js', 'archive-chat-screen.js',
        ].map((f) => codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n');
        expect(vanilla.length).toBeGreaterThan(5000);

        // THE SIX BEM ROOTS, matched as QUOTED LITERALS, which is exact:
        // each vanilla file writes `var ROOT_CLASS = 'archive-chat-...'`.
        for (const root of ['archive-chat', 'archive-chat-turn', 'archive-chat-block',
            'archive-chat-info', 'archive-chat-subagents', 'archive-chat-chain']) {
            expect(vanilla, root).toContain(`'${root}'`);
        }

        // THE REST, matched on the SUFFIX, which is forced by how the
        // vanilla builds its classes: never as one string, always as
        // `ROOT_CLASS + '__withheld-head'`. Weaker than an exact match on
        // the whole class, and still the property worth having: a class
        // invented here, say `archive-chat-turn__brand-new-thing`, has no
        // such suffix anywhere.
        const roots = new Set<string>([
            CLASS.root, CLASS.turn, CLASS.block, CLASS.info, CLASS.subagents,
            CLASS.chain,
        ]);
        const declared = [...Object.values(CLASS), ...Object.values(MOD)];
        const missing = declared.filter((c) => {
            if (roots.has(c)) return false;
            const cut = c.indexOf('__') === -1 ? c.indexOf('--') : c.indexOf('__');
            const suffix = c.slice(cut);
            return !vanilla.includes(`'${suffix}'`);
        });
        expect(missing).toEqual([]);

        // THE NEGATIVE CONTROL FOR THIS MATCHER: an invented suffix must
        // NOT pass it, or the assertion above would be vacuous.
        expect(vanilla.includes("'__brand-new-thing'")).toBe(false);
    });

    it('COMMITMENT 2: every class it emits already has a rule in the '
        + 'untouched archive stylesheets, bar twelve that never did', async () => {
        // THE ANTIJOIN, carried across from slices 5, 6 and 7, which
        // carried it from `tests/test_archive_tlist_styled.node.mjs`. That
        // test exists because a complete BEM tree once shipped matching
        // ZERO rules in any stylesheet and rendered in Chrome's
        // user-agent defaults in every theme. Nothing errored and no test
        // failed.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const cssDir = path.join(await here(), '..', '..', '..', '..', '..', 'client', 'css');
        const css = fs.readdirSync(cssDir)
            .filter((f) => f.startsWith('archive') && f.endsWith('.css'))
            .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8'))
            .join('\n');
        expect(css.length).toBeGreaterThan(1000);

        await paintEverything();
        const unstyled = [...emittedClasses()].filter((c) => !css.includes(`.${c}`));
        // The twelve are emitted by the VANILLA chat renderers today and
        // match nothing in any of the 12 stylesheets. Named in
        // `chat-vocab.ts` rather than quietly filtered here, so a
        // thirteenth cannot join them without somebody editing that list.
        // TEN OF THE TWELVE PAINT HERE; the other two are guards no
        // interaction can reach, named above rather than subtracted
        // silently, so this is an exact equality over a stated set and
        // not a subset check that would let a new one through.
        const reachable = [...UNSTYLED_PRE_EXISTING]
            .filter((c) => !UNREACHABLE_THROUGH_THE_UI.includes(c));
        expect(unstyled.slice().sort()).toEqual(reachable.sort());
        // And the two that did not paint really are declared, so this
        // test still owns all twelve.
        for (const c of UNREACHABLE_THROUGH_THE_UI) {
            expect(UNSTYLED_PRE_EXISTING, c).toContain(c);
        }
    });

    it('COMMITMENT 2, the other half: it touched no stylesheet, which is '
        + 'why the antijoin above is a real test', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const cssDir = path.join(await here(), '..', '..', '..', '..', '..', 'client', 'css');
        const files = fs.readdirSync(cssDir)
            .filter((f) => f.startsWith('archive') && f.endsWith('.css'));
        expect(files).toHaveLength(12);
        // COUNTED THE WAY THE COMMITMENT WAS: `wc -l`, which counts
        // NEWLINES. `split('\n').length` counts one more per file, for the
        // empty string after the final newline, and over twelve files
        // that is 4,456 - a number that would look like twelve lines of
        // drift and is nothing of the sort.
        const lines = files
            .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')
                .split('\n').length - 1)
            .reduce((a, b) => a + b, 0);
        expect(lines).toBe(4444);
    });

    it('COMMITMENT 3, its mechanical half: the pre-existing unstyled '
        + 'classes are a DECLARED table, not a filter hidden in a test', () => {
        expect([...UNSTYLED_PRE_EXISTING].sort()).toEqual([
            'archive-chat-block__len',
            'archive-chat-block__refused-why',
            'archive-chat-block__type',
            'archive-chat-block__withheld-size',
            'archive-chat-block__withheld-why',
            'archive-chat-chain__none',
            'archive-chat-info__none',
            'archive-chat-subagents--unknown',
            'archive-chat-subagents__name',
            'archive-chat-subagents__row',
            'archive-chat-turn__body',
            'archive-chat-turn__no-blocks',
        ]);
    });

    it('DECLARES NO STYLES OF ITS OWN: no component carries a <style> '
        + 'block, so nothing can leak past the stylesheets', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = await here();
        for (const f of CHAT_COMPONENTS) {
            const src = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
            expect(src, f).not.toContain('<style');
            // AND NO `:global`, which would reach outside this subtree.
            expect(src, f).not.toContain(':global(');
        }
    });

    it('USES NO `{@html}` ANYWHERE: transcript content is arbitrary text '
        + 'from the corpus and must never be parsed as markup', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = await here();
        for (const f of CHAT_COMPONENTS) {
            const src = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
            expect(src, f).not.toContain('{@html');
            expect(src, f).not.toContain('innerHTML');
        }
    });
});

describe('the masking seam is ONE file, and that is checkable', () => {
    it('ONLY `chat-mask.ts` READS A BLOCK\'S `.text`', async () => {
        // The vanilla stated this rule as a grep somebody had to remember
        // to run: "Grep for `.text` across client/js/archive-chat-*.js: it
        // must appear here and nowhere else." This is that grep, run.
        // `\b` after `text` is what keeps `.text_length` and `.text_state`
        // out of it - `_` is a word character - so the match is the raw
        // content field and nothing else.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = await here();
        const offenders: string[] = [];
        for (const f of [...CHAT_MODULES, ...CHAT_COMPONENTS]) {
            if (f === 'chat-mask.ts') continue;
            const src = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (/\.text\b/.test(src)) offenders.push(f);
        }
        expect(offenders).toEqual([]);

        // THE POSITIVE CONTROL: the matcher must FIND it in the one file
        // that is allowed to, or the assertion above would pass on a
        // broken regex.
        const seam = codeOnly(fs.readFileSync(path.join(dir, 'chat-mask.ts'), 'utf8'));
        expect(/\.text\b/.test(seam)).toBe(true);
    });

    it('AND ONLY `chat-mask.ts` IMPORTS THE MASKER', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = await here();
        const offenders: string[] = [];
        for (const f of [...CHAT_MODULES, ...CHAT_COMPONENTS]) {
            if (f === 'chat-mask.ts') continue;
            const src = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (src.includes('applyMask') || src.includes('maskBody')) offenders.push(f);
        }
        expect(offenders).toEqual([]);

        // AND IT IS A HARD IMPORT, not an injected seam. An injected
        // masker a composition root forgets to supply is a fail-OPEN
        // gate: the text renders, unmasked, and every rendering test
        // passes. So `chat-props.ts` must expose no way to pass one in.
        const props = codeOnly(fs.readFileSync(path.join(dir, 'chat-props.ts'), 'utf8'));
        expect(props).not.toContain('mask');
        const seam = fs.readFileSync(path.join(dir, 'chat-mask.ts'), 'utf8');
        expect(seam).toContain("import { applyMask } from './reader-gate'");
    });
});

describe('shell independence', () => {
    it('READS NOTHING OUTSIDE ITS OWN SUBTREE: no querySelector on the '
        + 'document, no closest(), no window measurement', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = await here();
        for (const f of [...CHAT_MODULES, ...CHAT_COMPONENTS]) {
            const src = codeOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
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
        for (const el of document.querySelectorAll<HTMLElement>(`.${CLASS.root} [style]`)) {
            expect(el.getAttribute('style') || '').toMatch(/^(height:|transform:)/);
        }
        expect(root?.getAttribute('style')).toBeNull();
    });

    it('TAKES NO FOURTH `app-screen` GAP: the only shell-shaped prop is '
        + 'the frame scheduler slice 7 already reported', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(await here(), 'chat-props.ts'), 'utf8');
        // The scrollport is OURS, so no `scrollport` prop; the view opens
        // no modal, so no `modalHost` prop.
        expect(src).not.toContain('scrollport');
        expect(src).not.toContain('modalHost');
        expect(src).toContain('raf?:');
    });
});
