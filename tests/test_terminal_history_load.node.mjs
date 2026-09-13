// Node test for client/js/terminal-history-load.js - the one-shot load of
// a session's tmux scrollback into xterm, so search has something to
// search.
//
// THE NEGATIVE CONTROLS ARE THE REASON THIS FILE EXISTS. This module
// ERASES THE TERMINAL BUFFER and repaints it. Every one of its refusals
// is protecting something the user cannot get back:
//
//   - the alternate screen: writing `ESC[?1049l` yanks vim or less out
//     from under them;
//   - a stale navigation token: the write would land on the session they
//     moved to and destroy that screen;
//   - a null capture, a shallower capture: nothing to gain, and a
//     shallower one TRADES a long conversation for a single frame, which
//     is the defect terminal-reconnect-buffer.js exists to record;
//   - the write queue: a 1 to 3 MB capture pushed through
//     `TerminalController.enqueue` would shed its oldest chunks and write
//     an "output dropped" marker into the middle of the user's history.
//
// So each of those asserts that NOTHING WAS WRITTEN, and the enqueue spy
// is asserted never to have been touched on any path at all. A module
// that simply never painted would pass those and fail the positive cases
// above them.
//
// Run with: node tests/test_terminal_history_load.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', 'client', 'js');

let failures = 0;
let passes = 0;

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

/** base64 for a node Buffer, so a capture can be built from real text. */
const b64 = (text) => Buffer.from(text, 'binary').toString('base64');

/**
 * Description: a fake xterm recording every write in order, and growing
 *   its baseY the way a real one does when a capture is painted.
 * Inputs: opts (object) - baseY, viewportY, type, contentRows (number of
 *   non-blank visible rows the measurer will find).
 * Output: object - the terminal, with `writes` and `scrolls`.
 */
function makeTerm(opts = {}) {
    const writes = [];
    const scrolls = [];
    const buf = {
        baseY: opts.baseY === undefined ? 0 : opts.baseY,
        viewportY: opts.viewportY === undefined ? 0 : opts.viewportY,
        cursorY: 0,
        length: opts.length === undefined ? 40 : opts.length,
        type: opts.type || 'normal',
        getLine(i) {
            const filled = i < (opts.contentRows === undefined ? 0 : opts.contentRows);
            return { translateToString: () => (filled ? 'content row ' + i : '') };
        },
    };
    return {
        cols: 100,
        rows: 40,
        buffer: { active: buf },
        writes,
        scrolls,
        /** Grow baseY on the capture write, as a real paint would. */
        write(data, cb) {
            writes.push(typeof data === 'string' ? data : 'BYTES:' + data.length);
            if (typeof data !== 'string') buf.baseY += 900;
            if (typeof cb === 'function') cb();
        },
        scrollToLine(line) { scrolls.push(line); },
    };
}

/**
 * Description: one realm holding the modules the loader reaches for,
 *   with a controllable API and a controller carrying an enqueue SPY.
 * Inputs: opts (object) - session (the getSession reply), navToken,
 *   throwOnFetch (boolean).
 * Output: object - {w, api, ctl, enqueueCalls, fetches}.
 */
function loadModules(opts = {}) {
    const fetches = [];
    const enqueueCalls = [];
    const context = {
        console: { log() {}, warn() {}, error() {}, debug() {} },
        Promise, Number, Math, Object, Array, String, JSON, Uint8Array, Buffer,
        setTimeout, clearTimeout,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        document: { querySelector: () => null },
        requestAnimationFrame(fn) { fn(); },
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    for (const f of ['terminal-reconnect-buffer.js', 'terminal-scrollback-paint.js',
        'terminal-history-load.js']) {
        vm.runInContext(fs.readFileSync(path.join(CLIENT_JS, f), 'utf8'),
            context, { filename: f });
    }
    // TerminalScroll and TerminalLayoutWait are absent on purpose in most
    // cases: both are optional and the loader must work without them.
    context.API = {
        async getSession(id, o) {
            fetches.push({ id, opts: o });
            if (opts.throwOnFetch) throw new Error('network down');
            return opts.session === undefined ? {} : opts.session;
        },
    };
    context.TerminalController = {
        _navToken: opts.navToken === undefined ? 7 : opts.navToken,
        fitAddon: { fit() {} },
        _forceScrollToBottom() { context.forcedToBottom = true; },
        enqueue(...args) { enqueueCalls.push(args); },
    };
    context.forcedToBottom = false;
    return { w: context, ctl: context.TerminalController, fetches, enqueueCalls };
}

/** The bytes of a capture, and how many lines it holds. */
const CAPTURE_900 = 'line\n'.repeat(900);

await test('countLines counts newlines and the unterminated final line', () => {
    const { w } = loadModules({});
    const H = w.TerminalHistory;
    assert.equal(H.countLines(new Uint8Array([])), 0);
    assert.equal(H.countLines(null), 0);
    assert.equal(H.countLines(new Uint8Array([65, 10, 66])), 2);
    assert.equal(H.countLines(new Uint8Array([65, 10, 66, 10])), 2);
});

await test('decide paints only a capture DEEPER than the buffer', () => {
    const { w } = loadModules({});
    const H = w.TerminalHistory;
    assert.equal(H.decide({ bufferLines: 40, captureLines: 900 }), 'paint');
    assert.equal(H.decide({ bufferLines: 900, captureLines: 900 }), 'not_deeper');
    assert.equal(H.decide({ bufferLines: 4000, captureLines: 900 }), 'not_deeper');
    assert.equal(H.decide({ bufferLines: 0, captureLines: 900, altScreen: true }),
        'alternate_screen');
});

await test('a first load paints, and ESC[3J precedes the bytes', async () => {
    const { w, fetches, enqueueCalls } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ contentRows: 12 });
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'painted');
    assert.equal(r.lines, 900);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].id, 'ses_a');
    assert.equal(fetches[0].opts.includeScrollback, true);
    assert.equal(fetches[0].opts.cols, 100);
    assert.equal(fetches[0].opts.rows, 40);

    // The reset sequence, then the bytes, and ED 3 inside the reset.
    assert.equal(term.writes.length, 2);
    const reset = term.writes[0];
    assert.ok(reset.indexOf('\x1b[3J') !== -1,
        'a history paint must erase the SAVED lines, or every prompt row '
        + 'inside the overlap is counted twice');
    assert.ok(reset.indexOf('\x1b[3J') < reset.indexOf('\x1b[2J'),
        'ED 3 must come before the viewport erase');
    assert.ok(term.writes[1].startsWith('BYTES:'), 'the bytes go in second');
    assert.equal(enqueueCalls.length, 0,
        'a capture must NEVER go through the live write queue');
});

await test('a second call is "already" and makes no request at all', async () => {
    const { w, fetches } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ contentRows: 12 });
    assert.equal((await w.TerminalHistory.ensureLoaded(term, 'ses_a')).loaded,
        'painted');
    const writesAfterFirst = term.writes.length;
    const second = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(second.loaded, 'already');
    assert.equal(fetches.length, 1, 'the memo must stop the second fetch');
    assert.equal(term.writes.length, writesAfterFirst, 'and the second write');
});

await test('a baseY collapse (term.reset) refetches, which is the whole memo rule', async () => {
    const { w, fetches } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ contentRows: 12 });
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(fetches.length, 1);
    // A reconnect repaint calls term.reset(), which zeroes baseY.
    term.buffer.active.baseY = 0;
    const again = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(again.loaded, 'painted');
    assert.equal(fetches.length, 2);
});

await test('a different session refetches rather than trusting the memo', async () => {
    const { w, fetches } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ contentRows: 12 });
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    await w.TerminalHistory.ensureLoaded(term, 'ses_b');
    assert.equal(fetches.length, 2);
    assert.deepEqual(fetches.map(f => f.id), ['ses_a', 'ses_b']);
});

await test('NEGATIVE CONTROL: the alternate screen writes NOTHING and never fetches', async () => {
    const { w, fetches, enqueueCalls } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ type: 'alternate', contentRows: 12 });
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'unavailable');
    assert.equal(r.reason, 'alternate_screen');
    assert.equal(term.writes.length, 0, 'a TUI must never be repainted under');
    assert.equal(fetches.length, 0);
    assert.equal(enqueueCalls.length, 0);
});

await test('NEGATIVE CONTROL: a null capture writes nothing', async () => {
    const { w, enqueueCalls } = loadModules({
        session: { initial_scrollback_b64: null },
    });
    const term = makeTerm({ contentRows: 12 });
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'unavailable');
    assert.equal(r.reason, 'no_capture');
    assert.equal(term.writes.length, 0);
    assert.equal(enqueueCalls.length, 0);
});

await test('NEGATIVE CONTROL: a navigation during the fetch writes nothing', async () => {
    const { w, ctl, enqueueCalls } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) }, navToken: 7,
    });
    const term = makeTerm({ contentRows: 12 });
    // The user opens another session while the request is in flight.
    const realGet = w.API.getSession;
    w.API.getSession = async (...a) => {
        ctl._navToken = 8;
        return realGet(...a);
    };
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'unavailable');
    assert.equal(r.reason, 'navigated_away');
    assert.equal(term.writes.length, 0,
        'a stale load must never erase the session the user moved to');
    assert.equal(enqueueCalls.length, 0);
});

await test('NEGATIVE CONTROL: a capture shallower than the buffer writes nothing', async () => {
    const { w } = loadModules({
        session: { initial_scrollback_b64: b64('line\n'.repeat(5)) },
    });
    // 300 rows of content already on screen; the capture holds five.
    const term = makeTerm({ baseY: 300, length: 340, contentRows: 40 });
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'already');
    assert.equal(r.reason, 'not_deeper');
    assert.equal(term.writes.length, 0,
        'a single-frame capture must not replace a long conversation');
});

await test('a failed request is unavailable rather than a throw', async () => {
    const { w } = loadModules({ throwOnFetch: true });
    const term = makeTerm({ contentRows: 12 });
    const r = await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(r.loaded, 'unavailable');
    assert.equal(r.reason, 'request_failed');
    assert.equal(term.writes.length, 0);
});

await test('pinned to the bottom, the paint scrolls to the bottom', async () => {
    const { w } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    w.TerminalScroll = { isPinnedToBottom: () => true };
    const term = makeTerm({ baseY: 20, viewportY: 20, contentRows: 12 });
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(w.forcedToBottom, true);
    assert.equal(term.scrolls.length, 0,
        'a pinned terminal uses the controller pin, not a line jump');
});

await test('scrolled up, the DISTANCE from the bottom survives the paint', async () => {
    const { w } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    w.TerminalScroll = { isPinnedToBottom: () => false };
    // Reading 30 rows above the bottom of a 100-deep buffer.
    const term = makeTerm({ baseY: 100, viewportY: 70, contentRows: 12 });
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(w.forcedToBottom, false,
        'a reader must not be yanked to the bottom of a buffer that just grew');
    assert.equal(term.scrolls.length, 1);
    // baseY grew by 900 on the write, so the same distance is 1000 - 30.
    assert.equal(term.scrolls[0], 970);
});

await test('forget() drops the memo so the next call fetches again', async () => {
    const { w, fetches } = loadModules({
        session: { initial_scrollback_b64: b64(CAPTURE_900) },
    });
    const term = makeTerm({ contentRows: 12 });
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    w.TerminalHistory.forget();
    await w.TerminalHistory.ensureLoaded(term, 'ses_a');
    assert.equal(fetches.length, 2);
});

await test('the module stays under the 500-line guideline', () => {
    const lines = fs.readFileSync(
        path.join(CLIENT_JS, 'terminal-history-load.js'), 'utf8').split('\n').length;
    assert.ok(lines < 500,
        `terminal-history-load.js is ${lines} lines, over the 500 limit`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
