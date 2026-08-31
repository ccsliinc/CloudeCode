// THE ARCHIVE KEYBOARD MAP, and specifically the Escape ladder's ORDER.
//
// Escape means "back out of the innermost thing", and the innermost
// thing is not always the same. Two owners for one key is how a modal
// closes and the screen behind it also navigates - one keystroke, two
// effects, and the second one is invisible until the person notices
// their paging position is gone.
//
// Run with: node tests/test_archive_keys.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name - Test description.
 * @param {() => void} fn - Body; throwing marks it failed.
 * @returns {void}
 */
function test(name, fn) {
    try {
        fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

/**
 * Load archive-keys.js into a vm context. It is pure, so it needs no DOM.
 * @returns {object} The ArchiveKeys module.
 */
function load() {
    const context = {
        window: {},
        console: { log() {}, warn() {}, error() {}, debug() {} },
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'archive-keys.js'), 'utf8'),
        context, { filename: 'archive-keys.js' }
    );
    return context.window.ArchiveKeys;
}

const keys = load();
const A = keys.ACTIONS;

// ---- 1. THE ESCAPE LADDER, RUNG BY RUNG -----------------------------

test('rung 1: a modal owns Escape outright, and this map claims nothing', () => {
    assert.equal(keys.resolve({ key: 'Escape' }, { modalOpen: true }), null);
    // Even with every lower rung armed, the modal still wins.
    assert.equal(keys.resolve({ key: 'Escape' }, {
        modalOpen: true, filterText: 'abc', searchOpen: true,
        narrow: true, canGoBack: true,
    }), null);
});

test('rung 2: a non-empty filter is cleared before anything else', () => {
    assert.equal(keys.resolve({ key: 'Escape' }, {
        filterText: 'abc', searchOpen: true, narrow: true, canGoBack: true,
    }), A.CLEAR_FILTER);
});

test('rung 3: with no filter text, Escape dismisses the search', () => {
    assert.equal(keys.resolve({ key: 'Escape' }, {
        filterText: '', searchOpen: true, narrow: true, canGoBack: true,
    }), A.DISMISS_SEARCH);
});

test('rung 4: on a narrow viewport with nothing else open, Escape goes back a pane', () => {
    assert.equal(keys.resolve({ key: 'Escape' }, {
        narrow: true, canGoBack: true,
    }), A.BACK_PANE);
});

test('rung 4 needs BOTH narrow and a pane to go back to', () => {
    assert.equal(keys.resolve({ key: 'Escape' }, { narrow: true, canGoBack: false }), null);
    assert.equal(keys.resolve({ key: 'Escape' }, { narrow: false, canGoBack: true }), null);
});

test('rung 5: Escape does NOT leave the archive screen', () => {
    // An accidental Escape throwing away a 3,416-row paging position is
    // a hostile default, so the bottom of the ladder is deliberately
    // nothing at all.
    assert.equal(keys.resolve({ key: 'Escape' }, {}), null);
    const actions = Object.values(A);
    assert.ok(!actions.some((a) => String(a).includes('close-screen')),
        'there must be no action that leaves the screen');
});

// ---- 2. TEXT FIELDS -------------------------------------------------

test('single-letter bindings are inert while a text field has focus', () => {
    for (const k of Object.keys(keys.PLAIN_KEYS)) {
        assert.equal(keys.resolve({ key: k }, { inTextField: true }), null,
            `"${k}" fired while somebody was typing`);
        assert.equal(keys.resolve({ key: k }, {}), keys.PLAIN_KEYS[k],
            `"${k}" did not fire outside a text field`);
    }
});

test('arrows DO work while typing, because moving a selection is not typing', () => {
    assert.equal(keys.resolve({ key: 'ArrowDown' }, { inTextField: true }), A.NEXT_ROW);
    assert.equal(keys.resolve({ key: 'ArrowUp' }, { inTextField: true }), A.PREV_ROW);
});

test('Enter in a text field belongs to that field, not to this map', () => {
    assert.equal(keys.resolve({ key: 'Enter' }, { inTextField: true }), null);
    assert.equal(keys.resolve({ key: 'Enter' }, {}), A.OPEN_ROW);
});

// ---- 3. MODIFIERS ---------------------------------------------------

test('a command modifier hands the key back to the browser', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
        const e = { key: 'j' };
        e[mod] = true;
        assert.equal(keys.resolve(e, {}), null, `${mod}+j was claimed`);
    }
});

test('Shift is NOT a command modifier: Shift+letter is still a letter', () => {
    assert.equal(keys.hasCommandModifier({ shiftKey: true }), false);
});

test('a modal swallows every key, not only Escape', () => {
    assert.equal(keys.resolve({ key: 'j' }, { modalOpen: true }), null);
    assert.equal(keys.resolve({ key: 'ArrowDown' }, { modalOpen: true }), null);
    assert.equal(keys.resolve({ key: 'Enter' }, { modalOpen: true }), null);
});

// ---- 4. THE MAP ITSELF ----------------------------------------------

test('an unbound key returns null rather than being swallowed', () => {
    assert.equal(keys.resolve({ key: 'q' }, {}), null);
    assert.equal(keys.resolve({ key: 'F5' }, {}), null);
    assert.equal(keys.resolve({}, {}), null);
    assert.equal(keys.resolve(null, null), null);
});

test('no key is bound to two different actions', () => {
    const seen = new Map();
    for (const [k, v] of Object.entries(keys.PLAIN_KEYS)) seen.set(k, v);
    for (const [k, v] of Object.entries(keys.NAMED_KEYS)) {
        assert.ok(!seen.has(k), `"${k}" is bound in both tables`);
        seen.set(k, v);
    }
    assert.ok(!seen.has('Escape'), 'Escape belongs to the ladder, not to a table');
});

test('every binding in the help table actually resolves', () => {
    for (const b of keys.bindings()) {
        assert.ok(Object.values(A).includes(b.action),
            `the help table names an action that does not exist: ${b.action}`);
        assert.ok(b.note && b.note.length > 0, `${b.keys} has no note`);
    }
});

test('the action set has not silently grown', () => {
    // A binding added without a test is a binding nobody checked. This
    // fails loudly when the map changes, which is the point.
    assert.equal(Object.keys(A).length, 11);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
