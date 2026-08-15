/**
 * Header Menu (mobile)
 *
 * At phone width the top-right icon cluster folds into a single dropdown;
 * at desktop width the icons sit inline exactly as before. Web-first and
 * mobile-first are both first class here, so this is a reflow, not a
 * rebuild: the SAME button nodes move between the two layouts.
 *
 * WHY MOVE THE NODES INSTEAD OF RENDERING A SECOND COPY: every one of
 * these controls is addressed by id from elsewhere in the app
 * (`document.getElementById('homeBtn')`, `.classList.remove('hidden')` on
 * screen change, click listeners wired once in app.js). A cloned mirror
 * menu would duplicate ids, strip listeners, and drift out of sync with
 * the show/hide gating the moment anything changed. Re-parenting keeps
 * one node per control, so every existing id lookup, listener and
 * `.hidden` toggle keeps working untouched in both layouts.
 *
 * NOT folded in: `#statusText`. It is a live state light, not an action -
 * hiding it behind a tap would mean the connection state is only visible
 * to someone who already went looking for it. It stays inline.
 *
 * Also not folded in: `#session-sidebar-toggle`, which is top-LEFT and is
 * the one-handed reach target on a phone. This module never touches it.
 *
 * Depends on window.DismissGuard (client/js/dismiss-guard.js) for
 * outside-click dismissal - deliberately click-based, never focusout, so
 * the dropdown cannot reintroduce the "focus a child input and the menu
 * vanishes" bug that DismissGuard exists to kill.
 */

console.log('[HeaderMenu Module] Loading...');

/** Width at or below which the cluster folds. Matches the existing
 *  `@media (max-width: 768px)` header breakpoint in styles.css. */
const HEADER_MENU_BREAKPOINT = '(max-width: 768px)';

/** Ids of the controls that fold, in their canonical inline order. */
const HEADER_MENU_CONTROL_IDS = [
    'audioToggleBtn',
    'homeBtn',
    'detachSessionBtn',
    'logoutBtn',
    'settingsBtn',
    'configEditorBtn'
];

class HeaderMenu {
    constructor() {
        /** @type {Element|null} */ this.controls = null;
        /** @type {Element|null} */ this.toggle = null;
        /** @type {Element|null} */ this.panel = null;
        /** @type {boolean} */ this.isOpen = false;
        /** @type {boolean} */ this.isFolded = false;
        /** @type {MediaQueryList|null} */ this.mql = null;
    }

    /**
     * Description: build the toggle + panel, then apply the layout that
     *   matches the current viewport and keep applying it on resize or
     *   rotate. Idempotent - a second call is a no-op.
     * Inputs: none.
     * Output: void.
     */
    init() {
        if (this.panel) return;
        this.controls = document.querySelector('.header .controls');
        if (!this.controls) {
            console.warn('[HeaderMenu] no .header .controls, skipping');
            return;
        }

        this._buildChrome();
        this._wireEvents();

        this.mql = window.matchMedia(HEADER_MENU_BREAKPOINT);
        const onChange = () => this.applyLayout();
        // addEventListener on MediaQueryList is the modern form; older
        // WebKit (including some iOS versions still in the wild) only has
        // addListener. Support both rather than silently never reflowing.
        if (typeof this.mql.addEventListener === 'function') {
            this.mql.addEventListener('change', onChange);
        } else if (typeof this.mql.addListener === 'function') {
            this.mql.addListener(onChange);
        }
        this.applyLayout();
        console.log('[HeaderMenu] initialized');
    }

    /**
     * Description: create the dropdown trigger and its panel and append
     *   both to `.controls`. The trigger is a real <button> with
     *   aria-expanded/aria-controls, matching the accessibility pattern
     *   the other header controls already use.
     * Inputs: none.
     * Output: void.
     */
    _buildChrome() {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'header-menu-toggle';
        toggle.className = 'header-menu-toggle';
        toggle.setAttribute('aria-label', 'More actions');
        toggle.setAttribute('title', 'more');
        toggle.setAttribute('aria-haspopup', 'true');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', 'header-menu-panel');
        toggle.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<circle cx="8" cy="3" r="1.5" fill="currentColor"/>' +
            '<circle cx="8" cy="8" r="1.5" fill="currentColor"/>' +
            '<circle cx="8" cy="13" r="1.5" fill="currentColor"/>' +
            '</svg>';

        const panel = document.createElement('div');
        panel.id = 'header-menu-panel';
        panel.className = 'header-menu-panel';
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', 'More actions');
        panel.hidden = true;

        this.controls.appendChild(toggle);
        this.controls.appendChild(panel);
        this.toggle = toggle;
        this.panel = panel;
    }

    /**
     * Description: wire open/close - trigger click, Escape, outside click,
     *   and a click on any control inside the panel (which should run that
     *   control's own action AND collapse the menu behind it).
     * Inputs: none.
     * Output: void.
     */
    _wireEvents() {
        this.toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isOpen ? this.close() : this.open();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
                this.toggle.focus();
            }
        });

        window.DismissGuard.onOutsideDismiss(this.panel, () => this.close(), {
            trigger: this.toggle,
            isOpen: () => this.isOpen
        });

        // A tap on a folded control fires that control's own handler
        // first (it is the same node, listeners intact); we only collapse
        // the menu behind it. Guarded so a tap on the panel's own padding
        // does not close it out from under a fat finger.
        this.panel.addEventListener('click', (e) => {
            if (e.target === this.panel) return;
            this.close();
        });
    }

    /**
     * Description: fold or unfold to match the current viewport width.
     *   Safe to call repeatedly; each direction is a no-op when already
     *   in that state.
     * Inputs: none.
     * Output: void.
     */
    applyLayout() {
        const shouldFold = !!(this.mql && this.mql.matches);
        if (shouldFold === this.isFolded) return;
        shouldFold ? this._fold() : this._unfold();
    }

    /**
     * Description: move every foldable control into the dropdown panel,
     *   in canonical order, and reveal the trigger.
     * Inputs: none.
     * Output: void.
     */
    _fold() {
        for (const id of HEADER_MENU_CONTROL_IDS) {
            const el = document.getElementById(id);
            if (el) this.panel.appendChild(el);
        }
        this.controls.classList.add('controls--folded');
        this.isFolded = true;
    }

    /**
     * Description: move every foldable control back inline, restoring the
     *   canonical order, and close + hide the dropdown. Controls are
     *   re-inserted BEFORE the trigger so the trigger and panel stay last
     *   in the row.
     * Inputs: none.
     * Output: void.
     */
    _unfold() {
        this.close();
        for (const id of HEADER_MENU_CONTROL_IDS) {
            const el = document.getElementById(id);
            if (el) this.controls.insertBefore(el, this.toggle);
        }
        this.controls.classList.remove('controls--folded');
        this.isFolded = false;
    }

    /** Open the dropdown (idempotent). */
    open() {
        if (!this.panel) return;
        this.panel.hidden = false;
        this.panel.classList.add('header-menu-panel--open');
        this.toggle.setAttribute('aria-expanded', 'true');
        this.isOpen = true;
    }

    /** Close the dropdown (idempotent). */
    close() {
        if (!this.panel) return;
        this.panel.classList.remove('header-menu-panel--open');
        this.panel.hidden = true;
        this.toggle.setAttribute('aria-expanded', 'false');
        this.isOpen = false;
    }
}

window.HeaderMenu = new HeaderMenu();
window.HeaderMenuConstants = {
    BREAKPOINT: HEADER_MENU_BREAKPOINT,
    CONTROL_IDS: HEADER_MENU_CONTROL_IDS
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.HeaderMenu.init());
} else {
    window.HeaderMenu.init();
}

console.log('[HeaderMenu Module] Exported as window.HeaderMenu');
