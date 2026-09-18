/**
 * THE SCRATCH LABEL, AND THE PATHS THAT DO NOT HAVE A LEAF.
 *
 * The mounted card suite in `NavProjectCard.names.test.ts` proves the
 * label reaches the DOM on the right rung and on no other. This proves
 * the composition itself over the shapes a real corpus produces, which
 * a card test would need 17 mounts to cover.
 *
 * THE DEGENERATE CASES ARE THE POINT. `scratchLabel` is only ever fed
 * `app_name_cwd`, which is a value the server measured - but it is
 * declared null on every node and is null on most of them, and a label
 * that came back empty or ended in a bare separator would paint a
 * broken card rather than a quiet one. So every way of having no leaf
 * is asserted to answer the bare word.
 */
import { describe, expect, it } from 'vitest';
import { SCRATCH_QUALIFIER, scratchLabel, scratchLeaf } from './nav-scratch-label';

describe('the leaf is the last real component', () => {
    const cases: readonly (readonly [string, string])[] = [
        ['/private/tmp/permtest-45244', 'permtest-45244'],
        ['/private/tmp', 'tmp'],
        ['/private/var/folders/p6/T/cc_rht_work_ko0irget', 'cc_rht_work_ko0irget'],
        // A trailing separator is not a component, so it is not a leaf.
        ['/private/tmp/renametest/', 'renametest'],
        // Nor are repeated ones, which a joined path can produce.
        ['/private//tmp//forktest', 'forktest'],
        ['bare', 'bare'],
    ];
    for (const [cwd, leaf] of cases) {
        it(`"${cwd}" -> "${leaf}"`, () => {
            expect(scratchLeaf(cwd)).toBe(leaf);
            expect(scratchLabel(cwd)).toBe(`${SCRATCH_QUALIFIER} / ${leaf}`);
        });
    }
});

describe('a path with no leaf degrades to the bare word, never to nothing '
    + 'and never to a dangling separator', () => {
    const noLeaf: readonly unknown[] = ['/', '//', '', '   ', null, undefined, 42, {}];
    for (const cwd of noLeaf) {
        it(`${JSON.stringify(cwd) ?? String(cwd)} has no leaf`, () => {
            expect(scratchLeaf(cwd)).toBe(null);
            expect(scratchLabel(cwd)).toBe(SCRATCH_QUALIFIER);
        });
    }
});

describe('the label is short, which is the entire reason it exists', () => {
    it('the longest scratch path on this install renders under 30 '
        + 'characters, against 178 for the path it replaces', () => {
        const worst = '/private/tmp/claude-501/-Users-jsugamele-Library-Mobile-'
            + 'Documents-com-apple-CloudDocs-Sync-Development-CloudeCode/'
            + '2629dba5-234e-44d2-be54-ddaf69c8db4b/scratchpad/resizeprobe';
        expect(worst.length).toBeGreaterThan(170);
        expect(scratchLabel(worst)).toBe('scratch / resizeprobe');
        expect(scratchLabel(worst).length).toBeLessThan(30);
    });

    it('it always says what it is before it says which one, so a column of '
        + 'them reads as one kind of thing', () => {
        for (const cwd of ['/private/tmp/a', '/private/var/folders/x/T/b', '/']) {
            expect(scratchLabel(cwd).startsWith(SCRATCH_QUALIFIER)).toBe(true);
        }
    });
});
