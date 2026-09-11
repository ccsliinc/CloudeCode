/**
 * client/js/preferences-transport.js, and the two lines terminal.js keeps.
 *
 * The delegation is asserted against terminal.js's real source, not only
 * against the module in isolation: a module that works perfectly and is
 * never called is the failure this file is here to catch. If somebody
 * removes the `preferences.changed` branch or the reconnect refresh from
 * the socket, the module below still passes every one of its own tests.
 *
 * Run: node --test tests/test_preferences_transport.node.mjs
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, '..', 'client', 'js');
const TRANSPORT = path.join(CLIENT, 'preferences-transport.js');
const PREFERENCES = path.join(CLIENT, 'preferences.js');

function load() {
    delete require.cache[require.resolve(TRANSPORT)];
    delete require.cache[require.resolve(PREFERENCES)];
    delete globalThis.Preferences;
    delete globalThis.PreferencesTransport;
    const prefs = require(PREFERENCES);
    prefs.reset();
    return { prefs, transport: require(TRANSPORT) };
}

const block = (revision, values) => ({
    status: 'unchanged', schema_version: 1, revision, values,
});

function makeApi(responses) {
    const queue = responses.slice();
    const sent = [];
    return {
        sent,
        async call(endpoint, options = {}) {
            sent.push({ endpoint, options });
            const next = queue.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error('no queued response');
            return next;
        },
    };
}

test('a preferences.changed frame reaches the fold', async () => {
    const { prefs, transport } = load();
    await prefs.hydrate(makeApi([block(1, { theme: 'claude' })]));

    const applied = transport.handleFrame({
        type: 'preferences.changed',
        revision: 2,
        changed: { theme: 'matrix' },
    });

    assert.equal(applied, true);
    assert.equal(prefs.get('theme'), 'matrix');
});

test('a frame of any other type is ignored', async () => {
    const { prefs, transport } = load();
    await prefs.hydrate(makeApi([block(1, {})]));

    assert.equal(transport.handleFrame({ type: 'toast.new', revision: 9 }), false);
    assert.equal(transport.handleFrame(null), false);
    assert.equal(prefs.revision(), 1);
});

test('the module refuses quietly when preferences did not load', () => {
    delete require.cache[require.resolve(TRANSPORT)];
    delete globalThis.Preferences;
    delete globalThis.PreferencesTransport;
    const transport = require(TRANSPORT);

    // A partial page still has a working terminal. Neither of these may
    // throw into the socket's own handlers.
    assert.equal(transport.handleFrame({ type: 'preferences.changed', revision: 1 }), false);
    assert.doesNotThrow(() => transport.refreshOnReconnect());
});

test('a reconnect re-reads the block and never uploads one', async () => {
    const { prefs, transport } = load();
    const api = makeApi([block(1, { theme: 'claude' }), block(6, { theme: 'matrix' })]);
    await prefs.hydrate(api);

    transport.refreshOnReconnect(api);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prefs.revision(), 6);
    assert.equal(prefs.get('theme'), 'matrix');
    assert.equal(api.sent.filter((entry) => entry.options.method).length, 0,
        'the reconnect uploaded this browsers snapshot instead of reading');
});

test('a failed reconnect refresh does not reject into the socket handler', async () => {
    const { prefs, transport } = load();
    const api = makeApi([block(3, { theme: 'claude' }), new Error('still down')]);
    await prefs.hydrate(api);

    assert.doesNotThrow(() => transport.refreshOnReconnect(api));
    await new Promise((resolve) => setImmediate(resolve));

    // The read failed, so the module now refuses writes rather than
    // carrying on with a value it cannot vouch for.
    assert.equal(prefs.status(), prefs.READ_FAILED);
});

// ---------------------------------------------------------------------
// The delegation. A module nothing calls is the failure this catches.
// ---------------------------------------------------------------------

test('terminal.js dispatches preferences.changed to the transport', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'terminal.js'), 'utf8');

    assert.ok(src.includes("type === 'preferences.changed'"),
        'terminal.js no longer has a preferences.changed branch, so a change '
        + 'committed on another device never reaches this browser');
    assert.ok(src.includes('PreferencesTransport.handleFrame'),
        'the preferences.changed branch does not call the transport module');
});

test('terminal.js refreshes preferences when the socket comes back', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'terminal.js'), 'utf8');

    assert.ok(src.includes('PreferencesTransport.refreshOnReconnect'),
        'nothing re-reads preferences on reconnect. Frames are not replayed, '
        + 'so a change committed while the socket was down would be lost '
        + 'until the next full page load');
});

test('index.html loads both preference modules before terminal.js', () => {
    const html = fs.readFileSync(path.join(here, '..', 'client', 'index.html'), 'utf8');
    const at = (name) => html.indexOf(`/static/js/${name}`);

    assert.ok(at('preferences.js') > 0, 'preferences.js is not loaded');
    assert.ok(at('preferences-transport.js') > 0, 'preferences-transport.js is not loaded');
    assert.ok(at('preferences.js') < at('preferences-transport.js'),
        'the transport loads before the module it delegates to');
    assert.ok(at('preferences-transport.js') < at('terminal.js'),
        'terminal.js loads before the module its socket handlers call');
});
