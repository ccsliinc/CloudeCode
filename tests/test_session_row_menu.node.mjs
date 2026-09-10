// Node tests for the SESSION ROW ACTION MENU's DEFINITION -
// client/js/session-row-menu.js (the item table and the markup),
// client/js/session-row-menu-actions.js (what each item reaches) and the
// contract client/js/session-row-menu-open.js declares in source.
//
// SCOPE, STATED HONESTLY. tests/mini-dom.mjs does not parse innerHTML and
// has no capture phase, and BOTH are load bearing for this menu: the
// panel is built by assigning a markup string to innerHTML, and the
// trigger's click is claimed on a document CAPTURE listener so it beats
// each surface's own bubble-phase row router. Neither can be exercised in
// that stub, so NEITHER IS ASSERTED HERE. Focus order, the key guards
// actually firing, the viewport clamp and the screenshots are answered in
// a real browser by tests/test_session_row_menu_renders.py; a stub that
// pretended to cover them would report a pass over nothing.
//
// What IS provable without a browser is everything about the DEFINITION:
// which five items exist and in what order, that each letter is unique
// and is the letter its own item renders, that a disabled item still
// paints, still takes focus and carries its reason as TEXT, that the
// mute label is a function of one normalized state, and that a row's
// identity is captured into the trigger and read back out unchanged.
// Plus the CSS contract for the shortcut column, the separator and the
// height cap, which are single declarations that are expensive to lose.
//
// Run with: node tests/test_session_row_menu.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read one client file's source. Inputs: dir, name. Output: string. */
function clientFile(dir, name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', dir, name), 'utf8');
}

let failures = 0;
let passes = 0;

/** Run one named assertion block. Inputs: name, fn. Output: void. */
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
 * Description: load the definition module into a sandbox with a document
 *   stub good enough for its HTML escaping (it builds a detached div and
 *   reads innerHTML back).
 * Inputs: none.
 * Output: object - {Menu, win}.
 */
function makeSandbox() {
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
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        readyState: 'complete',
    };
    const fakeWindow = { addEventListener() {} };
    fakeWindow.window = fakeWindow;
    const context = {
        window: fakeWindow,
        document: fakeDocument,
        console: { log() {}, warn() {}, error() {} },
        CSS: { escape: (s) => s },
        Promise,
        setTimeout,
        CustomEvent: function () {},
        encodeURIComponent,
    };
    vm.createContext(context);
    vm.runInContext(clientFile('js', 'session-row-menu.js'), context);
    vm.runInContext(clientFile('js', 'session-row-menu-actions.js'), context);
    return { Menu: fakeWindow.SessionRowMenu, Actions: fakeWindow.SessionRowMenuActions };
}

const { Menu, Actions } = makeSandbox();

/** A live, owned, renameable row on the sidebar. Inputs: over. Output: object. */
function row(over = {}) {
    return Object.assign({
        name: 'cloude_api',
        label: 'API work',
        status: 'working',
        created_by_cloude: true,
        session_id: 'ses_1234',
        notifications_muted: false,
    }, over);
}

/** The captured context for that row. Inputs: over, opts. Output: object. */
function ctx(over = {}, opts = {}) {
    return Menu.contextFromRow(row(over), Object.assign(
        { surface: 'sidebar', renameable: true, renameReason: '' }, opts));
}

/** Every `<button role="menuitem">` tag in a panel string. Inputs: html. */
function itemTags(html) {
    return html.match(/<button[^>]*role="menuitem"[^>]*>/g) || [];
}

// =====================================================================
// THE FIVE ITEMS, THEIR ORDER, AND THEIR LETTERS.
// =====================================================================

test('the menu holds exactly the five items, in the order the plan states', () => {
    const ids = Array.from(Menu.itemsFor(ctx()).map((i) => i.id));
    assert.deepEqual(ids, ['rename', 'fork', 'new-in-folder', 'mute', 'close']);
});

test('each item carries its own shortcut letter, and all five are distinct', () => {
    const keys = Array.from(Menu.itemsFor(ctx()).map((i) => i.shortcut));
    assert.deepEqual(keys, ['R', 'F', 'N', 'M', 'C']);
    assert.ok(Menu.uniqueShortcuts(),
        'two items sharing a letter renders two identical hints and only the '
        + 'first would ever run');
});

test('the letter a key runs is the letter that item RENDERS', () => {
    // The failure this rules out is silent: a table that bound M to close
    // while painting C beside it would look perfect and destroy a session.
    for (const item of Menu.itemsFor(ctx())) {
        assert.equal(Menu.itemIdForKey(item.shortcut), item.id);
        assert.equal(Menu.itemIdForKey(item.shortcut.toLowerCase()), item.id,
            'a lowercase press means the same item');
    }
});

test('a key that is not one of the five runs nothing', () => {
    for (const k of ['X', 'q', '1', 'Enter', 'ArrowDown', '', null, undefined]) {
        assert.equal(Menu.itemIdForKey(k), null, `${k} must match no item`);
    }
});

test('close is the only item behind a separator, and it is last', () => {
    const items = Menu.itemsFor(ctx());
    const withSep = Array.from(items.filter((i) => i.separatorBefore).map((i) => i.id));
    assert.deepEqual(withSep, ['close']);
    assert.equal(items[items.length - 1].id, 'close',
        'the destructive item sits apart, at the end');
    const html = Menu.panelHtml(ctx());
    assert.equal((html.match(/role="separator"/g) || []).length, 1);
    assert.ok(html.indexOf('role="separator"') < html.indexOf('data-row-menu-item="close"'),
        'the separator must come BEFORE close, not after it');
});

// =====================================================================
// THE MUTE LABEL.
// =====================================================================

test('the mute item names what the press will DO, from the row state', () => {
    const off = Menu.itemsFor(ctx({ notifications_muted: false }));
    const on = Menu.itemsFor(ctx({ name: 'other', notifications_muted: true }));
    assert.equal(off[3].label, 'mute notifications');
    assert.equal(on[3].label, 'unmute notifications');
});

test('an ABSENT notifications_muted reads as not muted - the old-server case', () => {
    // A server that does not carry the field is not a server reporting a
    // muted session. False is also the safe direction: alerts keep
    // arriving rather than being silently suppressed.
    for (const value of [undefined, null]) {
        assert.equal(Menu.mutedFor('no-field-row', value), false);
        const items = Menu.itemsFor(ctx({ name: 'no-field-row', notifications_muted: value }));
        assert.equal(items[3].label, 'mute notifications');
    }
    // And nothing but a literal true counts. A truthy string from a
    // hand-written payload must not read as a measured mute.
    assert.equal(Menu.mutedFor('no-field-row', 'yes'), false);
    assert.equal(Menu.mutedFor('no-field-row', 1), false);
});

test('an optimistic toggle survives the next repaint, and a rollback undoes it', () => {
    const name = 'opt-row';
    assert.equal(Menu.mutedFor(name, false), false);
    Menu.setMuteOverride(name, true);
    assert.equal(Menu.mutedFor(name, false), true,
        'the label must not flip back while the write is in flight');
    Menu.setMuteOverride(name, false);
    assert.equal(Menu.mutedFor(name, false), false, 'a rollback restores it');
    Menu.setMuteOverride(name, null);
    assert.equal(Menu.mutedFor(name, true), true,
        'forgetting the override hands the question back to the payload');
});

// =====================================================================
// UNAVAILABLE ITEMS.
// =====================================================================

test('a row with no live backend cannot rename, and the menu says why', () => {
    const items = Menu.itemsFor(ctx({}, {
        renameable: false,
        renameReason: 'cannot rename until this session is open - click the row to open it',
    }));
    assert.equal(items[0].id, 'rename');
    assert.equal(items[0].enabled, false);
    assert.ok(items[0].reason.length > 10, 'a refusal must be a sentence, not a code');
    assert.ok(items[0].reason.includes('click the row to open it'),
        "the surface's own reason is used verbatim, never re-derived");
});

test('a session cloudecode did not create cannot be forked, and says why', () => {
    const items = Menu.itemsFor(ctx({ created_by_cloude: false }));
    assert.equal(items[1].id, 'fork');
    assert.equal(items[1].enabled, false);
    assert.ok(/no recorded conversation/.test(items[1].reason));
    // And an owned one can.
    assert.equal(Menu.itemsFor(ctx()) [1].enabled, true);
});

test('an unavailable item is still RENDERED, still FOCUSABLE, and never natively disabled', () => {
    // A natively disabled button is skipped by focus entirely, so the
    // explanation would be unreachable by exactly the users who need it.
    const html = Menu.panelHtml(ctx({ created_by_cloude: false }, { renameable: false }));
    assert.equal(itemTags(html).length, 5, 'all five paint whatever their state');
    assert.ok(!/<button[^>]*\sdisabled/.test(html),
        'the `disabled` attribute would make the reason unreachable by keyboard');
    const forkTag = itemTags(html).find((t) => t.includes('data-row-menu-item="fork"'));
    assert.ok(forkTag.includes('aria-disabled="true"'));
    assert.ok(forkTag.includes('tabindex="0"'), 'it must stay in the roving order');
    assert.ok(forkTag.includes('aria-describedby='),
        'the reason must be ANNOUNCED, not left in a tooltip a keyboard never opens');
});

test('the reason is TEXT in the item, and every disabled item has a distinct one', () => {
    const html = Menu.panelHtml(ctx({ created_by_cloude: false }, { renameable: false }));
    const ids = html.match(/id="session-row-menu-panel-reason-\d+"/g) || [];
    assert.equal(ids.length, 2, 'rename and fork are both refused here');
    assert.equal(new Set(ids).size, 2, 'two items must not share one description id');
    assert.ok(html.includes('session-row-menu__reason'),
        'the reason renders as text, not only as a title attribute');
});

test('an ENABLED item carries no reason, no aria-disabled and no description', () => {
    const html = Menu.panelHtml(ctx());
    assert.ok(!html.includes('aria-disabled'));
    assert.ok(!html.includes('aria-describedby'));
    assert.ok(!html.includes('session-row-menu__reason'));
});

// =====================================================================
// CAPTURED IDENTITY.
// =====================================================================

test('the trigger carries the whole row identity, and it reads back unchanged', () => {
    const before = ctx();
    const after = Menu.contextFromTrigger(fakeTrigger(Menu.triggerHtml(before)));
    assert.deepEqual(after, before,
        'every field an item can need must survive the round trip through markup');
});

test('identity is captured at PAINT time, so a repaint cannot redirect an action', () => {
    // Two rows painted, then the FIRST trigger read back. It must still
    // describe the first row - the whole reason the menu reads a frozen
    // snapshot instead of querying the DOM when an item is chosen.
    const a = Menu.triggerHtml(ctx({ name: 'row-a', label: 'Alpha', session_id: 'ses_a' }));
    Menu.triggerHtml(ctx({ name: 'row-b', label: 'Beta', session_id: 'ses_b' }));
    const back = Menu.contextFromTrigger(fakeTrigger(a));
    assert.equal(back.name, 'row-a');
    assert.equal(back.label, 'Alpha');
    assert.equal(back.sessionId, 'ses_a');
});

test('a hostile session name cannot break out of an attribute', () => {
    const nasty = 'a" onmouseover="alert(1)" x="';
    const html = Menu.triggerHtml(ctx({ name: nasty, label: nasty }));
    // The literal text `onmouseover=` is still IN the markup - it is
    // part of the name - and that is fine. What must not survive is the
    // unescaped quote that would end the attribute and start a new one.
    assert.ok(!html.includes('a" onmouseover'),
        'the quote must be escaped, or the name becomes an event handler');
    assert.ok(html.includes('a&quot; onmouseover'),
        'and it must be escaped by the shared escaper, not stripped');
    assert.equal(Menu.contextFromTrigger(fakeTrigger(html)).name, nasty,
        'and it must still read back as the literal name it was');
});

test('a row with no session id captures null, not the string "null"', () => {
    const back = Menu.contextFromTrigger(
        fakeTrigger(Menu.triggerHtml(ctx({ session_id: null }))));
    assert.equal(back.sessionId, null);
});

test('the trigger is a real button carrying the menu-button aria contract', () => {
    const html = Menu.triggerHtml(ctx());
    assert.ok(html.startsWith('<button type="button"'),
        'not a role="button" span: Enter and Space must work without a key handler');
    for (const attr of ['aria-haspopup="menu"', 'aria-expanded="false"',
        'aria-controls="session-row-menu-panel"', 'aria-label=', 'title=']) {
        assert.ok(html.includes(attr), `the trigger must carry ${attr}`);
    }
    assert.ok(html.includes('aria-label="session actions for API work"'),
        'the accessible name must use the LABEL a human reads, not the tmux handle');
});

/**
 * Description: a stand-in for a rendered trigger, built by parsing the
 *   attributes back out of REAL triggerHtml output. Parsing rather than
 *   hand-writing them is what makes these assertions cover the round
 *   trip rather than a fixture.
 * Inputs: html (string). Output: object - {getAttribute}.
 */
function fakeTrigger(html) {
    const attrs = {};
    const re = /([a-z-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        attrs[m[1]] = m[2]
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }
    return { getAttribute: (n) => (n in attrs ? attrs[n] : null) };
}

// =====================================================================
// WHAT EACH ITEM REACHES.
// =====================================================================

test('every item id in the table is one the action runner knows', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    for (const item of Menu.ITEMS) {
        assert.ok(src.includes(`itemId === '${item.id}'`),
            `no runner for "${item.id}" - the item would paint and do nothing`);
    }
});

test('mute writes to the endpoint the contract names, and to nothing else', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    assert.ok(src.includes("'/sessions/records/'"), 'keyed on the durable record');
    assert.ok(src.includes("'/notifications'"));
    assert.ok(src.includes("method: 'PATCH', body: { muted: want }"),
        'the body is {muted: boolean}, exactly as specified');
    assert.ok(src.includes('encodeURIComponent(record.session_uuid)'),
        'the uuid is the key, and it is encoded');
});

test('a failed mute write rolls the label back and says nothing was changed', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    const body = src.slice(src.indexOf('async function runToggleMute'));
    assert.ok(body.indexOf('setMuteOverride(ctx.name, want)')
        < body.indexOf('await recordFor'),
        'the label must flip BEFORE the request - the menu answers immediately');
    assert.ok((body.match(/setMuteOverride\(ctx\.name, was\)/g) || []).length === 2,
        'both failure paths - no record, and a refused write - must roll back');
    assert.ok(body.includes('res.muted'),
        "the server's own answer must win over what was asked for");
});

test('fork and new-in-folder open their child only while the navigation is current', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    assert.ok(src.includes('var token = navToken();'),
        'the token must be read BEFORE the create');
    assert.ok(src.includes('if (navToken() !== token)'),
        'and compared after it');
    assert.ok(/session-created', 'popstate', 'hashchange'/.test(src)
        || src.includes("'session-created', 'popstate', 'hashchange'"),
        'every navigation the app announces must bump the token');
    const open = src.slice(src.indexOf('function openChild'));
    assert.ok(open.indexOf('if (navToken() !== token)') < open.indexOf('session-created'),
        'a stale token must return BEFORE anything is dispatched');
});

test('close reaches each surface\'s EXISTING confirm and teardown, not a new one', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    assert.ok(src.includes('_handleSessionRowAction'), 'the launchpad path');
    assert.ok(src.includes('clicks.onRowActionClick'), 'the sidebar path');
    assert.ok(!src.includes('showConfirmModal'),
        'the menu must not open a second, unreviewed confirmation');
    assert.ok(!src.includes('destroySession') && !src.includes('destroyExternalSession'),
        'and must not invent a third destruction path');
});

test('a rename is handed the ELEMENT, never the name', () => {
    // Both editors seed themselves off the row's own name node. Handing
    // them a name is what once made a plain Enter overwrite a label with
    // the tmux handle.
    const src = clientFile('js', 'session-row-menu-actions.js');
    const body = src.slice(src.indexOf('async function runRename'),
        src.indexOf('async function runFork'));
    assert.ok(body.includes('beginEdit(rowEl)'));
    assert.ok(body.includes('_handleRenameRunningSession(rowEl, ctx.sessionId)'));
});

test('the record lookup takes the NEWEST live row for a reused tmux name', () => {
    const src = clientFile('js', 'session-row-menu-actions.js');
    const body = src.slice(src.indexOf('async function recordFor'));
    assert.ok(body.includes('if (r.archived_at) continue;'),
        'a deleted row must never answer for a live session');
    assert.ok(body.includes('tmux_created_epoch'),
        'a reused name needs the epoch to tell its rows apart');
});

// =====================================================================
// WHAT THE OPEN MODULE DECLARES. Source-level: the behaviour itself is
// measured in tests/test_session_row_menu_renders.py.
// =====================================================================

test('the key handler refuses every kind of press that is not a menu shortcut', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function onKey('), src.indexOf('function onDocumentClickCapture'));
    assert.ok(body.includes('ev.ctrlKey || ev.metaKey || ev.altKey'),
        'a modified key belongs to the OS and the browser, not to this menu');
    assert.ok(body.includes('if (ev.repeat) return;'),
        'a held key must run an action once, not once per autorepeat tick');
    assert.ok(body.includes('ev.isComposing === true || ev.keyCode === 229'),
        'mid-composition keystrokes are not letters yet, on either engine');
    assert.ok(body.includes('isEditable(ev.target)'),
        'a letter typed into the rename editor this menu opens must reach it');
});

test('a handled key is CONSUMED, so it can never also reach the terminal', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function onKey('), src.indexOf('function onDocumentClickCapture'));
    // Every branch that acts must both preventDefault and stopPropagation.
    for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
        const at = body.indexOf(`'${key}'`);
        assert.ok(at !== -1, `no branch for ${key}`);
        const after = body.slice(at, at + 220);
        assert.ok(after.includes('preventDefault'), `${key} must preventDefault`);
        assert.ok(after.includes('stopPropagation'), `${key} must stopPropagation`);
    }
    assert.ok(body.includes('document.addEventListener') === false,
        'the listener is bound in open(), so close() is guaranteed to remove it');
    assert.ok(src.includes("document.addEventListener('keydown', onDocKey, true)"),
        'and it must be bound in the CAPTURE phase to beat the terminal');
});

test('letters are bound only while the menu is open', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    assert.ok(src.includes("document.addEventListener('keydown', onDocKey, true)"));
    assert.ok(src.includes("document.removeEventListener('keydown', onDocKey, true)"),
        'and removed on close, or R would open a rename from anywhere in the app');
});

test('Escape restores trigger focus; Tab and an outside click do NOT', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function onKey('), src.indexOf('function onDocumentClickCapture'));
    const esc = body.slice(body.indexOf("=== 'Escape'"), body.indexOf("=== 'Tab'"));
    assert.ok(esc.includes('close({ restoreFocus: true })'));
    const tab = body.slice(body.indexOf("=== 'Tab'"), body.indexOf('var inside'));
    assert.ok(tab.includes('close({ restoreFocus: false })'),
        'Tab must land where the user tabbed to, not back on the trigger');
    assert.ok(!tab.includes('preventDefault'), 'Tab belongs to the browser');
    const ptr = src.slice(src.indexOf('onDocPointer = function'), src.indexOf('setTimeout(function'));
    assert.ok(ptr.includes('close({ restoreFocus: false })'),
        'an outside click must leave focus on what was clicked');
});

test('focus lands on the first item when the menu opens', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const open = src.slice(src.indexOf('function open(trigger)'), src.indexOf('function onKey('));
    assert.ok(open.includes('moveFocus(0)'));
});

test('a disabled item cannot be activated, and the menu stays open when refused', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function activate('), src.indexOf('function announce('));
    const guard = body.indexOf("aria-disabled') === 'true'");
    assert.ok(guard !== -1, 'the refusal must be keyed on the rendered aria state');
    assert.ok(guard < body.indexOf('close({ restoreFocus: true })'),
        'it must return BEFORE the close, or the explanation vanishes with the panel');
    assert.ok(body.includes('announce('),
        'a control that can be focused but not activated must SAY so');
});

test('a disabled item is still reachable by the roving focus', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function items()'), src.indexOf('function moveFocus'));
    assert.ok(body.includes('[role="menuitem"]'),
        'every item is collected, not only the enabled ones');
    assert.ok(!body.includes('aria-disabled'),
        'filtering disabled items out here would hide their explanations');
});

test('the panel is capped to the VISUAL viewport before it is placed', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    const body = src.slice(src.indexOf('function clampHeight'), src.indexOf('function open(trigger)'));
    assert.ok(body.includes('window.visualViewport'),
        'a phone with a collapsing URL bar has a visual viewport smaller than the layout one');
    assert.ok(body.includes('maxHeight'));
    const open = src.slice(src.indexOf('function open(trigger)'));
    assert.ok(open.indexOf('clampHeight(panel)') < open.indexOf('AnchorPopover.place'),
        'the placement rule clamps a box POSITION and cannot rescue a box that does not fit');
});

test('the trigger click is claimed in the capture phase, for both surfaces at once', () => {
    const src = clientFile('js', 'session-row-menu-open.js');
    assert.ok(src.includes("document.addEventListener('click', onDocumentClickCapture, true)"),
        'a bubble-phase listener would let the row router also switch conversation');
    const body = src.slice(src.indexOf('function onDocumentClickCapture'));
    assert.ok(body.includes('e.stopPropagation()'));
    assert.ok(body.includes('e.preventDefault()'));
});

// =====================================================================
// THE ROWS THAT DRAW IT.
// =====================================================================

test('one predicate decides menu-or-X, so a row can never draw both or neither', () => {
    const actionsSrc = clientFile('js', 'session-row-actions.js');
    assert.ok(actionsSrc.includes('function offersMenu(status)'));
    assert.ok(actionsSrc.includes("actionsFor(status).indexOf(ACTION_CLOSE) !== -1"),
        'derived from actionsFor, never from a second status list');
    for (const src of ['session-sidebar-rows.js', 'launchpad.js']) {
        const js = clientFile('js', src);
        assert.ok(js.includes('SessionRowActions.offersMenu('),
            `${src} must ask the shared predicate`);
        assert.ok(js.includes('!offersMenu)'),
            `${src} must draw the inline action only when the menu is NOT offered`);
    }
});

// =====================================================================
// THE CSS CONTRACT. Single declarations, expensive to lose silently.
// =====================================================================

test('the shortcut letter is right-aligned in the muted text colour', () => {
    const css = clientFile('css', 'session-row-menu.css');
    const block = css.slice(css.indexOf('.session-row-menu__key {'));
    const decl = block.slice(0, block.indexOf('}'));
    assert.ok(decl.includes('justify-self: end'), 'right-aligned, in its own column');
    assert.ok(decl.includes('color: var(--color-fg-faint)'),
        'muted: it is a hint about the keyboard, not part of the label');
    assert.ok(css.includes('grid-template-columns: 1fr auto'),
        'the letters must line up whatever the label length');
});

test('the panel scrolls itself rather than running off a short viewport', () => {
    const css = clientFile('css', 'session-row-menu.css');
    assert.ok(css.includes('overflow-y: auto'));
    assert.ok(css.includes('max-height: calc(100vh - 16px)'), 'the fallback unit first');
    assert.ok(css.includes('max-height: calc(100dvh - 16px)'),
        "and dvh after it, so a mobile browser's collapsing URL bar cannot size it wrong");
    assert.ok(css.includes('max-width: calc(100vw - 16px)'),
        'a panel wider than the screen has no position satisfying both edges');
});

test('the panel is fixed and the trigger wears no circle', () => {
    const css = clientFile('css', 'session-row-menu.css');
    const panel = css.slice(css.indexOf('.session-row-menu {'));
    assert.ok(panel.slice(0, panel.indexOf('}')).includes('position: fixed'),
        'a transformed sidebar ancestor would otherwise be its containing block');
    const trigger = css.slice(css.indexOf('.session-row-menu-trigger {'));
    const decl = trigger.slice(0, trigger.indexOf('}'));
    assert.ok(decl.includes('border: none') && decl.includes('border-radius: 0'),
        '"no circles around icons on left menu" - the standing rule for this list');
});

test('the trigger gets a thumb-sized target without growing the row', () => {
    const css = clientFile('css', 'session-row-menu.css');
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {'));
    assert.ok(coarse.includes('min-width: 36px'), 'width on the real box');
    assert.ok(coarse.includes('height: 44px'), 'height only on the overlay');
    assert.ok(css.includes('.session-row-menu-trigger::after'),
        'the overlay is what gives a thumb its target');
    assert.ok(!/\[data-density="compact"\][^{]*::after/.test(coarse),
        'a 24px compact row must not get a 44px overlay that steals its neighbours taps');
});

test('every colour in the menu is a token, so it follows whichever theme is on', () => {
    const css = clientFile('css', 'session-row-menu.css');
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = Array.from(body.match(/(?:color|background)\s*:\s*(#[0-9a-fA-F]{3,8}|rgb)/g) || []);
    assert.deepEqual(literals, [],
        'a hardcoded colour is the one element on screen that would not follow the theme');
});

// =====================================================================
// DOUBLE-CLICK RENAME IS GONE, AND F2 IS NOT.
// =====================================================================

test('nothing in the sidebar listens for dblclick any more', () => {
    for (const f of ['session-sidebar.js', 'session-sidebar-clicks.js',
        'session-sidebar-rename.js', 'session-sidebar-rows.js']) {
        const js = clientFile('js', f);
        assert.ok(!/addEventListener\(\s*'dblclick'/.test(js), `${f} still binds dblclick`);
        assert.ok(!js.includes('onDblClick('), `${f} still calls onDblClick`);
        assert.ok(!js.includes('deferActivation'),
            `${f} still defers a click for a gesture that no longer exists`);
    }
});

test('a click on a row name activates it immediately, with nothing held back', () => {
    const js = clientFile('js', 'session-sidebar-clicks.js');
    assert.ok(!js.includes('setTimeout'),
        'the 250 ms hold was the whole cost of double-click rename');
    const rename = clientFile('js', 'session-sidebar-rename.js');
    assert.ok(!rename.includes('DBLCLICK_MS'), 'the constant must go with the gesture');
});

test('F2 and the row title still rename', () => {
    const rename = clientFile('js', 'session-sidebar-rename.js');
    assert.ok(rename.includes("if (e.key !== 'F2') return false;"),
        'F2 on a focused row is the keyboard way in and must survive');
    assert.ok(rename.includes('function beginEdit(rowEl)'),
        'and both ways in still go through the one gate');
    const rows = clientFile('js', 'session-sidebar-rows.js');
    assert.ok(rows.includes("'press F2 to rename'"),
        'the row must stop telling the user to double-click something that does nothing');
    assert.ok(!rows.includes('double-click'));
    const lp = clientFile('js', 'launchpad.js');
    assert.ok(lp.includes('running-session-rename'),
        "the home card's title rename control is untouched");
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
console.log('ALL PASS');
