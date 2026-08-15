/**
 * Session sidebar PIN - keep the conversation list docked open.
 *
 * WHICH "PIN" THIS IS. The request was "the left bar with the sessions
 * should have the ability to pin ... pinned bars should probably not
 * stick on mobile". "pinned BARS" is the bar itself, not rows inside it,
 * and "stick" is the language of a docked panel, so this pins the
 * SIDEBAR, not individual sessions. The sidebar's own structure argues
 * the same way: every row click calls `close()` (see
 * session-sidebar.js's `_onRowClick`), so a desktop user comparing two
 * conversations re-opens the bar on every single switch. Pinning is the
 * fix for that. Pinning individual sessions to the top of the list would
 * be a different feature solving a problem the list does not have - it
 * already sorts this-tab first, then live, then newest, and it carries a
 * mark-unread control for "come back to this one".
 *
 * PINNED means: docked, not overlaid. No backdrop, no auto-close when a
 * row is clicked, and the header + terminal are padded to the right of
 * it so the bar never covers the thing the user is reading. The terminal
 * refits itself - terminal.js watches its container with a
 * ResizeObserver - so no cross-module call is needed for that.
 *
 * NOT ON MOBILE. Under MOBILE_MAX_PX the pin is ignored entirely and the
 * control is hidden: the bar goes back to being an overlay that closes
 * on a row click, because 320px of permanent sidebar on a phone leaves
 * nothing for the terminal. The preference is still PERSISTED, just not
 * APPLIED - rotate to a wide viewport or open the same browser on a
 * desktop and the pin is honored again. A resize listener re-evaluates,
 * so crossing the breakpoint live does the right thing without a reload.
 *
 * Persistence follows the existing `cloude.*` localStorage convention
 * used by cloude.theme, cloude.launchpad.collapsed,
 * cloude.configEditor.collapsed and - the closest match, since it is the
 * same panel's own open/closed flag - cloude.session.sidebar. Same '1'/'0'
 * string encoding and same try/catch-and-ignore treatment as that key.
 *
 * Split into its own module because session-sidebar.js is already at the
 * project's 500-line ceiling; the two files are one feature.
 *
 * Must load AFTER session-sidebar.js (window.SessionSidebar).
 */

console.log('[SessionSidebarPin Module] Loading...');

(function () {
    /**
     * localStorage key for the pinned preference - '1' pinned, '0' not.
     * Sibling of SessionSidebarController.STORAGE_KEY
     * ('cloude.session.sidebar').
     * @type {string}
     */
    const STORAGE_KEY = 'cloude.session.sidebar.pinned';

    /**
     * Widest viewport that counts as "mobile" for pin purposes. Matches
     * the 700px breakpoint the modal stack and the editor modal use, so
     * "this is a phone" means one thing across the app.
     * @type {number}
     */
    const MOBILE_MAX_PX = 700;

    /**
     * Class on <body> while the sidebar is pinned AND wide enough to
     * honor it. Drives the layout shift in session-sidebar.css.
     * @type {string}
     */
    const BODY_CLASS = 'session-sidebar-pinned';

    let pinned = false;
    let btnEl = null;

    /**
     * True when the viewport is too narrow to dock a sidebar.
     *
     * A reported width of 0 is not a narrow viewport, it is NO viewport -
     * a hidden or not-yet-laid-out tab reports that, and treating it as a
     * phone silently drops the pin until the next resize. Observed live:
     * a backgrounded browser pane reported innerWidth 0 and the pinned
     * bar came back undocked. Unknown width means "not mobile"; the
     * resize listener corrects it the moment a real width exists.
     * Inputs: none. Output: boolean.
     */
    function isMobile() {
        const width = window.innerWidth;
        if (!width) return false;
        return width <= MOBILE_MAX_PX;
    }

    /**
     * Read the persisted preference.
     * Inputs: none. Output: boolean.
     */
    function loadPinned() {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch (_) {
            return false;
        }
    }

    /**
     * Write the preference. Never throws - a browser with storage denied
     * loses persistence, not the feature.
     * Inputs: value (boolean). Output: void.
     */
    function savePinned(value) {
        try {
            localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
        } catch (_) { /* storage denied - session-only pin */ }
    }

    /**
     * True when the sidebar should currently behave as docked: the user
     * pinned it AND the viewport is wide enough. Every behavioral
     * question ("should this row click close the bar?", "should the
     * backdrop show?") asks THIS, never the raw preference.
     * Inputs: none. Output: boolean.
     */
    function isEffectivelyPinned() {
        return pinned && !isMobile();
    }

    /**
     * Push the current pin state into the DOM: body class for the layout
     * shift, backdrop visibility, and the button's own pressed state and
     * mobile visibility.
     * Inputs: none. Output: void.
     */
    function apply() {
        const sidebar = window.SessionSidebar;
        const effective = isEffectivelyPinned();
        document.body.classList.toggle(BODY_CLASS, effective && !!sidebar && sidebar.isOpen);

        // A docked bar covers nothing, so its backdrop would only be a
        // full-screen click target that closes it by accident.
        if (sidebar && sidebar.backdrop) {
            sidebar.backdrop.hidden = !sidebar.isOpen || effective;
        }

        if (btnEl) {
            btnEl.setAttribute('aria-pressed', String(pinned));
            btnEl.title = pinned ? 'unpin sidebar' : 'pin sidebar open';
            btnEl.setAttribute('aria-label', pinned ? 'Unpin sidebar' : 'Pin sidebar open');
            // Hidden rather than disabled on a phone: an always-inert
            // control invites the user to wonder what is wrong with it.
            btnEl.hidden = isMobile();
        }
    }

    /**
     * Flip the pin and persist it.
     * Inputs: none. Output: void.
     */
    function toggle() {
        pinned = !pinned;
        savePinned(pinned);
        apply();
    }

    /**
     * What a row click should do to the bar once it has switched
     * conversations: close it (the overlay default - it is covering the
     * terminal the user just asked to see) or leave it alone (pinned - it
     * covers nothing, and closing it would defeat the entire point of
     * pinning, which is switching repeatedly without re-opening).
     * Inputs: none. Output: void.
     */
    function closeAfterSwitch() {
        if (isEffectivelyPinned()) return;
        if (window.SessionSidebar) window.SessionSidebar.close();
    }

    /**
     * Wire the pin button and restore the persisted state. Idempotent -
     * called from SessionSidebar.init() every time the terminal screen is
     * shown.
     * Inputs: none. Output: void.
     */
    function init() {
        if (!btnEl) {
            btnEl = document.getElementById('session-sidebar-pin');
            if (btnEl) btnEl.addEventListener('click', () => toggle());
            window.addEventListener('resize', () => apply());
        }
        pinned = loadPinned();
        apply();
    }

    window.SessionSidebarPin = {
        init, apply, toggle, closeAfterSwitch, isEffectivelyPinned, STORAGE_KEY, MOBILE_MAX_PX,
    };
    console.log('[SessionSidebarPin Module] Exported as window.SessionSidebarPin');
})();
