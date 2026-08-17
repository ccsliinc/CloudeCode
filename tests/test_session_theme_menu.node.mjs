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
 * ThemeAudio is faked with the TWO-GATE API it really has: an app sound
 * master switch and a per-session gate, silent unless both are on. Pass
 * `legacyThemeAudio: true` to fake an older ThemeAudio that only exposes
 * isMuted/toggleMute, which exercises the version-skew fallback.
 *
 * @param {object} opts
 * @param {string|null} opts.session - active tmux session name.
 * @param {object} opts.store - backing object for localStorage.
 * @param {boolean} opts.muted - starting effective mute (legacy fake only).
 * @param {boolean} opts.appSound - starting app sound master state.
 * @param {boolean} opts.legacyThemeAudio - omit the two-gate API.
 */
function load(opts) {
    const store = opts.store || {};
    const created = [];
    const calls = { applyGlobal: [], toggleMute: 0 };
    let muted = opts.muted === undefined ? true : opts.muted;
    let appSoundOn = opts.appSound === undefined ? false : opts.appSound;
    let sessionOn = true;

    const sandbox = {
        window: {
            Themes: {
                getActiveSession: () => opts.session,
                // `hasTrack` decides whether the active theme declares an
                // audio block. Without one the control honestly reports
                // "no track", which would otherwise mask the messages the
                // app-sound tests are actually asserting on.
                getActiveGlobal: () => (opts.hasTrack
                    ? {
                        id: 'claude',
                        name: 'Claude',
                        audio: { src: '/static/assets/audio/dead-ship.m4a' }
                    }
                    : { id: 'claude', name: 'Claude' }),
                listAll: () => [
                    { id: 'claude', name: 'Claude' },
                    { id: 'matrix', name: 'Matrix' },
                ],
                applyGlobal(id) { calls.applyGlobal.push(id); return true; },
            },
            ThemeAudio: opts.legacyThemeAudio
                ? {
                    isMuted: () => muted,
                    toggleMute() { muted = !muted; calls.toggleMute++; return muted; },
                }
                : {
                    isMuted: () => !(appSoundOn && sessionOn),
                    toggleMute() {
                        appSoundOn = !appSoundOn;
                        calls.toggleMute++;
                        return !(appSoundOn && sessionOn);
                    },
                    isAppSoundOn: () => appSoundOn,
                    setAppSound(on) { appSoundOn = !!on; return !(appSoundOn && sessionOn); },
                    isSessionEnabled: () => sessionOn,
                    setSessionEnabled(on) { sessionOn = !!on; return !(appSoundOn && sessionOn); },
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
        isMuted: () => (opts.legacyThemeAudio ? muted : !(appSoundOn && sessionOn)),
        isAppSoundOn: () => appSoundOn,
        isSessionEnabled: () => sessionOn,
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

test('entering an opted-in session opens its gate without touching the master', () => {
    // This used to assert toggleMute was called once, which encoded the
    // bug: an attach reached for the app sound master switch. It now
    // drives only the session gate.
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api, calls, isMuted, isSessionEnabled } = load({
        session: 'alpha', store, appSound: true
    });
    api.syncForSession();
    assert.equal(calls.toggleMute, 0, 'an attach must never flip the master switch');
    assert.equal(isSessionEnabled(), true);
    assert.equal(isMuted(), false, 'app sound on plus an opted-in session is audible');
});

test('an opted-in session is still silent while app sound is off', () => {
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api, isMuted, isSessionEnabled } = load({
        session: 'alpha', store, appSound: false
    });
    api.syncForSession();
    assert.equal(isSessionEnabled(), true, 'the session gate reflects the opt-in');
    assert.equal(isMuted(), true, 'the master switch must still win');
});

test('entering a session that never opted in leaves it silent', () => {
    const { api, calls, isMuted } = load({ session: 'beta', appSound: true });
    api.syncForSession();
    assert.equal(calls.toggleMute, 0, 'no autoplay without an explicit opt-in');
    assert.equal(isMuted(), true);
});

test('REGRESSION: music does not leak from one session into the next', () => {
    // Left session alpha playing, now entering beta which never opted in.
    // App sound is ON, so the session gate is the only thing that can
    // silence beta - without it this assertion would pass vacuously.
    const store = { 'cloude.audio.session.alpha': 'on' };
    const { api, isMuted, isAppSoundOn } = load({
        session: 'beta', store, appSound: true
    });
    api.syncForSession();
    assert.equal(isMuted(), true, 'beta must be silenced on entry');
    assert.equal(isAppSoundOn(), true, 'and it must do that without muting the app');
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

test('entering a session sets the session gate, never the app sound master', () => {
    // The reported bug: the header switch is "app sound (all sessions)",
    // but an attach used to drive that same boolean from the per-session
    // opt-in, so entering any session that had not opted into music
    // silently muted the whole app and the header kept showing itself on.
    const { api, isAppSoundOn, isSessionEnabled } = load({
        session: 'alpha', appSound: true
    });
    api.syncForSession();
    assert.equal(isAppSoundOn(), true, 'the attach clobbered the master switch');
    assert.equal(isSessionEnabled(), false, 'alpha never opted in, so its gate is off');
});

test('turning music on while app sound is off lifts it and says so', () => {
    // Two controls where one silently vetoes the other is a dead end: the
    // user taps "play music", nothing happens, and nothing explains why.
    const { api, isAppSoundOn, isMuted } = load({
        session: 'alpha', appSound: false, hasTrack: true
    });
    const pills = [];
    api.toggleAudio(
        { _showStatusPill(msg, kind) { pills.push({ msg, kind }); } },
        fakeEl('sessionAudioBtn')
    );

    assert.equal(isAppSoundOn(), true, 'app sound must be lifted in the same tap');
    assert.equal(isMuted(), false, 'both gates should now be open');
    assert.equal(pills.length, 1, 'the user must be told, not silently overridden');
    assert.ok(
        /app sound/.test(pills[0].msg),
        `the message must name the other control: ${pills[0].msg}`
    );
});

test('turning music on confirms it rather than saying nothing', () => {
    // This test used to assert ZERO messages on the happy path, which
    // encoded the defect: staying quiet made "it worked" and "it silently
    // did nothing" look identical, and that is how five separate causes
    // each survived a user tapping this control. Success is now stated.
    const { api } = load({ session: 'alpha', appSound: true, hasTrack: true });
    const pills = [];
    api.toggleAudio(
        { _showStatusPill(msg, kind) { pills.push({ msg, kind }); } },
        fakeEl('sessionAudioBtn')
    );
    assert.equal(pills.length, 1, 'the tap must be acknowledged');
    assert.ok(
        !/no sound/.test(pills[0].msg),
        `a working track must not report a fault: ${pills[0].msg}`
    );
    assert.notEqual(pills[0].kind, 'error');
});

test('an older ThemeAudio without the two-gate API still toggles', () => {
    // Version skew between a cached client and a deployed one must
    // degrade, not throw.
    const { api, isMuted } = load({
        session: 'alpha', muted: true, legacyThemeAudio: true
    });
    api.toggleAudio({ _showStatusPill() {} }, fakeEl('sessionAudioBtn'));
    assert.equal(isMuted(), false);
});

test('opting in on a theme with no track says so instead of pretending', () => {
    const { api } = load({ session: 'alpha', muted: true });
    const pills = [];
    api.toggleAudio(
        { _showStatusPill(msg, kind) { pills.push({ msg, kind }); } },
        fakeEl('sessionAudioBtn')
    );
    assert.equal(pills.length, 1);
    assert.ok(
        /no sound: this theme has no music track/.test(pills[0].msg),
        `unexpected message: ${pills[0].msg}`
    );
    assert.equal(pills[0].kind, 'error', 'a control that achieved nothing is a fault');
});

test('leaving a session re-opens the music gate for the home screen', () => {
    // REGRESSION. syncForSession() was only ever called on ATTACH, so the
    // session gate kept the detached session's opt-in (OFF by default).
    // Back on the launchpad the header "app sound (all sessions)" switch
    // painted itself ON - it paints from gate 1 - and produced nothing,
    // because gate 2 was still vetoing it on behalf of a session that was
    // no longer attached. No error, no message: the same silent-gate shape
    // as the bug this file's other regression test covers.
    const store = { 'cloude.audio.session.alpha': 'off' };
    const { api, isSessionEnabled, isMuted } = load({
        session: null, store, appSound: true
    });
    api.syncForSession();
    assert.equal(isSessionEnabled(), true, 'no session in scope means no session veto');
    assert.equal(isMuted(), false, 'the header switch alone must play the home theme');
});

test('the home gate does not leak back into an opted-out session', () => {
    // The counterpart: opening the gate when there is no session must not
    // become "on by default" once one IS attached.
    const { api, isSessionEnabled, isMuted } = load({
        session: 'beta', appSound: true
    });
    api.syncForSession();
    assert.equal(isSessionEnabled(), false);
    assert.equal(isMuted(), true, 'a session that never opted in stays silent');
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
