/**
 * THE RECONCILED ROW MENU - the superset the owner ruled on 2026-09-10.
 * ---------------------------------------------------------------------
 * "merge not take everything". Four items came from adam's menu (rename,
 * fork, new session in folder, mute), three from ours (mark unread, move
 * to group, restart the agent), and close is the one both sides had. Pin
 * stays inline. Double-click rename STAYS and gains a menu twin.
 *
 * THESE ASSERTIONS ARE THE SPECIFICATION, NOT A DESCRIPTION OF THE
 * CURRENT MARKUP. The vanilla client/js this exercises is scheduled to be
 * replaced by the Svelte rebuild on feat/svelte-1.3, where this surface is
 * a plugin registry. So every case below is written against BEHAVIOUR -
 * the pure functions `contextFromRow` / `itemsFor`, and which collaborator
 * a chosen item calls - and never against a class name, an attribute
 * spelling or a rendered string. A port that satisfies these is correct
 * whatever it renders.
 *
 * WHAT EACH CASE PROTECTS, and why it is here rather than assumed:
 *   - the eight items, and their order, on a live row
 *   - RESTART ON A LIVE ROW. Decision 3. Adam's branch removed it and the
 *     owner ruled it back; this is the case that fails if it goes again.
 *   - the mark-unread flag gate, WITH ITS NEGATIVE CONTROL, because a
 *     gate that never hides anything passes every positive test.
 *   - a dead row per decision 4: inline controls, no menu.
 *   - BOTH RENAME ENTRY POINTS reaching one implementation.
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
 * Build a sandbox holding the menu's pure half.
 *
 * Description: loads session-row-actions.js (which owns `actionsFor` and
 *   `offersMenu`) and session-row-menu.js on top, plus whichever
 *   collaborators a case wants to vary.
 * Inputs: opts (object) - {markUnread (boolean), groupActions (boolean)}.
 * Output: object - {Menu, RowActions, win}.
 */
function sandbox(opts = {}) {
    const showMarkUnread = opts.markUnread !== false;
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
    const win = {};
    win.window = win;
    const context = {
        window: win,
        document: { createElement: makeDiv, addEventListener() {} },
        globalThis: win,
        console: { log() {} },
    };
    vm.createContext(context);
    vm.runInContext(clientJs('session-status-ui.js'), context);
    vm.runInContext(clientJs('session-row-actions.js'), context);
    // THE ONE GATE. markUnreadHtml returns '' when the operator turned the
    // control off, and the menu asks it rather than reading the flag a
    // second time - so overriding it here is overriding the real gate.
    const realMarkUnread = win.SessionStatusUI.markUnreadHtml;
    win.SessionStatusUI.markUnreadHtml = (name, unread) => (
        showMarkUnread ? realMarkUnread.call(null, name, unread) : '');
    if (opts.groupActions !== false) win.SessionSidebarGroupActions = { openPickerFor() {} };
    vm.runInContext(clientJs('session-row-menu.js'), context);
    return { Menu: win.SessionRowMenu, RowActions: win.SessionRowActions, win };
}

/** One live row fixture. Inputs: over (object). Output: object. */
const liveRow = (over = {}) => ({
    name: 'cloude_api', label: 'api', status: 'working',
    created_by_cloude: true, session_id: 'ses_1', ...over,
});

/** Item ids offered for a row. Inputs: row, opts. Output: Array<string>. */
function idsFor(env, row, opts = {}) {
    const ctx = env.Menu.contextFromRow(row, { surface: 'sidebar', renameable: true, ...opts });
    // Array.from re-homes the result into THIS realm: an array built
    // inside the vm context has a different Array prototype, and
    // assert.deepEqual compares that too.
    return Array.from(env.Menu.itemsFor(ctx).map((i) => i.id));
}

// =====================================================================
// The superset, and its order
// =====================================================================

test('a live row offers all eight items, in the ruled order', () => {
    const env = sandbox();
    assert.deepEqual(idsFor(env, liveRow()), [
        'rename', 'mark-unread', 'move-to-group', 'fork',
        'new-in-folder', 'mute', 'restart', 'close',
    ]);
});

test('the two weighty items sit below the separator, and only they', () => {
    // Restart and close both end the process running right now, so a
    // mis-aimed thumb lands on empty space rather than on either.
    const env = sandbox();
    const ctx = env.Menu.contextFromRow(liveRow(), { surface: 'sidebar', renameable: true });
    const items = env.Menu.itemsFor(ctx);
    const sepAt = items.findIndex((i) => i.separatorBefore);
    assert.equal(items[sepAt].id, 'restart', 'the separator opens the weighty group');
    assert.deepEqual(Array.from(items.slice(sepAt).map((i) => i.id)),
        ['restart', 'close']);
    assert.equal(items.filter((i) => i.separatorBefore).length, 1,
        'exactly one separator, or the grouping stops meaning anything');
});

test('every shortcut letter is distinct', () => {
    // A shared letter renders two identical hints and only ever reaches
    // the first item, silently.
    const env = sandbox();
    assert.ok(env.Menu.uniqueShortcuts());
});

// =====================================================================
// DECISION 3 - restart on a live row
// =====================================================================

test('DECISION 3: every measured-live status offers restart in the menu', () => {
    const env = sandbox();
    for (const status of ['working', 'working_subagent', 'question', 'notice',
        'finished_unread', 'idle', 'running']) {
        assert.ok(idsFor(env, liveRow({ status })).includes('restart'),
            `a live row (${status}) must offer restart`);
    }
});

test('NEGATIVE CONTROL: an UNDETERMINED row offers no restart', () => {
    // The half of the old prohibition that is still correct: offering to
    // restart a session whose state could not be read is a guess.
    const env = sandbox();
    for (const status of ['unknown', undefined, null, '']) {
        assert.ok(!idsFor(env, liveRow({ status })).includes('restart'),
            `status ${String(status)} must offer no restart`);
    }
});

test('restart availability is DERIVED from actionsFor, not a second list', () => {
    // If these two ever disagree, the row and its menu disagree about the
    // same session. Asserted as an identity rather than trusted.
    const env = sandbox();
    for (const status of ['working', 'idle', 'unknown', 'dead', 'question']) {
        const offeredByActions = env.RowActions.actionsFor(status)
            .includes(env.RowActions.ACTION_RESTART);
        const offeredByMenu = idsFor(env, liveRow({ status })).includes('restart');
        // A dead row draws no menu at all, so the menu cannot offer it
        // there; everywhere a menu IS drawn the two must agree.
        if (env.RowActions.offersMenu(status)) {
            assert.equal(offeredByMenu, offeredByActions,
                `menu and actionsFor disagree about restart for ${status}`);
        }
    }
});

// =====================================================================
// DECISION 2 - the mark-unread flag, with its negative control
// =====================================================================

test('mark unread is offered while the control is enabled', () => {
    assert.ok(idsFor(sandbox({ markUnread: true }), liveRow()).includes('mark-unread'));
});

test('NEGATIVE CONTROL: mark unread VANISHES when the flag is off', () => {
    // Absent, not merely disabled: a greyed item still advertises a
    // feature the operator turned off. This is the case that fails if the
    // menu ever reads the flag itself instead of asking the one gate.
    const ids = idsFor(sandbox({ markUnread: false }), liveRow());
    assert.ok(!ids.includes('mark-unread'), 'the item must not be rendered at all');
    assert.ok(ids.includes('close'), 'and the rest of the menu is unaffected');
    assert.ok(ids.includes('restart'));
});

test('the mark-unread label states the RESULT, and flips with the row', () => {
    const env = sandbox();
    const labelFor = (unread) => {
        const ctx = env.Menu.contextFromRow(liveRow({ unread }),
            { surface: 'sidebar', renameable: true });
        return env.Menu.itemsFor(ctx).find((i) => i.id === 'mark-unread').label;
    };
    assert.match(labelFor(false), /mark unread/);
    assert.match(labelFor(true), /clear unread/);
});

// =====================================================================
// Move to group, mute, fork, new-in-folder
// =====================================================================

test('move to group is offered on the sidebar and withheld on the launchpad', () => {
    // Only the sidebar files sessions into groups. Offering the item on a
    // surface with no picker behind it would open nothing.
    assert.ok(idsFor(sandbox(), liveRow()).includes('move-to-group'));
    assert.ok(!idsFor(sandbox(), liveRow(), { surface: 'launchpad' }).includes('move-to-group'));
});

test('move to group is withheld when the group module is absent', () => {
    assert.ok(!idsFor(sandbox({ groupActions: false }), liveRow()).includes('move-to-group'));
});

test('the mute label states the RESULT, and flips with the row', () => {
    const env = sandbox();
    const labelFor = (muted) => {
        const ctx = env.Menu.contextFromRow(liveRow({ notifications_muted: muted }),
            { surface: 'sidebar', renameable: true });
        return env.Menu.itemsFor(ctx).find((i) => i.id === 'mute').label;
    };
    assert.match(labelFor(false), /^mute/);
    assert.match(labelFor(true), /^unmute/);
});

test('fork is REFUSED WITH A REASON on a session cloudecode did not create', () => {
    // Rendered and focusable, not hidden: the explanation has to be
    // reachable by exactly the users who need it.
    const env = sandbox();
    const ctx = env.Menu.contextFromRow(liveRow({ created_by_cloude: false }),
        { surface: 'sidebar', renameable: true });
    const fork = env.Menu.itemsFor(ctx).find((i) => i.id === 'fork');
    assert.ok(fork, 'the item is still offered');
    assert.equal(fork.enabled, false);
    assert.match(fork.reason, /cannot fork/);
});

test('rename is REFUSED WITH A REASON when the surface says it cannot', () => {
    const env = sandbox();
    const ctx = env.Menu.contextFromRow(liveRow(), {
        surface: 'sidebar', renameable: false, renameReason: 'open it first',
    });
    const rename = env.Menu.itemsFor(ctx).find((i) => i.id === 'rename');
    assert.equal(rename.enabled, false);
    assert.equal(rename.reason, 'open it first');
});

// =====================================================================
// DECISION 4 - a dead row
// =====================================================================

test('DECISION 4: a dead row draws no menu at all', () => {
    // It keeps inline restart and remove. A dead row also belongs in
    // Recent rather than on the live list, which is decision 4 itself.
    const env = sandbox();
    assert.equal(env.RowActions.offersMenu('dead'), false);
    assert.deepEqual(Array.from(env.RowActions.actionsFor('dead')),
        [env.RowActions.ACTION_RESTART, env.RowActions.ACTION_REMOVE]);
});

// =====================================================================
// The captured context survives a repaint
// =====================================================================

test('the context round-trips through the trigger unchanged', () => {
    // Identity is frozen at paint time because the list rebuilds every
    // five seconds. Every fact an item needs must survive the trip.
    const env = sandbox();
    const ctx = env.Menu.contextFromRow(liveRow({ unread: true }),
        { surface: 'sidebar', renameable: true });
    const html = env.Menu.triggerHtml(ctx);
    const tag = (html.match(/<button[\s\S]*?>/) || [])[0];
    const stub = { getAttribute(a) {
        const m = tag.match(new RegExp(`\\s${a}="([^"]*)"`));
        return m ? m[1] : null;
    } };
    const back = env.Menu.contextFromTrigger(stub);
    for (const field of ['name', 'status', 'unread', 'restartable',
        'markUnreadAvailable', 'groupable', 'renameable', 'muted']) {
        assert.equal(back[field], ctx[field], `${field} did not survive the trigger`);
    }
    assert.deepEqual(Array.from(env.Menu.itemsFor(back).map((i) => i.id)),
        Array.from(env.Menu.itemsFor(ctx).map((i) => i.id)),
        'the same menu must be built from the round-tripped context');
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
