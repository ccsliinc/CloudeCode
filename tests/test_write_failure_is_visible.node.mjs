/**
 * A FAILED WRITE MUST REACH A SURFACE A SIGHTED USER CAN SEE.
 * ---------------------------------------------------------------------
 * THE BUG. The sidebar's group controls report every refusal through
 * `#session-sidebar-live`, which session-sidebar-density.css clips to
 * `width:1px; height:1px; clip:rect(0,0,0,0)`. That element exists for
 * assistive technology and it works: a screen reader user HEARS
 * "could not create the group: ...". A sighted user gets silence, so a
 * refused write is indistinguishable from a click that did nothing.
 *
 * The owner reported "new group" as broken. It was not broken. It
 * correctly refused, said so, and he could not see it said so. This is
 * the usual accessibility defect INVERTED - the accessible path works
 * and the visual one is missing - which is also why nothing caught it:
 * every existing test asserts the sentence, and the sentence was always
 * there.
 *
 * WHAT IS ASSERTED HERE, and why it is behaviour rather than a selector.
 * The module is loaded and RUN, its real write paths are driven with an
 * API that refuses, and both surfaces are then read back. A test that
 * asserted "announceFailure exists" or "the file mentions
 * WriteFailureNotice" would pass forever while someone rewired one call
 * site back to `announce`.
 *
 * THE NEGATIVE CONTROL IS THE POINT. The same driver is re-run against a
 * COPY of the module with `announceFailure` rewritten back to `announce`
 * - the pre-fix source, reproduced rather than described - and is
 * required to show the live region alone. Without that, a driver that
 * always reported "both surfaces" would pass every positive check.
 *
 * ALSO GATED: all six failure sentences in the module go through the
 * dual-surface reporter, not just the two this file can cheaply drive.
 * That is a source rule, held ALONGSIDE the behavioural checks rather
 * than instead of them, the same way tests/test_no_remote_assets.py
 * gates a pattern that no runtime check can see.
 *
 * Run with: node tests/test_write_failure_is_visible.node.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let passes = 0;
let failures = 0;

/**
 * Run one named check.
 *
 * @param {string} name - what is being asserted.
 * @param {Function} fn - the body; throwing or rejecting fails it.
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

const GROUP_ACTIONS = path.join(repoRoot, 'client', 'js', 'session-sidebar-group-actions.js');
const NOTICE = path.join(repoRoot, 'client', 'js', 'write-failure-notice.js');
const TOAST = path.join(repoRoot, 'client', 'js', 'toast.js');

/**
 * Stand the module up in a sandbox with recorders on both surfaces.
 *
 * The REAL `write-failure-notice.js` is loaded too, rather than stubbed,
 * so this exercises the actual record it builds and the actual
 * `ToastManager.add` contract - the seam most likely to rot. Only
 * `ToastManager` itself is a recorder, because rendering a card needs a
 * browser and what matters here is that a card was ASKED FOR.
 *
 * @param {string} source - the module text to run (the real file, or a
 *   mutated copy for the negative control).
 * @returns {object} `{api, spoken, cards, calls}` - the module's exports
 *   plus what each surface received.
 */
function standUp(source) {
    /** Everything written into the clipped live region. */
    const spoken = [];
    /** Every toast record handed to the manager. */
    const cards = [];
    /** Which write API was called, in order. */
    const calls = [];

    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    sandbox.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: {}, classList: { add() {}, remove() {} },
            setAttribute() {}, appendChild() {}, addEventListener() {},
            children: [], querySelector: () => null, querySelectorAll: () => [],
        }),
        addEventListener() {},
        body: { appendChild() {}, contains: () => false },
    };
    sandbox.prompt = () => 'probe group';
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;

    // The live region, through the same module the real code borrows it
    // from. This IS the clipped surface.
    sandbox.SessionSidebarReorder = { announce: (text) => spoken.push(String(text)) };

    // The visible surface. Recorded at the ToastManager seam so the real
    // write-failure-notice.js runs unmodified.
    sandbox.ToastManager = {
        WRITE_FAILED_KIND: 'WriteFailed',
        add: (record) => cards.push(record),
    };

    sandbox.SessionSidebarGroupStore = {
        isUsable: () => true,
        apply() {}, setOptimistic() {},
        labelFor: () => 'a group', bandKeyFor: () => 'k',
        groups: () => [],
    };
    sandbox.SessionSidebar = { repaint() {} };

    const REFUSED = '409 groups are read only here';
    sandbox.API = {
        createSessionGroup: async () => { calls.push('create'); throw new Error(REFUSED); },
        assignSessionGroup: async () => { calls.push('assign'); throw new Error(REFUSED); },
        renameSessionGroup: async () => { calls.push('rename'); throw new Error(REFUSED); },
        deleteSessionGroup: async () => { calls.push('delete'); throw new Error(REFUSED); },
        reorderSessionGroups: async () => { calls.push('reorder'); throw new Error(REFUSED); },
        listSessionGroups: async () => ({ groups: [] }),
    };

    const ctx = vm.createContext(sandbox);
    // toast.js is loaded for its registry only; the recorder above is
    // what the notice actually talks to.
    vm.runInContext(fs.readFileSync(NOTICE, 'utf8'), ctx, { filename: NOTICE });
    vm.runInContext(source, ctx, { filename: GROUP_ACTIONS });

    return { sandbox, api: sandbox.SessionSidebarGroupActions, spoken, cards, calls, REFUSED };
}

// ---------------------------------------------------------------------
// The behaviour: drive real write paths that refuse.
// ---------------------------------------------------------------------

await test('a refused group CREATE reaches both surfaces, with one sentence', async () => {
    const env = standUp(fs.readFileSync(GROUP_ACTIONS, 'utf8'));
    await env.api.createGroupThenAssign(null);

    assert.deepEqual(env.calls, ['create'], 'the create write was not attempted');
    assert.equal(env.spoken.length, 1, `live region got ${env.spoken.length} messages`);
    assert.match(env.spoken[0], /could not create the group/);
    assert.equal(env.cards.length, 1, 'no visible card was raised for a failed create');
    assert.equal(
        env.cards[0].body, env.spoken[0],
        'the card and the announcement say different things about one failure',
    );
});

await test('a refused MOVE reaches both surfaces, with one sentence', async () => {
    const env = standUp(fs.readFileSync(GROUP_ACTIONS, 'utf8'));
    const landed = await env.api.commitAssignment('cloude_probe', 'u1');

    assert.equal(landed, false, 'a refused move reported success');
    assert.equal(env.spoken.length, 1, `live region got ${env.spoken.length} messages`);
    assert.match(env.spoken[0], /could not move cloude_probe/);
    assert.equal(env.cards.length, 1, 'no visible card was raised for a failed move');
    assert.equal(env.cards[0].body, env.spoken[0]);
});

await test('a SUCCESSFUL write raises no failure card', async () => {
    // The control that keeps this from being "always shows a card".
    const env = standUp(fs.readFileSync(GROUP_ACTIONS, 'utf8'));
    env.sandbox.API.assignSessionGroup = async () => ({ groups: [] });
    const landed = await env.api.commitAssignment('cloude_probe', null);

    assert.equal(landed, true, 'a successful move reported failure');
    assert.equal(env.spoken.length, 1, 'the success was not announced');
    assert.match(env.spoken[0], /moved to/);
    assert.equal(env.cards.length, 0, 'a successful write raised a failure card');
});

await test('the card carries what a card needs: local, no session, a named surface', async () => {
    const env = standUp(fs.readFileSync(GROUP_ACTIONS, 'utf8'));
    await env.api.createGroupThenAssign(null);
    const card = env.cards[0];

    assert.equal(card.local, true, 'not marked local: dismissing would ack an id no server minted');
    assert.equal(card.session_id, null, 'a session id would fold this into a conversation card');
    assert.ok(card.session_label, 'no identity line: the card would claim "unknown session"');
    assert.equal(card.kind, 'WriteFailed');
    assert.ok(card.id && String(card.id).length > 8, 'no usable record id');
});

await test('the kind is registered CAP-EXEMPT, so a failure cannot hide behind "+2 more"', () => {
    const toast = fs.readFileSync(TOAST, 'utf8');
    const kind = /const WRITE_FAILED_KIND = '([^']+)'/.exec(toast);
    assert.ok(kind, 'toast.js does not declare the write-failure kind');
    assert.equal(kind[1], 'WriteFailed');

    const exempt = /const CAP_EXEMPT_SEVERITY = (\d+)/.exec(toast);
    assert.ok(exempt, 'toast.js no longer declares a cap-exempt threshold');
    const severity = /\[WRITE_FAILED_KIND\]:\s*(\d+)/.exec(toast);
    assert.ok(severity, 'the write-failure kind has no severity, so it takes the default');
    assert.ok(
        Number(severity[1]) >= Number(exempt[1]),
        `severity ${severity[1]} is below the cap exemption ${exempt[1]}: `
        + 'a failed write could be pushed into overflow and become invisible again',
    );
});

// ---------------------------------------------------------------------
// The source gate: all six failure paths, not just the two driven above.
// ---------------------------------------------------------------------

await test('every failure sentence in the module goes through the dual-surface reporter', () => {
    const src = fs.readFileSync(GROUP_ACTIONS, 'utf8');
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('announce(') && !trimmed.startsWith('else announce(')) return;
        if (/could not|cannot|unavailable|failed/.test(trimmed)) {
            offenders.push(`${i + 1}: ${trimmed}`);
        }
    });
    assert.deepEqual(
        offenders, [],
        'these failures reach the clipped live region ONLY:\n  ' + offenders.join('\n  '),
    );

    const viaReporter = lines.filter((l) => l.trim().startsWith('announceFailure(')).length;
    assert.equal(
        viaReporter, 6,
        `expected 6 failure paths through announceFailure, found ${viaReporter}. `
        + 'If a path was legitimately added or removed, update this count deliberately.',
    );
});

// ---------------------------------------------------------------------
// NEGATIVE CONTROL: reproduce the pre-fix module and require it to fail.
// ---------------------------------------------------------------------

await test('NEGATIVE CONTROL: the pre-fix module reaches the live region alone', async () => {
    const real = fs.readFileSync(GROUP_ACTIONS, 'utf8');
    // Exactly the pre-fix source: DELETE the dual-surface reporter, then
    // put every failure path back on the clipped-only `announce`. The
    // definition has to go first - renaming it in place would leave
    // `announce` calling itself.
    const start = real.indexOf('    function announceFailure(text) {');
    assert.notEqual(start, -1, 'the reporter is gone; this control describes nothing');
    const end = real.indexOf('\n    }\n', start) + '\n    }\n'.length;
    const withoutReporter = real.slice(0, start) + real.slice(end);
    assert.ok(
        !withoutReporter.includes('function announceFailure'),
        'the reporter definition survived the cut',
    );
    const preFix = withoutReporter.split('announceFailure(').join('announce(');
    assert.notEqual(preFix, real, 'nothing was rewritten, so this control reproduces nothing');
    assert.ok(
        !preFix.includes('WriteFailureNotice'),
        'the pre-fix copy can still reach the visible surface, so it is not the pre-fix state',
    );

    const env = standUp(preFix);
    await env.api.createGroupThenAssign(null);

    assert.equal(env.spoken.length, 1, 'the pre-fix module did not even announce');
    assert.equal(
        env.cards.length, 0,
        'the pre-fix module raised a card, so this control is not reproducing the bug',
    );
    // And the positive assertion above must be false against it.
    assert.throws(
        () => { assert.equal(env.cards.length, 1); },
        'the positive check still passed against the pre-fix module',
    );
});

await test('NEGATIVE CONTROL: the driver can tell "no surface" from "one surface"', async () => {
    // With no ToastManager at all the notice must refuse rather than
    // pretend, so a broken toast layer cannot read as a working one.
    const env = standUp(fs.readFileSync(GROUP_ACTIONS, 'utf8'));
    env.sandbox.ToastManager = undefined;
    await env.api.createGroupThenAssign(null);
    assert.equal(env.spoken.length, 1, 'the announcement was lost');
    assert.equal(env.cards.length, 0, 'a card was recorded with no manager to record it');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
