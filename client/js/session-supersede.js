/**
 * SUPERSESSION - telling a restart REPLACEMENT apart from a deliberate
 * FORK, so a session the user restarted stops appearing twice.
 *
 * THE BUG THIS EXISTS FOR. Restarting a stopped session cannot reuse its
 * tmux instance, so it correctly mints a NEW session row - and since the
 * restart fix, that row carries the OLD row's title verbatim (see
 * src/core/session_restart.py, "THE TITLE IS CARRIED VERBATIM"). The
 * project tree then listed BOTH as peers under the same project: one
 * "Media Compression" running, one "Media Compression" ended, same name,
 * no way to tell which was which. It grew by one more every restart.
 *
 * WHY fork_kind CANNOT ANSWER THIS, AND SAYING SO IS THE POINT. Both a
 * restart replacement and a deliberate fork record
 * ``parent_session_id`` on the child and ``fork_kind = 'fork'`` - the
 * same two values, written by the same function (session_fork.
 * mark_as_fork). session_restart.py explains why on purpose: fork_kind
 * holds Claude Code's own SessionStart.source, a CLI measurement, and
 * "the user pressed RESTART" is a fact about a GUI gesture. So the
 * presence of lineage says a session came out of another one. It does
 * NOT say which gesture made it, and any code here that reads
 * fork_kind === 'fork' as "this was a restart" would be hiding forks the
 * user deliberately created.
 *
 * WHAT DOES ANSWER IT: *WHEN*, NOT *WHAT*.
 *
 *   A RESTART replaces a session that is ALREADY DEAD. It is only
 *   offered on a stopped row. So the parent's last proof of life -
 *   ``last_seen_running_at``, stamped by the tmux reconciler every time
 *   a probe finds the session alive - necessarily PRECEDES the child's
 *   ``created_at``, by however long the session sat stopped. Measured on
 *   the live database: parent #4 last seen 2026-08-29T16:49, child #7
 *   created 2026-09-03T14:13. Five days.
 *
 *   A FORK branches a session that is STILL RUNNING. Its parent goes on
 *   being probed after the child is born, so ``last_seen_running_at``
 *   keeps advancing PAST the child's ``created_at`` and stays past it
 *   forever, even after the parent eventually stops. This is what makes
 *   the test durable rather than a snapshot: it is not asking whether
 *   the parent is stopped NOW (it is, in both cases, by the time anyone
 *   is looking), it is asking whether the parent was ALREADY stopped
 *   when its child was created. That question has a permanent answer.
 *
 * WHY NOT THE '(fork)' TITLE SUFFIX, which also differs. A deliberate
 * fork labels its child ``name(fork)`` and a restart carries the title
 * verbatim, so the label looks like a free discriminator. It is not one:
 * the title is USER-EDITABLE. Renaming a forked session to drop the
 * suffix would silently make its parent disappear from the tree. A
 * mutable label must never drive a visibility decision; a recorded
 * measurement of when a process was alive can.
 *
 * THREE OUTCOMES, AND THE THIRD ONE STAYS ON SCREEN. Missing ids,
 * missing or unparseable timestamps, or a parent that was never once
 * seen running, all mean the comparison could not be made - which is not
 * the same as making it and getting "no". :data:`CANNOT_DETERMINE` is
 * returned, and every caller treats it exactly like NOT_SUPERSEDED,
 * because the cost of the two errors is not symmetric: a duplicate row
 * is untidy, and a hidden row is the user losing a session he meant to
 * keep.
 *
 * NOTHING HERE DELETES OR ARCHIVES ANYTHING. This module answers a
 * question about two rows. Supersession is DERIVED on every read, never
 * stored, so it cannot go stale and cannot be wrong about a session that
 * is still alive - the same reasoning session_fork.children_of gives for
 * not writing a "was forked from" column on the parent.
 */

console.log('[SessionSupersede Module] Loading...');

(function () {
    'use strict';

    /** This session was replaced by a restart. Safe to fold away. */
    var SUPERSEDED = 'superseded';

    /** Measured, and the answer is no. Render it as a peer. */
    var NOT_SUPERSEDED = 'not-superseded';

    /** Could not evaluate. Renders exactly like NOT_SUPERSEDED. */
    var CANNOT_DETERMINE = 'cannot-determine';

    /**
     * How much older than its child's birth the parent's last proof of
     * life must be before we call it superseded, in milliseconds.
     *
     * SET FROM A MEASURED CADENCE, NOT FROM ROUNDNESS. ``last_seen_
     * running_at`` is only as fresh as the last tmux probe, and the
     * launcher's own poller runs every 5000ms (Launchpad.
     * _startRunningSessionsPoller). So a genuinely-live parent's stamp
     * can legitimately lag the present by up to one poll tick, and a
     * fork taken in that window would show a small negative gap through
     * no fault of its own. 60s is twelve poll intervals of headroom -
     * far above the lag this can produce, and four orders of magnitude
     * below the days-long gap a real restart produces. The margin makes
     * the test STRICTLY MORE CONSERVATIVE: anything inside it falls back
     * to NOT_SUPERSEDED and stays visible.
     * @type {number}
     */
    var MIN_GAP_MS = 60000;

    /**
     * Description: parse an ISO-8601 stamp into epoch milliseconds,
     *   refusing anything that does not parse rather than coercing it to
     *   0. A 0 here would read as 1970 and make every comparison against
     *   it succeed, which is the false green this whole module is built
     *   to avoid.
     * Inputs: value (string|null|undefined).
     * Output: number|null - milliseconds, or null when unparseable.
     * Example: SessionSupersede._epoch('2026-09-03T14:13:57Z') // 1788...
     */
    function _epoch(value) {
        if (typeof value !== 'string' || value === '') return null;
        var ms = Date.parse(value);
        return (typeof ms === 'number' && isFinite(ms)) ? ms : null;
    }

    /**
     * Description: coerce a session id to a number, accepting the string
     *   form JSON sometimes carries but refusing null, undefined and ''.
     * Inputs: value (any).
     * Output: number|null.
     */
    function _id(value) {
        if (value === null || value === undefined || value === '') return null;
        var n = Number(value);
        return isFinite(n) ? n : null;
    }

    /**
     * Description: index a record list by ``id``, for the child lookups
     *   below. Records with no usable id are skipped - they cannot be
     *   pointed at by a ``parent_session_id`` anyway.
     * Inputs: records (Array<object>).
     * Output: Map<number, object>.
     */
    function indexById(records) {
        var map = new Map();
        var list = Array.isArray(records) ? records : [];
        for (var i = 0; i < list.length; i++) {
            var id = _id(list[i] && list[i].id);
            if (id !== null) map.set(id, list[i]);
        }
        return map;
    }

    /**
     * Description: every record in ``records`` whose ``parent_session_id``
     *   points at ``record``. Derived on each call - see the module
     *   header for why this is never stored on the parent.
     * Inputs: record (object) - the candidate parent. records
     *   (Array<object>) - the full record set to search.
     * Output: Array<object> - possibly empty.
     * Example: SessionSupersede.childrenOf({id: 4}, all)  // [{id: 7, ...}]
     */
    function childrenOf(record, records) {
        var pid = _id(record && record.id);
        if (pid === null) return [];
        var out = [];
        var list = Array.isArray(records) ? records : [];
        for (var i = 0; i < list.length; i++) {
            if (_id(list[i] && list[i].parent_session_id) === pid) {
                out.push(list[i]);
            }
        }
        return out;
    }

    /**
     * Description: decide whether ``record`` was replaced by a restart,
     *   as one of the three outcomes above. See the module header for the
     *   full reasoning; the short version is that lineage alone proves
     *   only that a child exists, and the TIMESTAMPS prove whether the
     *   parent was already dead when that child was made.
     *
     *   Returns the FIRST definite verdict it can reach. If any child
     *   clears the gap the record is SUPERSEDED. If no child clears it
     *   but some child could not be evaluated, the answer is
     *   CANNOT_DETERMINE - never a confident "no" assembled out of
     *   measurements that did not happen.
     * Inputs: record (object) - a session record carrying ``id`` and
     *   ``last_seen_running_at``. records (Array<object>) - the full set
     *   the children are looked up in.
     * Output: string - one of SUPERSEDED / NOT_SUPERSEDED /
     *   CANNOT_DETERMINE.
     * Example: SessionSupersede.classify(rec4, all) // 'superseded'
     */
    function classify(record, records) {
        if (!record) return CANNOT_DETERMINE;
        var kids = childrenOf(record, records);
        // NO LINEAGE IS A MEASURED NO. Nothing points at this row, so
        // nothing replaced it. This is the ordinary case for every
        // session that was never forked or restarted, and it must be a
        // definite answer rather than an unknown or the tree would fill
        // with cannot-determine noise.
        if (kids.length === 0) return NOT_SUPERSEDED;

        var lastAlive = _epoch(record.last_seen_running_at);
        // A parent that was never once PROVEN alive cannot be placed on
        // the timeline at all, so the comparison the verdict rests on is
        // unavailable. Not a no.
        if (lastAlive === null) return CANNOT_DETERMINE;

        var unevaluable = false;
        for (var i = 0; i < kids.length; i++) {
            var born = _epoch(kids[i] && kids[i].created_at);
            if (born === null) { unevaluable = true; continue; }
            if (born - lastAlive >= MIN_GAP_MS) return SUPERSEDED;
        }
        return unevaluable ? CANNOT_DETERMINE : NOT_SUPERSEDED;
    }

    /**
     * Description: convenience predicate - true ONLY for a definite
     *   SUPERSEDED verdict. Written as an explicit equality against the
     *   one hiding outcome rather than as "not visible", so a future
     *   fourth state cannot silently start hiding rows.
     * Inputs: record (object). records (Array<object>).
     * Output: boolean.
     * Example: SessionSupersede.isSuperseded(rec, all) // true
     */
    function isSuperseded(record, records) {
        return classify(record, records) === SUPERSEDED;
    }

    /**
     * Description: for a superseded record, the child that replaced it -
     *   the newest one that clears the gap. Callers need this because a
     *   superseded row is only ever HIDDEN where its successor is
     *   actually on screen to be folded under; when the successor is not
     *   rendered, the parent must stay visible or the user loses his
     *   only way back to it.
     * Inputs: record (object). records (Array<object>).
     * Output: object|null - the replacing record, or null when there is
     *   no definite one.
     * Example: SessionSupersede.successorOf(rec4, all).id  // 7
     */
    function successorOf(record, records) {
        if (!record) return null;
        var lastAlive = _epoch(record.last_seen_running_at);
        if (lastAlive === null) return null;
        var kids = childrenOf(record, records);
        var best = null;
        var bestBorn = null;
        for (var i = 0; i < kids.length; i++) {
            var born = _epoch(kids[i] && kids[i].created_at);
            if (born === null) continue;
            if (born - lastAlive < MIN_GAP_MS) continue;
            if (bestBorn === null || born > bestBorn) {
                best = kids[i];
                bestBorn = born;
            }
        }
        return best;
    }

    window.SessionSupersede = {
        classify: classify,
        isSuperseded: isSuperseded,
        successorOf: successorOf,
        childrenOf: childrenOf,
        indexById: indexById,
        SUPERSEDED: SUPERSEDED,
        NOT_SUPERSEDED: NOT_SUPERSEDED,
        CANNOT_DETERMINE: CANNOT_DETERMINE,
        MIN_GAP_MS: MIN_GAP_MS,
        _epoch: _epoch
    };
    console.log('[SessionSupersede Module] Exported as window.SessionSupersede');
})();
