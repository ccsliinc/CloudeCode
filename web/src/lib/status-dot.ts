/**
 * The session-status vocabulary, and the one function that turns a
 * `/sessions/list` row into an LED.
 *
 * This is a port of the status half of client/js/session-status-ui.js -
 * the labels, the provenance suffixes, the CSS modifier classes and
 * `dotHtml`. The icon glyphs and the mark-unread control stay in the
 * legacy file; they are not status and this module is not a junk drawer.
 *
 * BYTE-IDENTICAL BY CONTRACT. `ledHtmlForStatus` here and
 * `SessionStatusUI.dotHtml` there must return the same string for the
 * same input. src/lib/StatusLed.test.ts loads both legacy files in a `vm`
 * sandbox and compares them across the whole matrix of status, unread,
 * startup gate and status source, so a divergence fails the suite rather
 * than reaching a screen.
 *
 * THE LEGACY FALLBACK BRANCH IS NOT PORTED, on purpose. `dotHtml` still
 * carries a plain `.status-dot` fallback for the case where
 * status-led.js failed to load. Here the LED is an import, so it cannot
 * be absent, and a branch that can never run is a branch nobody can test.
 */
import { ledHtml, ledStateFor } from './led';

/**
 * Human-readable label per status, used for the badge text and for the
 * title/aria-label pair, so the meaning is never conveyed by colour alone.
 */
export const STATUS_LABELS: Record<string, string> = {
    dead: 'dead - process exited',
    question: 'waiting for permission',
    notice: 'wants your attention',
    working_subagent: 'working - a subagent is active',
    working: 'working',
    finished_unread: 'done - unread',
    // MEASURED 2026-09-09: 15 of 19 live panes were running claude, not a
    // shell, so "waiting at the shell" was wrong about four fifths of the
    // sessions it described. `idle` means the light has nothing to report.
    idle: 'idle - read, nothing running',
    // NOT a synonym for `dead`: `dead` is a tmux session that still EXISTS
    // holding an exited process. `stopped` is a tmux instance that is GONE.
    stopped: 'ended - the session is no longer running',
    // NOT MEASURED, not "nothing is happening".
    unknown: 'not measured',
    // Back-compat: a stale cached response may still send the old
    // tmux-only 'running' string.
    running: 'working',
};

/**
 * How each `status_source` reads in the tooltip.
 *
 * PROVENANCE, NEVER STATE. It is appended to the label and NOTHING else:
 * no class, no colour, no shape. 'none' is absent on purpose - when
 * nothing measured the status there is nothing to credit.
 */
export const SOURCE_SUFFIX: Record<string, string> = {
    hook: 'via hooks',
    transcript: 'via transcript',
    seed_row: 'via the session record',
    tmux: 'via tmux',
};

/**
 * CSS modifier class per status - separate from STATUS_LABELS so the
 * 'running' back-compat alias can share the 'working' style without
 * duplicating a colour rule.
 */
export const STATUS_DOT_CLASS: Record<string, string> = {
    dead: 'dead',
    question: 'question',
    notice: 'notice',
    working_subagent: 'working-subagent',
    working: 'working',
    finished_unread: 'finished-unread',
    idle: 'idle',
    stopped: 'stopped',
    unknown: 'unknown',
    running: 'working',
};

/**
 * Normalize any input into one of the known status keys.
 *
 * Inputs: status - raw value from the API payload.
 * Output: string - one of the STATUS_LABELS keys.
 * Example: normalizeStatus(undefined) -> 'unknown'
 */
export function normalizeStatus(status: unknown): string {
    return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status as string)
        ? (status as string)
        : 'unknown';
}

/**
 * Label for a status, with its provenance appended when known.
 *
 * Inputs: status - raw activity_status; statusSource - raw status_source.
 * Output: string, e.g. 'working (via hooks)'.
 * Example: labelWithSource('idle', 'transcript')
 *   -> 'idle - read, nothing running (via transcript)'
 */
export function labelWithSource(status: unknown, statusSource: unknown): string {
    const label = STATUS_LABELS[normalizeStatus(status)] as string;
    const suffix = Object.prototype.hasOwnProperty.call(
        SOURCE_SUFFIX,
        statusSource as string,
    )
        ? (SOURCE_SUFFIX[statusSource as string] as string)
        : '';
    return suffix ? `${label} (${suffix})` : label;
}

/** The wrapper-level fields the LED needs beyond the bare status string. */
export interface StatusSignals {
    /** Selects the green `done` dot over the grey `idle` one at rest. */
    unread?: boolean | null | undefined;
    /** `awaiting_startup_prompt` means the pane needs a keypress. */
    startup_gate?: string | null | undefined;
    /** Where the status came from; renders in the tooltip only. */
    status_source?: string | null | undefined;
    /** Optional CSS length override for the whole LED. */
    size?: string | null | undefined;
}

/**
 * Build the status LED for one session row.
 *
 * Description: The one seam every surface renders its light through. The
 *   legacy `status-dot status-dot--<state>` classes are KEPT on the LED
 *   rather than replaced: several call sites and harnesses find this
 *   element by `.status-dot`, and the class still carries the nine-state
 *   vocabulary, which is a genuinely different thing from the LED's two
 *   dimensions. The legacy element-level paint is neutralised in
 *   client/css/status-led.css by a `.status-dot.status-led` block; that
 *   block and this line are a pair.
 * Inputs:
 *   status - raw `activity_status` from a `/sessions/list` row.
 *   signals - the wrapper-level fields; optional, and a caller that
 *     passes nothing gets a correct LED for the status alone.
 * Output: string - HTML for one inline `<span>`.
 * Example:
 *   ledHtmlForStatus('working', {unread: false})
 *   // '<span class="status-dot status-dot--working status-led" ...></span>'
 */
export function ledHtmlForStatus(
    status?: unknown,
    signals?: StatusSignals | null,
): string {
    const key = normalizeStatus(status);
    const s: StatusSignals = signals || {};
    const label = labelWithSource(key, s.status_source);
    const cssClass = STATUS_DOT_CLASS[key] as string;
    const led = ledStateFor({
        activity_status: key,
        unread: s.unread,
        startup_gate: s.startup_gate,
    });
    return ledHtml({
        inner: led.inner,
        outer: led.outer,
        size: s.size,
        title: label,
        extraClass: `status-dot status-dot--${cssClass}`,
    });
}

/**
 * Look up the human-readable label alone, with no markup.
 *
 * Inputs: status - raw activity_status value.
 * Output: string.
 * Example: labelFor('idle') -> 'idle - read, nothing running'
 */
export function labelFor(status: unknown): string {
    return STATUS_LABELS[normalizeStatus(status)] as string;
}
