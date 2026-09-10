// One bounded in-flight xterm write, and the outgoing session's queue
// released on a switch.
// ----------------------------------------------------------------------
// TWO DEFECTS, AND THEY ARE DIFFERENT.
//
// UNBOUNDED. enqueue() pushed every incoming chunk with no size or count
// limit, so a session producing sustained output while the tab is
// throttled built an arbitrarily large array with no admission control
// anywhere in the path.
//
// NOT DISCARDED ON A SWITCH, which is the correctness half. flush()
// re-scheduled itself while the queue had anything in it, so bytes that
// arrived for the OLD session were still being written after navigation
// began, and the term.reset() that followed raced a write xterm had
// already accepted. That is the half-cleared screen showing the previous
// session's tail.
//
// THE TWO HALVES OF THE QUEUE ARE NOT THE SAME THING, and the teardown
// case below is really pinning that: bytes still in this.queue are ours
// and are discardable, bytes already handed to term.write() belong to
// xterm and must be allowed to finish. A test that only asserted "the
// queue was emptied" would pass against a reset fired straight under an
// accepted write, which is the undefined behaviour this exists to stop.
//
// This drives the SHIPPED client/js/terminal.js methods against a
// recording fake xterm whose write callback the TEST decides when to
// fire, because "did the reset wait" is a question about ORDER and no
// amount of real-time waiting can answer it deterministically.
//
// Run with: node --test tests/test_terminal_write_bounds.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const QUEUE_SRC = read('client/js/terminal-write-queue.js');
const TERM_SRC = read('client/js/terminal.js');
const INDEX_HTML = read('client/index.html');
const TERM_SINGLETON = 'window.TerminalController = new Terminal();';

/**
 * Description: a sandbox holding the shipped queue policy module.
 * Inputs: none. Output: vm context.
 */
function makeSandbox() {
    const sandbox = {
        window: {},
        document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout, clearTimeout, Promise, TextEncoder, TextDecoder,
        Uint8Array,
        requestAnimationFrame: (fn) => { fn(); return 1; },
        WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.WebSocket = sandbox.WebSocket;
    vm.createContext(sandbox);
    vm.runInContext(QUEUE_SRC, sandbox, { filename: 'terminal-write-queue.js' });
    if (!sandbox.window.TerminalWriteQueue) {
        throw new Error('terminal-write-queue.js did not export itself');
    }
    return sandbox;
}

/**
 * Description: the shipped Terminal class, minus its singleton line.
 * Inputs: sandbox. Output: class.
 */
function loadTerminalClass(sandbox) {
    const cut = TERM_SRC.indexOf(TERM_SINGLETON);
    if (cut === -1) throw new Error('terminal.js no longer ends with its singleton line');
    vm.runInContext(
        TERM_SRC.slice(0, cut) + '\nwindow.__TerminalClass = Terminal;',
        sandbox, { filename: 'terminal.js' });
    return sandbox.window.__TerminalClass;
}

/**
 * Description: a `this` carrying exactly what enqueue/flush/release read,
 *   with an xterm whose write callback the TEST fires.
 * Inputs: none.
 * Output: {self, term, sandbox}.
 */
function makeController() {
    const sandbox = makeSandbox();
    const Klass = loadTerminalClass(sandbox);
    const P = Klass.prototype;
    for (const name of ['enqueue', 'flush', '_releaseQueueForSwitch']) {
        if (typeof P[name] !== 'function') {
            throw new Error(`terminal.js has no ${name}() any more`);
        }
    }
    const term = {
        written: [],
        pendingCallback: null,
        resets: 0,
        write(data, cb) { this.written.push(data); this.pendingCallback = cb || null; },
        reset() { this.resets += 1; },
        scrollToBottom() {},
    };
    const self = {
        term,
        queue: [],
        flushing: false,
        _queuedBytes: 0,
        _writeInFlight: false,
        _writeDrained: null,
        autoScrollEnabled: true,
        enqueue: P.enqueue,
        flush: P.flush,
        _releaseQueueForSwitch: P._releaseQueueForSwitch,
    };
    // enqueue schedules through the sandbox's rAF, which runs the flush
    // immediately, so the queue's own scheduling is exercised rather than
    // reimplemented here.
    sandbox.requestAnimationFrame = (fn) => { fn.call(self); return 1; };
    return { self, term, sandbox, P };
}

/** Description: n bytes. Inputs: n. Output: Uint8Array. */
const chunk = (n, fill) => new Uint8Array(n).fill(fill == null ? 65 : fill);

/** Description: decode a written Uint8Array. Inputs: u8. Output: string. */
const asText = (u8) => new TextDecoder().decode(u8);

// -------------------------------------------------------- the policy

test('overflowBytes reports the shortfall and nothing else', () => {
    const { window: w } = makeSandbox();
    const Q = w.TerminalWriteQueue;
    assert.equal(Q.overflowBytes(0, 10), 0, 'the ordinary case admits as-is');
    // The shortfall PLUS the marker's reserve, because the marker itself
    // has to fit inside the budget or the bound does not hold.
    assert.equal(Q.overflowBytes(Q.MAX_QUEUED_BYTES, 10), 10 + Q.MARKER_RESERVE);
    assert.equal(Q.overflowBytes(Q.MAX_QUEUED_BYTES - 4, 10), 6 + Q.MARKER_RESERVE);
});

test('the marker always fits inside its own reserve', () => {
    // The reserve is a fixed number and the marker carries a byte count,
    // so this is the assertion that keeps the two from drifting apart.
    const { window: w } = makeSandbox();
    const Q = w.TerminalWriteQueue;
    const longest = Q.dropMarker(Number.MAX_SAFE_INTEGER);
    assert.ok(new TextEncoder().encode(longest).length <= Q.MARKER_RESERVE,
        `marker is ${longest.length} bytes against a ${Q.MARKER_RESERVE} reserve`);
});

test('the budget is 4 MiB, the same number the server-side viewer queues use', () => {
    const { window: w } = makeSandbox();
    assert.equal(w.TerminalWriteQueue.MAX_QUEUED_BYTES, 4 * 1024 * 1024,
        'one number in the system beats two separately tuned ones');
});

test('shedFront drops the OLDEST chunks and reports what really went', () => {
    const { window: w } = makeSandbox();
    const q = [chunk(10, 1), chunk(10, 2), chunk(10, 3)];
    const dropped = w.TerminalWriteQueue.shedFront(q, 15);
    assert.equal(dropped, 20, 'whole chunks only - a sliced escape sequence '
        + 'garbles everything after it, which is worse than a bigger gap');
    assert.equal(q.length, 1);
    assert.equal(q[0][0], 3, 'the NEWEST chunk survives - it is what the user is looking at');
});

test('shedFront on an exhausted queue reports honestly rather than rounding up', () => {
    const { window: w } = makeSandbox();
    const q = [chunk(4)];
    assert.equal(w.TerminalWriteQueue.shedFront(q, 100), 4);
    assert.equal(q.length, 0);
});

test('the marker names the byte count and is plain lowercase copy', () => {
    const { window: w } = makeSandbox();
    const m = w.TerminalWriteQueue.dropMarker(1234);
    assert.match(m, /1234 bytes/);
    assert.match(m, /^\r\n\x1b\[33m\[cloude: /);
    assert.match(m, /\x1b\[0m\r\n$/, 'it must close its own colour and its own line');
});

// ------------------------------------------------------ the queue

test('POSITIVE CONTROL: ordinary output is written, merged once per frame', () => {
    const { self, term } = makeController();
    self.enqueue(chunk(3, 1));
    assert.equal(term.written.length, 1,
        'the control is blind if nothing is written at all');
    assert.equal(term.written[0].length, 3);
    assert.equal(self.queue.length, 0);
});

test('two chunks in one frame become ONE write, so xterm parses once', () => {
    const { self, term, sandbox } = makeController();
    // Hold the frame so both chunks land before the flush runs.
    let frame = null;
    sandbox.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    self.enqueue(chunk(3, 1));
    self.enqueue(chunk(4, 2));
    assert.equal(term.written.length, 0, 'nothing written until the frame');
    frame.call(self);
    assert.equal(term.written.length, 1, 'one write, not two');
    assert.equal(term.written[0].length, 7);
});

test('an overflow drops from the FRONT and writes exactly one marker', () => {
    const { self, term, sandbox } = makeController();
    let frame = null;
    sandbox.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    const budget = sandbox.window.TerminalWriteQueue.MAX_QUEUED_BYTES;
    const half = Math.floor(budget / 2);
    self.enqueue(chunk(half, 1));      // oldest
    self.enqueue(chunk(half, 2));      // now exactly at budget
    self.enqueue(chunk(16, 3));        // must shed
    frame.call(self);
    const text = asText(term.written[0]);
    assert.match(text, /\[cloude: dropped \d+ bytes of output/,
        'a drop that is not announced makes the terminal lie');
    assert.equal((text.match(/\[cloude: dropped/g) || []).length, 1,
        'exactly one marker, not one per shed chunk');
    // The oldest chunk's bytes are gone; the newest are present.
    assert.ok(!term.written[0].includes(1),
        'the oldest chunk must be the one that went');
    assert.ok(term.written[0].includes(3),
        'and the newest output must survive - dropping the tail would '
        + 'throw away the very thing the pressure is producing');
});

test('the queue never exceeds the budget, however hard it is pushed', () => {
    const { self, sandbox } = makeController();
    sandbox.requestAnimationFrame = () => 1;   // never flush
    const budget = sandbox.window.TerminalWriteQueue.MAX_QUEUED_BYTES;
    for (let i = 0; i < 40; i += 1) self.enqueue(chunk(Math.floor(budget / 4)));
    assert.ok(self._queuedBytes <= budget,
        `queued ${self._queuedBytes} bytes against a ${budget} budget`);
    let real = 0;
    for (const c of self.queue) real += c.length;
    assert.equal(real, self._queuedBytes,
        'the running total must equal the queue, or the bound is measuring '
        + 'a number that has drifted away from the thing it caps');
});

test('with the policy module missing, the queue is unbounded as before', () => {
    // A load-order accident must degrade to the shipped behaviour, not
    // to a terminal that drops output it could have written.
    const { self, sandbox } = makeController();
    delete sandbox.window.TerminalWriteQueue;
    sandbox.requestAnimationFrame = () => 1;
    for (let i = 0; i < 8; i += 1) self.enqueue(chunk(1024 * 1024));
    assert.equal(self.queue.length, 8);
});

// ------------------------------------------- the switch, in two steps

test('THE DECISIVE CASE: a switch discards our bytes and waits for xterm\'s', async () => {
    const { self, term, sandbox } = makeController();
    let frame = null;
    sandbox.requestAnimationFrame = (fn) => { frame = fn; return 1; };

    self.enqueue(chunk(10, 1));
    frame.call(self);                 // one write is now IN FLIGHT
    assert.equal(self._writeInFlight, true);
    self.enqueue(chunk(10, 2));       // and more bytes queue behind it
    assert.equal(self.queue.length, 1);

    let released = false;
    const release = self._releaseQueueForSwitch().then(() => { released = true; });

    assert.equal(self.queue.length, 0,
        'the outgoing session\'s unwritten bytes are OURS and go immediately');
    assert.equal(self._queuedBytes, 0);
    await Promise.resolve();
    assert.equal(released, false,
        'but the switch must NOT proceed while a write xterm has already '
        + 'accepted is outstanding - resetting under one is undefined');

    term.pendingCallback();           // xterm finishes
    await release;
    assert.equal(released, true, 'and it proceeds the moment that write lands');
});

test('a SECOND switch releases the first one\'s wait rather than orphaning it', async () => {
    // There is one resolver slot. Overwriting it would leave the earlier
    // teardown parked on a promise nobody can settle - a session switch
    // hung forever, on exactly the rapid double-switch this chain exists
    // to make safe.
    const { self, term, sandbox } = makeController();
    let frame = null;
    sandbox.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    self.enqueue(chunk(10, 1));
    frame.call(self);
    assert.equal(self._writeInFlight, true);

    let firstDone = false;
    const first = self._releaseQueueForSwitch().then(() => { firstDone = true; });
    await Promise.resolve();
    assert.equal(firstDone, false, 'the first switch is waiting');

    const second = self._releaseQueueForSwitch();
    await first;
    assert.equal(firstDone, true,
        'the superseded switch must be released, not stranded');
    term.pendingCallback();
    await second;
});

test('a switch with nothing in flight does not wait at all', async () => {
    const { self } = makeController();
    self.enqueue(chunk(4));           // flushes and completes? no - callback pending
    self._writeInFlight = false;      // simulate the callback having fired
    let released = false;
    await self._releaseQueueForSwitch().then(() => { released = true; });
    assert.equal(released, true,
        'the ordinary switch must not pay for a wait it does not need');
});

test('both entry paths release the queue BEFORE they reset, and only on a real swap', () => {
    // Order is the whole claim, and a source read is how it is pinned:
    // instantiating a real TerminalController against a live xterm and a
    // real pty is not practical here, which is the established pattern
    // for this file (see tests/test_terminal_layout.node.mjs).
    const src = TERM_SRC;
    const hits = [...src.matchAll(/paintPlan !== 'keep'\)\s*\{([\s\S]{0,900}?)this\.term\.reset\(\)/g)];
    assert.equal(hits.length, 2,
        'connectToSession and reconnectToExistingSession both do this');
    for (const h of hits) {
        assert.match(h[1], /await this\._releaseQueueForSwitch\(\);/,
            'the release must sit between the guard and the reset');
    }
    // A 'keep' plan is the SAME session and its bytes are still its own.
    assert.equal((src.match(/_releaseQueueForSwitch/g) || []).length, 3,
        'two calls plus the one definition - a third call site would mean '
        + 'something is discarding a session\'s own output');
});

test('the in-flight fact is cleared in exactly one place outside the constructor', () => {
    // A second clear would let a switch wait forever on a resolver
    // nobody calls, or proceed while a write is still outstanding. The
    // constructor's initialiser is not a clear and is excluded by name.
    const ctorEnd = TERM_SRC.indexOf('    async init() {');
    assert.ok(ctorEnd > 0, 'terminal.js no longer opens with a constructor then init()');
    const afterCtor = TERM_SRC.slice(ctorEnd);
    const clears = (afterCtor.match(/this\._writeInFlight = false/g) || []).length;
    assert.equal(clears, 1, `_writeInFlight is cleared in ${clears} places`);
    assert.equal((TERM_SRC.slice(0, ctorEnd).match(/this\._writeInFlight = false/g) || []).length, 1,
        'and the constructor still initialises it');
});

test('the follow decision is still sampled BEFORE the write', () => {
    // terminal-scroll.js documents why a flag mutated by a debounced
    // scroll listener always lost that race. The bound must not have
    // moved the sample.
    const flush = TERM_SRC.slice(TERM_SRC.indexOf('    flush() {'));
    const body = flush.slice(0, flush.indexOf('\n    }'));
    assert.ok(body.indexOf('shouldFollowOutput') < body.indexOf('this.term.write('),
        'the viewport position must be read before the write, not after');
});

test('index.html serves the policy module before terminal.js', () => {
    const order = [...INDEX_HTML.matchAll(/\/static\/js\/([A-Za-z0-9._\-/]+\.js)/g)]
        .map((m) => m[1]);
    assert.ok(order.indexOf('terminal-write-queue.js') >= 0,
        'the module must be in index.html or it is dead code');
    assert.ok(order.indexOf('terminal-write-queue.js') < order.indexOf('terminal.js'));
});
