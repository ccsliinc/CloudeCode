// Node tests for client/js/terminal-away-gap.js - the rules and every
// sentence behind the after-you-were-away bar (punchlist item 1).
//
// WHAT IS WORTH PINNING HERE, and why each one is a defect waiting to
// happen rather than a tautology:
//
//   1. THE THRESHOLD IS A THRESHOLD. A blip must not raise the bar and a
//      real absence must. This is the difference between a feature and
//      noise the user learns to dismiss unread.
//   2. A REMEMBERED CHOICE STILL SHOWS THE BAR. The owner's ask, quoted
//      in .claude/TODO.md item 1, is the OPTION and not a better silent
//      default. A remembered choice that suppressed the bar, or that ran
//      itself, would reintroduce exactly what it removed - wearing the
//      user's own preference as a disguise. The pre-selection must never
//      shrink the choice list either.
//   3. THE TURN COUNT IS PRINTED AS A FLOOR. SessionManager.record_toast
//      coalesces an unacked Stop in place, so N records is "at least N
//      turns" and never "N turns".
//   4. A NULL IS NOT A FALSE. An unread permission signal prints as
//      unknown. Printing it as "nothing is waiting on you" is the claim
//      that sends someone away from a blocked agent, and it is this
//      project's single most repeated defect class.
//   5. A NAIVE SERVER TIMESTAMP IS UTC. Date.parse reads a zone-less
//      string as LOCAL time, which renders "last activity 5 hr ago" over
//      a session that spoke a moment ago.
//
// Run with: node tests/test_terminal_away_gap.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;
const queue = [];

/** Queue one named assertion block. Inputs: name, fn. Output: void. */
function test(name, fn) {
    queue.push([name, fn]);
}

/** Run every queued test in order. Inputs: none. Output: Promise<void>. */
async function runQueue() {
    for (const [name, fn] of queue) {
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
 * Load terminal-away-gap.js in a sandbox carrying only a bare `window`.
 *
 * No document and no storage: the module's contract is that it is pure,
 * so if a future edit reaches for the DOM this loader throws and the
 * test fails, which is the point.
 * Inputs: none. Output: object - the TerminalAwayGap api.
 */
function loadGap() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'terminal-away-gap.js'),
        'utf8',
    );
    const context = { console, window: {} };
    vm.createContext(context);
    vm.runInContext(src, context);
    return context.window.TerminalAwayGap;
}

const G = loadGap();

/**
 * A localStorage stand-in.
 * Inputs: opts.throwOnRead, opts.throwOnWrite (booleans). Output: object.
 */
function fakeStorage(opts = {}) {
    const map = new Map();
    return {
        getItem(k) {
            if (opts.throwOnRead) throw new Error('blocked');
            return map.has(k) ? map.get(k) : null;
        },
        setItem(k, v) {
            if (opts.throwOnWrite) throw new Error('blocked');
            map.set(k, String(v));
        },
    };
}

test('the threshold is 60s and a blip below it raises nothing', () => {
    assert.equal(G.AWAY_THRESHOLD_MS, 60000);
    assert.equal(
        G.decideAwayPrompt({ awayMs: 59999, hasSession: true }),
        'skip_short_blip',
    );
    assert.equal(
        G.decideAwayPrompt({ awayMs: 60000, hasSession: true }),
        'offer',
    );
    assert.equal(G.barPlan({ awayMs: 59999, hasSession: true }), null);
});

test('no attached session means no bar, however long the absence', () => {
    assert.equal(
        G.decideAwayPrompt({ awayMs: 86400000, hasSession: false }),
        'skip_no_session',
    );
    assert.equal(G.barPlan({ awayMs: 86400000, hasSession: false }), null);
});

test('a remembered choice pre-selects and NEVER suppresses the bar', () => {
    const plan = G.barPlan({
        awayMs: 300000,
        hasSession: true,
        remembered: 'summary',
    });
    assert.ok(plan, 'a remembered choice must still produce a bar');
    assert.equal(plan.remembered, 'summary');
    assert.deepEqual(
        JSON.parse(JSON.stringify(plan.choices)),
        ['full', 'summary', 'continue'],
        'the pre-selection must not shrink the choice list',
    );
    const none = G.barPlan({ awayMs: 300000, hasSession: true, remembered: null });
    assert.ok(none);
    assert.equal(none.remembered, null);
});

test('a junk remembered value is forgotten rather than pre-selected', () => {
    const plan = G.barPlan({
        awayMs: 300000,
        hasSession: true,
        remembered: 'replay-everything',
    });
    assert.equal(plan.remembered, null);
});

test('away time reads in words, and a bad duration refuses', () => {
    assert.equal(G.formatAway(0), 'less than a minute');
    assert.equal(G.formatAway(59000), 'less than a minute');
    assert.equal(G.formatAway(60000), '1 min');
    assert.equal(G.formatAway(300000), '5 min');
    assert.equal(G.formatAway(3600000), '1 hr');
    assert.equal(G.formatAway(7500000), '2 hr 5 min');
    assert.equal(G.formatAway(-1), 'an unknown time');
    assert.equal(G.formatAway(NaN), 'an unknown time');
    assert.equal(
        G.barPlan({ awayMs: 300000, hasSession: true }).awayLabel,
        'away 5 min',
    );
});

test('the remembered choice round-trips, and a throwing store costs nothing', () => {
    const store = fakeStorage();
    assert.equal(G.readRememberedChoice(store), null);
    assert.equal(G.writeRememberedChoice(store, 'full'), true);
    assert.equal(G.readRememberedChoice(store), 'full');
    assert.equal(
        G.writeRememberedChoice(store, 'nonsense'),
        false,
        'only a real choice may be stored',
    );
    assert.equal(G.readRememberedChoice(fakeStorage({ throwOnRead: true })), null);
    assert.equal(
        G.writeRememberedChoice(fakeStorage({ throwOnWrite: true }), 'full'),
        false,
    );
    assert.equal(G.readRememberedChoice(null), null);
});

test('a coalescing kind is printed as a floor, never as a total', () => {
    const lines = G.summaryLines(
        { counts: { stop: 3 }, permission_open: false, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(
        lines.some((l) => l === 'at least 3 turns finished'),
        `expected a floor, got ${JSON.stringify(lines)}`,
    );
    assert.ok(
        !lines.some((l) => l === '3 turns finished'),
        'a record count must never be printed as a turn total',
    );
    const one = G.summaryLines(
        { counts: { stop: 1 }, permission_open: false, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(one.some((l) => l === 'at least 1 turn finished'));
});

test('an unread permission signal prints as unknown, not as clear', () => {
    const unknown = G.summaryLines({ counts: {}, coverage: 'complete' }, Date.now());
    assert.ok(
        unknown.some((l) => l.includes('unknown')),
        `expected an unknown, got ${JSON.stringify(unknown)}`,
    );
    const open = G.summaryLines(
        { counts: {}, permission_open: true, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(open.some((l) => l === 'a permission request is still open'));
    const clear = G.summaryLines(
        { counts: {}, permission_open: false, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(
        !clear.some((l) => l.includes('permission')),
        'a measured-clear permission must say nothing at all',
    );
});

test('a quiet window says so, and never renders empty', () => {
    const lines = G.summaryLines(
        { counts: { stop: 0 }, permission_open: false, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l === 'nothing recorded while you were away'));
});

test('a restart during the window is said out loud', () => {
    const lines = G.summaryLines(
        {
            counts: { stop: 1 },
            permission_open: false,
            coverage: 'partial_server_restarted',
        },
        Date.now(),
    );
    assert.ok(lines.some((l) => l.includes('server restarted')));
    const unknown = G.summaryLines(
        { counts: {}, permission_open: false, coverage: 'unknown' },
        Date.now(),
    );
    assert.ok(unknown.some((l) => l.includes('how much of this window')));
});

test('a zone-less server timestamp is read as UTC, not as local time', () => {
    const naive = '2026-09-08T10:00:00';
    assert.equal(
        G.parseServerTime(naive),
        Date.parse('2026-09-08T10:00:00Z'),
        'a naive stamp must be UTC',
    );
    assert.equal(
        G.parseServerTime('2026-09-08T10:00:00Z'),
        Date.parse('2026-09-08T10:00:00Z'),
    );
    assert.ok(Number.isNaN(G.parseServerTime('')));

    const now = Date.parse('2026-09-08T10:05:00Z');
    const lines = G.summaryLines(
        { counts: {}, permission_open: false, coverage: 'complete', last_activity_at: naive },
        now,
    );
    assert.ok(
        lines.some((l) => l === 'last activity 5 min ago'),
        `expected a 5 min age, got ${JSON.stringify(lines)}`,
    );
});

test('an absent last activity is not recorded, never zero minutes ago', () => {
    const lines = G.summaryLines(
        { counts: {}, permission_open: false, coverage: 'complete' },
        Date.now(),
    );
    assert.ok(lines.some((l) => l === 'last activity not recorded'));
});

test('the full-history caveat names what the pane can actually give back', () => {
    const alt = G.historyCaveat({ history: { mode: 'screen_only', bound_lines: 3000 } });
    assert.ok(alt.includes('current screen'));
    assert.ok(
        alt.includes('replaces the history'),
        'the alternate-screen caveat must warn that the kept buffer goes',
    );
    const scroll = G.historyCaveat({ history: { mode: 'scrollback', bound_lines: 3000 } });
    assert.ok(
        scroll.includes('3000'),
        'the bound must be stated, not implied to be unbounded',
    );
    assert.ok(G.historyCaveat(null).includes('unknown'));
    assert.ok(G.historyCaveat({ history: { mode: 'unknown' } }).includes('unknown'));
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
