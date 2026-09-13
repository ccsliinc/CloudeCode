/**
 * THE CHORD ROUTER, AND EVERY REFUSAL IT MAKES.
 *
 * Ported from `tests/test_terminal_search_keys.node.mjs`, which the
 * Svelte port deleted along with the module it drove. The refusals are
 * the point: a chord that reaches xterm does not fail quietly, it TYPES
 * INTO SOMEBODY'S SHELL, and a suite that only drove the openings would
 * pass against a router that never refuses.
 *
 * THREE MUTATIONS WERE WATCHED GOING RED against this file before it was
 * believed: deleting the alternate-screen refusal, deleting the
 * closed-panel Cmd+G guard, and returning 'none' instead of 'shield' for
 * a plain character. A green negative control proves nothing until you
 * have seen it fail.
 */
import { describe, expect, test, vi } from 'vitest';

import { installKeyRouting, route, type KeyRoutingTarget } from './search-keys';

/** One keydown, with every modifier off unless named. */
function key(init: Record<string, unknown>): Record<string, unknown> {
    return { type: 'keydown', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

describe('opening', () => {
    test('Cmd+F opens and takes the chord away from the browser Find', () => {
        // The native dialog is BLIND to xterm - the terminal is painted,
        // not DOM - so it searches an empty page and looks broken.
        expect(route(key({ key: 'f', metaKey: true }), { screenActive: true })).toEqual({
            action: 'open',
            consume: 'both',
        });
    });

    test('NEGATIVE: an open modal blocks Cmd+F outright, and untouched', () => {
        expect(
            route(key({ key: 'f', metaKey: true }), { screenActive: true, modalOpen: true }),
        ).toEqual({ action: 'none', consume: 'none' });
    });

    test('NEGATIVE: Cmd+F does nothing when the terminal screen is not showing', () => {
        expect(route(key({ key: 'f', metaKey: true }), { screenActive: false })).toEqual({
            action: 'none',
            consume: 'none',
        });
    });

    test('NEGATIVE: Ctrl+F passes through on the alternate screen', () => {
        // Inside vim or less this is page-down. A pager you cannot page
        // is a worse outcome than no search panel.
        expect(
            route(key({ key: 'f', ctrlKey: true }), { screenActive: true, alternate: true }),
        ).toEqual({ action: 'none', consume: 'none' });
    });

    test('Ctrl+F DOES open on the normal screen - the positive twin', () => {
        // Without this the test above would pass against a router that
        // never opens on Ctrl+F at all.
        expect(
            route(key({ key: 'f', ctrlKey: true }), { screenActive: true, alternate: false }),
        ).toEqual({ action: 'open', consume: 'both' });
    });

    test("NEGATIVE: Cmd+Alt+F and Ctrl+Cmd+F are somebody else's chords", () => {
        for (const init of [
            { key: 'f', metaKey: true, altKey: true },
            { key: 'f', metaKey: true, ctrlKey: true },
        ]) {
            expect(route(key(init), { screenActive: true }).action).toBe('none');
        }
    });

    test('a second Cmd+F on an open panel refocuses rather than closing', () => {
        // Cmd+F is "find", not "toggle find" - the close controls are Esc
        // and the X. Note it opens even with the screen flag off, which
        // is what makes an already-open panel reachable.
        expect(route(key({ key: 'f', metaKey: true }), { open: true }).action).toBe('open');
    });

    test('NEGATIVE: a non-keydown is refused', () => {
        expect(route(key({ type: 'keyup', key: 'f', metaKey: true }), { screenActive: true })).toEqual(
            { action: 'none', consume: 'none' },
        );
        expect(route(null, { screenActive: true }).action).toBe('none');
    });
});

describe('walking matches', () => {
    test('Cmd+G and Ctrl+G step, Shift reverses', () => {
        expect(route(key({ key: 'g', metaKey: true }), { open: true }).action).toBe('next');
        expect(route(key({ key: 'g', ctrlKey: true }), { open: true }).action).toBe('next');
        expect(route(key({ key: 'g', metaKey: true, shiftKey: true }), { open: true }).action).toBe(
            'prev',
        );
    });

    test('NEGATIVE: Cmd+G and Ctrl+G do nothing at all while the panel is shut', () => {
        // Ctrl+G is readline's abort. Swallowing it on a closed panel
        // would break a chord the user relies on in every shell, and the
        // `consume: none` is half the claim: it must still REACH the pane.
        for (const init of [{ key: 'g', ctrlKey: true }, { key: 'g', metaKey: true }]) {
            expect(route(key(init), { open: false })).toEqual({
                action: 'none',
                consume: 'none',
            });
        }
    });

    test('Enter steps forward and Shift+Enter steps back, inside the panel', () => {
        expect(route(key({ key: 'Enter' }), { open: true, inPanel: true }).action).toBe('next');
        expect(route(key({ key: 'Enter', shiftKey: true }), { open: true, inPanel: true }).action).toBe(
            'prev',
        );
    });

    test('the arrows walk the prompt rail, not the matches', () => {
        expect(route(key({ key: 'ArrowUp' }), { open: true, inPanel: true }).action).toBe('jump-up');
        expect(route(key({ key: 'ArrowDown' }), { open: true, inPanel: true }).action).toBe(
            'jump-down',
        );
    });
});

describe('closing, and the shield', () => {
    test('Escape from inside the panel closes it', () => {
        expect(route(key({ key: 'Escape' }), { open: true, inPanel: true })).toEqual({
            action: 'close',
            consume: 'both',
        });
    });

    test('NEGATIVE: Escape typed AT THE PANE is claude\'s, not ours', () => {
        expect(route(key({ key: 'Escape' }), { open: true, inPanel: false }).action).toBe('none');
    });

    test('a plain character in the field is SHIELDED, stopped and not prevented', () => {
        // Stopping it keeps it out of the pane; PREVENTING it would also
        // stop the field receiving the character the user just typed, so
        // the box would take no input at all while looking normal.
        for (const k of ['r', 'm', ' ', '-', 'f', 'Backspace', 'Home', 'x']) {
            expect(route(key({ key: k }), { open: true, inPanel: true })).toEqual({
                action: 'shield',
                consume: 'stop',
            });
        }
    });

    test('NEGATIVE: the same characters typed at the pane are not ours', () => {
        for (const k of ['r', 'Backspace', 'x']) {
            expect(route(key({ key: k }), { open: true, inPanel: false }).action).toBe('none');
        }
    });
});

describe('the installed listener', () => {
    /** A recording target, and the world it reports. */
    function harness(world: Partial<Record<string, boolean>> = {}) {
        const calls: string[] = [];
        const target: KeyRoutingTarget = {
            isOpen: () => !!world.open,
            containsTarget: () => !!world.inPanel,
            alternate: () => !!world.alternate,
            screenActive: () => world.screenActive !== false,
            modalOpen: () => !!world.modalOpen,
            open: () => calls.push('open'),
            close: () => calls.push('close'),
            step: (dir) => calls.push(dir),
            jump: (delta) => calls.push(`jump ${delta}`),
        };
        return { calls, target };
    }

    /** A keydown carrying spies for the two things a decision consumes. */
    function event(init: Record<string, unknown>) {
        const e = {
            ...key(init),
            target: null,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        return e;
    }

    /** A document stand-in that hands one listener one event. */
    function docWith(): { doc: Document; fire: (e: unknown) => void } {
        let handler: ((e: unknown) => void) | null = null;
        const doc = {
            addEventListener: (_t: string, fn: (e: unknown) => void) => {
                handler = fn;
            },
            removeEventListener: () => {
                handler = null;
            },
        } as unknown as Document;
        return { doc, fire: (e) => handler?.(e) };
    }

    test('an acted-on chord is prevented AND stopped, and reaches the target', () => {
        const { calls, target } = harness();
        const { doc, fire } = docWith();
        installKeyRouting(target, doc);
        const e = event({ key: 'f', metaKey: true });
        fire(e);
        expect(calls).toEqual(['open']);
        expect(e.preventDefault).toHaveBeenCalledOnce();
        expect(e.stopPropagation).toHaveBeenCalledOnce();
    });

    test('a shielded character is stopped and NOT prevented, and runs nothing', () => {
        const { calls, target } = harness({ open: true, inPanel: true });
        const { doc, fire } = docWith();
        installKeyRouting(target, doc);
        const e = event({ key: 'q' });
        fire(e);
        expect(calls).toEqual([]);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(e.stopPropagation).toHaveBeenCalledOnce();
    });

    test('NEGATIVE: an unrecognised key is left completely alone', () => {
        const { calls, target } = harness();
        const { doc, fire } = docWith();
        installKeyRouting(target, doc);
        const e = event({ key: 'q' });
        fire(e);
        expect(calls).toEqual([]);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(e.stopPropagation).not.toHaveBeenCalled();
    });

    test('the arrows and the steps reach the target', () => {
        const { calls, target } = harness({ open: true, inPanel: true });
        const { doc, fire } = docWith();
        installKeyRouting(target, doc);
        fire(event({ key: 'ArrowUp' }));
        fire(event({ key: 'ArrowDown' }));
        fire(event({ key: 'Enter' }));
        fire(event({ key: 'Enter', shiftKey: true }));
        fire(event({ key: 'Escape' }));
        expect(calls).toEqual(['jump -1', 'jump 1', 'next', 'prev', 'close']);
    });

    test('the returned teardown removes the listener', () => {
        const { calls, target } = harness();
        const { doc, fire } = docWith();
        installKeyRouting(target, doc)();
        fire(event({ key: 'f', metaKey: true }));
        expect(calls).toEqual([]);
    });
});
