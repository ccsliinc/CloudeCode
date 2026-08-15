/**
 * Session sidebar ROW MARKUP - the HTML for one conversation row, and
 * the repaint signature that decides whether a repaint is needed at all.
 *
 * Split out of client/js/session-sidebar.js for the project's 500-line
 * rule, and along the same seam the repo already uses for row internals:
 * client/js/session-row-actions.js owns the destructive control and
 * client/js/session-status-ui.js owns the status dot and the mark-unread
 * toggle. This module is the row that composes them, nothing else - it
 * holds no state and touches no DOM, it only returns strings.
 *
 * Must load AFTER session-status-ui.js and session-row-actions.js, and
 * BEFORE session-sidebar.js runs (not necessarily before it parses).
 */

console.log('[SessionSidebarRows Module] Loading...');

(function () {
    /**
     * HTML-escape a value for safe interpolation into innerHTML.
     * Inputs: value (any). Output: string.
     */
    function esc(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    /**
     * Stable fingerprint of everything the rendered rows actually show.
     * The sidebar compares this against the previous paint and skips the
     * DOM rewrite when it matches, so the 5s poll tick cannot thrash
     * focus or scroll position while the panel sits open and idle.
     * Inputs: rows (Array<object>) - merged + sorted session rows.
     * Output: string.
     */
    function signature(rows) {
        return JSON.stringify(rows.map((r) => ({
            name: r.name,
            status: r.status || 'unknown',
            active: !!r.is_active,
            thisTab: !!r.is_this_tab,
            unread: !!r.unread,
        })));
    }

    /**
     * Build the full list markup for the sidebar body.
     * Inputs: rows (Array<object>) - merged + sorted session rows.
     * Output: string - HTML, including the empty-state when there are
     *   no rows.
     */
    function listHtml(rows) {
        if (!rows || rows.length === 0) {
            return '<div class="session-sidebar-empty">no other conversations</div>';
        }
        return rows.map((r) => rowHtml(r)).join('');
    }

    /**
     * Build one row: status dot, name, tmux/external badge, mark-unread
     * toggle, and the single destructive control. The dot, the toggle and
     * that control all come from the shared modules, so this row and the
     * launcher's running-session row are literally the same controls with
     * the same tooltips and the same confirm copy.
     * Inputs: r (object) - one merged session row.
     * Output: string - HTML.
     */
    function rowHtml(r) {
        const dot = window.SessionStatusUI ? window.SessionStatusUI.dotHtml(r.status) : '';
        const name = esc(r.name);
        const badge = r.created_by_cloude ? 'tmux' : 'external';
        const sidAttr = r.session_id ? ` data-session-id="${esc(r.session_id)}"` : '';
        const markUnread = window.SessionStatusUI
            ? window.SessionStatusUI.markUnreadHtml(r.name, !!r.unread)
            : '';
        const rowAction = window.SessionRowActions
            ? window.SessionRowActions.html(r.status, r.name, 'session-sidebar-row-delete')
            : '';
        return (
            `<div class="session-sidebar-row" data-name="${name}" ` +
            `data-active="${r.is_this_tab ? '1' : '0'}"${sidAttr}>` +
            `${dot}` +
            `<span class="session-sidebar-row-name">${name}</span>` +
            `<span class="session-sidebar-row-badge">${badge}</span>` +
            `${markUnread}${rowAction}` +
            '</div>'
        );
    }

    window.SessionSidebarRows = { listHtml, rowHtml, signature, esc };
    console.log('[SessionSidebarRows Module] Exported as window.SessionSidebarRows');
})();
