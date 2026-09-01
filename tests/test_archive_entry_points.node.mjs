// THE ARCHIVE HAS A WAY IN, FROM TWO PLACES, THROUGH ONE IMPLEMENTATION.
//
// WHAT THIS EXISTS TO CATCH. Measured on the running app at 9d190df:
//
//   grep -rn 'archive' client/js/launchpad.js client/js/header-menu.js
//       -> no matches
//   /archive/i.test(document.body.innerText) on the launchpad
//       -> false
//   the only control in the entire DOM matching /archive/
//       -> the archive screen's own Back button
//
// The message browser shipped complete, tested, reviewed and reachable
// only by typing the URL. That failure produces no error anywhere: every
// signal except a person trying to find it says the feature is present.
// "Unreachable" and "absent" are the same thing to a user, and neither
// a unit test nor a DOM-presence assertion can tell them apart, because
// the screen itself renders perfectly once you get to it.
//
// Run with: node tests/test_archive_entry_points.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name - Test description.
 * @param {() => void} fn - Body; throwing marks it failed.
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

/**
 * Read a file under the repo root.
 * @param {...string} parts - Path segments below the repo root.
 * @returns {string} File contents.
 */
function read(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const HTML = read('client', 'index.html');
const LAUNCHPAD = read('client', 'js', 'launchpad.js');
const HEADER = read('client', 'js', 'header-menu.js');

/**
 * Load archive-entry.js into a sandbox with a stubbed history + App.
 *
 * @param {object} opts - {pathname, withApp}.
 * @returns {object} {entry, calls, ctx} - the module and what it did.
 */
function loadEntry(opts) {
    const o = opts || {};
    const calls = { pushed: [], shown: [], warned: [] };
    const fakeWindow = {
        location: { pathname: o.pathname === undefined ? '/' : o.pathname },
        history: {
            pushState(state, title, url) {
                if (o.throwOnPush) throw new Error('History API blocked');
                calls.pushed.push(url);
            }
        }
    };
    if (o.withApp !== false) {
        fakeWindow.App = { showArchive(p) { calls.shown.push(p); } };
    }
    const context = {
        window: fakeWindow,
        console: { log() {}, warn(m) { calls.warned.push(String(m)); }, error() {} },
    };
    vm.createContext(context);
    vm.runInContext(read('client', 'js', 'archive-entry.js'),
                    context, { filename: 'archive-entry.js' });
    return { entry: context.window.ArchiveEntry, calls };
}

// ---- POSITIVE CONTROL --------------------------------------------------
// Every assertion below is a substring search over source files. A
// mistyped path silently yields an empty string, and an empty string
// makes an "it is not there" assertion pass for the wrong reason - which
// is the exact defect class this whole file exists to catch, sitting
// inside the file that catches it.

test('POSITIVE CONTROL: all three source files loaded and are non-empty', () => {
    for (const [name, src] of [['index.html', HTML], ['launchpad.js', LAUNCHPAD],
                               ['header-menu.js', HEADER]]) {
        assert.ok(src.length > 1000, `${name} did not load; every check below is vacuous`);
    }
    // And a string that is definitely NOT in them, so the search itself
    // is shown capable of returning false.
    assert.ok(!HTML.includes('zzqqxyz-not-in-this-file'),
        'the substring search returns true for everything');
});

// ---- 1. THE MODULE EXISTS AND IS LOADED --------------------------------

test('archive-entry.js is registered as a script and loads before app.js', () => {
    const entry = HTML.indexOf('/static/js/archive-entry.js');
    const app = HTML.indexOf('/static/js/app.js');
    assert.ok(entry > -1, 'archive-entry.js has no <script> tag, so it never parses');
    assert.ok(app > entry, 'app.js must stay last');
});

// ---- 2. THE LAUNCHPAD ENTRY POINT --------------------------------------

test('the launchpad renders an archive row', () => {
    assert.ok(LAUNCHPAD.includes('id="launchpad-archive-entry"'),
        'the launchpad markup has no archive row at all - the archive is ' +
        'unreachable from the home screen');
    assert.ok(/\/archive|message archive/i.test(LAUNCHPAD),
        'nothing on the launchpad names the archive, so nobody can find it');
});

test('the archive row reuses .project-item rather than a bespoke card', () => {
    const at = LAUNCHPAD.indexOf('id="launchpad-archive-entry"');
    const block = LAUNCHPAD.slice(at - 300, at + 500);
    assert.ok(block.includes('project-item'),
        'the archive row does not use the app card component, so it will drift ' +
        'from every other row on the screen the first time either changes');
    assert.ok(block.includes('project-name') && block.includes('project-description'),
        'the row does not use the app label/description pair');
});

test('the archive row is reachable by keyboard', () => {
    const at = LAUNCHPAD.indexOf('id="launchpad-archive-entry"');
    const block = LAUNCHPAD.slice(at - 300, at + 500);
    // It is a div (styles.css forces a 36px box on any bare button), so
    // the semantics a real button would have given for free are carried
    // explicitly, and Enter/Space are handled in setupArchiveEntry.
    assert.ok(block.includes('role="button"'), 'the row has no button role');
    assert.ok(block.includes('tabindex="0"'), 'the row cannot be focused');
    assert.ok(/e\.key === 'Enter'/.test(LAUNCHPAD) && /' '/.test(LAUNCHPAD),
        'setupArchiveEntry does not handle Enter and Space, so the row is ' +
        'focusable but not activatable');
});

test('the launchpad wires the row, and wires it at init', () => {
    assert.ok(/setupArchiveEntry\(\)\s*\{/.test(LAUNCHPAD),
        'setupArchiveEntry is not defined');
    assert.ok(/this\.setupArchiveEntry\(\);/.test(LAUNCHPAD),
        'setupArchiveEntry is defined but never called, so the row is inert');
});

// ---- 3. THE HEADER ENTRY POINT -----------------------------------------

test('the header overflow owns an archive control', () => {
    assert.ok(HTML.includes('id="archiveBtn"'), 'index.html has no #archiveBtn');
    // Asserted against the CONTROL_IDS ARRAY, not against the file. A
    // bare substring search for 'archiveBtn' over header-menu.js also
    // matches the getElementById call inside _wireArchive, so removing
    // the id from the contract left this check green - proven by
    // mutation, which is the only reason the hole was found.
    const idsBlock = /HEADER_MENU_CONTROL_IDS = \[([\s\S]*?)\]/.exec(HEADER);
    assert.ok(idsBlock, 'header-menu.js no longer declares HEADER_MENU_CONTROL_IDS');
    assert.ok(/'archiveBtn'/.test(idsBlock[1]),
        'header-menu.js does not claim #archiveBtn in HEADER_MENU_CONTROL_IDS, so ' +
        'it is never folded into the panel and renders loose in the header row');
    assert.ok(/_wireArchive\(\)\s*\{/.test(HEADER), '#archiveBtn is never wired');
    assert.ok(/this\._wireArchive\(\);/.test(HEADER),
        '_wireArchive is defined but never called');
});

test('the header control is NOT hidden behind session state', () => {
    const at = HTML.indexOf('id="archiveBtn"');
    const tag = HTML.slice(at - 120, at + 200);
    assert.ok(!/class="[^"]*\bhidden\b/.test(tag),
        'the archive button carries class="hidden"; its neighbours are ungated ' +
        'by session state in app.js and this one would never be revealed');
});

// ---- 4. NEITHER ENTRY POINT USES AN INLINE HANDLER ---------------------
// src/main.py stamps `script-src 'self'`, which refuses an inline
// onclick SILENTLY: the element stays present, sized, visible and
// clickable while doing nothing at all, and no DOM test can see it.
// #logoutBtn was dead from the initial commit for exactly this reason.

test('neither entry point carries an inline event handler', () => {
    const at = HTML.indexOf('id="archiveBtn"');
    assert.ok(!/on[a-z]+\s*=/.test(HTML.slice(at - 120, at + 400)),
        '#archiveBtn carries an inline handler, which CSP refuses silently');
    const lp = LAUNCHPAD.indexOf('id="launchpad-archive-entry"');
    assert.ok(!/on[a-z]+\s*=\s*["']/.test(LAUNCHPAD.slice(lp - 200, lp + 500)),
        'the launchpad archive row carries an inline handler');
});

// ---- 5. ONE IMPLEMENTATION, NOT TWO ------------------------------------
// Two copies of a navigation is two copies that can drift: one gains a
// guard, or a route parameter, or a different history mode, and from
// then on the two doors lead to different places with nothing to say so.

test('both entry points route through window.ArchiveEntry', () => {
    assert.ok(/window\.ArchiveEntry/.test(LAUNCHPAD),
        'the launchpad navigates to the archive by some other means');
    assert.ok(/window\.ArchiveEntry/.test(HEADER),
        'the header navigates to the archive by some other means');
    // Neither may call showArchive or pushState itself.
    for (const [name, src] of [['launchpad.js', LAUNCHPAD], ['header-menu.js', HEADER]]) {
        assert.ok(!/showArchive/.test(src),
            `${name} calls App.showArchive directly, bypassing the one entry point`);
    }
});

// ---- 6. THE ENTRY POINT ACTUALLY NAVIGATES -----------------------------

test('open() writes the address bar and then shows the screen', () => {
    const { entry, calls } = loadEntry({ pathname: '/' });
    assert.equal(entry.open(), true);
    assert.deepEqual(calls.pushed, ['/archive'], 'the URL was not written');
    assert.equal(calls.shown.length, 1, 'the screen was not shown');
});

test('open() does not push a duplicate history entry when already there', () => {
    const { entry, calls } = loadEntry({ pathname: '/archive' });
    entry.open();
    assert.deepEqual(calls.pushed, [],
        're-entering the archive adds a redundant Back-button target');
    assert.equal(calls.shown.length, 1, 'the screen must still be shown');
});

test('a blocked History API does not block the navigation', () => {
    // Sandboxed iframes throw on pushState. router.js already swallows
    // exactly this. A wrong address bar is strictly smaller than a
    // screen that will not open.
    const { entry, calls } = loadEntry({ pathname: '/', throwOnPush: true });
    assert.equal(entry.open(), true, 'a History exception aborted the navigation');
    assert.equal(calls.shown.length, 1);
});

test('a missing app shell is reported, not silently swallowed', () => {
    // THREE OUTCOMES. "I navigated", "I could not navigate", and never a
    // quiet false that reads like success to the caller.
    const { entry, calls } = loadEntry({ pathname: '/', withApp: false });
    assert.equal(entry.open(), false,
        'open() claims success with no App to show anything');
    assert.equal(calls.shown.length, 0);
    assert.ok(calls.warned.length > 0, 'a dead entry point produced no diagnostic');
});

test('the route matches the router prefix', () => {
    const { entry } = loadEntry({});
    const router = read('client', 'js', 'router.js');
    assert.match(router, new RegExp(`ARCHIVE_PREFIX = '${entry.PATH}'`),
        `ArchiveEntry.PATH (${entry.PATH}) does not match router.js's ARCHIVE_PREFIX, ` +
        'so the entry point navigates somewhere the router will not parse');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
