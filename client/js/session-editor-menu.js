/**
 * Session editor - what this session LOOKS AND SOUNDS like.
 * ----------------------------------------------------------------------
 * TWO ROWS: session theme and session music. Neither one moves content;
 * both configure the session you are currently looking at. That is the
 * whole distinction from the terminal tools menu next to it, whose three
 * rows all move content across the terminal's boundary.
 *
 * WHY IT IS ITS OWN CONTROL AND NOT A ROW OF SOMETHING ELSE.
 *
 *   - Not the terminal tools menu. They were merged into one drawer once
 *     and the grouping had no rule a user could learn. Configuring a
 *     session and copying its output are different jobs.
 *   - Not the header kebab. That is APP-scoped - home, detach, logout,
 *     settings - and is mounted on every screen including the launchpad,
 *     where "theme for this session" names nothing.
 *   - Not the session sidebar row menu. That surface acts on sessions you
 *     are NOT looking at; theme is a per-session identity cue you set
 *     while looking at the session it marks, so it belongs on the
 *     terminal screen beside the terminal it recolours.
 *
 * So: its own FAB, its own glyph, in the same bottom row as the d-pad and
 * the tools button, hidden on every screen with no session attached.
 *
 * The rows delegate to session-theme-menu.js, which still owns the theme
 * picker, the per-session music opt-in and its persistence. This module
 * is the control surface only.
 */

console.log('[SessionEditorMenu Module] Loading...');

(function () {
    'use strict';

    /** Stable ids for the menu rows, in declaration order. Read by tests. */
    var ENTRY_IDS = [
        'sessionThemeRow',
        'sessionMusicRow'
    ];

    /** The Terminal wrapper handed over by terminal.js, or null. */
    var termWrapper = null;

    /**
     * Icons, in the terminal-tool set's exact geometry: a 16x16 viewBox
     * rendered at 16x16, `fill="none"`, and stroke-width declared on
     * every stroked shape as a presentation attribute.
     *
     * @type {Object<string, string>}
     */
    var ICONS = {
        theme:
            '<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.69 0 1.25-.56 1.25-1.25 0-.32-.13-.62-.34-.84a1.19 1.19 0 0 1 .84-2.03h1.44A3.06 3.06 0 0 0 14.25 7 6.25 6.25 0 0 0 8 1.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
            '<circle cx="5.25" cy="6" r="0.9" fill="currentColor"/>' +
            '<circle cx="8" cy="4.5" r="0.9" fill="currentColor"/>' +
            '<circle cx="10.75" cy="6" r="0.9" fill="currentColor"/>',
        music:
            '<path d="M6.5 5.5 9.5 3v10L6.5 10.5H4a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5h2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
            '<path d="M11.75 6.25a2.5 2.5 0 0 1 0 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    };

    /**
     * Build one 16x16 icon from this menu's set.
     *
     * @param {string} name - a key of ICONS.
     * @returns {SVGElement|null}
     */
    function buildIcon(name) {
        return window.FabMenu ? window.FabMenu.buildIcon(ICONS, name) : null;
    }

    /**
     * True when this session's music opt-in is on. Defaults to false, and
     * says so honestly when the theme layer is not loaded.
     *
     * @returns {boolean}
     */
    function musicIsOn() {
        var themeMenu = window.SessionThemeMenu;
        if (!themeMenu || typeof themeMenu.isAudioOn !== 'function') return false;
        var themes = window.Themes;
        var name = themes && typeof themes.getActiveSession === 'function'
            ? themes.getActiveSession()
            : null;
        return !!themeMenu.isAudioOn(name);
    }

    /** The controller. Its plumbing is shared; its rows are not. */
    var menu = window.FabMenu.create({
        menuId: 'sessionEditorMenu',
        menuClass: 'session-editor-menu',
        ariaLabel: 'session editor',
        rows: buildItems
    });

    /**
     * The two rows, in order. Built per open so the music row reports the
     * live per-session opt-in rather than one captured at wire time.
     *
     * @param {object} ctl - the FabMenu controller building them.
     * @returns {HTMLButtonElement[]}
     */
    function buildItems(ctl) {
        var c = ctl || menu;
        var musicOn = musicIsOn();
        var rows = [
            c.item(ENTRY_IDS[0], buildIcon('theme'), 'session theme', function () {
                var anchor = c.trigger();
                if (window.SessionThemeMenu && anchor) {
                    window.SessionThemeMenu.open(anchor);
                }
            }),
            // Short label, one line. The full sentence lives in the
            // title/aria-label so the row stays a 44px list row.
            c.item(ENTRY_IDS[1], buildIcon('music'),
                musicOn ? 'stop music' : 'play music',
                function () {
                    if (window.SessionThemeMenu &&
                        typeof window.SessionThemeMenu.toggleAudio === 'function') {
                        window.SessionThemeMenu.toggleAudio(termWrapper);
                    }
                })
        ];
        if (musicOn) rows[1].classList.add('is-on');
        rows[1].setAttribute('aria-pressed', musicOn ? 'true' : 'false');
        var label = musicOn
            ? 'turn off music for this session'
            : 'play music for this session';
        rows[1].setAttribute('aria-label', label);
        rows[1].setAttribute('title', label);
        return rows;
    }

    /**
     * Wire the trigger and remember the terminal the rows act on.
     * Idempotent: a later session swap only replaces the wrapper.
     *
     * @param {object} wrapper - the Terminal wrapper (status pill).
     * @param {HTMLElement} btn - #sessionEditorBtn.
     * @returns {void}
     */
    function wire(wrapper, btn) {
        termWrapper = wrapper;
        menu.wire(btn);
    }

    window.SessionEditorMenu = {
        wire: wire,
        open: menu.open,
        close: menu.close,
        isOpen: menu.isOpen,
        buildItems: buildItems,
        ENTRY_IDS: ENTRY_IDS,
        ICONS: ICONS
    };
})();

console.log('[SessionEditorMenu Module] Exported as window.SessionEditorMenu');
