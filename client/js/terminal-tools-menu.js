/**
 * Session tools menu - ONE control for every session-scoped tool.
 * ----------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY.
 *
 * The terminal screen used to carry two separate tool surfaces:
 *
 *   1. a tool strip pinned over the terminal's TOP-RIGHT corner, folded
 *      behind #terminalToolsToggle, holding copy output / session theme /
 *      session music (client/js/terminal-tools-fold.js, deleted);
 *   2. a paperclip FAB in the BOTTOM-RIGHT corner whose own popup held
 *      paste from clipboard / attach image (the menu half of
 *      client/js/clipboard.js, deleted).
 *
 * Two collapsing menus, in two corners, both of them "session tools",
 * with no rule a user could learn for which tool lived in which. The
 * standing goal has been fewer blocking elements over the terminal, so
 * they are now ONE menu behind ONE button. The top-right overlay is gone
 * entirely: the terminal's top edge is no longer covered at all, and the
 * remaining trigger sits in the bottom-right FAB column next to the d-pad
 * where a floating control already lived.
 *
 * WHAT IS STILL SEPARATE. The header kebab (#header-menu-toggle,
 * header-menu.js) is APP-scoped - home, detach, logout, settings, claude
 * config - and is present on every screen, including the launchpad where
 * a session theme would be meaningless. This menu is SESSION-scoped and
 * only exists while a session is attached. Folding one into the other
 * would put session actions on screens with no session. They stay
 * separate, in different corners, with different glyphs.
 *
 * ENTRIES ARE BUILT FRESH ON EVERY OPEN so the music row always reports
 * the live per-session opt-in rather than a state captured at wire time.
 */

console.log('[TerminalToolsMenu Module] Loading...');

(function () {
    'use strict';

    /** Stable ids for the menu rows. Read by the tests. */
    var ENTRY_IDS = [
        'toolCopyOutput',
        'toolPasteClipboard',
        'toolAttachImage',
        'toolSessionTheme',
        'toolSessionMusic'
    ];

    /** The open menu element, or null. Only ever one. */
    var menuEl = null;

    /** The Terminal wrapper handed over by terminal.js, or null. */
    var termWrapper = null;

    /** The trigger button and the hidden file input, or null. */
    var triggerEl = null;
    var fileInputEl = null;

    /** Document-level dismiss handlers, bound only while open. */
    var onDocPointer = null;
    var onDocKey = null;

    /**
     * Icons, in the terminal-tool set's exact geometry: a 16x16 viewBox
     * rendered at 16x16, `fill="none"`, and stroke-width declared on
     * every path as a presentation attribute.
     *
     * The stroke width is per-path on purpose. A presentation attribute on
     * the path beats a `stroke-width` rule that targets the `svg`, so a
     * stylesheet cannot be trusted to normalise these - the value has to
     * be right in the markup. Same reason the icons in index.html carry
     * theirs inline.
     *
     * @type {Object<string, string>}
     */
    var ICONS = {
        copy:
            '<rect x="5.5" y="5.5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>' +
            '<path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        paste:
            '<path d="M4.5 3.5h-1a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
            '<rect x="5.5" y="1.5" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>',
        image:
            '<rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>' +
            '<path d="m3 11 3-3 2.5 2.5L11 8l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<circle cx="6" cy="6.5" r="1" stroke="currentColor" stroke-width="1.5"/>',
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
     * Build one 16x16 icon in the shared geometry.
     *
     * @param {string} name - a key of ICONS.
     * @returns {SVGElement|null} the icon, or null for an unknown name.
     */
    function buildIcon(name) {
        var body = ICONS[name];
        if (!body) return null;
        if (typeof document.createElementNS !== 'function') return null;
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = body;
        return svg;
    }

    /**
     * True when this session's music opt-in is on. Defaults to false, and
     * says so honestly when the theme layer is not loaded.
     *
     * @returns {boolean}
     */
    function musicIsOn() {
        var menu = window.SessionThemeMenu;
        if (!menu || typeof menu.isAudioOn !== 'function') return false;
        var themes = window.Themes;
        var name = themes && typeof themes.getActiveSession === 'function'
            ? themes.getActiveSession()
            : null;
        return !!menu.isAudioOn(name);
    }

    /**
     * Build one menu row.
     *
     * @param {string} id - one of ENTRY_IDS.
     * @param {string} icon - a key of ICONS.
     * @param {string} label - lowercase user-facing text.
     * @param {Function} onPick - invoked on click, after the menu closes.
     * @returns {HTMLButtonElement}
     */
    function buildItem(id, icon, label, onPick) {
        var item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('id', id);
        item.className = 'terminal-tools-menu__item';
        item.setAttribute('role', 'menuitem');

        var glyph = buildIcon(icon);
        if (glyph) item.appendChild(glyph);

        var text = document.createElement('span');
        text.className = 'terminal-tools-menu__label';
        text.textContent = label;
        item.appendChild(text);

        item.addEventListener('click', function (e) {
            e.stopPropagation();
            close();
            onPick();
        });
        return item;
    }

    /**
     * The five rows, in order. Built per open so the music row reflects
     * the live opt-in.
     *
     * @returns {HTMLButtonElement[]}
     */
    function buildItems() {
        var musicOn = musicIsOn();
        var rows = [
            buildItem(ENTRY_IDS[0], 'copy', 'copy output', function () {
                if (window.CopyOutput) window.CopyOutput.open(termWrapper);
            }),
            buildItem(ENTRY_IDS[1], 'paste', 'paste from clipboard', function () {
                if (window.ClipboardTools) {
                    window.ClipboardTools.pasteFromClipboard(termWrapper);
                }
            }),
            buildItem(ENTRY_IDS[2], 'image', 'attach image', function () {
                if (fileInputEl) fileInputEl.click();
            }),
            buildItem(ENTRY_IDS[3], 'theme', 'session theme', function () {
                if (window.SessionThemeMenu && triggerEl) {
                    window.SessionThemeMenu.open(triggerEl);
                }
            }),
            // Short label, one line. The full sentence lives in the
            // title/aria-label so the row stays a 44px list row.
            buildItem(ENTRY_IDS[4], 'music',
                musicOn ? 'stop music' : 'play music',
                function () {
                    if (window.SessionThemeMenu &&
                        typeof window.SessionThemeMenu.toggleAudio === 'function') {
                        window.SessionThemeMenu.toggleAudio(termWrapper);
                    }
                })
        ];
        if (musicOn) rows[4].classList.add('is-on');
        rows[4].setAttribute('aria-pressed', musicOn ? 'true' : 'false');
        var musicLabel = musicOn
            ? 'turn off music for this session'
            : 'play music for this session';
        rows[4].setAttribute('aria-label', musicLabel);
        rows[4].setAttribute('title', musicLabel);
        return rows;
    }

    /**
     * Open the menu anchored to the trigger. A second call re-opens it
     * with fresh state rather than stacking two menus.
     *
     * @returns {void}
     */
    function open() {
        close();
        if (!triggerEl) return;

        menuEl = document.createElement('div');
        menuEl.className = 'terminal-tools-menu';
        menuEl.setAttribute('id', 'terminalToolsMenu');
        menuEl.setAttribute('role', 'menu');
        menuEl.setAttribute('aria-label', 'session tools');
        buildItems().forEach(function (row) { menuEl.appendChild(row); });

        document.body.appendChild(menuEl);
        if (window.AnchorPopover) window.AnchorPopover.place(menuEl, triggerEl);
        triggerEl.setAttribute('aria-expanded', 'true');

        // Deferred one tick so the tap that opened the menu does not
        // immediately close it. Taps on the trigger are excluded because
        // its own click handler already toggles.
        onDocPointer = function (e) {
            if (!menuEl) return;
            if (menuEl.contains(e.target)) return;
            if (triggerEl && triggerEl.contains(e.target)) return;
            close();
        };
        onDocKey = function (e) {
            if (e.key === 'Escape') close();
        };
        setTimeout(function () {
            document.addEventListener('pointerdown', onDocPointer, true);
            document.addEventListener('keydown', onDocKey, true);
        }, 0);
    }

    /**
     * Close the menu if open. Safe to call when it is not.
     *
     * @returns {void}
     */
    function close() {
        if (onDocPointer) {
            document.removeEventListener('pointerdown', onDocPointer, true);
            onDocPointer = null;
        }
        if (onDocKey) {
            document.removeEventListener('keydown', onDocKey, true);
            onDocKey = null;
        }
        if (menuEl) {
            menuEl.remove();
            menuEl = null;
        }
        if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
    }

    /**
     * True while the menu is on screen.
     *
     * @returns {boolean}
     */
    function isOpen() {
        return menuEl !== null;
    }

    /**
     * Wire the trigger and remember the terminal it acts on. Idempotent:
     * the click handler is attached once, and a later session swap only
     * replaces the wrapper the entries act on.
     *
     * @param {object} wrapper - the Terminal wrapper (status pill, ws).
     * @param {HTMLElement} btn - #terminalToolsBtn.
     * @param {HTMLElement} input - the hidden image file input.
     * @returns {void}
     */
    function wire(wrapper, btn, input) {
        termWrapper = wrapper;
        fileInputEl = input || fileInputEl;
        if (!btn) return;
        triggerEl = btn;
        if (btn._terminalToolsWired) return;
        btn._terminalToolsWired = true;
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isOpen()) {
                close();
            } else {
                open();
            }
        });
    }

    window.TerminalToolsMenu = {
        wire: wire,
        open: open,
        close: close,
        isOpen: isOpen,
        buildItems: buildItems,
        ENTRY_IDS: ENTRY_IDS,
        ICONS: ICONS
    };
})();

console.log('[TerminalToolsMenu Module] Exported as window.TerminalToolsMenu');
