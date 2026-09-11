/**
 * Put an existing localStorage-backed control on the shared preference.
 *
 * WHAT THIS IS FOR. #43 and #44 built the server-owned preference block
 * and the client layer over it, and deliberately rewired NO existing
 * control, because moving each one is a behaviour change with its own
 * question about the value already sitting in that browser. #46 answers
 * that question, and this module is the answer applied: two functions, so
 * a control becomes shared by changing its read and its write rather than
 * by growing a preference layer inside itself.
 *
 * THE SHARED VALUE WINS, THE LOCAL ONE IS THE FALLBACK. `read` prefers
 * the server when the preference block was successfully read and the
 * field is actually set there; otherwise the control's own local reader
 * answers exactly as it always did. That ordering is what makes a failed
 * hydration a degradation rather than a reset: a browser that cannot
 * reach the server keeps working off its own copy instead of snapping
 * every control back to a default.
 *
 * `write` MIRRORS, IT DOES NOT MOVE. The value goes to localStorage as
 * well as to the server, every time. Three reasons, and the third is the
 * one that matters:
 *
 *   1. The local copy stays usable when the server is unreachable.
 *   2. The control's synchronous reader still works on the next page load
 *      before hydration has finished, which kills a flash of the default.
 *   3. #46 requires that the local source be RETAINED until the server
 *      confirms. A write that cleared the local copy optimistically would
 *      lose the user's setting on exactly the request that failed.
 *
 * ABSENT IS NOT A DEFAULT, AND THAT IS THE WHOLE RISK HERE. If `read`
 * treated "the server holds nothing" as a value, every control would
 * snap to its default the first time a browser hydrated against a fresh
 * install - and then the next change would save that default over the
 * real settings on every other device. So a field the server does not
 * hold falls through to local, and only an explicit user action ever
 * writes.
 *
 * IT NEVER SAVES ON ITS OWN. There is no read-then-write, no
 * write-back-on-hydrate and no upload of a local value the server has
 * not got. Seeding the server from what a browser happens to hold is the
 * one-time import in client/js/settings-import.js, which is explicit,
 * previewed and pressed by a human.
 */

console.log('[PreferenceBridge Module] Loading...');

(function () {
    /**
     * The shared value for a field, or the control's own local one.
     *
     * Description: prefers the server ONLY when the preference block was
     *   read and actually holds the field. Anything else - no preference
     *   layer, a failed read, a field the server does not hold - falls
     *   through to `localReader`, which is the control's existing
     *   synchronous reader and its existing default behaviour.
     * Inputs:
     *   field (string) - the preference name.
     *   localReader (function) - called with no arguments; returns what
     *     the control would have read before it was bridged.
     * Output: * - the value to use.
     * Example:
     *   PreferenceBridge.read('sidebar_density', loadModeFromStorage)
     */
    function read(field, localReader) {
        const local = () => {
            try {
                return localReader();
            } catch (err) {
                // Deliberately swallowed and re-raised as the caller's
                // problem would be wrong here: the local reader is the
                // FALLBACK, so a fallback that throws must not take the
                // shared value's caller down with it.
                console.warn('[PreferenceBridge] local read failed for ' + field, err);
                return undefined;
            }
        };
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.get !== 'function') return local();
        if (typeof prefs.status === 'function' && prefs.status() !== prefs.HYDRATED) {
            return local();
        }
        const shared = prefs.get(field, undefined);
        if (shared === undefined || shared === null) return local();
        return shared;
    }

    /**
     * Whether the shared record is the thing currently answering.
     *
     * Description: for a control that wants to say where its value came
     *   from, and for a test that needs to tell "the server agrees" from
     *   "the server was not consulted". Those are two different facts and
     *   a control that conflates them cannot explain itself to a user.
     * Inputs: field (string).
     * Output: boolean.
     */
    function isShared(field) {
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.get !== 'function') return false;
        if (typeof prefs.status === 'function' && prefs.status() !== prefs.HYDRATED) {
            return false;
        }
        const shared = prefs.get(field, undefined);
        return shared !== undefined && shared !== null;
    }

    /**
     * Save a deliberate user choice locally AND to the shared record.
     *
     * Description: the local write happens FIRST and unconditionally, so
     *   a server that refuses or is unreachable still leaves the user
     *   with the setting they just chose. CALL THIS ON A COMPLETED USER
     *   ACTION only - never on a resize, an animation frame or a restore
     *   pass, which is the same rule Preferences.set carries.
     * Inputs:
     *   field (string) - the preference name.
     *   value (*) - the new value, in the preference block's shape.
     *   localWriter (function) - called with no arguments; performs the
     *     control's existing local write.
     * Output: Promise<{status: string}> - the preference layer's status,
     *   or `{status: 'local_only'}` when there is no preference layer to
     *   save to. Never rejects: a control's own save must not fail
     *   because a network call did.
     * Example:
     *   await PreferenceBridge.write('sidebar_density', 'compact', save)
     */
    async function write(field, value, localWriter) {
        try {
            localWriter();
        } catch (err) {
            // Deliberately swallowed: the local copy is a convenience
            // and a cache. Losing it is survivable; refusing the shared
            // save because of it would not be.
            console.warn('[PreferenceBridge] local write failed for ' + field, err);
        }
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.set !== 'function') {
            return { status: 'local_only' };
        }
        try {
            return await prefs.set(field, value);
        } catch (err) {
            // Preferences.set answers with a status rather than throwing,
            // so reaching here means something under it broke. The user's
            // value is already applied and already local, which is the
            // state this whole module degrades toward on purpose.
            console.warn('[PreferenceBridge] shared save failed for ' + field, err);
            return { status: 'failed', detail: String(err && err.message ? err.message : err) };
        }
    }

    /**
     * Re-apply a control when its field changes anywhere.
     *
     * Description: subscribes to the preference layer for ONE field, so a
     *   change committed on another device repaints this one. The
     *   callback runs inside the preference layer's applying guard, where
     *   `Preferences.set` refuses, so a control that saves in its own
     *   apply path cannot echo the change back.
     * Inputs:
     *   field (string); apply (function) - called with the new value.
     * Output: function - an unsubscribe, or a no-op when there is
     *   nothing to subscribe to.
     * Example:
     *   PreferenceBridge.follow('sidebar_density', (v) => setModeLocal(v))
     */
    function follow(field, apply) {
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.subscribe !== 'function') return function () {};
        return prefs.subscribe(function (name, value) {
            if (name !== field) return;
            try {
                apply(value);
            } catch (err) {
                // One control throwing must not stop the others being
                // told; the preference layer has already recorded the
                // change either way.
                console.warn('[PreferenceBridge] apply failed for ' + field, err);
            }
        });
    }

    const api = {
        read: read,
        write: write,
        isShared: isShared,
        follow: follow,
    };

    globalThis.PreferenceBridge = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[PreferenceBridge Module] Loaded');
})();
