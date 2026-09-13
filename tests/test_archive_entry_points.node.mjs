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
// SLICE 7: `client/js/launchpad.js` is gone; the home screen's body is
// the Svelte shell and the modules beside it. The claim - the archive
// costs the body no space and has exactly one entry point, the header
// icon - is unchanged.
const { HOME_ALL_SRC: LAUNCHPAD } = await import('./lib-home-source.mjs');
const HEADER = read('client', 'js', 'header-menu.js');

// THE BEHAVIOURAL HALF OF THIS FILE MOVED, AND ONLY THE BEHAVIOURAL
// HALF. `archive-entry.js` is now web/src/lib/plugins/history/, behind
// the `app-screen` plugin surface, so the cases that LOADED it and drove
// `open()`, `close()` and `ensure()` moved with it to
// web/src/lib/plugins/history/screen.test.ts - rule 8.3 of
// docs/history-archive-scope.md, a suite is ported in the slice that
// moves its subject.
//
// WHAT STAYED IS EVERYTHING BELOW: source assertions about
// client/index.html, the home screen and client/js/header-menu.js, none
// of which moved in this slice. They are the guard against a SECOND door
// onto the archive growing back, and their subject is exactly those
// files. Moving them into vitest would have left a Svelte test reading
// client/index.html, which is a worse home than the one they have.

// ---- POSITIVE CONTROL --------------------------------------------------
// Every assertion below is a substring search over source files. A
// mistyped path silently yields an empty string, and an empty string
// makes an "it is not there" assertion pass for the wrong reason - which
// is the exact defect class this whole file exists to catch, sitting
// inside the file that catches it.

test('POSITIVE CONTROL: all three source files loaded and are non-empty', () => {
    for (const [name, src] of [['index.html', HTML], ['the home screen', LAUNCHPAD],
                               ['header-menu.js', HEADER]]) {
        assert.ok(src.length > 1000, `${name} did not load; every check below is vacuous`);
    }
    // And a string that is definitely NOT in them, so the search itself
    // is shown capable of returning false.
    assert.ok(!HTML.includes('zzqqxyz-not-in-this-file'),
        'the substring search returns true for everything');
});

// ---- 1. THE MODULE EXISTS AND IS LOADED --------------------------------

test('the way in is COMPILED, and no stale script tag was left behind', () => {
    // INVERTED IN THIS SLICE, AND THE INVERSION IS THE POINT. It used to
    // assert `/static/js/archive-entry.js` HAD a tag and preceded app.js.
    // That module is now compiled into the bundle, so the tag must be
    // GONE - a tag left pointing at a deleted file is a 404 on every page
    // load and a silently absent entry point.
    // MATCHED AS A TAG, NOT AS A SUBSTRING. Every one of these paths is
    // also NAMED in a comment in index.html explaining where the module
    // went, and a bare `includes` would fail on the explanation rather
    // than on a real tag - which is the false positive this file's own
    // positive control exists to make visible.
    const tagFor = (src) => new RegExp(
        '<script[^>]*\\ssrc=["\']' + src.replace(/[/.]/g, '\\$&') + '["\']');
    for (const gone of ['/static/js/archive-entry.js',
                        '/static/js/archive-deeplink.js',
                        '/static/js/archive-crumb.js',
                        '/static/js/archive-crumb-resolve.js']) {
        assert.ok(!tagFor(gone).test(HTML),
            `${gone} still has a <script> tag, but the file is deleted`);
    }
    // And the thing that replaced them IS loaded, so this is not passing
    // by the archive having no way in at all.
    const bundle = HTML.search(tagFor('/static/dist/app.js'));
    const app = HTML.search(tagFor('/static/js/app.js'));
    assert.ok(bundle > -1, 'the compiled bundle has no <script> tag');
    assert.ok(app > -1, 'app.js has no <script> tag');
    assert.ok(bundle > app, 'the bundle must load after app.js');
});

// ---- 2. THE LAUNCHPAD BODY ROW IS GONE, ON PURPOSE --------------------
// It was a full-width .project-item card with a title and a description,
// under its own section heading, costing four lines of vertical space on
// every visit to the home screen. The owner asked for the archive as a
// header ICON instead ("dont waste page space"), and one entry point that
// is present on EVERY screen beats one that is present on one screen.
// These assertions are the guard against it creeping back: two doors onto
// the same feature switch is two gates to keep in step, which is the
// drift section 5 below exists to prevent.

test('the launchpad no longer spends body space on an archive row', () => {
    assert.ok(!LAUNCHPAD.includes('id="launchpad-archive-entry"'),
        'the launchpad archive row is back; it was removed so the header ' +
        'icon could be the single entry point');
    assert.ok(!LAUNCHPAD.includes('id="archive-section"'),
        'the launchpad archive SECTION is back, heading and all');
    assert.ok(!/setupArchiveEntry/.test(LAUNCHPAD),
        'setupArchiveEntry is back; the row it wired no longer exists, so ' +
        'it can only be wiring something new and ungoverned');
});

// ---- 3. THE HEADER ENTRY POINT -----------------------------------------

test('the header owns an archive control, INLINE', () => {
    assert.ok(HTML.includes('id="archiveBtn"'), 'index.html has no #archiveBtn');
    // Asserted against the CONTROL_IDS ARRAY, not against the file. A
    // bare substring search for 'archiveBtn' over header-menu.js also
    // matches the getElementById call inside _wireArchive, so removing
    // the id from the contract left this check green - proven by
    // mutation, which is the only reason the hole was found.
    const inlineBlock = /HEADER_INLINE_CONTROL_IDS = \[([\s\S]*?)\]/.exec(HEADER);
    assert.ok(inlineBlock, 'header-menu.js no longer declares HEADER_INLINE_CONTROL_IDS');
    assert.ok(/'archiveBtn'/.test(inlineBlock[1]),
        'header-menu.js does not claim #archiveBtn in HEADER_INLINE_CONTROL_IDS, ' +
        'so the fold will sweep it into the overflow panel and the owner gets ' +
        'a menu entry again instead of the icon he asked for');
    const menuBlock = /HEADER_MENU_CONTROL_IDS = \[([\s\S]*?)\]/.exec(HEADER);
    assert.ok(menuBlock, 'header-menu.js no longer declares HEADER_MENU_CONTROL_IDS');
    assert.ok(!/'archiveBtn'/.test(menuBlock[1]),
        '#archiveBtn is claimed by BOTH lists; _fold() would move it into the ' +
        'panel and the inline contract would be a comment, not a fact');
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

test('the entry point carries no inline event handler', () => {
    const at = HTML.indexOf('id="archiveBtn"');
    assert.ok(!/on[a-z]+\s*=/.test(HTML.slice(at - 120, at + 400)),
        '#archiveBtn carries an inline handler, which CSP refuses silently');
    // There is no second entry point to check any more - the launchpad
    // row is gone (section 2). Its absence is asserted there rather than
    // by an inline-handler check over markup that does not exist, which
    // would pass vacuously.
});

// ---- 5. ONE IMPLEMENTATION, NOT TWO ------------------------------------
// Two copies of a navigation is two copies that can drift: one gains a
// guard, or a route parameter, or a different history mode, and from
// then on the two doors lead to different places with nothing to say so.

test('the entry point routes through the ONE published archive surface', () => {
    assert.ok(!/window\.ArchiveEntry/.test(LAUNCHPAD),
        'the launchpad reaches for ArchiveEntry again; it has no archive ' +
        'control any more, so this can only be a second door growing back');
    assert.ok(/CloudeWeb\.archive/.test(HEADER),
        'the header navigates to the archive by some other means than the '
        + 'one published surface, so there are two doors again');
    // Neither may call showArchive or pushState itself.
    for (const [name, src] of [['the home screen', LAUNCHPAD], ['header-menu.js', HEADER]]) {
        // TIGHTENED IN SLICE 7, AND IT WAS A REAL FALSE POSITIVE. The
        // bare substring also matches `showArchived`, which is the
        // RECENT and PROJECTS filter label - a different word for a
        // different thing that has always been on this screen. The claim
        // is about a CALL to `App.showArchive`, so the match is on the
        // call.
        assert.ok(!/\bshowArchive\s*\(/.test(src),
            `${name} calls App.showArchive directly, bypassing the one entry point`);
    }
});

// ---- 6. THE ENTRY POINT'S BEHAVIOUR IS MEASURED ELSEWHERE NOW ---------
//
// Six cases lived here: open() writes the address bar then shows the
// screen, it does not push a duplicate history entry, a blocked History
// API does not block the navigation, a missing app shell is reported
// rather than swallowed, and the route matches the router's prefix. All
// six are in web/src/lib/plugins/history/screen.test.ts, driven against
// the real implementation through an injected host rather than a vm
// sandbox. Nothing was dropped; the last one changed shape, because the
// two constants it compared (`ArchiveEntry.PATH` and
// `Router.ARCHIVE_PREFIX`) are one owner now and there is no longer a
// second spelling for it to disagree with.

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
