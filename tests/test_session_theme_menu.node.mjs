// Node tests for client/js/session-theme-menu.js — the per-session
// theme picker and the per-session background-music opt-in.
//
// The two properties worth locking down:
//
//  1. Picking a theme inside a session must go through
//     Themes.applyGlobal(), because THAT is what routes persistence to
//     the server (PATCH /api/v1/sessions/<tmux name>/theme) instead of
//     localStorage. Anything that wrote localStorage directly would
//     clobber the user's default theme and would not survive a
//     reconnect from another browser.
//  2. Music defaults OFF for every session, is keyed by the STABLE tmux
//     session name, and entering a session applies THAT session's
//     choice — so unmuting one session can never leak into the next.
//
// Run with: node tests/test_session_theme_menu.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Read a client JS file.
 * @param {string} name  File name under client/js/.
 * @returns {string} File contents.
 */
function clientJs(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'js', name), 'utf8');
}

// anchor-popover.js first: session-theme-menu.js delegates its placement
// to window.AnchorPopover rather than carrying its own copy of the rule.
const popoverSrc = clientJs('anchor-popover.js');
const src = clientJs('session-theme-menu.js');

let failures = 0;
let passes = 0;

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

/** Minimal element stand-in that records attributes and handlers. */
function fakeEl(id) {
    return {
        id,
        attrs: {},
        handlers: {},
        classes: new Set(),
        children: [],
        style: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        addEventListener(type, fn) { this.handlers[type] = fn; },
        appendChild(c) { this.children.push(c); },
        removeChild() {},
        remove() {},
        contains() { return false; },
        classList: {
            add() {}, remove() {},
            toggle(name, on) { if (on) this.__on = name; },
        },
        getBoundingClientRect() {
            return { top: 0, bottom: 10, left: 0, right: 10 };
        },
        offsetWidth: 10,
        offsetHeight: 10,
    };
}

/**
 * Build a sandbox with fake Themes/ThemeAudio/localStorage.
 *
 * @param {object} opts
 * @param {string|null} opts.session - active tmux session name.
 * @param {object} opts.store - backing object for localStorage.
 * @param {boolean} opts.muted - ThemeAudio's starting mute state.
 */
function load(opts) {
    const store = opts.store || {};
    const created = [];
    const calls = { applyGlobal: [], toggleMute: 0 };
    let muted = opts.muted === undefined ? true : opts.muted;

    const sandbox = {
        window: {
            Themes: {
                getActiveSession: () => opts.session,
                getActiveGlobal: () => ({ id: 'claude', name: 'Claude' }),
                listAll: () => [
                    { id: 'claude', name: 'Claude' },
                    { id: 'matrix', name: 'Matrix' },
                ],
                applyGlobal(id) { calls.applyGlobal.push(id); return true; },
            },
            ThemeAudio: {
                isMuted: () => muted,
                toggleMute() { muted = !muted; calls.toggleMute++; return muted; },
            },
            getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
            innerWidth: 400,
            innerHeight: 800,
        },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        document: {
            body: { appendChild() {} },
            createElement: () => {
                const el = fakeEl('created');
                created.push(el);
                return el;
            },
            addEventListener() {},
            removeEventListener() {},
            getElementById: () => null,
        },
        console: { log() {}, warn() {} },
        setTimeout: (fn) => fn(),
        Date,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(popoverSrc, sandbox);
    vm.runInContext(src, sandbox);
    return {
        api: sandbox.window.SessionThemeMenu,
        calls,
        store,
        created,
        isMuted: () => muted,
    };
}

test('music defaults OFF for a session that was never opted in', () => {
    const { api } = load({ session: 'my-project-Main' });
    assert.equal(api.isAudioOn('my-project-Main'), false);
});

test('the opt-in key is the tmux session name, not a pid or client id', () => {
    const { api, store } = load({ session: 'my-project-Main' });
    api.setAudioOn('my-project-Main', true);
    const keys = Object.keys(store);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], 'cloude.audio.session.my-project-Main');
    assert.equal(store[keys[0]], 'on');
});

test('the opt-in survives a reload (read back from storage)', () => {
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api } = load({ session: 'alpha', store });
    assert.equal(api.isAudioOn('alpha'), true);
});

test('one session opting in does not opt in any other session', () => {
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api } = load({ session: 'beta', store });
    assert.equal(api.isAudioOn('beta'), false);
});

test('a null session name is never on and never written', () => {
    const { api, store } = load({ session: null });
    assert.equal(api.isAudioOn(null), false);
    api.setAudioOn(null, true);
    assert.equal(Object.keys(store).length, 0);
});

test('entering an opted-in session unmutes', () => {
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api, calls, isMuted } = load({ session: 'alpha', store, muted: true });
    api.syncForSession();
    assert.equal(calls.toggleMute, 1);
    assert.equal(isMuted(), false);
});

test('entering a session that never opted in leaves it silent', () => {
    const { api, calls, isMuted } = load({ session: 'beta', muted: true });
    api.syncForSession();
    assert.equal(calls.toggleMute, 0, 'no autoplay without an explicit opt-in');
    assert.equal(isMuted(), true);
});

test('REGRESSION: music does not leak from one session into the next', () => {
    // Left session alpha unmuted, now entering beta which never opted in.
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api, isMuted } = load({ session: 'beta', store, muted: false });
    api.syncForSession();
    assert.equal(isMuted(), true, 'beta must be silenced on entry');
});

// toggleAudio is now reached from the session editor's "play music" MENU
// ROW (session-editor-menu.js), which rebuilds on every open, so these
// call it directly rather than through a long-lived button. The optional
// btn argument is still exercised because the row repaints itself.
test('toggling audio flips and persists the opt-in', () => {
    const { api, store, isMuted } = load({ session: 'alpha', muted: true });
    const audioBtn = fakeEl('sessionAudioBtn');

    api.toggleAudio({ _showStatusPill() {} }, audioBtn);
    assert.equal(store['cloude.audio.session.alpha'], 'on');
    assert.equal(isMuted(), false);
    assert.equal(audioBtn.getAttribute('aria-pressed'), 'true');

    api.toggleAudio({ _showStatusPill() {} }, audioBtn);
    assert.equal(store['cloude.audio.session.alpha'], 'off');
    assert.equal(isMuted(), true);
    assert.equal(audioBtn.getAttribute('aria-pressed'), 'false');
});

test('opting in on a theme with no track says so instead of pretending', () => {
    const { api } = load({ session: 'alpha', muted: true });
    const pills = [];
    api.toggleAudio(
        { _showStatusPill(msg, kind) { pills.push({ msg, kind }); } },
        fakeEl('sessionAudioBtn')
    );
    assert.equal(pills.length, 1);
    assert.ok(/no track/.test(pills[0].msg), `unexpected message: ${pills[0].msg}`);
});

test('the picker lists every registered theme and marks the active one', () => {
    const { api, created } = load({ session: 'alpha' });
    api.open(fakeEl('sessionThemeBtn'));
    const rows = created.filter((el) => el.handlers.click);
    assert.equal(rows.length, 2, 'one row per theme');
    assert.equal(rows[0].textContent, 'claude');
    assert.equal(rows[1].textContent, 'matrix');
    assert.equal(rows[0].getAttribute('aria-checked'), 'true');
    assert.equal(rows[1].getAttribute('aria-checked'), 'false');
});

test('picking a theme routes through applyGlobal (server-side per-session pin)', () => {
    const { api, calls, store, created } = load({ session: 'alpha' });
    api.open(fakeEl('sessionThemeBtn'));
    assert.equal(calls.applyGlobal.length, 0, 'opening alone must apply nothing');

    const rows = created.filter((el) => el.handlers.click);
    rows[1].handlers.click();

    assert.equal(calls.applyGlobal.join(','), 'matrix');
    // applyGlobal is what PATCHes the server when a session is in scope.
    // Writing localStorage here instead would clobber the user's default
    // theme and would not survive a reconnect from another browser.
    assert.equal(Object.keys(store).length, 0, 'picker must not write localStorage');
});

test('the picker names the session it is scoped to', () => {
    const { api, created } = load({ session: 'my-project-Main' });
    api.open(fakeEl('sessionThemeBtn'));
    const head = created.find(
        (el) => typeof el.textContent === 'string' && el.textContent.indexOf('theme for ') === 0
    );
    assert.ok(head, 'header present');
    assert.equal(head.textContent, 'theme for my-project-Main');
});

// The 'wire() is idempotent' test was removed with wire() itself: the
// two terminal-screen buttons it bound were deleted in 784433c, and
// nothing has called it since. The behaviour it guarded now lives in
// SessionEditorMenu.wire, which has its own idempotence test.

test('the picker is placed by the SHARED anchor rule, not a local copy', () => {
    const { api, created } = load({ session: 'alpha' });
    const anchor = fakeEl('sessionThemeBtn');
    api.open(anchor);
    // The picker is the first element the module creates.
    const picker = created[0];
    assert.equal(typeof picker.style.left, 'string',
        'the picker must have been positioned');
    assert.equal(typeof picker.style.top, 'string');
    // And the rule itself is not restated in this module.
    assert.ok(!src.includes('visualViewport'),
        'placement must live in anchor-popover.js, not be copied back in');
    assert.ok(popoverSrc.includes('visualViewport'),
        'the shared rule must still clamp to the visual viewport');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
    console.error('FAILURES');
    process.exit(1);
}
console.log('ALL PASS');
