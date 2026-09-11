/**
 * client/js/settings-import-collect.js - what a browser is allowed to offer.
 *
 * THE SECRET-LEAK CASE IS FIRST AND IT IS MEASURED TWO WAYS, because
 * issue #46 asks for it to be asserted "against the actual outgoing
 * request body, not against the code":
 *
 *   1. A RECORDING STORAGE. Every getItem the collector performs is
 *      recorded, so the test can assert the two auth tokens were never
 *      even READ. That is stronger than checking they are absent from
 *      the output: a collector that read a token and then dropped it
 *      would pass an output check and still have had it in memory.
 *   2. THE PAYLOAD ITSELF, serialised, searched for the token VALUE. A
 *      key renamed or nested somewhere unexpected still fails this.
 *
 * A DENYLIST WOULD PASS NEITHER OF THESE FOR A SECRET NOBODY THOUGHT OF,
 * which is the whole reason the collector is an allowlist of literals.
 * The third test proves that property directly: an unknown key sitting
 * in storage is never read.
 *
 * Run: node --test tests/test_settings_import_collect.node.mjs
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'client', 'js', 'settings-import-collect.js');

const TOKEN = 'tok_this_must_never_travel_0123456789';

/** A storage double that records every key the collector asks for. */
function makeStorage(entries) {
    const asked = [];
    return {
        asked,
        getItem(key) {
            asked.push(key);
            return Object.prototype.hasOwnProperty.call(entries, key)
                ? entries[key] : null;
        },
        setItem() { throw new Error('the collector must never write'); },
        removeItem() { throw new Error('the collector must never remove'); },
        // Present on purpose: a collector that iterated storage would
        // reach for these, and reaching for them fails the test.
        get length() { throw new Error('the collector must never enumerate storage'); },
        key() { throw new Error('the collector must never enumerate storage'); },
    };
}

function loadModule() {
    delete require.cache[require.resolve(MODULE_PATH)];
    delete globalThis.SettingsImportCollect;
    return require(MODULE_PATH);
}

function fullBrowser(extra = {}) {
    return Object.assign({
        'cloude.theme': 'matrix',
        'cloude.audio.enabled': 'on',
        'cloude.audio.master': JSON.stringify({ v: 0.8, setUnder: 3 }),
        'cloude_provider_last_model': 'anthropic/claude-3',
        'cloude.session.sidebar.density': 'compact',
        'cloude.session.sidebar.arrangement': JSON.stringify({
            v: 1, pinned: ['a'], order: ['a', 'b'], collapsed: ['pinned'],
        }),
        'cloude.session.sidebar.pinned': '1',
        'cloude.configEditor.pinned': '0',
        'cloude.configEditor.collapsed': JSON.stringify({ 'user:__root__': true }),
        'cloude.launchpad.collapsed': JSON.stringify({ 'recent-sessions': true }),
    }, extra);
}

// ---------------------------------------------------------------------
// Secrets, three ways.
// ---------------------------------------------------------------------

test('NEGATIVE CONTROL: neither auth token is ever read', () => {
    const mod = loadModule();
    const storage = makeStorage(fullBrowser({
        claude_tunnel_token: TOKEN,
        claude_refresh_token: TOKEN,
    }));
    mod.collect(storage);
    assert.ok(!storage.asked.includes('claude_tunnel_token'),
        'the collector read the tunnel token out of storage');
    assert.ok(!storage.asked.includes('claude_refresh_token'),
        'the collector read the refresh token out of storage');
});

test('NEGATIVE CONTROL: the token value never appears in the payload', () => {
    const mod = loadModule();
    const payload = mod.collect(makeStorage(fullBrowser({
        claude_tunnel_token: TOKEN,
        claude_refresh_token: TOKEN,
    })));
    const body = JSON.stringify({ candidates: payload, selections: [] });
    assert.ok(!body.includes(TOKEN), 'a token value reached the request body');
    assert.ok(!body.includes('claude_tunnel_token'));
    assert.ok(!body.includes('claude_refresh_token'));
});

test('NEGATIVE CONTROL: an unknown key in storage is never read at all', () => {
    // This is the property a denylist cannot have. The next secret
    // somebody adds is safe here because the collector does not look.
    const mod = loadModule();
    const storage = makeStorage(fullBrowser({
        some_future_secret_nobody_listed: TOKEN,
    }));
    mod.collect(storage);
    assert.ok(!storage.asked.includes('some_future_secret_nobody_listed'));
    assert.deepEqual(
        storage.asked.filter((k) => !mod.readableKeys().includes(k)), [],
        'the collector read a key outside its own allowlist');
});

test('NEGATIVE CONTROL: the theme script approval is never collected', () => {
    // Never infer, and never carry, a theme script approval. The local
    // record names a theme and no digest, so importing it would mint the
    // unbounded standing grant the consent model exists to prevent.
    const mod = loadModule();
    const storage = makeStorage(fullBrowser({
        'cloude.themeJsAllowlist': JSON.stringify({ matrix: true }),
    }));
    const payload = mod.collect(storage);
    assert.ok(!storage.asked.includes('cloude.themeJsAllowlist'));
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'theme_script_consent'));
    assert.ok(!mod.readableKeys().includes('cloude.themeJsAllowlist'));
});

test('NEGATIVE CONTROL: importing a theme choice carries the choice alone', () => {
    const mod = loadModule();
    const payload = mod.collect(makeStorage({
        'cloude.theme': 'matrix',
        'cloude.themeJsAllowlist': JSON.stringify({ matrix: true }),
    }));
    assert.deepEqual(payload, { theme: 'matrix' });
});

test('the paint cache and the local migration bookkeeping are not settings', () => {
    const mod = loadModule();
    const keys = mod.readableKeys();
    assert.ok(!keys.includes('cloude.theme.vars'));
    assert.ok(!keys.includes('cloude.audio.settingsVersion'));
    assert.ok(!keys.includes('cloude.audio.muted'),
        'a retired key a migration exists to erase would be resurrected');
});

// ---------------------------------------------------------------------
// What it does collect.
// ---------------------------------------------------------------------

test('a full browser translates into the typed preference shapes', () => {
    const mod = loadModule();
    const payload = mod.collect(makeStorage(fullBrowser()));
    assert.deepEqual(payload, {
        theme: 'matrix',
        audio_enabled: true,
        audio_master_volume: 0.8,
        launch_last_model: 'anthropic/claude-3',
        sidebar_density: 'compact',
        sidebar_arrangement: {
            v: 1, pinned: ['a'], order: ['a', 'b'], collapsed: ['pinned'],
        },
        sidebar_pinned: true,
        config_editor_pinned: false,
        config_editor_collapsed: { 'user:__root__': true },
        launchpad_collapsed: { 'recent-sessions': true },
    });
});

test('an empty browser offers nothing rather than a snapshot of defaults', () => {
    // A default offered as a value is how an import overwrites a real
    // setting on another device with nothing.
    const mod = loadModule();
    assert.deepEqual(mod.collect(makeStorage({})), {});
});

test('an unreadable or nonsense value is omitted, not guessed at', () => {
    const mod = loadModule();
    const payload = mod.collect(makeStorage({
        'cloude.theme': 'matrix',
        'cloude.audio.enabled': 'maybe',
        'cloude.session.sidebar.density': 'enormous',
        'cloude.session.sidebar.arrangement': 'not json',
        'cloude_provider_last_model': '--injected-flag',
    }));
    assert.deepEqual(payload, { theme: 'matrix' });
});

test('the empty model id is a real choice and is offered', () => {
    const mod = loadModule();
    const payload = mod.collect(makeStorage({ 'cloude_provider_last_model': '' }));
    assert.deepEqual(payload, { launch_last_model: '' });
});

test('the master volume prefers the current key and falls back to the legacy one', () => {
    const mod = loadModule();
    assert.equal(
        mod.collect(makeStorage({
            'cloude.audio.master': JSON.stringify({ v: 0.9 }),
            'cloude.audio.volume': '0.4',
        })).audio_master_volume, 0.9);
    assert.equal(
        mod.collect(makeStorage({ 'cloude.audio.volume': '0.6' })).audio_master_volume,
        0.6);
});

test('a pre-v2 inaudible gain heals to the floor rather than importing silence', () => {
    const mod = loadModule();
    assert.equal(
        mod.collect(makeStorage({ 'cloude.audio.volume': '0.05' })).audio_master_volume,
        0.35);
});

test('the server allowlist narrows what is collected, and the client carries no second copy', () => {
    const mod = loadModule();
    const storage = makeStorage(fullBrowser());
    const payload = mod.collect(storage, ['theme', 'sidebar_density']);
    assert.deepEqual(Object.keys(payload).sort(), ['sidebar_density', 'theme']);
    assert.ok(!storage.asked.includes('cloude.audio.enabled'),
        'a field the server refuses was still read out of this browser');
});
