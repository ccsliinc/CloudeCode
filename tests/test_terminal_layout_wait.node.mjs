// A LAYOUT WAIT MAY DELAY A CONNECT, NEVER CANCEL ONE.
//
// WHAT WENT WRONG, measured on live 2026-09-09.
// `TerminalController.connectWebSocket()` opened with
// `await this.waitForFontsAndLayout(container)`, whose tail was two bare
// `await new Promise(requestAnimationFrame)` calls. A browser does not
// run rAF callbacks for a tab it is not painting - and it does not run
// them late, it runs them when the tab is painted again, which may be
// never. So entering a session in a backgrounded tab suspended
// `connectWebSocket()` INSIDE that await, before `openWebSocket()` was
// ever reached.
//
// The failure is silent and permanent, which is why it went unnoticed:
// `ws` stays null, so there is no socket to close, so `onclose` never
// fires, so the auto-reconnect ladder - every rung of which is gated on
// a socket having existed - cannot fire either. The terminal sits on
// "Connecting to terminal...", the string set on the line ABOVE the
// await. Measured: a session entered at 23:57:28Z still had no
// WebSocket at 00:02Z; a bare `requestAnimationFrame` in that tab did
// not fire within 3000 ms while `document.visibilityState === 'hidden'`;
// and the suspended connect opened its socket the instant the tab was
// painted, 35 minutes later.
//
// AND THE UNREAD FLAG RIDES ON THIS. The server clears unread when a WS
// terminal binds (`SessionManager.mark_session_viewed`), so a session
// opened in an unpainted tab is never marked read, and the row keeps a
// halo nothing can clear. That is the symptom this was found through.
//
// THE NEGATIVE CONTROL IS LOAD-BEARING: a wait that simply returned
// immediately would pass every "it does not hang" assertion here and
// would also throw away the layout settling a painted tab needs. So the
// painted case asserts the frames were actually awaited.
//
// Run with: node tests/test_terminal_layout_wait.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'client', 'js', 'terminal-layout-wait.js');

/**
 * Load the module under a fabricated global.
 *
 * @param {object} opts
 * @param {boolean} opts.painting - whether requestAnimationFrame ever fires.
 * @returns {{api: object, rafRequests: number[]}}
 */
function load({ painting }) {
    const rafRequests = [];
    const sandbox = {
        setTimeout,
        clearTimeout,
        Date,
        console: { warn() {}, log() {} },
        requestAnimationFrame(cb) {
            rafRequests.push(cb);
            // An unpainted tab QUEUES the callback and never runs it.
            if (painting) setTimeout(() => cb(1), 0);
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
    return { api: sandbox.TerminalLayoutWait, rafRequests };
}

/** A container element double reporting a fixed box. */
function el(w, h) {
    return { offsetWidth: w, offsetHeight: h };
}

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}\n      ${e && e.message}`);
    }
}

console.log('terminal-layout-wait');

// --- THE REGRESSION ------------------------------------------------------

await check('an UNPAINTED tab resolves instead of hanging forever', async () => {
    const { api, rafRequests } = load({ painting: false });
    const started = Date.now();
    const result = await Promise.race([
        api.waitForLayout(el(1741, 724), { frameTimeoutMs: 30 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: never resolved')), 2000))
    ]);
    assert.equal(result.sized, true, 'the box was measurable');
    assert.equal(result.timedOut, true, 'must report that it gave up on paint');
    assert.equal(result.framesPainted, 0, 'no frame was painted');
    // It really did ask for frames - it did not skip the wait entirely.
    assert.equal(rafRequests.length, api.FRAME_COUNT, 'still requested its frames');
    assert.ok(Date.now() - started < 1500, 'bounded, not merely finite');
});

await check('an unpainted tab with a ZERO-SIZE container still resolves', async () => {
    const { api } = load({ painting: false });
    const result = await Promise.race([
        api.waitForLayout(el(0, 0), { sizeTimeoutMs: 60, frameTimeoutMs: 20 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: never resolved')), 2000))
    ]);
    assert.equal(result.sized, false, 'never got a box, and says so');
    assert.equal(result.timedOut, true);
});

await check('a null container is not fatal', async () => {
    const { api } = load({ painting: false });
    const result = await api.waitForLayout(null, { sizeTimeoutMs: 40, frameTimeoutMs: 20 });
    assert.equal(result.sized, false);
    assert.equal(result.timedOut, true);
});

await check('a missing requestAnimationFrame is not fatal', async () => {
    const { api } = load({ painting: false });
    // Strip rAF the way a non-browser harness would.
    const result = await Promise.race([
        (async () => {
            const painted = await api.nextFrameOrTimeout(25);
            return painted;
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), 1500))
    ]);
    assert.equal(result, false, 'timer settles it');
});

// --- NEGATIVE CONTROL: the painted case must NOT be short-circuited ------

await check('a PAINTED tab still waits for its frames (not short-circuited)', async () => {
    const { api, rafRequests } = load({ painting: true });
    const result = await api.waitForLayout(el(1741, 724), { frameTimeoutMs: 500 });
    assert.equal(result.sized, true);
    assert.equal(result.timedOut, false, 'a painted tab never reports a timeout');
    assert.equal(result.framesPainted, api.FRAME_COUNT, 'both frames were awaited');
    assert.equal(rafRequests.length, api.FRAME_COUNT);
});

await check('a painted tab waits out a container that gains its box late', async () => {
    const { api } = load({ painting: true });
    const box = el(0, 0);
    setTimeout(() => { box.offsetWidth = 800; box.offsetHeight = 400; }, 40);
    const result = await api.waitForLayout(box, { sizeTimeoutMs: 1000, frameTimeoutMs: 500 });
    assert.equal(result.sized, true, 'picked up the box once it appeared');
    assert.equal(result.timedOut, false);
});

// --- the primitive itself -------------------------------------------------

await check('nextFrameOrTimeout reports which one won', async () => {
    const painted = load({ painting: true });
    assert.equal(await painted.api.nextFrameOrTimeout(500), true);
    const dark = load({ painting: false });
    assert.equal(await dark.api.nextFrameOrTimeout(25), false);
});

await check('nextFrameOrTimeout settles exactly once', async () => {
    const { api, rafRequests } = load({ painting: false });
    let settles = 0;
    const p = api.nextFrameOrTimeout(20).then(() => { settles++; });
    await p;
    // Fire the queued rAF late, as a tab being painted again would.
    rafRequests.forEach((cb) => cb(1));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settles, 1, 'a late frame must not re-resolve');
});

await check('hasBox refuses zero and missing elements', async () => {
    const { api } = load({ painting: true });
    assert.equal(api.hasBox(el(10, 10)), true);
    assert.equal(api.hasBox(el(0, 10)), false);
    assert.equal(api.hasBox(el(10, 0)), false);
    assert.equal(api.hasBox(null), false);
});

if (failures) {
    console.error(`\n${failures} assertion group(s) failed`);
    process.exit(1);
}
console.log('\nall ok');
