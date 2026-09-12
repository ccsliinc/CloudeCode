/**
 * THE SHARED MODULES AND THE CATALOG MUST SAY THE SAME THING.
 *
 * FOUR LEGACY MODULES SURVIVE SLICE 5 BECAUSE THE SIDEBAR ROW DRAWS FROM
 * THEM: `session-row-actions.js` (which controls a status earns, and what
 * each is called), `session-startup-gate.js` (the "needs a keypress"
 * badge), `session-status-ui.js` (the mark-unread wording) and
 * `session-theme-tint.js` (the swatch). The running-sessions card renders
 * its own elements from their DATA halves and takes its WORDS from the
 * catalog, so there are now two carriers for one set of sentences.
 *
 * TWO CARRIERS IS FINE. TWO ANSWERS IS NOT. A user looking at the sidebar
 * row and the home card for one session must not read two different
 * descriptions of one control, which is the exact failure the shared
 * modules were extracted to prevent in the first place. So every string
 * the card took into the catalog is compared, here, against the real
 * legacy module loaded in a `vm` sandbox - not against a copy of it, and
 * not against what the porter remembered.
 *
 * THE NEGATIVE CONTROLS ARE LOAD BEARING. A comparison that could not fail
 * would pass this whole file while the two sides said anything at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

import enCatalog from '../../../../client/js/i18n/catalog.en.js';
import { glyphSvg } from '../../../../client/js/icons/glyphs.js';
import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** The catalog value for a key, as a string. Plural sets are refused. */
function message(key: string): string {
    const value = (enCatalog as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
        throw new Error(`${key} is not a plain message`);
    }
    return value;
}

/**
 * Load legacy classic scripts into one sandbox and hand back its window.
 *
 * Description: THE REAL FILES, NOT A FIXTURE. A hand-written stand-in
 *   would only prove the port agrees with what the porter remembered,
 *   which is the failure mode this whole file exists to close.
 * Inputs: files - paths under client/js.
 * Output: the sandbox's `window`.
 * Example: legacyWindow(['session-row-actions.js'])
 */
function legacyWindow(files: string[]): Record<string, any> {
    const context: Record<string, unknown> = { console };
    context.window = context;
    context.globalThis = context;
    context.CloudeGlyphs = { glyphSvg };
    vm.createContext(context);
    for (const file of files) {
        const source = fs.readFileSync(
            path.join(repoRoot, 'client', 'js', file), 'utf8');
        vm.runInContext(source, context);
    }
    return context as Record<string, any>;
}

describe('the destructive row controls say what the sidebar says', () => {
    const win = legacyWindow(['session-status-ui.js', 'session-row-actions.js']);
    const actions = win.SessionRowActions;

    test('close, remove and restart each match their catalog message', () => {
        expect(message(RUNNING_SESSION_KEYS.actionClose))
            .toBe(actions.labelFor(actions.ACTION_CLOSE));
        expect(message(RUNNING_SESSION_KEYS.actionRemove))
            .toBe(actions.labelFor(actions.ACTION_REMOVE));
        expect(message(RUNNING_SESSION_KEYS.actionRestart))
            .toBe(actions.labelFor(actions.ACTION_RESTART));
    });

    test('NEGATIVE CONTROL: the comparison is capable of failing', () => {
        expect(message(RUNNING_SESSION_KEYS.actionClose))
            .not.toBe(actions.labelFor(actions.ACTION_REMOVE));
    });

    test('A LIVE ROW EARNS RESTART, measured against the real rule', () => {
        // MUTATION 4's target. The card reads this module rather than
        // holding a status list of its own, so the sidebar and the card
        // cannot disagree about what a row may do.
        for (const status of actions.LIVE_STATUSES) {
            const offered = actions.actionsFor(status);
            expect(offered, `status ${status}`).toContain(actions.ACTION_RESTART);
            expect(offered, `status ${status}`).toContain(actions.ACTION_CLOSE);
            expect(offered, `status ${status}`).not.toContain(actions.ACTION_REMOVE);
        }
        expect(actions.LIVE_STATUSES.length).toBeGreaterThan(3);
    });

    test('a DEAD row earns restart and remove, and no close', () => {
        expect(actions.actionsFor('dead'))
            .toEqual([actions.ACTION_RESTART, actions.ACTION_REMOVE]);
    });

    test('UNKNOWN is never treated as dead', () => {
        expect(actions.actionsFor('unknown')).toEqual([actions.ACTION_CLOSE]);
    });
});

describe('the startup gate says what the sidebar badge says', () => {
    const win = legacyWindow(['session-startup-gate.js']);
    const gate = win.SessionStartupGate;

    test('the badge text and the sentence both match the catalog', () => {
        expect(message(RUNNING_SESSION_KEYS.startupGateLabel)).toBe(gate.LABEL);
        expect(message(RUNNING_SESSION_KEYS.startupGateReason)).toBe(gate.REASON);
    });

    test('NEGATIVE CONTROL: the two messages are not the same string', () => {
        // A badge whose two-word label and whose full sentence were the
        // same value would pass the test above while saying nothing
        // useful to a screen reader.
        expect(message(RUNNING_SESSION_KEYS.startupGateLabel))
            .not.toBe(message(RUNNING_SESSION_KEYS.startupGateReason));
    });

    test('and the card paints on the SAME value the shared predicate does', () => {
        expect(gate.isAwaiting('awaiting_startup_prompt')).toBe(true);
        expect(gate.isAwaiting('ready')).toBe(false);
        expect(gate.isAwaiting('unknown')).toBe(false);
        expect(gate.isAwaiting(undefined)).toBe(false);
    });
});

describe('the mark-unread wording', () => {
    const win = legacyWindow(['session-status-ui.js']);

    /** The `title` attribute out of the legacy builder, for one state. */
    function legacyTitle(unread: boolean): string {
        const html = win.SessionStatusUI.markUnreadHtml('cloude_api', unread);
        const match = /title="([^"]*)"/.exec(html);
        if (!match) throw new Error('markUnreadHtml emitted no title');
        return match[1]!;
    }

    test('both states match the catalog, word for word', () => {
        expect(message(RUNNING_SESSION_KEYS.unreadClear)).toBe(legacyTitle(true));
        expect(message(RUNNING_SESSION_KEYS.unreadSet)).toBe(legacyTitle(false));
    });

    test('NEGATIVE CONTROL: the two states really do say different things', () => {
        expect(legacyTitle(true)).not.toBe(legacyTitle(false));
    });
});

describe('the theme swatch reads the SHARED colour rule', () => {
    const win = legacyWindow(['session-theme-tint.js']);

    test('colorsFor is exported as DATA, which is what the card consumes', () => {
        // The card renders its own element from this rather than splicing
        // `swatchHtml`'s markup, because there is no `{@html}` in this
        // migration. Both halves therefore rest on one colour lookup.
        expect(typeof win.SessionThemeTint.colorsFor).toBe('function');
        // With no theme registry loaded it can determine nothing, which is
        // the honest answer and the one an unthemed row renders.
        expect(win.SessionThemeTint.colorsFor('dracula')).toBeNull();
        expect(win.SessionThemeTint.colorsFor(null)).toBeNull();
    });
});

describe('the five icons are ONE set of coordinates, two renderers', () => {
    const win = legacyWindow(['session-status-ui.js']);

    test('every legacy builder emits exactly the shared glyph data', () => {
        // SLICE 5 MOVED THE PATH DATA, NOT THE ICON. The Svelte side
        // renders these as real elements; the legacy side still needs a
        // string. A copy of the geometry in each tree is the DRY violation
        // with the most visible failure mode there is - the same button
        // drawn two different shapes on two screens.
        const ui = win.SessionStatusUI;
        expect(ui.closeIconSvg()).toBe(glyphSvg('close'));
        expect(ui.trashIconSvg()).toBe(glyphSvg('trash'));
        expect(ui.restartIconSvg()).toBe(glyphSvg('restart'));
        expect(ui.pencilIconSvg()).toBe(glyphSvg('pencil'));
    });

    test('NEGATIVE CONTROL: the glyphs are not all the same string', () => {
        expect(glyphSvg('close')).not.toBe(glyphSvg('trash'));
        expect(glyphSvg('envelope-outline')).not.toBe(glyphSvg('envelope-filled'));
    });

    test('the unread control draws the two envelopes by SHAPE, not colour', () => {
        const filled = win.SessionStatusUI.markUnreadHtml('cloude_api', true);
        const outline = win.SessionStatusUI.markUnreadHtml('cloude_api', false);
        expect(filled).toContain(glyphSvg('envelope-filled'));
        expect(outline).toContain(glyphSvg('envelope-outline'));
    });
});
