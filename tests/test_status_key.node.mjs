// Node-based tests for client/js/session-status-key.js - the foldable key
// to the status lights at the foot of the session sidebar.
//
// WHY THIS FILE EXISTS. Since the five-colour pass the LED is the ONLY
// thing on a row saying what a session is doing, and its meaning lives in
// a `title` nobody hovers on a phone. The key is where that vocabulary is
// written down in words, so it has two properties worth guarding and they
// are both about DRIFT:
//
//   1. IT DRAWS REAL LEDS. Every swatch is StatusLed.ledHtml with the same
//      (inner, outer) pair the rows resolve to. A hand-drawn legend is a
//      second implementation of the component, free to show a colour the
//      app does not paint - and this repo has already paid for two
//      stylesheets drawing one dot.
//   2. IT COVERS THE WHOLE VOCABULARY. A state added to status-led.js and
//      not to the key is a light on screen that the legend claims does not
//      exist, which is worse than having no legend.
//
// Run with: node tests/test_status_key.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;
const queue = [];

/** Queue one named assertion block. Inputs: name, fn. Output: void. */
function test(name, fn) {
    queue.push([name, fn]);
}

/** Run every queued test in order. Inputs: none. Output: Promise<void>. */
async function runQueue() {
    for (const [name, fn] of queue) {
        try {
            await fn();
            passes++;
            console.log(`ok - ${name}`);
        } catch (err) {
            failures++;
            console.error(`NOT OK - ${name}`);
            console.error(err && err.stack ? err.stack : err);
        }
    }
}

/** Read one repo file as text. Inputs: ...parts (string). Output: string. */
function repoFile(...parts) {
    return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

/**
 * A localStorage stand-in that records what it was asked to keep.
 *
 * Inputs: none. Output: object - the Storage-shaped double.
 */
function fakeStorage() {
    const map = new Map();
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
    };
}

/**
 * Load status-led.js and session-status-key.js into ONE sandbox.
 *
 * They share it for the same reason the summary tests do: the key reads
 * the LED builder off the global, and loading them apart would test a
 * legend drawing against a different copy of the component than the rows
 * do - the exact drift this file exists to prevent.
 * Inputs: storage (object|null) - a localStorage double, or null for a
 *   sandbox where localStorage throws (a private window).
 * Output: object - {Led, Key, storage}.
 */
function loadModules(storage) {
    const store = storage === undefined ? fakeStorage() : storage;
    const context = { console };
    if (store) {
        context.localStorage = store;
    } else {
        // A browser that refuses storage THROWS on access rather than
        // returning null, and the key must survive that.
        Object.defineProperty(context, 'localStorage', {
            get() { throw new Error('storage is blocked'); },
        });
    }
    vm.createContext(context);
    for (const file of ['status-led.js', 'session-status-key.js']) {
        vm.runInContext(repoFile('client', 'js', file), context);
    }
    return { Led: context.StatusLed, Key: context.SessionStatusKey, storage: store };
}

/**
 * The smallest element tree onToggleClick needs: a button inside a root
 * that also holds a body. Deliberately hand-rolled rather than a DOM
 * library - the function touches five methods and one property, and a
 * double that implements exactly those cannot pass by accident.
 * Inputs: none. Output: object - {button, body}.
 */
function fakeTree() {
    const body = { hidden: true, className: 'session-status-key__body' };
    const root = {
        querySelector: (sel) => (sel === '.session-status-key__body' ? body : null),
    };
    const attrs = new Map([['aria-expanded', 'false']]);
    const button = {
        closest: (sel) => (sel === '[data-status-key]' ? root : null),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        setAttribute: (k, v) => attrs.set(k, String(v)),
        attrs,
    };
    return { button, body };
}

const { Led, Key } = loadModules();

// ---- the whole vocabulary, and nothing invented -------------------------

test('EVERY INNER STATE THE COMPONENT CAN PAINT IS IN THE KEY', () => {
    // The anti-drift assertion. A state added to status-led.js and not to
    // the key is a light on screen the legend says does not exist.
    const covered = new Set(Key.ENTRIES.map((e) => e.inner));
    for (const state of Led.INNER_STATES) {
        assert.ok(covered.has(state), `the key never explains "${state}"`);
    }
});

test('AND NOTHING IN THE KEY IS INVENTED', () => {
    // The other direction. An entry naming a state the component cannot
    // produce would be a legend for a light nobody will ever see.
    for (const entry of Key.ENTRIES) {
        assert.ok(
            Led.INNER_STATES.indexOf(entry.inner) >= 0,
            `"${entry.inner}" is not an inner state`,
        );
        assert.ok(
            Led.OUTER_STATES.indexOf(entry.outer) >= 0,
            `"${entry.outer}" is not an outer state`,
        );
        assert.ok(entry.text && entry.text.trim(), 'every light gets words');
        assert.equal(entry.text, entry.text.toLowerCase(),
            'UI copy in this app is lowercase');
    }
});

test('THE FINISHED-TURN RING IS IN THERE, because it is the one nobody guesses', () => {
    // Grey dot, green ring. It replaced the unread envelope on both
    // surfaces, so it is the entry the key most needs to carry.
    const ring = Key.ENTRIES.filter((e) => e.outer === 'unread');
    assert.equal(ring.length, 1, 'exactly one entry explains the ring');
    assert.equal(ring[0].inner, 'done', 'and it is the grey centre it really has');
    assert.ok(/read/.test(ring[0].text), `got "${ring[0].text}"`);
});

test('THE KEY EXPLAINS THE GROUP HEADER TOO, in one line', () => {
    // A dot appears in two places. A reader who has just learned the
    // vocabulary must be told the header reuses it rather than left to
    // assume a header dot means something else.
    assert.ok(/group header/.test(Key.HEADER_NOTE), Key.HEADER_NOTE);
    assert.ok(Key.keyHtml().includes(Key.HEADER_NOTE));
});

// ---- the swatches are the shipped component -----------------------------

test('EVERY SWATCH IS A REAL LED, byte for byte', () => {
    // Not "looks like an LED": the exact string ledHtml returns for that
    // pair. A legend that built its own span could show a colour, a size
    // or a shape the app does not paint.
    for (const entry of Key.ENTRIES) {
        const expected = Led.ledHtml({ inner: entry.inner, outer: entry.outer });
        assert.ok(
            Key.itemHtml(entry).includes(expected),
            `the swatch for ${entry.inner}/${entry.outer} is not the component`,
        );
    }
});

test('a swatch keeps the component\'s own words, so colour is never the only signal', () => {
    const html = Key.keyHtml();
    for (const entry of Key.ENTRIES) {
        const label = Led.ledLabel(entry.inner, entry.outer);
        assert.ok(html.includes(`aria-label="${label}"`), `missing label: ${label}`);
    }
});

test('THE KEY STYLESHEET NEVER REPAINTS A LIGHT', () => {
    // The legend sizes the ROW around the light and never the light. A
    // rule here that set a colour, a width or a border-radius on a
    // `.status-led` would make the key show something the sidebar does
    // not, which is the whole failure it exists to avoid.
    const css = repoFile('client', 'css', 'session-status-key.css');
    const rules = css.match(/^[^\n{]*\.status-led[^\n{]*\{/gm) || [];
    assert.deepEqual(rules, [], `the key must not style the LED: ${rules.join(', ')}`);
});

// ---- the disclosure ------------------------------------------------------

test('IT SHIPS COLLAPSED, and says so in ARIA rather than by shape alone', () => {
    const { Key: K } = loadModules();
    const html = K.keyHtml();
    assert.ok(html.includes('aria-expanded="false"'), 'collapsed by default');
    assert.ok(html.includes(`aria-controls="${K.BODY_ID}"`), 'points at its body');
    assert.ok(html.includes(`id="${K.BODY_ID}"`), 'which really exists');
    // The body is HIDDEN, not dropped: `aria-controls` must always
    // resolve to a real element, or the button announces a target that
    // is not there.
    assert.ok(/class="session-status-key__body" id="[^"]+" hidden>/.test(html),
        'the closed body is hidden, not absent');
});

test('IT IS A BUTTON, so Tab reaches it and Enter and Space work for free', () => {
    // A div with a click handler is not keyboard operable, and this app
    // ships no key handler for the key. The element type IS the feature.
    const html = Key.keyHtml();
    assert.ok(/<button type="button" class="session-status-key__toggle"/.test(html));
});

test('the fold PERSISTS, on the app\'s own localStorage convention', () => {
    const { Key: K, storage } = loadModules();
    assert.ok(K.STORAGE_KEY.startsWith('cloude.'),
        `preferences live under cloude.*, got ${K.STORAGE_KEY}`);
    assert.equal(K.isOpen(), false, 'nothing stored means closed');
    K.setOpen(true);
    assert.equal(storage.map.get(K.STORAGE_KEY), '1');
    assert.equal(K.isOpen(), true);
    // AND THE MARKUP READS IT AT RENDER TIME, which is what makes the
    // fold survive the list repainting itself from a signature that
    // knows nothing about it.
    assert.ok(K.keyHtml().includes('aria-expanded="true"'));
    assert.ok(!/session-status-key__body" id="[^"]+" hidden/.test(K.keyHtml()));
    K.setOpen(false);
    assert.equal(storage.map.get(K.STORAGE_KEY), '0');
    assert.ok(K.keyHtml().includes('aria-expanded="false"'));
});

test('A BLOCKED localStorage COSTS THE PREFERENCE, NEVER THE KEY', () => {
    // A private window throws on access rather than returning null. The
    // legend must still render; it simply opens closed every time.
    const { Key: K } = loadModules(null);
    assert.equal(K.isOpen(), false);
    K.setOpen(true);
    assert.ok(K.keyHtml().includes('data-status-key'), 'it still renders');
    assert.ok(K.keyHtml().includes('aria-expanded="false"'));
});

test('the toggle folds IN PLACE and moves every attribute together', () => {
    const { Key: K, storage } = loadModules();
    const { button, body } = fakeTree();
    assert.equal(K.onToggleClick(button), true);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(body.hidden, false);
    assert.equal(storage.map.get(K.STORAGE_KEY), '1');
    // The tooltip and the accessible name say what the NEXT press does,
    // so they have to move with the state or they start lying.
    assert.equal(button.attrs.get('title'), button.attrs.get('aria-label'));
    assert.ok(/Hide/.test(button.attrs.get('title')), button.attrs.get('title'));

    assert.equal(K.onToggleClick(button), false);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(body.hidden, true);
    assert.equal(storage.map.get(K.STORAGE_KEY), '0');
    assert.ok(/Show/.test(button.attrs.get('title')), button.attrs.get('title'));
});

test('a toggle with no key around it refuses rather than throwing', () => {
    const orphan = {
        closest: () => null,
        getAttribute: () => 'false',
        setAttribute: () => {},
    };
    assert.equal(Key.onToggleClick(orphan), false);
    assert.equal(Key.onToggleClick(null), false);
});

test('THE SIDEBAR ACTUALLY CLAIMS THE CLICK - a control nobody wires is furniture', () => {
    const clicks = repoFile('client', 'js', 'session-sidebar-clicks.js');
    assert.ok(clicks.includes('data-status-key-toggle'), 'the click is routed');
    assert.ok(clicks.includes('SessionStatusKey.onToggleClick'), 'to this module');
    const html = repoFile('client', 'index.html');
    assert.ok(html.includes('/static/js/session-status-key.js'), 'the module is served');
    assert.ok(html.includes('/static/css/session-status-key.css'), 'and so is its CSS');
});

test('nothing here uses an em-dash, an en-dash, or an emoji', () => {
    for (const f of [['js', 'session-status-key.js'], ['css', 'session-status-key.css']]) {
        const src = repoFile('client', ...f);
        assert.ok(!/[—–]/.test(src), `${f[1]} carries a dash`);
        assert.ok(
            !/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(src),
            `${f[1]} carries an emoji`,
        );
    }
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
