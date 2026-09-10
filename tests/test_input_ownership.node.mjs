// Input ownership: an upload finishing for session A must never insert
// into session B.
// ----------------------------------------------------------------------
// THE DEFECT. terminal.js intercepts a file paste, uploads the blob, and
// inserts the returned absolute path into the terminal. Nothing between
// the upload starting and the insert happening checked that the user was
// still in the session that was open when they pasted. Output in the
// wrong pane is confusing; INPUT in the wrong pane runs a command.
//
// ASSERT BOTH SIDES OF THE DROP. Checking only "B received nothing"
// passes if the code threw on the way there, so every refusal case here
// also asserts that the user was TOLD, through the app's single
// status-pill path.
//
// AND ASSERT THE POSITIVE CONTROL. A guard that refused everything would
// satisfy every "nothing was written" assertion perfectly while making
// paste, upload and the slash commands unusable, so each case is paired
// with the same scenario resolved in order.
//
// This drives the SHIPPED client/js/clipboard.js and the SHIPPED
// client/js/terminal.js, so a re-implementation cannot pass while the
// real files break.
//
// Run with: node --test tests/test_input_ownership.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NAVGEN_SRC = read('client/js/navigation-generation.js');
const OWN_SRC = read('client/js/terminal-input-ownership.js');
const CLIP_SRC = read('client/js/clipboard.js');
const TERM_SRC = read('client/js/terminal.js');
const INDEX_HTML = read('client/index.html');
const TERM_SINGLETON = 'window.TerminalController = new Terminal();';

const OPEN = 1;

/**
 * Description: build a sandbox holding the generation counter, the
 *   ownership predicate and the shipped clipboard module, plus a fake
 *   terminal that records every byte written and every pill raised.
 * Inputs: none.
 * Output: {w, term, uploads, NG, Own, Clip}.
 */
function makeWorld() {
    const sandbox = {
        window: {},
        document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout, clearTimeout, Promise, TextEncoder,
        navigator: {},
        WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.navigator = sandbox.navigator;
    sandbox.window.WebSocket = sandbox.WebSocket;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });
    vm.runInContext(OWN_SRC, sandbox, { filename: 'terminal-input-ownership.js' });

    const uploads = [];
    sandbox.window.API = {
        uploadFile: (blob, filename) => {
            const u = { filename };
            let resolve;
            u.promise = new Promise((r) => { resolve = r; });
            u.resolve = (p) => resolve({ path: p, filename });
            uploads.push(u);
            return u.promise;
        },
    };
    vm.runInContext(CLIP_SRC, sandbox, { filename: 'clipboard.js' });
    if (!sandbox.window.ClipboardTools) {
        throw new Error(
            'clipboard.js did not export itself into the sandbox, so every '
            + 'case below would be measuring a harness bug');
    }

    // The Terminal wrapper as clipboard.js actually uses it: a socket, an
    // insertText, a status pill and a session id.
    const term = {
        written: [],
        pills: [],
        ws: { readyState: OPEN, send() {} },
        insertText(text) { this.written.push(text); },
        _showStatusPill(msg, kind) { this.pills.push({ msg, kind }); },
        _sessionId: () => 'ses_a',
    };
    return {
        w: sandbox.window,
        term,
        uploads,
        NG: sandbox.window.NavigationGeneration,
        Own: sandbox.window.TerminalInputOwnership,
        Clip: sandbox.window.ClipboardTools,
        sandbox,
    };
}

/**
 * Description: the shipped Terminal class, minus its singleton line.
 * Inputs: sandbox (vm context). Output: class.
 */
function loadTerminalClass(sandbox) {
    const cut = TERM_SRC.indexOf(TERM_SINGLETON);
    if (cut === -1) throw new Error('terminal.js no longer ends with its singleton line');
    vm.runInContext(
        TERM_SRC.slice(0, cut) + '\nwindow.__TerminalClass = Terminal;',
        sandbox, { filename: 'terminal.js' });
    return sandbox.window.__TerminalClass;
}

// ------------------------------------------------------ the predicate

test('a ticket is current until the navigation moves', () => {
    const { NG, Own } = makeWorld();
    NG.begin('session:a');
    const t = Own.claim('paste');
    assert.equal(Own.permits(t), true);
    NG.begin('session:b');
    assert.equal(Own.permits(t), false);
});

test('no ticket means no check, because that path declared it needs none', () => {
    // The keyboard, the Shift+Enter chord and the D-pad pass nothing.
    // Refusing them would turn a correctness guard into a new way for
    // input to disappear.
    const { NG, Own } = makeWorld();
    NG.begin('session:a');
    NG.begin('session:b');
    assert.equal(Own.permits(null), true);
    assert.equal(Own.permits(undefined), true);
});

test('a missing generation module is not a refusal', () => {
    const { w, NG, Own } = makeWorld();
    NG.begin('session:a');
    const t = Own.claim('paste');
    delete w.NavigationGeneration;
    assert.equal(Own.permits(t), true,
        'a load-order accident must not stop the terminal accepting input');
});

// ------------------------------------------- the upload, out of order

test('POSITIVE CONTROL: an upload that lands in its own session inserts the path', async () => {
    const { term, uploads, NG, Clip } = makeWorld();
    NG.begin('session:a');
    const ticket = { nav: NG.current(), what: 'paste' };
    const run = Clip.uploadAndInject(term, {}, 'shot.png', ticket);
    uploads[0].resolve('/tmp/shot.png');
    await run;
    assert.deepEqual(term.written, ['/tmp/shot.png '],
        'the ordinary paste must still work, or nothing below measures a guard');
});

test('THE DECISIVE CASE: an upload resolving after a session switch inserts nothing, and says so', async () => {
    const { term, uploads, NG, Own, Clip } = makeWorld();
    NG.begin('session:a');
    const ticket = Own.claim('paste');
    const run = Clip.uploadAndInject(term, {}, 'shot.png', ticket);
    // The user switches sessions while the upload is in flight.
    NG.begin('session:b');
    uploads[0].resolve('/tmp/shot.png');
    await run;
    assert.deepEqual(term.written, [],
        'session B must receive ZERO bytes from a paste made in session A');
    const dropped = term.pills.filter((p) => /dropped, you changed sessions/.test(p.msg));
    assert.equal(dropped.length, 1,
        'and the user must be TOLD - asserting only that B got nothing would '
        + 'pass if the code had thrown on the way there');
    assert.match(dropped[0].msg, /^paste dropped/,
        'the message names what was dropped, in the words the gesture used');
});

test('the dropped upload raises no attachment card either', async () => {
    const { w, term, uploads, NG, Own, Clip } = makeWorld();
    const shown = [];
    w.AttachmentToast = { show: (t, payload) => shown.push(payload) };
    NG.begin('session:a');
    const ticket = Own.claim('paste');
    const run = Clip.uploadAndInject(term, {}, 'shot.png', ticket);
    NG.begin('session:b');
    uploads[0].resolve('/tmp/shot.png');
    await run;
    assert.deepEqual(shown, [],
        'a receipt for a file nobody attached is a card about a session '
        + 'the user is not in');
});

// -------------------------------------------- the text injection path

test('injectText refuses a stale ticket BEFORE it reports anything else', () => {
    // Order matters: "terminal not connected" and "clipboard is empty"
    // would both be misleading answers to "why did my paste vanish".
    const { term, NG, Own, Clip } = makeWorld();
    NG.begin('session:a');
    const ticket = Own.claim('paste');
    NG.begin('session:b');
    term.ws = null;                       // also not connected
    Clip.injectText(term, 'ls -la', ticket);
    assert.deepEqual(term.written, []);
    assert.equal(term.pills.length, 1);
    assert.match(term.pills[0].msg, /dropped, you changed sessions/,
        'the true reason must win over the not-connected report');
});

test('POSITIVE CONTROL: injectText with a current ticket still writes', () => {
    const { term, NG, Own, Clip } = makeWorld();
    NG.begin('session:a');
    const ticket = Own.claim('paste');
    Clip.injectText(term, 'ls -la', ticket);
    assert.deepEqual(term.written, ['ls -la']);
});

// --------------------------------- the shipped terminal's write point

test('Terminal#insertText is the last line of defence and honours a ticket', () => {
    const { sandbox, NG, Own } = makeWorld();
    const Klass = loadTerminalClass(sandbox);
    const sent = [];
    const self = {
        ws: { readyState: OPEN, send: (b) => sent.push(b) },
        _noteUserInputToSession() {},
        insertText: Klass.prototype.insertText,
    };
    NG.begin('session:a');
    const ticket = Own.claim('command');
    // POSITIVE CONTROL first.
    self.insertText('/help', ticket);
    assert.equal(sent.length, 1, 'a current ticket must write');
    NG.begin('session:b');
    self._showStatusPill = () => {};
    self.insertText('/clear', ticket);
    assert.equal(sent.length, 1,
        'a stale ticket must not reach ws.send - this is the slash command '
        + 'picked from a panel the user left open across a switch');
    // And with no ticket at all, the keyboard-shaped callers still work.
    self.insertText('plain text');
    assert.equal(sent.length, 2);
});

// -------------------------------------------------- wiring, in the page

test('index.html loads the ownership module before terminal.js and clipboard.js', () => {
    const order = [...INDEX_HTML.matchAll(/\/static\/js\/([A-Za-z0-9._\-/]+\.js)/g)]
        .map((m) => m[1]);
    const at = (f) => order.indexOf(f);
    assert.ok(at('terminal-input-ownership.js') >= 0,
        'the module must be in index.html or it is dead code');
    for (const consumer of ['terminal.js', 'clipboard.js', 'paste-fallback.js',
                            'slash-commands.js']) {
        assert.ok(at('terminal-input-ownership.js') < at(consumer),
            `terminal-input-ownership.js must load before ${consumer}`);
    }
    assert.ok(at('navigation-generation.js') < at('terminal-input-ownership.js'),
        'and after the generation counter it reads');
});

test('every async input path claims at the gesture, and the paste stays in capture phase', () => {
    const term = read('client/js/terminal.js');
    // The claim must be the FIRST thing in the paste handler. Claiming
    // after the await would compare a freshly read value against itself.
    const handler = term.slice(term.indexOf("container.addEventListener('paste'"));
    const claimAt = handler.indexOf('TerminalInputOwnership');
    const awaitAt = handler.indexOf('await this._uploadAndInjectFile');
    assert.ok(claimAt > 0 && claimAt < awaitAt,
        'the paste handler must claim ownership before it awaits the upload');
    assert.match(handler.slice(0, handler.indexOf('}, true);') + 9), /\}, true\);/,
        'and the listener stays in CAPTURE phase - it must run before '
        + "xterm's own bubble-phase paste handler");

    const clip = read('client/js/clipboard.js');
    assert.match(clip, /input\.addEventListener\('change', async \(\) => \{[\s\S]{0,400}TerminalInputOwnership\.claim/,
        'the attach-file picker must claim at its change event');
    assert.match(clip, /function pasteFromClipboard\(term, ticket\)/,
        'pasteFromClipboard must accept and honour a ticket');

    const slash = read('client/js/slash-commands.js');
    const open = slash.slice(slash.indexOf('    open() {'));
    assert.match(open.slice(0, 600), /TerminalInputOwnership\.claim/,
        'the slash panel must claim when it OPENS, because nothing closes '
        + 'it on a session switch');
});

test('the copy sheet is deliberately unguarded, and that was measured', () => {
    // The open question on the issue. copy-output.js reads the xterm
    // buffer and writes to the SYSTEM clipboard; it never writes into the
    // terminal, so a check there would guard nothing and would tell the
    // next reader there was a race.
    const copy = read('client/js/copy-output.js');
    assert.ok(!/insertText|\.ws\.send/.test(copy),
        'copy-output.js must not write into the terminal - if it starts '
        + 'to, it needs a ticket like every other input path');
});

test('the synchronous paths take no ticket, and that is stated rather than forgotten', () => {
    const term = read('client/js/terminal.js');
    for (const fn of ['sendKeyToTerminal(keyData) {', '_writeSynthetic(data) {']) {
        const body = term.slice(term.indexOf(fn), term.indexOf(fn) + 400);
        assert.ok(!/TerminalInputOwnership/.test(body),
            `${fn} must stay unguarded: there is no await between the key `
            + 'and ws.send, so a check costs a comparison and buys nothing');
    }
    const own = read('client/js/terminal-input-ownership.js');
    assert.match(own, /keyboard[\s\S]{0,200}D-pad/,
        'and the module must say WHICH paths take none and why, or the next '
        + 'reader will add a decorative check');
});
