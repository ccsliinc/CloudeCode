/**
 * Session Status UI - shared status-dot rendering for the launchpad's
 * "Running Sessions" list and the in-terminal session sidebar.
 *
 * Single source of truth so the two call sites never drift on colors,
 * labels, or the accessibility wiring (title + aria-label, never
 * color-only - a user who can't distinguish the dot colors still needs
 * to know what state a session is in).
 *
 * States mirror the backend's src/core/session_status.py exactly:
 *   running - the pane's foreground process is something other than a
 *             bare shell (in practice, the agent CLI).
 *   idle    - pane alive, foreground is a bare shell. Agent not running.
 *   dead    - the pane's process exited; tmux is only holding the
 *             corpse open. Rendered with the loudest treatment on
 *             purpose - this is the state the user most needs to see
 *             (see CLAUDE.md hazard: a dead pane that "looked" fine).
 *   unknown - status could not be determined (non-tmux backend, or the
 *             tmux query failed). Never guessed.
 *
 * Must load AFTER no other module (no dependencies) and BEFORE
 * launchpad.js / session-sidebar.js, both of which call into it.
 */

console.log('[SessionStatusUI Module] Loading...');

(function () {
    /**
     * Human-readable label per status. Used for both the visible badge
     * text (uppercased by CSS) and the title/aria-label pair on the dot,
     * so the meaning is never conveyed by color alone.
     *
     * @type {Object<string, string>}
     */
    const STATUS_LABELS = {
        running: 'running - agent active',
        idle: 'idle - waiting at the shell',
        dead: 'dead - process exited',
        unknown: 'status unknown',
    };

    /**
     * Normalize any input into one of the four known status keys.
     *
     * Description: Defensive normalizer so a missing/unexpected value from
     *   the API (older cached response, non-tmux backend) never produces
     *   an unstyled dot or an empty aria-label.
     * Inputs:
     *   status (string|null|undefined) - raw value from the API payload.
     * Output:
     *   string - one of 'running' | 'idle' | 'dead' | 'unknown'.
     * Example:
     *   normalizeStatus('running') -> 'running'
     *   normalizeStatus(undefined) -> 'unknown'
     */
    function normalizeStatus(status) {
        return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
            ? status
            : 'unknown';
    }

    /**
     * Build the status-dot markup for a session row.
     *
     * Description: Returns a `<span>` styled by a `status-dot--<state>`
     *   CSS class (see client/css/session-sidebar.css), carrying both
     *   `title` (desktop hover tooltip) and `aria-label` (screen readers)
     *   set to the same human-readable label - the accessibility
     *   requirement this feature exists for. `role="img"` marks it as a
     *   meaningful glyph rather than decoration (unlike the old
     *   `aria-hidden="true"` dot it replaces).
     * Inputs:
     *   status (string|null|undefined) - raw activity_status/status value.
     * Output:
     *   string - HTML for a single inline `<span>` element.
     * Example:
     *   dotHtml('dead') ->
     *     '<span class="status-dot status-dot--dead" role="img"
     *        title="dead - process exited"
     *        aria-label="dead - process exited"></span>'
     */
    function dotHtml(status) {
        const key = normalizeStatus(status);
        const label = STATUS_LABELS[key];
        return (
            `<span class="status-dot status-dot--${key}" role="img" ` +
            `title="${label}" aria-label="${label}"></span>`
        );
    }

    /**
     * Look up the human-readable label alone (no markup) - used where a
     * caller wants plain text, e.g. a badge or a screen-reader-only note.
     *
     * Inputs:
     *   status (string|null|undefined) - raw activity_status/status value.
     * Output:
     *   string - human-readable label.
     * Example:
     *   labelFor('idle') -> 'idle - waiting at the shell'
     */
    function labelFor(status) {
        return STATUS_LABELS[normalizeStatus(status)];
    }

    window.SessionStatusUI = {
        normalizeStatus,
        dotHtml,
        labelFor,
    };
    console.log('[SessionStatusUI Module] Exported as window.SessionStatusUI');
})();
