// Node test for the RESTART PICKER's DEFINITION
// (client/js/session-restart-picker.js).
//
// Its sibling tests/test_restart_picker_renders.py measures the panel in a
// real browser - colour, hit tests, geometry. This file pins the rules that
// are true before anything is painted, and the sharpest of them is the one
// the whole feature turns on:
//
//   A PREDICTION IS NEVER A PERMISSION. The server reports what a choice
//   would COME BACK AS (`projected_kind`, liveness ignored) separately from
//   whether a restart may act on it now (`actionable_now`). The badge reads
//   the first; the radio obeys the second. Wire the badge to the radio and a
//   live session's options - which all project 'agent' - become pickable,
//   which is the one outcome that could kill a running agent.
//
// Follows the vm-sandbox pattern of tests/test_session_row_restart.node.mjs
// (this repo has no package.json / jest).
//
// Run with: node tests/test_restart_picker.node.mjs
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

function test(name, fn) {
    queue.push({ name, fn });
}

function runQueue() {
    for (const { name, fn } of queue) {
        try {
            fn();
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
 * Load the picker into a sandbox with the minimum DOM its escaper needs.
 * Output: the sandbox's `window` object.
 */
function loadPicker() {
    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        document: {
            createElement() {
                let text = '';
                return {
                    set textContent(v) {
                        text = String(v)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                    },
                    get innerHTML() {
                        return text;
                    },
                };
            },
        },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, '..', 'client', 'js',
                'session-restart-picker.js'),
            'utf8',
        ),
        sandbox,
    );
    return sandbox.window;
}

/** One option, live session: projects an agent, may NOT be acted on. */
const LIVE_OPTION = {
    agent_type: 'claude-chrome',
    label: 'claude-chrome',
    is_current: true,
    resolvable: true,
    actionable_now: false,
    kind: 'not_dead',
    detail: 'this session is still running; there is nothing to restart',
    projected_kind: 'agent',
    projected_detail: 'starting claude-chrome, which you picked',
    command: 'run-cc',
};

const LIVE_PREVIEW = {
    name: 'row-live',
    current_agent_type: 'claude-chrome',
    pane_state: 'alive',
    unchanged: {
        kind: 'not_dead',
        detail: 'this session is still running; there is nothing to restart',
        actionable: false,
    },
    projected: {
        kind: 'shell',
        detail: 'this pane was opened as a plain shell; restarting opens one again',
        actionable: true,
    },
    options: [LIVE_OPTION],
    wrappers_status: 'ok',
};

test('an unrecognised rung is never actionable', () => {
    const w = loadPicker();
    assert.equal(w.SessionRestartPicker.isActionable('agent'), true);
    assert.equal(w.SessionRestartPicker.isActionable('shell'), true);
    assert.equal(w.SessionRestartPicker.isActionable('replay'), true);
    assert.equal(w.SessionRestartPicker.isActionable('not_dead'), false);
    assert.equal(w.SessionRestartPicker.isActionable('cannot_determine'), false);
    // The one that matters: a verdict added server-side that this client
    // has never heard of must fail CLOSED, not be offered blind.
    assert.equal(w.SessionRestartPicker.isActionable('some_future_rung'), false);
    assert.equal(w.SessionRestartPicker.isActionable(undefined), false);
});

test('a live session projects an agent AND stays unpickable', () => {
    const w = loadPicker();
    const html = w.SessionRestartPicker.optionsHtml(LIVE_PREVIEW);
    // Every radio disabled - nothing here may act on a running pane.
    const inputs = html.match(/<input[^>]*>/g) || [];
    assert.equal(inputs.length, 2, `expected 2 options, got ${inputs.length}`);
    for (const tag of inputs) {
        assert.ok(/\sdisabled/.test(tag), `a live option is pickable: ${tag}`);
    }
    // ...and yet the panel still SAYS what each would come back as.
    assert.ok(
        html.includes('data-kind="agent"'),
        'the wrapper option does not say it would start an agent',
    );
    assert.ok(
        html.includes('data-kind="shell"'),
        'the baseline projection (a plain shell) is not shown at all',
    );
    // The two facts are carried on separate attributes so neither can be
    // read as the other.
    assert.ok(html.includes('data-now-kind="not_dead"'));
});

test('the baseline option leads and carries the projection', () => {
    const w = loadPicker();
    const html = w.SessionRestartPicker.optionsHtml(LIVE_PREVIEW);
    const first = html.indexOf('value=""');
    const second = html.indexOf('value="claude-chrome"');
    assert.ok(first !== -1 && second !== -1, 'an option is missing entirely');
    assert.ok(first < second, 'the baseline option is not first');
    assert.ok(
        html.includes('leave it on claude-chrome'),
        'the baseline does not name the wrapper the session already records',
    );
    assert.ok(
        html.includes('restart-picker__current'),
        'the current wrapper is not marked',
    );
});

test('a dead pane makes the matching option pickable', () => {
    const w = loadPicker();
    const dead = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    dead.pane_state = 'dead';
    dead.unchanged = {
        kind: 'shell',
        detail: 'this pane was opened as a plain shell; restarting opens one again',
        actionable: true,
    };
    dead.options[0].actionable_now = true;
    dead.options[0].kind = 'agent';
    const html = w.SessionRestartPicker.optionsHtml(dead);
    const inputs = html.match(/<input[^>]*>/g) || [];
    assert.equal(inputs.length, 2);
    for (const tag of inputs) {
        assert.ok(!/\sdisabled/.test(tag), `a dead pane's option is locked: ${tag}`);
    }
});

test('an unreadable wrapper list is not an empty one', () => {
    const w = loadPicker();
    const unreadable = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    unreadable.options = [];
    unreadable.wrappers_status = 'unavailable';
    const empty = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    empty.options = [];
    empty.wrappers_status = 'ok';

    const a = w.SessionRestartPicker.wrapperNoticeHtml(unreadable);
    const b = w.SessionRestartPicker.wrapperNoticeHtml(empty);
    assert.notEqual(a, b, 'could-not-read renders identically to has-none');
    assert.ok(a.includes('could not be read'));
    assert.ok(a.includes('not the same as having none'));
    assert.ok(b.includes('no launch wrappers are'));
});

test('a live or unreadable pane is named before the list', () => {
    const w = loadPicker();
    assert.ok(
        w.SessionRestartPicker.noticeHtml(LIVE_PREVIEW).includes('still running'),
        'a live session is not told it cannot be restarted yet',
    );
    const unknown = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    unknown.pane_state = 'unknown';
    const text = w.SessionRestartPicker.noticeHtml(unknown);
    assert.ok(text.includes('could not be determined'));
    assert.ok(
        text.includes('not the same as it being fine'),
        'an unreadable pane reads as a healthy one',
    );
    const dead = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    dead.pane_state = 'dead';
    assert.ok(
        !w.SessionRestartPicker.noticeHtml(dead).includes('still running'),
        'a dead pane is warned about as if it were live',
    );
});

test('a hostile wrapper id cannot break out of the markup', () => {
    const w = loadPicker();
    const hostile = JSON.parse(JSON.stringify(LIVE_PREVIEW));
    hostile.options[0].agent_type = '"><img src=x onerror=alert(1)>';
    hostile.options[0].label = '<script>bad()</script>';
    const html = w.SessionRestartPicker.optionsHtml(hostile);
    assert.ok(!html.includes('<img'), 'an attribute broke out of its quotes');
    assert.ok(!html.includes('<script>'), 'a label was injected as markup');
});

runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
console.log('ALL PASS');
