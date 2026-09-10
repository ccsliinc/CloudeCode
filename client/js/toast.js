/**
 * Toast Manager
 * ----------------------------------------------------------------------
 * Renders toast notifications surfaced by the server over the WebSocket
 * (toast.new / toast.ack frames) AND backfilled via the REST endpoint
 * on session attach. Per-toast accent color is sourced from the server's
 * project-theme resolution and applied as `style="--toast-accent: <hex>"`
 * on the toast element - the CSS picks it up as a left border.
 *
 * WHAT THESE TOASTS ARE, because it determines everything below: they are
 * NOT ephemeral snackbars. There is no dwell timer anywhere in this file
 * and there deliberately still is not one. A toast is a server-backed
 * record that survives a reload, is re-delivered by the attach backfill,
 * and disappears only when ACKED. An auto-dismiss would have to either
 * auto-ack (silently destroying a PermissionRequest the user never saw)
 * or hide-without-acking (a ghost that returns on the next attach). Both
 * are worse than a tall stack. Hover-to-pause is likewise moot with no
 * timer to pause.
 *
 * THE PILE-UP, and where it comes from. Every emitter is a Claude Code
 * hook (src/core/claude_hooks.py TOAST_EVENTS) and exactly one of the
 * three is chatty: `Stop` fires once per assistant turn, always with the
 * literal title "Your turn". A ten-turn session is ten identical cards
 * nobody acked. `Notification` is occasional; `PermissionRequest` is rare
 * and is the one the user actually has to act on.
 *
 * SO THE STACKING POLICY IS THREE RULES, each declared rather than
 * inferred:
 *
 *   1. COALESCE into ONE CARD PER SESSION, with a count. The
 *      pre-existing dedupe is by `id` only - that covers the
 *      backfill/WS race and nothing else. Ten `Stop` events are ten
 *      distinct ids saying one thing.
 *   2. CAP the number of visible cards and put the rest behind ONE
 *      overflow row that states how many it is holding and the worst
 *      severity in there. Nothing is dropped and nothing is auto-acked:
 *      an overflowed toast is still unacked on the server, still in
 *      `_byId`, still counted on screen, and one click from view.
 *   3. TIER by severity. High-severity groups sort to the top AND are
 *      exempt from the cap entirely - the cap exists to suppress noise,
 *      and a blocking permission prompt is not noise. So a
 *      PermissionRequest can never be the thing hidden behind "+7 more".
 *
 * WHICH EVENT THE ONE CARD SHOWS. Rule 1 keyed on (kind, session) until
 * 2026-09-09, so one session produced one card per kind - a "Your turn"
 * card AND a "wants your attention" card, side by side, about the same
 * session; four cards for two sessions, measured on the owner's screen.
 * The key is the SESSION alone now, and the winner is chosen by the fold
 * this project already writes down once, `SUMMARY_PRIORITY` in
 * client/js/session-status-summary.js - the same order the sidebar group
 * headers and the launchpad top bar use. The join from a hook event name
 * to one of its buckets, and the reasoning for each mapping, is in
 * client/js/toast-session-group.js. There is NO second ranking here.
 *
 * THE CARD UPGRADES AND CANNOT DOWNGRADE, because `_groups()` is a pure
 * FOLD over the live set rather than a running "current worst" variable.
 * A permission prompt landing on a session showing "your turn"
 * re-answers the fold on the SAME group key, so the SAME element becomes
 * the permission card; a later `Stop` cannot take it back. Hook events
 * arrive unordered, duplicated and droppable, and a fold over what is
 * held is idempotent against all three.
 *
 * NEVER SILENTLY LOSE SOMETHING THE USER NEEDED. Every suppression path
 * above stays reachable: the cap holds a live, counted, one-click set and
 * exempts high severity; a coalesced card carries every member id and
 * acks all of them on dismiss, so no member is orphaned server-side; and
 * nothing in this file expires on a timer.
 *
 * Dismiss flow:
 *   - User clicks x  -> fade-out animation -> POST to
 *     /api/v1/toasts/<id>/ack for EVERY member of the group -> server
 *     broadcasts toast.ack -> other tabs dismiss in lockstep (with
 *     syncToServer=false to skip the round-trip).
 *   - Server-driven ack (from another browser) -> dismiss(id, {syncToServer:
 *     false}) - no echo back to the server.
 *   - User clicks the card's session name -> the SAME switch a sidebar row
 *     click runs, PLUS this same ack-every-member teardown: arriving at the
 *     session is what a card exists to prompt, so the click also retires it.
 *
 * NO CARD FOR THE SESSION ON SCREEN, in either direction. `add()` refuses a
 * toast whose session is the one `SessionSidebar` says is currently active
 * (`_isActiveSession`) - if the user is looking at it, whatever the toast
 * says is already visible in the live terminal. And switching INTO a
 * session (`SessionSidebar.setActiveSession`) clears whatever card was
 * still showing for it via `dismissForSessionEntry`, because a card that
 * arrived while the user was elsewhere is stale the instant they arrive.
 * Both read/write the identical (sessionId, tmuxName) pair app.js already
 * sets before the WS connects, so there is no second flag and no race
 * against the attach backfill. The one exception is the attachment
 * receipt (`toast.local`), which is not a session-status event at all and
 * keeps rendering for the active session exactly as it always has.
 *
 * No localStorage cross-tab sync; the WS broadcast is the source of truth
 * for ack propagation.
 */

console.log('[Toast Module] Loading...');

/**
 * Severity per toast kind. Drives sort order, cap exemption, and the
 * ARIA live-region politeness of the rendered card.
 *
 * PermissionRequest is HIGH because it is blocking: Claude is stopped
 * until the user answers. Notification is MEDIUM: Claude is waiting on
 * input but the card itself is not the decision. Stop is LOW: "your
 * turn" is information the terminal in front of the user already shows.
 */
/**
 * The one CLIENT-raised toast kind. Every other kind in this file comes
 * from a Claude Code hook by way of the server
 * (src/core/claude_hooks.py TOAST_EVENTS); this one is raised in the
 * browser when the user attaches a file to the prompt, and there is no
 * server record behind it.
 *
 * It is declared HERE, beside the severity and coalesce rules that
 * govern it, because this file is the registry of what a toast kind
 * means. client/js/attachment-toast.js produces the record and reads
 * the name back off `ToastManager.ATTACHMENT_KIND` rather than
 * repeating the string, so the two cannot drift.
 */
const ATTACHMENT_KIND = 'Attachment';

/**
 * Kinds that a keystroke must NOT clear. See
 * `dismissForSessionActivity`, which is where the reasoning lives.
 */
const SURVIVES_TYPING = new Set([ATTACHMENT_KIND]);

const TOAST_SEVERITY = {
  PermissionRequest: 3,
  // punchlist 19 - a session parked on an unanswered startup prompt
  // (folder trust, login). HIGH for the same reason PermissionRequest is:
  // it is blocking, and unlike a PermissionRequest the user cannot see it
  // by glancing at the terminal - the whole defect is that the session
  // looked connected. Being HIGH also makes it cap-exempt, so it can
  // never be the thing hidden behind "+3 more".
  StartupPrompt: 3,
  Notification: 2,
  Stop: 1,
  // LOW, and lower than it may look like it deserves. This card is a
  // receipt for something the user did one second ago and can see in
  // their own prompt buffer; it is not news. Low severity keeps it
  // cap-eligible, so a stack of attachments can be pushed behind the
  // overflow row rather than burying a permission prompt - which is the
  // exact failure the tiering exists to prevent.
  [ATTACHMENT_KIND]: 1,
};
const SEVERITY_DEFAULT = 2; // an unknown future kind is not assumed harmless

/** Groups at or above this severity are never pushed into overflow. */
const CAP_EXEMPT_SEVERITY = 3;

/** Visible card cap, before the exemption above raises it. */
const CAP_DESKTOP = 3;
const CAP_NARROW = 2; // a phone screen is mostly toast at 3+
const NARROW_QUERY = '(max-width: 640px)'; // matches toast.css's breakpoint

/**
 * Per-kind coalescing, for the kinds the session grouping must NOT take.
 *
 * THE LOCAL RECEIPT IS THE ONLY ENTRY. It is not a session status event:
 * it describes what is staged in the prompt buffer, has no server
 * record, and is retired by the prompt being SENT rather than by the
 * user showing up. Folded into the status card, a picture of a staged
 * file would sit under a heading reading "wants your attention" and a
 * keystroke rule would retire the wrong thing. It coalesces on the
 * SESSION alone, so four files on one prompt are ONE card carrying four
 * thumbnails, and nothing is hidden by that: the card draws every member
 * (AttachmentToast.renderThumbs), so no filename is lost behind an "x4".
 *
 * Every other kind is grouped by session in `_groupKeyFor`, so the
 * per-kind rules that used to live here are gone rather than sitting
 * beside a rule that supersedes them. A kind absent from this table and
 * refused by the session grouping (no session id, or no attention order
 * loaded) simply gets a card of its own - noisy, never wrong.
 *
 * Inputs: toast (object) - server-shape toast.
 * Output: string|null - the coalesce key, or null for "never coalesce".
 * Example: COALESCE_KEY.Attachment({session_id:'s'}) -> 's|Attachment'
 */
const COALESCE_KEY = {
  [ATTACHMENT_KIND]: (t) => `${t.session_id}|${ATTACHMENT_KIND}`,
};

class ToastManager {
  constructor(containerId = 'toast-container') {
    this.containerId = containerId;
    /** The client-raised kind, read by client/js/attachment-toast.js. */
    this.ATTACHMENT_KIND = ATTACHMENT_KIND;
    /** id -> server-shape toast. Insertion-ordered = arrival-ordered. */
    this._byId = new Map();
    /**
     * id -> epoch ms this card was first seen HERE. Read only by
     * `reconcileOpen`, to tell a card the server has closed from one the
     * server has not heard of yet because it arrived after the poll
     * snapshot was taken. Injectable clock so the rule is testable
     * without waiting for one.
     */
    this._addedAt = new Map();
    this._now = () => Date.now();
    /** User expanded the overflow row; the cap is suspended until reset. */
    this._expanded = false;
    /** Set true once the container has had its live-region attrs applied. */
    this._containerPrepared = false;
    this._narrowQuery = null;
    this._bindViewportWatch();
  }

  /**
   * Re-render when the viewport crosses the narrow breakpoint, because
   * the cap differs on either side of it and a stale cap would render a
   * count the overflow row contradicts.
   * Output: None.
   */
  _bindViewportWatch() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    try {
      this._narrowQuery = window.matchMedia(NARROW_QUERY);
      const onChange = () => this._render();
      if (typeof this._narrowQuery.addEventListener === 'function') {
        this._narrowQuery.addEventListener('change', onChange);
      } else if (typeof this._narrowQuery.addListener === 'function') {
        this._narrowQuery.addListener(onChange); // Safari < 14
      }
    } catch (err) {
      // No matchMedia (test stub, ancient browser): fall back to the
      // desktop cap. Reported, never swallowed silently.
      console.warn('[Toast] viewport watch unavailable:', err && err.message);
    }
  }

  /**
   * Resolve the container element. Late-bound so the class can be
   * constructed before DOMContentLoaded - we look it up at first use.
   * Returns null if absent (e.g. on a page that doesn't include the
   * container markup); callers MUST guard for null.
   */
  _container() {
    const el = document.getElementById(this.containerId);
    if (el && !this._containerPrepared) {
      // Polite by default; an individual high-severity card upgrades
      // itself to role="alert" so a permission prompt interrupts.
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-relevant', 'additions text');
      this._containerPrepared = true;
    }
    return el;
  }

  /**
   * Severity for a toast kind.
   * Inputs: kind (string).
   * Output: number - higher is more urgent.
   */
  _severity(kind) {
    const s = TOAST_SEVERITY[kind];
    return typeof s === 'number' ? s : SEVERITY_DEFAULT;
  }

  /** Output: number - how many cards may render before overflow. */
  _cap() {
    const narrow = !!(this._narrowQuery && this._narrowQuery.matches);
    return narrow ? CAP_NARROW : CAP_DESKTOP;
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * Is a toast about the session the user is looking at RIGHT NOW.
   *
   * THE SINGLE SOURCE OF TRUTH IS SessionSidebar, not a second flag kept
   * here. app.js calls `SessionSidebar.setActiveSession(sessionId,
   * tmuxName)` on every navigation into a terminal - and with (null,
   * null) on the way out to the launchpad or archive - synchronously,
   * BEFORE `TerminalController.connectToSession` opens the WS or
   * requests the attach backfill. `session-sidebar-clicks.js` already
   * reuses the identical pair (`ctrl._activeTmuxName`) for the same
   * question on a self-click, so this is the second reuse, not a new
   * flag: inventing a local copy would be one more thing to forget to
   * clear on the way to the launchpad.
   *
   * NO RACE. Because the flag is set BEFORE the WS/backfill that could
   * feed a toast for that very session, every `add()` call for it -
   * whether the live `toast.new` frame or the attach backfill - already
   * sees the session as active by the time it runs. Hook events arrive
   * unordered, duplicated and droppable; this reads live state on every
   * call rather than latching anything, so a duplicate or a late arrival
   * answers exactly the same as the first.
   *
   * MATCHED ON EITHER id or tmux name, never both required: a toast
   * recorded before the server carried identity may carry only one.
   *
   * Inputs: toast (object) - server-shape toast.
   * Output: boolean.
   */
  _isActiveSession(toast) {
    const sidebar = window.SessionSidebar;
    if (!sidebar || !toast) return false;
    const sid = toast.session_id;
    const name = toast.session_name;
    if (sid && sidebar._activeSessionId && sid === sidebar._activeSessionId) return true;
    if (name && sidebar._activeTmuxName && name === sidebar._activeTmuxName) return true;
    return false;
  }

  /**
   * Add a toast to the UI.
   * @param {object} toast - shape: { id, session_id, kind, title, body,
   *   color, created_at, acknowledged }
   */
  add(toast) {
    if (!toast || !toast.id) return;
    if (toast.acknowledged) return; // server says already done; don't show
    if (!this._container()) return;
    // NEVER A CARD FOR THE SESSION ON SCREEN. If the user is looking at
    // it, whatever the toast says is already visible in the terminal
    // itself - a card would be telling them something they can see with
    // their own eyes. `toast.local` is excluded: the attachment receipt
    // (client/js/attachment-toast.js) is raised for the session the user
    // is TYPING into, which is normally this same active session, and it
    // is not a session-status event at all (see COALESCE_KEY) - it must
    // keep rendering exactly as it always has.
    if (!toast.local && this._isActiveSession(toast)) return;
    // A KNOWN ID IS EITHER A DUPLICATE OR A SUPERSESSION, AND THE
    // DIFFERENCE IS IN THE CONTENT, NOT THE ID.
    //
    // The server replaces an unacked `Stop` in place and keeps its id
    // (SessionManager.record_toast), then broadcasts the replaced record.
    // So the same id can legitimately arrive again carrying a NEWER body
    // for the same turn-ended event. Returning early on a known id - the
    // old dedupe - kept the card showing the FIRST turn's transcript tail
    // for the rest of the session while the server held the newest.
    //
    // Refreshing in place is the whole handling: `Map.set` on an existing
    // key preserves insertion position, so arrival order (which drives
    // within-tier sort) does not change, the card is not re-created, and
    // the id the user will ack is the id the server holds. The
    // backfill/WS race this branch was written for still resolves to one
    // card, because re-storing identical content renders identically.
    if (this._byId.has(toast.id)) {
      this._byId.set(toast.id, toast);
      this._render();
      return;
    }
    this._byId.set(toast.id, toast);
    // WHEN THIS CARD BECAME OURS. Read by `reconcileOpen` and by nothing
    // else: a poll response is a SNAPSHOT of the server taken when the
    // request left, so a card that arrived after that instant is
    // legitimately absent from it and must not be treated as closed. The
    // stamp is set only on first sight, so a supersession refreshing the
    // record in place above does not reset a card's age.
    this._addedAt.set(toast.id, this._now());
    this._render();
  }

  /**
   * Reconcile the local card set against the server's OPEN set, removing
   * cards the server no longer lists.
   *
   * WHY THIS EXISTS. `backfill` only ever ADDS. That was correct while
   * the only thing that could close a toast was a click in this browser
   * (which removes the card locally) or a click in another tab (which
   * arrives as a `toast.ack` frame). Neither is true any more: the
   * server now closes toasts by itself when a hook says the user turned
   * up - see src/core/toast_auto_ack.py - and a surface holding no
   * WebSocket for the raising session has no frame to hear that on. Its
   * only channel is the poll, and a poll that can only add is a card
   * that never leaves.
   *
   * THE GUARD IS THE MIRROR OF ToastDismissedRing'S. That ring stops a
   * card the user just dismissed coming BACK from a snapshot taken
   * before the ack landed. This is the same race pointing the other way:
   * a `toast.new` frame that arrived AFTER the poll request left is
   * absent from the response through no fault of its own, and removing
   * it would delete a card the server does hold. So a card is removed
   * only when the snapshot is NEWER than the card. A card younger than
   * the snapshot survives until a later tick can speak to it.
   *
   * IT NEVER ACKS. Every id removed here is one the server has already
   * closed, so syncing an ack back would be a write with nothing to
   * change, aimed at a record that may belong to a session this browser
   * is not attached to. Removal is a rendering fact only.
   *
   * @param {Array} openToasts - the server's open set, raw (server-shape
   *   objects or bare ids). NOT the ring-filtered list: an id the ring
   *   is suppressing is one this browser already dropped, so subtracting
   *   it from the open set would only make a no-op removal look real.
   * @param {object} [opts]
   * @param {number} [opts.since] - epoch ms at which the snapshot was
   *   requested. Cards added at or after this are spared. Omitting it
   *   means "this set is authoritative right now", which is only true
   *   for a caller that has no request instant to offer.
   * @returns {number} how many cards were removed.
   * Example: ToastManager.reconcileOpen([{id: 'a'}], {since: t}) -> 1
   */
  reconcileOpen(openToasts, { since } = {}) {
    if (!Array.isArray(openToasts)) return 0;
    const open = new Set();
    for (const entry of openToasts) {
      if (!entry) continue;
      const id = (typeof entry === 'string') ? entry : entry.id;
      if (id) open.add(id);
    }
    const stale = [];
    for (const id of this._byId.keys()) {
      if (open.has(id)) continue;
      if (since !== undefined && since !== null) {
        const addedAt = this._addedAt.get(id);
        // No stamp means the card predates this bookkeeping (a manager
        // built before the field, or a card injected by a test). Treat
        // it as old enough to reconcile rather than pinning it forever.
        if (addedAt !== undefined && addedAt >= since) continue;
      }
      stale.push(id);
    }
    for (const id of stale) this.dismiss(id, { syncToServer: false });
    return stale.length;
  }

  /**
   * Remove a toast from the UI, optionally syncing the ack to the server.
   * @param {string} toastId
   * @param {object} [opts]
   * @param {boolean} [opts.syncToServer=true] - POST /toasts/<id>/ack.
   *   Set false when this dismiss was triggered BY a server toast.ack
   *   frame (i.e. another browser already acked, we're just rendering).
   */
  dismiss(toastId, { syncToServer = true } = {}) {
    const toast = this._byId.get(toastId);
    if (!toast) return;
    this._byId.delete(toastId);
    // Drop the age stamp with the card, or a long-lived tab accumulates
    // one entry per notification it has ever shown.
    this._addedAt.delete(toastId);

    const el = this._cardFor(toastId);
    if (el) {
      el.classList.add('toast--dismissing');
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        this._render();
      }, 220); // slightly longer than the CSS transition (200ms)
    } else {
      this._render();
    }

    // A LOCAL TOAST HAS NOTHING TO ACK. Acking is how a dismissal is
    // made to stick against a SERVER record, and an attachment toast has
    // no such record - its id was minted in this browser. POSTing it
    // would be a guaranteed 404 on every dismissal, which trains the
    // reader of that log to ignore a line that is supposed to mean
    // something. The flag is set by client/js/attachment-toast.js.
    if (syncToServer && toast && toast.session_id && !toast.local) {
      this._ack(toastId, toast.session_id);
    }

    // ANNOUNCE THE DISMISSAL, so the cross-session poller can suppress
    // this id until its ack lands. Raising went global in
    // toast-global-poll.js, which means a poll tick can now return a
    // snapshot taken BEFORE the ack above was applied - and feeding that
    // back through `add()` would resurrect the card the user just
    // dismissed, in front of them. The poller's ToastDismissedRing
    // listens for this and filters the id out for a minute.
    //
    // AN EVENT RATHER THAN A DIRECT CALL: this module must keep working
    // with no poller loaded (it did for three releases), and a hard
    // reference would make the poller a load-order dependency of every
    // dismissal path. Fired for BOTH sync values on purpose - a
    // server-driven ack from another tab is equally a reason not to
    // re-add the id here.
    try {
      document.dispatchEvent(new CustomEvent('cloude:toast-dismissed', {
        detail: { id: toastId, sessionId: toast ? toast.session_id : null },
      }));
    } catch (err) {
      // CustomEvent is unavailable in the node stub suites, which do not
      // exercise the poller. Swallowed rather than logged: it is not a
      // fault in a browser and the suites would print it on every case.
    }
  }

  /**
   * Patch a toast this browser raised itself, in place.
   *
   * The one writer is client/js/attachment-toast.js, filling in a
   * thumbnail that finished decoding after the card went up. It is
   * deliberately NOT a general `update`: `add()` already refreshes a
   * server toast in place, and a second write path into a server-owned
   * record would let the client hold content the server never sent.
   *
   * IT REFUSES A TOAST THAT IS GONE rather than re-adding it. By the
   * time an image has decoded the user may have sent the prompt, which
   * retires the card; re-creating it here would resurrect something
   * that was correctly dismissed, holding a picture of a file that is
   * no longer staged.
   *
   * Inputs: toastId (string); patch (object) - fields to merge.
   * Output: boolean - true when a live local toast was updated.
   */
  updateLocal(toastId, patch) {
    const toast = this._byId.get(toastId);
    if (!toast || !toast.local || !patch) return false;
    this._byId.set(toastId, Object.assign({}, toast, patch));
    this._render();
    return true;
  }

  /**
   * Dismiss every toast of ONE kind belonging to ONE session.
   *
   * The narrowest of the bulk dismissals, and it exists because the
   * attachment receipt has a lifecycle none of the others share: it is
   * retired by the prompt being SENT, an event that says nothing about
   * the notifications sitting beside it. Clearing them too would
   * destroy a permission prompt the user never read.
   *
   * Inputs: kind (string); sessionId (string).
   * Output: number - how many were dismissed.
   * Example: mgr.dismissKindForSession('Attachment', 'ses_1') -> 2
   */
  dismissKindForSession(kind, sessionId) {
    if (!kind || !sessionId) return 0;
    // Snapshot before mutating: `dismiss` deletes from the same Map.
    const ids = [];
    for (const [id, toast] of this._byId.entries()) {
      if (toast && toast.kind === kind && toast.session_id === sessionId) {
        ids.push(id);
      }
    }
    for (const id of ids) this.dismiss(id, { syncToServer: true });
    return ids.length;
  }

  /**
   * Dismiss every member of a coalesced group. Each member is acked
   * individually so no id is orphaned unacked on the server, which would
   * resurrect it on the next attach backfill.
   * Inputs: key (string) - a group key from `_groups()`.
   * Output: None.
   */
  dismissGroup(key) {
    const group = this._groups().find((g) => g.key === key);
    if (!group) return;
    for (const toast of group.toasts) {
      this.dismiss(toast.id, { syncToServer: true });
    }
  }

  /**
   * Fire-and-forget server ack.
   * Inputs: toastId (string), sessionId (string). Output: None.
   */
  _ack(toastId, sessionId) {
    if (window.API && typeof window.API.ackToast === 'function') {
      window.API.ackToast(toastId, sessionId).catch((err) => {
        // 404 / 500: log only - the local UI is already updated; a
        // failed server ack will simply re-deliver the toast on the
        // next attach backfill, which is acceptable degraded behavior.
        console.warn('[Toast] ack failed', err && err.message);
      });
    }
  }

  /**
   * The rendered card currently showing a given toast id, if any.
   * Inputs: toastId (string). Output: HTMLElement|null.
   */
  _cardFor(toastId) {
    const container = this._container();
    if (!container) return null;
    return container.querySelector(`.toast[data-toast-id="${toastId}"]`);
  }

  /**
   * Bulk dismiss every tracked toast for a given session id. Called
   * when a session is destroyed so the user doesn't see ghost toasts
   * referencing a dead session. Does NOT sync to the server - the
   * session is gone, the toasts are gone with it server-side.
   */
  dismissBySession(sessionId) {
    if (!sessionId) return;
    for (const [id, toast] of Array.from(this._byId.entries())) {
      if (toast && toast.session_id === sessionId) {
        this.dismiss(id, { syncToServer: false });
      }
    }
  }

  /**
   * Clear whatever session-status card is showing for a session the user
   * has just switched INTO. The counterpart to `_isActiveSession`'s gate
   * on `add()`: that stops a NEW card appearing for the active session,
   * this clears one that arrived EARLIER, while the session was not yet
   * active - e.g. it fired while the user was on a different session,
   * and they have now switched back into it. Called from
   * `SessionSidebar.setActiveSession`, the same place that sets the
   * active-session flag `_isActiveSession` reads, so a switch clears the
   * card in the same beat it stops a new one from appearing.
   *
   * SYNCS TO THE SERVER, unlike `dismissBySession`: that method assumes
   * the session was just DESTROYED, so acking would be a pointless round
   * trip to a row that is going away anyway. Here the session is exactly
   * as alive as it was a moment ago; the dismissal has to stick the same
   * way any other one does.
   *
   * EXCLUDES the local receipt, for the same reason `add()` does: it is
   * not a session-status event, and switching into a session must not
   * touch a pending attachment thumbnail.
   *
   * Inputs: sessionId (string|null), tmuxName (string|null).
   * Output: number - how many toasts were dismissed.
   * Example: ToastManager.dismissForSessionEntry('ses_1', 'cloude_x') -> 1
   */
  dismissForSessionEntry(sessionId, tmuxName) {
    if (!sessionId && !tmuxName) return 0;
    const ids = [];
    for (const [id, toast] of this._byId.entries()) {
      if (!toast || toast.local) continue;
      if ((sessionId && toast.session_id === sessionId)
          || (tmuxName && toast.session_name === tmuxName)) {
        ids.push(id);
      }
    }
    for (const id of ids) this.dismiss(id, { syncToServer: true });
    return ids.length;
  }

  /**
   * The user just sent real input to a session, so every toast ABOUT
   * that session has been answered by the only act that could answer it.
   *
   * WHY THIS IS NOT AN AUTO-DISMISS TIMER. The header above says there
   * is deliberately no dwell timer, and there still is not one. A timer
   * fires on the passage of time, which is no evidence at all about
   * whether the user handled anything. This fires on the ONE observable
   * that is evidence: bytes the user typed into that session's pty.
   *
   * WHY IT ACKS RATHER THAN HIDES. Hiding without acking leaves the
   * record unacked server-side, so the next attach backfill re-delivers
   * it and the card returns - the "ghost" failure the header names. The
   * ack is what makes the dismissal stick.
   *
   * WHY EVERY KIND, INCLUDING PermissionRequest. The three kinds differ
   * in urgency, not in what resolves them: a `Stop` says the turn ended,
   * a `Notification` says Claude is waiting on input, and a
   * PermissionRequest says Claude is BLOCKED waiting for the user to
   * answer a prompt on that session's pty. Input to that session is
   * literally the answer to the third and the response to the other two.
   * Keeping a blocking card up while the user types the answer into it
   * is the exact complaint this exists to fix. Note also what is not
   * being lost: the toast is a notification, never the decision surface
   * - the prompt itself is in the terminal the user is typing into.
   *
   * SCOPED TO ONE SESSION, and that is the whole safety property. A
   * toast about session A is evidence about session A; typing into
   * session B says nothing about it and must leave it alone.
   *
   * Inputs: sessionId (string) - the session the user typed into.
   * Output: number - how many toasts were dismissed (0 is the common
   *   case, and is why this is cheap to call per keystroke).
   * Example: ToastManager.dismissForSessionActivity('sess-1') -> 2
   */
  dismissForSessionActivity(sessionId, data) {
    if (!sessionId) return 0;
    // THE SECOND HALF OF THE SAME POLICY, dispatched from here because
    // this is where the policy is written. terminal.js is under a hard
    // line-count guard and, more to the point, "what does user input
    // retire" is one question with one home; splitting it across the
    // caller would put half the rule in a file whose docstring says it
    // keeps none of it.
    //
    // `data` is the bytes just sent, and it is OPTIONAL: four of the
    // five call sites are not keystrokes at all (focus, attach, session
    // entry, a synthesised write), and for those "was this a submit"
    // has no answer. attachment-toast.js reads undefined as "no", so
    // they clear notifications and leave receipts standing, which is
    // correct - entering a session does not send its prompt.
    //
    // The submit test lives THERE, not here: this file is the registry
    // of what a toast kind means and has no business knowing that
    // ESC+CR is a newline while a bare CR is a send.
    if (data !== undefined && window.AttachmentToast
        && typeof window.AttachmentToast.noteUserInput === 'function') {
      window.AttachmentToast.noteUserInput(sessionId, data);
    }
    // Snapshot before mutating: `dismiss` deletes from the same Map.
    const ids = [];
    for (const [id, toast] of this._byId.entries()) {
      if (!toast || toast.session_id !== sessionId) continue;
      // A RECEIPT IS NOT A NOTIFICATION, so typing does not answer it.
      //
      // Everything above turns on input being the ANSWER to a card. An
      // attachment receipt is the opposite relationship: it describes
      // what is staged in the prompt buffer the user is typing INTO, so
      // it is true for exactly as long as they keep typing. Clearing it
      // on the first keystroke would make it flash and vanish - a worse
      // version of the unreadable overlay it replaced. It is retired by
      // the prompt being SENT, through `dismissKindForSession`.
      if (SURVIVES_TYPING.has(toast.kind)) continue;
      ids.push(id);
    }
    for (const id of ids) this.dismiss(id, { syncToServer: true });
    return ids.length;
  }

  /**
   * Dismiss EVERY toast on screen, whatever session it belongs to.
   *
   * The explicit counterpart to `dismissForSessionActivity`. That one is
   * implicit and must therefore be narrow; this one is a deliberate
   * click on a control that says what it does, so it is deliberately
   * broad - a stack that piled up across four sessions is exactly the
   * case the user asked for a single control for.
   *
   * NOTHING IS EXEMPT, and that is a decision rather than an oversight.
   * The cap exempts PermissionRequest because the cap is an automatic
   * suppression the user never asked for; this is not. A button labelled
   * "Dismiss all" that silently left cards behind would read as broken,
   * and the user would click it twice looking for the bug. What keeps
   * this honest instead is disclosure: `_renderDismissAll` names the
   * blocking prompts in the control's own accessible label BEFORE the
   * click, so nothing is cleared unannounced. And a dismissed
   * PermissionRequest costs the notification only - the prompt itself is
   * still sitting in that session's terminal, and the session's own
   * status surface still shows it waiting.
   *
   * IT CLEARS, IT DOES NOT MUTE. There is no suppression flag anywhere
   * in this path: the next `add()` renders normally.
   *
   * Output: number - how many toasts were dismissed.
   */
  dismissAll() {
    const ids = Array.from(this._byId.keys());
    for (const id of ids) this.dismiss(id, { syncToServer: true });
    // The cap is a view state, not a toast; an emptied stack must not
    // come back expanded.
    this._expanded = false;
    return ids.length;
  }

  /**
   * Drop all UI state without ack. Used on full logout / page tear-down
   * paths where the server-side ack is irrelevant.
   */
  clearAll() {
    for (const id of Array.from(this._byId.keys())) {
      this.dismiss(id, { syncToServer: false });
    }
  }

  /**
   * Backfill from a list of server-shape toasts (e.g. on session attach).
   * Each is fed through ``add`` which dedupes by id - safe to call twice.
   */
  backfill(toasts) {
    if (!Array.isArray(toasts)) return;
    // Server returns newest-first; ingest OLDEST-first so Map insertion
    // order is arrival order, which is what `_arrivalIndex` reads.
    for (let i = toasts.length - 1; i >= 0; i--) {
      this.add(toasts[i]);
    }
  }

  // --------------------------------------------------------------- render

  /**
   * Rebuild the visible card set from the live toast model.
   *
   * Rebuild-from-model rather than imperative append: the cap, the
   * coalesce counts and the overflow row are all functions of the whole
   * set, so any single-element mutation can invalidate all three. A card
   * already on screen for the same group key is REUSED (its count and
   * body updated in place) so an unrelated arrival does not restart every
   * neighbour's entry animation.
   *
   * Output: None.
   */
  _render() {
    const container = this._container();
    if (!container) return;

    const groups = this._groups();
    const cap = this._cap();
    const exemptCount = groups.filter((g) => g.severity >= CAP_EXEMPT_SEVERITY).length;
    // The cap suppresses NOISE. It never hides a blocking prompt, so it
    // is raised to fit every exempt group before it applies to the rest.
    const naturalCap = Math.max(cap, exemptCount);
    // Whether expansion is MEANINGFUL is a question about the natural cap,
    // never about the expanded one: while expanded, nothing is hidden by
    // construction, so asking "is the hidden set empty?" after applying
    // the expansion collapses the row the instant the user opens it.
    if (groups.length <= naturalCap) this._expanded = false;

    const effectiveCap = this._expanded ? groups.length : naturalCap;
    const visible = groups.slice(0, effectiveCap);
    const hidden = groups.slice(effectiveCap);

    const keep = new Set(visible.map((g) => g.key));
    for (const el of Array.from(container.querySelectorAll('.toast'))) {
      if (!keep.has(el.dataset.groupKey) && !el.classList.contains('toast--dismissing')) {
        el.remove();
      }
    }

    // The dismiss-all control is placed FIRST and then used as the
    // anchor every card positions itself after. Rendering it last and
    // hoisting it to the front instead would move two nodes on every
    // render even when nothing changed, and a moved node restarts its
    // transition.
    let prev = this._renderDismissAll(groups, container);
    for (const group of visible) {
      const el = this._renderCard(group, container);
      // Order matters and groups are re-sorted on every render, so place
      // each card explicitly rather than trusting append order.
      if (prev) {
        if (prev.nextSibling !== el) container.insertBefore(el, prev.nextSibling);
      } else if (container.firstChild !== el) {
        container.insertBefore(el, container.firstChild);
      }
      prev = el;
    }

    this._renderOverflow(hidden, container, prev);
  }

  /**
   * Create, update or remove the single "Dismiss all" control.
   *
   * SHOWN ONLY WHEN IT HELPS. With one toast on screen the card's own x
   * is already one click, so a second control would be pure chrome. The
   * threshold is the TOAST count, not the group count: ten coalesced
   * `Stop`s render as one card but are ten records, and clearing them is
   * exactly the "several have stacked up" case.
   *
   * PLACED FIRST, above every card. It acts on the whole stack, and a
   * control that governs a list belongs at the head of it; putting it
   * under the overflow row would also move it every time the stack grew.
   *
   * IT SAYS WHAT IT WILL CLEAR. When the stack holds blocking prompts
   * the accessible label names them, so the one kind whose loss could
   * matter is disclosed before the click rather than after it.
   *
   * Inputs: groups (array) from `_groups()`; container (HTMLElement).
   * Output: HTMLElement|null - the control, for use as a placement
   *   anchor by the caller. null when the stack is too small to warrant
   *   one.
   */
  _renderDismissAll(groups, container) {
    // Count CARDS, not records: the number must match what is on screen.
    const total = groups.length;
    let row = container.querySelector('.toast-dismiss-all');
    if (total < 2) {
      if (row) row.remove();
      return null;
    }
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'toast-dismiss-all';
      row.addEventListener('click', () => this.dismissAll());
    }
    const blocking = this._countBySeverity(groups, CAP_EXEMPT_SEVERITY);
    const label = blocking
      ? `Dismiss all ${total} notifications, including ${blocking} `
        + `waiting on your permission`
      : `Dismiss all ${total} notifications`;
    row.dataset.total = String(total);
    row.dataset.blocking = String(blocking);
    row.setAttribute('aria-label', label);
    row.setAttribute('title', label);
    row.textContent = `Dismiss all (${total})`;
    if (container.firstChild !== row) {
      container.insertBefore(row, container.firstChild);
    }
    return row;
  }

  /**
   * Create or update one card.
   * Inputs: group (object) from `_groups()`; container (HTMLElement).
   * Output: HTMLElement - the card.
   */
  _renderCard(group, container) {
    const { winner, count, badgeCount, severity, key } = group;
    // NOT `.toast--dismissing`: a card mid-fade still carries its group
    // key for the 220ms the exit animation runs, so a new toast arriving
    // in that window would reuse the corpse and resurrect a card the user
    // just dismissed, half-faded.
    let el = container.querySelector(
      `.toast[data-group-key="${CSS_ESC(key)}"]:not(.toast--dismissing)`);
    const isNew = !el;
    if (isNew) {
      el = document.createElement('div');
      el.className = 'toast toast--entering';
      el.dataset.groupKey = key;
    }
    el.dataset.toastId = winner.id;
    el.dataset.kind = winner.kind || '';
    el.dataset.severity = String(severity);
    el.dataset.count = String(count);
    // `data-themed` is what toast.css keys the background/border tint on,
    // SEPARATELY from `--toast-accent` itself: that variable always
    // resolves to something (a baked colour, or the CSS fallback to
    // whatever theme is currently on screen), so a CSS rule reading the
    // variable alone cannot tell "this session has its own theme" apart
    // from "nothing was ever baked for this card". Only the truthy case
    // gets the attribute, so an unpinned session's card keeps painting
    // exactly as it always has - see toast.css for the rest of the
    // reasoning.
    if (winner.color) {
      el.style.setProperty('--toast-accent', winner.color);
      el.dataset.themed = '1';
    }
    // A blocking prompt interrupts the screen reader; chatter does not.
    el.setAttribute('role', severity >= CAP_EXEMPT_SEVERITY ? 'alert' : 'status');

    el.textContent = '';

    const title = document.createElement('div');
    title.className = 'toast__title';
    // Two nodes, not one string: the count is styled separately, and a
    // single textContent would be indistinguishable from a title that
    // literally contains "x3".
    const titleText = document.createElement('span');
    titleText.className = 'toast__title-text';
    titleText.textContent = winner.title || '(untitled)';
    title.appendChild(titleText);
    // THE BADGE COUNTS WHAT THE TITLE SAYS, not the session's pile: it
    // sits against the winner's title and is read as "this sentence,
    // that many times", so a session holding one permission prompt and
    // six finished turns must not paint "permission needed ×7". What the
    // x actually CLEARS is a different number, stated on the control.
    if (badgeCount > 1) {
      const badge = document.createElement('span');
      badge.className = 'toast__count';
      badge.textContent = `×${badgeCount}`;
      badge.setAttribute('aria-label', `${badgeCount} occurrences`);
      title.appendChild(badge);
    }
    el.appendChild(title);

    // WHICH SESSION THIS IS ABOUT.
    //
    // A toast is not a view of a session, it is a record of a moment. It
    // can arrive for a session that is not on screen, it outlives the
    // session it names, and the attach backfill replays it later - so a
    // card with no session line reads as a card about whatever the user
    // happens to be looking at, which is the wrong session. The server
    // stamps session_label and session_name at record time, when the
    // identity is certainly knowable, and this renders them through the
    // one shared resolver.
    //
    // ITS OWN ELEMENT, never appended to the title. A title that happened
    // to contain the session name would be indistinguishable from this at
    // the .textContent level - which is exactly how a `~~claude` badge
    // shipped through a green suite in this codebase.
    //
    // THE THIRD OUTCOME IS SPOKEN, NOT DROPPED. A toast recorded before
    // the server carried identity has neither field. It says so. Silently
    // omitting the line would be the dishonest option.
    // CLICKING THE NAME SWITCHES TO THAT SESSION, so it is a real <button>
    // whenever there is somewhere to switch TO - a bare tmux name to hand
    // the existing switch flow, `winner.session_name`. Without one
    // (the pre-identity toast case just above) it stays a <div>: a
    // control that cannot do anything is worse than no control.
    const canNavigate = !!winner.session_name;
    const session = document.createElement(canNavigate ? 'button' : 'div');
    session.className = 'toast__session';
    if (canNavigate) session.type = 'button';
    const resolved = window.SessionLabel
      ? window.SessionLabel.resolveToast(winner)
      : (winner.session_label || winner.session_name || null);
    session.textContent = resolved
      || (window.SessionLabel ? window.SessionLabel.UNKNOWN : 'unknown session');
    if (!resolved) session.dataset.unknown = '1';
    if (canNavigate) {
      // SAME NAVIGATION THE SIDEBAR ROW USES, not a second path to it:
      // SessionSidebarClicks.activateRow is the exact function a sidebar
      // row's click runs, exported for exactly this kind of reuse. It
      // wants a controller (only for the already-active-session check
      // and closing the sidebar afterward, neither of which applies to a
      // toast card) and a row element (only for `dataset.name` /
      // `dataset.sessionId`), so both are the minimal stand-ins that let
      // it run unmodified.
      // No stopPropagation: the dismiss button is a SIBLING of this
      // element, not a parent, and nothing on `.toast` itself listens
      // for a click - there is no bubbling path for the two to fight
      // over.
      session.addEventListener('click', () => {
        if (window.SessionSidebarClicks
            && typeof window.SessionSidebarClicks.activateRow === 'function') {
          window.SessionSidebarClicks.activateRow(
            { _activeTmuxName: null, _closeAfterSwitch: () => {} },
            { dataset: { name: winner.session_name, sessionId: winner.session_id || '' } },
          );
        }
        // THE CLICK ALSO DISMISSES THE CARD. The user just arrived at the
        // session this card is about, which is the same "already seen it"
        // fact that keeps a card from appearing for the session on screen
        // (see `_isActiveSession`) - clicking the name is how that fact
        // becomes true a moment early. Reuses `dismissGroup`, the SAME
        // teardown the x button runs, rather than a second one: every
        // member gets acked, so nothing is left orphaned unacked server-side.
        this.dismissGroup(key);
      });
    }
    el.appendChild(session);

    if (winner.body) {
      const body = document.createElement('div');
      body.className = 'toast__body';
      body.textContent = winner.body;
      el.appendChild(body);
    }

    // AN ATTACHMENT CARD SHOWS THE FILES, and the drawing of them is
    // not this file's business. A thumbnail needs decoding, downscaling
    // and a CSP-legal `data:` URL, none of which a notification card
    // has any reason to know about, so the whole strip is built by
    // client/js/attachment-toast.js and this is the one line that asks
    // for it. The WHOLE GROUP is passed, not the winner: attachments
    // coalesce per session, so the card is showing four files when the
    // badge says x4 and must draw all four.
    if (winner.kind === ATTACHMENT_KIND
        && window.AttachmentToast
        && typeof window.AttachmentToast.renderThumbs === 'function') {
      window.AttachmentToast.renderThumbs(el, group.toasts);
    }

    // CLICK THE CARD, GO TO THE SESSION THAT RAISED IT. Only meaningful
    // now that raising is global: before, every card was about the
    // session already on screen. The handler sits on the CARD and the
    // dismiss button below calls stopPropagation, so "dismiss" cannot
    // also mean "navigate". Reading a notification is not answering it,
    // so this never acks.
    //
    // IT READS THE `winner`, WHICH IS ONE SESSION BY CONSTRUCTION. This
    // used to read a `newest` local, back when a group could hold cards
    // from more than one session; the group key is now the SESSION
    // itself, so the winner's session is the card's session and there is
    // nothing left to pick between.
    el.dataset.sessionId = winner.session_id || '';
    if (winner.session_id && window.ToastNavigate) {
      el.classList.add('toast--clickable');
      el.setAttribute('tabindex', '0');
      el.addEventListener('click', () => window.ToastNavigate.go(winner));
      el.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          window.ToastNavigate.go(winner);
        }
      });
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'toast__dismiss';
    // COUNTS EVERY RECORD IT WILL CLEAR, which can be larger than the
    // badge. The badge answers "how often did this happen"; this answers
    // "what am I about to throw away", and a control that understated
    // that would clear things the user was never told about.
    const label = count > 1
      ? `Dismiss ${count} notifications for this session`
      : 'Dismiss notification';
    dismissBtn.setAttribute('aria-label', label);
    dismissBtn.setAttribute('title', label);
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', (evt) => {
      // Do not let the dismiss click bubble into the card's
      // navigate handler above - dismissing a card must not also
      // yank the user into the session it was about.
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      this.dismissGroup(key);
    });
    el.appendChild(dismissBtn);

    if (isNew) {
      container.appendChild(el);
      // Force a style flush BEFORE dropping the entering class. Without
      // it, a burst that appends and un-classes several cards inside one
      // task can leave the browser never having computed the entering
      // state, so the transition sometimes runs and sometimes does not -
      // measured flapping between both on identical input. A reflow read
      // pins it: the entering style is computed, so the transition always
      // runs and the end state is always reached.
      void el.offsetWidth;
      requestAnimationFrame(() => el.classList.remove('toast--entering'));
    }
    return el;
  }

  /**
   * Create, update or remove the single overflow row.
   *
   * The row is the reason the cap is not a data-loss bug: it states how
   * many toasts it is holding and, when the hidden set contains anything
   * above the lowest severity, says so in words. Clicking it suspends the
   * cap so every hidden card renders.
   *
   * Inputs: hidden (array) of groups; container (HTMLElement);
   *   prev (HTMLElement|null) - the last visible card, for placement.
   * Output: None.
   */
  _renderOverflow(hidden, container, prev) {
    let row = container.querySelector('.toast-overflow');
    if (hidden.length === 0 && !this._expanded) {
      if (row) row.remove();
      return;
    }
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'toast-overflow';
      row.addEventListener('click', () => {
        this._expanded = !this._expanded;
        this._render();
      });
    }

    if (this._expanded) {
      row.textContent = 'Show fewer';
      row.dataset.hiddenCount = '0';
      row.dataset.worstSeverity = '0';
      row.setAttribute('aria-expanded', 'true');
    } else {
      const toastCount = hidden.reduce((n, g) => n + g.count, 0);
      const worst = hidden.reduce((m, g) => Math.max(m, g.severity), 0);
      row.dataset.hiddenCount = String(toastCount);
      row.dataset.worstSeverity = String(worst);
      row.setAttribute('aria-expanded', 'false');
      row.textContent = '';
      const n = document.createElement('span');
      n.className = 'toast-overflow__count';
      n.textContent = `+${toastCount} more`;
      row.appendChild(n);
      // Naming the worst thing in there is what keeps a suppressed item
      // from being silently lost: it is suppressed, and the screen still
      // says what kind of thing is suppressed.
      const worstLabel = OVERFLOW_SEVERITY_LABEL[worst];
      if (worstLabel) {
        const w = document.createElement('span');
        w.className = 'toast-overflow__worst';
        // Parenthesised because the two spans are read back as one
        // string by a screen reader: "+9 more9 waiting on you" is what
        // bare concatenation produces, and the flex gap only fixes the
        // sighted case.
        // Counted per RECORD at that exact severity, not per hidden
        // group: a hidden group is a whole session's pile, so summing
        // group counts would report a session's finished turns as
        // things waiting on the user.
        w.textContent = '(' + worstLabel(
          this._countBySeverity(hidden, worst, true),
        ) + ')';
        row.appendChild(w);
      }
    }
    row.dataset.severity = row.dataset.worstSeverity;

    if (prev) {
      if (prev.nextSibling !== row) container.insertBefore(row, prev.nextSibling);
    } else if (container.firstChild !== row) {
      container.insertBefore(row, container.firstChild);
    }
  }
}

/**
 * Words for the worst severity sitting in overflow. Severity 3 is absent
 * on purpose: it is cap-exempt and can never be in there, so a label for
 * it would be dead code claiming a case that cannot occur.
 */
const OVERFLOW_SEVERITY_LABEL = {
  2: (n) => (n === 1 ? '1 waiting on you' : `${n} waiting on you`),
};

/**
 * Escape a string for use inside an attribute-selector value.
 *
 * Group keys contain `|` and arbitrary title text from the server, so
 * they cannot be interpolated into a selector raw. CSS.escape is the
 * right tool and exists in every browser this app supports; the fallback
 * is for the DOM stub the node suites run against.
 *
 * Inputs: value (string). Output: string - safe inside "..." in a selector.
 */
function CSS_ESC(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// Singleton export - matches the pattern used by API, TerminalController.
window.ToastManager = new ToastManager();
console.log('[Toast Module] Exported as window.ToastManager:', window.ToastManager);
