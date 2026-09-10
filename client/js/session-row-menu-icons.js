/**
 * The glyphs prefixing the row action menu's items, in ONE place.
 * ----------------------------------------------------------------------
 * Same pattern as client/js/kebab-icon.js: a single builder function
 * returning a self-contained `<svg>` string, so client/js/session-row-
 * menu.js has one call site instead of eight inline literals that could
 * drift out of sync with each other across the panel and the launchpad's
 * copy of it (there is only one copy - this module is what keeps it
 * that way).
 *
 * ALSO REUSED BY THE GROUP HEADER MENU. `move-up` and `move-down` were
 * added for client/js/session-sidebar-group-actions.js's `openGroupMenu`
 * so the group menu's reorder entries could carry the same icon treatment
 * as the row menu, rather than the group menu growing a second icon
 * system. The two consumers share this one glyph set for that reason -
 * do not fork a second builder for the group menu.
 *
 * Every glyph shares one visual family: a 16-unit viewBox, `fill="none"`,
 * `stroke="currentColor"`, round caps and joins. `currentColor` is what
 * makes every icon here follow the item's own text colour - including
 * the close item's hover-to-red (client/css/session-row-menu.css sets
 * `color` on the hovered/focused button, and every descendant's
 * `currentColor` resolves against that with no separate rule needed).
 * The close glyph is the one exception to matching stroke-width: it is
 * drawn heavier (1.6 against 1.3 elsewhere) because it is the one
 * destructive entry in the row menu and is meant to read that way even
 * before the red hover fires.
 *
 * `aria-hidden="true"` on every glyph, because the button around it
 * already carries the accessible name via its label text - a screen
 * reader must read "rename", not "rename icon rename".
 *
 * No dependencies. Must load BEFORE session-row-menu.js AND BEFORE
 * session-sidebar-group-actions.js.
 */

console.log('[SessionRowMenuIcons Module] Loading...');

(function () {
    'use strict';

    /**
     * The rendered size, in CSS pixels, used when no size is passed. Sized
     * to sit beside the panel's 0.68em item label
     * (client/css/session-row-menu.css).
     * @type {number}
     */
    var DEFAULT_SIZE = 14;

    /**
     * One glyph's inner markup (everything between the `<svg ...>` open
     * tag this module adds and its own `</svg>`), keyed by the same item
     * id `client/js/session-row-menu-items.js` uses. Every path here is
     * `stroke="currentColor" fill="none"` on a 0 0 16 16 grid.
     * @type {Object<string, string>}
     */
    var GLYPHS = {
        // A pencil, tip trailing a short diagonal stroke.
        rename:
            '<path d="M11.15 2.15a1.2 1.2 0 0 1 1.7 0l1 1a1.2 1.2 0 0 1 0 1.7'
            + 'l-7.4 7.4-3.2.8.8-3.2z" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linejoin="round" stroke-linecap="round"/>'
            + '<path d="M9.7 3.6l2.7 2.7" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linecap="round"/>',
        // A ringed dot - the flag this item plants on a conversation.
        'mark-unread':
            '<circle cx="8" cy="8" r="5.25" stroke="currentColor" stroke-width="1.3"/>'
            + '<circle cx="8" cy="8" r="2" fill="currentColor"/>',
        // A folder, tabbed at the top left.
        'move-to-group':
            '<path d="M2 4.5A1.25 1.25 0 0 1 3.25 3.25h3l1.25 1.5h5.25'
            + 'A1.25 1.25 0 0 1 14 6v6.25A1.25 1.25 0 0 1 12.75 13.5h-9.5'
            + 'A1.25 1.25 0 0 1 2 12.25z" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linejoin="round"/>',
        // A branch - three points, two lines, the standard fork glyph.
        fork:
            '<circle cx="4" cy="3.25" r="1.5" stroke="currentColor" stroke-width="1.3"/>'
            + '<circle cx="4" cy="12.75" r="1.5" stroke="currentColor" stroke-width="1.3"/>'
            + '<circle cx="12" cy="6.25" r="1.5" stroke="currentColor" stroke-width="1.3"/>'
            + '<path d="M4 4.75v6.5" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linecap="round"/>'
            + '<path d="M4 8.5c0-1.8 1.4-2.75 3-2.75h3.6" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round"/>',
        // A plain plus.
        'new-in-folder':
            '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" '
            + 'stroke-linecap="round"/>',
        // A bell, clapper, and the diagonal slash through both.
        mute:
            '<path d="M4.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5l1.2 1.8a.5.5 0 0 1-.4.7'
            + 'H3.7a.5.5 0 0 1-.4-.7z" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linejoin="round" stroke-linecap="round"/>'
            + '<path d="M6.5 13a1.5 1.5 0 0 0 3 0" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round"/>'
            + '<path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.4" '
            + 'stroke-linecap="round"/>',
        // Two arcs, each carrying an arrowhead - a refresh/restart loop.
        restart:
            '<path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
            + '<path d="M13 3v3h-3" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linecap="round" stroke-linejoin="round"/>'
            + '<path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
            + '<path d="M3 13v-3h3" stroke="currentColor" stroke-width="1.3" '
            + 'stroke-linecap="round" stroke-linejoin="round"/>',
        // A bold X - the one destructive entry, drawn heavier than the rest.
        close:
            '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" '
            + 'stroke-linecap="round"/>',
        // A single shaft with an arrowhead at the top - reorder up. Used
        // by the group header menu.
        'move-up':
            '<path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
        // The same shaft, arrowhead at the bottom - reorder down. Used by
        // the group header menu.
        'move-down':
            '<path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke="currentColor" '
            + 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    };

    /**
     * Description: one item's glyph as a self-contained `<svg>` string,
     *   ready to interpolate into a menu item's innerHTML.
     * Inputs:
     *   id (string) - a session-row-menu-items.js item id (`rename`,
     *     `mark-unread`, `move-to-group`, `fork`, `new-in-folder`,
     *     `mute`, `restart`, `close`), or one of the group-menu-only ids
     *     (`move-up`, `move-down`).
     *   size (number|undefined) - rendered width and height in CSS
     *     pixels. Defaults to DEFAULT_SIZE (14).
     * Output:
     *   string - one `<svg>` element, or '' for an id with no glyph
     *     (never an id this menu ships with, but a caller that mistypes
     *     one gets a silent blank rather than a thrown error - the row
     *     it sits in must not take the sidebar down with it).
     * Example:
     *   SessionRowMenuIcons.svg('restart')    // 14x14
     *   SessionRowMenuIcons.svg('close', 16)  // 16x16
     */
    function svg(id, size) {
        var inner = GLYPHS[id];
        if (!inner) return '';
        var px = (typeof size === 'number' && size > 0) ? size : DEFAULT_SIZE;
        return (
            '<svg width="' + px + '" height="' + px + '" viewBox="0 0 16 16" '
            + 'fill="none" aria-hidden="true">' + inner + '</svg>'
        );
    }

    window.SessionRowMenuIcons = { svg: svg, DEFAULT_SIZE: DEFAULT_SIZE };
})();

console.log('[SessionRowMenuIcons Module] Exported as window.SessionRowMenuIcons');
