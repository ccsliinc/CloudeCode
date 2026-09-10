/**
 * TerminalWriteQueue - the admission policy for bytes on their way into
 * xterm, and the words the terminal says when it has to drop some.
 *
 * TWO DEFECTS, AND THEY ARE DIFFERENT.
 *
 * UNBOUNDED. `Terminal#enqueue` pushed every incoming chunk with no size
 * or count limit and `flush()` merged the ENTIRE queue into one
 * `Uint8Array` per animation frame. A session producing sustained output
 * while the browser throttles the tab builds an arbitrarily large array,
 * and there was no admission control anywhere in the path.
 *
 * NOT DISCARDED ON A SWITCH, which is the correctness half. `flush()`
 * writes into `this.term` and re-schedules itself while the queue has
 * anything in it, so bytes that arrived for the OLD session were still
 * being written after navigation began. The `term.reset()` that follows
 * then raced a write xterm had already accepted, which is what produced a
 * half-cleared screen showing the previous session's tail.
 *
 * THE TWO HALVES OF THE QUEUE ARE NOT THE SAME THING, and this is the
 * distinction the teardown turns on. Bytes still in `this.queue` are
 * OURS: nobody has seen them and they belong to the outgoing session, so
 * they are discardable. Bytes already handed to `term.write()` belong to
 * XTERM, and resetting under an accepted write is undefined. So the
 * switch is two steps: discard what is ours, then wait for what is not.
 *
 * DROP FROM THE FRONT, NEVER THE BACK. The newest output is what the user
 * is looking at. A queue that sheds its tail under pressure would throw
 * away the very thing the pressure is producing.
 *
 * DROP WHOLE CHUNKS, NEVER PART OF ONE. Slicing to hit the budget exactly
 * would cut an escape sequence in half, and half an escape sequence does
 * not corrupt one cell - it puts the VT parser into a state that garbles
 * everything after it. Whole chunks are not a guarantee of alignment
 * either (one escape sequence can straddle two WebSocket frames), which
 * is precisely why the drop is ANNOUNCED rather than performed quietly: a
 * terminal that silently loses ANSI bytes is a terminal that lies, and
 * that is worse than a slow one.
 *
 * THE BUDGET IS THE SERVER'S NUMBER. `MAX_QUEUED_BYTES` is 4 MiB, the
 * same ceiling the server-side terminal viewer queues use. One number in
 * the system is worth more than two separately tuned ones, and the point
 * of the bound is to make the worst case FINITE, not to make it fast: 4
 * MiB of Uint8Array is nothing to hold, and what it really caps is how
 * much a throttled tab can accumulate before it is asked to parse it all
 * in one write.
 */

console.log('[TerminalWriteQueue Module] Loading...');

(function () {
    'use strict';

    /**
     * The most unwritten output we will hold for one session, in bytes.
     * 4 MiB, matching the server-side viewer queue ceiling.
     * @type {number}
     */
    var MAX_QUEUED_BYTES = 4 * 1024 * 1024;

    /**
     * Headroom held back so the drop marker itself fits INSIDE the
     * budget. Without it the queue lands a marker's worth over the
     * ceiling on every shed, which is small and is still a bound that
     * does not hold - and a bound that does not hold is a number nobody
     * can reason from. A fixed reserve rather than a second pass,
     * because shedding to make room for the marker could shed the
     * marker. 128 bytes against a marker whose fixed text is 68
     * characters plus at most a 16-digit count, asserted in
     * tests/test_terminal_write_bounds.node.mjs rather than eyeballed.
     * @type {number}
     */
    var MARKER_RESERVE = 128;

    /**
     * Description: what the terminal says in place of the bytes it threw
     *   away. Written INTO the pane buffer rather than raised as a status
     *   pill, deliberately: it marks the position in the stream where the
     *   gap is, which a toast floating over the screen cannot do.
     * Inputs: bytes (number) - how many bytes were dropped.
     * Output: string - a plain, lowercase, self-terminating ANSI line.
     */
    function dropMarker(bytes) {
        return '\r\n\x1b[33m[cloude: dropped ' + bytes
            + ' bytes of output that could not be written in time]\x1b[0m\r\n';
    }

    /**
     * Description: decide how much has to be shed from the FRONT of the
     *   queue to admit an incoming chunk. Pure: measurements in, a number
     *   out, no queue touched and nothing written.
     *   The marker's own reserve is included, so the queue after a shed
     *   is under the ceiling WITH the marker in it.
     * Inputs: queuedBytes (number) - what is already waiting.
     *   incomingBytes (number) - the size of the chunk being offered.
     *   budget (number) - defaults to MAX_QUEUED_BYTES.
     * Output: number - bytes that must be shed. 0 means admit as-is,
     *   which is every call on a working box.
     * Example: overflowBytes(4194304, 10, 4194304) === 138
     */
    function overflowBytes(queuedBytes, incomingBytes, budget) {
        var cap = (typeof budget === 'number' && budget > 0) ? budget : MAX_QUEUED_BYTES;
        var over = (queuedBytes + incomingBytes) - cap;
        return over > 0 ? over + MARKER_RESERVE : 0;
    }

    /**
     * Description: shed whole chunks off the front of a queue until at
     *   least `needed` bytes are gone, and report exactly how many went.
     *   MUTATES the array it is given, which is the point - it is the
     *   queue, and copying it under memory pressure is the last thing
     *   this path should do.
     * Inputs: queue (Array<{length:number}>) - chunks, oldest first.
     *   needed (number) - the shortfall from overflowBytes().
     * Output: number - bytes actually dropped, always >= needed unless
     *   the queue ran out, which is reported honestly rather than
     *   rounded up.
     * Example: shedFront([a10, b10], 5) drops a10 and returns 10.
     */
    function shedFront(queue, needed) {
        var dropped = 0;
        while (queue.length && dropped < needed) {
            dropped += queue.shift().length;
        }
        return dropped;
    }

    window.TerminalWriteQueue = {
        MAX_QUEUED_BYTES: MAX_QUEUED_BYTES,
        MARKER_RESERVE: MARKER_RESERVE,
        dropMarker: dropMarker,
        overflowBytes: overflowBytes,
        shedFront: shedFront
    };
})();

console.log('[TerminalWriteQueue Module] Exported as window.TerminalWriteQueue');
