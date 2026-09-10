/**
 * Session row ACTION MENU - opening it, moving around it, closing it.
 * ----------------------------------------------------------------------
 * The item table and the markup are in client/js/session-row-menu.js;
 * what each item does is in client/js/session-row-menu-actions.js. This
 * file is the only one that touches the document.
 *
 * IT OPENS BEFORE IT ASKS ANYTHING. Building the panel is a string
 * substitution over a context that was captured when the row was
 * painted, so the menu is on screen in the frame the trigger was
 * pressed. Nothing here awaits a request, and nothing an item needs from
 * the server is fetched until that item is chosen.
 *
 * THE PANEL IS MOUNTED ON document.body AND IS position: fixed. That is
 * a measured constraint rather than a preference: `.session-sidebar-panel`
 * carries a `translateX` for its slide, and a transformed ancestor
 * becomes the containing block for a fixed descendant, so a panel
 * rendered inside a sidebar row would be positioned against the sliding
 * sidebar and clipped by the list's own overflow. Mounting on the body
 * is what makes the viewport clamp mean what it says.
 *
 * THE TRIGGER'S CLICK IS CLAIMED IN THE CAPTURE PHASE, on the document.
 * Both surfaces route their row clicks through one bubble-phase listener
 * on a container (the sidebar list, the running-sessions list), and a
 * click on the trigger that reached either of them would ALSO switch
 * conversation. Capturing on the document runs before both, and
 * stopping propagation there is what keeps opening a menu from also
 * navigating. It is one listener for both surfaces, so neither can
 * acquire the behaviour without the other.
 *
 * THE KEYBOARD MODEL, and every clause in it earned its place:
 *
 *   * Letters are bound ONLY while the menu is open, on a document
 *     capture listener that is removed on close. There is no global
 *     shortcut here to collide with anything.
 *   * A handled key is consumed - preventDefault AND stopPropagation in
 *     the capture phase - so it can never also reach the terminal, which
 *     would type the letter into the running agent.
 *   * A key with ctrl, meta or alt held is NOT ours. Those are the OS's
 *     and the browser's, and swallowing them would break copy, paste and
 *     tab switching while a menu happened to be open.
 *   * ``event.repeat`` is ignored: a held-down key must run an action
 *     once, not once per autorepeat tick.
 *   * A composing IME is ignored (``isComposing``, and keyCode 229 for
 *     the engines that only report it that way). Mid-composition
 *     keystrokes are not letters yet.
 *   * A key typed into an input, textarea or contenteditable is ignored
 *     outright, so the inline rename editor this menu can open keeps
 *     every letter of the name being typed.
 *
 * FOCUS: the first item takes focus on open. Escape closes and returns
 * focus to the trigger, re-resolved by name because a repaint may have
 * replaced the button we opened from. Tab and a click outside close the
 * menu WITHOUT moving focus, so the thing the user tabbed or clicked to
 * is where they end up - a menu that yanked focus home on the way out
 * would undo the move that dismissed it.
 *
 * Load AFTER session-row-menu.js, session-row-menu-actions.js and
 * anchor-popover.js.
 */

console.log('[SessionRowMenuOpen Module] Loading...');

(function () {
    'use strict';

    /** The open panel, or null. Only ever one, app-wide. */
    var panelEl = null;

    /** The trigger the open panel belongs to, so focus can go home. */
    var triggerEl = null;

    /** The identity captured when the panel opened. Frozen for its life. */
    var openCtx = null;

    /** Document-level handlers, bound only while open. */
    var onDocPointer = null;
    var onDocKey = null;

    /** Scroll/resize closer and the element it is bound to. */
    var onReflow = null;
    var scrollEls = [];

    /** Gap kept from every screen edge; the placement rule's own margin. */
    function margin() {
        return (window.AnchorPopover && window.AnchorPopover.MARGIN) || 8;
    }

    /**
     * Description: is a menu open right now?
     * Inputs: none. Output: boolean.
     */
    function isOpen() { return !!panelEl; }

    /**
     * Description: the tmux name the open menu belongs to, or null.
     * Inputs: none. Output: string|null.
     */
    function openFor() { return openCtx ? openCtx.name : null; }

    /**
     * Description: the identity the open menu is acting on. Exposed so a
     *   test can prove an action ran against the row that was CLICKED
     *   rather than against whatever the last repaint left in its place.
     * Inputs: none. Output: object|null.
     */
    function context() { return openCtx; }

    /**
     * Description: every focusable item in the open panel, in order.
     *   DISABLED ITEMS ARE INCLUDED: they are focusable on purpose, so a
     *   keyboard user reaches the explanation instead of finding the
     *   entry silently missing.
     * Inputs: none. Output: Array<Element>.
     */
    function items() {
        if (!panelEl) return [];
        return Array.prototype.slice.call(
            panelEl.querySelectorAll('[role="menuitem"]'));
    }

    /**
     * Description: move focus within the open menu, wrapping at both
     *   ends.
     * Inputs: delta (number) - +1 next, -1 previous, 0 first,
     *   Infinity last.
     * Output: void.
     */
    function moveFocus(delta) {
        var list = items();
        if (!list.length) return;
        var at = list.indexOf(document.activeElement);
        var next;
        if (delta === 0) next = 0;
        else if (delta === Infinity) next = list.length - 1;
        else if (at === -1) next = delta > 0 ? 0 : list.length - 1;
        else next = (at + delta + list.length) % list.length;
        list[next].focus();
    }

    /**
     * Description: whether an event's target is somewhere text is being
     *   typed. A menu shortcut must never eat a character out of the
     *   rename editor this very menu can open.
     * Inputs: target (EventTarget|null). Output: boolean.
     */
    function isEditable(target) {
        if (!target || !target.tagName) return false;
        var tag = String(target.tagName).toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        return target.isContentEditable === true;
    }

    /**
     * Description: run the item a menu entry stands for, against the
     *   identity captured at open time.
     *
     *   A DISABLED ITEM DOES NOT RUN, and says so out loud rather than
     *   doing nothing: an entry that can be focused but not activated
     *   would otherwise read as a broken control. The menu STAYS OPEN in
     *   that case, because nothing happened and closing would hide the
     *   explanation the user just asked for.
     * Inputs: itemEl (Element) - a `[role="menuitem"]`.
     * Output: void.
     */
    function activate(itemEl) {
        var menu = window.SessionRowMenu;
        if (!itemEl || !menu) return;
        var id = itemEl.getAttribute(menu.ITEM_ATTR);
        if (!id) return;
        if (itemEl.getAttribute('aria-disabled') === 'true') {
            announce(itemEl.getAttribute('title') || 'that action is not available');
            return;
        }
        var ctx = openCtx;
        // CLOSED FIRST, AND FOCUS GOES HOME FIRST. Every one of these
        // ends in a repaint, a modal or a navigation, and a panel still
        // holding focus while its row is destroyed strands the caret on
        // a detached node.
        close({ restoreFocus: true });
        if (window.SessionRowMenuActions) {
            Promise.resolve(window.SessionRowMenuActions.run(id, ctx))
                .catch(function (err) {
                    console.error('[SessionRowMenu] "' + id + '" failed:', err);
                });
        }
    }

    /**
     * Description: say something in the app's live region, so a refusal
     *   reaches an assistive technology rather than only the screen.
     * Inputs: text (string). Output: void.
     */
    function announce(text) {
        var region = document.getElementById('session-sidebar-live');
        if (region) region.textContent = text;
    }

    /**
     * Description: close the open menu, if any.
     * Inputs: opts (object|null) - {restoreFocus (boolean)}. Focus is
     *   returned to the trigger ONLY when asked AND only when it is
     *   currently inside the menu: closing because the user tabbed or
     *   clicked elsewhere must not yank focus off what they moved to.
     * Output: void.
     */
    function close(opts) {
        var restore = !!(opts && opts.restoreFocus);
        if (onDocPointer) {
            document.removeEventListener('pointerdown', onDocPointer, true);
            onDocPointer = null;
        }
        if (onDocKey) {
            document.removeEventListener('keydown', onDocKey, true);
            onDocKey = null;
        }
        if (onReflow) {
            scrollEls.forEach(function (el) {
                el.removeEventListener('scroll', onReflow);
            });
            window.removeEventListener('resize', onReflow);
            onReflow = null;
            scrollEls = [];
        }
        var hadFocus = !!(panelEl && panelEl.contains(document.activeElement));
        var forName = openCtx ? openCtx.name : null;
        if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
        panelEl = null;
        openCtx = null;
        var trigger = triggerEl;
        triggerEl = null;
        if (!trigger) return;
        // A POLL REPAINT REWRITES THE WHOLE LIST, so the trigger we
        // opened from can be a detached node by now. Re-resolve it by
        // name, so `aria-expanded` is cleared on the button the user can
        // see rather than on a corpse.
        var menu = window.SessionRowMenu;
        var live = document.contains(trigger)
            ? trigger
            : (forName && menu && document.querySelector(
                '[' + menu.TRIGGER_ATTR + '="' + CSS.escape(forName) + '"]'));
        (live || trigger).setAttribute('aria-expanded', 'false');
        if (!restore || !hadFocus) return;
        if (live && typeof live.focus === 'function') live.focus();
    }

    /**
     * Description: cap the panel's height to the visible viewport, so a
     *   list taller than the screen scrolls INSIDE itself instead of
     *   running off the bottom. Done before placement, because the
     *   placement rule clamps a box's position and cannot rescue a box
     *   that does not fit.
     * Inputs: panel (Element). Output: void.
     */
    function clampHeight(panel) {
        var vp = window.visualViewport || null;
        var vh = vp ? vp.height : window.innerHeight;
        panel.style.maxHeight = Math.max(0, vh - (margin() * 2)) + 'px';
    }

    /**
     * Description: open the menu for one trigger.
     *
     *   Opening closes whatever was open first, so there is never a
     *   second menu on screen, and captures the row's identity ONCE. The
     *   panel is built from that snapshot and never re-reads the row.
     * Inputs:
     *   trigger (Element) - a rendered `[data-row-menu]` button.
     *   opts (object|null) - optional `{point: {x, y}}`. When given the
     *     panel is placed AT THAT POINT instead of against the trigger,
     *     which is what keeps a right-click and a long-press opening
     *     where the user actually pressed. The trigger is still the
     *     identity and the focus-return target; only the geometry moves.
     *     See client/js/session-row-menu-gestures.js.
     * Output: boolean - whether a menu is now open.
     */
    function open(trigger, opts) {
        close({ restoreFocus: false });
        var menu = window.SessionRowMenu;
        if (!trigger || !menu) return false;
        var ctx = menu.contextFromTrigger(trigger);
        if (!ctx || !ctx.name) return false;

        var panel = document.createElement('div');
        panel.id = menu.PANEL_ID;
        panel.className = menu.PANEL_CLASS;
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', 'actions for ' + (ctx.label || ctx.name));
        panel.setAttribute('data-row-menu-for', ctx.name);
        panel.innerHTML = menu.panelHtml(ctx);
        document.body.appendChild(panel);

        panelEl = panel;
        triggerEl = trigger;
        openCtx = ctx;
        trigger.setAttribute('aria-expanded', 'true');
        clampHeight(panel);
        var point = (opts && opts.point) || null;
        if (window.AnchorPopover) {
            if (point && typeof window.AnchorPopover.placeAt === 'function') {
                window.AnchorPopover.placeAt(panel, point.x, point.y);
            } else {
                window.AnchorPopover.place(panel, trigger);
            }
        }

        panel.addEventListener('click', function (e) {
            var itemEl = e.target.closest
                ? e.target.closest('[' + menu.ITEM_ATTR + ']') : null;
            e.preventDefault();
            e.stopPropagation();
            if (itemEl) activate(itemEl);
        });

        onDocKey = function (ev) { onKey(ev); };
        // ESCAPE AND THE LETTERS ARE BOUND SYNCHRONOUSLY. Deferring them
        // leaves a real window, measured in Chromium, in which the menu
        // is on screen and Escape does nothing. Nothing needs the defer
        // here: the keydown that opens a menu (Enter or Space on the
        // trigger) is delivered before the click it synthesises, so this
        // listener cannot see it.
        document.addEventListener('keydown', onDocKey, true);

        onDocPointer = function (ev) {
            if (!panelEl) return;
            if (panelEl.contains(ev.target)) return;
            if (triggerEl && triggerEl.contains(ev.target)) return;
            // NO FOCUS RESTORE. The user is pointing at something else,
            // and that is where they should end up.
            close({ restoreFocus: false });
        };
        // The POINTER handler stays deferred a tick so the pointerdown
        // that opened this cannot immediately dismiss it.
        setTimeout(function () {
            if (!panelEl) return;
            document.addEventListener('pointerdown', onDocPointer, true);
        }, 0);

        // A FIXED PANEL OVER A SCROLLING LIST MUST NOT HANG IN SPACE.
        // Closing is the honest answer: the row it belongs to has moved,
        // and re-placing it every frame would make a phone scroll stutter.
        onReflow = function () { close({ restoreFocus: false }); };
        scrollEls = ['session-sidebar-list', 'running-sessions-list']
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
        scrollEls.forEach(function (el) {
            el.addEventListener('scroll', onReflow, { passive: true });
        });
        window.addEventListener('resize', onReflow, { passive: true });

        moveFocus(0);
        return true;
    }

    /**
     * Description: the key handler bound for the life of one open menu.
     *   See this file's docblock for why each guard is here.
     * Inputs: ev (KeyboardEvent). Output: void.
     */
    function onKey(ev) {
        if (!panelEl) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.repeat) return;
        if (ev.isComposing === true || ev.keyCode === 229) return;
        if (isEditable(ev.target)) return;

        var menu = window.SessionRowMenu;
        var key = ev.key;

        if (key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            close({ restoreFocus: true });
            return;
        }
        if (key === 'Tab') {
            // NOT CONSUMED. Tab is the browser's, and its destination is
            // where the user asked to go; the menu simply gets out of the
            // way without touching focus.
            close({ restoreFocus: false });
            return;
        }

        var inside = panelEl.contains(document.activeElement);
        if (key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); moveFocus(1); return; }
        if (key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); moveFocus(-1); return; }
        if (key === 'Home') { ev.preventDefault(); ev.stopPropagation(); moveFocus(0); return; }
        if (key === 'End') { ev.preventDefault(); ev.stopPropagation(); moveFocus(Infinity); return; }
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            if (!inside) return;
            ev.preventDefault();
            ev.stopPropagation();
            activate(document.activeElement);
            return;
        }
        var id = menu ? menu.itemIdForKey(key) : null;
        if (!id) return;
        ev.preventDefault();
        ev.stopPropagation();
        var itemEl = panelEl.querySelector(
            '[' + menu.ITEM_ATTR + '="' + id + '"]');
        if (itemEl) activate(itemEl);
    }

    /**
     * Description: claim a click on any row's trigger, on either surface,
     *   before the container click routers see it. One listener, bound
     *   once, in the capture phase - see this file's docblock.
     * Inputs: e (MouseEvent). Output: void.
     */
    function onDocumentClickCapture(e) {
        var menu = window.SessionRowMenu;
        if (!menu || !e.target || typeof e.target.closest !== 'function') return;
        var trigger = e.target.closest('[' + menu.TRIGGER_ATTR + ']');
        if (!trigger) return;
        e.preventDefault();
        e.stopPropagation();
        var name = trigger.getAttribute(menu.TRIGGER_ATTR);
        // A SECOND PRESS ON THE SAME ROW CLOSES. Rebuilding the panel in
        // place would look like nothing happened.
        if (isOpen() && openFor() === name) {
            close({ restoreFocus: true });
            return;
        }
        open(trigger);
    }

    document.addEventListener('click', onDocumentClickCapture, true);

    window.SessionRowMenuOpen = {
        open: open,
        close: close,
        isOpen: isOpen,
        openFor: openFor,
        context: context,
        items: items,
        moveFocus: moveFocus,
        activate: activate,
        clampHeight: clampHeight,
        isEditable: isEditable,
        onKey: onKey,
    };
})();

console.log('[SessionRowMenuOpen Module] Exported as window.SessionRowMenuOpen');
