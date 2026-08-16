/**
 * Terminal tool strip folding.
 *
 * The session tool strip (copy output, session theme, session music)
 * floats over the top-right corner of the terminal. Three 44px chips plus
 * their gaps is ~150px of live output permanently covered. This folds it
 * to ONE chip, which is what the user asked for: "only one blocking
 * element in the top right of session".
 *
 * WHY THIS IS NOT MERGED INTO THE HEADER KEBAB, which sits in the same
 * corner one row up. They are different scopes and merging them would
 * make both worse:
 *
 *   header kebab (#header-menu-toggle, header-menu.js)
 *     APP scope. home, detach, logout, settings, claude config, global
 *     music. Present on every screen including the launchpad, where a
 *     session theme would be meaningless. Lives INSIDE the header bar.
 *
 *   this trigger (#terminalToolsToggle)
 *     SESSION scope. Themes THIS tmux session, copies THIS session's
 *     output, plays music for THIS session. Only exists on the terminal
 *     screen. Floats OVER the terminal, below the header bar.
 *
 * Folding one into the other would put session-scoped actions on screens
 * that have no session, or move session actions into a menu the user
 * opens for navigation. So they stay separate and are instead made
 * unmistakable: different row, different glyph (sliders here, vertical
 * dots there), different anchor (over the terminal, not in the header).
 * See the header comment in client/css/terminal-tools.css.
 *
 * Collapsed is the default on every mount. There is no persistence: the
 * expanded state is a momentary "I am about to use a tool", not a
 * preference, and a strip that reopens itself is back to blocking output.
 */

console.log('[TerminalToolsFold Module] Loading...');

/** Ids of the session tools that fold behind the trigger. */
const FOLDED_TOOL_IDS = ['terminalCopyBtn', 'sessionThemeBtn', 'sessionAudioBtn'];

/** Class applied to the strip while the tools are revealed. */
const OPEN_CLASS = 'terminal-tools--open';

class TerminalToolsFold {
    constructor() {
        /** @type {Element|null} */ this.strip = null;
        /** @type {Element|null} */ this.toggle = null;
        /** @type {boolean} */ this.isOpen = false;
    }

    /**
     * Build the trigger and start in the collapsed state. Idempotent - a
     * second call returns without rebuilding.
     *
     * @returns {void}
     */
    init() {
        if (this.toggle) return;
        this.strip = document.getElementById('terminalTools');
        this.toggle = document.getElementById('terminalToolsToggle');
        if (!this.strip || !this.toggle) {
            console.warn('[TerminalToolsFold] strip or toggle missing, skipping');
            return;
        }

        this.toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setOpen(!this.isOpen);
        });

        // Escape closes, matching every other transient surface in the app.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.setOpen(false);
        });

        // Click-outside collapses. Click-based, never focusout - see the
        // reasoning in client/js/dismiss-guard.js.
        if (window.DismissGuard) {
            window.DismissGuard.onOutsideDismiss(
                this.strip,
                () => this.setOpen(false),
                { trigger: this.toggle, isOpen: () => this.isOpen }
            );
        }

        this.setOpen(false);
        console.log('[TerminalToolsFold] initialized');
    }

    /**
     * Reveal or hide the folded tools.
     *
     * Visibility is driven by a class on the strip rather than inline
     * styles on each button, so the tools keep whatever display value
     * terminal-tools.css gives them and nothing here has to know about
     * `.hidden` gating done elsewhere.
     *
     * @param {boolean} open  True to reveal the tools.
     * @returns {void}
     */
    setOpen(open) {
        if (!this.strip || !this.toggle) return;
        this.isOpen = !!open;
        this.strip.classList.toggle(OPEN_CLASS, this.isOpen);
        this.toggle.setAttribute('aria-expanded', this.isOpen ? 'true' : 'false');
        const label = this.isOpen ? 'hide session tools' : 'session tools';
        this.toggle.setAttribute('title', label);
        this.toggle.setAttribute('aria-label', label);
        this.toggle.setAttribute('data-tooltip', label);
    }

    /**
     * Collapse the strip. Called when a session is swapped in so a new
     * session never inherits the previous one's expanded strip.
     *
     * @returns {void}
     */
    collapse() {
        this.setOpen(false);
    }
}

window.TerminalToolsFold = new TerminalToolsFold();
window.TerminalToolsFoldConstants = {
    FOLDED_TOOL_IDS,
    OPEN_CLASS
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.TerminalToolsFold.init());
} else {
    window.TerminalToolsFold.init();
}

console.log('[TerminalToolsFold Module] Exported as window.TerminalToolsFold');
