/**
 * client/js/preferences.js - hydration, the revision fold, and the echo.
 *
 * THE TWO CASES ISSUE #44 SAYS TO WRITE FIRST ARE WRITTEN FIRST HERE,
 * because they are the two that silently corrupt a user's settings
 * rather than visibly breaking something:
 *
 *   - applying a received change generates NO outgoing save, or two
 *     browsers ping-pong forever;
 *   - with the read failing, no default is written over a real setting.
 *
 * The API client is a RECORDER, not a mock of fetch: it keeps the exact
 * request bodies the module produced, so "no save was generated" is
 * asserted against what would have gone on the wire rather than against
 * a spy's call count on some internal helper.
 *
 * Run: node --test tests/test_preferences_client.node.mjs
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'client', 'js', 'preferences.js');

/**
 * A recording stand-in for client/js/api.js's `call`.
 *
 * Queue a response (or an Error to throw) per request; every request is
 * kept in `sent`.
 */
function makeApi(responses) {
    const queue = responses.slice();
    const sent = [];
    return {
        sent,
        async call(endpoint, options = {}) {
            sent.push({ endpoint, options });
            const next = queue.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) {
                throw new Error(`no queued response for ${endpoint}`);
            }
            return next;
        },
    };
}

/** A 409 shaped exactly the way client/js/api.js throws one. */
function staleError(revision, values) {
    const err = new Error('HTTP 409');
    err.status = 409;
    err.detail = { status: 'stale_revision', revision, values };
    return err;
}

function loadModule() {
    delete require.cache[require.resolve(MODULE_PATH)];
    delete globalThis.Preferences;
    const mod = require(MODULE_PATH);
    mod.reset();
    return mod;
}

const block = (revision, values) => ({
    status: 'unchanged', schema_version: 1, revision, values,
});

// ---------------------------------------------------------------------
// CASE 7: applying a received change generates NO outgoing save.
// ---------------------------------------------------------------------

test('applying a received change generates no outgoing save', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, { theme: 'claude' })]);
    await prefs.hydrate(api);

    // A control that naively re-saves whatever it is handed. This is the
    // exact shape that ping-pongs between two browsers.
    prefs.subscribe((name, value) => { prefs.set(name, value, api); });

    const applied = prefs.applyRemote({
        type: 'preferences.changed',
        revision: 2,
        changed: { theme: 'matrix' },
        origin_client_id: 'some-other-browser',
    });

    assert.equal(applied, true);
    assert.equal(prefs.get('theme'), 'matrix');
    assert.equal(api.sent.length, 1,
        'a received change produced an outgoing request; two clients would echo forever');
    assert.equal(api.sent[0].options.method, undefined, 'the only request was the hydrate GET');
});

test('a browser ignores the event raised by its own write', async () => {
    const prefs = loadModule();
    const api = makeApi([block(0, {})]);
    await prefs.hydrate(api);

    const applied = prefs.applyRemote({
        revision: 9,
        changed: { theme: 'matrix' },
        origin_client_id: prefs.clientId,
    });

    assert.equal(applied, false);
    assert.equal(prefs.revision(), 0);
});

// ---------------------------------------------------------------------
// CASE 8: with the read failing, no default is written.
// ---------------------------------------------------------------------

test('with the read failing, no write is ever sent', async () => {
    const prefs = loadModule();
    const api = makeApi([new Error('network down')]);

    const status = await prefs.hydrate(api);
    assert.equal(status, prefs.READ_FAILED);

    const result = await prefs.set('theme', 'matrix', api);

    assert.equal(result.status, 'refused');
    assert.equal(api.sent.length, 1,
        'a failed read was followed by a write; that saves a default over a real setting');
});

test('a write before hydration has run at all is refused', async () => {
    const prefs = loadModule();
    const api = makeApi([]);

    const result = await prefs.set('theme', 'matrix', api);

    assert.equal(result.status, 'refused');
    assert.equal(api.sent.length, 0);
});

test('a failed read reports no value, so a control keeps its own default', async () => {
    const prefs = loadModule();
    const api = makeApi([new Error('network down')]);
    await prefs.hydrate(api);

    assert.equal(prefs.get('sidebar_density', 'cozy'), 'cozy');
    assert.equal(prefs.get('theme'), undefined);
});

// ---------------------------------------------------------------------
// The revision fold: duplicate, reorder, drop.
// ---------------------------------------------------------------------

test('the same event twice applies once', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    const frame = { revision: 2, changed: { theme: 'matrix' } };
    assert.equal(prefs.applyRemote(frame), true);
    assert.equal(prefs.applyRemote(frame), false, 'a duplicate frame was applied twice');
    assert.equal(prefs.revision(), 2);
});

test('an out of order event is ignored rather than reverting a newer one', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    prefs.applyRemote({ revision: 3, changed: { theme: 'matrix' } });
    const older = prefs.applyRemote({ revision: 2, changed: { theme: 'claude' } });

    assert.equal(older, false);
    assert.equal(prefs.get('theme'), 'matrix', 'a reordered frame reverted a newer value');
    assert.equal(prefs.revision(), 3);
});

test('a dropped event is closed by the next higher one', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    // Revision 2 never arrives. Revision 3 carries its own full field.
    prefs.applyRemote({ revision: 3, changed: { sidebar_density: 'compact' } });

    assert.equal(prefs.get('sidebar_density'), 'compact');
    assert.equal(prefs.revision(), 3);
});

test('a null in a received change unsets the field', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, { theme: 'matrix' })]);
    await prefs.hydrate(api);

    prefs.applyRemote({ revision: 2, changed: { theme: null } });

    assert.equal(prefs.get('theme', 'claude'), 'claude');
});

test('a frame with no usable revision is ignored', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    assert.equal(prefs.applyRemote({ changed: { theme: 'matrix' } }), false);
    assert.equal(prefs.applyRemote({ revision: 'two', changed: { theme: 'x' } }), false);
    assert.equal(prefs.applyRemote(null), false);
    assert.equal(prefs.get('theme'), undefined);
});

// ---------------------------------------------------------------------
// Pending, committed, failed, conflict.
// ---------------------------------------------------------------------

test('a deliberate choice applies locally and reports itself pending', async () => {
    const prefs = loadModule();
    let resolveSave;
    const api = {
        sent: [],
        async call(endpoint, options = {}) {
            api.sent.push({ endpoint, options });
            if (!options.method) return block(1, {});
            return await new Promise((resolve) => { resolveSave = resolve; });
        },
    };
    await prefs.hydrate(api);

    const saving = prefs.set('sidebar_density', 'compact', api);

    // Immediate feedback, and the save is visibly in flight.
    assert.equal(prefs.get('sidebar_density'), 'compact');
    assert.equal(prefs.stateFor('sidebar_density'), prefs.PENDING);

    resolveSave({ status: 'committed', revision: 2, values: { sidebar_density: 'compact' } });
    await saving;

    assert.equal(prefs.stateFor('sidebar_density'), prefs.COMMITTED);
    assert.equal(prefs.revision(), 2);
});

test('the patch carries only the changed field and the held revision', async () => {
    const prefs = loadModule();
    const api = makeApi([
        block(4, { theme: 'claude', sidebar_density: 'cozy' }),
        { status: 'committed', revision: 5, values: { theme: 'claude', sidebar_density: 'compact' } },
    ]);
    await prefs.hydrate(api);

    await prefs.set('sidebar_density', 'compact', api);

    const body = api.sent[1].options.body;
    assert.deepEqual(body.changes, { sidebar_density: 'compact' },
        'the whole view was sent; that overwrites fields the user never displayed');
    assert.equal(body.expected_revision, 4);
    assert.equal(body.client_id, prefs.clientId);
});

test('a failed save keeps the users value visible and offers a retry', async () => {
    const prefs = loadModule();
    const api = makeApi([
        block(1, { theme: 'claude' }),
        new Error('network down'),
        { status: 'committed', revision: 2, values: { theme: 'matrix' } },
    ]);
    await prefs.hydrate(api);

    const failed = await prefs.set('theme', 'matrix', api);

    assert.equal(failed.status, 'failed');
    assert.equal(prefs.stateFor('theme'), prefs.FAILED);
    assert.equal(prefs.get('theme'), 'matrix', 'the users choice vanished from the control');
    assert.equal(prefs.committedValue('theme'), 'claude',
        'the committed setting is still readable beside the unsaved one');

    const retried = await prefs.retry('theme', api);
    assert.equal(retried.status, 'committed');
    assert.equal(prefs.stateFor('theme'), prefs.COMMITTED);
});

test('a stale revision refusal keeps both values and does not retry blindly', async () => {
    const prefs = loadModule();
    const api = makeApi([
        block(1, { theme: 'claude' }),
        staleError(7, { theme: 'set-by-another-device' }),
    ]);
    await prefs.hydrate(api);

    const result = await prefs.set('theme', 'matrix', api);

    assert.equal(result.status, 'stale_revision');
    assert.equal(api.sent.length, 2, 'the module retried a conflict on its own');
    assert.equal(prefs.stateFor('theme'), prefs.CONFLICT);
    // NEITHER SIDE IS DROPPED. The user resolves it.
    assert.equal(prefs.get('theme'), 'matrix');
    assert.equal(prefs.committedValue('theme'), 'set-by-another-device');
    // Server state was adopted, so the next attempt races against a real
    // number rather than the stale one.
    assert.equal(prefs.revision(), 7);
});

test('discarding a local edit leaves the committed value', async () => {
    const prefs = loadModule();
    const api = makeApi([
        block(1, { theme: 'claude' }),
        staleError(7, { theme: 'set-by-another-device' }),
    ]);
    await prefs.hydrate(api);
    await prefs.set('theme', 'matrix', api);

    prefs.discardLocal('theme');

    assert.equal(prefs.stateFor('theme'), prefs.COMMITTED);
    assert.equal(prefs.get('theme'), 'set-by-another-device');
});

test('a received change for a field with an unsaved edit becomes a conflict', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, { theme: 'claude' }), new Error('network down')]);
    await prefs.hydrate(api);
    await prefs.set('theme', 'matrix', api);
    assert.equal(prefs.stateFor('theme'), prefs.FAILED);

    prefs.applyRemote({ revision: 2, changed: { theme: 'from-another-device' } });

    assert.equal(prefs.stateFor('theme'), prefs.CONFLICT);
    assert.equal(prefs.get('theme'), 'matrix');
    assert.equal(prefs.committedValue('theme'), 'from-another-device');
});

// ---------------------------------------------------------------------
// Hydration and reconnect.
// ---------------------------------------------------------------------

test('server values win on a refresh', async () => {
    const prefs = loadModule();
    const api = makeApi([
        block(1, { theme: 'claude' }),
        block(5, { theme: 'matrix', sidebar_density: 'compact' }),
    ]);
    await prefs.hydrate(api);
    await prefs.hydrate(api);

    assert.equal(prefs.get('theme'), 'matrix');
    assert.equal(prefs.get('sidebar_density'), 'compact');
    assert.equal(prefs.revision(), 5);
});

test('a refresh never uploads this browsers state', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, { theme: 'claude' }), block(2, { theme: 'matrix' })]);
    await prefs.hydrate(api);
    await prefs.hydrate(api);

    const writes = api.sent.filter((entry) => entry.options.method);
    assert.equal(writes.length, 0,
        'a reconnect uploaded an old whole-browser snapshot');
});

test('a read is answered from memory and never fetches', async () => {
    const prefs = loadModule();
    const api = makeApi([block(3, { theme: 'matrix' })]);
    await prefs.hydrate(api);

    for (let i = 0; i < 100; i += 1) prefs.get('theme');

    assert.equal(api.sent.length, 1);
});

test('a listener that throws does not stop the others being told', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    const seen = [];
    prefs.subscribe(() => { throw new Error('this control is broken'); });
    prefs.subscribe((name, value) => { seen.push([name, value]); });

    prefs.applyRemote({ revision: 2, changed: { theme: 'matrix' } });

    assert.deepEqual(seen, [['theme', 'matrix']]);
});

test('unsubscribing stops the listener', async () => {
    const prefs = loadModule();
    const api = makeApi([block(1, {})]);
    await prefs.hydrate(api);

    let calls = 0;
    const off = prefs.subscribe(() => { calls += 1; });
    prefs.applyRemote({ revision: 2, changed: { theme: 'a' } });
    off();
    prefs.applyRemote({ revision: 3, changed: { theme: 'b' } });

    assert.equal(calls, 1);
});
