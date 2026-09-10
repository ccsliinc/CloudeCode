/**
 * WHICH CODE A CHOSEN MENU ITEM ACTUALLY REACHES.
 * ---------------------------------------------------------------------
 * The suite next door (test_session_row_menu_superset.node.mjs) fixes
 * WHAT the reconciled menu offers. This one fixes WHERE each item goes,
 * which is the half that decides whether the merge preserved behaviour or
 * merely preserved labels.
 *
 * THE POINT OF THE FILE IS THE RENAME PAIR. The owner's correction on
 * 2026-09-10 was "dont remove the rename. i said merge not take
 * everything": adam's commit deleted double-click rename and replaced it
 * with a menu item, and BOTH ship instead. Two entry points are only
 * safe while they are two doors onto ONE implementation - two copies
 * drift, and the drift is silent because each door looks fine from the
 * inside. So the cases below drive every entry point and assert they land
 * in the same place, and they would fail if someone gave the menu its own
 * rename.
 *
 * Written against BEHAVIOUR - which collaborator is called, and what
 * observable state results - so the Svelte rebuild on feat/svelte-1.3 can
 * satisfy them without rendering anything the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientJs = (f) => fs.readFileSync(
    path.join(__dirname, '..', 'client', 'js', f), 'utf8');

let passes = 0;
let failures = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runQueue() {
    for (const [name, fn] of queue) {
        try { await fn(); console.log(`ok - ${name}`); passes++; }
        catch (err) { console.log(`NOT OK - ${name}`); console.error(err); failures++; }
    }
}

/**
 * A DOM node good enough for the rename editor.
 *
 * Description: hand-rolled because this repo bundles no jsdom. It covers
 *   only what session-sidebar-rename.js touches; anything it does not
 *   support throws rather than silently returning undefined, so a test
 *   cannot pass by exercising nothing.
 * Inputs: tag (string). Output: object - a fake element.
 */
function el(tag = 'div') {
    const node = {
        tagName: tag.toUpperCase(),
        children: [],
        attrs: Object.create(null),
        dataset: Object.create(null),
        hidden: false,
        textContent: '',
        className: '',
        value: '',
        parent: null,
        getAttribute(n) { return n in node.attrs ? node.attrs[n] : null; },
        setAttribute(n, v) { node.attrs[n] = String(v); },
        removeAttribute(n) { delete node.attrs[n]; },
        appendChild(c) { c.parent = node; node.children.push(c); return c; },
        insertAdjacentElement(_pos, c) { c.parent = node.parent; return c; },
        addEventListener() {},
        removeEventListener() {},
        focus() {}, select() {}, remove() {},
        querySelector(sel) {
            const want = sel.replace(/[[\]]/g, '');
            const hit = (n) => Object.keys(n.attrs).some((a) => a === want)
                || n.className === want.replace(/^\./, '');
            const walk = (n) => {
                for (const c of n.children) {
                    if (hit(c)) return c;
                    const deep = walk(c);
                    if (deep) return deep;
                }
                return null;
            };
            return walk(node);
        },
        closest(sel) {
            const want = sel.replace(/[[\].]/g, '');
            let cur = node;
            while (cur) {
                if (Object.keys(cur.attrs).some((a) => a === want)
                    || cur.className === want) return cur;
                cur = cur.parent;
            }
            return null;
        },
    };
    return node;
}

/**
 * A renameable sidebar row, and the sandbox its modules run in.
 * Inputs: none. Output: object - {win, rowEl, nameEl, Rename, Actions}.
 */
function makeRow() {
    const win = { SessionLabel: { LABEL_MAX_CHARS: 200 }, addEventListener() {} };
    win.window = win;
    const doc = {
        createElement: (t) => el(t),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        activeElement: null,
    };
    const context = { window: win, document: doc, console: { log() {}, error() {} }, globalThis: win };
    vm.createContext(context);
    vm.runInContext(clientJs('session-sidebar-rename.js'), context);

    const rowEl = el('div');
    rowEl.className = 'session-sidebar-row';
    rowEl.setAttribute('data-rename-state', 'renameable');
    rowEl.dataset.name = 'cloude_api';
    rowEl.dataset.sessionId = 'ses_1';
    const nameEl = el('span');
    nameEl.setAttribute('data-row-name', '');
    nameEl.textContent = 'api';
    rowEl.appendChild(nameEl);
    doc.querySelector = (sel) => (sel.includes('cloude_api') ? rowEl : null);
    return { win, doc, rowEl, nameEl, Rename: win.SessionSidebarRename };
}

// =====================================================================
// The rename pair - one implementation, three doors
// =====================================================================

test('DOUBLE-CLICK RENAME STILL WORKS - the owner kept it, 2026-09-10', () => {
    // Adam's commit deleted this gesture outright. It ships.
    const { rowEl, nameEl, Rename } = makeRow();
    assert.equal(Rename.isEditing(), false);
    Rename.onDblClick({
        target: nameEl, preventDefault() {}, stopPropagation() {},
    });
    assert.ok(Rename.isEditing(), 'a double-click on the name must open the editor');
    assert.equal(rowEl.getAttribute('data-editing'), '1');
});

test('F2 REACHES THE SAME EDITOR - the keyboard door, unchanged', () => {
    const { rowEl, Rename } = makeRow();
    assert.equal(Rename.onRowKeydown({ key: 'F2', preventDefault() {} }, rowEl), true);
    assert.ok(Rename.isEditing());
});

test("THE MENU'S RENAME REACHES THAT SAME EDITOR, not a copy of it", () => {
    // The third door, and the one adam added. It is wired to
    // SessionSidebarRename.beginEdit - the SAME function the two gestures
    // above end in - so all three open one editor with one seed, one
    // validator and one commit path.
    const { win, doc, rowEl, Rename } = makeRow();
    const context = { window: win, document: doc, console: { log() {}, error() {} }, globalThis: win, CSS: { escape: (s) => s } };
    vm.createContext(context);
    vm.runInContext(clientJs('session-row-menu-actions.js'), context);

    assert.equal(Rename.isEditing(), false);
    win.SessionRowMenuActions.run('rename', {
        name: 'cloude_api', label: 'api', surface: 'sidebar', sessionId: 'ses_1',
    });
    assert.ok(Rename.isEditing(),
        "the menu's rename must open the row's own editor");
    assert.equal(rowEl.getAttribute('data-editing'), '1');
});

test('all three doors refuse a row that cannot be renamed, identically', () => {
    // ONE implementation means one refusal. If a door ever grew its own,
    // this is where it would show up.
    const seen = [];
    for (const drive of ['dbl', 'f2', 'menu']) {
        const { win, doc, rowEl, nameEl, Rename } = makeRow();
        rowEl.setAttribute('data-rename-state', 'adopting');
        if (drive === 'dbl') {
            Rename.onDblClick({ target: nameEl, preventDefault() {}, stopPropagation() {} });
        } else if (drive === 'f2') {
            Rename.onRowKeydown({ key: 'F2', preventDefault() {} }, rowEl);
        } else {
            const c = { window: win, document: doc, console: { log() {}, error() {} }, globalThis: win, CSS: { escape: (s) => s } };
            vm.createContext(c);
            vm.runInContext(clientJs('session-row-menu-actions.js'), c);
            win.SessionRowMenuActions.run('rename', {
                name: 'cloude_api', surface: 'sidebar', sessionId: 'ses_1',
            });
        }
        seen.push([Rename.isEditing(), rowEl.getAttribute('data-rename-refused')]);
    }
    for (const [editing, refused] of seen) {
        assert.ok(!editing, 'no door may open an editor on a refused row');
        assert.equal(refused, '1', 'and every door must record the refusal');
    }
});

// =====================================================================
// Where our three items go
// =====================================================================

/**
 * Load the action runners over a stubbed client.
 * Inputs: none. Output: object - {win, calls}.
 */
function dispatchSandbox() {
    const calls = [];
    const rowEl = el('div');
    rowEl.className = 'session-sidebar-row';
    const trigger = el('button');
    trigger.setAttribute('data-row-menu', 'cloude_api');
    rowEl.appendChild(trigger);
    const win = {
        addEventListener() {},
        SessionSidebar: { id: 'the-controller' },
        SessionSidebarClicks: {
            runRestart(ctrl, name, el2) { calls.push(['runRestart', ctrl, name, !!el2]); },
            onMarkUnreadClick(ctrl, toggle) {
                calls.push(['markUnread', ctrl, toggle.dataset.markUnread,
                    toggle.dataset.unreadCurrent]);
            },
        },
        SessionSidebarGroupActions: {
            openPickerFor(anchor, name) { calls.push(['openPickerFor', !!anchor, name]); },
        },
    };
    win.window = win;
    const doc = {
        createElement: (t) => el(t),
        querySelector: (sel) => (sel.includes('cloude_api') ? rowEl : null),
        addEventListener() {},
    };
    const context = { window: win, document: doc, console: { log() {}, error() {} }, globalThis: win, CSS: { escape: (s) => s } };
    vm.createContext(context);
    vm.runInContext(clientJs('session-row-menu-actions.js'), context);
    return { win, calls };
}

const ctx = () => ({ name: 'cloude_api', label: 'api', surface: 'sidebar', sessionId: 'ses_1' });

test('RESTART goes to the picker, through the row\'s own handler', () => {
    // Decision 3's control. It must reach SessionSidebarClicks.runRestart,
    // which opens the restart picker - the arm box, the confirm modal and
    // `confirm_restart_live` are the gates behind it. A second path to the
    // respawn ladder is exactly what this asserts does not exist.
    const { win, calls } = dispatchSandbox();
    win.SessionRowMenuActions.run('restart', ctx());
    assert.deepEqual(Array.from(calls[0]), ['runRestart', { id: 'the-controller' }, 'cloude_api', true]);
});

test('MARK UNREAD goes to the row\'s own handler, carrying the frozen flag', () => {
    // The handler flips whatever it is told the current value is, so the
    // menu must hand it the state the row SHOWED when the menu opened -
    // the captured snapshot, never a re-read of a list that has since
    // repainted.
    const { win, calls } = dispatchSandbox();
    win.SessionRowMenuActions.run('mark-unread', { ...ctx(), unread: true });
    assert.deepEqual(Array.from(calls[0]), ['markUnread', { id: 'the-controller' }, 'cloude_api', 'true']);
    const second = dispatchSandbox();
    second.win.SessionRowMenuActions.run('mark-unread', { ...ctx(), unread: false });
    assert.equal(second.calls[0][3], 'false');
});

test('MOVE TO GROUP opens the group module\'s own picker', () => {
    const { win, calls } = dispatchSandbox();
    win.SessionRowMenuActions.run('move-to-group', ctx());
    assert.deepEqual(Array.from(calls[0]), ['openPickerFor', true, 'cloude_api']);
});

test('a runner whose collaborator is missing does nothing, and does not throw', () => {
    // Load order and a half-built page are real: the menu must degrade to
    // an item that does nothing rather than to an exception that leaves
    // the panel open and the row wedged.
    const { win } = dispatchSandbox();
    delete win.SessionSidebarClicks;
    delete win.SessionSidebarGroupActions;
    win.SessionRowMenuActions.run('restart', ctx());
    win.SessionRowMenuActions.run('mark-unread', ctx());
    win.SessionRowMenuActions.run('move-to-group', ctx());
});

// =====================================================================
// THE WRITER AND THE READER MUST AGREE ON THE ATTRIBUTE NAME
// =====================================================================

/**
 * Turn one rendered `<button ...>` tag into something with getAttribute.
 *
 * Description: THE MARKUP IS THE REAL OUTPUT of
 *   SessionRowMenu.triggerHtml, parsed rather than hand-written, because
 *   a hand-written attribute map would be a THIRD spelling of the same
 *   fact and could agree with the reader while the writer disagreed with
 *   both. Attributes are read out of the tag exactly as rendered.
 * Inputs: tag (string) - one rendered button tag.
 * Output: object - an element exposing getAttribute.
 */
function elementFromTag(tag) {
    const attrs = Object.create(null);
    for (const m of tag.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    return {
        attrs,
        getAttribute: (n) => (n in attrs ? attrs[n] : null),
        querySelector: () => null,
    };
}

test('RESTART READS THE STATUS THE TRIGGER ACTUALLY STAMPED', () => {
    // THE REGRESSION THIS EXISTS FOR. `runRestart` resolves a row's
    // status by reading an attribute off the menu trigger. The writer
    // (SessionRowMenu.triggerHtml) spells it `data-row-menu-status`; it
    // was `data-row-status` on our own kebab before the 2026-09-10
    // reconcile. If the reader is left on the old spelling the lookup
    // returns null, the picker is handed "unknown" for every session, and
    // NOTHING FAILS - the restart still opens, still looks right, and
    // simply predicts the wrong thing.
    //
    // Neither half alone can catch that. A writer-side assertion that the
    // trigger carries the attribute passes while the reader looks
    // elsewhere; a reader-side test with a MOCKED runRestart never
    // performs the read at all. So this drives the REAL runRestart
    // against the REAL rendered trigger and asserts the status arrives at
    // the picker - the one observation that fails if the two spellings
    // ever drift apart again.
    const win = { addEventListener() {}, SessionLabel: { LABEL_MAX_CHARS: 200 } };
    win.window = win;
    const makeDiv = () => {
        let text = '';
        return {
            set textContent(v) { text = v == null ? '' : String(v); },
            get textContent() { return text; },
            get innerHTML() {
                return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            },
        };
    };
    const doc = {
        createElement: makeDiv,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
    };
    const context = {
        window: win, document: doc, globalThis: win,
        console: { log() {}, error() {} },
        CSS: { escape: (v) => v },
        alert() { throw new Error('runRestart must not fail closed here'); },
    };
    vm.createContext(context);
    vm.runInContext(clientJs('session-status-ui.js'), context);
    vm.runInContext(clientJs('session-row-actions-confirm.js'), context);
    vm.runInContext(clientJs('session-row-actions.js'), context);
    vm.runInContext(clientJs('session-row-menu-items.js'), context);
    vm.runInContext(clientJs('session-row-menu.js'), context);
    vm.runInContext(clientJs('session-sidebar-clicks.js'), context);

    // THE WRITER, for real.
    const menu = win.SessionRowMenu;
    const html = menu.triggerHtml(menu.contextFromRow(
        { name: 'cloude_api', label: 'api', status: 'working', created_by_cloude: true },
        { surface: 'sidebar', renameable: true },
    ));
    const tag = (html.match(/<button[\s\S]*?>/) || [])[0];
    const trigger = elementFromTag(tag);
    doc.querySelector = (sel) => (sel.includes('cloude_api') ? trigger : null);

    // THE READER, for real. The picker records what it was handed.
    const seen = [];
    win.SessionRestartPicker = {
        open(name, label, status) { seen.push(status); return Promise.resolve(null); },
        lastError() { return null; },
    };

    return win.SessionSidebarClicks.runRestart(win.SessionSidebar, 'cloude_api', null)
        .then(() => {
            assert.equal(seen.length, 1, 'the picker must have been opened');
            assert.equal(
                seen[0], 'working',
                'the reader and the writer disagree about the status attribute: '
                + 'runRestart read ' + JSON.stringify(seen[0]) + ' from a trigger '
                + 'that stamps data-row-menu-status="working"',
            );
        });
});

test('and it reports the MEASURED status, never a default, for each one', () => {
    // The failure mode is uniform: a wrong spelling reads null for EVERY
    // status, so one fixture could pass by luck if the picker defaulted.
    // Driving several proves the value travels rather than a constant.
    for (const status of ['working', 'idle', 'question', 'notice']) {
        const win = { addEventListener() {}, SessionLabel: { LABEL_MAX_CHARS: 200 } };
        win.window = win;
        const makeDiv = () => {
            let text = '';
            return {
                set textContent(v) { text = v == null ? '' : String(v); },
                get textContent() { return text; },
                get innerHTML() { return text; },
            };
        };
        const doc = {
            createElement: makeDiv, getElementById: () => null,
            querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        };
        const context = {
            window: win, document: doc, globalThis: win,
            console: { log() {}, error() {} },
            CSS: { escape: (v) => v }, alert() {},
        };
        vm.createContext(context);
        vm.runInContext(clientJs('session-status-ui.js'), context);
        vm.runInContext(clientJs('session-row-actions-confirm.js'), context);
        vm.runInContext(clientJs('session-row-actions.js'), context);
        vm.runInContext(clientJs('session-row-menu-items.js'), context);
        vm.runInContext(clientJs('session-row-menu.js'), context);
        vm.runInContext(clientJs('session-sidebar-clicks.js'), context);
        const menu = win.SessionRowMenu;
        const html = menu.triggerHtml(menu.contextFromRow(
            { name: 'cloude_api', status, created_by_cloude: true },
            { surface: 'sidebar', renameable: true },
        ));
        const trigger = elementFromTag((html.match(/<button[\s\S]*?>/) || [])[0]);
        doc.querySelector = () => trigger;
        const seen = [];
        win.SessionRestartPicker = {
            open(n, l, st) { seen.push(st); return Promise.resolve(null); },
            lastError() { return null; },
        };
        win.SessionSidebarClicks.runRestart(win.SessionSidebar, 'cloude_api', null);
        assert.equal(seen[0], status, `status ${status} must reach the picker`);
    }
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
