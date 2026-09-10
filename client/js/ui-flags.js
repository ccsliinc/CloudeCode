/**
 * UI flags - the owner's own show/hide switches, read once per page load.
 *
 * WHAT THIS IS AND IS NOT. `client/js/archive-entry.js` gates an entire
 * SUBSYSTEM off `GET /api/v1/features` and has to keep three states
 * apart, because a message archive can be off, on, or on-but-not-mounted.
 * These flags are a different kind of thing: plain booleans on the same
 * endpoint, one per surface, describing what the owner asked to see. They
 * are read through the same probe for the same reason - one round trip
 * per page load, not one per render.
 *
 * A FAILED READ NEVER HIDES ANYTHING. Every flag here defaults to ON,
 * because every one of them switches OFF a control that ships. A probe
 * that could not run, an older server that does not send the block, an
 * unparseable config on the server side: all three leave the control
 * exactly where the user last saw it. Turning "I could not tell" into
 * "hide it" is how a capability disappears without anyone deciding to
 * remove it.
 *
 * READS ARE SYNCHRONOUS, THE PROBE IS NOT. Row rendering cannot await
 * anything, so `showMarkUnreadControl()` answers from a cached value that
 * starts at the default and is corrected when the probe lands. The
 * sidebar and the launchpad both repaint on their own poll, so a flag set
 * to false reaches the screen within one poll of page load rather than
 * instantly. That is the cost of not blocking the first paint on a
 * network round trip, and it is only ever visible for the state that
 * shows MORE than the user asked for, never less.
 */

console.log('[UIFlags Module] Loading...');

(function () {
    /** @type {string} The endpoint carrying the flags. */
    const FEATURES_PATH = '/features';

    /**
     * Current values. Seeded with the DEFAULTS, which are the shipped
     * behaviour of every control here, so this object is a correct
     * answer before anything is measured.
     * @type {Object<string, boolean>}
     */
    const _flags = {
        show_mark_unread_control: true,
    };

    /** @type {Promise|null} The one in-flight or settled probe. */
    let _probe = null;

    /**
     * Fold the server's `ui` block into the cached flags.
     *
     * Description: only a real boolean is taken. A missing key, a null,
     *   or a string leaves the default in place - an older server sends
     *   no `ui` block at all, and that must read as "everything shown",
     *   not as "everything off".
     * Inputs: block (Object|null) - the `ui` object from the response.
     * Output: void.
     * Example: _apply({show_mark_unread_control: false})
     */
    function _apply(block) {
        if (!block || typeof block !== 'object') return;
        const keys = Object.keys(_flags);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (typeof block[k] === 'boolean') _flags[k] = block[k];
        }
    }

    /**
     * Probe the server once per page load.
     *
     * Description: idempotent - every caller after the first gets the
     *   same promise. A failure is swallowed deliberately (the flags stay
     *   at their defaults, which is the documented behaviour) and logged
     *   rather than rethrown, because no caller of this module can do
     *   anything useful with the error.
     * Inputs: none.
     * Output: Promise<Object> - the cached flag map, after the probe.
     * Example: window.UIFlags.ensure().then(function (f) { ... });
     */
    function ensure() {
        if (_probe) return _probe;
        if (!window.API || typeof window.API.call !== 'function') {
            _probe = Promise.resolve(_flags);
            return _probe;
        }
        _probe = window.API.call(FEATURES_PATH)
            .then(function (data) {
                _apply(data && data.ui);
                return _flags;
            })
            .catch(function (err) {
                console.warn('[UIFlags] flags left at their defaults: ' +
                             (err && err.message ? err.message : String(err)));
                return _flags;
            });
        return _probe;
    }

    /**
     * Whether the manual mark-unread toggle should be rendered.
     *
     * Description: SYNCHRONOUS, so a row renderer can call it inline.
     *   Answers the default (true) until the probe lands. Backed by
     *   `ui.show_mark_unread_control` in config.json - see
     *   src/config.py::UIConfig for why the control and the LED's unread
     *   ring are two different things and only one of them is optional.
     * Inputs: none.
     * Output: boolean.
     * Example: if (UIFlags.showMarkUnreadControl()) { ... }
     */
    function showMarkUnreadControl() {
        return _flags.show_mark_unread_control !== false;
    }

    const api = {
        ensure: ensure,
        showMarkUnreadControl: showMarkUnreadControl,
    };

    globalThis.UIFlags = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[UIFlags Module] Loaded');
})();
