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
    // THE FLAG THE MARK-UNREAD PLUGIN READS. Mutable, so a block below
    // can switch the control off and read the menu again.
    fakeWindow.UIFlags = {
        _show: true,
        showMarkUnreadControl() { return this._show; },
    };

    const context = { window: fakeWindow, document: fakeDocument, console };
    vm.createContext(context);
    vm.runInContext(readClientJs('kebab-icon.js'), context);
    vm.runInContext(readClientJs('session-status-ui.js'), context);
    vm.runInContext(readClientJs('session-row-actions-confirm.js'), context);
    vm.runInContext(readClientJs('session-row-actions.js'), context);
    vm.runInContext(readClientJs('session-sidebar-rows.js'), context);
    // The row's action controls MOVED into the overflow menu. The module
    // that builds them from a row's kebab is loaded here so the
    // invariants below can still be asserted over what a row OFFERS,
    // rather than quietly narrowing to what a row happens to draw inline.
    vm.runInContext(readClientJs('session-row-menu-items.js'), context);
    vm.runInContext(readClientJs('session-row-menu-plugins.js'), context);
    vm.runInContext(readClientJs('session-row-menu.js'), context);
    // THE REAL COMPILED BUNDLE, not a stand-in. client/dist/app.js is
    // emitted with no import or export statement, so it runs in this same
    // sandbox and publishes the real `window.CloudeWeb` - which is what
    // makes the plugin assertions below a test of the shipped path rather
    // than of a fixture that agrees with whatever it was built to agree
    // with. It is the committed artifact, and scripts/web-build-check.sh
    // is what keeps that artifact current.
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, '..', 'client', 'dist', 'app.js'), 'utf8'),
        context);

    return {
        Rows: fakeWindow.SessionSidebarRows,
        StatusUI: fakeWindow.SessionStatusUI,
        RowActions: fakeWindow.SessionRowActions,
        RowMenu: fakeWindow.SessionRowMenu,
        Win: fakeWindow,
    };
}

const { Rows, RowActions, RowMenu, Win } = makeSandbox();

/**
 * Description: everything a row OFFERS the user - its own markup PLUS
 *   the markup of the menu its kebab opens. Pin, mark-unread and
 *   close/restart/remove are behind that kebab now, so an invariant
 *   about what a row offers has to read both halves or it silently
 *   becomes an invariant about nothing.
 *
 *   The kebab's attributes are parsed back OUT of the rendered row
 *   rather than rebuilt from the fixture, so this exercises the real
 *   chain: rowHtml -> kebab attributes -> menu contents. A kebab that
 *   stopped carrying the row's state would fail here.
 * Inputs: r (object) - one row fixture.
 * Output: string - row HTML concatenated with its menu's HTML.
 */
function offeredActions(r) {
    const html = Rows.rowHtml(r);
    const inline = [...html.matchAll(/data-session-action="([^"]+)"/g)]
        .map((m) => m[1]);
    const tag = (html.match(/<button[^>]*data-row-menu="[^"]*"[^>]*>/) || [])[0];
    let menu = [];
    if (tag) {
        const stub = {
            getAttribute(name) {
                const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
                return m ? m[1] : null;
            },
        };
        menu = RowMenu.itemsFor(RowMenu.contextFromTrigger(stub)).map((i) => i.id);
    }
    return { html, inline, menu, all: [...inline, ...menu] };
}

/**
 * Description: the row's rendered kebab, as something with getAttribute -
 *   parsed back OUT of real markup, so the frozen context under test is
 *   the one the browser would read.
 * Inputs: html (string) - one rendered row.
 * Output: object - a getAttribute stub.
 */
function triggerOf(html) {
    const tag = (html.match(/<button[^>]*data-row-menu="[^"]*"[^>]*>/) || [])[0] || '';
    return {
        getAttribute(name) {
            const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
            return m ? m[1] : null;
        },
    };
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
    // KNOWN, PRE-EXISTING, OUT OF SCOPE: SessionStatusUI.markUnreadHtml()
    // interpolates the same name into `data-mark-unread="..."` WITHOUT
    // escaping it, so a name containing a double quote breaks out of that
    // attribute. That sink lives in client/js/session-status-ui.js and is
    // reached identically from the launchpad, so it is not this module's
    // to fix and is reported separately rather than patched here.
    //
    // The slice used to stop at 'mark-unread-toggle', the first thing on
    // the row this module did not write. That control moved into the
    // overflow menu, so the boundary moved with it: the kebab is now the
    // last thing rowHtml() emits from another module's builder, and
    // client/js/session-row-menu.js escapes its own attributes.
    const html = Rows.rowHtml(row({ name: 'evil" onclick="x', session_id: 'a" onload="y' }));
    assert.ok(!html.includes('onclick="'), 'attribute injection must not survive escaping');
    assert.ok(!html.includes('onload="'));
    assert.ok(html.includes('evil&quot; onclick=&quot;x'), 'quotes must be entity-escaped');
    const scripted = Rows.rowHtml(row({ name: '<script>x</script>' }));
    assert.ok(!/<script/i.test(scripted));
});

test('a live row draws pin inline and everything else in ONE menu', () => {
    // THE SPLIT THE OWNER RULED on 2026-09-10, asserted as facts rather
    // than as absences: pin stays on the line because it is a state the
    // eye reads at a glance, and every other action folds into a single
    // trigger. A DEAD row is the exception and is covered by its own case
    // below.
    for (const status of ['working', 'idle', 'question', 'unknown']) {
        const html = Rows.rowHtml(row({ status, is_pinned: true, unread: true }));
        assert.equal(
            (html.match(/data-row-menu=/g) || []).length, 1,
            `status ${status} must paint exactly one menu trigger`);
        assert.equal((html.match(/data-pin-session=/g) || []).length, 1,
            'the pin toggle IS drawn inline - adam\'s placement, taken');
        assert.equal((html.match(/data-mark-unread=/g) || []).length, 0,
            'mark unread rides in the menu, not on the line');
        assert.equal((html.match(/data-group-pick=/g) || []).length, 0,
            'group filing rides in the menu, not on the line');
        assert.equal(
            (html.match(new RegExp(`${RowActions.ATTR_ACTION}=`, 'g')) || []).length, 0,
            'a live row draws no inline close, remove or restart - they are '
            + 'menu items now');
    }
});

test('a DEAD row keeps its inline controls and draws no menu', () => {
    // Decision 4 sends a dead row to Recent, so this is the honest
    // rendering of one still on screen rather than a surface anyone is
    // meant to live on. It keeps restart and remove inline because those
    // are what a stopped session needs, and none of the menu's items is.
    const html = Rows.rowHtml(row({ status: 'dead', is_pinned: true }));
    assert.equal((html.match(/data-row-menu=/g) || []).length, 0,
        'a dead row draws no menu trigger');
    const offered = offeredActions(row({ status: 'dead' }));
    assert.deepEqual(offered.inline.sort(), ['remove', 'restart'],
        'a dead row offers restart and remove, inline');
    assert.deepEqual(offered.menu, [], 'and no menu items at all');
});

test('the trigger carries the row state its menu is built from', () => {
    // IDENTITY IS CAPTURED AT PAINT TIME. The list repaints every five
    // seconds, so the menu reads a frozen snapshot off the trigger rather
    // than the live row - if the trigger stopped carrying a fact, the
    // item that needs it would silently act on a default.
    const html = Rows.rowHtml(row({ is_pinned: true, unread: true, status: 'working' }));
    assert.ok(html.includes('data-row-menu-status="working"'),
        'status, which is what decides whether restart is offered');
    assert.ok(html.includes('data-row-menu-unread="1"'),
        'unread, which is what decides the mark-unread label');
});

test('the group chip is removed, not commented out - no definition left behind', () => {
    // "no i dont need to see the group name in the item. its in the group
    // i can see the group on the sidebar." The chip's builder used to
    // live here; its action moved to session-sidebar-group-actions.js
    // .rowMenuItemHtml, which client/js/session-row-menu.js pulls into
    // the kebab. Nothing chip-shaped should remain in THIS module.
    const src = readClientJs('session-sidebar-rows.js');
    assert.ok(!src.includes('groupChipHtml'),
        'session-sidebar-rows.js must not still define the removed chip builder');
    assert.ok(!src.includes('data-group-pick'),
        'session-sidebar-rows.js must not still emit the chip\'s action attribute');
    assert.ok(!src.includes('session-sidebar-row-group'),
        'session-sidebar-rows.js must not still reference the chip\'s CSS class');
});

test('every row offers exactly one DESTRUCTIVE control, inline or in its menu', () => {
    // The invariant is about the destructive pair: close and remove make
    // opposite promises, so a row may offer exactly one of them, never
    // both. Asked over what the row OFFERS rather than what it happens to
    // draw inline, because after the 2026-09-10 reconcile a live row's
    // close lives in the menu and a dead row's remove does not.
    for (const status of ['working', 'dead', 'idle', 'question']) {
        const offered = offeredActions(row({ status }));
        const destructive = offered.all.filter(
            (a) => a === 'close' || a === 'remove').length;
        assert.equal(
            destructive, 1,
            `status ${status} must offer exactly one destructive control`,
        );
    }
});

test('a LIVE row offers RESTART - decision 3, and the regression guard', () => {
    // THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE REGRESSION. Adam's
    // branch removed restart from a live row and the owner ruled it back
    // on 2026-09-09 (decision 3 of the 1.2 merge). It is offered through
    // the MENU now rather than as an inline icon, which is why this asks
    // what the row offers rather than what it draws.
    //
    // A dead row is checked here too: its restart is inline, and both
    // routes must keep working or "restart a session" quietly becomes
    // "restart a session that already died".
    for (const status of ['working', 'working_subagent', 'question', 'notice',
        'finished_unread', 'idle', 'running']) {
        const offered = offeredActions(row({ status }));
        assert.ok(offered.menu.includes('restart'),
            `a live row (${status}) must offer restart in its menu`);
        assert.ok(!offered.inline.includes('restart'),
            `a live row (${status}) offers restart through the menu, not inline`);
    }
    const dead = offeredActions(row({ status: 'dead' }));
    assert.ok(dead.inline.includes('restart'),
        'a dead row keeps its inline restart');
});

test('an UNDETERMINED row is still offered no restart - the original rule, kept', () => {
    // The half of the old prohibition that is still correct and still
    // load-bearing: a row the attachable probe alone produced carries
    // `unknown`, and offering to restart a session whose state we could
    // not read is exactly the guess this app refuses to make. It must be
    // absent from the MENU too, not merely from the row's inline icons.
    for (const status of ['unknown', undefined, null, '']) {
        const offered = offeredActions(row({ status }));
        assert.ok(!offered.all.includes('restart'),
            `status ${String(status)} must offer no restart, anywhere`);
    }
});

test('MARK UNREAD IS STILL OFFERED, and it arrives from the plugin surface', () => {
    // THE RE-SEAT, ASSERTED AS A FACT RATHER THAN AS AN ABSENCE. The item
    // used to be a hardcoded entry in session-row-menu-items.js. It is now
    // the first `session-card-action` on the compiled registry
    // (web/src/lib/plugins/mark-unread/), merged into the menu's own table
    // by itemsFor. What the user sees must not have moved, so this checks
    // that it is offered EXACTLY ONCE, in the ruled position, saying the
    // shipped words - and not merely that something appeared.
    for (const unread of [false, true]) {
        const offered = offeredActions(row({ unread }));
        assert.equal(offered.menu.filter((id) => id === 'mark-unread').length, 1,
            `unread=${unread} must offer exactly one mark-unread`);
        assert.equal(offered.menu[1], 'mark-unread',
            'and it keeps the second slot the owner ruled it into');
        const item = RowMenu.itemsFor(RowMenu.contextFromTrigger(triggerOf(offered.html)))
            .find((i) => i.id === 'mark-unread');
        assert.equal(item.shortcut, 'U');
        assert.equal(item.enabled, true);
        assert.equal(item.label,
            unread ? 'clear unread' : 'mark unread');
    }
});

test('NEGATIVE CONTROL: the flag off removes it, and nothing else', () => {
    // `ui.show_mark_unread_control` is still the one switch. It now reaches
    // the item through the contribution's `enabled` instead of through an
    // early return in a builder, and this proves the gate survived the move
    // - in BOTH directions, so a surface that had silently stopped
    // registering anything could not pass.
    const before = offeredActions(row()).menu;
    assert.ok(before.includes('mark-unread'));

    Win.UIFlags._show = false;
    try {
        const after = offeredActions(row()).menu;
        assert.ok(!after.includes('mark-unread'),
            'the flag off must remove the plugin-contributed item');
        assert.deepEqual(Array.from(after),
            Array.from(before.filter((id) => id !== 'mark-unread')),
            'the flag must take that item and nothing else');
    } finally {
        Win.UIFlags._show = true;
    }
    assert.ok(offeredActions(row()).menu.includes('mark-unread'),
        'and it comes back when the flag does');
});

test('the hardcoded copy is GONE from the menu, not commented out', () => {
    // No dual path. If the old table entry or the old click route came
    // back beside the plugin, the item would render twice or be run by two
    // handlers, and both are the kind of thing that reads fine in a diff.
    //
    // Matched on the CALL form, `name(`, not on the bare name: the
    // modules' docblocks record what moved and where it went, and a check
    // that forbade naming the deleted function would force that history to
    // be deleted with it. A stale doc is worse than no doc; an accurate one
    // is not a regression.
    const items = readClientJs('session-row-menu-items.js');
    assert.ok(!items.includes("id: 'mark-unread'"),
        'the item table must not still carry a hardcoded entry');
    const menu = readClientJs('session-row-menu.js');
    assert.ok(!menu.includes('markUnreadHtml('),
        'session-row-menu.js must not still probe the legacy builder');
    const actions = readClientJs('session-row-menu-actions.js');
    assert.ok(!actions.includes('onMarkUnreadClick('),
        'the runner must not still route to the old sidebar handler');
    const clicks = readClientJs('session-sidebar-clicks.js');
    assert.ok(!clicks.includes('onMarkUnreadClick'),
        'the old handler must be deleted, not left unreachable');
    const sidebar = readClientJs('session-sidebar.js');
    assert.ok(!sidebar.includes('_onMarkUnreadClick'),
        'the sidebar must not still carry a method reaching the old handler');
});

test('the plugin path is LOUD when the compiled bundle is missing', () => {
    // A menu that silently drops a shipped item is the false green this
    // project keeps paying for, so the bridge reports rather than returning
    // an empty list quietly. Note it reports on the FUNCTION being absent,
    // not on an empty result: an empty result is what the flag being off
    // looks like, and those two must not be confused.
    const held = Win.CloudeWeb;
    const errors = [];
    const realError = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
        delete Win.CloudeWeb;
        const offered = offeredActions(row());
        assert.ok(!offered.menu.includes('mark-unread'));
        assert.ok(errors.length > 0, 'it reports, rather than staying silent');
        assert.ok(errors.every((e) => e.includes('sessionCardMenuItems')));
    } finally {
        console.error = realError;
        Win.CloudeWeb = held;
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
