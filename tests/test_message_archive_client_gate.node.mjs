// THE UI HALF OF THE MESSAGE-ARCHIVE SWITCH: no door on an install that
// opted out, and no door drawn on a guess.
//
// The server refuses the archive four ways when the switch is off - no
// schema, no scheduler, no API routes, and /archive redirects to the
// launchpad. None of that stops the CLIENT from painting a "message
// archive" row that leads there. A row that leads to a 302 and a screen
// whose every request 404s is worse than no row: it reads as a broken
// feature rather than an absent one, and it is the visible half, so it is
// the half a user judges the release by.
//
// THREE STATES, NOT TWO, and the third is the whole reason this file
// exists. `enabled` and `disabled` come from a server that answered.
// `unknown` is a probe that failed, an API client that never loaded, or a
// server that said something this build does not understand. `unknown`
// leaves both doors HIDDEN, because the two failure directions are not
// symmetric: a hidden row on a healthy install is a feature the user can
// still reach by URL, an exposed row on an install that opted out is a
// broken screen.
//
// Run with: node tests/test_message_archive_client_gate.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createEnvironment } from './mini-dom.mjs';
import { installArchiveSeam } from './archive-seam-stub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name - Test description.
 * @param {() => (void|Promise<void>)} fn - Body; throwing marks it failed.
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

/**
 * Read a file under the repo root.
 * @param {...string} parts - Path segments below the repo root.
 * @returns {string} File contents.
 */
function read(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

// SLICE 7: the home screen's markup is a Svelte component now, and
// the claim - there is no archive door left in the body to gate - is
// made against every slice 7 source rather than one deleted file.
const { HOME_ALL_SRC: LAUNCHPAD } = await import('./lib-home-source.mjs');

// THE PROBE'S OWN BEHAVIOUR MOVED, AND THE HEADER'S GATING DID NOT.
// `archive-entry.js` is web/src/lib/plugins/history/availability.ts now,
// behind the `app-screen` surface, so the six cases that loaded it here
// and drove `ensure()` - enabled, disabled, cannot_determine as UNKNOWN,
// a failed probe, no client at all, and single-flight - moved to
// web/src/lib/plugins/history/screen.test.ts, against the real
// implementation. Rule 8.3 of docs/history-archive-scope.md.
//
// WHAT STAYS IS THIS FILE'S OTHER SUBJECT: that the HEADER does the
// right thing with whatever the probe answers, and that the home screen
// grew no second door to gate. Neither of those moved in this slice.

/**
 * Load header-menu.js over a real mini-DOM header carrying #archiveBtn.
 *
 * @param {object|null} feature - the message_archive block the stubbed
 *   /api/v1/features answers with, or null for "no API at all".
 * @returns {object} {btn, flush} - the button and a settle helper.
 */
function loadHeader(feature) {
    const env = createEnvironment({ matches: false });
    const header = env.document.createElement('div');
    header.className = 'header';
    const controls = env.document.createElement('div');
    controls.className = 'controls';
    for (const id of ['archiveBtn', 'logoutBtn', 'settingsBtn']) {
        const btn = env.document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('id', id);
        controls.appendChild(btn);
    }
    header.appendChild(controls);
    env.document.body.appendChild(header);

    // A DOUBLE OF THE SEAM, resolving the state the block names. The
    // block-to-state mapping itself - including that an unknown value
    // and a dead probe both read UNKNOWN - is measured against the real
    // availability ladder in web/src/lib/plugins/history/screen.test.ts.
    // What is measured HERE is what the header does with the answer.
    const named = feature && typeof feature.state === 'string' ? feature.state : null;
    const state = named === 'enabled' || named === 'disabled' ? named : 'unknown';
    installArchiveSeam(env.window, {
        state,
        reason: (feature && feature.reason) || '',
    });
    const sandbox = {
        window: env.window,
        document: env.document,
        Promise,
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const file of ['kebab-icon.js', 'dismiss-guard.js', 'header-menu.js']) {
        vm.runInContext(read('client', 'js', file), sandbox, { filename: file });
    }
    // header-menu.js exports an INSTANCE and self-inits at load when the
    // document is not still parsing; init() is idempotent, so calling it
    // again here is a no-op that keeps the test honest if that changes.
    sandbox.window.HeaderMenu.init();
    return {
        btn: env.document.getElementById('archiveBtn'),
        /** Let the availability promise settle. @returns {Promise<void>} */
        flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
}

// ---- POSITIVE CONTROL --------------------------------------------------
// Every source assertion below is a substring search. A mistyped path
// yields an empty string and makes an "it is not there" check pass for
// the wrong reason - the exact defect class this file is guarding.

await test('POSITIVE CONTROL: the source files loaded and are non-empty', () => {
    assert.ok(LAUNCHPAD.length > 1000, 'the home screen source did not load');
    assert.ok(!LAUNCHPAD.includes('zzqqxyz-not-in-this-file'),
        'the substring search returns true for everything');
});

// ---- 1. THE PROBE ------------------------------------------------------

// The six availability cases that lived here - a disabled server, an
// enabled one, cannot_determine reading as UNKNOWN, a rejected probe, no
// client at all, and the probe being single-flight - are now in
// web/src/lib/plugins/history/screen.test.ts, one for one, against the
// real ladder. See the note at the top of this file.

await test('the launchpad has no archive door left to gate', () => {
    assert.ok(LAUNCHPAD.length > 1000, 'the home screen source did not load; vacuous');
    assert.ok(!LAUNCHPAD.includes('id="archive-section"'),
        'the launchpad archive section is back and needs its own gate again');
    assert.ok(!LAUNCHPAD.includes('id="launchpad-archive-entry"'),
        'the launchpad archive row is back and needs its own gate again');
    assert.ok(!/ArchiveEntry|CloudeWeb\.archive/.test(LAUNCHPAD),
        'the home screen reaches for the archive again, so it is gating (or ' +
        'failing to gate) something this suite does not know about');
});

// ---- 3. THE HEADER CONTROL ---------------------------------------------

await test('#archiveBtn is hidden when the server says disabled', async () => {
    const { btn, flush } = loadHeader({ state: 'disabled', reason: 'off' });
    await flush();
    assert.equal(btn.style.display, 'none',
        'the header archive control is visible on an install that opted out');
    assert.equal(btn.hidden, true);
});

await test('#archiveBtn is revealed when the server says enabled', async () => {
    const { btn, flush } = loadHeader({ state: 'enabled', reason: 'on' });
    await flush();
    assert.equal(btn.style.display, '',
        'the header archive control stayed hidden with the feature ON; the ' +
        'entry point is dead when it should work');
    assert.equal(btn.hidden, false);
});

await test('#archiveBtn stays hidden on cannot_determine', async () => {
    const { btn, flush } = loadHeader({ state: 'cannot_determine', reason: 'x' });
    await flush();
    assert.equal(btn.style.display, 'none',
        'a door was drawn on a guess');
});

await test('#archiveBtn stays hidden when there is no API client', async () => {
    const { btn, flush } = loadHeader(null);
    await flush();
    assert.equal(btn.style.display, 'none');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
