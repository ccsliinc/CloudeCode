// THE CSS-VAR DIFF WRITER: skip an unchanged property SET, never skip a
// REMOVAL, never skip anything else registry.js does on the same call.
//
// Setting a CSS custom property to the value it already holds still
// invalidates style for everything that depends on it - a full ~30
// variable palette reapplied unchanged is real recalculation for zero
// visual difference, and it used to happen on every navigation and every
// re-entry into a session, not only on a genuine theme switch.
//
// THE INVALIDATION TESTS ARE THE POINT. A cache-hit test alone would pass
// on a "skip everything, always" writer that never removes a stale
// variable - which is exactly the bug `6f79e90` fixed on this same code
// path. Every "must still happen" case below was confirmed to fail when
// the corresponding guard in theme-var-writer.js or registry.js is
// loosened; see the failure this file's author ran before shipping.
//
// TWO LAYERS. Layer 1 is theme-var-writer.js in isolation, against a bare
// style-object stub - no registry, no themes, no DOM. Layer 2 runs the
// REAL themes/registry.js (same pattern as
// tests/test_login_theme_precache.node.mjs) so the skip is proven against
// the actual paint path a browser executes, not a description of it.
//
// Run with: node tests/test_theme_var_writer.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passes = 0;
let failures = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name @param {() => (void|Promise<void>)} fn
 * @returns {Promise<void>}
 */
async function test(name, fn) {
    try {
        await fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

// -----------------------------------------------------------------
// LAYER 1: theme-var-writer.js in isolation.
// -----------------------------------------------------------------

function loadWriter() {
    const sandbox = { window: {}, console: { log() {}, error() {} } };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'theme-var-writer.js'), 'utf8'),
        sandbox, { filename: 'theme-var-writer.js' });
    return sandbox.window.ThemeVarWriter;
}

/** A style stub recording every set/removeProperty call, by count and by name. */
function styleSpy() {
    const values = new Map();
    const setCalls = [];
    const removeCalls = [];
    return {
        values, setCalls, removeCalls,
        setProperty(name, value) { setCalls.push(name); values.set(name, value); },
        removeProperty(name) { removeCalls.push(name); values.delete(name); },
    };
}

await test('writer: an unchanged value is never re-set', () => {
    const w = loadWriter();
    const style = styleSpy();
    const a = w.applyVarDiff(style, {}, { '--bg': '#111' });
    assert.deepEqual(style.setCalls, ['--bg']);
    const b = w.applyVarDiff(style, a.values, { '--bg': '#111' });
    assert.deepEqual(style.setCalls, ['--bg'], 'a second identical value must not call setProperty again');
    assert.equal(b.skipped, 1);
});

await test('writer: a CHANGED value still gets set - the skip is per-value, not per-name', () => {
    const w = loadWriter();
    const style = styleSpy();
    const a = w.applyVarDiff(style, {}, { '--bg': '#111' });
    w.applyVarDiff(style, a.values, { '--bg': '#222' });
    assert.deepEqual(style.setCalls, ['--bg', '--bg']);
    assert.equal(style.values.get('--bg'), '#222');
});

await test('writer: a dropped name is removed UNCONDITIONALLY, never skipped', () => {
    const w = loadWriter();
    const style = styleSpy();
    const a = w.applyVarDiff(style, {}, { '--bg': '#111', '--fg': '#eee' });
    // REMOVING --fg entirely - this is the exact shape of a session
    // pin taking scope away from an agent theme that defined --fg.
    w.applyVarDiff(style, a.values, { '--bg': '#111' });
    assert.deepEqual(style.removeCalls, ['--fg']);
    assert.equal(style.values.has('--fg'), false);
});

await test('writer: a value unchanged in TEXT but re-typed is still treated as unchanged (string compare)', () => {
    const w = loadWriter();
    const style = styleSpy();
    const a = w.applyVarDiff(style, {}, { '--n': 5 });
    style.setCalls.length = 0;
    w.applyVarDiff(style, a.values, { '--n': 5 });
    assert.deepEqual(style.setCalls, [], 'the same value re-supplied must still be a skip');
});

// -----------------------------------------------------------------
// LAYER 2: the real registry.js, same load() shape as
// test_login_theme_precache.node.mjs.
// -----------------------------------------------------------------

/**
 * Load themes/registry.js (with theme-var-writer.js) over a DOM shim
 * whose :root style records every setProperty/removeProperty call.
 * @param {object} store initial localStorage contents
 * @returns {{sandbox: object, style: object}}
 */
function loadRegistry(store) {
    const style = styleSpy();
    const backing = { ...store };
    const documentElement = { style, dataset: {} };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            documentElement,
            createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
            head: { appendChild() {} },
            addEventListener() {}, removeEventListener() {},
            getElementById: () => null, querySelector: () => null,
            querySelectorAll: () => [],
        },
        localStorage: {
            getItem: (k) => (k in backing ? backing[k] : null),
            setItem: (k, v) => { backing[k] = String(v); },
            removeItem: (k) => { delete backing[k]; },
        },
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
        fetch: () => Promise.reject(new Error('no network pre-auth')),
        Set, Map, JSON, Object, Array, Promise, Error,
        location: { href: '' }, navigator: { userAgent: '' },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'theme-var-writer.js'), 'utf8'),
        sandbox, { filename: 'theme-var-writer.js' });
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'themes', 'registry.js'), 'utf8'),
        sandbox, { filename: 'registry.js' });
    return { sandbox, style, backing };
}

function manifest(id) {
    return JSON.parse(fs.readFileSync(
        path.join(ROOT, 'client', 'css', 'themes', id, 'theme.json'), 'utf8'));
}
const TERMINAL = manifest('terminal');
const CLAUDE = manifest('claude');
const VARS_CACHE_KEY = 'cloude.theme.vars';
const THEME_KEY = 'cloude.theme';

await test('registry: re-applying the SAME cached theme costs zero setProperty calls the second time', () => {
    const { sandbox, style } = loadRegistry({
        [THEME_KEY]: 'terminal',
        [VARS_CACHE_KEY]: JSON.stringify({ id: 'terminal', cssVars: TERMINAL.cssVars }),
    });
    sandbox.Themes.applyStoredThemeIdSync();
    const afterFirst = style.setCalls.length;
    assert.ok(afterFirst > 0, 'the first paint must have set something');

    style.setCalls.length = 0;
    style.removeCalls.length = 0;
    sandbox.Themes.applyStoredThemeIdSync(); // same stored id, same cache
    assert.deepEqual(style.setCalls, [],
        'a re-apply of the identical palette must set nothing');
    assert.deepEqual(style.removeCalls, [],
        'a re-apply of the identical palette must remove nothing either');
});

await test('registry: switching themes still REMOVES every variable the outgoing one owned', () => {
    // Every real shipped manifest happens to declare the identical
    // ~70-token set (measured: terminal and claude both declare exactly
    // the same keys, only the values differ), so this scenario - a
    // variable ONE theme owns that the other does not - is built
    // synthetically rather than from two real manifests, the same way
    // an agent theme and a narrower session pin can differ in practice.
    const wide = { '--color-bg': '#111111', '--agent-only-var': '#abcdef' };
    const narrow = { '--color-bg': '#111111' };
    const { sandbox, style, backing } = loadRegistry({
        [THEME_KEY]: 'wide',
        [VARS_CACHE_KEY]: JSON.stringify({ id: 'wide', cssVars: wide }),
    });
    sandbox.Themes.applyStoredThemeIdSync();
    assert.equal(style.values.get('--agent-only-var'), '#abcdef');
    assert.equal(style.values.get('--color-bg'), '#111111');

    style.setCalls.length = 0;
    style.removeCalls.length = 0;
    backing[THEME_KEY] = 'narrow';
    backing[VARS_CACHE_KEY] = JSON.stringify({ id: 'narrow', cssVars: narrow });
    sandbox.Themes.applyStoredThemeIdSync();

    assert.equal(style.values.has('--agent-only-var'), false,
        '--agent-only-var belonged only to the wide set and must be gone');
    assert.deepEqual(style.removeCalls, ['--agent-only-var']);
    // --color-bg is IDENTICAL in both sets - this is the actual point of
    // the whole feature - and must not have been re-set.
    assert.deepEqual(style.setCalls, [],
        'the one variable both sets share, at the same value, must not be re-set '
        + 'just because a different variable was dropped alongside it');
});

await test('registry: applyTheme still fires ThemeAudio and xterm on EVERY call, even a no-op repaint', async () => {
    // Audio semantics must never be skipped by the var-write optimisation:
    // browsers gate audio on a user gesture, and a shortcut that skips
    // the call can lose the gesture context that made it permissible.
    const { sandbox } = loadRegistry({});
    const audioCalls = [];
    sandbox.ThemeAudio = { setTheme(v) { audioCalls.push(v); } };
    const xtermCalls = [];
    sandbox.Themes.onXtermThemeChange((p) => xtermCalls.push(p));

    // Seed one real manifest via a genuine init() so applyGlobal has
    // something to resolve; fetch is stubbed per-test rather than reused
    // globally, matching test_login_theme_precache's own pattern.
    sandbox.fetch = () => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve([TERMINAL, CLAUDE]),
    });
    await sandbox.Themes.init();
    audioCalls.length = 0;
    xtermCalls.length = 0;

    sandbox.Themes.applyGlobal('terminal');
    assert.equal(audioCalls.length, 1, 'the first apply must call ThemeAudio.setTheme');
    assert.equal(xtermCalls.length, 1, 'the first apply must fire the xterm listener');

    // Re-apply the SAME theme - the var writes should skip, but audio
    // and xterm must fire exactly as before: unconditionally, every call.
    sandbox.Themes.applyGlobal('terminal');
    assert.equal(audioCalls.length, 2,
        'a repeated apply must still call ThemeAudio.setTheme - audio semantics are never skipped');
    assert.equal(xtermCalls.length, 2,
        'a repeated apply must still fire the xterm listener');
});

await test('registry: an unchanged VARS_CACHE_KEY write is skipped; a real change still writes', async () => {
    const { sandbox } = loadRegistry({});
    let setItemCalls = 0;
    const realSetItem = sandbox.localStorage.setItem;
    sandbox.localStorage.setItem = function (k, v) {
        if (k === 'cloude.theme.vars') setItemCalls++;
        return realSetItem(k, v);
    };
    sandbox.fetch = () => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve([TERMINAL, CLAUDE]),
    });
    await sandbox.Themes.init();
    setItemCalls = 0;

    sandbox.Themes.applyGlobal('terminal');
    assert.equal(setItemCalls, 1, 'the first apply must cache the palette');

    sandbox.Themes.applyGlobal('terminal');
    assert.equal(setItemCalls, 1,
        're-applying the identical theme must not write the cache again');

    sandbox.Themes.applyGlobal('claude');
    assert.equal(setItemCalls, 2,
        'a real theme change must still write the cache');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
