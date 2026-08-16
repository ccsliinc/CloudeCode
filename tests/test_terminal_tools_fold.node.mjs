// Node test for client/js/terminal-tools-fold.js - folding the session
// tool strip that overlays the terminal's top-right corner.
//
// The properties that matter:
//   1. COLLAPSED IS THE DEFAULT. An expanded strip covers ~150px of live
//      terminal output, which is the thing the fold exists to stop.
//   2. NOTHING IS LOST. All three tools come back on demand, as the SAME
//      nodes, so every handler terminal.js wired stays attached.
//   3. THE TRIGGER DOES NOT MOVE between states, so it stays a reliable
//      thumb target.
//   4. IT IS NOT THE HEADER KEBAB. Two collapsing menus in one corner is a
//      usability trap; these tests pin the ways they are kept distinct.
//
// Run with: node tests/test_terminal_tools_fold.node.mjs

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

/** Ids of the session tools, in the order index.html declares them. */
const TOOL_IDS = ['terminalCopyBtn', 'sessionThemeBtn', 'sessionAudioBtn'];

/** Id of the fold trigger. */
const TOGGLE_ID = 'terminalToolsToggle';

/**
 * Read a client file.
 * @param {...string} parts  Path segments under client/.
 * @returns {string} File contents.
 */
function clientFile(...parts) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', ...parts), 'utf8');
}

/**
 * Build the real strip shape from index.html: #terminalTools holding the
 * three tools and then the trigger last.
 *
 * @param {object} document  MiniDocument.
 * @returns {object} {strip, toggle, tools}.
 */
function buildStrip(document) {
    const strip = document.createElement('div');
    strip.className = 'terminal-tools';
    strip.setAttribute('id', 'terminalTools');
    const tools = TOOL_IDS.map((id) => {
        const btn = document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('id', id);
        btn.className = 'terminal-tool';
        strip.appendChild(btn);
        return btn;
    });
    const toggle = document.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('id', TOGGLE_ID);
    toggle.className = 'terminal-tool terminal-tools__toggle';
    toggle.setAttribute('aria-expanded', 'false');
    strip.appendChild(toggle);
    document.body.appendChild(strip);
    return { strip, toggle, tools };
}

/**
 * Load dismiss-guard.js + terminal-tools-fold.js into one sandbox with the
 * strip already mounted.
 *
 * @returns {object} {env, fold, strip, toggle, tools}.
 */
function load() {
    const env = createEnvironment({});
    const built = buildStrip(env.document);
    const sandbox = {
        window: env.window,
        document: env.document,
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const file of ['dismiss-guard.js', 'terminal-tools-fold.js']) {
        vm.runInContext(clientFile('js', file), sandbox);
    }
    return { env, fold: env.window.TerminalToolsFold, ...built };
}

// ---------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------

test('the strip is collapsed on load', () => {
    const { fold, strip, toggle } = load();
    assert.equal(fold.isOpen, false);
    assert.equal(strip.classList.contains('terminal-tools--open'), false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('the trigger is labelled for its action in both states', () => {
    const { fold, toggle } = load();
    assert.equal(toggle.getAttribute('aria-label'), 'session tools');
    fold.setOpen(true);
    assert.equal(toggle.getAttribute('aria-label'), 'hide session tools');
    // The label must track the state on every surface that renders it,
    // because header-menu.css style row labels read `title`.
    assert.equal(toggle.getAttribute('title'), 'hide session tools');
    assert.equal(toggle.getAttribute('data-tooltip'), 'hide session tools');
});

// ---------------------------------------------------------------------
// Toggling
// ---------------------------------------------------------------------

test('clicking the trigger reveals the tools and clicking again hides them', () => {
    const { fold, strip, toggle } = load();
    toggle.dispatchEvent('click');
    assert.equal(fold.isOpen, true);
    assert.equal(strip.classList.contains('terminal-tools--open'), true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    toggle.dispatchEvent('click');
    assert.equal(fold.isOpen, false);
    assert.equal(strip.classList.contains('terminal-tools--open'), false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('nothing is lost: the same three tool nodes survive a fold cycle', () => {
    const { fold, strip, tools } = load();
    fold.setOpen(true);
    fold.setOpen(false);
    const present = strip.children
        .filter((c) => c.getAttribute('id') !== TOGGLE_ID)
        .map((c) => c.getAttribute('id'));
    assert.deepEqual(present, TOOL_IDS);
    // Same node identity, so terminal.js's click handlers are still on them.
    for (let i = 0; i < tools.length; i++) {
        assert.equal(strip.children[i], tools[i]);
    }
});

test('the trigger stays the last child, so it never moves between states', () => {
    const { fold, strip, toggle } = load();
    assert.equal(strip.children[strip.children.length - 1], toggle);
    fold.setOpen(true);
    assert.equal(strip.children[strip.children.length - 1], toggle,
        'tools must expand to the LEFT of a stationary trigger');
});

test('collapse() is idempotent and safe to call when already collapsed', () => {
    const { fold, strip } = load();
    fold.collapse();
    fold.collapse();
    assert.equal(fold.isOpen, false);
    assert.equal(strip.classList.contains('terminal-tools--open'), false);
});

test('Escape collapses an open strip and is a no-op when closed', () => {
    const { fold, env } = load();
    fold.setOpen(true);
    env.document.dispatchEvent('keydown', { key: 'Escape' });
    assert.equal(fold.isOpen, false);
    assert.doesNotThrow(() => env.document.dispatchEvent('keydown', { key: 'Escape' }));
    assert.equal(fold.isOpen, false);
});

test('a click outside collapses the strip', () => {
    const { fold, env } = load();
    fold.setOpen(true);
    const outside = env.document.createElement('div');
    env.document.body.appendChild(outside);
    env.document.dispatchEvent('click', { target: outside });
    assert.equal(fold.isOpen, false);
});

// ---------------------------------------------------------------------
// The markup and CSS contract
// ---------------------------------------------------------------------

test('index.html declares every id the module folds', () => {
    const html = clientFile('index.html');
    for (const id of TOOL_IDS.concat([TOGGLE_ID])) {
        assert.ok(html.includes(`id="${id}"`), `index.html is missing ${id}`);
    }
    assert.ok(html.includes('/static/js/terminal-tools-fold.js'),
        'index.html must load the fold module');
    const src = clientFile('js', 'terminal-tools-fold.js');
    for (const id of TOOL_IDS) {
        assert.ok(src.includes(`'${id}'`), `the module forgot ${id}`);
    }
});

test('CSS hides the tools by default and reveals them on the open class', () => {
    const src = clientFile('css', 'terminal-tools.css');
    // display:none, not opacity/visibility - a zero-opacity chip still
    // reserves the width it was covering, which defeats the whole fold.
    assert.match(
        src,
        /\.terminal-tools \.terminal-tool:not\(\.terminal-tools__toggle\)\s*\{\s*display:\s*none;/,
        'collapsed tools must be display:none');
    assert.match(
        src,
        /\.terminal-tools--open \.terminal-tool:not\(\.terminal-tools__toggle\)\s*\{\s*display:\s*inline-flex;/,
        'the open class must reveal the tools');
});

test('the trigger reaches the 44px minimum tap target on touch devices', () => {
    const src = clientFile('css', 'terminal-tools.css');
    // The trigger carries `.terminal-tool`, which the coarse-pointer media
    // query grows to 44px. If that class is ever dropped from the trigger
    // it silently becomes a 32px target on a phone.
    assert.match(src, /@media \(pointer: coarse\)\s*\{\s*\.terminal-tool\s*\{\s*width:\s*44px;\s*height:\s*44px;/);
    const html = clientFile('index.html');
    const tag = html.slice(html.indexOf(`id="${TOGGLE_ID}"`) - 200,
        html.indexOf(`id="${TOGGLE_ID}"`) + 200);
    assert.ok(/class="[^"]*\bterminal-tool\b[^"]*"/.test(tag),
        'the trigger must carry .terminal-tool to inherit the 44px size');
});

// ---------------------------------------------------------------------
// Not the header kebab
// ---------------------------------------------------------------------

test('the session fold and the header kebab are separate, non-overlapping controls', () => {
    // Comments are allowed to reference the other control - the two files
    // explain each other on purpose - so strip them and assert on CODE.
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const foldSrc = stripComments(clientFile('js', 'terminal-tools-fold.js'));
    const menuSrc = stripComments(clientFile('js', 'header-menu.js'));
    // Different triggers, and neither reaches into the other's DOM.
    assert.ok(foldSrc.includes(TOGGLE_ID));
    assert.ok(!foldSrc.includes('header-menu-toggle'),
        'the fold must not drive the header kebab');
    assert.ok(!foldSrc.includes('header-menu-panel'),
        'the fold must not reach into the header kebab panel');
    assert.ok(!menuSrc.includes(TOGGLE_ID),
        'the header kebab must not drive the fold');
    assert.ok(!menuSrc.includes('terminalTools'),
        'the header kebab must not reach into the session strip');
    // Disjoint control sets. The kebab holds app-scoped nav; this holds
    // session-scoped tools. An id in both would mean one control moved
    // under two owners and would fight on every layout change.
    const headerIds = ['homeBtn', 'detachSessionBtn', 'logoutBtn',
        'settingsBtn', 'configEditorBtn', 'audioToggleBtn'];
    for (const id of headerIds) {
        assert.ok(!TOOL_IDS.includes(id), `${id} is claimed by both menus`);
        assert.ok(!foldSrc.includes(`'${id}'`), `the fold must not claim ${id}`);
    }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
