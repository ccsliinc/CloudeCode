/**
 * The `session-card-action` surface end to end: what the mark-unread
 * plugin paints, that it is the SAME control the legacy builder paints,
 * that the flag gates it both ways, and that a click finds its `run`.
 *
 * THE EQUIVALENCE TEST IS THE LOAD-BEARING ONE, for the same reason it
 * was for the status LED: porting a control by hand and then testing it
 * against hand-written expectations proves only that the port agrees
 * with what the porter remembered. So it loads the REAL
 * client/js/session-status-ui.js in a `vm` sandbox and compares
 * `markUnreadHtml`'s output against this plugin's, attribute by
 * attribute, in both unread states and against a hostile session name.
 *
 * WHAT THE COMPARISON DELIBERATELY IGNORES, AND WHY. Attribute ORDER,
 * and the one attribute the renderer adds (`data-plugin-action`).
 * Nothing in this app selects on attribute order - no stylesheet, no
 * handler, no assistive technology - so pinning it would be pinning a
 * detail that cannot break a user. `data-plugin-action` is the id's
 * return trip from the DOM to `run`, it exists only on the plugin path,
 * and the test asserts its presence separately rather than waving it
 * through.
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
import { actionHtml, runSessionCardAction, sessionCardActions } from './session-card-actions';
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

/** The plugin's fragment for one row, with no registry lookup involved. */
function pluginHtml(r: SessionCardRow): string {
    const contribution = markUnreadPlugin.contributions[0]!;
    return actionHtml(contribution.id, contribution.payload as never, r);
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
        const rendered = sessionCardActions(row(), ctx({}));
        expect(rendered.map((a) => a.id)).toEqual([ACTION_ID]);
    });

    test('flag true - the control is rendered', () => {
        expect(sessionCardActions(row(), ctx({ [FLAG]: true })).map((a) => a.id))
            .toEqual([ACTION_ID]);
    });

    test('NEGATIVE CONTROL: flag false - the control is ABSENT', () => {
        const rendered = sessionCardActions(row(), ctx({ [FLAG]: false }));
        expect(rendered).toEqual([]);
        expect(JSON.stringify(rendered)).not.toContain('mark-unread-toggle');
    });

    test('NEGATIVE CONTROL: this file would notice if enabled were ignored', () => {
        // The block above asserts an ABSENCE, and an absence passes just
        // as well when the whole surface is empty or when the flag name
        // is misspelled. This pins the difference: the SAME registry, the
        // SAME row, the SAME call, and the only thing that moved is the
        // flag. If `enabled` stopped being consulted, `off` would equal
        // `on` and this fails; if the surface were empty, `on` would be
        // empty and this fails too.
        const on = sessionCardActions(row(), ctx({ [FLAG]: true }));
        const off = sessionCardActions(row(), ctx({ [FLAG]: false }));
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

    for (const unread of [false, true]) {
        test(`unread=${unread}: same tag, class, label, aria and data attributes`, () => {
            const r = row({ unread });
            const mine = parse(pluginHtml(r));
            const theirs = parse(legacy(r.name, unread));

            expect(mine.tag).toBe(theirs.tag);
            expect(mine.inner).toBe(theirs.inner);
            // The added attribute is named, not waved through.
            expect(mine.attrs['data-plugin-action']).toBe(ACTION_ID);
            delete mine.attrs['data-plugin-action'];
            expect(mine.attrs).toEqual(theirs.attrs);
        });
    }

    test('a hostile session name is escaped the same way in both', () => {
        const name = 'evil" onclick="x&<>\'';
        const mine = parse(pluginHtml({ name, unread: false }));
        const theirs = parse(legacy(name, false));
        delete mine.attrs['data-plugin-action'];
        expect(mine.attrs).toEqual(theirs.attrs);
        expect(mine.attrs['data-mark-unread']).not.toContain('onclick="');
    });

    test('NEGATIVE CONTROL: the comparison can actually fail', () => {
        const r = row();
        const theirs = parse(legacy(r.name, false));
        // The SAME row painted for the OPPOSITE state must not compare
        // equal. If it did, this whole block would be comparing nothing.
        const wrong = parse(pluginHtml({ ...r, unread: true }));
        delete wrong.attrs['data-plugin-action'];
        expect(wrong.attrs).not.toEqual(theirs.attrs);
        expect(wrong.inner).not.toBe(theirs.inner);
    });

    test('NEGATIVE CONTROL: the parser refuses markup it cannot read', () => {
        expect(() => parse('')).toThrow();
        expect(() => parse('<span class=unquoted>x</span>')).toThrow();
        expect(() => parse('<span>x')).toThrow();
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
