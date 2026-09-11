// The slash command palette off the connect path, and the create path
// entering the session before it repaints a list.
// ----------------------------------------------------------------------
// WHAT WAS COUPLED THAT SHOULD NOT HAVE BEEN. Both session entry paths in
// app.js did `await window.SlashCommandsModal.init(...)` on the line
// above the terminal connect. `init` makes TWO server round trips - the
// starred-favourites row and the full grouped palette - and the socket
// waited for both. The list is a property of the session's AGENT, not of
// the socket: nothing in it is needed to render a terminal and nothing in
// the terminal is needed to render it.
//
// THE HARD PART IS NOT MAKING IT ASYNCHRONOUS. It is what happens when a
// fetch started for session A lands after the user has moved to session
// B. A slash command run in the wrong pane RUNS A COMMAND, so the
// interesting assertions here are the ones where the palette arrives
// late and must be DISCARDED.
//
// STRUCTURAL, NOT TIMED. The fetch is a promise the TEST decides when to
// resolve, so "did the caller wait for it" is answered by ordering rather
// than by a clock, and nothing here can flake on a loaded box.
//
// Run with: node --test tests/test_slash_commands_boot.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOOT_SRC = read('client/js/slash-commands-boot.js');
const NAVGEN_SRC = read('client/js/navigation-generation.js');
const APP_SRC = read('client/js/app.js');
// THE 1.4.0 MERGE MOVED THESE RULES, IT DID NOT RETIRE THEM.
// `client/js/launchpad.js` is deleted; the home screen's create and
// detach paths are `web/src/lib/launchpad/create-flow.ts` and
// `web/src/lib/launchpad/navigation.ts`. The assertions below are the
// other line's, re-aimed at the code that now has to satisfy them - a
// guard left pointing at a deleted file does not fail, it throws ENOENT,
// and a guard that cannot run is not a guard.
const CREATE_FLOW_SRC = read('web/src/lib/launchpad/create-flow.ts');
const NAVIGATION_SRC = read('web/src/lib/launchpad/navigation.ts');
const INDEX_HTML = read('client/index.html');

/**
 * Description: a realm with the shipped boot module, the real navigation
 *   generation counter, and a modal stand-in whose init the TEST
 *   resolves.
 * Inputs: none.
 * Output: {window, modal, Boot, NavGen}.
 */
function makeRealm() {
    const sandbox = {
        console: { log() {}, warn() {}, debug() {}, error() {} },
        Promise, setTimeout,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });
    vm.runInContext(BOOT_SRC, sandbox, { filename: 'slash-commands-boot.js' });

    const modal = {
        button: null,
        inits: [],            // one {dir, resolve, reject} per init call
        shows: 0,
        inserted: [],
        init(cb, dir) {
            modal.onSelect = cb;
            return new Promise((resolve, reject) => {
                modal.inits.push({
                    dir,
                    resolve: () => { modal.button = {}; resolve(); },
                    reject,
                });
            });
        },
        show() { modal.shows += 1; },
    };
    sandbox.window.SlashCommandsModal = modal;
    sandbox.window.TerminalController = {
        inserted: [],
        insertText(text, ticket) { this.inserted.push([text, ticket]); },
    };
    return {
        window: sandbox.window,
        modal,
        Boot: sandbox.window.SlashCommandsBoot,
        NavGen: sandbox.window.NavigationGeneration,
    };
}

/** Let every already-resolved promise run its continuations. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// -------------------------------------------------- off the critical path

test('start() returns immediately, before the fetch has resolved', () => {
    // Deliberately NOT a promise: returning one invites a caller to await
    // it, which is the defect this module removes.
    const { Boot, modal, NavGen } = makeRealm();
    const nav = NavGen.begin('session:a');
    assert.equal(Boot.start('/proj', nav), undefined,
        'start must return nothing, or somebody will await it');
    assert.equal(modal.inits.length, 1, 'the fetch did begin');
    assert.equal(modal.shows, 0, 'and the control waits for it');
});

test('the palette shows once its fetch lands', async () => {
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/proj', NavGen.begin('session:a'));
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 1);
    // Field by field: the object comes from the vm realm, so it has a
    // different Object prototype and deepEqual would refuse it.
    assert.equal(Boot.state().loadedFor, '/proj');
    assert.equal(Boot.state().loading, false);
});

// ------------------------------------------- the late-arrival controls

test('THE CASE THAT MATTERS: a palette landing after the user left is discarded', async () => {
    // Fetched for session A's project, lands after the user is in B. A
    // slash command run in the wrong pane RUNS A COMMAND.
    const { Boot, modal, NavGen } = makeRealm();
    const navA = NavGen.begin('session:a');
    Boot.start('/project-a', navA);
    NavGen.begin('session:b');             // the user moves on
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 0,
        "A's palette must not be shown over B's session");
});

test('POSITIVE CONTROL: the same fetch DOES show while its navigation stands', async () => {
    // Without this, a guard that refused everything would pass the test
    // above and the feature would simply never work.
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/project-a', NavGen.begin('session:a'));
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 1);
});

test('a caller with no navigation token is treated as current', async () => {
    // Not having looked is not evidence of staleness - the same asymmetry
    // Terminal#_navCurrent uses. Refusing here would be a new way for the
    // palette to silently never appear.
    const { Boot, modal } = makeRealm();
    Boot.start('/proj', null);
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 1);
});

// ------------------------------------------------------- the fetch budget

test('re-entering the SAME project does not re-fetch', async () => {
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/proj', NavGen.begin('a'));
    modal.inits[0].resolve();
    await settle();
    Boot.start('/proj', NavGen.begin('a again'));
    await settle();
    assert.equal(modal.inits.length, 1, 'one fetch for one project');
    assert.equal(modal.shows, 2, 'but the control is shown each time');
});

test('a DIFFERENT project does re-fetch, because its command set differs', async () => {
    // Project commands and skills are discovered under the working
    // directory, so reusing one project's palette for another would show
    // the user commands that are not there.
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/project-a', NavGen.begin('a'));
    modal.inits[0].resolve();
    await settle();
    Boot.start('/project-b', NavGen.begin('b'));
    await settle();
    assert.equal(modal.inits.length, 2);
    assert.equal(modal.inits[1].dir, '/project-b');
});

test('a second call while one is in flight JOINS it', async () => {
    // Two inits racing would have two callbacks writing one projectPath,
    // and the loser would decide which commands the panel shows.
    const { Boot, modal, NavGen } = makeRealm();
    const nav = NavGen.begin('a');
    Boot.start('/proj', nav);
    Boot.start('/proj', nav);
    Boot.start('/proj', nav);
    assert.equal(modal.inits.length, 1, 'one fetch, not three');
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 3, 'and every caller in that navigation is answered');
});

test('joiners from a SUPERSEDED navigation are still refused', async () => {
    // Joining the in-flight fetch is an optimisation, not a way around
    // the token: the first caller's navigation is stale the moment the
    // second begins, and only the navigation still on screen may paint.
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/proj', NavGen.begin('a'));
    Boot.start('/proj', NavGen.begin('b'));
    assert.equal(modal.inits.length, 1, 'still one fetch');
    modal.inits[0].resolve();
    await settle();
    assert.equal(modal.shows, 1, "only the current navigation's caller shows it");
});

test('A FAILED FETCH IS NOT CACHED AS AN ANSWER', async () => {
    // The palette is a convenience. A failure must leave the next entry
    // free to retry, and must never stop a session opening.
    const { Boot, modal, NavGen } = makeRealm();
    Boot.start('/proj', NavGen.begin('a'));
    modal.inits[0].reject(new Error('the server was not there'));
    await settle();
    assert.equal(Boot.state().loadedFor, null, 'a failure is not a loaded palette');
    Boot.start('/proj', NavGen.begin('b'));
    assert.equal(modal.inits.length, 2, 'the next entry tries again');
});

test('a picked command reaches the terminal with its ownership ticket', async () => {
    // The ticket is claimed when the PANEL OPENED. The panel survives a
    // session switch, so a pick made after one would otherwise run in the
    // pane the user left.
    const { Boot, modal, window: w, NavGen } = makeRealm();
    Boot.start('/proj', NavGen.begin('a'));
    modal.inits[0].resolve();
    await settle();
    const ticket = { claimed: 'at the gesture' };
    modal.onSelect('/clear', ticket);
    assert.deepEqual(w.TerminalController.inserted, [['/clear', ticket]]);
});

// ------------------------------------------------- the call sites

test('app.js no longer AWAITS the palette above the connect', () => {
    // The whole point. An await here puts two server round trips between
    // a click and a connected pane.
    assert.ok(!/await window\.SlashCommandsModal\.init/.test(APP_SRC),
        'the terminal connect must not wait for the command list');
    const starts = (APP_SRC.match(/SlashCommandsBoot\.start\(/g) || []).length;
    assert.equal(starts, 2,
        `both entry paths must start it; found ${starts}`);
    assert.ok(/SlashCommandsBoot\.start\([^)]*nav\)/.test(APP_SRC),
        'and both must hand it the navigation token');
});

test('index.html serves the boot module after the modal it drives', () => {
    const order = [...INDEX_HTML.matchAll(/\/static\/js\/([A-Za-z0-9._\-/]+\.js)/g)]
        .map((m) => m[1]);
    const boot = order.indexOf('slash-commands-boot.js');
    assert.ok(boot >= 0, 'the module must be in index.html or it is dead code');
    assert.ok(order.indexOf('slash-commands.js') < boot);
    assert.ok(order.indexOf('navigation-generation.js') < boot);
});

// --------------------------------------- create enters, then decorates

test('THE CREATE PATH ENTERS THE SESSION BEFORE IT REPAINTS THE LIST', () => {
    // The session is what the user clicked; the project repaint is
    // bookkeeping they did not ask for, and nothing in its result is
    // needed to render the terminal. Reading the ORDER in the source,
    // because driving the whole create path needs a server.
    const fn = CREATE_FLOW_SRC.slice(CREATE_FLOW_SRC.indexOf('export async function createProjectFlow('));
    const body = fn.slice(0, fn.indexOf('isAlreadyRunning(error)'));
    const enter = body.indexOf('host.announceSessionCreated(session, nav)');
    const decorate = body.lastIndexOf('await refreshProjects(host)');
    assert.ok(enter > 0 && decorate > 0, 'both steps must still happen');
    assert.ok(enter < decorate,
        'the user watches a list repaint before their new session appears');
});

test('the decoration still happens, and is still guarded on its own', () => {
    // Moving it after entry is a REORDERING, not a removal: a created
    // session that never gets decorated shows up under the wrong project.
    const fn = CREATE_FLOW_SRC.slice(CREATE_FLOW_SRC.indexOf('export async function createProjectFlow('));
    const body = fn.slice(0, fn.indexOf('isAlreadyRunning(error)'));
    assert.ok(body.includes('await refreshProjects(host)'));
    // The guard moved into `refreshProjects`, which is the one helper both
    // create flows call, so it is asserted where it now lives rather than
    // inline in each caller.
    const helper = CREATE_FLOW_SRC.slice(CREATE_FLOW_SRC.indexOf('async function refreshProjects('));
    assert.ok(/catch/.test(helper.slice(0, helper.indexOf('\n}'))),
        'a failed repaint must not read as a failed create');
});

test('CreateSessionRequest.label is still sent', () => {
    // claude_title_sync depends on the session being launched with a
    // --name, and the plain create endpoint was the one creator that
    // used to pass none.
    // The payload is built by `buildCreatePayload`, so the label is
    // asserted there - that is the one place every create path composes it.
    const fn = CREATE_FLOW_SRC.slice(CREATE_FLOW_SRC.indexOf('export function buildCreatePayload('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/label:/.test(body), 'the launch must still name the session');
});

// ------------------------------------------ the detach timers are gone

test('NEITHER detach path sleeps before it acts', () => {
    // Both slept 500 ms "to let the server finish clearing its backend
    // handles". It already has: detach_session awaits
    // detach_current_session, which awaits the idle watcher's stop and
    // the reader task's cancellation before the handler returns, so the
    // response the client already awaited IS the completion signal.
    // The constant is the assertion now: both paths call
    // `host.wait(DETACH_SETTLE_MS)`, and the seam is kept deliberately so
    // a future teardown that stops being awaited is one edit away. What
    // must not come back is a NON-ZERO wait.
    assert.match(NAVIGATION_SRC, /export const DETACH_SETTLE_MS = 0;/,
        'a detach settle delay is back; the awaited detach response is the '
        + 'completion signal, so a sleep here waits for what already happened');
    for (const name of ['detachAndOpenProject', 'detachAndCreateNew']) {
        const fn = NAVIGATION_SRC.slice(NAVIGATION_SRC.indexOf(`export async function ${name}(`));
        const body = fn.slice(0, fn.indexOf('\n}'));
        assert.ok(!/setTimeout/.test(body),
            `${name} still sleeps before re-opening`);
        assert.ok(/await host\.detachSession\(\)/.test(body),
            `${name} must still wait for the detach itself`);
    }
});

test('and each reports its OWN failure rather than calling it a failed detach', () => {
    // The timer escaped the try block, so an error in the re-open used to
    // be an unhandled rejection. Folding it into the detach's catch would
    // report a failed OPEN as a failed detach.
    const fn = NAVIGATION_SRC.slice(NAVIGATION_SRC.indexOf('export async function detachAndOpenProject('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.equal((body.match(/catch \(error\)/g) || []).length, 2,
        'the detach and the re-open are two failures and need two messages');
    // Named through the catalog rather than as a literal, because this
    // tree's i18n guard refuses a hardcoded sentence in a ported file.
    assert.ok(body.includes('HOME_KEYS.openFailed'), 'the re-open names itself');
});

test('no 500ms sleep survives anywhere on the launch or connect paths', () => {
    // Phase 2 exists to remove configured delays, not to relocate them.
    for (const rel of ['web/src/lib/launchpad/navigation.ts',
        'web/src/lib/launchpad/create-flow.ts', 'client/js/terminal.js',
        'client/js/app.js']) {
        const src = read(rel);
        assert.ok(!/setTimeout\([^;]*,\s*500\s*\)/.test(src),
            `${rel} still carries a 500ms delay`);
    }
});
