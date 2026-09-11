/**
 * The foot of the conversations list: the status-light key and the app's
 * version. Also carries missingNoteHtml(), kept as a no-op stub - see
 * that function's own docblock.
 *
 * WHY ITS OWN MODULE. Both halves are shared components that live
 * elsewhere (client/js/session-status-key.js and
 * client/js/version-footer.js), so all this does is join them in the one
 * order they appear. It is extracted from session-sidebar-rows.js purely
 * to keep that file under the project's 500-line budget - the budget is
 * enforced by tests/test_sidebar_sessions.node.mjs, and inlining these
 * twelve lines is what pushed it over.
 *
 * NEITHER HALF IS CONDITIONAL ON THE LIST HOLDING ANYTHING. The key
 * explains lights the user has already seen on the launchpad and in the
 * terminal header, and the version is not a property of this list, so
 * both ride the empty branches too.
 *
 * A MISSING MODULE RENDERS NOTHING, never a placeholder. Each half is
 * guarded independently, so a page that loaded one and not the other
 * still shows the one it has.
 *
 * Loads AFTER session-status-key.js and version-footer.js, and BEFORE
 * session-sidebar-rows.js, which calls it.
 */

console.log('[SessionSidebarFooter Module] Loading...');

(function () {
    /**
     * The list's footer markup.
     *
     * Description: PURE apart from reading the two globals. Returns the
     *   status-light key followed by the version line, either of which is
     *   '' when its module is absent.
     * Inputs: none.
     * Output: string - HTML, possibly empty.
     * Example:
     *   SessionSidebarFooter.html()
     *   // '<div class="session-status-key">...</div><div class="version-footer">...</div>'
     */
    function html() {
        const key = window.SessionStatusKey ? window.SessionStatusKey.keyHtml() : '';
        const version = window.VersionFooter ? window.VersionFooter.sidebarFooterHtml() : '';
        return key + version;
    }

    /**
     * Held slots for gone sessions render nothing on screen now.
     *
     * Description: the owner read the sentence this used to print
     *   ("N remembered positions are held for sessions not currently
     *   listed") and asked for it gone outright - it explained bookkeeping
     *   no reader could act on. The slots themselves are UNTOUCHED: they
     *   are still kept rather than dropped, and the count is still
     *   stamped on the list element itself as `data-order-missing` (see
     *   client/js/session-sidebar.js). This function only ever produced
     *   the sentence, so deleting the sentence means this always returns
     *   ''.
     * Inputs: missing (Array<string>) - the tmux names with no live row.
     *   Kept as a parameter so the call site in session-sidebar-rows.js
     *   does not have to change.
     * Output: string - always ''.
     * Example:
     *   SessionSidebarFooter.missingNoteHtml(['ghost'])   // ''
     */
    function missingNoteHtml(missing) {
        void missing;
        return '';
    }

    window.SessionSidebarFooter = { html, missingNoteHtml };
    console.log('[SessionSidebarFooter Module] Exported as window.SessionSidebarFooter');
})();
