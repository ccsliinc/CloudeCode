/**
 * ToastManager, grouping half - severity, the visible-card cap, and the
 * coalesce-into-one-card-per-session fold.
 *
 * WHY THIS IS A SEPARATE FILE, and why it extends the prototype rather
 * than subclassing: the same reasons client/js/api-toasts.js gives for
 * `API.prototype`. `window.ToastManager` is one instance built at the end
 * of client/js/toast.js and every toast call site holds it; a second
 * singleton would give the app two toast models disagreeing about what
 * is on screen. `Object.assign(ToastManager.prototype, ...)` leaves every
 * call site untouched.
 *
 * LOAD ORDER IS LOAD-BEARING: this file MUST come after toast.js.
 * `class ToastManager` is not hoisted across scripts, so loading it first
 * throws a ReferenceError at parse time - see the guard below.
 *
 * WHAT LIVES HERE, and why together: `_severity` and `_cap` are the two
 * inputs the coalescing decision is made from; `_groupKeyFor` and `_pick`
 * decide which card a toast lands on and which member of that card wins;
 * `_groups` is the fold that turns the live set into render groups; and
 * `_countBySeverity` answers "how many of these are the urgent kind",
 * which both the dismiss-all control and the overflow row need. All six
 * read `this._byId` and the registry constants (`TOAST_SEVERITY`,
 * `SEVERITY_DEFAULT`, `CAP_DESKTOP`, `CAP_NARROW`, `COALESCE_KEY`)
 * declared in toast.js, none of them touch the DOM, and moving them here
 * verbatim is a pure relocation: no line of logic changed.
 *
 * This split is issue #55: toast.js had grown past the repo's 1000-line
 * guideline. Reading the file, this was one of the three seams that
 * already stood apart - grouping and coalescing, rendering, and
 * lifecycle - so it becomes its own file rather than the whole module
 * growing further.
 */

console.log('[ToastGrouping Module] Loading...');

if (typeof ToastManager !== 'function') {
    // A named refusal, not a silent no-op. Loading this before toast.js is
    // a script-order mistake and must say so rather than leaving these six
    // methods quietly absent, which would render as every toast falling
    // back to a group of one with no severity ordering.
    throw new Error(
        'toast-grouping.js loaded before toast.js - class ToastManager is '
        + 'not defined. Fix the script order in client/index.html.'
    );
}

Object.assign(ToastManager.prototype, {
    /**
     * Severity for a toast kind.
     * Inputs: kind (string).
     * Output: number - higher is more urgent.
     */
    _severity(kind) {
      const s = TOAST_SEVERITY[kind];
      return typeof s === 'number' ? s : SEVERITY_DEFAULT;
    },

    /** Output: number - how many cards may render before overflow. */
    _cap() {
      const narrow = !!(this._narrowQuery && this._narrowQuery.matches);
      return narrow ? CAP_NARROW : CAP_DESKTOP;
    },

    /**
     * Which card a toast belongs on.
     *
     * A LOCAL RECEIPT IS ASKED ABOUT FIRST, because it is the one kind
     * that must NOT join the session's status card - see COALESCE_KEY.
     * Everything else is a session status event and gets the session's one
     * card.
     *
     * Inputs: toast (object) - server-shape toast.
     * Output: string|null - a group key, or null for "a card of its own".
     * Example: _groupKeyFor({session_id: 'ses_1', kind: 'Stop'})
     *          -> 'ses_1|session'
     */
    _groupKeyFor(toast) {
      const keyFn = COALESCE_KEY[toast.kind];
      if (typeof keyFn === 'function') return keyFn(toast);
      const grouper = globalThis.ToastSessionGroup;
      if (grouper && typeof grouper.groupKey === 'function') {
        return grouper.groupKey(toast);
      }
      return null;
    },

    /**
     * Which member of a group the card shows, and how many of its kind.
     *
     * Delegated to client/js/toast-session-group.js, which owns the join
     * from a hook event name to the project's one attention order. The
     * fallback - the newest member, whole group counted - is exactly right
     * for a single-kind group, the only shape a group can have when that
     * module is missing.
     *
     * Inputs: toasts (Array) - one group's members, arrival ordered.
     * Output: {winner: object, count: number}.
     */
    _pick(toasts) {
      const grouper = globalThis.ToastSessionGroup;
      if (grouper && typeof grouper.pick === 'function') {
        const picked = grouper.pick(toasts, (kind) => this._severity(kind));
        if (picked && picked.winner) return picked;
      }
      return { winner: toasts[toasts.length - 1], count: toasts.length };
    },

    /**
     * Collapse the live toast set into render groups.
     *
     * Output: Array of { key, toasts: [...], winner, count, badgeCount,
     *   severity }, sorted severity-desc then newest-first. `winner` is
     *   the toast whose title, body and colour the card shows; `count` is
     *   every record the card would clear; `badgeCount` is how many of
     *   them are the same kind as the winner, which is what the ×n badge
     *   beside the winner's title may honestly claim.
     */
    _groups() {
      const order = new Map();
      let idx = 0;
      for (const id of this._byId.keys()) order.set(id, idx++);
      const byKey = new Map();
      const singles = [];
      for (const toast of this._byId.values()) {
        const key = this._groupKeyFor(toast);
        if (!key) {
          singles.push({ key: `id:${toast.id}`, toasts: [toast] });
          continue;
        }
        const existing = byKey.get(key);
        if (existing) existing.toasts.push(toast);
        else byKey.set(key, { key, toasts: [toast] });
      }
      const groups = [...byKey.values()].concat(singles).map((g) => {
        const picked = this._pick(g.toasts);
        return {
          key: g.key,
          toasts: g.toasts,
          winner: picked.winner,
          count: g.toasts.length,
          badgeCount: picked.count,
          // The WINNER's severity, which is also the group's highest: the
          // attention order never ranks a bucket above one that can hold a
          // more severe kind, so the card cannot be handed to a quieter
          // event than something it is hiding.
          severity: this._severity(picked.winner.kind),
        };
      });
      // Severity first so an actionable card is never below chatter; then
      // newest-first so the most recent thing in a tier reads at the top.
      groups.sort((a, b) => {
        if (b.severity !== a.severity) return b.severity - a.severity;
        return order.get(b.winner.id) - order.get(a.winner.id);
      });
      return groups;
    },

    /**
     * How many TOASTS across these groups their own kind marks at or above
     * a severity. Per RECORD, never per group: a group is a whole session's
     * pile now, so summing group counts would report every `Stop` behind a
     * permission prompt as a permission prompt, and a disclosure that
     * overstates is worse than none.
     *
     * Inputs: groups (Array) from `_groups()`; min (number) - inclusive
     *   floor; exact (boolean) - count only severity === min.
     * Output: number.
     * Example: _countBySeverity(groups, 3) -> 1
     */
    _countBySeverity(groups, min, exact = false) {
      let n = 0;
      for (const group of groups) {
        for (const toast of group.toasts) {
          const sev = this._severity(toast.kind);
          if (exact ? sev === min : sev >= min) n += 1;
        }
      }
      return n;
    },
});
