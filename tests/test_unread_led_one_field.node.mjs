// ONE `/sessions/list` ROW, THREE SURFACES, THE SAME LIGHT.
//
// WHAT WENT WRONG. `SessionStatusUI.dotHtml(status, signals)` takes an
// OPTIONAL second argument carrying the two fields a bare status string
// cannot express - `unread` and `startup_gate` - and `StatusLed.ledStateFor`
// is the only thing that reads them. Every live call site passed the
// status alone. So the flag reached the row, was fingerprinted by both
// repaint signatures, forced a repaint, and was then dropped at the last
// inch: an `idle` session the user had just marked unread rendered
// identically to one with nothing waiting on it.
//
// WHAT THE FLAG MOVES CHANGED ON 2026-09-09, and this file changed with
// it. Unread used to paint an outer `unread` halo; the ring now carries
// ACTIVITY alone and unread rides the INNER dot - green `done` against
// grey `idle`. So the observable that proves the field survived the trip
// is `data-inner`, not `data-outer`, and it is only observable on a
// RESTING row: a working session is painted working whether or not an
// older turn is unread, deliberately. The assertions below moved to the
// dot for that reason, and the cross-surface agreement check now compares
// BOTH attributes, which is a stronger claim than the halo one it
// replaces.
//
// WHY A NODE TEST AND NOT A SCREENSHOT. The defect is a dropped argument,
// which is exactly what source-level rendering can see and a pixel diff
// cannot explain. What this file will NOT catch is CSS that paints the
// dot invisibly; tests/test_status_led.node.mjs owns that half.
//
// THE LOAD-BEARING PART IS THAT ONE ROW OBJECT FEEDS BOTH SURFACES. Two
// separate fixtures would let the two renderers agree with their own
// stubs and disagree with each other, which is the shape of the bug.
//
// Run with: node tests/test_unread_led_one_field.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { loadLaunchpad, el, test, results } from './lib-home-mechanics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Load the real LED stack (status-led.js + session-status-ui.js) into one
 * sandbox and return its `SessionStatusUI`.
 *
 * Description: the two modules are loaded together because dotHtml
 *   delegates to `globalThis.StatusLed` and falls back to the legacy dot
 *   when it is absent - a test that loaded only one of them would measure
 *   the fallback and pass while the LED was broken.
 * @returns {object} The sandbox's SessionStatusUI.
 */
function loadStatusUI() {
    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['status-led.js', 'session-status-ui.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8'),
            sandbox,
            { filename: f },
        );
    }
    assert.ok(sandbox.StatusLed, 'status-led.js did not publish StatusLed');
    return sandbox.SessionStatusUI;
}

/**
 * Load the real session-sidebar-rows.js against the real LED stack.
 * @returns {object} The sandbox's SessionSidebarRows.
 */
function loadSidebarRows() {
    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    // session-sidebar-rows.js escapes through a detached <div>, so it needs
    // exactly this much document. Escaping TEXT content, not attributes -
    // the same three characters the real textContent/innerHTML round trip
    // produces, and no more (see the module's own note on why it does not
    // use this idiom for attribute values).
    sandbox.document = {
        createElement() {
            return {
                textContent: '',
                get innerHTML() {
                    return String(this.textContent)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');
                },
            };
        },
    };
    vm.createContext(sandbox);
    for (const f of [
        'status-led.js',
        'session-status-ui.js',
        'session-startup-gate.js',
        'session-sidebar-rows.js',
    ]) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8'),
            sandbox,
            { filename: f },
        );
    }
    assert.ok(sandbox.SessionSidebarRows, 'session-sidebar-rows.js did not publish');
    return sandbox.SessionSidebarRows;
}

/**
 * The one row both surfaces render, shaped exactly as the merge in
 * session-sidebar-fetch.js and launchpad.js leaves it after folding a
 * `/sessions/list` SessionInfo over an attachable row.
 * @param {string} status  The wrapper's `activity_status`.
 * @param {boolean} unread  The wrapper's `unread`.
 * @returns {object} One merged session row.
 */
function listRow(status, unread) {
    return {
        name: 'cloude_oneflag',
        label: 'one flag',
        status,
        unread,
        is_active: false,
        is_this_tab: false,
        created_by_cloude: true,
        created_at_epoch: 1788444912,
        session_id: 'ses_oneflag',
        startup_gate: 'ready',
        agent_family: 'claude',
        agent_family_source: 'launched',
        pinned_theme: null,
        last_work_at: null,
    };
}

/**
 * Read the `data-outer` value off the FIRST LED in a fragment.
 * @param {string} html  Rendered markup.
 * @returns {?string} The outer state, or null when no LED was drawn.
 */
function outerOf(html) {
    const m = String(html).match(/data-outer="([^"]*)"/);
    return m ? m[1] : null;
}

/**
 * Read the `data-inner` value off the FIRST LED in a fragment.
 * @param {string} html  Rendered markup.
 * @returns {?string} The inner state, or null when no LED was drawn.
 */
function innerOf(html) {
    const m = String(html).match(/data-inner="([^"]*)"/);
    return m ? m[1] : null;
}

/**
 * Render the launchpad's running-session CARD for one row, through the
 * real `renderRunningSessions()` and the real LED stack.
 * @param {object} row  One merged session row.
 * @returns {string} The card container's innerHTML.
 */
function renderCard(row) {
    const container = el('running-sessions-list-container', { id: 'running-sessions-list' });
    const section = el('running-sessions-section', { id: 'running-sessions-section' });
    const { lp, win } = loadLaunchpad({
        'running-sessions-list': container,
        'running-sessions-section': section,
    });
    // The harness stubs SessionStatusUI with a dot that ignores its
    // arguments. Swap in the REAL one, or this measures the stub.
    win.SessionStatusUI = Object.assign({}, win.SessionStatusUI, loadStatusUI());
    lp.runningSessions = [row];
    lp.runningSessionsListing = { ok: true, reason: null, detail: null, sources: [] };
    lp._lastRunningSig = null;
    lp.renderRunningSessions();
    return container.innerHTML;
}

/**
 * Render the launchpad's project-TREE child row for one row.
 * @param {object} row  One merged session row.
 * @returns {string} The row markup.
 */
function renderTreeRow(row) {
    const { lp, win } = loadLaunchpad({});
    win.SessionStatusUI = Object.assign({}, win.SessionStatusUI, loadStatusUI());
    return lp._renderTreeSessionRowHtml(row);
}

const SidebarRows = loadSidebarRows();

/**
 * Render the sidebar row for one row object.
 * @param {object} row  One merged session row.
 * @returns {string} The row markup.
 */
function renderSidebarRow(row) {
    return SidebarRows.rowHtml(row, 'cozy');
}

const SURFACES = [
    ['sidebar row', renderSidebarRow],
    ['launchpad card', renderCard],
    ['launchpad project tree row', renderTreeRow],
];

// ---------------------------------------------------------------------
// 1. THE FIX: one field, every surface.
// ---------------------------------------------------------------------

for (const [name, render] of SURFACES) {
    await test(`${name}: an idle+unread row paints the green unread dot`, () => {
        const html = render(listRow('idle', true));
        assert.equal(innerOf(html), 'done',
            `${name} dropped the row's unread field`);
    });

    await test(`${name}: and the ring is the STILL green one, never breathing`, () => {
        // The owner's 2026-09-09 ruling: unread rides the ring, and the
        // ring is crisp and still. `active` is the only state that
        // animates, so a light that MOVES is a session that is moving -
        // which is the whole of the defect this replaced.
        const html = render(listRow('idle', true));
        assert.equal(outerOf(html), 'unread',
            `${name} dropped the unread ring`);
        assert.notEqual(outerOf(html), 'active',
            `${name} made a finished conversation breathe`);
    });
}

// ---------------------------------------------------------------------
// 2. THE NEGATIVE CONTROL. A renderer that hardcoded `unread` would pass
//    every assertion above. These are what make the ones above mean
//    something.
// ---------------------------------------------------------------------

for (const [name, render] of SURFACES) {
    await test(`${name}: an idle row with NOTHING waiting paints the grey read dot`, () => {
        const html = render(listRow('idle', false));
        assert.equal(innerOf(html), 'idle',
            `${name} claimed unread on a row that is not`);
        assert.equal(outerOf(html), 'steady',
            `${name} did not calm the ring on a session that was read`);
    });

    await test(`${name}: a working row rings active whatever the flag says`, () => {
        // BOTH directions. The ring carries unread AND activity, and
        // activity outranks it: a working session is working, and a
        // renderer that let an old unread turn stop the pulse would be
        // hiding the louder, more perishable fact behind the quieter one.
        assert.equal(outerOf(render(listRow('working', false))), 'active',
            `${name} lost the working ring`);
        assert.equal(outerOf(render(listRow('working', true))), 'active',
            `${name} let an unread flag change a working session's ring`);
    });

    await test(`${name}: a DEAD pane is never painted as something to read`, () => {
        // An unread flag must not paint a corpse as waiting for you.
        const html = render(listRow('dead', true));
        assert.equal(outerOf(html), 'off', `${name} rang a dead pane`);
        assert.equal(innerOf(html), 'dead', `${name} painted a dead pane as unread`);
    });
}

// ---------------------------------------------------------------------
// 3. THE TWO SURFACES AGREE, ROW FOR ROW. This is the claim the bug
//    report actually made: the same list row rendered two different
//    halos depending on which screen you were looking at.
// ---------------------------------------------------------------------

await test('every surface renders the same LIGHT for the same list row', () => {
    for (const status of ['idle', 'working', 'finished_unread', 'unknown', 'dead']) {
        for (const unread of [true, false]) {
            const row = listRow(status, unread);
            const seen = SURFACES.map(([name, render]) => {
                const html = render(row);
                return [name, innerOf(html) + '/' + outerOf(html)];
            });
            const first = seen[0][1];
            for (const [name, light] of seen) {
                assert.equal(light, first,
                    `${status}/unread=${unread}: ${name} said ${light}, ` +
                    `${seen[0][0]} said ${first}`);
            }
        }
    }
});

// ---------------------------------------------------------------------
// 3b. THE RING IS A FUNCTION OF BOTH, AND ACTIVITY WINS. The exhaustive
//     check that no surface invents a ring the others do not, and that
//     `unread` is reachable ONLY where nothing is running.
// ---------------------------------------------------------------------

await test('the unread ring appears exactly where a turn finished and nothing runs', () => {
    for (const status of ['idle', 'working', 'finished_unread', 'unknown', 'dead']) {
        for (const unread of [true, false]) {
            const row = listRow(status, unread);
            const resting = status === 'finished_unread'
                || (status === 'idle' && unread);
            for (const [name, render] of SURFACES) {
                const outer = outerOf(render(row));
                if (resting) {
                    assert.equal(outer, 'unread',
                        `${name} lost the unread ring for ${status}/unread=${unread}`);
                } else {
                    assert.notEqual(outer, 'unread',
                        `${name} claimed a finished turn for ${status}/unread=${unread}`);
                }
            }
        }
    }
});

// ---------------------------------------------------------------------
// 4. THE ENVELOPE READS THE SAME FIELD, not a parallel one.
// ---------------------------------------------------------------------

await test('the mark-unread control is pressed from the same field', () => {
    const ui = loadStatusUI();
    assert.match(ui.markUnreadHtml('cloude_oneflag', true), /aria-pressed="true"/);
    assert.match(ui.markUnreadHtml('cloude_oneflag', false), /aria-pressed="false"/);
    // The handler sends the OPPOSITE of what the row painted, so the
    // data attribute has to carry the same value aria-pressed does.
    assert.match(ui.markUnreadHtml('cloude_oneflag', true), /data-unread-current="true"/);
});

const { passes, failures } = results();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
