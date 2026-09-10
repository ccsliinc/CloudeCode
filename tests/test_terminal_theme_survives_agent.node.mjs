// A PINNED TERMINAL MUST KEEP ITS PALETTE WHEN THE SESSION IS RE-ENTERED.
//
// WHAT THIS EXISTS TO CATCH, reported by the owner on 2026-09-09 with
// screenshots: a session pinned to snes showed snes colours the moment it was
// picked, and a dark terminal in a snes-coloured page after leaving and
// coming back. Only the terminal reverted; the chrome around it was correct,
// which is what made it look like a terminal bug rather than a theme bug.
//
// It was neither. The terminal had TWO writers. theme-navigation.js painted
// the session's pin, and app.js then called Themes.applySession(agent_type),
// which painted the AGENT's manifest over the top. Whichever ran last won,
// and app.js always ran last. Measured against the shipped snes and claude
// manifests before the fix:
//
//     after picking snes    background #3A3A40  cyan #3CC4B5
//     after leave + return  background #1e1e1e  cyan #11a8cd   <- claude
//
// while <html data-theme> still read `snes` the whole time.
//
// WHAT THIS FILE RUNS, rather than reads. The REAL client/js/themes/
// registry.js, client/js/theme-navigation.js and client/js/app.js are
// executed in a vm sandbox, fed the REAL client/css/themes/*/theme.json
// manifests, and driven through the REAL App.showTerminal /
// App.returnToExistingTerminal / App.showLaunchpad. The assertions read the
// palettes the registry actually fired at its xterm subscribers - the same
// channel terminal.js subscribes to - so a fix that only changed a decision
// without changing the palette would fail here.
//
// tests/test_theme_follows_navigation.node.mjs covers the same navigation
// with a STUBBED registry, which is why it could not see this: the overwrite
// happened inside the registry the stub replaced.
//
// THE THREE-OUTCOME CAVEAT, STATED RATHER THAN IMPLIED. This proves which
// palette object reaches xterm. It does NOT prove a pixel changed: a vm
// sandbox has no cascade, no renderer and no canvas. The rendered half is
// measured in a real Chromium in
// tests/test_terminal_theme_survives_agent_renders.py, and this file is not
// a substitute for it.
//
// Run with: node tests/test_terminal_theme_survives_agent.node.mjs
// Exits 0 and prints ALL PASS on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

const queued = [];

/**
 * Description: queue one named assertion block. Every test here is async
 *   (Themes.init() fetches its manifests), so they are collected and awaited
 *   in order by run() at the bottom rather than executed on registration.
 *   Calling an async fn() inside a try/catch does NOT catch its rejection,
 *   which would silently report a failing suite as green.
 * Inputs: name (string), fn (function) - may be async.
 * Output: void.
 */
function test(name, fn) {
    queued.push({ name, fn });
}

/**
 * Description: run every queued test in order, recording outcomes rather
 *   than throwing, so every test reports even after one fails.
 * Inputs: none.
 * Output: Promise<void>.
 */
async function run() {
    for (const { name, fn } of queued) {
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
}

/**
 * Description: read one shipped theme manifest off disk.
 * Inputs: id (string) - the theme id, e.g. 'snes'.
 * Output: object - the manifest, marked `source: 'builtin'` exactly as the
 *   server marks a bundled theme.
 * Example: manifest('snes').xterm.background === '#3A3A40'
 */
function manifest(id) {
    const m = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'client', 'css', 'themes', id, 'theme.json'), 'utf8'));
    m.source = 'builtin';
    return m;
}

const SNES = manifest('snes');
const CLAUDE = manifest('claude');
const MATRIX = manifest('matrix');

/**
 * Description: a DOM element stand-in that actually RECORDS inline custom
 *   properties, because "which CSS variables are on #terminal-screen" is
 *   half of what this file is asserting. The stub in the sibling suite has
 *   a no-op style object, which cannot see a leaked variable.
 * Inputs: none.
 * Output: object - the fake element, with `inline` (a Map) readable by tests.
 */
function makeEl() {
    const classes = new Set();
    const inline = new Map();
    return {
        inline,
        dataset: {},
        hidden: false,
        textContent: '',
        innerHTML: '',
        classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            contains(c) { return classes.has(c); },
            toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
        },
        style: {
            setProperty(k, v) { inline.set(k, v); },
            removeProperty(k) { inline.delete(k); },
        },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        appendChild() {},
        removeChild() {},
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
}

/**
 * Description: boot the REAL registry, navigation module and app.js in one
 *   sandbox and hand back the pieces a test drives.
 * Inputs: opts (object|null) -
 *   - storedTheme (string) - the user's own global theme. Default 'claude'.
 *   - themes (array) - manifests the theme endpoint serves. Default
 *     [claude, snes, matrix].
 * Output: object - {app, Themes, ThemeNavigation, fired, screen, docEl,
 *   lastPalette()}.
 *
 * The effects allowlist is seeded to `false` for every theme so the consent
 * modal and the dynamic effects import stay out of the way; this file is
 * about palettes, and effects consent is covered by its own suite.
 */
function boot(opts) {
    const o = opts || {};
    const rows = o.themes || [CLAUDE, SNES, MATRIX];

    const els = {};
    function el(id) {
        if (!els[id]) els[id] = makeEl();
        return els[id];
    }
    const docEl = makeEl();
    const doc = {
        title: '',
        body: makeEl(),
        documentElement: docEl,
        getElementById(id) { return el(id); },
        querySelector(sel) { return el('sel:' + sel); },
        querySelectorAll() { return []; },
        createElement() { return makeEl(); },
        addEventListener() {},
    };

    const store = new Map();
    store.set('cloude.theme', o.storedTheme === undefined ? 'claude' : o.storedTheme);
    const allowlist = {};
    rows.forEach((m) => { allowlist[m.id] = false; });
    store.set('cloude.themeJsAllowlist', JSON.stringify(allowlist));

    const patched = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: doc,
        localStorage: {
            getItem(k) { return store.has(k) ? store.get(k) : null; },
            setItem(k, v) { store.set(k, String(v)); },
            removeItem(k) { store.delete(k); },
        },
        setTimeout: () => 0,
        setInterval: () => 0,
        clearTimeout() {},
        clearInterval() {},
        addEventListener() {},
        location: { pathname: '/' },
        history: { pushState() {}, replaceState() {} },
        Set, Map, Object, Array, JSON, Promise, Error, String, Number,
        Boolean, RegExp,
        fetch(url, init) {
            if (String(url).indexOf('/api/v1/themes') === 0) {
                return Promise.resolve({
                    ok: true, status: 200,
                    json: () => Promise.resolve(rows),
                });
            }
            // The per-session pin PATCH. Recorded so a test can prove the
            // picker persisted the choice against the tmux name.
            patched.push({ url: String(url), body: init && init.body });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const load = (rel) => vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', rel), 'utf8'),
        sandbox, { filename: rel });
    // Same order as index.html: registry, then navigation, then app.
    load('themes/registry.js');
    load('theme-navigation.js');
    load('app.js');

    sandbox.ScreenChrome = { apply() {} };
    sandbox.TerminalController = {
        term: {},
        pauseForHome() {},
        connectToSession: () => Promise.resolve(),
        reconnectToExistingSession: () => Promise.resolve(),
    };
    sandbox.SessionSidebar = { hide() {}, show() {}, setActiveSession() {} };
    sandbox.Router = { resetToLauncher() {} };
    sandbox.Launchpad = {
        render: () => Promise.resolve(), show: () => Promise.resolve(),
        init: () => Promise.resolve(), loadProjects: () => Promise.resolve(),
        renderLaunchpadUI() {},
    };
    sandbox.DPad = { floatingButton: {}, init() {}, show() {}, hide() {} };
    sandbox.SlashCommandsModal = {
        button: {}, init: () => Promise.resolve(), hide() {}, show() {},
    };
    sandbox.GlobalAudioToggle = { place() {}, syncForSession() {} };

    const app = sandbox.App;
    app.logoutBtn = makeEl();
    app.settingsBtn = makeEl();
    app.configEditorBtn = makeEl();
    app._placeStatusLight = () => {};
    app._syncSessionUrl = () => {};
    app._consumeStashedArchiveRoute = () => false;
    app.currentScreen = 'launchpad';

    // The recording subscriber. This is the SAME channel terminal.js
    // subscribes to, so what lands here is what xterm would be handed.
    const fired = [];
    sandbox.Themes.onXtermThemeChange((p) => fired.push(p));

    return {
        app,
        Themes: sandbox.Themes,
        ThemeNavigation: sandbox.ThemeNavigation,
        fired,
        patched,
        docEl,
        screen: el('terminal-screen'),
        lastPalette: () => fired[fired.length - 1] || {},
    };
}

/**
 * Description: build a `/sessions/list` style SessionInfo wrapper.
 * Inputs: name (string) - bare tmux name. pin (string|null) - pinned theme.
 *   agent (string|null) - agent_type. id (string|null) - session id.
 * Output: object - the SessionInfo wrapper.
 *
 * `pinned_theme`, `tmux_session` and `agent_type` sit on the WRAPPER; `id`
 * sits on the nested `.session`. Shaped like the real payload rather than
 * flattened, because getting that level wrong is this project's most
 * repeated bug.
 */
function sessionInfo(name, pin, agent, id) {
    return {
        tmux_session: name,
        pinned_theme: pin,
        agent_type: agent === undefined ? null : agent,
        label: name,
        session: { id: id || name, working_dir: '/tmp', pty_pid: 1 },
    };
}

/**
 * Description: run an async App navigation for its SYNCHRONOUS effects only.
 * Inputs: promise (Promise).
 * Output: void.
 *
 * Every theme decision happens before the first await in both session-entry
 * methods, so the recording is complete the moment the call returns.
 */
function swallow(promise) {
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
}

/**
 * Description: assert a fired palette is a named manifest's, key for key.
 * Inputs: actual (object) - the palette handed to the xterm subscribers.
 *   expected (object) - a manifest's `xterm` block. what (string) - the
 *   sentence printed on failure.
 * Output: void - throws on mismatch.
 *
 * Compares EVERY key rather than the background alone. A partial merge that
 * got the background right and left stale ANSI colours behind would satisfy
 * a background-only check and still look wrong on screen.
 */
function assertPalette(actual, expected, what) {
    Object.keys(expected).forEach((k) => {
        assert.equal(actual[k], expected[k],
            `${what}: xterm.${k} should be ${expected[k]}, got ${actual[k]}`);
    });
}

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG, END TO END, WITH THE REAL MANIFESTS.
// ---------------------------------------------------------------------------
test('a snes-pinned session keeps its terminal palette across leave and return', async () => {
    const t = boot({});
    await t.Themes.init();
    const info = sessionInfo('cloude_snes', 'snes', 'claude');

    // Enter, then pick snes from the in-session picker.
    swallow(t.app.showTerminal(info, {}));
    t.Themes.applyGlobal('snes');
    assertPalette(t.lastPalette(), SNES.xterm, 'immediately after the pick');
    assert.equal(t.screen.dataset.sessionTheme, 'snes',
        'the pick must move the terminal CSS scope too, not only the palette');

    // Leave to the launchpad and come back.
    t.app.showLaunchpad();
    swallow(t.app.returnToExistingTerminal(info));

    assertPalette(t.lastPalette(), SNES.xterm,
        'after leaving and returning - this is the reported defect');
    assert.equal(t.docEl.dataset.theme, 'snes',
        'the page theme was never the broken half');
    assert.equal(t.screen.dataset.sessionTheme, 'snes',
        'the agent must not take the terminal scope back on re-entry');
});

// ---------------------------------------------------------------------------
// 2. THE FALLBACK THE FIX MUST NOT EAT. An unpinned session still follows
//    its agent; that behaviour is intentional and predates the defect.
// ---------------------------------------------------------------------------
test('an UNPINNED session still wears its agent theme', async () => {
    const t = boot({ storedTheme: 'snes' });
    await t.Themes.init();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', null, 'claude')));
    assertPalette(t.lastPalette(), CLAUDE.xterm,
        'an unpinned session follows its agent');
    assert.equal(t.docEl.dataset.theme, 'snes',
        'the PAGE still follows the user global theme; only the terminal '
        + 'follows the agent');
});

test('a null agent and an unknown agent both hand the terminal to the global theme', async () => {
    for (const agent of [null, 'no-such-agent-1234']) {
        const t = boot({ storedTheme: 'snes' });
        await t.Themes.init();
        swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', null, agent)));
        assertPalette(t.lastPalette(), SNES.xterm,
            `agent ${String(agent)} has no manifest, so the global theme governs`);
        assert.equal(t.screen.dataset.sessionTheme, undefined,
            'no session scope may be left on the screen');
        assert.equal(t.screen.inline.size, 0,
            'and no scoped CSS variable may be left behind either');
    }
});

// ---------------------------------------------------------------------------
// 3. THE MATRIX THE PLAN ASKS FOR.
// ---------------------------------------------------------------------------
test('A/B/A: snes -> a differently themed session -> snes', async () => {
    const t = boot({});
    await t.Themes.init();
    const a = sessionInfo('cloude_a', 'snes', 'claude');
    const b = sessionInfo('cloude_b', 'matrix', 'claude');

    swallow(t.app.returnToExistingTerminal(a));
    assertPalette(t.lastPalette(), SNES.xterm, 'A');
    swallow(t.app.returnToExistingTerminal(b));
    assertPalette(t.lastPalette(), MATRIX.xterm, 'B');
    swallow(t.app.returnToExistingTerminal(a));
    assertPalette(t.lastPalette(), SNES.xterm, 'back to A');
    assert.equal(t.screen.dataset.sessionTheme, 'snes');
});

test('no scoped CSS variable from the previous owner survives a switch', async () => {
    const t = boot({});
    await t.Themes.init();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', 'matrix', 'claude')));
    const matrixOnly = Object.keys(MATRIX.cssVars || {})
        .filter((k) => !(SNES.cssVars || {})[k]);
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_b', 'snes', 'claude')));

    matrixOnly.forEach((k) => {
        assert.equal(t.screen.inline.has(k), false,
            `${k} belongs to the outgoing theme and must be removed, not orphaned`);
    });
    Object.keys(SNES.cssVars || {}).forEach((k) => {
        assert.equal(t.screen.inline.get(k), SNES.cssVars[k],
            `${k} must carry the incoming theme's value`);
    });
});

test('first attach: a terminal built AFTER the paint seeds from the session theme', async () => {
    const t = boot({});
    await t.Themes.init();
    // showTerminal() paints the theme and then constructs the terminal, so
    // the seed terminal.js reads must already be the session's, not the
    // page's. getActiveTerminalManifest() is what terminal.js seeds from.
    swallow(t.app.showTerminal(sessionInfo('cloude_a', 'snes', 'claude'), {}));
    assertPalette(t.Themes.getActiveTerminalManifest().xterm, SNES.xterm,
        'the seed a freshly constructed xterm would read');
    assert.equal(t.Themes.getActiveGlobal().id, 'snes',
        'and the page manifest agrees here because the pin IS the page theme');
});

test('an unpinned first attach seeds from the AGENT, not the page', async () => {
    const t = boot({ storedTheme: 'snes' });
    await t.Themes.init();
    swallow(t.app.showTerminal(sessionInfo('cloude_a', null, 'claude'), {}));
    assertPalette(t.Themes.getActiveTerminalManifest().xterm, CLAUDE.xterm,
        'the terminal seed follows the agent');
    assert.equal(t.Themes.getActiveGlobal().id, 'snes',
        'while the page keeps the user global theme - the two DISAGREE here, '
        + 'which is precisely why seeding from getActiveGlobal() was wrong');
});

test('going home drops the session scope, and returning restores the pin', async () => {
    const t = boot({});
    await t.Themes.init();
    const info = sessionInfo('cloude_a', 'snes', 'claude');
    swallow(t.app.returnToExistingTerminal(info));
    t.app.showLaunchpad();
    assertPalette(t.lastPalette(), CLAUDE.xterm,
        'the launchpad is not a session, so the global theme governs xterm');
    assert.equal(t.screen.dataset.sessionTheme, undefined);
    assert.equal(t.screen.inline.size, 0);

    swallow(t.app.returnToExistingTerminal(info));
    assertPalette(t.lastPalette(), SNES.xterm, 'and the pin comes back');
});

test('PIN REMOVAL: a session whose pin is gone falls back to its agent', async () => {
    const t = boot({});
    await t.Themes.init();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', 'snes', 'claude')));
    assertPalette(t.lastPalette(), SNES.xterm, 'pinned');

    // The server no longer reports a pin for this session.
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', null, 'claude')));
    assertPalette(t.lastPalette(), CLAUDE.xterm,
        'removing the pin must release the terminal to the agent, not strand '
        + 'it on the theme that was pinned a moment ago');
    assert.equal(t.screen.dataset.sessionTheme, 'claude');
});

test('a pin naming an UNAVAILABLE theme falls back without stranding the terminal', async () => {
    const t = boot({});
    await t.Themes.init();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', 'snes', 'claude')));
    swallow(t.app.returnToExistingTerminal(
        sessionInfo('cloude_b', 'uninstalled-theme', 'claude')));
    // The page fell back to the user's global theme; the terminal must fall
    // back on the same evidence rather than keeping the previous session's.
    assert.equal(t.docEl.dataset.theme, 'claude');
    assertPalette(t.lastPalette(), CLAUDE.xterm,
        'an unknown pin must not leave the previous session\'s palette up');
});

test('RAPID SWITCHING: the last navigation wins, every time', async () => {
    const t = boot({});
    await t.Themes.init();
    const order = ['snes', 'matrix', 'snes', 'matrix', 'snes'];
    order.forEach((id, i) => {
        swallow(t.app.returnToExistingTerminal(
            sessionInfo('cloude_' + i, id, 'claude')));
    });
    assertPalette(t.lastPalette(), SNES.xterm, 'the last target');
    assert.equal(t.screen.dataset.sessionTheme, 'snes');
});

test('a PICKER CHANGE is durable: it survives leaving and returning', async () => {
    const t = boot({});
    await t.Themes.init();
    const info = sessionInfo('cloude_a', null, 'claude');
    swallow(t.app.returnToExistingTerminal(info));
    assertPalette(t.lastPalette(), CLAUDE.xterm, 'unpinned, so the agent');

    // The user picks snes from the in-session picker.
    t.Themes.applyGlobal('snes');
    assertPalette(t.lastPalette(), SNES.xterm, 'the pick takes effect at once');
    assert.equal(t.screen.dataset.sessionTheme, 'snes',
        'and it takes the CSS scope off the agent, not just the palette');
    assert.ok(t.patched.some((p) => p.url.indexOf('cloude_a') >= 0),
        'the pick must be PATCHed against the tmux name so the server can '
        + 'report it as the pin on the next visit');

    // The server now reports the pin, which is what makes it durable.
    t.app.showLaunchpad();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', 'snes', 'claude')));
    assertPalette(t.lastPalette(), SNES.xterm,
        'leaving and returning must not undo a saved choice');
});

test('a picker change mid-replay is not undone by the replay finishing', async () => {
    const t = boot({});
    await t.Themes.init();
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_a', null, 'claude')));

    // A replay starts; a terminal paint that lands now is deferred.
    t.Themes.setReplayInProgress(true);
    swallow(t.app.returnToExistingTerminal(sessionInfo('cloude_b', null, 'claude')));
    // The user picks snes WHILE the replay is still running.
    t.Themes.applyGlobal('snes');
    // The replay finishes and the deferred paint runs.
    t.Themes.setReplayInProgress(false);

    assertPalette(t.lastPalette(), SNES.xterm,
        'the deferred paint must re-resolve on drain; replaying the agent id '
        + 'it was deferred with would repaint the theme the user just left');
    assert.equal(t.screen.dataset.sessionTheme, 'snes');
});

test('RECONNECT: re-entering the same session repeatedly is idempotent', async () => {
    const t = boot({});
    await t.Themes.init();
    const info = sessionInfo('cloude_a', 'snes', 'claude');
    for (let i = 0; i < 3; i++) {
        swallow(t.app.returnToExistingTerminal(info));
        assertPalette(t.lastPalette(), SNES.xterm, `re-entry ${i + 1}`);
    }
    Object.keys(SNES.cssVars || {}).forEach((k) => {
        assert.equal(t.screen.inline.get(k), SNES.cssVars[k]);
    });
    assert.equal(t.screen.inline.size, Object.keys(SNES.cssVars || {}).length,
        'repeated entry must not accumulate variables');
});

// ---------------------------------------------------------------------------
// 4. THE NEGATIVE CONTROL. A resolver that always answered with the pin
//    would pass every test above and break the agent fallback, so the
//    ordering is asserted directly.
// ---------------------------------------------------------------------------
test('the resolution is pin over agent over global, and nothing else', async () => {
    const t = boot({ storedTheme: 'matrix' });
    await t.Themes.init();

    t.Themes.applySessionScope({ pinnedTheme: 'snes', agentType: 'claude' });
    assert.equal(t.Themes.resolveTerminalThemeId(), 'snes', 'pin wins');

    t.Themes.applySessionScope({ pinnedTheme: null, agentType: 'claude' });
    assert.equal(t.Themes.resolveTerminalThemeId(), 'claude', 'agent is next');

    t.Themes.applySessionScope({ pinnedTheme: null, agentType: null });
    assert.equal(t.Themes.resolveTerminalThemeId(), null,
        'with neither, the global theme governs and there is no session theme');

    t.Themes.applySessionScope({ pinnedTheme: 'nope', agentType: 'claude' });
    assert.equal(t.Themes.resolveTerminalThemeId(), 'claude',
        'a pin no manifest matches is not a choice, so the agent takes it');
});

await run();

if (failures > 0) {
    console.error(`\n${failures} FAILED, ${passes} passed`);
    process.exit(1);
}
console.log(`\nALL PASS - ${passes} assertions`);
