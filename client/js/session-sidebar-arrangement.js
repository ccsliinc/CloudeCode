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
 * A FOURTH FIELD, `collapsed`, RIDES THE SAME ENVELOPE AND DOES NOT BUMP
 * THE VERSION. It records which section headers the user folded shut.
 * Bumping VERSION to 2 for it would have declared every arrangement
 * already on disk 'unreadable', so every existing user would have opened
 * the bar to a CANNOT LOAD notice and a default order - breaking the
 * exact thing this module exists to protect in order to store a
 * preference. It is therefore ADDITIVE and OPTIONAL: absent reads as
 * "nothing collapsed", and an older build that never heard of it parses
 * the envelope unchanged and ignores the key.
 *
 * AND IT IS GRADED DIFFERENTLY FROM THE OTHER THREE, deliberately. A
 * malformed `pinned` or `order` is 'unreadable', because that is the
 * user's own arrangement and losing it silently would be a lie. A
 * malformed `collapsed` warns to the console and reads as "nothing
 * collapsed", because a fold is a preference and not data - the same
 * stance client/js/session-sidebar-density.js already takes for the
 * density mode, and for the same reason: there is nothing of the user's
 * to lose and nothing to announce in the UI.
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

    /**
     * The two section keys the list can fold. Not free-form strings: a
     * stored key that is not one of these is discarded on load, so a
     * renamed or removed section cannot leave a fold nothing can reopen.
     * @type {Array<string>}
     */
    const GROUP_KEYS = ['pinned', 'other'];

    /** Live state, replaced wholesale by load(). @type {object} */
    let state = {
        status: 'default', reason: null, pinned: [], order: [], collapsed: [],
    };

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
     * Description: read the optional `collapsed` list out of a stored
     *   envelope. Anything that is not a list of known GROUP_KEYS reads
     *   as "nothing collapsed" and warns, rather than failing the whole
     *   parse - see the file docblock for why a fold is graded as a
     *   preference and the order is graded as data.
     * Inputs: value (any) - whatever the envelope carried, possibly
     *   undefined.
     * Output: Array<string> - a subset of GROUP_KEYS, never anything else.
     * Example: readCollapsed(['pinned', 'nope']) // ['pinned']
     */
    function readCollapsed(value) {
        if (value === undefined || value === null) return [];
        if (!isNameArray(value)) {
            console.warn('SessionSidebarArrangement: stored collapsed list is not a list of'
                + ' section names, treating every section as open');
            return [];
        }
        const kept = dedupe(value).filter((k) => GROUP_KEYS.indexOf(k) !== -1);
        if (kept.length !== dedupe(value).length) {
            console.warn('SessionSidebarArrangement: dropped unknown collapsed section key(s)');
        }
        return kept;
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
                collapsed: [],
            };
            return state;
        }
        if (raw === null || raw === undefined || raw === '') {
            state = {
                status: 'default', reason: null, pinned: [], order: [], collapsed: [],
            };
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
                collapsed: [],
            };
            return state;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            state = {
                status: 'unreadable',
                reason: 'stored value is not an arrangement object',
                pinned: [],
                order: [],
                collapsed: [],
            };
            return state;
        }
        if (parsed.v !== VERSION) {
            state = {
                status: 'unreadable',
                reason: `stored arrangement is version ${JSON.stringify(parsed.v)}, this app writes version ${VERSION}`,
                pinned: [],
                order: [],
                collapsed: [],
            };
            return state;
        }
        if (!isNameArray(parsed.pinned) || !isNameArray(parsed.order)) {
            state = {
                status: 'unreadable',
                reason: 'stored pin or order list is not a list of session names',
                pinned: [],
                order: [],
                collapsed: [],
            };
            return state;
        }
        state = {
            status: 'ok',
            reason: null,
            pinned: dedupe(parsed.pinned).slice(0, MAX_REMEMBERED),
            order: dedupe(parsed.order).slice(0, MAX_REMEMBERED),
            collapsed: readCollapsed(parsed.collapsed),
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
    function save(pinned, order, collapsed) {
        const nextPinned = dedupe(pinned).slice(0, MAX_REMEMBERED);
        const nextOrder = dedupe(order).slice(0, MAX_REMEMBERED);
        // `undefined` means "leave the folds alone", which is what every
        // caller that only touches pins or order wants. Passing the live
        // value through rather than defaulting to [] is what stops a
        // reorder from silently reopening a section the user folded.
        const nextCollapsed = readCollapsed(
            collapsed === undefined ? state.collapsed : collapsed,
        );
        state = {
            status: 'ok',
            reason: null,
            pinned: nextPinned,
            order: nextOrder,
            collapsed: nextCollapsed,
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                v: VERSION,
                pinned: nextPinned,
                order: nextOrder,
                collapsed: nextCollapsed,
            }));
            return true;
        } catch (err) {
            console.warn('SessionSidebarArrangement: could not persist arrangement:', err);
            return false;
        }
    }

    /**
     * Description: true when a section is folded shut.
     * Inputs: key (string) - one of GROUP_KEYS.
     * Output: boolean.
     */
    function isCollapsed(key) { return state.collapsed.indexOf(key) !== -1; }

    /**
     * Description: fold or unfold one section and persist it, leaving the
     *   pins and the order exactly as they were.
     * Inputs: key (string) - one of GROUP_KEYS. Anything else is ignored.
     * Output: boolean - the section's new collapsed state.
     */
    function toggleCollapsed(key) {
        if (GROUP_KEYS.indexOf(key) === -1) return false;
        const next = !isCollapsed(key);
        const collapsed = next
            ? state.collapsed.concat([key])
            : state.collapsed.filter((k) => k !== key);
        save(state.pinned, state.order, collapsed);
        return next;
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
     * Description: move one session one slot up or down, CROSSING THE
     *   PINNED BOUNDARY when it reaches its band's edge - which pins or
     *   unpins it. This is the keyboard twin of dragging a row into or out
     *   of the pinned group, and it exists so that capability is not
     *   pointer-only.
     *
     *   THIS REVERSES AN EARLIER RULE ON PURPOSE. The band edge used to be
     *   a hard refusal, on the reasoning that a move must never change a
     *   pin the user could not see themselves perform. The user has since
     *   asked for exactly that crossing, so the protection moves rather
     *   than disappearing: a crossing move RETURNS `crossed: true`, and
     *   the caller announces the pin change in words (see
     *   client/js/session-sidebar-reorder.js). An invisible unpin was the
     *   thing being prevented, not the unpin itself.
     *
     *   THE LIST EDGES ARE STILL HARD REFUSALS. Alt+Up on the very first
     *   row has no row above it to cross past, so it does nothing rather
     *   than pinning into an empty band - `p` is the gesture for
     *   "pin where you are", and overloading Alt+Up with it would make the
     *   top row's behaviour depend on invisible state.
     * Inputs: name (string), delta (number) - -1 up, +1 down.
     *   visibleNames (Array<string>) - current top-to-bottom visible order.
     * Output: object|null - {order (Array<string>), crossed (boolean),
     *   pinned (boolean) - the row's pin state AFTER the move}, or null
     *   when the move was refused (row not found, or at a list edge).
     */
    function move(name, delta, visibleNames) {
        const names = dedupe(visibleNames);
        const idx = names.indexOf(name);
        if (idx === -1) return null;
        const step = delta < 0 ? -1 : 1;
        const target = idx + step;
        if (target < 0 || target >= names.length) return null;
        const band = isPinned(name);
        const neighbourBand = isPinned(names[target]);
        const next = names.slice();
        next[idx] = names[target];
        next[target] = name;
        // Crossing means adopting the neighbour's band. The swap above
        // already puts the row on the far side of the boundary in the
        // visible sequence; arrange() re-partitions from the pin set, so
        // the pin has to move with it or the row snaps straight back.
        const crossed = neighbourBand !== band;
        const nowPinned = crossed ? neighbourBand : band;
        const pinnedSet = crossed
            ? (nowPinned ? state.pinned.concat([name]) : state.pinned.filter((n) => n !== name))
            : state.pinned;
        save(pinnedSet, mergeOrder(next));
        return { order: next, crossed, pinned: nowPinned };
    }

    /**
     * Description: place `name` immediately before `beforeName` (or at the
     *   end of the list when `beforeName` is null) AND set which band it
     *   lands in, then persist. This is the pointer-drag commit, and the
     *   one function that can pin or unpin by position.
     *
     *   The caller decides the band from what the pointer is OVER (the
     *   group container, not the neighbouring row), because a drop into an
     *   empty pinned group has no neighbouring row to infer a band from
     *   and inferring one from the nearest row would make the empty group
     *   undroppable - which is exactly the case the feature is for.
     *
     *   `next` is not required to be band-contiguous. `arrange()`
     *   re-partitions it into the two bands and preserves relative order
     *   inside each, so this only has to get the within-band sequence
     *   right, which is why there is no boundary arithmetic left here.
     * Inputs: name (string) - the row being placed.
     *   targetPinned (boolean) - the band it should end up in.
     *   beforeName (string|null) - the visible row to sit above, or null
     *   for the end.
     *   visibleNames (Array<string>) - current top-to-bottom visible order.
     * Output: object|null - {order (Array<string>), crossed (boolean),
     *   pinned (boolean)}, or null when the placement is a no-op or the
     *   row is not visible.
     * Example: placeAt('cloude_fs2', true, 'cloude_asd', names).crossed
     */
    function placeAt(name, targetPinned, beforeName, visibleNames) {
        const names = dedupe(visibleNames);
        if (names.indexOf(name) === -1) return null;
        if (beforeName === name) return null;
        if (beforeName !== null && beforeName !== undefined
            && names.indexOf(beforeName) === -1) return null;
        const want = !!targetPinned;
        const rest = names.filter((n) => n !== name);
        let at = (beforeName === null || beforeName === undefined)
            ? rest.length
            : rest.indexOf(beforeName);
        if (at === -1) at = rest.length;
        const next = rest.slice(0, at).concat([name], rest.slice(at));
        const wasPinned = isPinned(name);
        const crossed = wasPinned !== want;
        // A drop that changes neither the band nor the sequence is not a
        // move. Returning null for it keeps the live drag from writing
        // storage and repainting on every pointer sample.
        if (!crossed && sameOrder(next, names)) return null;
        const pinnedSet = want
            ? state.pinned.concat([name])
            : state.pinned.filter((n) => n !== name);
        save(pinnedSet, mergeOrder(next));
        return { order: next, crossed, pinned: want };
    }

    /**
     * Description: true when two name lists are identical, same order.
     * Inputs: a (Array<string>), b (Array<string>).
     * Output: boolean.
     */
    function sameOrder(a, b) {
        return a.length === b.length && a.every((n, i) => n === b[i]);
    }

    window.SessionSidebarArrangement = {
        load, current, save, arrange, isPinned, togglePin, move, placeAt,
        mergeOrder, isCollapsed, toggleCollapsed, readCollapsed, sameOrder,
        STORAGE_KEY, VERSION, MAX_REMEMBERED, GROUP_KEYS,
    };
    console.log('[SessionSidebarArrangement Module] Exported as window.SessionSidebarArrangement');
})();
