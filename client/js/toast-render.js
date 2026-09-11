/**
 * ToastManager, rendering half - rebuilding the visible card set, the
 * dismiss-all control, one card, and the overflow row.
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
 * WHAT LIVES HERE: `_render` rebuilds the whole visible set from the
 * model (the cap, the coalesce counts and the overflow row are all
 * functions of the WHOLE set, so a single-element mutation can invalidate
 * all three); `_renderDismissAll` builds the one bulk control;
 * `_renderCard` builds one coalesced card, including the click-to-
 * navigate and dismiss wiring; `_renderOverflow` builds the row that
 * makes the cap safe to have. None of these four change what toasts
 * exist - that is the lifecycle file's job - they only decide what the
 * DOM looks like for the model as it currently stands. `OVERFLOW_SEVERITY_LABEL`
 * and `CSS_ESC` travel with them because both are used only here. Moved
 * here verbatim: no line of logic changed.
 *
 * This split is issue #55: toast.js had grown past the repo's 1000-line
 * guideline. Reading the file, this was one of the three seams that
 * already stood apart - grouping and coalescing, rendering, and
 * lifecycle - so it becomes its own file rather than the whole module
 * growing further.
 */

console.log('[ToastRender Module] Loading...');

if (typeof ToastManager !== 'function') {
    // A named refusal, not a silent no-op. Loading this before toast.js is
    // a script-order mistake and must say so rather than leaving every
    // card silently unbuilt, which would render as "toasts never appear".
    throw new Error(
        'toast-render.js loaded before toast.js - class ToastManager is '
        + 'not defined. Fix the script order in client/index.html.'
    );
}

Object.assign(ToastManager.prototype, {
    /**
     * Coalesce many model changes into ONE render pass.
     *
     * WHY. `_render()` below rebuilds the WHOLE visible set on every call,
     * so calling it once per arriving or dismissed record buys nothing
     * over calling it once per BURST - issue #39 measured a 500-record
     * backfill costing 500 renders and about 173ms of synchronous work.
     * Every lifecycle method that used to call `this._render()` directly
     * (client/js/toast-lifecycle.js: `add`, `dismiss`, `updateLocal`) now
     * calls this instead.
     *
     * ONE PENDING FLUSH, NOT A QUEUE. `_renderPending` is the whole
     * coalescing mechanism: the FIRST call in a burst schedules a flush
     * and every call after it, while that flush is still pending, is a
     * no-op here - the model mutation the caller already made is enough,
     * because the eventual flush reads the CURRENT model, not a snapshot
     * taken when it was scheduled.
     *
     * GOTCHA 9 (CLAUDE.md): a bare `await requestAnimationFrame` never
     * resolves in a hidden tab. `client/js/toast-render-batch.js` races
     * the frame against a `setTimeout` fallback for exactly that reason,
     * so a backgrounded tab still flushes - delayed, never cancelled. Its
     * absence degrades to rendering immediately, never to silently not
     * rendering, matching how this codebase already degrades a missing
     * optional module elsewhere (e.g. the xterm load wait).
     *
     * Output: None.
     */
    _scheduleRender() {
      if (this._renderPending) return;
      this._renderPending = true;
      const flush = () => {
        this._renderPending = false;
        this._render();
      };
      if (window.ToastRenderBatch && typeof window.ToastRenderBatch.schedule === 'function') {
        window.ToastRenderBatch.schedule(flush);
      } else {
        flush();
      }
    },

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
    },

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
    },

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
        // THIS HANDLER DISMISSES. IT DOES NOT NAVIGATE, and the reason is
        // that THE CARD IS A LISTENING ANCESTOR. `el` below binds a click
        // handler that calls `ToastNavigate.go`, and this element is a
        // CHILD of `el`, so a click on the name runs this handler and then
        // bubbles to the card and runs that one. This block used to also
        // call `SessionSidebarClicks.activateRow` with a stand-in
        // controller, which made one click perform TWO independent
        // navigations - and each one tears the live WebSocket down and
        // opens a fresh one, so the session took about thirty seconds to
        // settle while the transport indicator flickered. Measured on live:
        // 161 connects against 116 disconnects, 45 sockets opened and never
        // closed.
        //
        // An earlier comment here claimed nothing on `.toast` listens for a
        // click and there was therefore no bubbling path. That was true on
        // the branch it was written on; the merge that brought the card's
        // own handler in compiled cleanly and made it false.
        //
        // THE CARD'S HANDLER IS THE ONE THAT SURVIVES, deliberately.
        // `ToastNavigate.go` fetches the live list and hands
        // `App.returnToExistingTerminal` the row the SERVER has, so
        // `pinned_theme` and `tmux_session` arrive on the wrapper where that
        // function reads them (gotcha 1), and a session that has since died
        // is announced through the app's one error banner. `activateRow`
        // reached through a fabricated `{_activeTmuxName: null}` controller
        // carries neither, and that null also disables its
        // already-in-this-session guard by construction.
        //
        // Still no stopPropagation, and now that matters more, not less:
        // silencing this click would kill the card's navigation and leave
        // nothing to enter the session with. The dismiss button is a
        // SIBLING of this element and stops propagation itself, so
        // dismissing still never navigates.
        session.addEventListener('click', () => {
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
    },

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
          this._scheduleRender();
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
    },
});

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
