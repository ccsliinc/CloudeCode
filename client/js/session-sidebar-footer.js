/**
 * The foot of the conversations list: the remembered-positions note, the
 * status-light key, and the app's version.
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
     * Escape a value for interpolation into an HTML attribute or text.
     *
     * Description: string-based on purpose - the `textContent`/`innerHTML`
     *   idiom does not escape quotes, and a tmux session name is free
     *   text the user chose, so it can carry one.
     * Inputs: v (any) - stringified; null/undefined become ''.
     * Output: string.
     * Example: esc('a"b') -> 'a&quot;b'
     */
    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * The note naming remembered positions whose sessions are not running.
     *
     * Description: deliberately not an error and not a silent drop. The
     *   slots are KEPT and the count says so out loud, because a
     *   remembered position quietly vanishing is how a user comes to
     *   believe the app forgot their arrangement.
     * Inputs: missing (Array<string>) - the tmux names with no live row.
     * Output: string - HTML, or '' when nothing is missing.
     * Example:
     *   SessionSidebarFooter.missingNoteHtml(['ghost'])
     *   // '<div class="session-sidebar-note" data-order-missing="1" ...'
     */
    function missingNoteHtml(missing) {
        if (!missing || !missing.length) return '';
        const n = missing.length;
        const names = esc(missing.join(', '));
        return (
            `<div class="session-sidebar-note" data-order-missing="${n}" title="${names}">` +
            `${n} remembered ${n === 1 ? 'position is' : 'positions are'} held for ` +
            `${n === 1 ? 'a session' : 'sessions'} not currently listed` +
            '</div>'
        );
    }

    window.SessionSidebarFooter = { html, missingNoteHtml };
    console.log('[SessionSidebarFooter Module] Exported as window.SessionSidebarFooter');
})();
