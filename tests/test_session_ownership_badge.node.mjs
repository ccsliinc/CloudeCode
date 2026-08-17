// Node test for the TMUX / EXTERNAL badge on a session row.
//
// THE REPORT. Two tmux sessions created identically - `tmux new-session`
// on the `cloude` socket, same user, same minute - showed different
// badges: `scrolltest` said TMUX and `fstest` said EXTERNAL. The
// difference was not in how they were created. It was whether one of
// them happened to be OPEN.
//
// THE RULE, ALL THE WAY DOWN.
//   - `AttachableSession.created_by_cloude` is set server-side by
//     cross-referencing the tmux name against SessionManager's persisted
//     `owned_tmux_sessions` set (src/core/tmux_backend.py). That set
//     holds names Cloude Code BIRTHED, via POST /sessions.
//   - Adoption deliberately does NOT add to it
//     (SessionManager.adopt_external_session): "we don't own them; we
//     adopted them". An adopted session keeps the id `adopted:<name>`.
//   - GET /sessions/attachable then filters out every tmux name bound to
//     a live backend, so the UI never offers self-adopt.
//
// That last point is the bug. Because every OPEN session is filtered out
// of /attachable, every open session reaches the client only through the
// /sessions merge - and both merges (launchpad.js and session-sidebar.js)
// hardcoded `created_by_cloude: true` for it. So opening an adopted
// external session silently promoted it to TMUX, and closing it demoted
// it back. Two identically-created sessions, one open, two badges.
//
// The client already has the evidence it needs: the live session's own
// id. `adopted:<name>` for an adopted session, a plain id for one Cloude
// Code created. That is what both merges read now.
//
// Run with: node tests/test_session_ownership_badge.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name  Test description.
 * @param {() => void} fn  Body; throwing marks the test failed.
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
 * Read one file from the repo root.
 * @param {...string} parts  Path segments below the repo root.
 * @returns {string} File contents.
 */
function read(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const launchpad = read('client', 'js', 'launchpad.js');
const sidebar = read('client', 'js', 'session-sidebar.js');
const manager = read('src', 'core', 'session_manager.py');
const backend = read('src', 'core', 'tmux_backend.py');

// ---------------------------------------------------------------------
// 1. Neither merge may assert ownership it did not measure.
// ---------------------------------------------------------------------

for (const [label, src] of [['launchpad.js', launchpad], ['session-sidebar.js', sidebar]]) {
    test(`${label} derives ownership from the session id, never a literal`, () => {
        assert.doesNotMatch(src, /created_by_cloude:\s*true\s*,/,
            'a hardcoded true here badges every OPEN session TMUX, including '
            + 'an adopted external one');
        assert.match(src, /created_by_cloude:\s*!String\([^)]*\)\.startsWith\('adopted:'\)/,
            'the live session id is the evidence: `adopted:<name>` for an '
            + 'adopted session, a plain id for one Cloude Code created');
    });
}

test('the server-side rule the client is now agreeing with is still the rule', () => {
    // If adoption ever starts claiming ownership, the client's id test
    // becomes wrong in the other direction and this must be revisited.
    assert.match(manager,
        /The adopted session is NOT added to ``owned_tmux_sessions``/,
        'adopt_external_session must still leave the owned set alone');
    assert.match(backend, /created_by_cloude = name in owned_names/,
        'the server still answers ownership from the persisted owned set');
});

test('an adopted session is still keyed `adopted:<name>`', () => {
    assert.match(manager, /adopted_id = f"adopted:\{name\}"/,
        'the id prefix is what the client reads; renaming it breaks the badge');
});

// ---------------------------------------------------------------------
// 2. The badge itself, so the two surfaces cannot drift apart on what
//    the flag means.
// ---------------------------------------------------------------------

test('both surfaces render the same flag as the same badge', () => {
    assert.match(launchpad, /owned \? 'TMUX' : 'EXTERNAL'/);
    assert.match(read('client', 'js', 'session-sidebar-rows.js'),
        /r\.created_by_cloude \? 'tmux' : 'external'/);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
