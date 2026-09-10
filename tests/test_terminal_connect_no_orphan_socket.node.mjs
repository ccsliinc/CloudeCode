// connectWebSocket() must not abandon a socket that is still CONNECTING.
// ----------------------------------------------------------------------
// THE DEFECT. The method refused to reconnect only when the existing
// socket was OPEN:
//
//     if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
//
// A socket still mid-handshake fell straight through that and was
// silently overwritten by `this.ws = window.API.openWebSocket(...)` at the
// bottom of the method. Nothing closed it, and the server does not close
// on handshake timeout either, so the orphan stayed open forever still
// attached to the pane's FIFO. Measured on live: 161 WebSocket connects
// against 116 disconnects, so 45 sockets opened and never closed, and 70
// `send_pty_output_error` lines writing bytes to viewers nobody was
// watching.
//
// THE FIX IS CLOSE-BEFORE-OVERWRITE, NOT REFUSE-WHILE-CONNECTING, and the
// distinction is what this suite is really pinning. Refusing while
// CONNECTING is the obvious alternative and it is a trap: ONE socket
// wedged in CONNECTING would block every future reconnect for the life of
// the page, converting a thirty-second stall into a permanent outage. So
// the last case here asserts that a new socket IS created - a fix that
// merely refused would satisfy "no orphan left behind" perfectly while
// breaking reconnect entirely.
//
// THE HANDLERS COME OFF FIRST, and that is asserted too. A close this
// method asked for must not reach `onclose`, which would paint the
// "[Disconnected]" banner and start a reconnect ladder racing the connect
// happening on the very next line.
//
// This drives the SHIPPED client/js/terminal.js class, loaded through the
// same loader the other terminal suites use, so a re-implementation
// cannot pass while the real file breaks.
//
// Run with: node tests/test_terminal_connect_no_orphan_socket.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TERM_SRC = fs.readFileSync(path.join(ROOT, 'client/js/terminal.js'), 'utf8');
const ABANDON_SRC = fs.readFileSync(
    path.join(ROOT, 'client/js/terminal-socket-abandon.js'), 'utf8');
const TERM_SINGLETON = 'window.TerminalController = new Terminal();';
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');

const tests = [];
/** Description: register one named case. Inputs: name, fn. Output: None. */
function test(name, fn) { tests.push([name, fn]); }

// The four readyState values, spelled here rather than imported because
// node has no WebSocket constant in a vm context. These are the values
// the browser uses and the values terminal.js compares against.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * Description: a socket that records whether it was closed and what its
 *   handlers were at the moment of closing. Recording the handlers AT
 *   CLOSE TIME rather than afterwards is the point: the claim under test
 *   is an ORDERING (detach, then close), and a check made after the fact
 *   cannot tell a detach-before from a detach-after.
 * Inputs: readyState (number).
 * Output: object.
 */
function fakeSocket(readyState) {
    const sock = {
        readyState,
        closed: 0,
        handlersAtClose: null,
        onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => {},
        binaryType: '',
        close() {
            this.closed += 1;
            this.handlersAtClose = {
                onopen: this.onopen,
                onmessage: this.onmessage,
                onerror: this.onerror,
                onclose: this.onclose,
            };
            this.readyState = CLOSING;
        },
    };
    return sock;
}

/**
 * Description: the shipped Terminal class, loaded without its trailing
 *   singleton construction (that line builds a live xterm against a pty
 *   and cannot run outside a browser).
 * Inputs: sandbox (vm context). Output: class.
 */
function loadTerminalClass(sandbox) {
    const cut = TERM_SRC.indexOf(TERM_SINGLETON);
    if (cut === -1) {
        throw new Error(
            'terminal.js no longer ends with its singleton line, so this '
            + 'loader is slicing something it does not understand - refusing '
            + 'to guess');
    }
    vm.runInContext(
        TERM_SRC.slice(0, cut) + '\nwindow.__TerminalClass = Terminal;',
        sandbox, { filename: 'terminal.js' });
    return sandbox.window.__TerminalClass;
}

/**
 * Description: a `this` carrying exactly what connectWebSocket() reads,
 *   with every collaborator that would touch a real browser or a real pty
 *   replaced by a recorder.
 * Inputs: existing (object|null) - the socket already on the controller.
 * Output: {self, opened} - opened is every socket the method created.
 */
function makeController(existing) {
    const opened = [];
    const sandbox = {
        window: {}, document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout, clearTimeout, Promise, requestAnimationFrame: (fn) => { fn(); return 1; },
        WebSocket: { CONNECTING, OPEN, CLOSING, CLOSED },
        TextEncoder, CSS: undefined,
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.WebSocket = sandbox.WebSocket;
    sandbox.window.API = {
        getWebSocketURL: () => 'ws://test/ws',
        openWebSocket: () => {
            const s = fakeSocket(CONNECTING);
            opened.push(s);
            return s;
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(ABANDON_SRC, sandbox, { filename: 'terminal-socket-abandon.js' });
    if (!sandbox.window.TerminalSocketAbandon) {
        throw new Error(
            'terminal-socket-abandon.js did not export itself into the '
            + 'sandbox, so connectWebSocket would fall back to the old '
            + 'overwrite-and-leak path and every case below would be '
            + 'measuring the defect while looking like a harness bug');
    }
    const Klass = loadTerminalClass(sandbox);
    const P = Klass.prototype;
    for (const name of ['connectWebSocket', '_sessionId', '_unwrapSession']) {
        if (typeof P[name] !== 'function') {
            throw new Error(`terminal.js has no ${name}() any more`);
        }
    }

    const self = {
        ws: existing,
        isReconnecting: false,
        _currentSession: { id: 'ses_test' },
        term: { cols: 80, rows: 24 },
        fitAddon: { fit() {} },
        statuses: [],
        handlersInstalled: 0,
        updateStatus(s) { this.statuses.push(s); },
        // The layout wait is NOT under test here and must not be
        // reimplemented: gotcha 9 in CLAUDE.md and
        // tests/test_terminal_layout_wait.node.mjs own it. Stubbed to
        // resolve immediately so this suite measures socket lifetime and
        // nothing else.
        waitForFontsAndLayout() { return Promise.resolve(); },
        setupWebSocketHandlers() { this.handlersInstalled += 1; },
        connectWebSocket: P.connectWebSocket,
        _sessionId: P._sessionId,
        _unwrapSession: P._unwrapSession,
    };
    return { self, opened, sandbox };
}

// --------------------------------------------------------------- cases

test('NEGATIVE CONTROL: with no existing socket, one is opened', async () => {
    const { self, opened } = makeController(null);
    await self.connectWebSocket();
    assert.equal(opened.length, 1,
        'the control is blind: connectWebSocket must open a socket in the '
        + 'ordinary case, or every assertion below is measuring a method '
        + 'that does nothing');
    assert.equal(self.ws, opened[0], 'and it must be the one held');
    assert.equal(self.handlersInstalled, 1, 'with its handlers installed');
});

test('an OPEN socket is left alone and no second socket is opened', async () => {
    const existing = fakeSocket(OPEN);
    const { self, opened } = makeController(existing);
    await self.connectWebSocket();
    assert.equal(opened.length, 0, 'the existing connection is reused');
    assert.equal(existing.closed, 0,
        'a healthy OPEN socket must never be closed by a connect attempt');
    assert.equal(self.ws, existing, 'and it stays on the controller');
});

test('a CONNECTING socket is CLOSED, not silently abandoned', async () => {
    const existing = fakeSocket(CONNECTING);
    const { self, opened } = makeController(existing);
    await self.connectWebSocket();

    assert.equal(existing.closed, 1,
        'THIS IS THE LEAK. An abandoned CONNECTING socket that is never '
        + 'closed stays attached to the pane FIFO forever, because the '
        + 'server does not close on handshake timeout either');
    assert.equal(opened.length, 1, 'and a fresh socket takes its place');
    assert.notEqual(self.ws, existing,
        'the controller must be holding the NEW socket');
});

test('the abandoned socket has its handlers detached BEFORE it is closed', async () => {
    const existing = fakeSocket(CONNECTING);
    const { self } = makeController(existing);
    await self.connectWebSocket();

    assert.ok(existing.handlersAtClose,
        'the socket must actually have been closed for this to mean anything');
    for (const key of ['onopen', 'onmessage', 'onerror', 'onclose']) {
        assert.equal(existing.handlersAtClose[key], null,
            `${key} must already be null at the moment close() is called. A `
            + 'close we asked for is not a disconnection: reaching onclose '
            + 'would paint the disconnect banner and start a reconnect '
            + 'ladder racing the connect happening on the next line');
    }
    void self;
});

test('THE TRAP: a CONNECTING socket does not BLOCK the reconnect', async () => {
    const existing = fakeSocket(CONNECTING);
    const { self, opened } = makeController(existing);
    await self.connectWebSocket();

    assert.equal(opened.length, 1,
        'A fix that merely REFUSED while CONNECTING would pass the leak '
        + 'test above and be worse than the defect: one socket wedged in '
        + 'CONNECTING would block every future reconnect for the life of '
        + 'the page');
    assert.equal(self.handlersInstalled, 1,
        'and the replacement must be wired up, not left inert');
});

test('a CLOSING or CLOSED socket is replaced without a redundant close', async () => {
    for (const state of [CLOSING, CLOSED]) {
        const existing = fakeSocket(state);
        const { self, opened } = makeController(existing);
        await self.connectWebSocket();
        assert.equal(opened.length, 1, `a socket in state ${state} is replaced`);
        assert.equal(existing.closed, 0,
            `a socket already in state ${state} needs no close: it is not `
            + 'holding a server-side viewer open, and closing it twice is '
            + 'noise in the log for no gain');
    }
});

test('the module is actually served, and BEFORE terminal.js', () => {
    // client/ has no build step and no module system, so the script tags
    // in index.html ARE the dependency graph. A module that is never
    // loaded leaves connectWebSocket on its optional-chain fallback,
    // which is the pre-fix overwrite-and-leak behaviour - and every test
    // above would still pass, because they load the file themselves.
    const abandon = INDEX_HTML.indexOf('terminal-socket-abandon.js');
    const terminal = INDEX_HTML.indexOf('/static/js/terminal.js');
    assert.notEqual(abandon, -1,
        'terminal-socket-abandon.js must have a script tag in index.html, '
        + 'or the fix does not ship');
    assert.notEqual(terminal, -1, 'terminal.js must still be served');
    assert.ok(abandon < terminal,
        'it must load BEFORE terminal.js, or connectWebSocket finds nothing '
        + 'on window and silently keeps leaking');
});

// ----------------------------------------------------------------- run

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`not ok - ${name}\n    ${err && err.message}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
