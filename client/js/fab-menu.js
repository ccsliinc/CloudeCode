/**
 * Shared machinery for a small menu hung off a floating action button.
 * ----------------------------------------------------------------------
 * TWO CONTROLS, ONE MECHANISM. The terminal screen carries two
 * session-scoped FAB menus and they are deliberately NOT the same menu:
 *
 *   - #terminalToolsBtn  "tools"          getting content in and out of
 *                                          the terminal: copy output,
 *                                          paste from clipboard, attach
 *                                          image (terminal-tools-menu.js)
 *   - #sessionEditorBtn  "session editor" configuring the session
 *                                          itself: theme and music
 *                                          (session-editor-menu.js)
 *
 * What they share is only the plumbing: build a 16x16 icon, build a 44px
 * row, open anchored to the trigger, close on Escape or an outside
 * pointerdown, wire the trigger once. That plumbing lived twice and the
 * copies drifted - the same failure the FAB geometry tokens exist to
 * stop. It lives here once, and each menu declares only its own rows.
 *
 * ROWS ARE BUILT FRESH ON EVERY OPEN so a row that reflects live state
 * (the music opt-in) reports the current value rather than one captured
 * at wire time.
 */

console.log('[FabMenu Module] Loading...');

(function () {
    'use strict';

    /**
     * Build one 16x16 icon in the shared terminal-tool geometry.
     *
     * The stroke width is declared per path by the caller's icon body, on
     * purpose. A presentation attribute on the path beats a `stroke-width`
     * rule that targets the `svg`, so a stylesheet cannot be trusted to
     * normalise these - the value has to be right in the markup.
     *
     * @param {Object<string, string>} icons - name to inner SVG markup.
     * @param {string} name - a key of `icons`.
     * @returns {SVGElement|null} the icon, or null for an unknown name or
     *   a document with no createElementNS.
     */
    function buildIcon(icons, name) {
        var body = icons ? icons[name] : null;
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
     * Build one menu row: icon, label, and a click that closes first.
     *
     * @param {object} spec
     * @param {string} spec.id - the row's stable id, read by the tests.
     * @param {SVGElement|null} spec.icon - a built icon, or null.
     * @param {string} spec.label - lowercase user-facing text.
     * @param {Function} spec.onPick - invoked after the menu closes.
     * @param {Function} spec.close - the owning menu's close().
     * @returns {HTMLButtonElement}
     */
    function buildRow(spec) {
        var item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('id', spec.id);
        item.className = 'fab-menu__item';
        item.setAttribute('role', 'menuitem');

        if (spec.icon) item.appendChild(spec.icon);

        var text = document.createElement('span');
        text.className = 'fab-menu__label';
        text.textContent = spec.label;
        item.appendChild(text);

        item.addEventListener('click', function (e) {
            e.stopPropagation();
            spec.close();
            spec.onPick();
        });
        return item;
    }

    /**
     * Create one FAB menu controller. Each call owns its own trigger,
     * its own element and its own dismiss handlers, so two controllers
     * never fight over one another's state.
     *
     * @param {object} config
     * @param {string} config.menuId - the id given to the open element.
     * @param {string} config.menuClass - an extra class beside `fab-menu`.
     * @param {string} config.ariaLabel - the menu's accessible name.
     * @param {Function} config.rows - called per open with the controller
     *   and expected to return HTMLButtonElement[].
     * @returns {object} {open, close, isOpen, wire, trigger, item}
     */
    function create(config) {
        /** The open menu element, or null. Only ever one per controller. */
        var menuEl = null;

        /** The trigger button, or null until wire() runs. */
        var triggerEl = null;

        /** Document-level dismiss handlers, bound only while open. */
        var onDocPointer = null;
        var onDocKey = null;

        /**
         * True while this menu is on screen.
         * @returns {boolean}
         */
        function isOpen() {
            return menuEl !== null;
        }

        /**
         * Close the menu if open. Safe to call when it is not.
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
         * Build one row of this menu.
         *
         * @param {string} id - the row's stable id.
         * @param {SVGElement|null} icon - a built icon, or null.
         * @param {string} label - lowercase user-facing text.
         * @param {Function} onPick - invoked after the menu closes.
         * @returns {HTMLButtonElement}
         */
        function item(id, icon, label, onPick) {
            return buildRow({
                id: id, icon: icon, label: label, onPick: onPick, close: close
            });
        }

        /**
         * Open the menu anchored to the trigger. A second call re-opens it
         * with fresh state rather than stacking two menus.
         * @returns {void}
         */
        function open() {
            close();
            if (!triggerEl) return;

            menuEl = document.createElement('div');
            menuEl.className = 'fab-menu ' + config.menuClass;
            menuEl.setAttribute('id', config.menuId);
            menuEl.setAttribute('role', 'menu');
            menuEl.setAttribute('aria-label', config.ariaLabel);
            config.rows(controller).forEach(function (r) {
                menuEl.appendChild(r);
            });

            document.body.appendChild(menuEl);
            if (window.AnchorPopover) window.AnchorPopover.place(menuEl, triggerEl);
            triggerEl.setAttribute('aria-expanded', 'true');

            // Deferred one tick so the tap that opened the menu does not
            // immediately close it. Taps on the trigger are excluded
            // because its own click handler already toggles.
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
         * Wire the trigger. Idempotent: the click handler is attached
         * once, so a session swap re-calling this cannot double-bind and
         * toggle twice.
         *
         * @param {HTMLElement|null} btn - the FAB.
         * @returns {void}
         */
        function wire(btn) {
            if (!btn) return;
            triggerEl = btn;
            if (btn._fabMenuWired) return;
            btn._fabMenuWired = true;
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

        /**
         * The trigger this controller is wired to, or null.
         * @returns {HTMLElement|null}
         */
        function trigger() {
            return triggerEl;
        }

        var controller = {
            open: open,
            close: close,
            isOpen: isOpen,
            wire: wire,
            item: item,
            trigger: trigger
        };
        return controller;
    }

    window.FabMenu = {
        create: create,
        buildIcon: buildIcon
    };
})();

console.log('[FabMenu Module] Exported as window.FabMenu');
