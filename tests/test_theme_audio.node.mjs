// Node tests for the theme background music: client/js/themeAudio.js and
// client/js/themeAudioNode.js, plus the theme manifests that feed them.
//
// WHAT ACTUALLY BROKE, and therefore what these lock down. The clips
// shipped as Ogg Vorbis only, and iOS cannot decode Ogg Vorbis: measured
// on iPhone 16e / iOS 26.1 / Safari 26.1 on 2026-08-16, the element fails
// with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4). The trap is that
// canPlayType('audio/ogg; codecs=vorbis') returns "probably" on that same
// device, so any capability probe would have picked the unplayable file
// and stayed silent. Hence:
//
//  1. Every theme that declares audio declares BOTH formats, with the
//     .m4a as the primary. A regression that reorders them, or drops the
//     m4a, is silence on the user's phone and nowhere else.
//  2. A load error advances to the next declared source on the SAME
//     element, because createMediaElementSource can only be called once
//     per element - rebuilding it would throw on the retry.
//  3. Only an exhausted candidate list tears the node down.
//  4. The gain budget: manifest volume times master volume must stay
//     audible. The bug's second half was 0.28 x 0.3 = 0.084 linear on top
//     of a -24 LUFS master, i.e. about -45 LUFS, inaudible on a phone.
//
// Run with: node tests/test_theme_audio.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/**
 * Read a client JS file.
 *
 * @param {string} name - File name under client/js/.
 * @returns {string} File contents.
 */
function clientJs(name) {
    return fs.readFileSync(path.join(repoRoot, 'client', 'js', name), 'utf8');
}

let failures = 0;
let passes = 0;

/**
 * Run one named assertion, recording the outcome.
 *
 * @param {string} name - Test name.
 * @param {Function} fn - Body; throwing marks a failure.
 * @returns {void}
 */
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

// ---------------------------------------------------------------------
// Fake DOM, just enough to run the two modules.
// ---------------------------------------------------------------------

/**
 * A stand-in HTMLAudioElement that records src assignments and lets a test
 * fire a load error with a chosen MediaError code.
 */
class FakeAudio {
    constructor() {
        this.loaded = [];
        this.handlers = {};
        this.volume = 1;
        this.paused = true;
        this.loop = false;
        this.preload = '';
        this.crossOrigin = null;
        this.error = null;
        this.playCalls = 0;
        this._src = '';
    }

    get src() { return this._src; }

    set src(v) {
        this._src = v;
        if (v) this.loaded.push(v);
    }

    addEventListener(type, fn) { this.handlers[type] = fn; }

    load() {}

    pause() { this.paused = true; }

    play() {
        this.playCalls++;
        this.paused = false;
        return Promise.resolve();
    }

    removeAttribute() { this._src = ''; }

    /**
     * Fire the element's error handler with a MediaError code.
     *
     * @param {number} code - MediaError code; 4 is SRC_NOT_SUPPORTED.
     * @returns {void}
     */
    fireError(code) {
        this.error = { code: code };
        if (this.handlers.error) this.handlers.error();
    }
}

/**
 * Build a sandbox with both audio modules loaded, and return its window
 * plus the list of FakeAudio elements the modules constructed.
 *
 * @returns {{win: object, els: FakeAudio[]}}
 */
function loadModules(seedStore) {
    const els = [];
    const store = Object.assign({}, seedStore || {});
    const win = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        },
        CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        document: {
            hidden: false,
            addEventListener() {},
            dispatchEvent() {}
        },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        performance: { now: () => 0 },
        // No AudioContext: the modules fall back to element mode, which is
        // the engine-independent path and keeps the test free of Web Audio
        // stubs. The fallback logic under test is identical in both.
        AudioContext: null,
        webkitAudioContext: null
    };
    win.window = win;
    win.Audio = function () { const a = new FakeAudio(); els.push(a); return a; };
    win.console = win.console;

    const ctx = vm.createContext(win);
    vm.runInContext(clientJs('themeAudioNode.js'), ctx);
    vm.runInContext(clientJs('themeAudioSettings.js'), ctx);
    vm.runInContext(clientJs('themeAudio.js'), ctx);
    return { win, els, store };
}

/** The manifest block shape the themes actually ship. */
const CFG = {
    src: '/static/assets/audio/scifi-drone.m4a',
    srcFallback: '/static/assets/audio/scifi-drone.ogg',
    volume: 0.6,
    fadeMs: 2500
};

// ---------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------

test('every theme with audio ships m4a primary and ogg fallback', () => {
    const themeDir = path.join(repoRoot, 'client', 'css', 'themes');
    const names = fs.readdirSync(themeDir)
        .filter((n) => fs.existsSync(path.join(themeDir, n, 'theme.json')));
    assert.ok(names.length > 0, 'no theme manifests found');

    let withAudio = 0;
    for (const name of names) {
        const m = JSON.parse(
            fs.readFileSync(path.join(themeDir, name, 'theme.json'), 'utf8')
        );
        if (!m.audio) continue;
        withAudio++;
        const a = m.audio;
        assert.ok(
            a.src.endsWith('.m4a'),
            `${name}: src must be the .m4a, iOS cannot decode Ogg Vorbis (got ${a.src})`
        );
        assert.ok(
            a.srcFallback && a.srcFallback.endsWith('.ogg'),
            `${name}: srcFallback must be the .ogg (got ${a.srcFallback})`
        );
        assert.equal(
            a.src.replace(/\.m4a$/, ''), a.srcFallback.replace(/\.ogg$/, ''),
            `${name}: the two formats must be the same clip`
        );
        for (const url of [a.src, a.srcFallback]) {
            const rel = url.replace('/static/', '');
            assert.ok(
                fs.existsSync(path.join(repoRoot, 'client', rel)),
                `${name}: ${url} is not on disk`
            );
        }
    }
    assert.ok(withAudio > 0, 'no theme declared audio');
});

test('manifest volume stays in an audible band', () => {
    // The shipped bug was 0.28 x a 0.3 master = 0.084 linear, about -21.5 dB
    // on top of a -24 LUFS clip. Anything below 0.35 here reintroduces it.
    const themeDir = path.join(repoRoot, 'client', 'css', 'themes');
    for (const name of fs.readdirSync(themeDir)) {
        const f = path.join(themeDir, name, 'theme.json');
        if (!fs.existsSync(f)) continue;
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!m.audio) continue;
        assert.ok(
            m.audio.volume >= 0.35 && m.audio.volume <= 1,
            `${name}: volume ${m.audio.volume} is outside the audible band 0.35..1`
        );
    }
});

test('master volume defaults to unity so the two gains cannot compound', () => {
    const { win } = loadModules();
    win.ThemeAudio.init();
    assert.equal(win.ThemeAudio.getVolume(), 1);
});

// ---------------------------------------------------------------------
// Format fallback
// ---------------------------------------------------------------------

test('candidates() puts the primary first and drops a duplicate fallback', () => {
    const { win } = loadModules();
    // Spread into a host array: the module returns one built inside the vm
    // realm, whose prototype is not this realm's Array.prototype, and
    // assert/strict compares prototypes.
    const list = (cfg) => [...win.ThemeAudioNode.candidates(cfg)];

    assert.deepEqual(list(CFG), [CFG.src, CFG.srcFallback]);
    assert.deepEqual(list({ src: 'a.m4a', srcFallback: 'a.m4a' }), ['a.m4a']);
    assert.deepEqual(list({ src: 'a.m4a' }), ['a.m4a']);
});

test('a load error retries the fallback on the SAME element', () => {
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);

    assert.equal(els.length, 1, 'exactly one element should be built');
    const el = els[0];
    assert.deepEqual([...el.loaded], [CFG.src], 'primary loads first');

    // MEDIA_ERR_SRC_NOT_SUPPORTED, exactly what iOS returns for the ogg.
    el.fireError(4);

    assert.equal(els.length, 1,
        'the retry must reuse the element: createMediaElementSource is once-only');
    assert.deepEqual([...el.loaded], [CFG.src, CFG.srcFallback],
        'the fallback must be loaded onto the same element');
});

test('an exhausted candidate list gives up instead of looping', () => {
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);
    const el = els[0];

    el.fireError(4);          // primary fails, swap to fallback
    el.fireError(4);          // fallback fails too, give up

    assert.equal(els.length, 1);
    assert.deepEqual([...el.loaded], [CFG.src, CFG.srcFallback],
        'no third load attempt');
    assert.equal(el.src, '', 'the node is torn down and the src detached');
});

test('a single-format config still errors out cleanly', () => {
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme({ src: 'only.m4a', volume: 0.5, fadeMs: 0 });
    const el = els[0];
    el.fireError(4);
    assert.deepEqual([...el.loaded], ['only.m4a']);
    assert.equal(el.src, '');
});

test('re-applying the same theme after a fallback does not restart it', () => {
    // setTheme() compares the track IDENTITY (the manifest primary), not the
    // candidate currently loaded. If it compared the loaded src, a theme
    // re-apply after a fallback would look like a track change and rebuild
    // the node, restarting the music mid-play.
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);
    els[0].fireError(4);
    assert.equal(els.length, 1);

    win.ThemeAudio.setTheme(CFG);
    assert.equal(els.length, 1, 'the same config must be a no-op, not a rebuild');
});

// ---------------------------------------------------------------------
// Silent-failure visibility
// ---------------------------------------------------------------------

/**
 * The one assertion that must await a microtask: a play() rejection is
 * only observable after the promise settles.
 *
 * @returns {Promise<void>}
 */
async function testRejectedPlayIsRecorded() {
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);

    els[0].play = function () {
        const err = new Error('gesture required');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
    };
    win.ThemeAudio.toggleMute(); // unmute -> play()

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(win.ThemeAudio.getLastPlayError(), 'NotAllowedError');
}

test('a clean play() clears the recorded error', () => {
    const { win } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);
    win.ThemeAudio.toggleMute();
    assert.equal(win.ThemeAudio.getLastPlayError(), null);
});

// ---------------------------------------------------------------------
// Stale stored settings - the upgrade bug class.
//
// These are the tests a fresh browser can never fail. Every other test in
// this file starts from an empty localStorage, which is exactly the state
// the affected user is NOT in. Up to v0.7.2 the master volume was an
// attenuator defaulting to 0.3, and a stored value overrides a default by
// construction - so raising the default to 1.0 changed nothing for anyone
// who already had a number in `cloude.audio.volume`. The migration drops
// those values; without it the fix is invisible to precisely the people
// who hit the bug.
// ---------------------------------------------------------------------

test('a stale master volume from an old build is dropped on upgrade', () => {
    // The shape of a browser that ran the old build and had setVolume()
    // called on it: a low master volume and NO version stamp.
    const { win, store } = loadModules({ 'cloude.audio.volume': '0.28' });
    win.ThemeAudio.init();

    assert.equal(
        win.ThemeAudio.getVolume(), 1,
        'a stale 0.28 master must not survive the upgrade - it re-applies ' +
        'the old inaudible gain budget on top of the new manifest volumes'
    );
    assert.ok(
        !('cloude.audio.volume' in store),
        'the stale key must be cleared, not just ignored in memory'
    );
    assert.equal(store['cloude.audio.settingsVersion'], '2');
});

test('every stale master volume below unity is dropped, not just 0.28', () => {
    for (const stale of ['0', '0.05', '0.3', '0.5', '0.99']) {
        const { win } = loadModules({ 'cloude.audio.volume': stale });
        win.ThemeAudio.init();
        assert.equal(
            win.ThemeAudio.getVolume(), 1,
            `stored master volume ${stale} survived the migration`
        );
    }
});

test('a stamped store keeps its master volume - migration is not a reset', () => {
    // Once stamped at the current version, a deliberate value is the
    // user's, and an upgrade must not keep stomping it.
    const { win } = loadModules({
        'cloude.audio.volume': '0.4',
        'cloude.audio.settingsVersion': '2'
    });
    win.ThemeAudio.init();
    assert.equal(win.ThemeAudio.getVolume(), 0.4);
});

test('migration leaves the app sound switch alone', () => {
    // Only the volume's MEANING changed. A user who had unmuted stays
    // unmuted across the upgrade.
    const { win, store } = loadModules({
        'cloude.audio.volume': '0.28',
        'cloude.audio.muted': 'false'
    });
    win.ThemeAudio.init();
    assert.equal(store['cloude.audio.muted'], 'false');
    assert.equal(win.ThemeAudio.isAppSoundOn(), true);
});

test('migration is idempotent', () => {
    const seed = { 'cloude.audio.volume': '0.28' };
    const first = loadModules(seed);
    first.win.ThemeAudio.init();
    const afterFirst = Object.assign({}, first.store);

    const second = loadModules(afterFirst);
    second.win.ThemeAudio.init();
    assert.equal(second.win.ThemeAudio.getVolume(), 1);
    assert.equal(second.store['cloude.audio.settingsVersion'], '2');
});

// ---------------------------------------------------------------------
// The two gates. A session attach must not be able to undo the header.
// ---------------------------------------------------------------------

test('a session attach cannot clobber the app sound master switch', () => {
    // The exact reported sequence: turn app sound on in the header, then
    // enter a session that never opted into music. The master used to be
    // the SAME boolean the attach drove from the per-session default of
    // OFF, so the app went silent and the header still showed itself on.
    const { win } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setAppSound(true);

    win.ThemeAudio.setSessionEnabled(false); // attach, session opted out
    assert.equal(
        win.ThemeAudio.isAppSoundOn(), true,
        'the attach silently turned the master switch off'
    );
    assert.equal(win.ThemeAudio.isMuted(), true, 'no session opt-in, so silent');

    win.ThemeAudio.setSessionEnabled(true); // the user taps "play music"
    assert.equal(win.ThemeAudio.isMuted(), false, 'both gates on must play');
});

test('sound requires BOTH gates', () => {
    const { win } = loadModules();
    win.ThemeAudio.init();

    win.ThemeAudio.setAppSound(false);
    win.ThemeAudio.setSessionEnabled(true);
    assert.equal(win.ThemeAudio.isMuted(), true, 'app sound off must win');

    win.ThemeAudio.setAppSound(true);
    win.ThemeAudio.setSessionEnabled(false);
    assert.equal(win.ThemeAudio.isMuted(), true, 'session opt-out must win');
});

test('the app sound switch persists across a reload', () => {
    const first = loadModules();
    first.win.ThemeAudio.init();
    first.win.ThemeAudio.setAppSound(true);

    const second = loadModules(first.store);
    second.win.ThemeAudio.init();
    assert.equal(second.win.ThemeAudio.isAppSoundOn(), true);
});

// ---------------------------------------------------------------------
// The element-volume trap: the actual cause of "still dont hear audio".
// ---------------------------------------------------------------------

/**
 * Build a sandbox whose AudioContext succeeds, so makeNode() takes the
 * webaudio branch. Measured in desktop Chrome 150 on 2026-08-16:
 * HTMLMediaElement.volume attenuates UPSTREAM of the graph, so with
 * el.volume=0 the output RMS is exactly 0 no matter what the GainNode
 * says. Every observable signal still looks healthy.
 *
 * @returns {{win: object, els: object[]}}
 */
function loadModulesWebAudio() {
    const els = [];
    const store = {};
    const gains = [];
    const win = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        },
        CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        document: { hidden: false, addEventListener() {}, dispatchEvent() {} },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        performance: { now: () => 0 },
        AudioContext: class {
            constructor() { this.state = 'running'; this.currentTime = 0; }
            createMediaElementSource() { return { connect: (n) => n, disconnect() {} }; }
            createGain() {
                const g = {
                    gain: {
                        value: 0,
                        cancelScheduledValues() {},
                        setValueAtTime() {},
                        linearRampToValueAtTime(v) { g.gain.value = v; }
                    },
                    connect: (n) => n,
                    disconnect() {}
                };
                gains.push(g);
                return g;
            }
            resume() { return Promise.resolve(); }
        },
        webkitAudioContext: null
    };
    win.window = win;
    win.Audio = function () { const a = new FakeAudio(); els.push(a); return a; };

    const ctx = vm.createContext(win);
    vm.runInContext(clientJs('themeAudioNode.js'), ctx);
    vm.runInContext(clientJs('themeAudioSettings.js'), ctx);
    vm.runInContext(clientJs('themeAudio.js'), ctx);
    return { win, els, gains };
}

test('webaudio mode opens the element volume so the gain node is heard', () => {
    const { win, els } = loadModulesWebAudio();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);

    assert.equal(win.ThemeAudioNode.getEngineKind(), 'webaudio');
    assert.equal(
        els[0].volume, 1,
        'element volume left at 0 multiplies the whole graph by zero: ' +
        'currentTime advances, gain reads 0.6, play() never rejects, silence'
    );
});

test('element mode still starts silent so the fade can ramp up', () => {
    // No AudioContext in this sandbox, so the element's own volume IS the
    // fade and must start at 0. The webaudio fix must not leak here.
    const { win, els } = loadModules();
    win.ThemeAudio.init();
    win.ThemeAudio.setTheme(CFG);

    assert.equal(win.ThemeAudioNode.getEngineKind(), 'element');
    assert.equal(els[0].volume, 0);
});

test('the fade reaches the manifest target, not something near zero', () => {
    const { win, gains } = loadModulesWebAudio();
    win.ThemeAudio.init();
    win.ThemeAudio.setAppSound(true);   // both gates on
    win.ThemeAudio.setTheme(CFG);

    // CFG.volume 0.6 x master 1.0. A stale master would land at 0.168.
    assert.equal(gains[0].gain.value, 0.6);
});

// ---------------------------------------------------------------------

await testRejectedPlayIsRecorded()
    .then(() => { passes++; console.log('ok - a rejected play() is recorded rather than swallowed'); })
    .catch((err) => {
        failures++;
        console.error('NOT OK - a rejected play() is recorded rather than swallowed');
        console.error(err && err.stack ? err.stack : err);
    });

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
    console.error('FAILURES');
    process.exit(1);
}
console.log('ALL PASS');
