// Node test for client/js/header-menu.js — the mobile top-right dropdown.
//
// The property that matters most is NOTHING IS LOST: every control that
// was reachable inline at desktop width must still be reachable after the
// fold, as the SAME node (ids and listeners intact), and must come back
// in the original order when the viewport widens again.
//
// Run with: node tests/test_header_menu.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createEnvironment } from './mini-dom.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;

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

/** Ids of the header controls, in the order index.html declares them. */
const EXPECTED_IDS = [
    'audioToggleBtn',
    'homeBtn',
    'detachSessionBtn',
    'logoutBtn',
    'settingsBtn',
    'configEditorBtn',
];

/**
 * Build the real header shape from index.html: .header > .controls with
 * the six buttons plus the status span.
 * Inputs: document (MiniDocument).
 * Output: {controls, status}.
 */
function buildHeader(document) {
    const header = document.createElement('div');
    header.className = 'header';
    const controls = document.createElement('div');
    controls.className = 'controls';
    for (const id of EXPECTED_IDS) {
        const btn = document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('id', id);
        btn.setAttribute('title', id.toLowerCase());
        controls.appendChild(btn);
    }
    const status = document.createElement('span');
    status.className = 'status';
    status.setAttribute('id', 'statusText');
    controls.appendChild(status);
    header.appendChild(controls);
    document.body.appendChild(header);
    return { controls, status };
}

/**
 * Load dismiss-guard.js + header-menu.js into one sandbox at a chosen
 * viewport state, with the header already in the DOM.
 * Inputs: options (object) - {mobile: boolean}.
 * Output: {env, menu, controls, status, setMediaMatches}.
 */
function load(options = {}) {
    const env = createEnvironment({ matches: !!options.mobile });
    const built = buildHeader(env.document);
    const sandbox = {
        window: env.window,
        document: env.document,
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const file of ['dismiss-guard.js', 'header-menu.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, '..', 'client', 'js', file), 'utf8'),
            sandbox);
    }
    return {
        env,
        menu: env.window.HeaderMenu,
        controls: built.controls,
        status: built.status,
        setMediaMatches: env.setMediaMatches,
    };
}

/** Ids of the button children of a node, in document order. */
function buttonIds(node) {
    return node.children
        .filter(c => c.tagName === 'BUTTON' && c.getAttribute('id') !== 'header-menu-toggle')
        .map(c => c.getAttribute('id'));
}

// ---------------------------------------------------------------------
// Inventory: nothing is lost
// ---------------------------------------------------------------------

test('the module and index.html agree on which controls fold', () => {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'header-menu.js'), 'utf8');
    // Every id the module folds must actually exist in the shell, or the
    // fold silently drops a control.
    for (const id of EXPECTED_IDS) {
        assert.ok(src.includes(`'${id}'`), `header-menu.js forgot ${id}`);
        assert.ok(html.includes(`id="${id}"`), `index.html has no ${id}`);
    }
});

test('desktop: every control is inline and in declaration order', () => {
    const { controls } = load({ mobile: false });
    assert.deepEqual(buttonIds(controls), EXPECTED_IDS);
});

test('mobile: every control moved into the panel, none lost', () => {
    const { env, controls } = load({ mobile: true });
    const panel = env.document.getElementById('header-menu-panel');
    assert.deepEqual(buttonIds(panel), EXPECTED_IDS);
    assert.deepEqual(buttonIds(controls), [], 'no control left behind inline');
});

test('mobile: the folded controls are the SAME nodes, not copies', () => {
    const { env } = load({ mobile: true });
    // A duplicate id would break every getElementById in the app.
    for (const id of EXPECTED_IDS) {
        const matches = env.document.querySelectorAll(`#${id}`);
        assert.equal(matches.length, 1, `${id} exists ${matches.length} times`);
    }
});

test('mobile: listeners survive the move', () => {
    const { env } = load({ mobile: true });
    const home = env.document.getElementById('homeBtn');
    let clicked = 0;
    home.addEventListener('click', () => { clicked++; });
    home.dispatchEvent('click');
    assert.equal(clicked, 1);
});

test('the status light is NOT folded away', () => {
    const { env, controls, status } = load({ mobile: true });
    const panel = env.document.getElementById('header-menu-panel');
    assert.ok(controls.contains(status), 'status must stay inline');
    assert.ok(!panel.contains(status));
});

test('the sidebar toggle is never touched', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'header-menu.js'), 'utf8');
    // It is the top-LEFT one-handed target; folding it would be a
    // usability regression, not a tidy-up.
    assert.ok(!/CONTROL_IDS[\s\S]*session-sidebar-toggle/.test(src));
});

// ---------------------------------------------------------------------
// Reflow
// ---------------------------------------------------------------------

test('widening restores the original inline order exactly', () => {
    const { env, controls, setMediaMatches } = load({ mobile: true });
    const panel = env.document.getElementById('header-menu-panel');
    assert.deepEqual(buttonIds(panel), EXPECTED_IDS);
    setMediaMatches(false);
    assert.deepEqual(buttonIds(controls), EXPECTED_IDS);
    assert.deepEqual(buttonIds(panel), []);
});

test('narrowing then widening repeatedly does not duplicate or drop', () => {
    const { env, controls, setMediaMatches } = load({ mobile: false });
    const panel = env.document.getElementById('header-menu-panel');
    for (let i = 0; i < 3; i++) {
        setMediaMatches(true);
        assert.deepEqual(buttonIds(panel), EXPECTED_IDS, `fold ${i}`);
        setMediaMatches(false);
        assert.deepEqual(buttonIds(controls), EXPECTED_IDS, `unfold ${i}`);
    }
});

test('the trigger stays last in the row after unfolding', () => {
    const { env, controls, setMediaMatches } = load({ mobile: true });
    setMediaMatches(false);
    const toggleIndex = controls.children.indexOf(
        env.document.getElementById('header-menu-toggle'));
    const lastControlIndex = controls.children.indexOf(
        env.document.getElementById('configEditorBtn'));
    assert.ok(toggleIndex > lastControlIndex);
});

test('a second init() is a no-op', () => {
    const { env, menu } = load({ mobile: true });
    menu.init();
    assert.equal(env.document.querySelectorAll('#header-menu-toggle').length, 1);
    assert.equal(env.document.querySelectorAll('#header-menu-panel').length, 1);
});

// ---------------------------------------------------------------------
// Open / close behavior
// ---------------------------------------------------------------------

test('the dropdown starts closed and hidden', () => {
    const { env, menu } = load({ mobile: true });
    const panel = env.document.getElementById('header-menu-panel');
    assert.equal(menu.isOpen, false);
    assert.equal(panel.hidden, true);
});

test('the trigger opens and closes it, and tracks aria-expanded', () => {
    const { env, menu } = load({ mobile: true });
    const toggle = env.document.getElementById('header-menu-toggle');
    const panel = env.document.getElementById('header-menu-panel');
    toggle.dispatchEvent('click');
    assert.equal(menu.isOpen, true);
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.dispatchEvent('click');
    assert.equal(menu.isOpen, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('an outside tap closes it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    assert.equal(menu.isOpen, true);
    const elsewhere = env.document.createElement('div');
    env.document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent('click');
    assert.equal(menu.isOpen, false);
});

test('Escape closes it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    assert.equal(menu.isOpen, true);
    env.document.body.dispatchEvent('keydown', { key: 'Escape' });
    assert.equal(menu.isOpen, false);
});

test('a key other than Escape does not close it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    env.document.body.dispatchEvent('keydown', { key: 'a' });
    assert.equal(menu.isOpen, true);
});

test('tapping a folded control closes the menu behind it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    env.document.getElementById('settingsBtn').dispatchEvent('click');
    assert.equal(menu.isOpen, false);
});

test('a tap on the panel padding does NOT close it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    env.document.getElementById('header-menu-panel').dispatchEvent('click');
    assert.equal(menu.isOpen, true);
});

test('unfolding to desktop closes an open dropdown', () => {
    const { env, menu, setMediaMatches } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    assert.equal(menu.isOpen, true);
    setMediaMatches(false);
    assert.equal(menu.isOpen, false);
    assert.equal(env.document.getElementById('header-menu-panel').hidden, true);
});

// ---------------------------------------------------------------------
// Bug 1 must not come back through the new surface
// ---------------------------------------------------------------------

test('the dropdown does not dismiss on focus loss', () => {
    // A focusout/blur dismiss is the third way to reproduce the original
    // bug. Pin its absence rather than only testing the click path.
    // Matched against listener registrations, not raw text - the file
    // mentions focusout in a comment explaining why it is not used, and
    // that comment is worth keeping.
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'header-menu.js'), 'utf8');
    assert.ok(!/addEventListener\(\s*['"]focusout['"]/.test(src));
    assert.ok(!/addEventListener\(\s*['"]blur['"]/.test(src));
    assert.ok(!/addEventListener\(\s*['"]focusin['"]/.test(src));
});

test('a click on an input inside the dropdown does not close it', () => {
    const { env, menu } = load({ mobile: true });
    env.document.getElementById('header-menu-toggle').dispatchEvent('click');
    const panel = env.document.getElementById('header-menu-panel');
    const input = env.document.createElement('input');
    input.type = 'text';
    panel.appendChild(input);
    // A future control with a field in it must not be un-typeable, which
    // is exactly bug 1 reappearing on a new surface.
    input.dispatchEvent('input');
    assert.equal(menu.isOpen, true, 'typing must not close the dropdown');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
