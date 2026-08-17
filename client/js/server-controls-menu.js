/**
 * Server controls - the app-scoped menu hung off the home bar.
 * ----------------------------------------------------------------------
 * SCOPE: things done to the SERVER PROCESS, not to a session and not to a
 * project. That is the rule this menu is drawn along, and it is why it
 * lives on the home bar rather than beside the two terminal FABs: the
 * session editor configures the session you are looking at, the tools menu
 * moves content across the terminal's boundary, and neither of those means
 * anything on the home screen. Restarting the web server means the same
 * thing everywhere, and the home screen is where you are when you want it.
 *
 * TWO ROWS. "restart server" used to be a full-width button in a "server
 * management" section of the launchpad body, which is a lot of vertical
 * real estate for a control pressed roughly never. "server status" was
 * added second, and it cost exactly what this file's design promised: one
 * entry in ENTRY_IDS, one icon, one row in buildItems(), and nothing
 * else. Keep it that way - the rendering, the fetching and the one
 * destructive control all live in server-status-panel.js, not here.
 *
 * WHY IT ROUTES THROUGH FabMenu. The open/close/outside-dismiss/Escape
 * plumbing lived twice before and the copies drifted, and - the part that
 * bites - FabMenu.notify() is the only feedback surface in this app that
 * is guaranteed to be visible. The terminal status pill sits at z-index 70
 * underneath the sticky header (1000) and every overlay, so a message
 * raised from a menu row through the pill is painted over and seen by
 * nobody. Rows here take notify() as their argument and must use it.
 *
 * ANCHORING FROM THE BOTTOM. AnchorPopover places a popover ABOVE its
 * anchor with their right edges flush and only drops below when there is
 * no room above. A trigger sitting in a bottom bar is the case that rule
 * was written for, so the menu opens upward with no special handling. The
 * menu is `position: fixed` on document.body, so the home screen's
 * scroller cannot clip it.
 */

console.log('[ServerControlsMenu Module] Loading...');

(function () {
    'use strict';

    /** Stable ids for the menu rows, in declaration order. Read by tests. */
    var ENTRY_IDS = [
        'serverStatusRow',
        'serverRestartRow'
    ];

    /**
     * Icons in the shared 16x16 terminal-tool geometry: a 16x16 viewBox
     * rendered at 16x16, `fill="none"`, and stroke-width declared as a
     * presentation attribute on every stroked shape (a presentation
     * attribute beats a stylesheet rule that targets the `svg`, so the
     * value has to be right in the markup).
     *
     * `restart` is the arrow that used to sit on the "reset server"
     * button, carried over unchanged so the control is still
     * recognisable after moving surfaces.
     *
     * @type {Object<string, string>}
     */
    var ICONS = {
        gauge:
            '<path d="M2.5 12A5.5 5.5 0 0 1 8 3a5.5 5.5 0 0 1 5.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
            '<path d="M8 8.5L10.75 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
            '<path d="M8 12.5V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        restart:
            '<path d="M13 8C13 10.7614 10.7614 13 8 13C5.23858 13 3 10.7614 3 8C3 5.23858 5.23858 3 8 3C9.87677 3 11.5 4.01207 12.3284 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
            '<path d="M12 2.5V5.5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    };

    /**
     * Build one 16x16 icon from this menu's set.
     *
     * @param {string} name - a key of ICONS.
     * @returns {SVGElement|null} the icon, or null with no FabMenu.
     */
    function buildIcon(name) {
        return window.FabMenu ? window.FabMenu.buildIcon(ICONS, name) : null;
    }

    /** The controller. Its plumbing is shared; its rows are not. */
    var menu = window.FabMenu.create({
        menuId: 'serverControlsMenu',
        menuClass: 'server-controls-menu',
        ariaLabel: 'server controls',
        rows: buildItems
    });

    /**
     * Restart the web server. Delegates to the launchpad, which owns the
     * confirmation modal, the API call and the reload - the behaviour is
     * untouched by this menu, only the surface moved.
     *
     * @param {Function} notify - FabMenu.notify, the visible feedback
     *   channel. Used for the one case the launchpad cannot report,
     *   namely the launchpad not being loaded at all.
     * @returns {void}
     */
    /**
     * Open the server-status panel. The panel owns the fetch, the render
     * and its one destructive control; this row only opens it.
     *
     * @param {Function} notify - FabMenu.notify, the one feedback channel
     *   guaranteed to be visible above every overlay in this app.
     * @returns {void}
     */
    function openServerStatus(notify) {
        var panel = window.ServerStatusPanel;
        if (panel && typeof panel.open === 'function') {
            panel.open(menu.trigger());
            return;
        }
        if (typeof notify === 'function') {
            notify('server status unavailable right now', 'error');
        }
    }

    function restartServer(notify) {
        var lp = window.Launchpad;
        if (lp && typeof lp.restartServer === 'function') {
            lp.restartServer();
            return;
        }
        if (typeof notify === 'function') {
            notify('server controls unavailable right now', 'error');
        }
    }

    /**
     * The rows, in order. Built per open, per the FabMenu contract, so a
     * row that ever reflects live state reports the current value.
     *
     * @param {object} ctl - the FabMenu controller building them.
     * @returns {HTMLButtonElement[]}
     */
    function buildItems(ctl) {
        var c = ctl || menu;
        var statusRow = c.item(ENTRY_IDS[0], buildIcon('gauge'),
            'server status', openServerStatus);
        // Read-only apart from one control the panel confirms for itself,
        // so nothing here is danger-styled.
        statusRow.setAttribute('aria-label',
            'server status, sessions and host health');
        statusRow.setAttribute('title',
            'server status, sessions and host health');
        var restartRow = c.item(ENTRY_IDS[1], buildIcon('restart'),
            'restart server', restartServer);
        // Disruptive-adjacent: the web connection drops for a few
        // seconds. Not danger-styled, because nothing is destroyed - the
        // tmux sessions keep running and re-attach. The confirmation
        // modal says exactly that; see Launchpad.restartServer().
        restartRow.setAttribute('aria-label',
            'restart server, sessions keep running');
        restartRow.setAttribute('title',
            'restart server, sessions keep running');
        return [statusRow, restartRow];
    }

    /**
     * Wire the trigger. Idempotent through FabMenu.wire(), so a launchpad
     * re-render that hands over a fresh button cannot double-bind.
     *
     * @param {HTMLElement|null} btn - #server-controls-btn.
     * @returns {void}
     */
    function wire(btn) {
        menu.wire(btn);
    }

    window.ServerControlsMenu = {
        wire: wire,
        open: menu.open,
        close: menu.close,
        isOpen: menu.isOpen,
        buildItems: buildItems,
        ENTRY_IDS: ENTRY_IDS,
        ICONS: ICONS
    };
})();

console.log('[ServerControlsMenu Module] Exported as window.ServerControlsMenu');
