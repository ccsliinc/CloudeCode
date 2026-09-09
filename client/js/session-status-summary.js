/**
 * Session status summary - roll a set of sessions up into ONE LED.
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
 *   permission > input > working > unread > idle > dead > unknown
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
 * outranks the two quiet states for the same reason. `idle` (the gray
 * read/at-rest dot) sits below `unread` and above `dead`: a group with
 * one unread and ten idle still bubbles unread, and a group of nothing
 * but idle sessions reads idle rather than falling all the way to
 * unknown. Dead sits BELOW both deliberately: a dead pane in a group of
 * live ones is not the headline, and hoisting it would make a group with
 * one corpse and nine busy sessions read as dead. Unknown is last
 * because it is the absence of a measurement, and any measured state is
 * more informative than no measurement.
 *
 * THE `done` BUCKET IS GONE, 2026-09-09, and it did not lose a meaning.
 * It used to mean "finished and already read" while `unread` meant
 * "finished and not"; the inner dot now spells that difference itself
 * (`idle` grey versus `done` green), so `done`-as-read IS `idle` and a
 * separate bucket for it could never be reached.
 *
 * AND THE HEADER'S RING IS ITS OWN QUESTION. The inner dot is the
 * highest-priority state in the group; the outer ring is ACTIVITY across
 * the group, computed independently by `outerFor` - active if anything
 * in there is moving, steady if anything is a live turn waiting on the
 * user, off otherwise. So a group holding one working session and one
 * parked one paints the parked dot inside a breathing ring, which is
 * both facts at once and is the whole point of having two rings. Taking
 * the ring off the winning bucket's row instead would have hidden the
 * work behind the more urgent dot.
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
        { key: 'idle', inner: 'idle' },
        { key: 'dead', inner: 'dead' },
        { key: 'unknown', inner: 'unknown' },
    ];

    /**
     * Buckets that mean "something is RUNNING in this group right now".
     * @type {string[]}
     */
    const ACTIVE_BUCKETS = ['working'];

    /**
     * Buckets that mean "a live turn in this group is stopped, waiting on
     * the user". Lit, but not moving - the same claim the row-level ring
     * makes for `question`, `notice` and an unanswered startup prompt.
     * @type {string[]}
     */
    const STEADY_BUCKETS = ['permission', 'input'];

    /**
     * Which summary bucket one child's (inner, outer) pair falls into.
     *
     * Description: The bucket is derived from the LED state the child
     *   ALREADY resolved to, not from its raw `activity_status`. That is
     *   deliberate: the header then cannot disagree with the rows under
     *   it, because both are reading the same value - and it is why the
     *   startup gate lands in `input` for free, without this function
     *   knowing the gate exists. It reads the INNER dot only: the ring
     *   carries activity, folded separately by `outerFor`, so a working
     *   session with an unread Stop still buckets as `working` (it is
     *   moving) while a resting one with the same flag buckets as
     *   unread.
     * Inputs:
     *   led (Object|null) - `{inner, outer}` from StatusLed.ledStateFor.
     * Output:
     *   string - one of the SUMMARY_PRIORITY keys.
     * Example:
     *   bucketFor({inner: 'done', outer: 'off'}) -> 'unread'
     * Example:
     *   bucketFor({inner: 'idle', outer: 'off'}) -> 'idle'
     */
    function bucketFor(led) {
        const l = led || {};
        if (l.inner === 'waiting-permission') return 'permission';
        if (l.inner === 'waiting-input') return 'input';
        if (l.inner === 'working') return 'working';
        // `done` IS unread. The ring used to be what said so, and reading
        // it here is what tied this fold to a ring that has since stopped
        // talking about unread at all - see the module header.
        if (l.inner === 'done') return 'unread';
        if (l.inner === 'idle') return 'idle';
        if (l.inner === 'dead') return 'dead';
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
     * Inputs:
     *   present (Object) - a set of bucket keys seen, as a map to true.
     *   winner (string) - the bucket the fold selected.
     * Output:
     *   string - a member of StatusLed.OUTER_STATES.
     * Example:
     *   outerFor({working: true, permission: true}, 'permission') -> 'active'
     */
    function outerFor(present, winner) {
        for (let i = 0; i < ACTIVE_BUCKETS.length; i++) {
            if (present[ACTIVE_BUCKETS[i]]) return 'active';
        }
        for (let i = 0; i < STEADY_BUCKETS.length; i++) {
            if (present[STEADY_BUCKETS[i]]) return 'steady';
        }
        return winner === 'unknown' ? 'dim' : 'off';
    }

    /**
     * Summarise a set of sessions into one LED state plus a count.
     *
     * Description: PURE. Takes the raw server rows (each carrying
     *   `activity_status`, `unread` and optionally `startup_gate`),
     *   resolves each through the single mapping in StatusLed, buckets
     *   them, and returns the highest-priority bucket present along with
     *   how many children are unread.
     *
     *   AN EMPTY GROUP IS `unknown`, NOT `done`. A group with no children
     *   has not been measured as quiet; there is simply nothing in it,
     *   and rendering that as a calm green light would be the same false
     *   green this project keeps paying for elsewhere.
     * Inputs:
     *   children (Array|null) - session rows. Each may be
     *     `{activity_status, unread, startup_gate}`. Non-objects are
     *     skipped rather than throwing, so one malformed row cannot blank
     *     a whole header.
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

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || typeof row !== 'object') continue;
            total += 1;
            const led = globalThis.StatusLed.ledStateFor(row);
            const bucket = bucketFor(led);
            present[bucket] = true;
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
                return {
                    inner: entry.inner,
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
     *   // '<span class="status-led" title="unread - 1 session, 1 unread" ...></span>'
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
    };

    globalThis.SessionStatusSummary = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[SessionStatusSummary Module] Loaded');
})();
