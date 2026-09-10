/**
 * ToastManager, lifecycle half - add, dismiss (single, grouped, by
 * session, all), reconcile against the server's open set, and the
 * attach backfill.
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
 * WHAT LIVES HERE: every method that changes what toasts this browser is
 * holding, and why - `_isActiveSession` (no card for the session on
 * screen), `add` (the one entry point for a new or superseding record),
 * `reconcileOpen` (the poll-driven removal path), `dismiss` and its
 * bulk variants (`dismissKindForSession`, `dismissGroup`,
 * `dismissBySession`, `dismissForSessionEntry`,
 * `dismissForSessionActivity`, `dismissAll`, `clearAll`), `_ack`,
 * `_cardFor`, and `backfill`. All of them read and write `this._byId` /
 * `this._addedAt` and call `this._render()` to reflect a change; none of
 * them build markup, which is why rendering is its own file. Moved here
 * verbatim: no line of logic changed.
 *
 * This split is issue #55: toast.js had grown past the repo's 1000-line
 * guideline. Reading the file, this was one of the three seams that
 * already stood apart - grouping and coalescing, rendering, and
 * lifecycle - so it becomes its own file rather than the whole module
 * growing further.
 */

console.log('[ToastLifecycle Module] Loading...');

if (typeof ToastManager !== 'function') {
    // A named refusal, not a silent no-op. Loading this before toast.js is
    // a script-order mistake and must say so rather than leaving add/
    // dismiss/backfill quietly absent, which would render as "toasts never
    // appear and never go away".
    throw new Error(
        'toast-lifecycle.js loaded before toast.js - class ToastManager is '
        + 'not defined. Fix the script order in client/index.html.'
    );
}

Object.assign(ToastManager.prototype, {
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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

    /**
     * The rendered card currently showing a given toast id, if any.
     * Inputs: toastId (string). Output: HTMLElement|null.
     */
    _cardFor(toastId) {
      const container = this._container();
      if (!container) return null;
      return container.querySelector(`.toast[data-toast-id="${toastId}"]`);
    },

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
    },

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
    },

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
    },

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
    },

    /**
     * Drop all UI state without ack. Used on full logout / page tear-down
     * paths where the server-side ack is irrelevant.
     */
    clearAll() {
      for (const id of Array.from(this._byId.keys())) {
        this.dismiss(id, { syncToServer: false });
      }
    },

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
    },
});
