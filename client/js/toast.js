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
 *
 * THIS FILE HOLDS THE REGISTRY AND THE CONSTRUCTOR ONLY. Issue #55 split
 * toast.js along the three seams its own structure already suggested:
 * grouping and coalescing (client/js/toast-grouping.js), rendering
 * (client/js/toast-render.js), and lifecycle - add/dismiss/backfill
 * (client/js/toast-lifecycle.js). Each of those three extends
 * `ToastManager.prototype` from a separate file, the same way
 * client/js/api-toasts.js extends `API.prototype`; all three MUST load
 * after this file in client/index.html, or `class ToastManager` is not
 * yet defined for them to extend.
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
 * The OTHER client-raised kind: a write the server refused.
 *
 * Raised by client/js/write-failure-notice.js, which reads the name back
 * off `ToastManager.WRITE_FAILED_KIND` rather than repeating the string.
 * It is declared here for the same reason the attachment kind is - this
 * file is the registry of what a kind MEANS, and its severity and
 * coalescing rules live in the two tables below.
 */
const WRITE_FAILED_KIND = 'WriteFailed';

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
  // HIGH, and therefore CAP-EXEMPT, which is the whole point of the
  // number. This card is the only visible trace of an action the user
  // took that did NOT happen; the live region says it too, but that is
  // clipped and silent to a sighted user. A failure pushed behind
  // "+2 more" is invisible again, which is the defect returning wearing
  // a card. It is not blocking the way a PermissionRequest is - it
  // shares the tier because it shares the "must not be hidden" property.
  [WRITE_FAILED_KIND]: 3,
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
    /** The other one, read by client/js/write-failure-notice.js. */
    this.WRITE_FAILED_KIND = WRITE_FAILED_KIND;
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
    /**
     * True while a render pass is scheduled but has not run yet. The
     * whole coalescing mechanism for `_scheduleRender()`
     * (client/js/toast-render.js): every call while this is true folds
     * into the flush already pending rather than scheduling a second one.
     */
    this._renderPending = false;
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
      const onChange = () => this._scheduleRender();
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
}

// Singleton export - matches the pattern used by API, TerminalController.
window.ToastManager = new ToastManager();
console.log('[Toast Module] Exported as window.ToastManager:', window.ToastManager);
