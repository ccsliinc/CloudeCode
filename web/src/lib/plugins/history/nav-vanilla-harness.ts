/**
 * LOAD A VANILLA `client/js/archive-nav-*.js` MODULE INTO A TEST.
 *
 * WHY: the ordering rule and the fuzzy ranking are where a silent
 * behaviour change hides, and the only way to prove a port matches is to
 * run BOTH over the same inputs and compare. Asserting my port against
 * my own expectations proves my expectations, not the port. This
 * evaluates the real vanilla file, from disk, unmodified.
 *
 * IT IS A TEST HELPER AND NOTHING SHIPS AGAINST IT. Nothing under
 * `history/` imports this outside a `.test.ts`; the modules it loads are
 * the ones this slice replaces.
 *
 * THE FAKE WINDOW IS THE POINT. Each vanilla file is an IIFE that hangs
 * its exports off `window` and logs on load. Handing it a plain object
 * and a silent console runs it exactly as the browser does, with none of
 * its dependencies guessed at: whatever it reaches for is whatever the
 * caller put on the object, and a missing one produces the same
 * `console.error` the browser would.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `client/js`, from this file. */
const CLIENT_JS = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', 'client', 'js',
);

/** The fake window a vanilla module hangs its exports off. */
export type FakeWindow = Record<string, unknown>;

/**
 * Evaluate one vanilla client module against a fake window.
 *
 * Description: the module's exports land ON the window object handed in,
 *   so loading several in dependency order into one object reproduces
 *   the browser's `<script>` sequence.
 * Inputs: file - e.g. 'archive-nav-order.js'. win - the fake window,
 *   mutated in place and returned.
 * Output: the same object, now carrying the module's exports.
 * Example: loadVanilla('archive-nav-fuzzy.js', {}).ArchiveNavFuzzy
 */
export function loadVanilla(file: string, win: FakeWindow = {}): FakeWindow {
    const source = readFileSync(join(CLIENT_JS, file), 'utf8');
    const silent = { log: () => {}, error: () => {}, warn: () => {} };
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'console', source) as
        (w: FakeWindow, c: typeof silent) => void;
    run(win, silent);
    return win;
}

/** A row as the vanilla modules pass it around: a bag of unknown fields. */
export type VanillaRow = Record<string, unknown>;

/** One parked node, as `ArchiveNavOrder.sortNodes` reports it. */
export interface VanillaParked {
    readonly node: VanillaRow;
    readonly reason: { readonly short: string; readonly title: string };
}

/**
 * The shape of `window.ArchiveNavOrder`, as far as the parity tests use
 * it. Declared rather than indexed off a `Record`, so a typo is a
 * compile error and a call site needs no cast of its own.
 */
export interface VanillaOrderModule {
    sortNodes(nodes: unknown, modeId: unknown): {
        nodes: VanillaRow[]; ordered: number; mode: string; parked: VanillaParked[];
    };
    activityCell(row: unknown): { text: string; title: string; known: boolean } | null;
    unsortedReason(row: unknown, kind: string): { short: string; title: string };
}

/** One ranked row, as `ArchiveNavFuzzy.rank` reports it. */
export interface VanillaRanked {
    readonly row: VanillaRow;
    readonly score: number;
    readonly field: string;
    readonly positions: number[];
}

/** The shape of `window.ArchiveNavFuzzy`. */
export interface VanillaFuzzyModule {
    rank(rows: unknown, needle: unknown, fields: unknown): VanillaRanked[];
    match(text: unknown, needle: unknown): { score: number; positions: number[] } | null;
}

/** The shape of `window.ArchiveNavMerged`. */
export interface VanillaMergedModule {
    filterByHost(nodes: unknown, hostId: unknown): VanillaRow[];
    partitionUnattributed(rows: unknown): {
        shown: { row: VanillaRow; reason: string }[];
        hidden: { row: VanillaRow; reason: string }[];
    };
    FIELDS: { name: string; weight: number }[];
}

/** The shape of `window.ArchiveNavRow`. */
export interface VanillaRowModule {
    labelFor(kind: string, row: unknown): string;
    titleFor(kind: string, row: unknown): string;
    idFor(kind: string, row: unknown): number | string | null;
    countFor(kind: string, row: unknown): number | null;
    renderCount(n: unknown): string;
    describeFilter(matched: unknown, loaded: unknown, total: unknown, noun: string): string;
    filterRows(rows: unknown, needle: unknown, fields: unknown): VanillaRow[];
    shouldShowUnattributed(row: unknown): { show: boolean; reason: string };
    unattributedNote(row: unknown): { text: string; answered: boolean };
}

/** The shape of `window.ArchiveNavCard`. */
export interface VanillaCardModule {
    sessionCountFor(row: unknown): { state: string; value: number | null };
    countsTitle(session: unknown, total: unknown): string;
    presentationFor(row: unknown, overlay: unknown): Record<string, unknown>;
}

/** The shape of `window.ArchiveNavInfo`. */
export interface VanillaInfoModule {
    machinesHeading(hosts: unknown): { text: string; known: boolean };
    machineRows(row: unknown): VanillaRow[];
}
