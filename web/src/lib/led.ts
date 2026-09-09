/**
 * Status LED - the two-ring session indicator, ported to TypeScript.
 *
 * This is a LINE-FOR-LINE port of client/js/status-led.js. It exists so
 * the Svelte tree can render the LED without loading the legacy global,
 * and its contract is byte-identical output: src/lib/StatusLed.test.ts
 * loads the legacy file in a `vm` sandbox and compares the two strings
 * over the whole input matrix. If you change a rule here, change it there
 * in the same edit or that test fails, which is the point of it.
 *
 * WHY TWO RINGS. The inner dot is the chat's own status INCLUDING whether
 * it has been read; the outer ring is ACTIVITY ALONE. They are two
 * independent questions - an agent stopped on a permission prompt is a
 * live turn making no progress - so they get two vocabularies and neither
 * vocabulary contains a value that means something about the other one.
 *
 * THE RING MEANS ACTIVITY AND NOTHING ELSE (2026-09-09). The outer
 * `unread` state was retired: a finished, read-nothing conversation was
 * painting the loudest ring on the screen. Unread lives on the inner dot
 * now, green `done` against grey `idle`.
 *
 * PURE BY CONTRACT. Nothing in this file touches the DOM, reads a global
 * or fetches. Colour and motion live entirely in client/css/status-led.css,
 * keyed off the two data attributes; there are no colour values here.
 */

/** Inner-dot vocabulary: what the chat itself is doing. */
// FROZEN, not copied. The legacy module hands each caller a `.slice()`
// so a caller cannot corrupt the shared vocabulary. An ES module has one
// instance and no natural place to slice, so the same property is bought
// the stronger way: module code is strict, and a write to a frozen array
// throws instead of silently succeeding.
export const INNER_STATES = Object.freeze([
    'working',
    'waiting-permission',
    'waiting-input',
    'idle',
    'done',
    'dead',
    'unknown',
] as const);

/** Outer-ring vocabulary: ACTIVITY, and nothing else. */
export const OUTER_STATES = Object.freeze(['active', 'steady', 'off', 'dim'] as const);

/** One member of the inner-dot vocabulary. */
export type InnerState = (typeof INNER_STATES)[number];

/** One member of the outer-ring vocabulary. */
export type OuterState = (typeof OUTER_STATES)[number];

/** Fallback inner state for any unrecognised input. */
const INNER_FALLBACK: InnerState = 'unknown';

/** Fallback outer state for any unrecognised input. */
const OUTER_FALLBACK: OuterState = 'dim';

/**
 * Human-readable label per inner state. The LED never conveys meaning by
 * colour alone - this text becomes the title and aria-label.
 */
export const INNER_LABELS: Readonly<Record<InnerState, string>> = Object.freeze({
    working: 'working',
    'waiting-permission': 'waiting on you - permission',
    'waiting-input': 'waiting on you',
    idle: 'idle - already read',
    done: 'done - unread',
    dead: 'dead - process exited',
    unknown: 'status not measured',
});

/**
 * Human-readable suffix per outer state, appended to the inner label only
 * when it adds something the inner label does not already say. Every value
 * is empty today because the ring carries activity alone, which the inner
 * state already implies; the hook is kept because a future outer state
 * might need it.
 */
const OUTER_LABELS: Readonly<Record<OuterState, string>> = Object.freeze({
    active: '',
    steady: '',
    off: '',
    dim: '',
});

/**
 * Escape a value for interpolation into a double-quoted HTML attribute.
 *
 * Description: `&` is replaced first or later replacements would be
 *   re-escaped. Deliberately string-based, not the textContent/innerHTML
 *   trick used elsewhere in the client: that idiom does not escape quote
 *   characters and so is wrong for an attribute value. This module may
 *   also not touch the DOM.
 * Inputs: value - anything; stringified first, null/undefined become ''.
 * Output: string safe between the quotes of an attribute.
 * Example: escapeAttr('a"b') -> 'a&quot;b'
 */
export function escapeAttr(value: unknown): string {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Clamp any value onto a known inner state.
 *
 * Inputs: inner - any value.
 * Output: InnerState - a member of INNER_STATES.
 * Example: normalizeInner('nope') -> 'unknown'
 */
export function normalizeInner(inner: unknown): InnerState {
    return (INNER_STATES as readonly string[]).indexOf(inner as string) >= 0
        ? (inner as InnerState)
        : INNER_FALLBACK;
}

/**
 * Clamp any value onto a known outer state.
 *
 * Inputs: outer - any value.
 * Output: OuterState - a member of OUTER_STATES.
 * Example: normalizeOuter(undefined) -> 'dim'
 */
export function normalizeOuter(outer: unknown): OuterState {
    return (OUTER_STATES as readonly string[]).indexOf(outer as string) >= 0
        ? (outer as OuterState)
        : OUTER_FALLBACK;
}

/**
 * The accessible label for one (inner, outer) pair.
 *
 * Inputs: inner, outer - already normalized.
 * Output: string.
 * Example: ledLabel('done', 'off') -> 'done - unread'
 */
export function ledLabel(inner: InnerState, outer: OuterState): string {
    const head = INNER_LABELS[inner];
    const tail = OUTER_LABELS[outer];
    return tail ? head + ', ' + tail : head;
}

/** Options accepted by ledHtml. Every field is optional and clamped. */
export interface LedHtmlOptions {
    /** Inner-dot state; anything unrecognised clamps to `unknown`. */
    inner?: unknown;
    /** Outer-ring state; anything unrecognised clamps to `dim`. */
    outer?: unknown;
    /** CSS length for the whole LED, e.g. '9px'. Anything else is dropped. */
    size?: unknown;
    /** Overrides the derived accessible label. */
    title?: unknown;
    /** Extra class names, restricted to a plain class-name shape. */
    extraClass?: unknown;
}

/** The two dimensions resolved for one session. */
export interface LedState {
    inner: InnerState;
    outer: OuterState;
}

/**
 * Build the markup for one status LED.
 *
 * Description: PURE - no DOM, no globals, no side effects. Returns a
 *   single `<span>` carrying `data-inner` and `data-outer`; every colour
 *   and every animation is selected off those two attributes by
 *   client/css/status-led.css. Both rings are painted on that one span -
 *   fill for the inner state, box-shadow for the outer - so the LED
 *   occupies one inline box and stays concentric by construction rather
 *   than by two boxes agreeing. Unrecognised inputs are clamped rather
 *   than rejected, so a stale cached API response can never render an
 *   unstyled or unlabelled LED.
 * Inputs: opts - see LedHtmlOptions; null and undefined are accepted.
 * Output: string - HTML for one inline `<span>`.
 * Example:
 *   ledHtml({inner: 'working', outer: 'active'})
 *   // '<span class="status-led" data-inner="working" data-outer="active"
 *   //    role="img" title="working" aria-label="working"></span>'
 */
export function ledHtml(opts?: LedHtmlOptions | null): string {
    const o: LedHtmlOptions = opts || {};
    const inner = normalizeInner(o.inner);
    const outer = normalizeOuter(o.outer);
    const label = o.title == null ? ledLabel(inner, outer) : String(o.title);
    // Only a plain CSS length is accepted. Anything else is dropped rather
    // than sanitised: this value lands in a style attribute, and an
    // allowlist is the only version of that which is safe to reason about.
    const size =
        typeof o.size === 'string' && /^[0-9]+(\.[0-9]+)?(px|rem|em)$/.test(o.size)
            ? o.size
            : '';
    const styleAttr = size ? ` style="--led-size: ${escapeAttr(size)}"` : '';
    // Extra classes for a caller that needs this element findable by an
    // existing selector (the legacy status-dot vocabulary is kept on it).
    // Restricted to a plain class-name shape so the attribute cannot be
    // broken out of.
    const extra =
        typeof o.extraClass === 'string' && /^[A-Za-z0-9 _-]+$/.test(o.extraClass)
            ? o.extraClass.trim() + ' '
            : '';
    return (
        `<span class="${escapeAttr(extra)}status-led" data-inner="${escapeAttr(inner)}" ` +
        `data-outer="${escapeAttr(outer)}" role="img" ` +
        `title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"` +
        `${styleAttr}></span>`
    );
}

/** The three fields a `/sessions/list` row carries that the LED reads. */
export interface LedSignals {
    activity_status?: string | null | undefined;
    unread?: boolean | null | undefined;
    startup_gate?: string | null | undefined;
}

/**
 * Map this app's server-side signals onto the two LED dimensions.
 *
 * Description: THE ONE PLACE the unified `activity_status` vocabulary
 *   (src/core/session_status.py) is translated into (inner, outer).
 *   Order matters and encodes the priority: dead outranks everything,
 *   then anything blocking on the user, then activity, then rest. The
 *   ring is derived from ONE question - is something running right now.
 * Inputs: signals - `{activity_status, unread, startup_gate}` exactly as
 *   they arrive on a `/sessions/list` row. All three optional; a missing
 *   one degrades to not-measured rather than to a confident answer.
 * Output: LedState - both members of the vocabularies.
 * Example: ledStateFor({activity_status: 'idle'}) -> {inner:'idle', outer:'off'}
 */
export function ledStateFor(signals?: LedSignals | null): LedState {
    const s: LedSignals = signals || {};
    const status = s.activity_status;
    const unread = !!s.unread;
    const gate = s.startup_gate;

    // A dead pane is dead whatever else is true of it, and an unread flag
    // must not paint a corpse as something to go and read.
    if (status === 'dead' || status === 'stopped') {
        return { inner: 'dead', outer: 'off' };
    }

    // Blocked on a keypress at startup. Measured by the startup gate,
    // which is a separate probe from the hook stream.
    if (gate === 'awaiting_startup_prompt') {
        return { inner: 'waiting-input', outer: 'steady' };
    }

    // THE AGENT IS STOPPED. `question` is a PermissionRequest and nothing
    // else since the 2026-09-08 split. The ring is STEADY, not breathing:
    // the agent is stopped, and a pulsing ring means something is running.
    if (status === 'question') {
        return { inner: 'waiting-permission', outer: 'steady' };
    }

    // Claude asked to be looked at and is NOT blocked. Same ring as a
    // permission prompt - both are live turns that are not moving.
    if (status === 'notice') {
        return { inner: 'waiting-input', outer: 'steady' };
    }

    // `running` is the pre-hook-era spelling and still arrives from a
    // stale cached response.
    if (status === 'working' || status === 'working_subagent' || status === 'running') {
        // THE ONLY BREATHING RING IN THE APP. Unread is deliberately not
        // consulted: a working session is working.
        return { inner: 'working', outer: 'active' };
    }

    // FINISHED AND UNREAD - the green dot, and NO ring.
    if (status === 'finished_unread') {
        return { inner: 'done', outer: 'off' };
    }

    // READ AND AT REST. The `unread` branch is defensive rather than
    // reachable from a well-formed row (the server derives this pair from
    // the flag on every path), but if the two ever arrive contradictory
    // the flag must not be swallowed.
    if (status === 'idle') {
        return unread ? { inner: 'done', outer: 'off' } : { inner: 'idle', outer: 'off' };
    }

    // Everything else. NOT `done`: not having measured is not the same as
    // having measured rest, and collapsing the two is the false green this
    // project keeps paying for.
    return { inner: 'unknown', outer: 'dim' };
}
