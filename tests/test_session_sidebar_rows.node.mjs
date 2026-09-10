// Node-based tests for client/js/session-sidebar-rows.js - the row markup
// and repaint signature extracted out of session-sidebar.js when that file
// hit the project's 500-line ceiling.
//
// WHY THIS FILE EXISTS: the extraction moved working, untested markup into
// a new module. These assertions pin the parts a silent refactor could have
// broken - escaping, the active-row flag, the empty state, and the repaint
// signature that keeps the 5s poll from thrashing the list.
//
// Run with: node tests/test_session_sidebar_rows.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read one client JS module's source. */
function readClientJs(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'js', name), 'utf8');
}

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
 * Load the row module alongside the two shared modules it composes, with a
 * document stub good enough for their HTML escaping (each builds a detached
 * div and reads innerHTML back).
 * Inputs: none. Output: object - {Rows, StatusUI, RowActions}.
 */
function makeSandbox() {
    /** Minimal stand-in for a detached element used only for escaping. */
    function makeEscapingDiv() {
        let text = '';
        return {
            set textContent(v) { text = v == null ? '' : String(v); },
            get textContent() { return text; },
            get innerHTML() {
                return text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            },
        };
    }

    const fakeDocument = {
        createElement() { return makeEscapingDiv(); },
        getElementById() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
    };
    const fakeWindow = { App: { showConfirmModal: () => Promise.resolve(true) } };
    fakeWindow.window = fakeWindow;

    const context = { window: fakeWindow, document: fakeDocument, console };
    vm.createContext(context);
    vm.runInContext(readClientJs('kebab-icon.js'), context);
    vm.runInContext(readClientJs('session-status-ui.js'), context);
    vm.runInContext(readClientJs('session-row-actions.js'), context);
    vm.runInContext(readClientJs('session-row-menu.js'), context);
    vm.runInContext(readClientJs('session-sidebar-rows.js'), context);

    return {
        Rows: fakeWindow.SessionSidebarRows,
        StatusUI: fakeWindow.SessionStatusUI,
        RowActions: fakeWindow.SessionRowActions,
    };
}

const { Rows, RowActions } = makeSandbox();

/**
 * Description: everything a row OFFERS the user. That is now the row's
 *   own markup and nothing else: pin and close/restart/remove came back
 *   out of the overflow menu on 2026-09-08 and are inline again, so
 *   there is no second half to concatenate.
 *
 *   KEPT AS A FUNCTION RATHER THAN INLINED. It exists to name the
 *   distinction between what a row DRAWS and what a row OFFERS, and the
 *   two were different for a whole release. Assertions written against
 *   this name stay correct if a control is ever folded away again.
 * Inputs: r (object) - one row fixture.
 * Output: string - the row's HTML.
 */
function offeredHtml(r) {
    return Rows.rowHtml(r);
}

/** One ordinary row fixture. Inputs: overrides (object). Output: object. */
function row(overrides = {}) {
    return {
        name: 'cloude_api',
        status: 'working',
        created_by_cloude: true,
        is_active: true,
        is_this_tab: false,
        unread: false,
        session_id: null,
        ...overrides,
    };
}

test('an empty list renders the empty state, not an empty container', () => {
    const html = Rows.listHtml([]);
    assert.ok(html.includes('session-sidebar-empty'));
    assert.ok(!html.includes('session-sidebar-row"'));
    assert.equal(Rows.listHtml(null), html, 'null must behave as empty, not throw');
});

test('this tab is the only row flagged active', () => {
    const html = Rows.listHtml([row({ name: 'a', is_this_tab: true }), row({ name: 'b' })]);
    assert.equal((html.match(/data-active="1"/g) || []).length, 1);
    assert.equal((html.match(/data-active="0"/g) || []).length, 1);
});

test('the tmux/external badge follows created_by_cloude', () => {
    assert.ok(Rows.rowHtml(row({ created_by_cloude: true })).includes('>tmux<'));
    assert.ok(Rows.rowHtml(row({ created_by_cloude: false })).includes('>external<'));
});

test('session_id is emitted only when the row actually has one', () => {
    assert.ok(!Rows.rowHtml(row()).includes('data-session-id'));
    assert.ok(Rows.rowHtml(row({ session_id: 'sid-1' })).includes('data-session-id="sid-1"'));
});

test('a hostile session name cannot break out of THIS module s own markup', () => {
    // Scoped to the attributes and text session-sidebar-rows.js writes
    // itself: data-name, data-session-id, and the visible row name.
    //
    // The slice used to stop at the unread envelope, the first thing on
    // the row this module did not write. That control is gone entirely -
    // the status light says unread now - and the boundary is the inline
    // pin and action control, which escape their own attributes in
    // pinButtonHtml and client/js/session-row-actions.js.
    const html = Rows.rowHtml(row({ name: 'evil" onclick="x', session_id: 'a" onload="y' }));
    assert.ok(!html.includes('onclick="'), 'attribute injection must not survive escaping');
    assert.ok(!html.includes('onload="'));
    assert.ok(html.includes('evil&quot; onclick=&quot;x'), 'quotes must be entity-escaped');
    const scripted = Rows.rowHtml(row({ name: '<script>x</script>' }));
    assert.ok(!/<script/i.test(scripted));
});

test('a live row draws pin plus the three-dot MENU; a dead row draws pin plus its two inline controls', () => {
    // The split, asserted as a fact on both sides rather than as an
    // absence on one. A live row's close X became the menu, so the two
    // are mutually exclusive by construction; a dead row is untouched,
    // because restart and remove are what a stopped session needs and
    // none of the five menu items is.
    for (const status of ['working', 'idle', 'question', 'unknown']) {
        const html = Rows.rowHtml(row({ status, is_pinned: true, unread: true }));
        assert.equal((html.match(/data-row-menu=/g) || []).length, 1,
            `status ${status} must paint exactly one menu trigger`);
        assert.equal(
            (html.match(new RegExp(`${RowActions.ATTR_ACTION}=`, 'g')) || []).length, 0,
            `status ${status} must not ALSO paint the inline close it replaced`);
        assert.equal((html.match(/data-pin-session=/g) || []).length, 1,
            `status ${status} must keep exactly one inline pin`);
        assert.equal((html.match(/data-mark-unread=/g) || []).length, 0,
            'the mark-unread toggle is gone from the app entirely');
        assert.equal((html.match(/data-group-pick=/g) || []).length, 0,
            'filing is reached by drag, by `g` on a focused row, or by Alt+Arrow');
    }
    const dead = Rows.rowHtml(row({ status: 'dead', is_pinned: true }));
    assert.equal((dead.match(/data-row-menu=/g) || []).length, 0,
        'a dead row gets no menu - restart and remove are what it needs');
    assert.ok(dead.includes(`${RowActions.ATTR_ACTION}="restart"`));
    assert.ok(dead.includes(`${RowActions.ATTR_ACTION}="remove"`));
    // The row carries the status the restart picker reads.
    assert.ok(dead.includes('data-row-status="dead"'));
    assert.ok(!dead.includes('data-row-pinned='),
        'pinned state is carried by the pin button\'s aria-pressed, not a '
        + 'second attribute');
    assert.ok(!dead.includes('data-row-unread='));
    assert.ok(Rows.rowHtml(row({ status: undefined })).includes('data-row-status="unknown"'),
        'a row with no status says unknown out loud rather than saying nothing');
});

test('the menu trigger captures the row identity the items will act on', () => {
    const html = Rows.rowHtml(row({
        status: 'working', name: 'cloude_api', label: 'API work',
        session_id: 'ses_1', created_by_cloude: true,
    }));
    assert.ok(html.includes('data-row-menu="cloude_api"'));
    assert.ok(html.includes('data-row-menu-session-id="ses_1"'));
    assert.ok(html.includes('data-row-menu-surface="sidebar"'));
    assert.ok(html.includes('data-row-menu-renameable="1"'),
        'a row with a live backend can be renamed, and the menu must agree with it');
    const external = Rows.rowHtml(row({
        status: 'working', session_id: null, created_by_cloude: false,
    }));
    assert.ok(external.includes('data-row-menu-renameable="0"'));
    assert.ok(external.includes('data-row-menu-forkable="0"'),
        'a session cloudecode did not create has no conversation to branch');
    assert.ok(/data-row-menu-rename-reason="[^"]+"/.test(external),
        'and the refusal must travel with it as a sentence');
});

test('the pin keeps its accessible name and its pressed state inline', () => {
    // Inside the menu these controls were given a visible text label from
    // their own `title`. On the row they are icon-only again, so `title`
    // and `aria-label` are the whole accessible story and both must be
    // there. `aria-pressed` is what stops pinned from being shape-only.
    const unpinned = Rows.rowHtml(row({ is_pinned: false }));
    assert.ok(unpinned.includes('aria-pressed="false"'));
    assert.ok(unpinned.includes('title="pin to top"'));
    assert.ok(unpinned.includes('aria-label="Pin cloude_api to the top"'));
    const pinned = Rows.rowHtml(row({ is_pinned: true }));
    assert.ok(pinned.includes('aria-pressed="true"'));
    assert.ok(pinned.includes('title="unpin"'));
    assert.ok(pinned.includes('aria-label="Unpin cloude_api"'));
});

test('the inline action keeps its title and aria-label, on every status that has one', () => {
    // A live row no longer has an inline action - its close moved into
    // the menu - so only the dead row's pair is asserted here. The menu's
    // own labels are pinned in tests/test_session_row_menu.node.mjs.
    for (const [status, label] of [
        ['dead', 'remove from the list'],
        ['dead', 'restart the agent'],
    ]) {
        const html = Rows.rowHtml(row({ status }));
        assert.ok(html.includes(`title="${label}"`),
            `status ${status} must keep the hover tooltip "${label}"`);
        assert.ok(html.includes(`aria-label="${label}"`),
            `status ${status} must keep the accessible name "${label}"`);
    }
});

test('the pin sits BEFORE the action, and both sit after the name', () => {
    // Order is the muscle memory. Pre-kebab the line read name, then
    // pin, then the destructive control on the far right, and putting a
    // destructive control anywhere else would move it under a cursor
    // that had learned where it was.
    const live = Rows.rowHtml(row({ status: 'working' }));
    assert.ok(live.indexOf('session-sidebar-row-name') < live.indexOf('data-pin-session='),
        'the name column comes first and takes the slack');
    assert.ok(live.indexOf('data-pin-session=') < live.indexOf('data-row-menu='),
        'pin before the menu, which stands where the destructive control stood');
    const dead = Rows.rowHtml(row({ status: 'dead' }));
    assert.ok(dead.indexOf('data-pin-session=')
        < dead.indexOf(`${RowActions.ATTR_ACTION}="remove"`),
        'pin before the destructive control');
});

test('the group chip is removed, not commented out - no definition left behind', () => {
    // "no i dont need to see the group name in the item. its in the group
    // i can see the group on the sidebar." The chip's builder used to
    // live here. Nothing chip-shaped should remain in THIS module, and
    // nothing anywhere on the row opens the group picker now.
    const src = readClientJs('session-sidebar-rows.js');
    assert.ok(!src.includes('groupChipHtml'),
        'session-sidebar-rows.js must not still define the removed chip builder');
    assert.ok(!src.includes('data-group-pick'),
        'session-sidebar-rows.js must not still emit the chip\'s action attribute');
    assert.ok(!src.includes('session-sidebar-row-group'),
        'session-sidebar-rows.js must not still reference the chip\'s CSS class');
});

test('every row offers exactly ONE way to destroy the session, and never two', () => {
    // The invariant is about the destructive pair: close and remove make
    // opposite promises, so a row may offer exactly one of them, never
    // both, and never neither. What changed is WHERE close lives - a
    // live row reaches it through the menu item now, a dead row still
    // draws remove inline - so the count is taken across both surfaces
    // of the row rather than over the inline markup alone.
    for (const status of ['working', 'dead', 'idle', 'question']) {
        const html = offeredHtml(row({ status }));
        const inlineDestructive =
            (html.match(new RegExp(`${RowActions.ATTR_ACTION}="close"`, 'g')) || []).length
            + (html.match(new RegExp(`${RowActions.ATTR_ACTION}="remove"`, 'g')) || []).length;
        const menus = (html.match(/data-row-menu=/g) || []).length;
        assert.equal(inlineDestructive + menus, 1,
            `status ${status} must offer exactly one route to destruction`);
        assert.equal(
            (html.match(/data-pin-session=/g) || []).length, 1,
            `status ${status} must paint exactly one pin toggle`,
        );
        const restarts =
            (html.match(new RegExp(`${RowActions.ATTR_ACTION}="restart"`, 'g')) || []).length;
        // ONE ON A DEAD ROW, NONE ANYWHERE ELSE. A live row briefly
        // offered restart; the owner removed that control on 2026-09-08
        // and the menu that replaced its close does not carry it back.
        // The dead row keeps it because a pane holding an exited process
        // is the case restart exists for, and it is still the only
        // surface in the app that reaches the respawn ladder.
        assert.equal(restarts, status === 'dead' ? 1 : 0,
            `status ${status} restart count`);
    }
});

test('an UNDETERMINED row is still offered no restart - the original rule, kept', () => {
    // Still correct and still load-bearing, and for its OWN reason
    // rather than the one that now also covers live rows: a row the
    // attachable probe alone produced carries `unknown`, and offering to
    // restart a session whose state we could not read is exactly the
    // guess this app refuses to make.
    for (const status of ['unknown', undefined, null, '']) {
        const html = offeredHtml(row({ status }));
        assert.equal(
            (html.match(new RegExp(`${RowActions.ATTR_ACTION}="restart"`, 'g')) || []).length,
            0,
            `status ${String(status)} must offer no restart control`,
        );
    }
});

test('the signature changes for every field the row actually shows', () => {
    const base = [row()];
    const sig = Rows.signature(base);
    const changes = [
        { status: 'idle' },
        { unread: true },
        { is_active: false },
        { is_this_tab: true },
        { name: 'other' },
    ];
    for (const change of changes) {
        assert.notEqual(
            Rows.signature([row(change)]), sig,
            `a change to ${Object.keys(change)[0]} must force a repaint`,
        );
    }
});

test('the signature is stable for an idle poll tick', () => {
    // This is what stops the 5s poll from rewriting the DOM and throwing
    // away focus and scroll position while the panel sits open.
    const rows = [row({ name: 'a' }), row({ name: 'b', status: 'idle' })];
    assert.equal(Rows.signature(rows), Rows.signature(rows.map((r) => ({ ...r }))));
    // A field the row does NOT render must not force a repaint either.
    const withNoise = rows.map((r) => ({ ...r, created_at_epoch: Date.now() }));
    assert.equal(Rows.signature(withNoise), Rows.signature(rows));
});

test('a missing status is normalized rather than leaking undefined', () => {
    assert.equal(Rows.signature([row({ status: undefined })]), Rows.signature([row({ status: 'unknown' })]));
});

await runQueue();
console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
