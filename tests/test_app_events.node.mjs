/**
 * client/js/app-events.js: the browser end of the application event channel.
 *
 * THE TWO CLAIMS WORTH PROVING HERE ARE THE ONES THAT ARE EASY TO GET
 * BACKWARDS. First, that a reconnect performs an AUTHORITATIVE REFRESH
 * rather than trusting what it already holds: nothing replays while the
 * socket is down, so a channel that came back and said nothing would
 * leave the user on state from before the gap. Second, that the OVERFLOW
 * recovery does not back off - being closed at the bound means this
 * client fell behind, not that the server is unwell, and waiting would
 * leave stale rows on screen for no reason.
 *
 * The wiring is asserted against the SHIPPED source of index.html and
 * app.js, not only against the module: a module that works perfectly and
 * is never called is exactly the failure this file exists to catch.
 *
 * Run: node --test tests/test_app_events.node.mjs
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const CLIENT = path.join(ROOT, 'client', 'js');
const MODULE = path.join(CLIENT, 'app-events.js');

function load() {
    delete require.cache[require.resolve(MODULE)];
    delete globalThis.AppEvents;
    delete globalThis.SessionSidebar;
    delete globalThis.Launchpad;
    delete globalThis.PreferencesTransport;
    delete globalThis.ToastManager;
    delete globalThis.API;
    return require(MODULE);
}

function spies() {
    const calls = [];
    globalThis.SessionSidebar = { refreshNow: () => calls.push('sidebar') };
    globalThis.Launchpad = { loadRunningSessions: () => calls.push('launchpad') };
    globalThis.PreferencesTransport = {
        CHANGED: 'preferences.changed',
        refreshOnReconnect: () => calls.push('preferences-refresh'),
        handleFrame: (f) => { calls.push('preferences-frame:' + f.revision); return true; },
    };
    globalThis.ToastManager = {
        add: (t) => calls.push('toast-add:' + t.id),
        dismiss: (id) => calls.push('toast-dismiss:' + id),
    };
    return calls;
}

test('hello triggers an authoritative refresh of everything', () => {
    const events = load();
    const calls = spies();
    assert.equal(events.handleFrame({ type: 'events.hello', client_id: 'evt_1' }), true);
    // Preferences AND the session surfaces: while the socket was down no
    // frame was delivered and nothing replays one, so every reader has to
    // re-read rather than trust what it holds.
    assert.deepEqual(calls, ['preferences-refresh', 'sidebar', 'launchpad']);
});

test('a status notice re-reads rather than patching the row locally', () => {
    const events = load();
    const calls = spies();
    events.handleFrame({
        type: 'session.status', session_id: 'ses_b', activity_status: 'question',
    });
    // Deliberately NOT a local edit of one row. Patching would make this
    // file a second assembler of the session list beside /sessions/list
    // and the two would drift. The notice's value is that it says "now".
    assert.deepEqual(calls, ['sidebar', 'launchpad']);
});

test('a structural notice re-reads the list', () => {
    const events = load();
    const calls = spies();
    events.handleFrame({ type: 'sessions.changed', reason: 'created' });
    assert.deepEqual(calls, ['sidebar', 'launchpad']);
});

test('toast frames go to the module that already owns toast cards', () => {
    const events = load();
    const calls = spies();
    events.handleFrame({ type: 'toast.new', toast: { id: 't1' } });
    events.handleFrame({ type: 'toast.ack', toast_id: 't1' });
    assert.deepEqual(calls, ['toast-add:t1', 'toast-dismiss:t1']);
});

test('a preferences frame goes to the existing transport, not a second copy', () => {
    const events = load();
    const calls = spies();
    events.handleFrame({ type: 'preferences.changed', revision: 7 });
    assert.deepEqual(calls, ['preferences-frame:7']);
});

test('an unknown frame type is ignored and does not force a re-read', () => {
    const events = load();
    const calls = spies();
    assert.equal(events.handleFrame({ type: 'something.newer' }), false);
    // THE NEGATIVE CONTROL. A handler that treated anything it did not
    // recognise as "something changed" would turn a newer server's
    // harmless frame into a refresh storm on an older page.
    assert.deepEqual(calls, []);
});

test('every branch survives the modules it pokes being absent', () => {
    const events = load();
    // No spies installed at all: a page that loaded partially still has a
    // working terminal, and this channel is an optimisation over polls
    // that are all still running.
    assert.doesNotThrow(() => {
        events.handleFrame({ type: 'events.hello' });
        events.handleFrame({ type: 'sessions.changed' });
        events.handleFrame({ type: 'toast.new', toast: { id: 'x' } });
        events.handleFrame({ type: 'toast.ack', toast_id: 'x' });
    });
});

test('an overflow close reconnects at once and any other close backs off', () => {
    const events = load();
    events._state.attempts = 1;
    // Closed at the bound: this client fell behind, the server is fine,
    // and the recovery is meant to be invisible. Waiting would leave the
    // user looking at stale rows for no reason at all.
    assert.equal(events.backoffFor(events.OVERFLOW_CLOSE_CODE), 0);
    // Anything else is a real outage and gets exponential backoff.
    assert.equal(events.backoffFor(1006), 1000);
    events._state.attempts = 3;
    assert.equal(events.backoffFor(1006), 4000);
    events._state.attempts = 99;
    assert.equal(events.backoffFor(1006), 30000);
});

test('the close code matches the server constant exactly', () => {
    const events = load();
    // Read from bounded_stream.py, which is where the number is DECLARED
    // once for both channels - the event hub and the terminal fan-out
    // both import it, so a second literal anywhere is the drift this
    // assertion exists to catch.
    const server = fs.readFileSync(
        path.join(ROOT, 'src', 'core', 'bounded_stream.py'), 'utf8');
    const match = server.match(/^OVERFLOW_CLOSE_CODE\s*=\s*(\d+)/m);
    assert.ok(match, 'server no longer declares OVERFLOW_CLOSE_CODE');
    // Two ends of one wire. If they drift, the client silently stops
    // recognising the one close it is supposed to recover from silently.
    assert.equal(events.OVERFLOW_CLOSE_CODE, Number(match[1]));
});

test('start refuses to open a socket with no credential to present', () => {
    const events = load();
    let opened = 0;
    globalThis.API = {
        getToken: () => null,
        openWebSocket: () => { opened += 1; return {}; },
    };
    events.start();
    assert.equal(opened, 0);
    events.stop();
});

test('start opens the events path through the app API, reusing its auth', () => {
    const events = load();
    const opens = [];
    globalThis.API = {
        getToken: () => 'a-token',
        openWebSocket: (sessionId, urlPath) => {
            opens.push([sessionId, urlPath]);
            return {};
        },
    };
    events.start();
    // ONE auth scheme, not two: API.openWebSocket is what puts the JWT in
    // the Sec-WebSocket-Protocol header, and a token in a URL is what
    // that exists to avoid.
    assert.deepEqual(opens, [[null, '/ws/events']]);
    events.stop();
});

test('the page actually loads and starts the channel', () => {
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
    assert.ok(html.includes('/static/js/app-events.js'),
        'app-events.js is not loaded by index.html');
    // Load order is load bearing: it pokes window.SessionSidebar by name.
    assert.ok(html.indexOf('/static/js/session-sidebar.js')
        < html.indexOf('/static/js/app-events.js'),
        'app-events.js must load after session-sidebar.js');

    const app = fs.readFileSync(path.join(CLIENT, 'app.js'), 'utf8');
    assert.ok(app.includes('AppEvents.start()'),
        'nothing starts the event channel');
    // In _initAuthenticatedState, which is the ONE function both post-auth
    // paths run. Two copies of that sequence is how one of them acquires a
    // step the other never gets.
    const initAt = app.indexOf('async _initAuthenticatedState()');
    const startAt = app.indexOf('AppEvents.start()');
    assert.ok(initAt !== -1 && startAt > initAt && startAt - initAt < 1200,
        'AppEvents.start() is not inside _initAuthenticatedState');
});

test('the sidebar exposes the public refresh the channel pokes', () => {
    const mod = fs.readFileSync(
        path.join(CLIENT, 'session-sidebar-refresh.js'), 'utf8');
    // It must do exactly what a poll tick does, so an event can only make
    // the same refresh happen sooner and can never produce a row the poll
    // would not have produced.
    assert.ok(mod.includes('sidebar.refreshNow = function refreshNow()'));
    assert.ok(mod.includes('this._fetchAndRender()'));
    // AND IT REFUSES WHILE CLOSED. Measured, not theorised: without this
    // guard the hidden sidebar acquires its own copy of every session row
    // while the user is on the launchpad, so two elements carry the same
    // data-session-id and the first one found is the invisible one. That
    // is the same ambiguity scripts/perf/perf_browser.py already warns
    // about, and it broke a real browser test.
    assert.ok(mod.includes('if (!this.isOpen) return;'),
        'refreshNow must not render into a closed sidebar');

    // And the page loads it, after the controller it attaches to.
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
    assert.ok(html.indexOf('/static/js/session-sidebar.js')
        < html.indexOf('/static/js/session-sidebar-refresh.js'));
    assert.ok(html.indexOf('/static/js/session-sidebar-refresh.js')
        < html.indexOf('/static/js/app-events.js'));
});

test('nothing here removed a poll', () => {
    // THE CHANNEL IS AN OPTIMISATION, NEVER A DEPENDENCY. A tmux session
    // started by hand on the cloude socket produces no event at all, so
    // the reconciliation poll is what covers it - and a client whose
    // socket never connects has to converge exactly as it did before.
    const sidebar = fs.readFileSync(path.join(CLIENT, 'session-sidebar.js'), 'utf8');
    assert.ok(/POLL_MS\(\)\s*\{\s*return 5000;/.test(sidebar)
        || sidebar.includes('return 5000;'),
        'the five second reconciliation poll is gone');
    assert.ok(sidebar.includes('_startPoll()'), 'the poll timer is gone');
});
