// A RESTARTED SESSION MUST NOT APPEAR TWICE UNDER ITS PROJECT.
//
// WHAT THIS EXISTS TO CATCH. Restarting a stopped session cannot reuse
// its tmux instance, so it correctly mints a NEW row - and since the
// restart fix that row carries the OLD row's title verbatim. The project
// tree then listed both as peers: "Media Compression" running and "Media
// Compression" ended, same name, no way to tell them apart, one more
// every restart. Measured on the live database at the time:
//
//   id 4  stopped  parent=NULL  last_seen_running_at 2026-08-29T16:49
//   id 7  running  parent=4     created_at           2026-09-03T14:13
//   id 5  stopped  parent=NULL  last_seen_running_at 2026-08-29T16:40
//   id 8  running  parent=5     created_at           2026-09-03T14:15
//
// THE HARD PART IS NOT HIDING THE WRONG THING. A deliberate fork records
// the SAME parent_session_id and the SAME fork_kind='fork' as a restart
// replacement - by design, see src/core/session_restart.py. So the whole
// suite below is really about one question: can this code tell a session
// the user RESTARTED from a session he deliberately FORKED, and does it
// keep its hands off the row when it cannot?
//
// Run with: node tests/test_session_supersede.node.mjs

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

const SUPERSEDE_SRC = read('client', 'js', 'session-supersede.js');
const LAUNCHPAD_SRC = read('client', 'js', 'launchpad.js');

/**
 * Load session-supersede.js into a fresh realm.
 * @returns {object} window.SessionSupersede.
 */
function loadSupersede() {
    const sandbox = { window: {}, Date, isFinite, Number, Map, Array,
                      console: { log() {} } };
    vm.createContext(sandbox);
    vm.runInContext(SUPERSEDE_SRC, sandbox, { filename: 'session-supersede.js' });
    return sandbox.window.SessionSupersede;
}

const S = loadSupersede();

/** An ISO stamp `days` days after a fixed base. @param {number} days
 *  @returns {string} ISO-8601 stamp. */
function day(days) {
    return new Date(Date.UTC(2026, 7, 29, 16, 0, 0) + days * 86400000)
        .toISOString();
}

// The live shape: a long-dead parent and the restart that replaced it.
const PARENT = { id: 4, parent_session_id: null, lifecycle: 'stopped',
                 last_seen_running_at: day(0), created_at: day(-4) };
const REPLACEMENT = { id: 7, parent_session_id: 4, fork_kind: 'fork',
                      lifecycle: 'running', created_at: day(5),
                      last_seen_running_at: day(5) };
// A session nobody ever forked or restarted.
const LONER = { id: 9, parent_session_id: null, lifecycle: 'stopped',
                last_seen_running_at: day(1), created_at: day(1) };

// ---- POSITIVE CONTROL --------------------------------------------------
// Every assertion below rests on this module having loaded and on its
// verdicts being capable of differing. A classifier that returned the
// same string for everything would pass a naive "is it superseded" suite
// completely, which is exactly the shape of check that cannot fail.

test('POSITIVE CONTROL: the module loaded and its three verdicts are distinct', () => {
    assert.ok(S && typeof S.classify === 'function',
        'session-supersede.js did not load; every check below is vacuous');
    const seen = new Set([S.SUPERSEDED, S.NOT_SUPERSEDED, S.CANNOT_DETERMINE]);
    assert.equal(seen.size, 3, 'the three outcomes are not three distinct values');
    // And the classifier is shown capable of returning more than one of
    // them, against inputs this suite goes on to rely on.
    assert.equal(S.classify(PARENT, [PARENT, REPLACEMENT]), S.SUPERSEDED);
    assert.equal(S.classify(LONER, [LONER]), S.NOT_SUPERSEDED);
    assert.equal(S.classify({ id: 1, last_seen_running_at: null },
                            [{ id: 1 }, { id: 2, parent_session_id: 1,
                                          created_at: day(3) }]),
                 S.CANNOT_DETERMINE);
});

// ---- 1. THE RESTART CASE -----------------------------------------------

test('a session replaced by a restart is SUPERSEDED', () => {
    assert.equal(S.classify(PARENT, [PARENT, REPLACEMENT]), S.SUPERSEDED);
    assert.ok(S.isSuperseded(PARENT, [PARENT, REPLACEMENT]));
    assert.equal(S.successorOf(PARENT, [PARENT, REPLACEMENT]).id, 7);
});

test('the REPLACEMENT itself is never superseded - the successor stays listed', () => {
    // The inverse of the fix, and the one that would be catastrophic to
    // get wrong: hiding the session the user is actually working in.
    assert.equal(S.classify(REPLACEMENT, [PARENT, REPLACEMENT]), S.NOT_SUPERSEDED);
    assert.equal(S.successorOf(REPLACEMENT, [PARENT, REPLACEMENT]), null);
});

test('a session with no lineage at all is untouched', () => {
    assert.equal(S.classify(LONER, [LONER, PARENT, REPLACEMENT]),
                 S.NOT_SUPERSEDED);
    assert.equal(S.successorOf(LONER, [LONER, PARENT, REPLACEMENT]), null);
});

// ---- 2. THE FORK CASE, WHICH LOOKS IDENTICAL IN fork_kind --------------
// This is the requirement in one test: same parent_session_id, same
// fork_kind, opposite verdict. Anything keyed on fork_kind fails here.

test('a DELIBERATE fork of a live session does not supersede its parent', () => {
    // The parent was running when the child was born and went on being
    // probed afterwards, so its last proof of life is LATER than the
    // child's birth. Identical lineage fields to the restart case above.
    const liveParent = { id: 20, parent_session_id: null, lifecycle: 'running',
                         last_seen_running_at: day(6), created_at: day(1) };
    const forkChild = { id: 21, parent_session_id: 20, fork_kind: 'fork',
                        lifecycle: 'running', created_at: day(5) };
    assert.equal(forkChild.fork_kind, REPLACEMENT.fork_kind,
        'the two cases must be indistinguishable by fork_kind, or this ' +
        'test is not testing what it claims to');
    assert.equal(S.classify(liveParent, [liveParent, forkChild]),
                 S.NOT_SUPERSEDED);
});

test('a forked parent that stops LATER still does not become superseded', () => {
    // The durability property. lifecycle is a snapshot - by the time
    // anyone looks, both a restarted and a forked parent read 'stopped'.
    // last_seen_running_at is a record, and it keeps the answer.
    const stoppedLater = { id: 20, parent_session_id: null, lifecycle: 'stopped',
                           last_seen_running_at: day(9), created_at: day(1) };
    const forkChild = { id: 21, parent_session_id: 20, fork_kind: 'fork',
                        created_at: day(5) };
    assert.equal(S.classify(stoppedLater, [stoppedLater, forkChild]),
                 S.NOT_SUPERSEDED);
});

test('the margin is honoured, and it errs towards VISIBLE', () => {
    const base = Date.parse(day(3));
    const parent = { id: 30, last_seen_running_at: new Date(base).toISOString() };
    const justInside = { id: 31, parent_session_id: 30,
                         created_at: new Date(base + S.MIN_GAP_MS - 1000).toISOString() };
    const justOutside = { id: 31, parent_session_id: 30,
                          created_at: new Date(base + S.MIN_GAP_MS + 1000).toISOString() };
    assert.equal(S.classify(parent, [parent, justInside]), S.NOT_SUPERSEDED,
        'a gap inside the margin must stay visible');
    assert.equal(S.classify(parent, [parent, justOutside]), S.SUPERSEDED);
});

// ---- 3. CANNOT DETERMINE STAYS ON SCREEN -------------------------------

test('a parent never seen running CANNOT be classified, and is not hidden', () => {
    const never = { id: 40, last_seen_running_at: null };
    const child = { id: 41, parent_session_id: 40, created_at: day(5) };
    assert.equal(S.classify(never, [never, child]), S.CANNOT_DETERMINE);
    assert.equal(S.isSuperseded(never, [never, child]), false,
        'cannot-determine must never hide a row');
    assert.equal(S.successorOf(never, [never, child]), null,
        'an unclassifiable row must have no successor to be folded under');
});

test('an unparseable timestamp is CANNOT DETERMINE, not a silent zero', () => {
    // Date.parse of junk is NaN; coercing it to 0 would read as 1970 and
    // make every comparison against it succeed - hiding the row.
    const parent = { id: 50, last_seen_running_at: 'not-a-date' };
    const child = { id: 51, parent_session_id: 50, created_at: day(5) };
    assert.equal(S.classify(parent, [parent, child]), S.CANNOT_DETERMINE);
    assert.equal(S._epoch('not-a-date'), null);
    assert.equal(S._epoch(''), null);
    assert.equal(S._epoch(undefined), null);
});

test('a child with no created_at leaves the verdict undetermined, not negative', () => {
    const parent = { id: 60, last_seen_running_at: day(0) };
    const child = { id: 61, parent_session_id: 60, created_at: null };
    assert.equal(S.classify(parent, [parent, child]), S.CANNOT_DETERMINE);
});

test('one measurable child that clears the gap decides it, despite an unmeasurable sibling', () => {
    const parent = { id: 70, last_seen_running_at: day(0) };
    const vague = { id: 71, parent_session_id: 70, created_at: null };
    const clear = { id: 72, parent_session_id: 70, created_at: day(5) };
    assert.equal(S.classify(parent, [parent, vague, clear]), S.SUPERSEDED);
});

// ---- 4. THE LAUNCHPAD USES IT, AND USES IT SAFELY ----------------------

test('_endedSessionsForTree annotates rather than filters', () => {
    // The distinction is the safety property: this method cannot see
    // whether the successor will be rendered, so it must not be the thing
    // that removes the row.
    const at = LAUNCHPAD_SRC.indexOf('_endedSessionsForTree() {');
    assert.ok(at > -1, '_endedSessionsForTree is gone');
    const body = LAUNCHPAD_SRC.slice(at, at + 4000);
    assert.ok(/superseded_by/.test(body),
        'the ended rows carry no supersession annotation');
    assert.ok(/window\.SessionSupersede/.test(body),
        'the launchpad does not consult the classifier');
    assert.ok(/successorOf/.test(body),
        'the launchpad classifies without resolving a successor, so it ' +
        'cannot check the successor is on screen before folding');
});

test('the fold only happens when the successor is in the SAME group', () => {
    const at = LAUNCHPAD_SRC.indexOf('_renderTreeSessionRowsHtml(sessions) {');
    assert.ok(at > -1, '_renderTreeSessionRowsHtml is gone');
    const body = LAUNCHPAD_SRC.slice(at, at + 2600);
    assert.ok(/presentIds/.test(body) && /presentIds\.has\(/.test(body),
        'rows are folded away without checking their successor is present, ' +
        'so a predecessor whose successor is in another project becomes ' +
        'unreachable from this screen');
});

test('BOTH tree call sites go through the folding helper', () => {
    // A single un-folded call site is a group that still shows duplicates,
    // and nothing else would report it.
    const direct = LAUNCHPAD_SRC.match(/\.map\(\s*s\s*=>\s*this\._renderTreeSessionRowHtml\(s\)\s*\)/g);
    assert.equal(direct, null,
        'a group still maps _renderTreeSessionRowHtml directly, bypassing ' +
        'the fold');
    const folded = LAUNCHPAD_SRC.match(/this\._renderTreeSessionRowsHtml\(/g) || [];
    assert.equal(folded.length, 2,
        'expected exactly the two group renderers (the project node and the ' +
        'synthetic "no project" node) to call the folding helper');
    assert.ok(/_renderTreeSessionRowsHtml\(sessions\)\s*\{/.test(LAUNCHPAD_SRC),
        'the folding helper is called but never defined');
});

test('the superseded rows stay REACHABLE behind a disclosure, not deleted', () => {
    const at = LAUNCHPAD_SRC.indexOf('_renderTreeSessionRowsHtml(sessions) {');
    const body = LAUNCHPAD_SRC.slice(at, at + 2600);
    assert.ok(/project-session-superseded__toggle/.test(body),
        'there is no control to reveal the folded sessions, so they are ' +
        'hidden rather than moved');
    assert.ok(/aria-expanded/.test(body) && /aria-controls/.test(body),
        'the disclosure is not announced to assistive tech');
    assert.ok(/_renderTreeSessionRowHtml\(f\)/.test(body),
        'the folded rows are not rendered with the ordinary row renderer, ' +
        'so restart/delete/open would not behave the same once revealed');
    assert.ok(/_bindSupersededToggles\(\)\s*\{/.test(LAUNCHPAD_SRC),
        'the disclosure is never wired, so it is inert');
    assert.ok(/this\._bindSupersededToggles\(\);/.test(LAUNCHPAD_SRC),
        '_bindSupersededToggles is defined but never called');
});

test('a classifier that failed to load hides NOTHING', () => {
    // The safe direction, asserted structurally: the annotation is inside
    // a window.SessionSupersede guard, so an absent module leaves every
    // ended row exactly as it was before this fix.
    const at = LAUNCHPAD_SRC.indexOf('_endedSessionsForTree() {');
    const body = LAUNCHPAD_SRC.slice(at, at + 4000);
    assert.ok(/let supersededBy = null;/.test(body),
        'the annotation does not default to "not superseded"');
    assert.ok(/if \(window\.SessionSupersede &&/.test(body),
        'the classifier is called without a presence guard');
});

test('RECENT applies the same rule, so the two surfaces cannot disagree', () => {
    const at = LAUNCHPAD_SRC.indexOf('renderRecentSessions() {');
    assert.ok(at > -1, 'renderRecentSessions is gone');
    const body = LAUNCHPAD_SRC.slice(at, at + 2200);
    // Asserted against the PREDICATE, not against a bare mention of the
    // module. The presence guard next to it also names isSuperseded, so a
    // substring search matched even after the filter body was gutted to
    // `(r) => true` - proven by mutation, which is the only reason this
    // hole was found.
    assert.ok(/\.filter\(\s*\n?\s*\(r\)\s*=>\s*!window\.SessionSupersede\.isSuperseded\(r, records\)/.test(body),
        'RECENT still lists rows the project tree folds away; the two ' +
        'surfaces contradicting each other is the bug listable_sessions ' +
        'exists to prevent');
    assert.ok(/rows = recentAll\.filter\(/.test(body),
        'the filtered set is never assigned, so the unfiltered rows render');
    assert.ok(/sessionAttributionListingOk/.test(body),
        'RECENT filters without checking the record set was actually read');
});

// ---- 5. THE SERVER ACTUALLY SHIPS THE FIELDS ---------------------------
// Every verdict above is computed from four columns. If the wire model
// drops any of them the client silently degrades to CANNOT_DETERMINE for
// every row - which is safe, and completely useless.

test('the SessionRecord wire model carries the lineage fields', () => {
    const models = read('src', 'models.py');
    const at = models.indexOf('class SessionRecord(BaseModel):');
    assert.ok(at > -1, 'SessionRecord is gone');
    const body = models.slice(at, models.indexOf('class SessionImportStatus', at));
    for (const field of ['id', 'parent_session_id', 'fork_kind',
                         'created_at', 'last_seen_running_at']) {
        assert.ok(new RegExp(`\\n    ${field}:`).test(body),
            `SessionRecord does not declare ${field}, so the client cannot ` +
            'classify anything');
    }
    const routes = read('src', 'api', 'routes.py');
    const rat = routes.indexOf('def _session_record_payload(row: dict)');
    assert.ok(rat > -1, '_session_record_payload is gone');
    const rbody = routes.slice(rat, rat + 2600);
    for (const field of ['parent_session_id', 'last_seen_running_at',
                         'created_at', 'fork_kind']) {
        assert.ok(new RegExp(`${field}=row\\.get\\("${field}"\\)`).test(rbody),
            `_session_record_payload never populates ${field}; a declared ` +
            'field that is never set is a null on every row');
    }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
