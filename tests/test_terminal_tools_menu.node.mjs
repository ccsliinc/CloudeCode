// Node test for client/js/terminal-tools-menu.js - the single session
// tools menu that replaced BOTH the folded tool strip over the terminal's
// top-right corner and the paperclip FAB's own popup in the bottom-right.
//
// (Replaces tests/test_terminal_tools_fold.node.mjs, which tested the
// strip that no longer exists.)
//
// The properties that matter:
//   1. THERE IS ONLY ONE MENU. The old strip markup, its ids and its
//      module are gone from index.html - not hidden, gone. Two menus for
//      one concept was the whole complaint.
//   2. NOTHING WAS LOST IN THE MERGE. All five tools - copy output, paste
//      from clipboard, attach image, session theme, session music - are
//      rows of this one menu, and each row calls the module that owns it.
//   3. THE ATTACH CAPABILITY SURVIVED. The hidden file input is still in
//      index.html and the "attach image" row still opens it.
//   4. IT IS NOT THE HEADER KEBAB. The app-scoped kebab stays separate.
//   5. THE ICONS MATCH THE SET, and the stroke width is on the PATH.
//      A `stroke-width` presentation attribute beats a stylesheet rule
//      that targets the `svg`, so a rule cannot be trusted to normalise
//      these - the markup has to carry the right value.
//   6. THE FAB IS ON THE D-PAD'S CENTRE LINE. It used to sit at
//      right:16px with a 44px box against the d-pad's right:20px/45px,
//      putting their centres 4.5px apart.
//
// Run with: node tests/test_terminal_tools_menu.node.mjs

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

/**
 * Read a file under client/.
 * @param {...string} parts  Path segments under client/.
 * @returns {string} File contents.
 */
function clientFile(...parts) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', ...parts), 'utf8');
}

/** The five rows, in the order the menu declares them. */
const ENTRY_IDS = [
    'toolCopyOutput',
    'toolPasteClipboard',
    'toolAttachImage',
    'toolSessionTheme',
    'toolSessionMusic',
];

/**
 * Load the menu module against a mini-DOM, with recording stubs for every
 * module its rows delegate to.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.musicOn] - the per-session opt-in to report.
 * @returns {object} {env, menu, trigger, input, calls}
 */
function load(opts) {
    const options = opts || {};
    const env = createEnvironment({});
    const calls = {
        copyOpen: 0, paste: 0, inputClick: 0, themeOpen: 0, audioToggle: 0,
    };

    const trigger = env.document.createElement('button');
    trigger.setAttribute('id', 'terminalToolsBtn');
    trigger.className = 'terminal-tools-fab';
    env.document.body.appendChild(trigger);

    const input = env.document.createElement('input');
    input.setAttribute('id', 'cloude-image-attach-input');
    input.click = () => { calls.inputClick++; };
    env.document.body.appendChild(input);

    env.window.CopyOutput = { open: () => { calls.copyOpen++; } };
    env.window.ClipboardTools = { pasteFromClipboard: () => { calls.paste++; } };
    env.window.SessionThemeMenu = {
        open: () => { calls.themeOpen++; },
        toggleAudio: () => { calls.audioToggle++; return true; },
        isAudioOn: () => !!options.musicOn,
    };
    env.window.Themes = { getActiveSession: () => 'demo-Main' };
    env.window.AnchorPopover = { place: () => ({ left: 0, top: 0 }) };

    const sandbox = {
        window: env.window,
        document: env.document,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn) => fn(),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(clientFile('js', 'terminal-tools-menu.js'), sandbox);

    const menu = env.window.TerminalToolsMenu;
    menu.wire({ _showStatusPill() {} }, trigger, input);
    return { env, menu, trigger, input, calls };
}

/**
 * Find a row by id inside the open menu.
 * @param {object} env  The mini-DOM environment.
 * @param {string} id   One of ENTRY_IDS.
 * @returns {object} The row element.
 */
function row(env, id) {
    const found = env.document.body.children
        .filter((c) => c.className === 'terminal-tools-menu')
        .flatMap((m) => m.children)
        .find((r) => r.getAttribute('id') === id);
    assert.ok(found, `row ${id} is missing from the open menu`);
    return found;
}

// ---------------------------------------------------------------------
// One menu, five tools
// ---------------------------------------------------------------------

test('the menu is closed on load and opens on the trigger', () => {
    const { menu, trigger } = load();
    assert.equal(menu.isOpen(), false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    trigger.dispatchEvent('click');
    assert.equal(menu.isOpen(), true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    trigger.dispatchEvent('click');
    assert.equal(menu.isOpen(), false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('NOTHING WAS LOST: all five tools are rows of the one menu', () => {
    const { env, menu } = load();
    menu.open();
    const ids = env.document.body.children
        .filter((c) => c.className === 'terminal-tools-menu')
        .flatMap((m) => m.children)
        .map((r) => r.getAttribute('id'));
    assert.deepEqual(ids, ENTRY_IDS);
});

test('each row calls the module that owns that tool', () => {
    const cases = [
        ['toolCopyOutput', 'copyOpen'],
        ['toolPasteClipboard', 'paste'],
        ['toolAttachImage', 'inputClick'],
        ['toolSessionTheme', 'themeOpen'],
        ['toolSessionMusic', 'audioToggle'],
    ];
    for (const [id, counter] of cases) {
        const { env, menu, calls } = load();
        menu.open();
        row(env, id).dispatchEvent('click');
        assert.equal(calls[counter], 1, `${id} did not reach its module`);
    }
});

test('THE ATTACH CAPABILITY SURVIVED: the row opens the real file input', () => {
    const { env, menu, calls } = load();
    menu.open();
    row(env, 'toolAttachImage').dispatchEvent('click');
    assert.equal(calls.inputClick, 1);
    const html = clientFile('index.html');
    assert.ok(html.includes('id="cloude-image-attach-input"'),
        'the hidden file input must still be mounted');
    assert.ok(html.includes('accept="image/*,image/heic,image/heif"'),
        'the picker must still offer the Photos library and Files');
    // The change handler moved out of the deleted paperclip menu into
    // clipboard.js#wireFileInput; terminal.js must still wire it.
    assert.ok(clientFile('js', 'clipboard.js').includes('function wireFileInput'));
    assert.ok(clientFile('js', 'terminal.js').includes('ClipboardTools.wireFileInput'));
});

test('picking a tool closes the menu, so it never sits over the terminal', () => {
    const { env, menu } = load();
    menu.open();
    row(env, 'toolCopyOutput').dispatchEvent('click');
    assert.equal(menu.isOpen(), false);
});

test('the music row reports the LIVE per-session opt-in on every open', () => {
    const off = load({ musicOn: false });
    off.menu.open();
    assert.equal(row(off.env, 'toolSessionMusic').getAttribute('aria-pressed'), 'false');

    const on = load({ musicOn: true });
    on.menu.open();
    const r = row(on.env, 'toolSessionMusic');
    assert.equal(r.getAttribute('aria-pressed'), 'true');
    assert.ok(r.classList.contains('is-on'));
});

test('Escape closes, and a click outside closes', () => {
    const esc = load();
    esc.menu.open();
    esc.env.document.dispatchEvent('keydown', { key: 'Escape' });
    assert.equal(esc.menu.isOpen(), false);

    const out = load();
    out.menu.open();
    const elsewhere = out.env.document.createElement('div');
    out.env.document.body.appendChild(elsewhere);
    out.env.document.dispatchEvent('pointerdown', { target: elsewhere });
    assert.equal(out.menu.isOpen(), false);
});

test('close() and a second open() are both safe, and never stack two menus', () => {
    const { env, menu } = load();
    menu.close();
    menu.open();
    menu.open();
    const menus = env.document.body.children
        .filter((c) => c.className === 'terminal-tools-menu');
    assert.equal(menus.length, 1);
});

test('wire() is idempotent - a session swap does not double-bind the trigger', () => {
    const { menu, trigger, calls } = load();
    menu.wire({ _showStatusPill() {} }, trigger, null);
    menu.wire({ _showStatusPill() {} }, trigger, null);
    trigger.dispatchEvent('click');
    assert.equal(menu.isOpen(), true, 'a doubled handler would toggle twice');
    assert.equal(calls.copyOpen, 0);
});

// ---------------------------------------------------------------------
// The old surfaces are GONE, not merely hidden
// ---------------------------------------------------------------------

test('the top-right tool strip is gone from the markup and the tree', () => {
    const html = clientFile('index.html');
    for (const id of ['terminalTools', 'terminalToolsToggle', 'terminalCopyBtn',
        'sessionThemeBtn', 'sessionAudioBtn']) {
        assert.ok(!html.includes(`id="${id}"`), `index.html still mounts ${id}`);
    }
    assert.ok(!html.includes('terminal-tools-fold.js'),
        'index.html must not load the deleted fold module');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'client', 'js',
        'terminal-tools-fold.js')), 'the fold module must be deleted');
    assert.ok(html.includes('/static/js/terminal-tools-menu.js'),
        'index.html must load the menu module');
});

test('clipboard.js no longer builds a second menu', () => {
    const src = clientFile('js', 'clipboard.js');
    assert.ok(!src.includes('cloude-attach-menu'),
        'the paperclip popup must be gone, not just unused');
    assert.ok(!src.includes('function openMenu'));
    assert.ok(src.includes('function pasteFromClipboard'),
        'the paste capability itself must survive');
});

// ---------------------------------------------------------------------
// Icons and geometry
// ---------------------------------------------------------------------

test('ICONS: every path declares stroke-width 1.5 in a 16x16 viewBox', () => {
    const { menu } = load();
    for (const [name, body] of Object.entries(menu.ICONS)) {
        const strokedShapes = body.match(/<(path|rect|circle)\b[^>]*stroke="currentColor"[^>]*>/g) || [];
        assert.ok(strokedShapes.length, `${name} has no stroked shape`);
        for (const shape of strokedShapes) {
            assert.ok(/stroke-width="1\.5"/.test(shape),
                `${name} has a stroked shape without stroke-width 1.5: ${shape}`);
        }
    }
    const src = clientFile('js', 'terminal-tools-menu.js');
    assert.ok(src.includes("setAttribute('viewBox', '0 0 16 16')"));
    assert.ok(src.includes("setAttribute('width', '16')"));
    assert.ok(src.includes("setAttribute('height', '16')"));
});

test('the FAB trigger icon matches the same set, inline in index.html', () => {
    const html = clientFile('index.html');
    const at = html.indexOf('id="terminalToolsBtn"');
    assert.ok(at > 0, 'the trigger must be mounted');
    const tag = html.slice(at, at + 900);
    assert.ok(tag.includes('viewBox="0 0 16 16"'), 'same viewBox as the set');
    assert.ok(tag.includes('width="16" height="16"'), 'same rendered size as the set');
    assert.ok(!tag.includes('\u{1F4CE}'), 'the paperclip emoji must be gone');
    const shapes = tag.slice(tag.indexOf('<svg'), tag.indexOf('</svg>'))
        .match(/<(path|circle|rect)\b[^>]*>/g) || [];
    assert.ok(shapes.length >= 4, 'the tool glyph must still be drawn');
    for (const shape of shapes) {
        assert.ok(/stroke-width="1\.5"/.test(shape),
            `every path carries its own stroke-width: ${shape}`);
    }
});

test('ALIGNMENT: the FAB shares one centre line with the d-pad button', () => {
    const base = clientFile('css', 'styles.css');
    const tools = clientFile('css', 'terminal-tools.css');
    // One declaration of the geometry, in styles.css with the other tokens.
    assert.match(base, /--fab-size:\s*45px;/);
    assert.match(base, /--fab-edge:\s*20px;/);
    assert.match(base, /--fab-gap:\s*12px;/);
    assert.ok(!tools.includes('--fab-size:'),
        'the tokens must not be restated - that is how they drifted before');
    // Every button in the column derives from them. Same right offset and
    // same width means the same centre: previously 16+44/2=38px against
    // the d-pad's 20+45/2=42.5px, a 4.5px offset.
    for (const rule of ['.dpad-float-button', '.terminal-tools-fab']) {
        const src = rule === '.dpad-float-button' ? base : tools;
        const at = src.indexOf(rule + ' {');
        assert.ok(at > 0, `${rule} rule not found`);
        const block = src.slice(at, src.indexOf('}', at));
        assert.ok(block.includes('right: var(--fab-edge)') ||
            block.includes('right: var(--fab-edge);'), `${rule} must use --fab-edge`);
        assert.ok(block.includes('width: var(--fab-size)'), `${rule} must use --fab-size`);
    }
    assert.ok(!base.includes('.cloude-image-attach-button'),
        'the old hardcoded attach-button geometry must be gone');
});

// ---------------------------------------------------------------------
// Not the header kebab
// ---------------------------------------------------------------------

test('the session menu and the header kebab stay separate controls', () => {
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const menuSrc = stripComments(clientFile('js', 'terminal-tools-menu.js'));
    const kebabSrc = stripComments(clientFile('js', 'header-menu.js'));
    // terminal.js owns the id lookup and hands the node over; the menu
    // module never reaches into the header's DOM at all.
    assert.ok(clientFile('js', 'terminal.js').includes("getElementById('terminalToolsBtn')"));
    assert.ok(!menuSrc.includes('header-menu-toggle'),
        'the session menu must not drive the header kebab');
    assert.ok(!menuSrc.includes('header-menu-panel'));
    assert.ok(!kebabSrc.includes('terminalToolsBtn'),
        'the header kebab must not drive the session menu');
    assert.ok(!kebabSrc.includes('terminalToolsMenu'));
    // Disjoint control sets. An id in both would mean one control moved
    // under two owners and would fight on every layout change.
    for (const id of ['homeBtn', 'detachSessionBtn', 'logoutBtn', 'settingsBtn',
        'configEditorBtn', 'audioToggleBtn']) {
        assert.ok(!ENTRY_IDS.includes(id), `${id} is claimed by both menus`);
        assert.ok(!menuSrc.includes(`'${id}'`), `the session menu must not claim ${id}`);
    }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
