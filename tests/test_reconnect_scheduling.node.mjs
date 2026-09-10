// The reconnect ladder: one writer for the retry budget, and a named
// initialization success.
// ----------------------------------------------------------------------
// THE LADDER NEVER RECONNECTED, and that was MEASURED against the shipped
// class before a line was changed. attemptReconnect() set
// isReconnecting = true and scheduled connectWebSocket(), whose first
// line was:
//
//     if (this.isReconnecting) { this.stopReconnecting(); return; }
//
// so the retry it had just fired hit that guard, RETURNED without opening
// anything, and stopReconnecting() put the budget back to zero on its way
// out. One timer, ZERO sockets, budget 0, and the only thing the user
// ever saw was "reconnecting, attempt 1 of 5" followed by silence - not
// even the failure message, because attemptReconnect() was never
// re-entered. Present since the initial commit.
//
// THE FIRST CASE REPRODUCES THE PRE-FIX RULE INLINE, so this file fails
// if the old behaviour comes back, rather than only checking that some
// keyword argument exists.
//
// THE FOUR CASES THE ISSUE NAMES, because each is a different bug:
//   1. five genuine failures produce exactly five attempts and ONE message
//   2. an attempt with an UNKNOWN outcome does not decrement the budget
//   3. a successful init resets the budget, and nothing else does
//   4. a reconnect scheduled for A does not fire after navigating to B
//
// Case 2 is the one that failed before and the one a mock will happily
// fake, so it is driven through the real close-and-reschedule cycle
// rather than by calling the predicate directly.
//
// Run with: node --test tests/test_reconnect_scheduling.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const realSetTimeout = setTimeout;
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NAVGEN_SRC = read('client/js/navigation-generation.js');
const POLICY_SRC = read('client/js/terminal-reconnect-policy.js');
const ABANDON_SRC = read('client/js/terminal-socket-abandon.js');
const TERM_SRC = read('client/js/terminal.js');
const INDEX_HTML = read('client/index.html');
const TERM_SINGLETON = 'window.TerminalController = new Terminal();';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Description: a controller carrying exactly what the reconnect path
 *   reads, with the timers under the TEST's control so a ladder can be
 *   driven to exhaustion without waiting 31 real seconds for it.
 * Inputs: none.
 * Output: {self, sandbox, timers, opened, NG, sockets}.
 */
function makeController() {
    const timers = [];
    const sandbox = {
        window: {},
        document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        // THE BACKOFF IS QUEUED, THE SHORT INTERNAL WAITS ARE NOT.
        // connectWebSocket() awaits a real 50ms settle between its two
        // fit attempts; queueing that would suspend the method before it
        // ever reached openWebSocket() and every case here would be
        // measuring the harness. The reconnect backoff starts at 1000ms
        // and only grows, so the split is unambiguous.
        setTimeout: (fn, ms) => {
            if (ms < 100) return realSetTimeout(fn, 0);
            timers.push({ fn, ms });
            return timers.length;
        },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
        Promise, TextEncoder,
        requestAnimationFrame: (fn) => { fn(); return 1; },
        WebSocket: { CONNECTING, OPEN, CLOSING: 2, CLOSED },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.WebSocket = sandbox.WebSocket;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });
    vm.runInContext(POLICY_SRC, sandbox, { filename: 'terminal-reconnect-policy.js' });
    vm.runInContext(ABANDON_SRC, sandbox, { filename: 'terminal-socket-abandon.js' });
    if (!sandbox.window.TerminalReconnectPolicy) {
        throw new Error('terminal-reconnect-policy.js did not export itself');
    }

    const opened = [];
    sandbox.window.API = {
        getWebSocketURL: () => 'ws://test/ws',
        openWebSocket: () => {
            const s = { readyState: CONNECTING, close() { this.readyState = CLOSED; } };
            opened.push(s);
            return s;
        },
    };

    const cut = TERM_SRC.indexOf(TERM_SINGLETON);
    if (cut === -1) throw new Error('terminal.js no longer ends with its singleton line');
    vm.runInContext(
        TERM_SRC.slice(0, cut) + '\nwindow.__TerminalClass = Terminal;',
        sandbox, { filename: 'terminal.js' });
    const P = sandbox.window.__TerminalClass.prototype;
    for (const name of ['attemptReconnect', 'stopReconnecting', 'connectWebSocket',
                        '_resetRetryBudget', '_noteInitializationSuccess',
                        '_measuredInitOutcome', '_scheduleRecovery']) {
        if (typeof P[name] !== 'function') throw new Error(`terminal.js has no ${name}()`);
    }

    const self = {
        sessionActive: true,
        isReconnecting: false,
        reconnectAttempts: 0,
        _attemptsSinceProgress: 0,
        maxReconnectAttempts: 5,
        reconnectTimeout: null,
        ws: null,
        term: { cols: 80, rows: 24 },
        fitAddon: { fit() {} },
        _currentSession: { id: 'ses_a' },
        _navToken: null,
        _socketEverOpened: false,
        _bytesEverSeen: false,
        _initOutcome: 'unknown',
        _unreachableReported: false,
        _restartWatchActive: false,
        _reconnectByNameAttempted: false,
        pills: [],
        statuses: [],
        handlersInstalled: 0,
        updateStatus(s) { this.statuses.push(s); },
        _showStatusPill(m) { this.pills.push(m); },
        waitForFontsAndLayout: () => Promise.resolve(),
        setupWebSocketHandlers() { this.handlersInstalled += 1; },
        attemptReconnect: P.attemptReconnect,
        stopReconnecting: P.stopReconnecting,
        connectWebSocket: P.connectWebSocket,
        _resetRetryBudget: P._resetRetryBudget,
        _noteInitializationSuccess: P._noteInitializationSuccess,
        _measuredInitOutcome: P._measuredInitOutcome,
        _scheduleRecovery: P._scheduleRecovery,
        _navCurrent: P._navCurrent,
        _sessionId: P._sessionId,
        _unwrapSession: P._unwrapSession,
        _currentTmuxName: () => 'cloude_a',
        _handleAuthFailedClose() { this.authRefreshes = (this.authRefreshes || 0) + 1; },
        _attemptReconnectByName() { this.byName = (this.byName || 0) + 1; },
        _handlePossibleOutage() { this.outages = (this.outages || 0) + 1; },
    };
    return { self, sandbox, timers, opened, NG: sandbox.window.NavigationGeneration };
}

/**
 * Description: run every pending, uncancelled timer once, oldest first.
 * Inputs: timers (array). Output: Promise<number> - how many ran.
 */
async function runTimers(timers) {
    let ran = 0;
    const pending = timers.splice(0, timers.length);
    for (const t of pending) {
        if (t.cancelled) continue;
        await t.fn();
        ran += 1;
    }
    // THE CALLBACK RETURNS BEFORE connectWebSocket() FINISHES. The
    // scheduler's timer body is not async, so awaiting it resolves while
    // the connect is still parked on its own internal 50ms settle - and
    // a case that read `opened.length` right then would be measuring the
    // harness rather than the ladder. One real macrotask is what that
    // settle costs; twenty milliseconds is comfortably past it.
    await new Promise((r) => realSetTimeout(r, 20));
    return ran;
}

// ---------------------------------------------------- the regression

test('THE PRE-FIX RULE: a scheduled retry must actually open a socket', async () => {
    const { self, timers, opened } = makeController();
    self.attemptReconnect();
    assert.equal(timers.length, 1, 'the ladder must schedule an attempt');
    await runTimers(timers);
    assert.equal(opened.length, 1,
        'the scheduled retry opened ZERO sockets before this fix: '
        + 'connectWebSocket() saw isReconnecting, called stopReconnecting() '
        + 'and RETURNED, so the ladder ran one timer and went silent');
    assert.equal(self.handlersInstalled, 1, 'with its handlers installed');
});

test('and the retry does not wipe the budget on its way in', async () => {
    const { self, timers } = makeController();
    self.attemptReconnect();
    assert.equal(self.reconnectAttempts, 1);
    await runTimers(timers);
    assert.equal(self.reconnectAttempts, 1,
        'stopReconnecting() used to zero the budget from inside the retry, '
        + 'which is how a ceiling becomes unreachable');
});

// ----------------------------------------------- case 1: five failures

test('five genuine failures produce exactly five attempts and ONE message', async () => {
    const { self, timers, opened } = makeController();
    // A genuine failure: the socket never opens. `_socketEverOpened`
    // stays false, which is what "the server did not answer" looks like.
    for (let i = 0; i < 10; i += 1) {
        self.attemptReconnect();
        await runTimers(timers);
        self._socketEverOpened = false;
        self._bytesEverSeen = false;
        self.isReconnecting = false;
    }
    assert.equal(opened.length, 5,
        `five attempts against the ceiling, got ${opened.length}`);
    const failures = self.pills.filter((p) => /reconnection failed after/.test(p));
    assert.equal(failures.length, 1,
        'the unreachable message is said ONCE and stays said - it used to '
        + 'reset the budget on its way out and hand over five more attempts');
});

test('the failure message survives further closes, it does not repeat', async () => {
    const { self, timers } = makeController();
    for (let i = 0; i < 20; i += 1) {
        self.attemptReconnect();
        await runTimers(timers);
        self.isReconnecting = false;
    }
    assert.equal(self.pills.filter((p) => /reconnection failed/.test(p)).length, 1);
});

// ---------------------------------------------- case 2: unknown outcome

test('THE CASE THAT FAILED: an attempt whose outcome is UNKNOWN costs nothing', async () => {
    const { self, timers, opened } = makeController();
    // The socket opens - the server answered - and then it closes with
    // the pane having said nothing. That is not evidence of failure: a
    // slow machine, or a pane parked on its folder-trust dialog, looks
    // exactly like this and is perfectly healthy.
    for (let i = 0; i < 12; i += 1) {
        self._socketEverOpened = true;
        self._bytesEverSeen = false;
        self.attemptReconnect();
        await runTimers(timers);
        self.isReconnecting = false;
    }
    assert.equal(self.reconnectAttempts, 0,
        'an unknown outcome must not spend the budget, or a slow machine '
        + 'gets a healthy session declared unreachable');
    assert.equal(self.pills.filter((p) => /reconnection failed/.test(p)).length, 0,
        'and the user is never told it is unreachable on that evidence');
    assert.ok(opened.length >= 10, 'while still actually retrying');
});

test('a pane sitting on its startup prompt is a CONNECTED session, not a failed attempt', () => {
    const { self } = makeController();
    self._currentSession = { id: 'ses_a', startup_gate: 'awaiting_startup_prompt' };
    self._socketEverOpened = true;
    self._bytesEverSeen = false;
    assert.equal(self._measuredInitOutcome(), 'awaiting_startup_prompt',
        'the server already models this and the client reuses its word');
});

test('the backoff still grows even when the budget does not', async () => {
    const { self, timers, sandbox } = makeController();
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
        self._socketEverOpened = true;   // unknown outcome, costs nothing
        self.attemptReconnect();
        seen.push(timers[timers.length - 1].ms);
        await runTimers(timers);
        self.isReconnecting = false;
    }
    const P = sandbox.window.TerminalReconnectPolicy;
    assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 16000],
        'an unknown outcome must be a slow poll, not a spin - the delay is '
        + 'the only thing bounding it');
    assert.equal(seen[seen.length - 1], P.BACKOFF_CEILING_MS);
});

// ----------------------------------------- case 3: one writer, one reset

test('initialization success is the first BYTES, not the socket opening', () => {
    const { self } = makeController();
    self._socketEverOpened = true;
    assert.equal(self._measuredInitOutcome(), 'unknown',
        'a socket that opens proves the SERVER answered and says nothing '
        + 'about whether the pane is talking');
    self._bytesEverSeen = true;
    assert.equal(self._measuredInitOutcome(), 'ready');
});

test('a successful init resets the budget, and nothing else does', async () => {
    const { self, timers } = makeController();
    for (let i = 0; i < 3; i += 1) {
        self.attemptReconnect();
        await runTimers(timers);
        self.isReconnecting = false;
    }
    assert.equal(self.reconnectAttempts, 3);
    // stopReconnecting must NOT clear it: it is called from the
    // exhaustion branch itself, so a reset there is what made the ceiling
    // unreachable.
    self.stopReconnecting();
    assert.equal(self.reconnectAttempts, 3,
        'stopReconnecting() must leave the budget alone');
    self._noteInitializationSuccess();
    assert.equal(self.reconnectAttempts, 0);
    assert.equal(self._attemptsSinceProgress, 0, 'and the backoff with it');
});

test('exactly one method assigns zero to the budget', () => {
    // Four writers is the defect this issue names. The constructor's
    // initialiser and _resetRetryBudget's assignment are the only two
    // occurrences, and only the second is a reset.
    const zeroes = (TERM_SRC.match(/this\.reconnectAttempts = 0/g) || []).length;
    assert.equal(zeroes, 2, `reconnectAttempts is zeroed in ${zeroes} places`);
    const reset = TERM_SRC.slice(TERM_SRC.indexOf('    _resetRetryBudget(reason) {'));
    assert.match(reset.slice(0, 400), /this\.reconnectAttempts = 0/,
        'and the second one is inside _resetRetryBudget');
    const stop = TERM_SRC.slice(TERM_SRC.indexOf('    stopReconnecting() {'));
    assert.ok(!/reconnectAttempts/.test(stop.slice(0, 300)),
        'stopReconnecting() must not touch the budget');
});

// ------------------------------------------ case 4: the navigation token

test('a reconnect scheduled for A does not fire after navigating to B', async () => {
    const { self, timers, opened, NG } = makeController();
    self._navToken = NG.begin('session:a');
    self.attemptReconnect();
    assert.equal(timers.length, 1);
    // The delay reaches sixteen seconds. The user moves on.
    NG.begin('session:b');
    await runTimers(timers);
    assert.equal(opened.length, 0,
        'a retry that fired anyway would open a socket for a session '
        + 'nobody is looking at');
    assert.equal(self.isReconnecting, false, 'and the ladder stands down');
});

test('POSITIVE CONTROL: the same reconnect DOES fire while its navigation stands', async () => {
    const { self, timers, opened, NG } = makeController();
    self._navToken = NG.begin('session:a');
    self.attemptReconnect();
    await runTimers(timers);
    assert.equal(opened.length, 1,
        'a guard that refused everything would pass the case above and '
        + 'break reconnect entirely');
});

// -------------------------------------- the named recovery branches

test('each close code selects its own named recovery, and the conditions are stated', () => {
    const { sandbox } = makeController();
    const P = sandbox.window.TerminalReconnectPolicy;
    const R = P.RECOVERY;
    assert.equal(P.recoveryFor({ code: 4401 }), R.AUTH);
    assert.equal(P.recoveryFor({ code: 4404 }), R.BY_NAME);
    assert.equal(P.recoveryFor({ code: 4404, byNameAlreadyTried: true }), R.RETRY,
        'one re-resolve per disconnect episode - a second is the same '
        + 'lookup twice');
    assert.equal(P.recoveryFor({ code: 1006, outageCodeKnown: true }), R.OUTAGE);
    assert.equal(P.recoveryFor({ code: 1006, outageCodeKnown: false }), R.RETRY,
        'a missing ServerRestartWatch degrades to the plain retry rather '
        + 'than throwing inside onclose');
    assert.equal(P.recoveryFor({ code: 1000, intentional: true }), R.NONE);
});

test('the scheduler runs the branch the policy picked, and only one of them', () => {
    for (const [code, field] of [[4401, 'authRefreshes'], [4404, 'byName']]) {
        const { self } = makeController();
        self._scheduleRecovery(code);
        assert.equal(self[field], 1, `close ${code} must reach its own branch`);
        assert.equal(self.reconnectAttempts, 0,
            'and must NOT also spend a plain retry');
    }
    const { self, timers } = makeController();
    self._scheduleRecovery(1006);
    assert.equal(timers.length, 1, 'an unrecognised close falls through to the retry');
});

test('a second 4404 in one episode falls through to the plain retry', () => {
    const { self, timers } = makeController();
    self._scheduleRecovery(4404);
    assert.equal(self.byName, 1);
    self.isReconnecting = false;
    self._scheduleRecovery(4404);
    assert.equal(self.byName, 1, 'still one - the guard is per episode');
    assert.equal(timers.length, 1, 'and the second went to the retry ladder');
});

test('index.html serves the policy module before terminal.js', () => {
    const order = [...INDEX_HTML.matchAll(/\/static\/js\/([A-Za-z0-9._\-/]+\.js)/g)]
        .map((m) => m[1]);
    assert.ok(order.indexOf('terminal-reconnect-policy.js') >= 0);
    assert.ok(order.indexOf('terminal-reconnect-policy.js') < order.indexOf('terminal.js'));
});
