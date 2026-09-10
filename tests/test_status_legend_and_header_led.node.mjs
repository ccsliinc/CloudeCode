// Node test for the status legend copy (defect C) and the terminal
// header's status light (defect D), 2026-09-09.
//
// WHY IT ASSERTS AGAINST RENDERED MARKUP, NOT STATE. Same rule the
// agent-family-pill test records: this project once shipped a feature
// with 282 green state assertions that rendered zero pixels. Every
// assertion below reads the HTML string the renderer actually produced,
// or the DOM the header module actually mutated.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT: the LED's rings, classes,
// colours or sizes. Those belong to client/js/status-led.js and
// client/css/status-led.css, which are owned elsewhere and are under
// concurrent edit; pinning them here would make this file fail for
// somebody else's correct change. The contract this file locks down is
// the TITLE - the words a user reads - and the header's DOM behaviour.
//
// Run with: node tests/test_status_legend_and_header_led.node.mjs

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
 * @param {string} name  Test description.
 * @param {() => void} fn  Body; throwing marks it failed.
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
 * One stub element: enough DOM for the header module to insert, update
 * and remove a child of the title's parent.
 * @param {string} id  Element id.
 * @returns {object} The stub.
 */
function makeEl(id) {
    return {
        id,
        innerHTML: '',
        className: '',
        parentNode: null,
        children: [],
        insertBefore(node) {
            node.parentNode = this;
            this.children.unshift(node);
            return node;
        },
        removeChild(node) {
            this.children = this.children.filter((c) => c !== node);
            node.parentNode = null;
            return node;
        },
    };
}

/**
 * Build a context holding a header shaped like index.html's: an <h1>
 * wrapper with the title span inside it.
 * @returns {object} {ctx, titleEl, wrapperEl, byId}
 */
function makeContext() {
    const byId = new Map();
    const wrapperEl = makeEl('appTitle');
    const titleEl = makeEl('header-title-text');
    titleEl.parentNode = wrapperEl;
    wrapperEl.children.push(titleEl);
    byId.set('appTitle', wrapperEl);
    byId.set('header-title-text', titleEl);

    const document = {
        getElementById(id) {
            // A dynamically created element is findable only once it has
            // been inserted, which is what the real DOM does and what the
            // module's "already there?" branch depends on.
            const created = wrapperEl.children.find((c) => c.id === id);
            return created || byId.get(id) || null;
        },
        createElement(tag) {
            return makeEl('');
        },
    };

    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        document,
        setInterval() { return 1; },
        clearInterval() {},
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    return { ctx, titleEl, wrapperEl };
}

/**
 * Load client scripts into a context, in the order index.html loads them.
 * @param {object} ctx  A vm context.
 * @param {string[]} files  Paths relative to client/js.
 * @returns {void}
 */
function load(ctx, files) {
    for (const file of files) {
        const src = fs.readFileSync(path.join(ROOT, 'client', 'js', file), 'utf8');
        vm.runInContext(src, ctx, { filename: file });
    }
}

const SCRIPTS = [
    'status-led.js',
    'session-status-ui.js',
    'session-header-led.js',
];

// ------------------------------------------------------------------ //
// C. The legend copy. Words a user reads, in one place.
// ------------------------------------------------------------------ //

test('C: every state reads the way the owner asked for', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const UI = ctx.window.SessionStatusUI;

    assert.equal(UI.labelFor('idle'), 'idle - read, nothing running');
    assert.equal(UI.labelFor('finished_unread'), 'done - unread');
    // The two attention states name WHO is waiting on whom, because at a
    // glance a bare "waiting for permission" reads as the app waiting on
    // something rather than claude waiting on the user.
    assert.equal(UI.labelFor('notice'), 'your turn - claude wants your attention');
    assert.equal(UI.labelFor('question'), 'your turn - claude needs your permission');
    assert.equal(UI.labelFor('working'), 'working');
    assert.equal(UI.labelFor('unknown'), 'not measured');
    assert.equal(UI.labelFor('dead'), 'dead - process exited');
});

test('C: the old shell wording is gone from every state', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const UI = ctx.window.SessionStatusUI;
    // MEASURED: 15 of 19 live panes were running claude, not a shell, so
    // "waiting at the shell" was wrong about four fifths of the sessions
    // it described.
    for (const key of ['idle', 'unknown', 'working', 'notice', 'question']) {
        assert.ok(
            !UI.labelFor(key).includes('shell'),
            `${key} still mentions a shell`,
        );
    }
});

test('C: the label reaches the rendered title attribute', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const html = ctx.window.SessionStatusUI.dotHtml('idle', { unread: false });
    assert.ok(
        html.includes('title="idle - read, nothing running"'),
        `title not rendered: ${html}`,
    );
});

// ------------------------------------------------------------------ //
// E. Provenance, in the tooltip and nowhere else.
// ------------------------------------------------------------------ //

test('E: a source is appended to the tooltip', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const UI = ctx.window.SessionStatusUI;
    assert.equal(
        UI.labelWithSource('working', 'hook'), 'working (via hooks)',
    );
    assert.equal(
        UI.labelWithSource('idle', 'transcript'),
        'idle - read, nothing running (via transcript)',
    );
});

test('E: an absent or unrecognised source appends nothing', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const UI = ctx.window.SessionStatusUI;
    assert.equal(UI.labelWithSource('working', 'none'), 'working');
    assert.equal(UI.labelWithSource('working', undefined), 'working');
    assert.equal(UI.labelWithSource('working', 'made up'), 'working');
});

test('E: the source changes the tooltip and NOTHING else', () => {
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const UI = ctx.window.SessionStatusUI;
    const plain = UI.dotHtml('idle', { unread: false });
    const sourced = UI.dotHtml('idle', { unread: false, status_source: 'hook' });
    // Strip the two attributes that carry the label, and the rest of the
    // markup must be byte-identical: one status must never have two
    // appearances.
    const strip = (s) => s
        .replace(/title="[^"]*"/g, '')
        .replace(/aria-label="[^"]*"/g, '');
    assert.equal(strip(plain), strip(sourced));
    assert.ok(sourced.includes('via hooks'));
});

// ------------------------------------------------------------------ //
// D. The header light.
// ------------------------------------------------------------------ //

test('D: a matching list row paints a light beside the title', () => {
    const { ctx, titleEl, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update([{ name: 'cloude_a', status: 'working', unread: false }], 'cloude_a');

    const led = wrapperEl.children.find((c) => c.id === HL.LED_ID);
    assert.ok(led, 'no header light was inserted');
    assert.ok(led.innerHTML.includes('title="working"'), led.innerHTML);
    // It sits BEFORE the title text, inside the same wrapper.
    assert.ok(
        wrapperEl.children.indexOf(led) < wrapperEl.children.indexOf(titleEl),
        'the light is not before the title',
    );
});

test('D: it updates in place when the status changes', () => {
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update([{ name: 'cloude_a', status: 'working' }], 'cloude_a');
    HL.update([{ name: 'cloude_a', status: 'idle' }], 'cloude_a');

    const leds = wrapperEl.children.filter((c) => c.id === HL.LED_ID);
    assert.equal(leds.length, 1, 'a second light was inserted');
    assert.ok(leds[0].innerHTML.includes('idle - read, nothing running'));
});

test('D: the bind that clears unread turns the light idle', () => {
    // The exact sequence the owner described: a session finishes a turn
    // and is unread, the tab is opened, the flag clears, and the light
    // must follow on the next poll rather than staying done-unread.
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update(
        [{ name: 'cloude_a', status: 'finished_unread', unread: true }],
        'cloude_a',
    );
    let led = wrapperEl.children.find((c) => c.id === HL.LED_ID);
    assert.ok(led.innerHTML.includes('done - unread'), led.innerHTML);

    HL.update([{ name: 'cloude_a', status: 'idle', unread: false }], 'cloude_a');
    led = wrapperEl.children.find((c) => c.id === HL.LED_ID);
    assert.ok(led.innerHTML.includes('idle - read, nothing running'));
});

test('D: it carries the status source into the header tooltip', () => {
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update(
        [{ name: 'cloude_a', status: 'idle', status_source: 'transcript' }],
        'cloude_a',
    );

    const led = wrapperEl.children.find((c) => c.id === HL.LED_ID);
    assert.ok(led.innerHTML.includes('via transcript'), led.innerHTML);
});

test('D: no attached session removes the light rather than freezing it', () => {
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update([{ name: 'cloude_a', status: 'working' }], 'cloude_a');
    HL.update([{ name: 'cloude_a', status: 'working' }], null);

    assert.equal(
        wrapperEl.children.filter((c) => c.id === HL.LED_ID).length, 0,
        'a light was left under a header naming something else',
    );
});

test('D: a session with no row in the list paints nothing', () => {
    // NEGATIVE CONTROL. An absent row is not an `unknown` measurement,
    // and painting one would look exactly like a measurement.
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update([{ name: 'cloude_other', status: 'working' }], 'cloude_a');

    assert.equal(HL.rowFor([{ name: 'cloude_other' }], 'cloude_a'), null);
    assert.equal(
        wrapperEl.children.filter((c) => c.id === HL.LED_ID).length, 0,
    );
});

test('D: a SessionInfo is read off the WRAPPER, not off .session', () => {
    // The single most repeated bug in this project: activity_status,
    // unread, startup_gate and status_source all sit on the wrapper.
    const { ctx } = makeContext();
    load(ctx, SCRIPTS);
    const row = ctx.window.SessionHeaderLed.rowFromInfo({
        tmux_session: 'cloude_a',
        activity_status: 'notice',
        unread: true,
        status_source: 'hook',
        session: { id: 'ses_1', unread: false },
    });
    assert.equal(row.name, 'cloude_a');
    assert.equal(row.status, 'notice');
    assert.equal(row.unread, true);
    assert.equal(row.status_source, 'hook');
});

test('D: an older payload with no status_source still renders', () => {
    const { ctx, wrapperEl } = makeContext();
    load(ctx, SCRIPTS);
    const HL = ctx.window.SessionHeaderLed;

    HL.update([{ name: 'cloude_a', status: 'idle' }], 'cloude_a');

    const led = wrapperEl.children.find((c) => c.id === HL.LED_ID);
    assert.ok(led && led.innerHTML.includes('idle - read, nothing running'));
    assert.ok(!led.innerHTML.includes('(via'));
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
