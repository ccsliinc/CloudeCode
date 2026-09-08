// Node test for the RECREATE half of the restart picker, client side.
//
// PUNCHLIST ITEM 22, the missing half. A session whose tmux SESSION is
// gone has no pane for the respawn ladder to read, so the restart preview
// answers `cannot_determine` - correct, and a dead end. The client's job
// is to notice that shape and ask the OTHER endpoint, which measures the
// socket instead. Three things are pinned here and each fails differently.
//
//   1. `shouldRecreate` FIRES ON EXACTLY THE RIGHT SHAPE. Too loose and a
//      live session gets re-asked; too tight and the feature never
//      appears. The `alive` case is the one that matters: a running
//      session must never be routed to a path whose action creates a
//      second tmux beside it.
//
//   2. `previewFor` RETURNS THE MODE THAT PRODUCED THE PAYLOAD. Both
//      endpoints return the same response shape on purpose, so the mode is
//      carried rather than re-derived - and the caller posts its action to
//      the endpoint that made the prediction. A recreate posted to the
//      respawn route reaches a session with no pane and is answered
//      `cannot_determine`, which looks exactly like a click that did
//      nothing.
//
//   3. A FAILED SECOND ASK FALLS BACK TO THE FIRST ANSWER. The restart
//      preview is a real answer that simply had no action in it, and
//      showing it tells the user why. Showing nothing would replace an
//      explanation with a blank panel.
//
// Follows the vm-sandbox pattern of tests/test_restart_live_gate.node.mjs
// (this repo has no package.json / jest).
//
// Run with: node tests/test_recreate_picker.node.mjs
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

/**
 * Register one async test.
 * Inputs: name (string), fn (function returning a promise or void).
 * Output: void.
 */
function test(name, fn) {
    queue.push({ name, fn });
}

/**
 * Run every registered test in order.
 * Inputs: none. Output: Promise<void>.
 */
async function runQueue() {
    for (const { name, fn } of queue) {
        try {
            await fn();
            passes += 1;
            console.log(`  PASS  ${name}`);
        } catch (err) {
            failures += 1;
            console.log(`  FAIL  ${name}`);
            console.log(`        ${err && err.message}`);
        }
    }
}

/**
 * Load the options module into a sandbox with a stubbed API.
 * Inputs: api (object) - the window.API stand-in.
 * Output: the sandbox's `window`.
 */
function load(api) {
    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        document: {
            createElement() {
                let text = '';
                return {
                    set textContent(v) { text = String(v); },
                    get innerHTML() { return text; },
                };
            },
        },
    };
    sandbox.window = sandbox;
    sandbox.API = api;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, '..', 'client', 'js',
                'session-restart-options.js'),
            'utf8',
        ),
        sandbox,
    );
    return sandbox.window;
}

/** A restart preview for a session whose tmux session is gone. */
const GONE = {
    pane_state: 'unknown',
    unchanged: { kind: 'cannot_determine', detail: 'the pane could not be read' },
    options: [],
};

/** A restart preview for a session that is running. */
const LIVE = {
    pane_state: 'alive',
    unchanged: { kind: 'not_dead', detail: 'still running' },
    options: [],
};

/** A restart preview for a dead PANE, which respawn can already handle. */
const DEAD_PANE = {
    pane_state: 'dead',
    unchanged: { kind: 'agent', detail: 'would start the agent' },
    options: [],
};

test('a pane that could not be read is re-asked as a recreate', () => {
    const w = load({});
    assert.equal(w.SessionRestartOptions.shouldRecreate(GONE), true);
});

test('A LIVE SESSION IS NEVER RE-ASKED', () => {
    // THE LOAD-BEARING NEGATIVE. The recreate action CREATES a tmux
    // session; running it beside a live one would orphan the pane the
    // user is talking to. The server refuses it too, but a client that
    // routes here on a live row has already told the user the wrong story.
    const w = load({});
    assert.equal(w.SessionRestartOptions.shouldRecreate(LIVE), false);
    assert.equal(
        w.SessionRestartOptions.shouldRecreate(
            { pane_state: 'alive', unchanged: { kind: 'cannot_determine' } }),
        false,
        'alive is a measurement and outranks an undetermined rung',
    );
});

test('a dead PANE keeps the respawn path it already had', () => {
    const w = load({});
    assert.equal(w.SessionRestartOptions.shouldRecreate(DEAD_PANE), false);
});

test('a missing preview is never re-asked', () => {
    const w = load({});
    assert.equal(w.SessionRestartOptions.shouldRecreate(null), false);
    assert.equal(w.SessionRestartOptions.shouldRecreate({}), false);
});

test('recreate is an actionable rung and carries its own badge', () => {
    const w = load({});
    assert.equal(w.SessionRestartOptions.isActionable('recreate'), true);
    const badge = w.SessionRestartOptions.KIND_BADGE.recreate;
    assert.ok(badge && badge.length, 'the rung needs a badge of its own');
    assert.notEqual(
        badge, w.SessionRestartOptions.KIND_BADGE.agent,
        'agent reuses the pane and keeps its scrollback; recreate does not',
    );
});

test('an unknown rung is still refused', () => {
    // FAIL CLOSED. A verdict this file has never heard of must not enable
    // anything, which is what stops a new server-side rung from being
    // silently treated as permission.
    const w = load({});
    assert.equal(w.SessionRestartOptions.isActionable('brand_new_rung'), false);
});

test('previewFor returns the restart answer and mode for a live row',
    async () => {
        const w = load({
            restartPreview: async () => LIVE,
            recreatePreview: async () => { throw new Error('must not be asked'); },
        });
        const answer = await w.SessionRestartOptions.previewFor('cloude_a', 'row-uuid');
        assert.equal(answer.mode, 'restart');
        assert.equal(answer.preview.unchanged.kind, 'not_dead');
    });

test('previewFor asks the recreate endpoint for an unreadable pane',
    async () => {
        let asked = null;
        const RECREATED = {
            pane_state: 'dead',
            unchanged: { kind: 'cannot_determine', detail: 'pick a wrapper' },
            options: [{
                agent_type: 'claude', label: 'claude', kind: 'recreate',
                actionable_now: true, detail: 'would build a new session',
            }],
        };
        const w = load({
            restartPreview: async () => GONE,
            recreatePreview: async (uuid) => { asked = uuid; return RECREATED; },
        });
        const answer = await w.SessionRestartOptions.previewFor('cloude_a', 'row-uuid');
        assert.equal(asked, 'row-uuid',
            'the recreate endpoints take the durable key, not the name');
        assert.equal(answer.mode, 'recreate',
            'the mode names the endpoint the action must post to');
        assert.equal(answer.preview.options[0].kind, 'recreate');
    });

test('a failed recreate ask falls back to the first answer, not to nothing',
    async () => {
        const w = load({
            restartPreview: async () => GONE,
            recreatePreview: async () => { throw new Error('offline'); },
        });
        const answer = await w.SessionRestartOptions.previewFor('cloude_a', 'row-uuid');
        assert.equal(answer.mode, 'restart');
        assert.equal(answer.preview.unchanged.kind, 'cannot_determine',
            'the honest refusal is shown rather than a blank panel');
    });

test('an API with no recreate method degrades to the old behaviour',
    async () => {
        // An older client half-loaded, or the method removed. It must
        // still show the restart answer rather than throwing.
        const w = load({ restartPreview: async () => GONE });
        const answer = await w.SessionRestartOptions.previewFor('cloude_a', 'row-uuid');
        assert.equal(answer.mode, 'restart');
    });


test('WITHOUT A DURABLE KEY THE SECOND QUESTION IS NEVER ASKED',
    async () => {
        // A tmux name is a reusable label, so the recreate endpoints take
        // a `session_uuid`. With none in hand the panel falls back to the
        // restart preview's honest refusal rather than inventing an
        // identity to make an offer with.
        const w = load({
            restartPreview: async () => GONE,
            recreatePreview: async () => { throw new Error('must not be asked'); },
        });
        const answer = await w.SessionRestartOptions.previewFor('cloude_a', null);
        assert.equal(answer.mode, 'restart');
        assert.equal(answer.sessionUuid, null);
    });

test('recreateTarget names a row only when exactly one carries the name',
    () => {
        const w = load({});
        const t = w.SessionRestartOptions.recreateTarget;
        const rows = [
            { tmux_name: 'cloude_a', session_uuid: 'u1' },
            { tmux_name: 'cloude_b', session_uuid: 'u2' },
        ];
        assert.equal(t(rows, 'cloude_a'), 'u1');
        assert.equal(t(rows, 'cloude_missing'), null);
        assert.equal(t(null, 'cloude_a'), null);
        assert.equal(t(rows, ''), null);
    });

test('TWO ROWS SHARING A NAME REFUSE RATHER THAN PICK THE NEWEST', () => {
    // THE LOAD-BEARING NEGATIVE for identity. "the newest row with this
    // name" is a recency guess, and a wrong answer would rebind a
    // DIFFERENT session's record onto a tmux session it has nothing to do
    // with. Refusing costs the user an offer; guessing costs them a
    // session.
    const w = load({});
    const rows = [
        { tmux_name: 'cloude_a', session_uuid: 'older' },
        { tmux_name: 'cloude_a', session_uuid: 'newer' },
    ];
    assert.equal(w.SessionRestartOptions.recreateTarget(rows, 'cloude_a'), null);
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures === 0) console.log('ALL PASS');
process.exit(failures === 0 ? 0 : 1);
