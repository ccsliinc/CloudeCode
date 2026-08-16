// Node test for client/js/terminal-tools-menu.js - the TOOLS half of the
// two session-scoped FAB menus, and the bottom-row geometry both of them
// share with the d-pad.
//
// (Replaces tests/test_terminal_tools_fold.node.mjs, which tested the
// folded strip over the terminal's top-right corner that no longer
// exists.)
//
// THE SPLIT IS THE POINT. Everything was briefly merged into one drawer
// behind the old paperclip. That grouping had no rule a user could
// learn, so the five tools are now two coherent groups:
//
//   #terminalToolsBtn  "terminal tools"  content across the terminal's
//                      boundary: copy output, paste from clipboard,
//                      attach image                       (tested here)
//   #sessionEditorBtn  "session editor"  configuring the session: theme
//                      and music     (tests/test_session_editor_menu.mjs)
//
// The properties that matter:
//   1. THE SPLIT HOLDS. Three rows here, and theme/music are NOT among
//      them - they belong to the other control, which exists.
//   2. NOTHING WAS LOST. All five tools still reach the module that owns
//      them, across the two menus.
//   3. THE ATTACH CAPABILITY SURVIVED. The hidden file input is still in
//      index.html and the "attach image" row still opens it.
//   4. NEITHER IS THE HEADER KEBAB. The app-scoped kebab stays separate.
//   5. THE ICONS MATCH THE SET, and the stroke width is on the PATH.
//      A `stroke-width` presentation attribute beats a stylesheet rule
//      that targets the `svg`, so a rule cannot be trusted to normalise
//      these - the markup has to carry the right value.
//   6. THE FABS SHARE ONE BOTTOM ROW WITH THE D-PAD, measured from the
//      tokens rather than eyeballed: equal centres on the y axis, exact
//      slot pitch on the x axis, and no two boxes overlapping.
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

/** The three rows, in the order the tools menu declares them. */
const ENTRY_IDS = [
    'toolCopyOutput',
    'toolPasteClipboard',
    'toolAttachImage',
];

/** The rows that must NOT be here - they are the session editor's. */
const EDITOR_IDS = ['sessionThemeRow', 'sessionMusicRow'];

/**
 * Load the tools menu against a mini-DOM, with recording stubs for every
 * module its rows delegate to. fab-menu.js carries the shared plumbing
 * and has to be evaluated first, exactly as index.html orders them.
 *
 * @returns {{env: object, menu: object, trigger: object, input: object,
 *   calls: object}}
 */
function load() {
    const env = createEnvironment({});
    const calls = { copyOpen: 0, paste: 0, inputClick: 0 };

    const trigger = env.document.createElement('button');
    trigger.setAttribute('id', 'terminalToolsBtn');
    trigger.className = 'fab-menu-btn terminal-tools-fab';
    env.document.body.appendChild(trigger);

    const input = env.document.createElement('input');
    input.setAttribute('id', 'cloude-image-attach-input');
    input.click = () => { calls.inputClick++; };
    env.document.body.appendChild(input);

    env.window.CopyOutput = { open: () => { calls.copyOpen++; } };
    env.window.ClipboardTools = { pasteFromClipboard: () => { calls.paste++; } };
    env.window.AnchorPopover = { place: () => ({ left: 0, top: 0 }) };

    const sandbox = {
        window: env.window,
        document: env.document,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn) => fn(),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(clientFile('js', 'fab-menu.js'), sandbox);
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
        .filter((c) => c.className === 'fab-menu terminal-tools-menu')
        .flatMap((m) => m.children)
        .find((r) => r.getAttribute('id') === id);
    assert.ok(found, `row ${id} is missing from the open menu`);
    return found;
}

/**
 * Every row id in the open menu, in order.
 * @param {object} env  The mini-DOM environment.
 * @returns {string[]}
 */
function openIds(env) {
    return env.document.body.children
        .filter((c) => c.className === 'fab-menu terminal-tools-menu')
        .flatMap((m) => m.children)
        .map((r) => r.getAttribute('id'));
}

// ---------------------------------------------------------------------
// The split
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

test('THE SPLIT: tools holds the three content rows and nothing else', () => {
    const { env, menu } = load();
    menu.open();
    assert.deepEqual(openIds(env), ENTRY_IDS);
});

test('THE SPLIT: theme and music are NOT rows of the tools menu', () => {
    const { env, menu } = load();
    menu.open();
    const ids = openIds(env);
    for (const id of EDITOR_IDS) {
        assert.ok(!ids.includes(id), `${id} belongs to the session editor`);
    }
    const src = clientFile('js', 'terminal-tools-menu.js');
    assert.ok(!src.includes('SessionThemeMenu'),
        'the tools menu must not reach into the session editor at all');
    assert.ok(!Object.keys(menu.ICONS).includes('theme'));
    assert.ok(!Object.keys(menu.ICONS).includes('music'));
});

test('THE SPLIT: the session editor exists as its own mounted control', () => {
    const html = clientFile('index.html');
    assert.ok(html.includes('id="sessionEditorBtn"'),
        'theme and music need a home, and it is this button');
    assert.ok(html.includes('/static/js/session-editor-menu.js'));
    assert.ok(html.includes('/static/js/fab-menu.js'),
        'the shared plumbing must load before either menu');
    // Ordering: fab-menu.js declares FabMenu, which both menus call at
    // module scope. Loaded the other way round, both throw on load.
    assert.ok(html.indexOf('/static/js/fab-menu.js')
        < html.indexOf('/static/js/terminal-tools-menu.js'));
    assert.ok(html.indexOf('/static/js/fab-menu.js')
        < html.indexOf('/static/js/session-editor-menu.js'));
    // Two triggers, two menus, two aria targets. A shared id would mean
    // one control opened both.
    assert.ok(html.includes('aria-controls="terminalToolsMenu"'));
    assert.ok(html.includes('aria-controls="sessionEditorMenu"'));
    assert.ok(clientFile('js', 'terminal.js').includes('SessionEditorMenu.wire'));
});

test('NOTHING WAS LOST: each tools row calls the module that owns it', () => {
    const cases = [
        ['toolCopyOutput', 'copyOpen'],
        ['toolPasteClipboard', 'paste'],
        ['toolAttachImage', 'inputClick'],
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
    // The change handler lives in clipboard.js#wireFileInput and drives
    // _uploadAndInjectImage; terminal.js must still wire it.
    assert.ok(clientFile('js', 'clipboard.js').includes('function wireFileInput'));
    const term = clientFile('js', 'terminal.js');
    assert.ok(term.includes('ClipboardTools.wireFileInput'));
    assert.ok(term.includes('_uploadAndInjectImage'),
        'the upload + path-injection flow must survive the resplit');
});

test('picking a tool closes the menu, so it never sits over the terminal', () => {
    const { env, menu } = load();
    menu.open();
    row(env, 'toolCopyOutput').dispatchEvent('click');
    assert.equal(menu.isOpen(), false);
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
        .filter((c) => c.className === 'fab-menu terminal-tools-menu');
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

test('the shared plumbing lives once, not once per menu', () => {
    const tools = clientFile('js', 'terminal-tools-menu.js');
    const editor = clientFile('js', 'session-editor-menu.js');
    // Both delegate; neither re-implements dismiss handling. Two copies
    // of this is exactly how the FAB geometry drifted before.
    for (const [name, src] of [['tools', tools], ['editor', editor]]) {
        assert.ok(src.includes('window.FabMenu.create('),
            `${name} must use the shared controller`);
        assert.ok(!src.includes("addEventListener('pointerdown'"),
            `${name} must not re-implement outside-click dismissal`);
        assert.ok(!src.includes("e.key === 'Escape'"),
            `${name} must not re-implement Escape dismissal`);
        assert.ok(src.split('\n').length < 500, `${name} must stay small`);
    }
    assert.ok(clientFile('js', 'fab-menu.js').split('\n').length < 500);
});

// ---------------------------------------------------------------------
// Icons and geometry
// ---------------------------------------------------------------------

test('ICONS: every path declares stroke-width 1.5 in a 16x16 viewBox', () => {
    const { menu } = load();
    // The editor's set is checked from source text in the same place, so
    // a stroke width cannot regress in either module unnoticed.
    const editorIcons = /var ICONS = \{[\s\S]*?\n    \};/
        .exec(clientFile('js', 'session-editor-menu.js'))[0];
    const bodies = Object.entries(menu.ICONS).concat([['editor', editorIcons]]);
    for (const [name, body] of bodies) {
        const strokedShapes = body.match(/<(path|rect|circle)\b[^>]*stroke="currentColor"[^>]*>/g) || [];
        assert.ok(strokedShapes.length, `${name} has no stroked shape`);
        for (const shape of strokedShapes) {
            assert.ok(/stroke-width="1\.5"/.test(shape),
                `${name} has a stroked shape without stroke-width 1.5: ${shape}`);
        }
    }
    const src = clientFile('js', 'fab-menu.js');
    assert.ok(src.includes("setAttribute('viewBox', '0 0 16 16')"));
    assert.ok(src.includes("setAttribute('width', '16')"));
    assert.ok(src.includes("setAttribute('height', '16')"));
});

test('each FAB carries its OWN glyph, in the same set, inline in index.html', () => {
    const html = clientFile('index.html');
    const glyphs = {};
    for (const id of ['terminalToolsBtn', 'sessionEditorBtn']) {
        const at = html.indexOf(`id="${id}"`);
        assert.ok(at > 0, `${id} must be mounted`);
        const tag = html.slice(at, at + 1200);
        assert.ok(tag.includes('viewBox="0 0 16 16"'), `${id}: same viewBox as the set`);
        assert.ok(tag.includes('width="16" height="16"'), `${id}: same rendered size`);
        assert.ok(!tag.includes('\u{1F4CE}'), 'the paperclip emoji must be gone');
        const svg = tag.slice(tag.indexOf('<svg'), tag.indexOf('</svg>'));
        const shapes = svg.match(/<(path|circle|rect)\b[^>]*>/g) || [];
        assert.ok(shapes.length >= 2, `${id}: the glyph must be drawn`);
        for (const shape of shapes) {
            assert.ok(/stroke-width="1\.5"/.test(shape),
                `${id}: every path carries its own stroke-width: ${shape}`);
        }
        glyphs[id] = svg;
    }
    // Two controls that look identical are the merge complaint again in
    // a different form.
    assert.notEqual(glyphs.terminalToolsBtn, glyphs.sessionEditorBtn,
        'the two FABs must be distinguishable at a glance');
});

test('GEOMETRY: the bottom row is measured from the tokens, not eyeballed', () => {
    const base = clientFile('css', 'styles.css');
    const tools = clientFile('css', 'terminal-tools.css');
    // One declaration of the geometry, in styles.css with the other tokens.
    assert.match(base, /--fab-size:\s*45px;/);
    assert.match(base, /--fab-edge:\s*20px;/);
    assert.match(base, /--fab-gap:\s*12px;/);
    assert.ok(!tools.includes('--fab-size:'),
        'the tokens must not be restated - that is how they drifted before');

    // Resolve them and lay the row out the way the browser will.
    const size = 45, edge = 20, gap = 12, step = size + gap;
    assert.match(base, /--fab-step:\s*calc\(var\(--fab-size\) \+ var\(--fab-gap\)\);/);
    const slot = (n) => edge + step * n;
    const boxes = {
        // right offset -> [left, right] measured from the viewport's
        // right edge, so smaller numbers are further right.
        'terminal tools': slot(0),
        'd-pad': slot(1),
        'session editor': slot(2),
    };
    assert.deepEqual(boxes, {
        'terminal tools': 20, 'd-pad': 77, 'session editor': 134,
    });
    // Adjacent centres are exactly one step apart: 42.5 / 99.5 / 156.5
    // from the right edge. The regression this guards is the 4.5px
    // mismatch a hand-written right:16px/44px box produced.
    const centres = Object.values(boxes).map((r) => r + size / 2);
    assert.deepEqual(centres, [42.5, 99.5, 156.5]);
    for (let i = 1; i < centres.length; i++) {
        assert.equal(centres[i] - centres[i - 1], step,
            'two FABs must be exactly one slot apart');
    }
    // No overlap: the near edge of each box clears the far edge of the
    // previous one by exactly --fab-gap.
    for (let i = 1; i < centres.length; i++) {
        const clearance = Object.values(boxes)[i] - (Object.values(boxes)[i - 1] + size);
        assert.equal(clearance, gap, 'FABs must not overlap');
    }
    // And they share one y: every one of them derives its bottom from
    // the same token, in the base rule and in the iOS safe-area rule.
    assert.match(ruleOf(tools, '.fab-menu-btn'), /bottom:\s*var\(--fab-edge\);/);
    assert.match(ruleOf(base, '.dpad-float-button'), /bottom:\s*var\(--fab-edge\);/);
    assert.match(ruleOf(base, '.slash-commands-btn'), /bottom:\s*var\(--fab-edge\);/);
    const ios = clientFile('css', 'ios-chrome.css');
    assert.ok(!/\.terminal-tools-fab\s*\{/.test(ios),
        'the old stacked safe-area override must be gone, not left to drift');
    assert.match(ios,
        /\.dpad-float-button,\n\.slash-commands-btn,\n\.fab-menu-btn \{\n\s*bottom: calc\(var\(--fab-edge\) \+ env\(safe-area-inset-bottom\)\);/,
        'one safe-area rule for the whole row keeps them on one line');

    assert.ok(!base.includes('.cloude-image-attach-button'),
        'the old hardcoded attach-button geometry must be gone');
});

test('NOTHING MOVED INSIDE #terminal, so the scroll guard cannot eat a tap', () => {
    const html = clientFile('index.html');
    // #terminal carries TerminalScroll.blockOverscrollEscape, which calls
    // preventDefault on single-touch drags that would escape the
    // scrollback. Anything mounted inside it loses its gestures to that
    // guard. The element is empty in the markup and xterm owns it.
    assert.ok(/<div id="terminal"><\/div>/.test(html),
        '#terminal must stay empty in the markup');
    // Both triggers and the file input are body-level, mounted after the
    // div that closes #terminal-screen.
    const screenEnd = html.indexOf('<!-- Vendored xterm.js');
    assert.ok(screenEnd > 0);
    for (const id of ['terminalToolsBtn', 'sessionEditorBtn',
        'cloude-image-attach-input']) {
        assert.ok(html.indexOf(`id="${id}"`) > screenEnd,
            `${id} must sit outside #terminal-screen, not inside #terminal`);
    }
    // And the popups are appended to body, never into the terminal.
    const fab = clientFile('js', 'fab-menu.js');
    assert.ok(fab.includes('document.body.appendChild(menuEl)'));
    assert.ok(!fab.includes("getElementById('terminal')"));
    for (const f of ['terminal-tools-menu.js', 'session-editor-menu.js']) {
        assert.ok(!clientFile('js', f).includes("getElementById('terminal')"),
            `${f} must not mount anything inside #terminal`);
    }
    // The gesture fix itself is untouched.
    assert.match(clientFile('css', 'styles.css'),
        /\.terminal-container \{[^}]*overscroll-behavior: contain;/s);
});

test('GEOMETRY: desktop closes the row rather than leaving the d-pad hole', () => {
    const base = clientFile('css', 'styles.css');
    const tools = clientFile('css', 'terminal-tools.css');
    // styles.css hides the d-pad outright at >=769px: it is a touch
    // control. Slot 1 therefore goes empty on desktop.
    const hide = /@media \(min-width: 769px\) \{[\s\S]*?\.dpad-float-button \{\s*\n\s*display: none !important;/;
    assert.match(base, hide, 'the d-pad must still be touch-only');
    // So the editor moves up into it. Without this the row renders as two
    // buttons 69px apart with a gap that reads as a failed render.
    assert.match(tools,
        /@media \(min-width: 769px\) \{\s*\n\s*\.session-editor-fab \{\s*\n\s*right: var\(--fab-slot-1\);/,
        'desktop must reclaim slot 1, from the same tokens');
    // Same breakpoint in both files, or the hole reopens at some width.
    const breakpoints = (tools.match(/@media \(min-width: (\d+)px\)/g) || []);
    assert.ok(breakpoints.includes('@media (min-width: 769px)'));
});

/**
 * The declaration block of a rule, by exact selector.
 * @param {string} css  Stylesheet text.
 * @param {string} sel  The selector, e.g. '.fab-menu-btn'.
 * @returns {string} The text between the selector and its closing brace.
 */
function ruleOf(css, sel) {
    const at = css.indexOf(sel + ' {');
    assert.ok(at > -1, `${sel} rule not found`);
    return css.slice(at, css.indexOf('}', at));
}

// ---------------------------------------------------------------------
// Not the header kebab
// ---------------------------------------------------------------------

test('the session menus and the header kebab stay separate controls', () => {
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const menuSrc = stripComments(clientFile('js', 'terminal-tools-menu.js'))
        + stripComments(clientFile('js', 'session-editor-menu.js'));
    const kebabSrc = stripComments(clientFile('js', 'header-menu.js'));
    // terminal.js owns the id lookups and hands the nodes over; neither
    // menu module reaches into the header's DOM at all.
    assert.ok(clientFile('js', 'terminal.js').includes("getElementById('terminalToolsBtn')"));
    assert.ok(clientFile('js', 'terminal.js').includes("getElementById('sessionEditorBtn')"));
    assert.ok(!menuSrc.includes('header-menu-toggle'),
        'a session menu must not drive the header kebab');
    assert.ok(!menuSrc.includes('header-menu-panel'));
    assert.ok(!kebabSrc.includes('terminalToolsBtn'),
        'the header kebab must not drive a session menu');
    assert.ok(!kebabSrc.includes('terminalToolsMenu'));
    assert.ok(!kebabSrc.includes('sessionEditorBtn'),
        'session theme and music must NOT land in the app-scoped kebab');
    assert.ok(!kebabSrc.includes('sessionEditorMenu'));
    // Disjoint control sets. An id in both would mean one control moved
    // under two owners and would fight on every layout change.
    for (const id of ['homeBtn', 'detachSessionBtn', 'logoutBtn', 'settingsBtn',
        'configEditorBtn', 'audioToggleBtn']) {
        assert.ok(!ENTRY_IDS.includes(id), `${id} is claimed by both menus`);
        assert.ok(!EDITOR_IDS.includes(id), `${id} is claimed by both menus`);
        assert.ok(!menuSrc.includes(`'${id}'`), `a session menu must not claim ${id}`);
    }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
