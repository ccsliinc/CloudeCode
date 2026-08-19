/**
 * Session sidebar ARRANGEMENT - which sessions are pinned to the top, and
 * the order the user put them in.
 *
 * WHICH "PIN" THIS IS. There are now two, and they are different features
 * with different storage keys. client/js/session-sidebar-pin.js pins the
 * BAR (docked open, no backdrop). This module pins a SESSION (it sorts to
 * the top of the list and stays there). The user asked for both, in two
 * separate sentences, so neither name is available to mean the other.
 *
 * WHY ONE KEY FOR TWO CAPABILITIES. A pin is not independent of an order:
 * it is a partition of the same list into a top band and a bottom band.
 * Storing them apart lets one half parse and the other half not, which
 * would leave the list half-arranged and no honest way to describe it.
 * One key, one parse, one verdict.
 *
 * THREE OUTCOMES ON LOAD, and they are not the same thing:
 *   'default'    nothing stored yet. Not a failure. The list falls back
 *                to its built-in sort and says nothing, because there is
 *                nothing the user arranged for it to have lost.
 *   'ok'         parsed, and it is his.
 *   'unreadable' a value IS stored and could not be read or did not have
 *                the right shape (or localStorage itself threw). The list
 *                falls back to the built-in sort AND SAYS SO. Presenting
 *                the default order silently would tell the user that this
 *                is the arrangement he chose. It is not.
 * The stored bytes are deliberately NOT overwritten on 'unreadable' - the
 * value stays on disk, inspectable, until the user's next deliberate
 * arrangement change replaces it with a good one.
 *
 * A REMEMBERED NAME WHOSE SESSION IS GONE KEEPS ITS SLOT. It is not an
 * error and it is not dropped: the entry stays in storage at the same
 * index, renders no row, and is counted out loud (see `arrange()`'s
 * `missing`, which the list renders as a note and stamps on the list
 * element as a data attribute). A session that stops overnight and comes
 * back lands back where the user left it. The remembered list is capped
 * at MAX_REMEMBERED so it cannot grow without bound.
 *
 * No DOM in this file, no storage reads outside load()/save(). It is a
 * pure ordering function plus a persistence pair, which is what makes it
 * testable without a browser.
 *
 * Must load BEFORE session-sidebar.js runs.
 */

console.log('[SessionSidebarArrangement Module] Loading...');

(function () {
    /**
     * localStorage key for the pinned set + user order. Follows the app's
     * `cloude.*` convention, and sits beside the two flags the same panel
     * already owns (`cloude.session.sidebar`, `...sidebar.pinned`).
     * @type {string}
     */
    const STORAGE_KEY = 'cloude.session.sidebar.arrangement';

    /**
     * Schema version stamped into the stored envelope. A value carrying
     * any other version is treated as unreadable rather than guessed at.
     * @type {number}
     */
    const VERSION = 1;

    /**
     * Most remembered names kept across saves. Slots for sessions that no
     * longer exist are retained on purpose (see the file docblock); this
     * is the bound that stops "retained on purpose" becoming "forever".
     * @type {number}
     */
    const MAX_REMEMBERED = 200;

    /** Live state, replaced wholesale by load(). @type {object} */
    let state = { status: 'default', reason: null, pinned: [], order: [] };

    /**
     * Description: true when `value` is an array of non-empty strings.
     * Inputs: value (any).
     * Output: boolean.
     */
    function isNameArray(value) {
        return Array.isArray(value)
            && value.every((n) => typeof n === 'string' && n.length > 0);
    }

    /**
     * Description: drop duplicates from a name list, keeping first wins.
     * Inputs: names (Array<string>).
     * Output: Array<string>.
     */
    function dedupe(names) {
        const seen = new Set();
        const out = [];
        for (const n of names) {
            if (seen.has(n)) continue;
            seen.add(n);
            out.push(n);
        }
        return out;
    }

    /**
     * Description: read the stored arrangement and classify the result as
     *   one of the three outcomes described in the file docblock. Never
     *   throws; a storage backend that refuses to answer is 'unreadable',
     *   which is a verdict, not a crash.
     * Inputs: none (reads localStorage).
     * Output: object - {status, reason, pinned, order}. Also replaces the
     *   module's live state.
     * Example: SessionSidebarArrangement.load().status // 'default'
     */
    function load() {
        let raw = null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (err) {
            state = {
                status: 'unreadable',
                reason: 'storage unavailable',
                pinned: [],
                order: [],
            };
            return state;
        }
        if (raw === null || raw === undefined || raw === '') {
            state = { status: 'default', reason: null, pinned: [], order: [] };
            return state;
        }
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            state = {
                status: 'unreadable',
                reason: 'stored value is not valid JSON',
                pinned: [],
                order: [],
            };
            return state;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            state = {
                status: 'unreadable',
                reason: 'stored value is not an arrangement object',
                pinned: [],
                order: [],
            };
            return state;
        }
        if (parsed.v !== VERSION) {
            state = {
                status: 'unreadable',
                reason: `stored arrangement is version ${JSON.stringify(parsed.v)}, this app writes version ${VERSION}`,
                pinned: [],
                order: [],
            };
            return state;
        }
        if (!isNameArray(parsed.pinned) || !isNameArray(parsed.order)) {
            state = {
                status: 'unreadable',
                reason: 'stored pin or order list is not a list of session names',
                pinned: [],
                order: [],
            };
            return state;
        }
        state = {
            status: 'ok',
            reason: null,
            pinned: dedupe(parsed.pinned).slice(0, MAX_REMEMBERED),
            order: dedupe(parsed.order).slice(0, MAX_REMEMBERED),
        };
        return state;
    }

    /**
     * Description: the last loaded/updated arrangement, without re-reading
     *   storage.
     * Inputs: none.
     * Output: object - {status, reason, pinned, order}.
     */
    function current() { return state; }

    /**
     * Description: persist a pin set + order, and mark the live state 'ok'.
     *   A deliberate write is what clears an 'unreadable' verdict: the
     *   user has now told us an arrangement, so there is no longer a lost
     *   one to warn about.
     * Inputs: pinned (Array<string>), order (Array<string>).
     * Output: boolean - true when the write landed, false when storage
     *   refused it (the in-memory arrangement still applies for this page).
     */
    function save(pinned, order) {
        const nextPinned = dedupe(pinned).slice(0, MAX_REMEMBERED);
        const nextOrder = dedupe(order).slice(0, MAX_REMEMBERED);
        state = {
            status: 'ok', reason: null, pinned: nextPinned, order: nextOrder,
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                v: VERSION, pinned: nextPinned, order: nextOrder,
            }));
            return true;
        } catch (err) {
            console.warn('SessionSidebarArrangement: could not persist arrangement:', err);
            return false;
        }
    }

    /**
     * Description: true when this session name is pinned to the top band.
     * Inputs: name (string).
     * Output: boolean.
     */
    function isPinned(name) { return state.pinned.indexOf(name) !== -1; }

    /**
     * Description: sort rows into the user's arrangement: the pinned band
     *   first, then the rest, each band following the stored order, with
     *   any name the arrangement has never seen appended to the end of its
     *   band in the caller's incoming (default-sorted) order. Names the
     *   arrangement remembers but that have no row are reported, never
     *   dropped.
     *
     *   The incoming order is the sidebar's built-in sort (this tab, then
     *   live, then newest). It is used ONLY for names the user has not
     *   arranged - a user-defined position is never silently overridden by
     *   it, which is the whole requirement.
     * Inputs: rows (Array<object>) - merged session rows, each with `name`.
     * Output: object - {rows (Array<object>), missing (Array<string>)}.
     * Example: SessionSidebarArrangement.arrange(rows).missing // ['cloude_old']
     */
    function arrange(rows) {
        const list = Array.isArray(rows) ? rows.slice() : [];
        const byName = new Map();
        for (const row of list) {
            if (row && typeof row.name === 'string') byName.set(row.name, row);
        }

        const known = new Set(state.order);
        const ordered = [];
        for (const name of state.order) {
            const row = byName.get(name);
            if (row) ordered.push(row);
        }
        for (const row of list) {
            if (!known.has(row.name)) ordered.push(row);
        }

        const pinnedBand = [];
        const restBand = [];
        for (const row of ordered) {
            row.is_pinned = isPinned(row.name);
            (row.is_pinned ? pinnedBand : restBand).push(row);
        }

        const remembered = dedupe(state.order.concat(state.pinned));
        const missing = remembered.filter((n) => !byName.has(n));
        return { rows: pinnedBand.concat(restBand), missing };
    }

    /**
     * Description: rewrite the stored order from the currently VISIBLE
     *   sequence while keeping every remembered-but-absent name in the
     *   slot it already occupies. Walking the old order and substituting
     *   the new visible sequence into the slots the visible names held is
     *   what makes a stopped session come back to where the user left it,
     *   rather than to the bottom of the list.
     * Inputs: visibleNames (Array<string>) - the new top-to-bottom order
     *   of the names that currently have rows.
     * Output: Array<string> - the merged order to persist.
     */
    function mergeOrder(visibleNames) {
        const incoming = dedupe(visibleNames);
        const visible = new Set(incoming);
        const out = [];
        let i = 0;
        for (const name of state.order) {
            if (visible.has(name)) {
                if (i < incoming.length) out.push(incoming[i++]);
            } else {
                out.push(name);
            }
        }
        while (i < incoming.length) out.push(incoming[i++]);
        return dedupe(out).slice(0, MAX_REMEMBERED);
    }

    /**
     * Description: flip one session's pin and persist the result. The row
     *   keeps its relative position inside whichever band it lands in.
     * Inputs: name (string), visibleNames (Array<string>) - current
     *   top-to-bottom visible order, so the write records the list as the
     *   user currently sees it.
     * Output: boolean - the new pinned state of `name`.
     */
    function togglePin(name, visibleNames) {
        const next = !isPinned(name);
        const pinned = next
            ? state.pinned.concat([name])
            : state.pinned.filter((n) => n !== name);
        save(pinned, mergeOrder(visibleNames));
        return next;
    }

    /**
     * Description: move one session up or down WITHIN ITS OWN BAND and
     *   persist. Confining the move to the band is what stops an
     *   ArrowUp at the top of the unpinned band from silently unpinning
     *   or leapfrogging a pinned row - a move must never change a pin.
     * Inputs: name (string), delta (number) - -1 up, +1 down.
     *   visibleNames (Array<string>) - current top-to-bottom visible order.
     * Output: Array<string>|null - the new visible order, or null when the
     *   move was refused (row not found, or already at its band edge).
     */
    function move(name, delta, visibleNames) {
        const names = dedupe(visibleNames);
        const idx = names.indexOf(name);
        if (idx === -1) return null;
        const band = isPinned(name);
        const step = delta < 0 ? -1 : 1;
        const target = idx + step;
        if (target < 0 || target >= names.length) return null;
        if (isPinned(names[target]) !== band) return null;
        const next = names.slice();
        next[idx] = names[target];
        next[target] = name;
        save(state.pinned, mergeOrder(next));
        return next;
    }

    /**
     * Description: place `name` immediately before `beforeName` (or at the
     *   end when `beforeName` is null), refusing any move that would cross
     *   a band boundary, and persist. This is the pointer-drag commit.
     * Inputs: name (string), beforeName (string|null),
     *   visibleNames (Array<string>).
     * Output: Array<string>|null - the new visible order, or null when the
     *   move was refused.
     */
    function moveBefore(name, beforeName, visibleNames) {
        const names = dedupe(visibleNames);
        if (names.indexOf(name) === -1) return null;
        if (beforeName !== null && names.indexOf(beforeName) === -1) return null;
        if (beforeName === name) return null;
        const band = isPinned(name);
        const rest = names.filter((n) => n !== name);
        let at = beforeName === null ? rest.length : rest.indexOf(beforeName);
        if (at === -1) at = rest.length;
        // A drop is legal exactly when it leaves the two bands contiguous
        // with the pinned band on top. Requiring BOTH neighbours to match
        // the row's own band was too strict and refused a legal move: it
        // rejected dropping an unpinned row into the FIRST unpinned slot,
        // whose upper neighbour is necessarily pinned. So each band is
        // constrained only on the side that faces the boundary - a pinned
        // row must not have an unpinned row above it, and an unpinned row
        // must not have a pinned row below it.
        const before = at > 0 ? rest[at - 1] : null;
        const after = at < rest.length ? rest[at] : null;
        if (band && before !== null && !isPinned(before)) return null;
        if (!band && after !== null && isPinned(after)) return null;
        const next = rest.slice(0, at).concat([name], rest.slice(at));
        save(state.pinned, mergeOrder(next));
        return next;
    }

    window.SessionSidebarArrangement = {
        load, current, save, arrange, isPinned, togglePin, move, moveBefore,
        mergeOrder, STORAGE_KEY, VERSION, MAX_REMEMBERED,
    };
    console.log('[SessionSidebarArrangement Module] Exported as window.SessionSidebarArrangement');
})();
