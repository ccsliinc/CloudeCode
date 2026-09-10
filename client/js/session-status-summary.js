/**
 * Session status summary - roll a set of sessions up into ONE LED.
 *
 * ONE COMPONENT, TWO PLACES. The roll-up is not a header-shaped dot: it
 * is `StatusLed.ledHtml` with an (inner, outer) pair this module folds
 * out of the children, so a group header and a row cannot draw two
 * different vocabularies. The finished-turn ring in particular is the
 * SAME ring on both.
 *
 * A group header (and the launchpad's top bar, which is the same question
 * asked of every session at once) has to answer "is there anything in
 * here I need to deal with" without the user opening the group. That is a
 * pure fold over the children's states, and it lives here rather than in
 * either caller so the sidebar and the launchpad cannot drift.
 *
 * THE PRIORITY IS THE PRODUCT DECISION, so it is written down once, as
 * data, in SUMMARY_PRIORITY:
 *
 *   permission > input > working > unread > done > dead > unknown
 *
 * Read it as "what is the most interesting thing in this group".
 * `permission` is a session STOPPED on a yes/no; `input` is one that
 * wants the user's eyes (a Notification, or a startup prompt nobody has
 * answered) without being stopped. They were one `waiting` bucket until
 * the 2026-09-08 split; permission leads because it is the only state in
 * the list that is guaranteed to make no progress at all until a human
 * acts, and a group header that hoisted a chatty notification over a
 * parked one would point the user at the wrong session.
 *
 * Both outrank working because they are about the USER and will stay
 * that way until they act; working will resolve on its own. Unread
 * outranks the two quiet states for the same reason. `done` means
 * "finished, and already read" and sits below `unread` and above `dead`:
 * a group with one unread and ten read still bubbles unread, and a group
 * of nothing but read sessions reads done rather than falling all the
 * way to unknown. It renders the grey `idle` dot, which is what a read
 * session looks like on a row. Dead sits BELOW both deliberately: a dead
 * pane in a group of live ones is not the headline, and hoisting it
 * would make a group with one corpse and nine busy sessions read as
 * dead. Unknown is last because it is the absence of a measurement, and
 * any measured state is more informative than no measurement.
 *
 * AND THE HEADER'S RING IS FOLDED ACROSS THE WHOLE GROUP, not looked up
 * on the winning bucket. The inner dot is the highest-priority state in
 * the group; the ring answers "what is the most interesting thing
 * HAPPENING in here", over every member. So a group holding one working
 * session and one parked one paints the parked dot inside a breathing
 * ring, which is both facts at once and is the whole point of having two
 * rings. Reading the ring off the winner's row instead would have hidden
 * the work behind the more urgent dot.
 *
 * ACTIVITY OUTRANKS UNREAD ON THAT RING, and it has to, because since
 * 2026-09-09 the ring carries both. A breathing ring is a claim that
 * something is running right now and it expires on its own; a green
 * unread ring is a claim that will still be true in an hour. When a
 * group holds both, the ring shows the activity and the unread count
 * still reaches the user through the LED's own title. A single-child
 * group always paints exactly what that child's row paints - that
 * agreement is asserted case by case in tests/test_status_summary.node.mjs
 * and it is the property that keeps a header from contradicting the one
 * row under it.
 *
 * THE STATUS FIELD HAS TWO NAMES IN THIS APP, AND THE FOLD HAS TO KNOW
 * BOTH. A `/sessions/list` row calls it `activity_status`; the merged
 * sidebar row calls it `status`, because
 * `session-sidebar-fetch.js mergeLiveRow()` copies `info.activity_status`
 * onto `row.status` so the probe rows and the live rows share one shape.
 * The group header - the only caller today - passes those MERGED rows,
 * so a fold that read `activity_status` alone found the field undefined
 * on every child, bucketed all of them `unknown`, and painted every
 * header `unknown/dim`: a full group and an empty one rendered
 * identically. Measured on live at 880247f, all five headers, including
 * one holding twelve idle sessions and one holding a working session.
 * `signalsFor` is the single place that reconciles the two spellings,
 * and it is not a widening of the contract - it is the contract the one
 * caller always had. Do NOT push this mapping into the caller: the row
 * beside the header renders through `SessionStatusUI.dotHtml(r.status,
 * ...)`, so a second copy of the adapter is a second chance to drift,
 * which is the exact failure this module exists to prevent.
 *
 * Depends on client/js/status-led.js (for the vocabularies) and nothing
 * else. No DOM, no globals beyond that one.
 */

console.log('[SessionStatusSummary Module] Loading...');

(function () {
    /**
     * The fold order. Index 0 wins. Each entry names a summary bucket and
     * the INNER dot that renders it. The ring is not in this table: it
     * answers a different question and is computed by `outerFor`.
     * @type {Array<{key: string, inner: string}>}
     */
    const SUMMARY_PRIORITY = [
        { key: 'permission', inner: 'waiting-permission' },
        { key: 'input', inner: 'waiting-input' },
        { key: 'working', inner: 'working' },
        { key: 'unread', inner: 'done' },
        // FINISHED AND ALREADY READ. The bucket keeps the name `done`
        // because that is what it means; the DOT it renders is the grey
        // `idle` one, because that is what a read session looks like on
        // a row and the header may not disagree with its own children.
        { key: 'done', inner: 'idle' },
        { key: 'dead', inner: 'dead' },
        { key: 'unknown', inner: 'unknown' },
    ];

    /**
     * Buckets that mean "a turn is OPEN in this group right now" - it is
     * either moving or stopped mid-turn waiting on the user. All three
     * take the breathing ring, because all three are what the ROW paints
     * for the same session (see ledStateFor: `question`, `notice` and an
     * unanswered startup prompt all resolve to outer `active`). A header
     * that chose a different ring from its only child would be a bug.
     * @type {string[]}
     */
    const ACTIVE_BUCKETS = ['working', 'permission', 'input'];

    /**
     * The three signals StatusLed needs, from a row of EITHER shape.
     *
     * Description: PURE. `activity_status` is what a `/sessions/list`
     *   row carries; `status` is what the merged sidebar row carries for
     *   the same fact (see the module header). Whichever is a non-empty
     *   string wins, `activity_status` first because it is the server's
     *   own spelling and a row carrying both is a server row that some
     *   other layer has annotated. Neither present is left undefined
     *   rather than defaulted to a state, so StatusLed answers
     *   `unknown/dim` - not having a field is not a measurement, and
     *   inventing `idle` here would be the false green this project
     *   keeps paying for.
     *
     *   `unread` and `startup_gate` are spelled the same on both shapes
     *   and are passed straight through.
     * Inputs:
     *   row (Object|null) - one session row, either shape.
     * Output:
     *   Object - `{activity_status, unread, startup_gate}` for
     *   StatusLed.ledStateFor.
     * Example:
     *   signalsFor({status: 'working'})
     *   // {activity_status: 'working', unread: false, startup_gate: undefined}
     * Example:
     *   signalsFor({activity_status: 'idle', unread: true})
     *   // {activity_status: 'idle', unread: true, startup_gate: undefined}
     */
    function signalsFor(row) {
        const r = row || {};
        const status =
            (typeof r.activity_status === 'string' && r.activity_status)
                ? r.activity_status
                : ((typeof r.status === 'string' && r.status) ? r.status : undefined);
        return {
            activity_status: status,
            unread: !!r.unread,
            startup_gate: r.startup_gate,
        };
    }

    /**
     * Which summary bucket one child's (inner, outer) pair falls into.
     *
     * Description: The bucket is derived from the LED state the child
     *   ALREADY resolved to, not from its raw `activity_status`. That is
     *   deliberate: the header then cannot disagree with the rows under
     *   it, because both are reading the same value - and it is why the
     *   startup gate lands in `input` for free, without this function
     *   knowing the gate exists. Note the RING is checked before the two
     *   rest dots for `unread` - a working session with an unread Stop
     *   counts as working (it is moving), but a resting one with the same
     *   flag counts as unread.
     * Inputs:
     *   led (Object|null) - `{inner, outer}` from StatusLed.ledStateFor.
     * Output:
     *   string - one of the SUMMARY_PRIORITY keys.
     * Example:
     *   bucketFor({inner: 'done', outer: 'unread'}) -> 'unread'
     * Example:
     *   bucketFor({inner: 'idle', outer: 'steady'}) -> 'done'
     */
    function bucketFor(led) {
        const l = led || {};
        if (l.inner === 'waiting-permission') return 'permission';
        // `notice` joins `waiting-input` in the SAME bucket even though
        // the five-colour pass gave it its own hue. The bucket answers
        // "what is the most interesting thing in this group", and both
        // of these are one answer: a session that wants the user without
        // being stopped by a yes/no. The colour split is a rendering
        // decision on the ROW; hoisting it into the fold would change the
        // documented priority, which it must not - see the header, and
        // `inputIsStopped` in summarizeStates for how the hue is kept.
        if (l.inner === 'waiting-input' || l.inner === 'notice') return 'input';
        if (l.inner === 'working') return 'working';
        // THE RING IS WHAT SAYS UNREAD, so the fold reads the RING for
        // it, not the dot. That is the model the owner chose on
        // 2026-09-09 and it is checked before the two rest states below,
        // so a resting session with an unread turn bubbles above one
        // without.
        if (l.outer === 'unread') return 'unread';
        // BOTH REST DOTS FALL HERE. `idle` is the one a live row paints
        // once the unread ring has gone; `done` without that ring is
        // only reachable from a matrix gallery, and it means the same
        // thing, so it may not get a bucket of its own to disagree from.
        if (l.inner === 'idle' || l.inner === 'done') return 'done';
        // `disconnected` is a transport fact and no group feeds one in
        // today - children come from a REST listing, which has no socket.
        // It buckets with `dead` rather than adding an eighth bucket
        // because they paint the same red and rank the same way: neither
        // is the headline for a group that also holds live sessions.
        if (l.inner === 'dead' || l.inner === 'disconnected') return 'dead';
        return 'unknown';
    }

    /**
     * The group's RING, from what is happening across the whole group.
     *
     * Description: PURE, and deliberately not a lookup on the winning
     *   bucket. The ring answers "is anything running in here", which is
     *   a question about EVERY member, not about the loudest one: a group
     *   holding a parked session and a busy one must paint the parked dot
     *   AND the breathing ring, or one of the two facts is lost.
     *   `dim` is reserved for a group where nothing was measured at all,
     *   so an all-unknown group renders exactly like an unknown row.
     *
     *   ACTIVITY OUTRANKS UNREAD here, because the ring carries both
     *   since 2026-09-09 and only one of them can be painted. A
     *   breathing ring expires on its own; a green unread ring does not.
     * Inputs:
     *   present (Object) - a set of bucket keys seen, as a map to true.
     *   winner (string) - the bucket the fold selected.
     * Output:
     *   string - a member of StatusLed.OUTER_STATES.
     * Example:
     *   outerFor({working: true, permission: true}, 'permission') -> 'active'
     * Example:
     *   outerFor({unread: true, done: true}, 'unread') -> 'unread'
     */
    function outerFor(present, winner) {
        for (let i = 0; i < ACTIVE_BUCKETS.length; i++) {
            if (present[ACTIVE_BUCKETS[i]]) return 'active';
        }
        // Nothing is running, but a turn finished in here and nobody has
        // looked. Below activity on purpose - see the module header.
        if (present.unread) return 'unread';
        if (winner === 'unknown') return 'dim';
        // Read and at rest, which the row paints as a still ring in the
        // dot's own grey rather than as no ring at all.
        if (winner === 'done') return 'steady';
        return 'off';
    }

    /**
     * Summarise a set of sessions into one LED state plus a count.
     *
     * Description: PURE. Takes session rows of either shape (a server
     *   row spelling the state `activity_status`, or a merged sidebar
     *   row spelling it `status` - `signalsFor` reconciles the two),
     *   resolves each through the single mapping in StatusLed, buckets
     *   them, and returns the highest-priority bucket present along with
     *   how many children are unread. It reads the ROWS it is handed and
     *   never the DOM, which is what lets a COLLAPSED group - whose rows
     *   are deliberately absent from the markup - still report what is
     *   inside it.
     *
     *   AN EMPTY GROUP IS `unknown`, NOT `done`. A group with no children
     *   has not been measured as quiet; there is simply nothing in it,
     *   and rendering that as a calm green light would be the same false
     *   green this project keeps paying for elsewhere.
     * Inputs:
     *   children (Array|null) - session rows. Each may be
     *     `{activity_status|status, unread, startup_gate}`. Non-objects
     *     are skipped rather than throwing, so one malformed row cannot
     *     blank a whole header.
     * Output:
     *   Object - `{inner, outer, bucket, unreadCount, total}`.
     * Example:
     *   summarizeStates([{activity_status: 'idle', unread: true},
     *                    {activity_status: 'working'}])
     *   // {inner: 'working', outer: 'active', bucket: 'working',
     *   //  unreadCount: 1, total: 2}
     * Example:
     *   summarizeStates([{activity_status: 'question'},
     *                    {activity_status: 'working'}])
     *   // {inner: 'waiting-permission', outer: 'active', ...} - the dot
     *   // is the parked session, the ring is the busy one
     */
    function summarizeStates(children) {
        const rows = Array.isArray(children) ? children : [];
        const present = Object.create(null);
        let unreadCount = 0;
        let total = 0;
        // See the `input` bucket note in the loop below.
        let inputIsStopped = false;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || typeof row !== 'object') continue;
            total += 1;
            const led = globalThis.StatusLed.ledStateFor(signalsFor(row));
            const bucket = bucketFor(led);
            present[bucket] = true;
            // ONE BUCKET, TWO HUES. The `input` bucket holds both
            // `waiting-input` (stopped on a startup prompt, yellow) and
            // `notice` (still working, wants a look, light blue). The
            // bucket's RANK is the same for both - that is the product
            // decision and it does not move - but the header still has
            // to paint one of them, and a header that disagrees with its
            // only child is a bug this suite already guards. Yellow wins
            // inside the bucket, because a stopped session is the one
            // that will not move until someone goes to it.
            if (bucket === 'input' && led.inner === 'waiting-input') {
                inputIsStopped = true;
            }
            // Counted off the ROW's flag, not off the light: a working
            // session with an unread Stop buckets as `working` but is
            // still one unread thing waiting for the user, and the badge
            // is a count of those, not a count of green dots.
            if (row.unread) unreadCount += 1;
        }

        if (total === 0) {
            return {
                inner: 'unknown',
                outer: 'dim',
                bucket: 'unknown',
                unreadCount: 0,
                total: 0,
            };
        }

        for (let i = 0; i < SUMMARY_PRIORITY.length; i++) {
            const entry = SUMMARY_PRIORITY[i];
            if (present[entry.key]) {
                const inner =
                    entry.key === 'input' && !inputIsStopped
                        ? 'notice'
                        : entry.inner;
                return {
                    inner: inner,
                    outer: outerFor(present, entry.key),
                    bucket: entry.key,
                    unreadCount: unreadCount,
                    total: total,
                };
            }
        }

        // Unreachable: bucketFor always returns one of the keys above.
        // Returned rather than thrown so a future bucket added to one
        // table and not the other degrades to not-measured instead of
        // taking down the sidebar render.
        return {
            inner: 'unknown',
            outer: 'dim',
            bucket: 'unknown',
            unreadCount: unreadCount,
            total: total,
        };
    }

    /**
     * The summary LED, as one HTML string.
     *
     * Description: What a group header and the launchpad top bar both
     *   render. The unread count is not shown as a visible badge - the
     *   LED's inner dot already carries that state (see `bucketFor` and
     *   SUMMARY_PRIORITY) - but it is still folded into the LED's title
     *   and aria-label so the count survives for screen readers and
     *   hover text. Copy is lowercase and plain, per the project's voice.
     * Inputs:
     *   children (Array|null) - as summarizeStates.
     *   opts (Object|null) - `{size}` forwarded to ledHtml.
     * Output:
     *   string - HTML: one `.status-led`.
     * Example:
     *   summaryHtml([{activity_status: 'idle', unread: true}])
     *   // '<span class="status-led" data-inner="done" data-outer="unread"
     *   //   title="unread - 1 session, 1 unread" ...></span>'
     */
    function summaryHtml(children, opts) {
        const o = opts || {};
        const s = summarizeStates(children);
        let label =
            s.total === 0
                ? 'no sessions'
                : s.bucket + ' - ' + s.total + ' session' + (s.total === 1 ? '' : 's');
        if (s.unreadCount > 0) {
            label += ', ' + s.unreadCount + ' unread';
        }
        return globalThis.StatusLed.ledHtml({
            inner: s.inner,
            outer: s.outer,
            size: o.size,
            title: label,
        });
    }

    const api = {
        SUMMARY_PRIORITY: SUMMARY_PRIORITY.slice(),
        summarizeStates: summarizeStates,
        summaryHtml: summaryHtml,
        bucketFor: bucketFor,
        outerFor: outerFor,
        signalsFor: signalsFor,
    };

    globalThis.SessionStatusSummary = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[SessionStatusSummary Module] Loaded');
})();
