// THE DOUBLE-CLICK RENAME GESTURE, DRIVEN FOR REAL.
// ---------------------------------------------------------------------
// docs/kept-behaviours/ccsliinc.md lists double-click rename as a KEPT
// behaviour - the owner's own words, "dont remove the rename. i said
// merge not take everything" - and honestly records `tests: none`,
// because every existing rename test calls into the editor directly:
// test_sidebar_rename_edits_label.node.mjs calls
// `SessionSidebarRename.beginEdit(rowEl)` straight, and even
// test_session_row_menu_dispatch.node.mjs's own double-click case calls
// `Rename.onDblClick(...)` straight. Both prove the EDITOR works and
// prove nothing about the GESTURE that is supposed to reach it - which
// is exactly the half `8898f07` deleted while the words "double-click"
// and "dblclick" survived in its prose.
//
// This file closes that gap by driving the REAL registered listener:
// `SessionSidebar.init()` wires `this.listEl.addEventListener('dblclick',
// ...)` in client/js/session-sidebar.js, and the tests below dispatch a
// genuine bubbling `dblclick` through that listener rather than calling
// any handler function by name. lib-sidebar-sessions.mjs's `El` class is
// what makes that possible here - unlike the hand-rolled stub in
// test_session_row_menu_dispatch.node.mjs, its addEventListener/
// dispatchEvent pair actually fires and bubbles, the way a browser does.
//
// It also extends that file's three-doors-one-implementation guarantee
// to the POSITIVE path: the existing dispatch test proves all three
// doors refuse an unrenameable row identically, using onDblClick called
// directly for the double-click door. Here the double-click door is
// driven through the real listener instead, so a future change that
// removes the `addEventListener('dblclick', ...)` registration - or
// repoints it at a different function than F2 and the menu item use -
// fails a named test in this file, not just a prose comment.
//
// Run with: node tests/test_session_sidebar_rename_gesture.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { Doc, loadModules, results, test } from './lib-sidebar-sessions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Description: read one client JS module's source, for a module loaded
 *   into an ALREADY-CONTEXTIFIED window rather than through loadModules
 *   (which only accepts a list evaluated up front).
 * Inputs: name (string) - a file under client/js/.
 * Output: string.
 */
function clientJs(name) {
    return fs.readFileSync(path.join(ROOT, 'client', 'js', name), 'utf8');
}

/**
 * Build the real sidebar panel markup `SessionSidebar.init()` requires -
 * the five ids it reads with `document.getElementById` - plus a
 * document.querySelector able to resolve the compound selector
 * `session-row-menu-actions.js` uses to find a row by its `data-name`
 * (`.session-sidebar-row[data-name="..."]`). `El.matches` only
 * understands one simple selector clause at a time, which is why the
 * existing dispatch test stubs this same lookup rather than relying on
 * the class - this does the same thing, generically, by attribute rather
 * than by a single hardcoded name.
 * Inputs: none. Output: object - {document, listEl}.
 */
function buildPanel() {
    const document = new Doc();
    const mk = (tag, id) => {
        const e = document.createElement(tag);
        if (id) e.id = id;
        return e;
    };
    const toggle = mk('button', 'session-sidebar-toggle');
    const panel = mk('div', 'session-sidebar-panel');
    const backdrop = mk('div', 'session-sidebar-backdrop');
    const closeBtn = mk('button', 'session-sidebar-close');
    const listEl = mk('div', 'session-sidebar-list');
    document.body.appendChild(toggle);
    document.body.appendChild(backdrop);
    document.body.appendChild(closeBtn);
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    document.querySelector = (sel) => {
        const m = sel.match(/data-name="([^"]+)"/);
        if (!m) return null;
        return document._walk([]).find(
            (e) => e.classList && e.classList.contains('session-sidebar-row')
                && e.getAttribute('data-name') === m[1],
        ) || null;
    };
    return { document, listEl };
}

/**
 * One sidebar row, mounted into `listEl` the way a real repaint would
 * leave it - a `.session-sidebar-row` carrying the identity attributes
 * `beginEdit` reads, holding a `[data-row-name]` span with the rendered
 * text as its seed.
 * Inputs: listEl (El); opts ({name, sessionId, seed, renameable}).
 * Output: object - {rowEl, nameEl}.
 */
function mountRow(listEl, { name, sessionId, seed, renameable = true }) {
    const document = listEl.ownerDocument;
    const rowEl = document.createElement('div');
    rowEl.className = 'session-sidebar-row';
    rowEl.setAttribute('data-rename-state', renameable ? 'renameable' : 'adopting');
    rowEl.dataset.name = name;
    rowEl.dataset.sessionId = sessionId;
    const nameEl = document.createElement('span');
    nameEl.setAttribute('data-row-name', '');
    nameEl.textContent = seed;
    rowEl.appendChild(nameEl);
    listEl.appendChild(rowEl);
    return { rowEl, nameEl };
}

/**
 * Load the sidebar controller and the rename module into one sandbox and
 * wire them for real via `SessionSidebar.init()` - the same call the app
 * makes on entering the terminal or home screen.
 * Inputs: document (Doc).
 * Output: object - {window, Sidebar, Rename}.
 */
function wireSidebar(document) {
    const { window } = loadModules(
        ['session-sidebar-rename.js', 'session-sidebar.js'],
        { document },
    );
    window.SessionSidebar.init();
    return { window, Sidebar: window.SessionSidebar, Rename: window.SessionSidebarRename };
}

// =====================================================================
// 1. THE REAL GESTURE REACHES beginEdit, FOR THE RIGHT SESSION.
// =====================================================================

await test('a double-click on a renameable name reaches beginEdit for THAT session, '
    + 'through the real registered listener', () => {
    const { document, listEl } = buildPanel();
    const { Rename } = wireSidebar(document);
    const a = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
    const b = mountRow(listEl, { name: 'cloude_web', sessionId: 'ses_2', seed: 'web' });

    assert.equal(Rename.isEditing(), false);
    // NOT a call to onDblClick. This dispatches a real event at the
    // name span and lets it bubble to the listEl listener
    // session-sidebar.js registers in init() - the gesture itself.
    a.nameEl.dispatchEvent('dblclick');

    assert.ok(Rename.isEditing(), 'the double-click must have opened an editor');
    assert.equal(a.rowEl.getAttribute('data-editing'), '1',
        'the row that was double-clicked must be the one editing');
    assert.equal(b.rowEl.getAttribute('data-editing'), null,
        'a sibling row must be untouched - this proves the RIGHT session, '
        + 'not merely A session');
    const input = a.rowEl.querySelector('.session-sidebar-rename-input');
    assert.ok(input, 'the editor input must be mounted on the clicked row');
    assert.equal(input.getAttribute('aria-label'), 'Rename api',
        'the editor must be seeded from the clicked row\'s own name');
});

// =====================================================================
// 2. THREE DOORS, ONE IMPLEMENTATION - the positive path.
// =====================================================================
// test_session_row_menu_dispatch.node.mjs already proves all three
// refuse an unrenameable row identically. These name each door on its
// own opening path, plus one assertion tying all three to the same
// observable outcome - so removing any one door, or repointing it at a
// second implementation, fails a named test rather than only breaking a
// use case nothing checks.

await test('DOOR 1 (double-click): the real gesture opens the editor', () => {
    const { document, listEl } = buildPanel();
    const { Rename } = wireSidebar(document);
    const { rowEl, nameEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
    nameEl.dispatchEvent('dblclick');
    assert.ok(Rename.isEditing());
    assert.equal(rowEl.getAttribute('data-editing'), '1');
});

await test('DOOR 2 (F2): the keyboard door opens the SAME editor', () => {
    const { document, listEl } = buildPanel();
    const { Rename } = wireSidebar(document);
    const { rowEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
    const handled = Rename.onRowKeydown({ key: 'F2', preventDefault() {} }, rowEl);
    assert.equal(handled, true);
    assert.ok(Rename.isEditing());
    assert.equal(rowEl.getAttribute('data-editing'), '1');
});

await test('DOOR 3 (row menu): the menu\'s rename item opens the SAME editor', () => {
    const { document, listEl } = buildPanel();
    const { window, Rename } = wireSidebar(document);
    window.CSS = { escape: (s) => s };
    window.addEventListener = () => {};
    vm.runInContext(clientJs('session-row-menu-actions.js'), window, {
        filename: 'session-row-menu-actions.js',
    });
    const { rowEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
    window.SessionRowMenuActions.run('rename', {
        name: 'cloude_api', label: 'api', surface: 'sidebar', sessionId: 'ses_1',
    });
    assert.ok(Rename.isEditing());
    assert.equal(rowEl.getAttribute('data-editing'), '1');
});

await test('all three doors land on IDENTICAL observable state - one editor, '
    + 'one seed, one commit path', () => {
    // Each door drives its OWN fresh sandbox (beginEdit refuses a second
    // open while one is in progress, so this cannot be three doors into
    // one still-open editor - it has to be three separate opens that
    // each reach the same code). If any door were repointed at a second
    // implementation, its shape of side effects would differ from the
    // other two, or the door would open nothing at all - either way this
    // fails.
    const outcomes = [];

    {
        const { document, listEl } = buildPanel();
        const { Rename } = wireSidebar(document);
        const { rowEl, nameEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
        nameEl.dispatchEvent('dblclick');
        outcomes.push({
            door: 'dblclick',
            editing: Rename.isEditing(),
            dataEditing: rowEl.getAttribute('data-editing'),
            ariaLabel: rowEl.querySelector('.session-sidebar-rename-input').getAttribute('aria-label'),
        });
    }
    {
        const { document, listEl } = buildPanel();
        const { Rename } = wireSidebar(document);
        const { rowEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
        Rename.onRowKeydown({ key: 'F2', preventDefault() {} }, rowEl);
        outcomes.push({
            door: 'f2',
            editing: Rename.isEditing(),
            dataEditing: rowEl.getAttribute('data-editing'),
            ariaLabel: rowEl.querySelector('.session-sidebar-rename-input').getAttribute('aria-label'),
        });
    }
    {
        const { document, listEl } = buildPanel();
        const { window, Rename } = wireSidebar(document);
        window.CSS = { escape: (s) => s };
    window.addEventListener = () => {};
        vm.runInContext(clientJs('session-row-menu-actions.js'), window, {
            filename: 'session-row-menu-actions.js',
        });
        const { rowEl } = mountRow(listEl, { name: 'cloude_api', sessionId: 'ses_1', seed: 'api' });
        window.SessionRowMenuActions.run('rename', {
            name: 'cloude_api', label: 'api', surface: 'sidebar', sessionId: 'ses_1',
        });
        outcomes.push({
            door: 'menu',
            editing: Rename.isEditing(),
            dataEditing: rowEl.getAttribute('data-editing'),
            ariaLabel: rowEl.querySelector('.session-sidebar-rename-input').getAttribute('aria-label'),
        });
    }

    for (const o of outcomes) {
        assert.equal(o.editing, true, `${o.door} must have opened an editor`);
        assert.equal(o.dataEditing, '1', `${o.door} must mark its row editing`);
        assert.equal(o.ariaLabel, 'Rename api', `${o.door} must seed the same editor`);
    }
});

// =====================================================================
// 3. A DOUBLE-CLICK ON SOMETHING NOT RENAMEABLE OPENS NOTHING.
// =====================================================================

await test('a double-click on a NOT-renameable name opens no editor', () => {
    const { document, listEl } = buildPanel();
    const { Rename } = wireSidebar(document);
    const { rowEl, nameEl } = mountRow(listEl, {
        name: 'cloude_locked', sessionId: 'ses_9', seed: 'locked', renameable: false,
    });
    nameEl.dispatchEvent('dblclick');
    assert.equal(Rename.isEditing(), false, 'a refused row must not open an editor');
    assert.equal(rowEl.getAttribute('data-editing'), null);
    assert.equal(rowEl.getAttribute('data-rename-refused'), '1',
        'the refusal must still be recorded, through the same beginEdit gate');
});

await test('a double-click with no [data-row-name] ancestor at all does nothing, '
    + 'and does not throw', () => {
    const { document, listEl } = buildPanel();
    const { Rename } = wireSidebar(document);
    // A plain child with no data-row-name - clicking the list's own
    // background, not a session's name.
    const filler = document.createElement('div');
    listEl.appendChild(filler);
    assert.doesNotThrow(() => filler.dispatchEvent('dblclick'));
    assert.equal(Rename.isEditing(), false);
});

const { passes, failures } = results();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
