/**
 * Toast version arbitration - issue #39's client half.
 * ----------------------------------------------------------------------
 * A pure standalone module, deliberately not a ToastManager method: it
 * has no dependency on `class ToastManager` and none on it, so - like
 * client/js/toast-render-batch.js and client/js/toast-session-group.js
 * beside it - it carries NO ORDER REQUIREMENT relative to toast.js or
 * anything else here. client/js/toast-lifecycle.js reads it off
 * `window.ToastVersionArbitration` at CALL time, not at parse time, the
 * same way toast-render.js reads `ToastSessionGroup`.
 *
 * WHAT PROBLEM THIS SOLVES. `ToastManager.add()` (toast-lifecycle.js)
 * handles a known toast id by overwriting whatever it holds with
 * whatever just arrived, unconditionally - correct for the case that
 * code was written for (the server superseding an unacked `Stop` in
 * place, so the same id legitimately carries newer content on its next
 * arrival). It is WRONG once "arrives again" stops meaning "arrives
 * newest": CLAUDE.md - "Hook events arrive unordered, and may be
 * duplicated or dropped" - so the same id can reach this browser via two
 * different transports (the `toast.new` WS frame and the cross-session
 * poll) in either order, and a duplicated OLDER frame landing after a
 * newer one was already applied must not regress the card the user is
 * looking at.
 *
 * THE RULE IS THE ONE THIS CODEBASE ALREADY WROTE DOWN, copied rather
 * than reinvented: client/js/preferences.js applies a `preferences.changed`
 * frame "only when its revision is strictly HIGHER than the one held",
 * because "the revision moves only on a real change" and "a no-op does
 * not make every client refresh for nothing" (CLAUDE.md). The server
 * half is symmetric: `SessionManager.record_toast` bumps `Toast.version`
 * only when a superseded record's content actually differs, and
 * `SessionManager.ack_toast` bumps it once on the acked transition,
 * guarded by the same check that makes that method idempotent against a
 * duplicated ack. So the same fact delivered twice always carries the
 * same version, and this file only has to compare integers - never
 * content, never a timestamp (two hook events can share a millisecond).
 *
 * ABSENT IS NOT A DEFAULT. A toast can carry no `version` for two
 * reasons: it came from a server built before this field existed, or it
 * was never a server record at all - client/js/attachment-toast.js mints
 * its own ids in this browser and has no ordering counter to offer.
 * Neither case carries ordering information, so `undefined`/`null` must
 * never be read as version 0. Doing that would let a genuinely NEWER
 * record from a version-aware server be discarded as "older than
 * nothing" the moment the held copy predates the field, and would make
 * every re-raise from an older server look like a downgrade of its own
 * predecessor - silently freezing every toast on the first thing it
 * said. A version missing on EITHER side therefore falls back to
 * exactly the behavior `add()` had before this field existed: always
 * replace. That is a DELIBERATE widening of "when in doubt, replace",
 * not a gap - the failure mode of over-replacing is a wasted render,
 * the same one issue #39 is about; the failure mode of treating absent
 * as zero is a stuck card, which is worse.
 */
(function (global) {
    /**
     * Decide whether an incoming record with a KNOWN id should replace
     * the one already held under that id.
     *
     * Inputs: held (object|null|undefined) - the record currently
     *   stored. incoming (object|null|undefined) - the record just
     *   received for the same id.
     * Output: boolean - true when `incoming` should replace `held`.
     * Example: shouldReplace({version:1}, {version:2}) -> true
     * Example: shouldReplace({version:2}, {version:1}) -> false
     */
    function shouldReplace(held, incoming) {
        const heldVersion = held ? held.version : undefined;
        const incomingVersion = incoming ? incoming.version : undefined;
        if (heldVersion === undefined || heldVersion === null
            || incomingVersion === undefined || incomingVersion === null) {
            return true;
        }
        return incomingVersion > heldVersion;
    }

    const api = { shouldReplace: shouldReplace };

    global.ToastVersionArbitration = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[ToastVersionArbitration Module] Exported as window.ToastVersionArbitration');
