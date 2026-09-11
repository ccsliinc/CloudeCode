// Put the REAL compiled bundle into a node test's vm sandbox.
//
// WHY THIS EXISTS. Slice 3 of the launchpad migration moved the whole
// session data layer into web/src/lib/sessions/, and the fields the
// still-legacy renderers read (`projects`, `runningSessions`, the two
// attribution maps, the work-stamp index and the three listing latches)
// are ACCESSOR PROPERTIES on `Launchpad.prototype` that delegate to that
// one store. There is deliberately no fallback object behind them: an
// accessor that quietly fell back to a local field when the bundle was
// missing would be a SECOND data owner, and two copies of a session list
// answer differently the moment either one is written to. So a harness
// that drives those fields has to provide the store.
//
// IT LOADS THE REAL ARTIFACT, NOT A STUB, AND THAT IS THE POINT. A stub
// store would be a second implementation of the thing under test, and it
// would agree with whatever it was built to agree with.
// `client/dist/app.js` is committed and `scripts/web-build-check.sh`
// keeps it current, so these tests exercise the shipped path.
// tests/test_session_row_menu_superset.node.mjs already does exactly
// this for the plugin registry; this is the same move, factored out.
//
// EACH SANDBOX GETS ITS OWN EVALUATION, so each test file holds its own
// store and cannot leak rows into the next one. That is a property of vm
// contexts, not something this helper arranges.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { glyphSvg } from '../../client/js/icons/glyphs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const BUNDLE = path.join(ROOT, 'client', 'dist', 'app.js');

/**
 * Description: read the committed bundle once per process.
 * Inputs: none. Output: string - the bundle source.
 */
let cached = null;
function bundleSource() {
    if (cached === null) cached = fs.readFileSync(BUNDLE, 'utf8');
    return cached;
}

/**
 * Evaluate client/dist/app.js inside an existing vm context.
 *
 * Description: the bundle is emitted with no `import` and no `export`, so
 *   it runs as a classic script in the same sandbox the legacy files run
 *   in and publishes the real `window.CloudeWeb` onto that context's
 *   window. It REFUSES to run twice against one window, by its own
 *   design, so this is a no-op when the namespace is already there.
 *
 *   The bundle needs `window`, `document` and a `console` carrying
 *   `warn`. A sandbox missing `console.warn` fails the whole evaluation
 *   rather than one call, which is how an unrelated test broke once; this
 *   fills the gap rather than letting that recur silently.
 * Inputs: context (vm context) - as returned by vm.createContext.
 * Output: object - the published window.CloudeWeb.
 * Example:
 *   const context = vm.createContext(sandbox);
 *   installCloudeWeb(context);
 */
export function installCloudeWeb(context) {
    // A SANDBOX WITH NO `window` GETS ONE POINTING AT ITSELF, which is
    // the shape a browser has. The bundle assigns `window.CloudeWeb` at
    // its last statement, and in a vm realm a bare `window` that was never
    // defined is a ReferenceError rather than an undefined - so a context
    // built for a pure-logic test throws from deep inside minified Svelte
    // and says nothing useful. This is the minimum host, not a DOM: there
    // is still no `Element`, and a test that mounts a component needs one.
    if (!context.window) context.window = context;
    const win = context.window;
    if (win.CloudeWeb) return win.CloudeWeb;
    if (!win.console) win.console = context.console || console;
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        if (typeof win.console[level] !== 'function') win.console[level] = () => {};
    }
    // SVELTE 5's RUNE RUNTIME SCHEDULES, so a `$state` write reaches
    // `queueMicrotask`. A vm context is not a browser and carries none of
    // the host's timing globals, so a harness that omitted them saw the
    // bundle throw ReferenceError from inside a plain property set. These
    // are supplied on the CONTEXT rather than faked, so the scheduling is
    // real: a test that starts the 5s poller gets a real interval and has
    // to clear it, which is the behaviour under test.
    for (const [name, impl] of [
        ['queueMicrotask', queueMicrotask],
        ['setTimeout', setTimeout],
        ['clearTimeout', clearTimeout],
        ['setInterval', setInterval],
        ['clearInterval', clearInterval],
    ]) {
        if (typeof context[name] !== 'function') context[name] = impl;
        if (win !== context && typeof win[name] !== 'function') win[name] = impl;
    }
    if (typeof context.requestAnimationFrame !== 'function') {
        context.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    }
    // THE LOCALE LADDER READS BOTH OF THESE, lazily, the first time
    // anything asks for a string: an override in
    // `localStorage['cloude.locale']`, then `navigator.languages`. Absent,
    // they throw from inside a `t()` call rather than falling back, and
    // the failure surfaces somewhere with no obvious connection to copy.
    // A missing preference and a missing navigator both mean the same
    // thing here, which is "take the default locale".
    if (!context.navigator) context.navigator = { languages: ['en'], language: 'en' };
    if (win !== context && !win.navigator) win.navigator = context.navigator;
    if (!context.localStorage) {
        context.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    }
    if (win !== context && !win.localStorage) win.localStorage = context.localStorage;
    // THE SHARED ICON GEOMETRY, published the way `client/js/i18n/boot.js`
    // publishes it in a browser. `client/js/session-status-ui.js` is a
    // CLASSIC script and cannot import, so every icon it hands back reads
    // its coordinates from `globalThis.CloudeGlyphs` at call time. Slice 5
    // moved close, trash, restart and the two envelopes into that data
    // alongside the pencil and the archive box - one set of coordinates,
    // two renderers - so a sandbox without it gets the empty string from
    // every builder and a test that looked for an `<svg>` fails for a
    // reason that has nothing to do with what it is measuring.
    if (!context.CloudeGlyphs) context.CloudeGlyphs = { glyphSvg };
    if (win !== context && !win.CloudeGlyphs) win.CloudeGlyphs = context.CloudeGlyphs;
    vm.runInContext(bundleSource(), context);
    return win.CloudeWeb;
}

/**
 * Reset the store a previous test in this sandbox filled.
 *
 * Description: `reset()` puts every held fetch back to its NEVER-ASKED
 *   value, which is not the same as an empty one - a cleared store must
 *   not be able to claim a group is measurably empty. It also stops the
 *   5s tick, so a test that started one cannot leave a timer behind.
 * Inputs: cloudeWeb (object) - what installCloudeWeb returned.
 * Output: void.
 * Example: resetSessionStore(win.CloudeWeb);
 */
export function resetSessionStore(cloudeWeb) {
    if (cloudeWeb && cloudeWeb.launchpad && cloudeWeb.launchpad.sessions) {
        cloudeWeb.launchpad.sessions.reset();
    }
}

/**
 * Replace the THREE Svelte panel mounts with counting no-ops.
 *
 * Description: MOUNTING IS A DIFFERENT THING FROM READING THE STORE, and
 *   only one of them needs a real browser. `mountRecentSessions`,
 *   `mountAttributionPrompt` and (since slice 4) `mountProjectTree` put
 *   compiled Svelte components into the document, so they reach for
 *   `Element` and everything under it; a vm sandbox with a hand-built
 *   fake document throws from inside Svelte's own mount, which says
 *   nothing about the thing a launchpad harness is usually measuring.
 *
 *   USE THIS ONLY WHEN THE TEST DOES NOT MEASURE THOSE TWO PANELS. Their
 *   own behaviour is covered by the vitest suite, which has a real DOM.
 *   Stubbing them in a harness that DID measure them would be a test
 *   agreeing with its own fixture. The counts are returned so a caller
 *   can still assert the call happened.
 * Inputs: cloudeWeb (object) - what installCloudeWeb returned.
 * Output: object - {recent, attribution, projectTree} call counts, live.
 * Example: const mounts = stubPanelMounts(win.CloudeWeb);
 */
export function stubPanelMounts(cloudeWeb) {
    const counts = { recent: 0, attribution: 0, projectTree: 0 };
    if (!cloudeWeb || !cloudeWeb.launchpad) return counts;
    cloudeWeb.launchpad.mountRecentSessions = () => { counts.recent++; };
    cloudeWeb.launchpad.mountAttributionPrompt = () => { counts.attribution++; };
    // SLICE 4. `Launchpad.renderProjectList()` is now ONE call to this,
    // so a harness that does not stub it throws on every code path that
    // used to paint the tree - including several that never looked at
    // the tree at all. The project tree's own behaviour is measured in
    // web/src/lib/launchpad/ProjectTree.behaviour.test.ts, which has a
    // real DOM.
    cloudeWeb.launchpad.mountProjectTree = () => { counts.projectTree++; };
    return counts;
}
