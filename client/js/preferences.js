/**
 * The client's copy of the server-owned `ui_preferences` block.
 *
 * HYDRATE BEFORE ANY PREFERENCE-DEPENDENT CONTROL INITIALISES. A control
 * that starts on its default and is corrected a moment later flashes;
 * worse, a control that SAVES its default on initialisation overwrites
 * the user's real setting with a default. So `get()` answers `undefined`
 * until hydration has run, and `set()` REFUSES while the read has not
 * succeeded - a failed read must never cause a default to be saved over
 * a real setting.
 *
 * A RECEIVED CHANGE MUST NEVER GENERATE A SAVE ECHO, or two browsers
 * ping-pong forever. `applyRemote()` sets a flag for the duration of the
 * listener fan-out and `set()` refuses while it is up, so a control that
 * naively re-saves what it was just handed is stopped at this layer
 * rather than in every control.
 *
 * THE REVISION IS THE ONLY ORDERING THIS NEEDS. An event is applied ONLY
 * when its revision is HIGHER than the one held. That one rule survives
 * everything this project already knows about unreliable event streams:
 * the same frame twice is an equal revision and ignored, a reordered
 * pair has the older one lower and ignored, and a dropped frame is
 * closed by the next higher one or by the next authoritative refresh. It
 * is a fold over a number, not an increment, so it needs no delivery
 * guarantee from the socket.
 *
 * EVENTS ARE AN OPTIMISATION. `hydrate()` is the source of truth and is
 * called on startup and on reconnect. This browser holds a socket to at
 * most one session, so a screen with no terminal open receives NO events
 * at all and depends entirely on that refresh - which is why the refresh
 * is the thing that has to be right.
 *
 * EVERY FIELD HAS A STATE, AND PENDING IS NOT COMMITTED. A deliberate
 * choice is applied locally at once so the control feels immediate, and
 * reported as `pending` until the server says otherwise. A failure keeps
 * the user's value visible and marks the field `failed`, with the
 * committed value still retrievable, so a retry is possible and the two
 * are never confused for one another.
 *
 * A CONFLICT IS NOT RESOLVED HERE. When a stale-revision refusal or a
 * remote change lands on a field the user has edited but not saved, the
 * field goes `conflict` and BOTH values are kept. Silently dropping
 * either side is how a user loses a setting they watched themselves
 * change.
 */

console.log('[Preferences Module] Loading...');

(function () {
    /** @type {string} Hydration has not run. Nothing may be saved. */
    const NOT_HYDRATED = 'not_hydrated';

    /** @type {string} The block was read; values are authoritative. */
    const HYDRATED = 'hydrated';

    /** @type {string} A read was attempted and failed. Saving stays
     * refused: writing now would push this browser's defaults over
     * settings we were unable to see. */
    const READ_FAILED = 'read_failed';

    /** @type {string} This field matches what the server committed. */
    const COMMITTED = 'committed';

    /** @type {string} The user changed it; the save is in flight. */
    const PENDING = 'pending';

    /** @type {string} The save was attempted and did not land. The
     * user's value is still on screen and can be retried. */
    const FAILED = 'failed';

    /** @type {string} A newer committed value arrived for a field this
     * browser has an unsaved edit on. Both are kept. */
    const CONFLICT = 'conflict';

    /** Endpoint path, relative to the API client's own base. */
    const ENDPOINT = '/preferences';

    /**
     * An opaque per-page id echoed back on the broadcast so this browser
     * can recognise its own event. Not identity, not trusted, and never
     * sent anywhere but this endpoint.
     * @type {string}
     */
    const clientId = 'c' + Math.random().toString(36).slice(2, 12);

    /** @type {{status: string, revision: number, values: object}} */
    const held = { status: NOT_HYDRATED, revision: 0, values: {} };

    /**
     * Per-field save state, plus what the server last committed for a
     * field the user has since edited.
     * @type {Object<string, {state: string, local: *, committed: *}>}
     */
    const fields = Object.create(null);

    /** @type {Array<function(string, *, object): void>} */
    const listeners = [];

    /**
     * True while a received change is being applied. `set()` refuses
     * during it, which is what stops the echo.
     * @type {boolean}
     */
    let applyingRemote = false;

    /**
     * Read one preference.
     *
     * Description: answers from memory. Never fetches, so it is safe on
     *   a render path.
     * Inputs:
     *   name (string) - the preference field name.
     *   fallback (*) - what to return when the field is unset, or when
     *     hydration has not run or failed. Defaults to undefined.
     * Output: * - the local value if the user has an unsaved edit,
     *   otherwise the committed one, otherwise the fallback.
     * Example: Preferences.get('sidebar_density', 'cozy')
     */
    function get(name, fallback) {
        const record = fields[name];
        if (record && (record.state === PENDING || record.state === FAILED
                       || record.state === CONFLICT)) {
            return record.local;
        }
        if (held.status !== HYDRATED) return fallback;
        if (Object.prototype.hasOwnProperty.call(held.values, name)) {
            return held.values[name];
        }
        return fallback;
    }

    /**
     * What the server last committed for a field, ignoring local edits.
     *
     * Description: the other half of a conflict. A UI showing "your
     *   change" beside "what is saved" reads this for the second one.
     * Inputs: name (string).
     * Output: * - the committed value, or undefined.
     */
    function committedValue(name) {
        const record = fields[name];
        if (record && record.state === CONFLICT) return record.committed;
        return held.values[name];
    }

    /**
     * The save state of one field.
     *
     * Inputs: name (string).
     * Output: string - COMMITTED, PENDING, FAILED or CONFLICT.
     */
    function stateFor(name) {
        const record = fields[name];
        return record ? record.state : COMMITTED;
    }

    /**
     * Whether hydration has run, and how it went.
     *
     * Inputs: none.
     * Output: string - NOT_HYDRATED, HYDRATED or READ_FAILED.
     */
    function status() {
        return held.status;
    }

    /**
     * The revision this browser believes is current.
     *
     * Inputs: none.
     * Output: number - 0 before hydration and for a fresh install.
     */
    function revision() {
        return held.revision;
    }

    /**
     * Fetch the whole block from the server. THE AUTHORITATIVE REFRESH.
     *
     * Description: called once at startup before preference-dependent
     *   controls initialise, and again on reconnect. SERVER VALUES WIN:
     *   a committed field is replaced outright. A field with an unsaved
     *   local edit is NOT silently discarded - it becomes a conflict the
     *   user can resolve, because dropping an edit the user watched
     *   themselves make is the failure this whole design is avoiding.
     *   A FAILED READ CHANGES NOTHING and leaves saving refused.
     * Inputs: api (object|undefined) - the API client; defaults to the
     *   global one. Must expose `call(path, options)`.
     * Output: Promise<string> - the resulting status.
     * Example: await Preferences.hydrate();
     */
    async function hydrate(api) {
        const client = api || globalThis.api;
        if (!client || typeof client.call !== 'function') {
            held.status = READ_FAILED;
            return held.status;
        }
        let body;
        try {
            body = await client.call(ENDPOINT);
        } catch (err) {
            // Deliberately swallowed: a preferences read that fails must
            // leave the app usable on its own defaults. What it must NOT
            // do is let anything be saved afterwards, which is why the
            // status is recorded rather than the error rethrown.
            console.warn('[Preferences] hydrate failed', err);
            held.status = READ_FAILED;
            return held.status;
        }
        adoptServerState(body, { authoritative: true });
        held.status = HYDRATED;
        return held.status;
    }

    /**
     * Apply a deliberate user choice locally, then save it.
     *
     * Description: the value is applied to the local view IMMEDIATELY so
     *   the control responds, marked PENDING, and PATCHed with the
     *   revision this browser holds. Persistence is confirmed only when
     *   the server commits. CALL THIS ON A COMPLETED USER ACTION, never
     *   on a resize, an animation frame or a pointer move.
     * Inputs:
     *   name (string) - the preference field.
     *   value (*) - the new value; null unsets the field.
     *   api (object|undefined) - the API client, defaulting to the
     *     global one.
     * Output: Promise<{status: string, detail: (string|undefined)}> -
     *   `committed`, `unchanged`, `stale_revision`, `failed`, or
     *   `refused` when the module is not in a state that may write.
     * Example: await Preferences.set('sidebar_density', 'compact');
     */
    async function set(name, value, api) {
        if (applyingRemote) {
            // The echo guard. A control that re-saves what it was just
            // handed is stopped here rather than in every control.
            return { status: 'refused', detail: 'applying a received change' };
        }
        if (held.status !== HYDRATED) {
            return { status: 'refused', detail: 'preferences have not been read yet' };
        }
        const client = api || globalThis.api;
        if (!client || typeof client.call !== 'function') {
            return { status: 'refused', detail: 'no api client' };
        }

        const previouslyCommitted = held.values[name];
        fields[name] = { state: PENDING, local: value, committed: previouslyCommitted };
        notify(name, value, fields[name]);

        let body;
        try {
            body = await client.call(ENDPOINT, {
                method: 'PATCH',
                // A 409 here is another device having got there first,
                // which is a negative ANSWER this code handles, not a
                // fault. Declaring it keeps it out of the error log.
                expectedStatuses: [409],
                body: {
                    changes: { [name]: value },
                    expected_revision: held.revision,
                    client_id: clientId,
                },
            });
        } catch (err) {
            const conflict = conflictBodyFrom(err);
            if (conflict) {
                // The server refused because somebody else committed
                // first. Take its state, and keep the user's unsaved
                // choice visible beside it rather than dropping either.
                adoptServerState(conflict, { authoritative: true });
                markConflict(name, value);
                return { status: 'stale_revision', detail: conflict.detail };
            }
            fields[name] = {
                state: FAILED, local: value, committed: previouslyCommitted,
            };
            notify(name, value, fields[name]);
            return { status: 'failed', detail: String(err && err.message ? err.message : err) };
        }

        adoptServerState(body, { authoritative: true });
        delete fields[name];
        notify(name, held.values[name], { state: COMMITTED });
        return { status: body && body.status ? body.status : 'committed' };
    }

    /**
     * Apply a `preferences.changed` frame from another client.
     *
     * Description: IDEMPOTENT AND ORDER-FREE. A frame is applied only
     *   when its revision is strictly higher than the one held, so the
     *   same frame twice, a reordered pair and a dropped frame all
     *   resolve correctly without the socket promising anything. This
     *   browser's OWN event is skipped by `origin_client_id`. While the
     *   listeners run, `set()` refuses, so applying a change can never
     *   generate a save.
     * Inputs: frame (object) - the decoded WebSocket message.
     * Output: boolean - whether anything was applied.
     * Example: Preferences.applyRemote(message);
     */
    function applyRemote(frame) {
        if (!frame || typeof frame !== 'object') return false;
        if (frame.origin_client_id && frame.origin_client_id === clientId) return false;

        const nextRevision = Number(frame.revision);
        if (!Number.isFinite(nextRevision) || nextRevision <= held.revision) {
            // A duplicate, a reorder, or a frame this browser already
            // has. Not an error, and deliberately silent.
            return false;
        }
        const changed = frame.changed && typeof frame.changed === 'object'
            ? frame.changed
            : {};

        held.revision = nextRevision;
        applyingRemote = true;
        try {
            Object.keys(changed).forEach(function (name) {
                const value = changed[name];
                if (value === null) {
                    delete held.values[name];
                } else {
                    held.values[name] = value;
                }
                const record = fields[name];
                if (record && (record.state === PENDING || record.state === FAILED)) {
                    markConflict(name, record.local);
                    return;
                }
                if (!record || record.state !== CONFLICT) {
                    notify(name, value, { state: COMMITTED });
                }
            });
        } finally {
            applyingRemote = false;
        }
        return true;
    }

    /**
     * Retry a field whose save failed, or whose conflict the user keeps.
     *
     * Description: re-sends the LOCAL value against the revision this
     *   browser now holds, which is the point of keeping the two apart:
     *   the retry knows what the user wanted and what the server has.
     * Inputs: name (string); api (object|undefined).
     * Output: Promise<{status: string}> - as `set()`, or `refused` when
     *   the field has nothing to retry.
     */
    async function retry(name, api) {
        const record = fields[name];
        if (!record || record.state === COMMITTED) {
            return { status: 'refused', detail: 'nothing to retry' };
        }
        const value = record.local;
        delete fields[name];
        return await set(name, value, api);
    }

    /**
     * Abandon a local edit and keep what the server committed.
     *
     * Inputs: name (string).
     * Output: undefined.
     */
    function discardLocal(name) {
        if (!fields[name]) return;
        delete fields[name];
        notify(name, held.values[name], { state: COMMITTED });
    }

    /**
     * Subscribe to preference changes, whatever their source.
     *
     * Description: the listener is called for a committed value, a
     *   pending local one, a failure and a conflict alike, so a control
     *   can paint all four from one place. It is called INSIDE the
     *   remote-apply guard for a received change, so a listener that
     *   calls `set()` is refused rather than starting an echo.
     * Inputs: listener (function(name, value, record)) - `record` carries
     *   `{state}` and, for a conflict, `committed`.
     * Output: function - call it to unsubscribe.
     */
    function subscribe(listener) {
        if (typeof listener !== 'function') return function () {};
        listeners.push(listener);
        return function () {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
        };
    }

    /**
     * Reset every held value. For tests and for a sign-out.
     *
     * Inputs: none. Output: undefined.
     */
    function reset() {
        held.status = NOT_HYDRATED;
        held.revision = 0;
        held.values = {};
        Object.keys(fields).forEach(function (name) { delete fields[name]; });
        applyingRemote = false;
    }

    // ---- internals -----------------------------------------------------

    /**
     * Take a server body as the new truth.
     *
     * Inputs: body (object) - a GET or PATCH response, or a 409 detail;
     *   opts (object) - reserved, currently unused beyond readability.
     * Output: undefined.
     */
    function adoptServerState(body, opts) {
        void opts;
        if (!body || typeof body !== 'object') return;
        const nextRevision = Number(body.revision);
        if (Number.isFinite(nextRevision)) held.revision = nextRevision;
        if (body.values && typeof body.values === 'object') {
            held.values = Object.assign({}, body.values);
        }
    }

    /**
     * Mark a field as holding an unsaved edit that the server disagrees
     * with, keeping both values.
     *
     * Inputs: name (string); localValue (*).
     * Output: undefined.
     */
    function markConflict(name, localValue) {
        fields[name] = {
            state: CONFLICT,
            local: localValue,
            committed: held.values[name],
        };
        notify(name, localValue, fields[name]);
    }

    /**
     * Fan one change out to every listener.
     *
     * Inputs: name (string); value (*); record (object).
     * Output: undefined.
     */
    function notify(name, value, record) {
        listeners.slice().forEach(function (listener) {
            try {
                listener(name, value, record);
            } catch (err) {
                // Deliberately swallowed: one broken control must not
                // stop the others being told, and the change has already
                // been applied to the held state by this point.
                console.error('[Preferences] listener failed for ' + name, err);
            }
        });
    }

    /**
     * Recover the 409 body from whatever the API client threw.
     *
     * Description: the client's error shape is not guaranteed, so this
     *   looks for a stale-revision payload in the two places it can be
     *   and answers null otherwise. A conflict we cannot recognise is
     *   treated as an ordinary failure, which keeps the user's value on
     *   screen - never as a success.
     * Inputs: err (*) - whatever was thrown.
     * Output: object|null - the payload, or null.
     */
    function conflictBodyFrom(err) {
        if (!err || typeof err !== 'object') return null;
        const candidates = [err.detail, err.body && err.body.detail, err.data && err.data.detail];
        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            if (candidate && typeof candidate === 'object'
                && candidate.status === 'stale_revision') {
                return candidate;
            }
        }
        return null;
    }

    const api = {
        NOT_HYDRATED: NOT_HYDRATED,
        HYDRATED: HYDRATED,
        READ_FAILED: READ_FAILED,
        COMMITTED: COMMITTED,
        PENDING: PENDING,
        FAILED: FAILED,
        CONFLICT: CONFLICT,
        clientId: clientId,
        get: get,
        committedValue: committedValue,
        stateFor: stateFor,
        status: status,
        revision: revision,
        hydrate: hydrate,
        set: set,
        applyRemote: applyRemote,
        retry: retry,
        discardLocal: discardLocal,
        subscribe: subscribe,
        reset: reset,
    };

    // Published on globalThis rather than window by name so the same file
    // loads unchanged in a browser and under `node --test`, matching
    // client/js/status-led.js and client/js/session-transport.js.
    globalThis.Preferences = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[Preferences Module] Loaded');
})();
