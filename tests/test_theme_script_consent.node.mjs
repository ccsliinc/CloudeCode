/**
 * client/js/theme-consent.js - the gate in front of a theme's effects.js.
 *
 * THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE AND THEY ARE FIRST.
 * A theme script is executable code, so the only claim worth testing is
 * what the gate REFUSES. A suite that only drove the consented path
 * would pass perfectly against a gate that never refuses anything, which
 * is the same false confidence CLAUDE.md records for the matcher that
 * always finds something.
 *
 * `inject` IS A SPY ON THE REAL EXECUTION PATH, not on a helper. It is
 * the exact callback client/js/themes/registry.js passes in - the one
 * that performs the dynamic import - so "the script did not execute" is
 * asserted against the thing that would have executed it, rather than
 * against some internal flag that happens to correlate with it today.
 *
 * Run: node --test tests/test_theme_script_consent.node.mjs
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(here, '..', 'client', 'js', 'theme-consent.js');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/**
 * A stand-in for client/js/preferences.js holding one field.
 *
 * `hydrated: false` reproduces a browser whose preference read failed,
 * which the gate must treat as "cannot verify" rather than "nothing on
 * record".
 */
function makePreferences({ consent = null, hydrated = true, setResult = null } = {}) {
    const saved = [];
    const listeners = [];
    let held = consent;
    return {
        HYDRATED: 'hydrated',
        saved,
        listeners,
        status() { return hydrated ? 'hydrated' : 'read_failed'; },
        get(name, fallback) {
            if (name !== 'theme_script_consent') return fallback;
            return held === null ? fallback : held;
        },
        async set(name, value) {
            saved.push({ name, value });
            if (setResult) return setResult;
            held = value;
            return { status: 'committed' };
        },
        subscribe(fn) { listeners.push(fn); return () => {}; },
        _replace(next) { held = next; },
    };
}

function makeStorage(entries) {
    return {
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(entries, key)
                ? entries[key] : null;
        },
        setItem(key, value) { entries[key] = String(value); },
        removeItem(key) { delete entries[key]; },
    };
}

function loadModule({ preferences = makePreferences(), storage = makeStorage({}) } = {}) {
    delete require.cache[require.resolve(MODULE_PATH)];
    delete globalThis.ThemeConsent;
    globalThis.Preferences = preferences;
    globalThis.localStorage = storage;
    const mod = require(MODULE_PATH);
    return { mod, preferences, storage };
}

function userTheme(overrides = {}) {
    return Object.assign({
        id: 'matrix',
        name: 'matrix',
        source: 'user',
        effects: 'effects.js',
        effectsDigest: DIGEST_A,
    }, overrides);
}

/** Records every call, so "never called" is measurable. */
function spy() {
    const calls = [];
    const fn = (...args) => { calls.push(args); };
    fn.calls = calls;
    return fn;
}

// ---------------------------------------------------------------------
// Negative controls. Every one of these must NOT execute the script.
// ---------------------------------------------------------------------

test('NEGATIVE CONTROL: with nothing on record and no way to ask, the script does not run', async () => {
    const { mod } = loadModule();
    const inject = spy();
    const outcome = await mod.gateEffects({ manifest: userTheme(), inject });
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
    assert.equal(inject.calls.length, 0,
        'a theme with no consent record executed its script');
});

test('NEGATIVE CONTROL: a dismissed prompt is not a yes', async () => {
    const { mod } = loadModule();
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(),
        inject,
        prompt: async () => null,
    });
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
    assert.equal(inject.calls.length, 0);
});

test('NEGATIVE CONTROL: a recorded refusal never runs and is never asked about', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'never' } },
        }),
    });
    const inject = spy();
    const prompt = spy();
    const outcome = await mod.gateEffects({ manifest: userTheme(), inject, prompt });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
    assert.equal(prompt.calls.length, 0,
        'a refusal was re-opened as a question, which is how a no becomes a yes');
});

test('NEGATIVE CONTROL: a refusal outranks the bundled-theme bypass', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'never' } },
        }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme({ source: 'builtin' }),
        inject,
        prompt: async () => 'always',
    });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
});

test('NEGATIVE CONTROL: a grant for DIFFERENT bytes does not run the new script', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'always', digest: DIGEST_B } },
        }),
    });
    const inject = spy();
    let asked = null;
    const outcome = await mod.gateEffects({
        manifest: userTheme({ effectsDigest: DIGEST_A }),
        inject,
        prompt: async (manifest, info) => { asked = info; return null; },
    });
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
    assert.equal(inject.calls.length, 0,
        'an edited effects.js inherited a grant given for the old one');
    assert.ok(asked && asked.changed === true,
        'the user was asked as if this were a first sighting, not an edit');
});

test('NEGATIVE CONTROL: an unreadable record refuses rather than asking', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'always', digest: DIGEST_A } },
            hydrated: false,
        }),
    });
    const inject = spy();
    const prompt = spy();
    const outcome = await mod.gateEffects({ manifest: userTheme(), inject, prompt });
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
    assert.equal(inject.calls.length, 0,
        'a cached grant ran while the current record could not be read, so a '
        + 'newer refusal on another device could not have been seen');
    assert.equal(prompt.calls.length, 0);
});

test('NEGATIVE CONTROL: a user theme whose bytes could not be measured never runs', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'always', digest: DIGEST_A } },
        }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme({ effectsDigest: null }),
        inject,
        prompt: async () => 'always',
    });
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
    assert.equal(inject.calls.length, 0);
});

test('NEGATIVE CONTROL: allow once is never written anywhere', async () => {
    const { mod, preferences, storage } = loadModule();
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(),
        inject,
        prompt: async () => 'once',
    });
    assert.equal(outcome, mod.RUN);
    assert.equal(inject.calls.length, 1, 'an explicit allow once did not run');
    assert.equal(preferences.saved.length, 0,
        'a temporary allowance was persisted, which makes it a standing one');
    assert.equal(storage.getItem('cloude.themeJsAllowlist'), null);
});

// ---------------------------------------------------------------------
// The permitted paths. Present so a gate that refused everything would
// fail here rather than looking correct.
// ---------------------------------------------------------------------

test('a grant naming THESE bytes runs without asking again', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'always', digest: DIGEST_A } },
        }),
    });
    const inject = spy();
    const prompt = spy();
    const outcome = await mod.gateEffects({ manifest: userTheme(), inject, prompt });
    assert.equal(outcome, mod.RUN);
    assert.equal(inject.calls.length, 1);
    assert.equal(prompt.calls.length, 0);
});

test('a bundled theme with nothing on record runs without a prompt', async () => {
    const { mod } = loadModule();
    const inject = spy();
    const prompt = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme({ source: 'builtin' }), inject, prompt,
    });
    assert.equal(outcome, mod.RUN);
    assert.equal(prompt.calls.length, 0,
        'a theme shipped in this repo put a modal in front of our own code');
});

test('a theme with no script is not a consent question at all', async () => {
    const { mod } = loadModule();
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme({ effects: null, effectsDigest: null }), inject,
    });
    assert.equal(outcome, mod.SKIP_NO_SCRIPT);
    assert.equal(inject.calls.length, 0);
});

test('always allow stores the digest it was granted for, and only that theme', async () => {
    const { mod, preferences } = loadModule({
        preferences: makePreferences({
            consent: { other: { decision: 'never' } },
        }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(), inject, prompt: async () => 'always',
    });
    assert.equal(outcome, mod.RUN);
    assert.equal(inject.calls.length, 1);
    assert.equal(preferences.saved.length, 1);
    assert.deepEqual(preferences.saved[0].value, {
        other: { decision: 'never' },
        matrix: { decision: 'always', digest: DIGEST_A },
    }, 'answering for one theme rewrote the answers for the others');
});

test('never stores a refusal carrying no digest, because it is about the theme', async () => {
    const { mod, preferences } = loadModule();
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(), inject, prompt: async () => 'never',
    });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
    assert.deepEqual(preferences.saved[0].value.matrix, { decision: 'never' });
});

test('an always the server refused to store degrades to this sitting only', async () => {
    // The user consented in front of us a moment ago, which is the
    // strongest evidence there is, so the script runs - but nothing about
    // that moment survives the page.
    const { mod, preferences } = loadModule({
        preferences: makePreferences({ setResult: { status: 'failed' } }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(), inject, prompt: async () => 'always',
    });
    assert.equal(outcome, mod.RUN);
    assert.equal(inject.calls.length, 1);
    assert.equal(preferences.get('theme_script_consent', null), null,
        'a failed save left a grant behind anyway');
});

test('a refusal committed elsewhere while we were asking wins the race', async () => {
    // The prompt is answered "always", the PATCH comes back 409, and the
    // record that beat us says never. Running on our own answer here is
    // exactly the "a pending prompt cannot outrank a newer Never" case.
    const preferences = makePreferences({ setResult: { status: 'stale_revision' } });
    const { mod } = loadModule({ preferences });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(),
        inject,
        prompt: async () => {
            preferences._replace({ matrix: { decision: 'never' } });
            return 'always';
        },
    });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
});

// ---------------------------------------------------------------------
// The legacy per-browser key: refusals carry over, grants do not.
// ---------------------------------------------------------------------

test('a refusal in the old local allowlist still refuses', async () => {
    const { mod } = loadModule({
        storage: makeStorage({
            'cloude.themeJsAllowlist': JSON.stringify({ matrix: false }),
        }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({
        manifest: userTheme(), inject, prompt: async () => 'always',
    });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
});

test('NEGATIVE CONTROL: a grant in the old local allowlist does NOT run the script', async () => {
    // The old key recorded `true` against a theme id and nothing else, so
    // there is no artifact for a grant to be bound to. Honouring it would
    // reintroduce the unbounded grant this design exists to remove.
    const { mod } = loadModule({
        storage: makeStorage({
            'cloude.themeJsAllowlist': JSON.stringify({ matrix: true }),
        }),
    });
    const inject = spy();
    let asked = false;
    const outcome = await mod.gateEffects({
        manifest: userTheme(),
        inject,
        prompt: async () => { asked = true; return null; },
    });
    assert.equal(inject.calls.length, 0);
    assert.ok(asked, 'the user was not re-asked about a grant that names no bytes');
    assert.equal(outcome, mod.SKIP_UNVERIFIABLE);
});

test('a local refusal is not overridden by a shared grant', async () => {
    const { mod } = loadModule({
        preferences: makePreferences({
            consent: { matrix: { decision: 'always', digest: DIGEST_A } },
        }),
        storage: makeStorage({
            'cloude.themeJsAllowlist': JSON.stringify({ matrix: false }),
        }),
    });
    const inject = spy();
    const outcome = await mod.gateEffects({ manifest: userTheme(), inject });
    assert.equal(outcome, mod.SKIP_DENIED);
    assert.equal(inject.calls.length, 0);
});

// ---------------------------------------------------------------------
// Revocation arriving from another device.
// ---------------------------------------------------------------------

test('only a move INTO a refusal counts as a revocation', () => {
    const { mod } = loadModule();
    assert.deepEqual(
        mod.revocationsBetween({}, { a: { decision: 'never' } }), ['a']);
    assert.deepEqual(
        mod.revocationsBetween(
            { a: { decision: 'never' } }, { a: { decision: 'never' } }), [],
        'a refusal that was already there was reported as newly arrived');
    assert.deepEqual(
        mod.revocationsBetween(
            { a: { decision: 'always', digest: DIGEST_A } }, {}), [],
        'a grant merely expiring was treated as a teardown');
});

test('a refusal committed elsewhere tears the running module down', () => {
    const preferences = makePreferences();
    const { mod } = loadModule({ preferences });
    const revoked = [];
    globalThis.Themes = { revokeEffects: (id) => revoked.push(id) };
    try {
        assert.equal(preferences.listeners.length, 1,
            'the module did not subscribe to the shared record on load');
        preferences._replace({ matrix: { decision: 'never' } });
        preferences.listeners[0]('theme_script_consent');
        assert.deepEqual(revoked, ['matrix']);
    } finally {
        delete globalThis.Themes;
    }
    assert.ok(mod.FIELD === 'theme_script_consent');
});

test('a change to some other preference tears nothing down', () => {
    const preferences = makePreferences();
    loadModule({ preferences });
    const revoked = [];
    globalThis.Themes = { revokeEffects: (id) => revoked.push(id) };
    try {
        preferences._replace({ matrix: { decision: 'never' } });
        preferences.listeners[0]('sidebar_density');
        assert.deepEqual(revoked, [],
            'an unrelated preference change tore down a theme script');
    } finally {
        delete globalThis.Themes;
    }
});
