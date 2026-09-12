/**
 * The `session-card-action` surface end to end: what the mark-unread
 * item SAYS, that it says the same words the legacy control says, that
 * the flag gates it both ways, and that activating it finds its `run`.
 *
 * WHAT THE EQUIVALENCE TEST COMPARES, AND WHY IT CHANGED. It used to
 * compare MARKUP: the plugin emitted a `<span role="button">` with a
 * glyph, a class list and `data-mark-unread`, and this file parsed both
 * that and `session-status-ui.js::markUnreadHtml` and matched them
 * attribute by attribute. Since the 1.2.1 row menu, a contribution
 * supplies no markup at all - the menu renders every item as the same
 * `<button role="menuitem">` - so there is no longer any markup to
 * compare, and pretending otherwise would be testing a renderer this
 * surface does not have.
 *
 * WHAT SURVIVED IS THE PART A USER CAN SEE. Both surfaces still exist:
 * the sidebar row menu shows this item, and the unmigrated launchpad
 * still draws the inline envelope through `markUnreadHtml`. If the two
 * came to describe one action in different words, a user would meet two
 * different features. So this loads the REAL legacy builder in a `vm`
 * sandbox and compares its `title` and `aria-label` against the
 * contribution's `label`, in both unread states.
 *
 * THE NEGATIVE CONTROLS ARE NOT DECORATION. A matcher that always finds
 * something is worse than useless, so: the comparison is proven capable
 * of FAILING, and the flag-off case is asserted as an absence with a
 * companion block that would fail if `enabled` were ignored.
 *
 * Run with: npm test   (from web/)
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Imported for its registration side effect: this is the real ship
// list, so these blocks exercise what the browser actually gets.
import './builtin';
import { runSessionCardAction, sessionCardMenuItems } from './session-card-actions';
import { surfacesOf } from './registry';
import { ACTION_ID, FLAG, markUnreadPlugin } from './mark-unread/index';
import type { PluginContext, SessionCardRow } from './types';

/** Repo root, three levels up from web/src/lib/plugins. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** A PluginContext whose `refresh` records the calls made to it. */
interface RecordingContext extends PluginContext {
    refresh: ReturnType<typeof vi.fn<() => void>>;
}

/** A context carrying the given flags and a recording refresh. */
function ctx(flags: Record<string, boolean> = {}): RecordingContext {
    return { flags, refresh: vi.fn<() => void>() };
}

/** One row fixture. Inputs: overrides. Output: SessionCardRow. */
function row(overrides: Partial<SessionCardRow> = {}): SessionCardRow {
    return { name: 'cloude_api', unread: false, ...overrides };
}

/**
 * The real legacy builder, loaded from disk.
 *
 * Description: a bare `vm` context with a `window` and a `console` and
 *   nothing else. `markUnreadHtml` gates on `globalThis.UIFlags`, which
 *   is absent in there, so it renders - which is the branch this
 *   comparison is about. Its own flag behaviour is the legacy file's
 *   test to keep.
 * Inputs: none.
 * Output: function - markUnreadHtml(tmuxName, unread) -> string.
 */
function legacyMarkUnreadHtml(): (name: string, unread: boolean) => string {
    const context: Record<string, unknown> = { console, window: {} };
    vm.createContext(context);
    const src = fs.readFileSync(
        path.join(repoRoot, 'client', 'js', 'session-status-ui.js'), 'utf8');
    vm.runInContext(src, context);
    const ui = (context['window'] as Record<string, unknown>)['SessionStatusUI'] as {
        markUnreadHtml(name: string, unread: boolean): string;
    };
    return (name, unread) => ui.markUnreadHtml(name, unread);
}

/** One parsed element: its tag, its attributes and its inner markup. */
interface Parsed {
    tag: string;
    attrs: Record<string, string>;
    inner: string;
}

/**
 * Parse one whole element into tag, attribute map and inner markup.
 *
 * Description: deliberately small and strict rather than a real parser -
 *   both inputs are markup this repo writes, both are a single `<span>`
 *   with double-quoted attributes, and a shape it cannot read must
 *   THROW rather than silently compare two empty maps. A lenient parser
 *   here is how an equivalence test starts passing on nothing.
 * Inputs: html - one element.
 * Output: Parsed.
 * Example: parse('<span a="1">x</span>') -> {tag: 'span', attrs: {a: '1'}, inner: 'x'}
 */
function parse(html: string): Parsed {
    const open = html.match(/^<([a-z]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*>/);
    if (!open) throw new Error(`not a single open tag: ${html.slice(0, 80)}`);
    const close = `</${open[1]}>`;
    if (!html.endsWith(close)) throw new Error(`does not end with ${close}`);
    const attrs: Record<string, string> = {};
    for (const m of (open[2] ?? '').matchAll(/\s+([a-zA-Z-]+)="([^"]*)"/g)) {
        attrs[m[1] as string] = m[2] as string;
    }
    return {
        tag: open[1] as string,
        attrs,
        inner: html.slice(open[0].length, html.length - close.length),
    };
}

/** The plugin's label for one row, with no registry lookup involved. */
function pluginLabel(r: SessionCardRow): string {
    const contribution = markUnreadPlugin.contributions[0]!;
    return (contribution.payload as { label(row: SessionCardRow): string }).label(r);
}

afterEach(() => {
    delete (globalThis as { API?: unknown }).API;
});

describe('the shipped surface', () => {
    test('mark-unread is registered on session-card-action, exactly once', () => {
        const held = surfacesOf('session-card-action');
        expect(held.map((c) => c.id)).toContain(ACTION_ID);
        expect(held.filter((c) => c.id === ACTION_ID)).toHaveLength(1);
    });

    test('it contributes to no other surface', () => {
        expect(surfacesOf('sidebar-item')).toEqual([]);
        expect(surfacesOf('launchpad-panel')).toEqual([]);
        expect(surfacesOf('status-source')).toEqual([]);
    });
});

describe('the flag gates it, both ways', () => {
    test('flag absent - the control is rendered, because a failed read never hides', () => {
        const rendered = sessionCardMenuItems(row(), ctx({}));
        expect(rendered.map((a) => a.id)).toEqual([ACTION_ID]);
    });

    test('flag true - the control is rendered', () => {
        expect(sessionCardMenuItems(row(), ctx({ [FLAG]: true })).map((a) => a.id))
            .toEqual([ACTION_ID]);
    });

    test('NEGATIVE CONTROL: flag false - the control is ABSENT', () => {
        const rendered = sessionCardMenuItems(row(), ctx({ [FLAG]: false }));
        expect(rendered).toEqual([]);
        expect(JSON.stringify(rendered)).not.toContain('unread');
    });

    test('NEGATIVE CONTROL: this file would notice if enabled were ignored', () => {
        // The block above asserts an ABSENCE, and an absence passes just
        // as well when the whole surface is empty or when the flag name
        // is misspelled. This pins the difference: the SAME registry, the
        // SAME row, the SAME call, and the only thing that moved is the
        // flag. If `enabled` stopped being consulted, `off` would equal
        // `on` and this fails; if the surface were empty, `on` would be
        // empty and this fails too.
        const on = sessionCardMenuItems(row(), ctx({ [FLAG]: true }));
        const off = sessionCardMenuItems(row(), ctx({ [FLAG]: false }));
        expect(on).toHaveLength(1);
        expect(off).toHaveLength(0);
        expect(off).not.toEqual(on);
    });

    test('a disabled action cannot be RUN either, even from a stale fragment', () => {
        // A menu can sit open across a poll or a flag change, so the
        // fragment on screen is not proof the action still applies.
        const setSessionUnread = vi.fn(async () => ({}));
        (globalThis as { API?: unknown }).API = { setSessionUnread };
        const context = ctx({ [FLAG]: false });
        return runSessionCardAction(ACTION_ID, row(), context).then((ran) => {
            expect(ran).toBe(false);
            expect(setSessionUnread).not.toHaveBeenCalled();
        });
    });
});

describe('equivalence with the legacy control', () => {
    const legacy = legacyMarkUnreadHtml();

    /** The legacy control's own label for one row. Inputs: row. Output: string. */
    function legacyLabel(r: SessionCardRow): string {
        const p = parse(legacy(r.name, r.unread));
        // The builder writes the same string into both, and the menu item
        // has only one label, so a disagreement between them would make
        // "the same words" ambiguous. Assert they agree before using one.
        expect(p.attrs['title']).toBe(p.attrs['aria-label']);
        return p.attrs['title'] as string;
    }

    for (const unread of [false, true]) {
        test(`unread=${unread}: the two surfaces say the same words`, () => {
            const r = row({ unread });
            expect(pluginLabel(r)).toBe(legacyLabel(r));
        });
    }

    test('the label states the RESULT, so it flips with the row', () => {
        expect(pluginLabel(row({ unread: false }))).toMatch(/mark unread/);
        expect(pluginLabel(row({ unread: true }))).toMatch(/clear unread/);
    });

    test('NEGATIVE CONTROL: the comparison can actually fail', () => {
        // The SAME row read for the OPPOSITE state must not compare equal.
        // If it did, the block above would be comparing nothing.
        expect(pluginLabel(row({ unread: true })))
            .not.toBe(legacyLabel(row({ unread: false })));
    });

    test('NEGATIVE CONTROL: the parser refuses markup it cannot read', () => {
        expect(() => parse('')).toThrow();
        expect(() => parse('<span class=unquoted>x</span>')).toThrow();
        expect(() => parse('<span>x')).toThrow();
    });

    test('the shortcut letter does not collide with the native menu table', () => {
        // R, G, F, N, M, T, C are the seven letters
        // client/js/session-row-menu-items.js binds. A contribution taking
        // one of them would render a hint the key handler could only ever
        // resolve to whichever item it found first.
        const native = new Set(['R', 'G', 'F', 'N', 'M', 'T', 'C']);
        const items = sessionCardMenuItems(row(), ctx({}));
        expect(items).toHaveLength(1);
        for (const item of items) expect(native.has(item.shortcut)).toBe(false);
    });

    test('the order lands in a gap the native table left, not on top of one', () => {
        // The native items sort 100, 300, 400, 500, 600, 700, 800.
        const taken = new Set([100, 300, 400, 500, 600, 700, 800]);
        for (const item of sessionCardMenuItems(row(), ctx({}))) {
            expect(taken.has(item.order)).toBe(false);
            expect(item.order).toBeGreaterThan(100);
            expect(item.order).toBeLessThan(300);
        }
    });
});

describe('running it', () => {
    test('it PATCHes the opposite of the painted state, then repaints', async () => {
        const setSessionUnread = vi.fn(async () => ({}));
        (globalThis as { API?: unknown }).API = { setSessionUnread };
        const context = ctx({});
        const ran = await runSessionCardAction(ACTION_ID, row({ unread: false }), context);
        expect(ran).toBe(true);
        expect(setSessionUnread).toHaveBeenCalledWith('cloude_api', true);
        expect(context.refresh).toHaveBeenCalledTimes(1);
    });

    test('an already-unread row is cleared', async () => {
        const setSessionUnread = vi.fn(async () => ({}));
        (globalThis as { API?: unknown }).API = { setSessionUnread };
        await runSessionCardAction(ACTION_ID, row({ unread: true }), ctx({}));
        expect(setSessionUnread).toHaveBeenCalledWith('cloude_api', false);
    });

    test('a failed PATCH is logged, swallowed, and does NOT repaint', async () => {
        const setSessionUnread = vi.fn(async () => { throw new Error('boom'); });
        (globalThis as { API?: unknown }).API = { setSessionUnread };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const context = ctx({});
        try {
            await expect(runSessionCardAction(ACTION_ID, row(), context)).resolves.toBe(true);
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
        expect(context.refresh).not.toHaveBeenCalled();
    });

    test('an unknown id runs nothing and says so', async () => {
        const setSessionUnread = vi.fn(async () => ({}));
        (globalThis as { API?: unknown }).API = { setSessionUnread };
        expect(await runSessionCardAction('no-such-action', row(), ctx({}))).toBe(false);
        expect(setSessionUnread).not.toHaveBeenCalled();
    });

    test('a missing window.API is reported, not thrown past the menu', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const context = ctx({});
        try {
            expect(await runSessionCardAction(ACTION_ID, row(), context)).toBe(true);
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
        expect(context.refresh).not.toHaveBeenCalled();
    });
});
