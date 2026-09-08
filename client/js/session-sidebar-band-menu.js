/**
 * The kebab menu for a RESERVED band header - `pinned` or `other` - as
 * opposed to a real user group, which opens its own rename/reorder/
 * delete menu from session-sidebar-group-actions.js.
 *
 * WHY THIS IS ITS OWN FILE. Every group header now renders a kebab, not
 * only a real group's ("pinned and the other doesnt have a kebab. maybe
 * just give it one."). The reserved bands' version of that menu is a
 * small, separate concern - it has nothing to rename or delete, so it
 * offers only what already applies to any section - and adding it
 * inline pushed session-sidebar-group-actions.js over the 500-line
 * budget. Splitting it out is the same move this project already made
 * for session-sidebar-clicks.js and session-sidebar-drop-target.js: more
 * small files instead of one growing one.
 *
 * NO NEW ACTION IS INVENTED HERE. Fold/unfold is the one thing every
 * header already does (the chevron performs it); this is a second route
 * to that same `arrangement.toggleCollapsed` call, offered here so the
 * kebab column is never empty for a header that has nothing else to
 * offer. If a reserved band ever grows a real bulk action (mark-all-
 * read, for one - not implemented anywhere in this app today, so it is
 * not offered here either), it is added to `entries` alongside fold,
 * not as a reason to duplicate the menu.
 *
 * Must load AFTER session-sidebar-group-actions.js, whose `showMenu`,
 * `announce` and `repaint` this reuses rather than re-implementing the
 * positioned-menu widget or the live-region announcer a second time.
 */

console.log('[SessionSidebarBandMenu Module] Loading...');

(function () {
    /**
     * Description: open the reserved-band kebab menu, anchored near the
     *   button that was clicked.
     * Inputs: anchor (Element) - the kebab button.
     *   key (string) - 'pinned' or 'other'.
     * Output: void.
     * Example: open(kebabEl, 'pinned')
     */
    function open(anchor, key) {
        const GA = window.SessionSidebarGroupActions;
        const arrangement = window.SessionSidebarArrangement;
        const groups = window.SessionSidebarGroups;
        if (!GA || !arrangement || !key) return;
        const label = groups ? groups.labelFor(key) : key;
        const collapsed = arrangement.isCollapsed(key);
        const entries = [{
            label: collapsed ? 'expand' : 'collapse',
            onPick: () => {
                arrangement.toggleCollapsed(key);
                GA.repaint();
                GA.announce(`${label} group ${collapsed ? 'expanded' : 'collapsed'}`);
            },
        }];
        GA.showMenu(anchor, entries, `Actions for the ${label} group`);
    }

    window.SessionSidebarBandMenu = { open };
    console.log('[SessionSidebarBandMenu Module] Exported as window.SessionSidebarBandMenu');
})();
