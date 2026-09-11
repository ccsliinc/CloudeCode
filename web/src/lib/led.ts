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
 * WHY TWO RINGS. The inner dot is WHAT the chat is doing; the outer halo
 * is activity and attention. One dot cannot answer both - `finished_unread`
 * had to exist as a whole extra state just to say "done, and also unread",
 * and there was no way at all to say "working, and also unread". Two rings
 * say both at once and need no combined state.
 *
 * THE RING CARRIES UNREAD, and the owner settled that on 2026-09-09. Two
 * lines of this project fixed the same reported defect - a ring pulsing on
 * sessions with nothing running - in opposite ways. One retired the outer
 * `unread` state and moved unread onto the inner dot; the other kept the
 * ring, stopped it breathing, and made it a crisp still green. THE OWNER
 * PICKED THE SECOND, and `release/1.2` is where it landed - which is why
 * this port was rewritten when 1.3 rebased onto it. So `unread` is an
 * OUTER state, a finished turn nobody has read paints a green ring, and
 * motion is reserved for `active`: a light that moves is a session that is
 * moving. Do not reintroduce the inner-dot-unread model; it was decided
 * against, not forgotten.
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
    'notice',
    'idle',
    'done',
    'dead',
    'disconnected',
    'unknown',
] as const);

/**
 * Outer-halo vocabulary: activity and attention.
 *
 * `active` means the session is MOVING and it breathes. `unread` means a
 * turn FINISHED here and nobody has looked, and it is a crisp still green
 * ring rather than a breathing glow - an outline that pulses stops reading
 * as an outline at nine pixels. `steady` is lit and still, `off` is at
 * rest, `dim` is not measured.
 */
export const OUTER_STATES = Object.freeze([
    'active',
    'steady',
    'unread',
    'off',
    'dim',
] as const);

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
    'waiting-permission': 'stopped - waiting on your permission',
    'waiting-input': 'stopped - waiting on you',
    notice: 'still working - wants your attention',
    idle: 'idle - already read',
    done: 'done',
    // TWO RED STATES, TWO DIFFERENT FACTS, and the colour cannot say
    // which. `dead` is a pane whose process exited - the session is still
    // there and can be restarted. `disconnected` is OUR socket being down:
    // the session may well be fine, we simply have no live word from it.
    // The words are the only thing separating them, so they must not be
    // paraphrases of each other.
    dead: 'dead - the process exited',
    disconnected: 'disconnected - no live connection to this session',
    unknown: 'status not measured',
});

/**
 * Human-readable suffix per outer state, appended to the inner label only
 * when it adds something the inner label does not already say - "done,
 * unread" is worth two words, "working" plus `active` is not.
 */
const OUTER_LABELS: Readonly<Record<OuterState, string>> = Object.freeze({
    active: '',
    steady: '',
    unread: 'unread',
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
 * Example: ledLabel('done', 'unread') -> 'done, unread'
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

/**
 * The signals the LED reads. Three arrive on a `/sessions/list` row;
 * `transport` does not, and cannot - it is whether THIS browser holds a
 * live socket to the session, which only the client knows. See
 * client/js/session-transport.js.
 */
export interface LedSignals {
    activity_status?: string | null | undefined;
    unread?: boolean | null | undefined;
    startup_gate?: string | null | undefined;
    transport?: string | null | undefined;
}

/**
 * Map this app's server-side signals onto the two LED dimensions.
 *
 * Description: THE ONE PLACE the unified `activity_status` vocabulary
 *   (src/core/session_status.py) is translated into (inner, outer).
 *   Order matters and encodes the priority: a dead transport outranks
 *   everything (nothing we are showing is fresh), then a dead pane (a
 *   corpse is not "busy"), then anything blocking on the user, then
 *   activity, then attention, then rest. `unread` is applied to the HALO
 *   independently of all of it, which is the whole reason there are two
 *   rings - see the module header.
 * Inputs: signals - `{activity_status, unread, startup_gate, transport}`.
 *   All optional; a missing one degrades to not-measured rather than to a
 *   confident answer.
 * Output: LedState - both members of the vocabularies.
 * Example: ledStateFor({activity_status: 'idle'}) -> {inner:'idle', outer:'steady'}
 * Example: ledStateFor({activity_status: 'idle', unread: true})
 *   -> {inner:'done', outer:'unread'}
 */
export function ledStateFor(signals?: LedSignals | null): LedState {
    const s: LedSignals = signals || {};
    const status = s.activity_status;
    const unread = !!s.unread;
    const gate = s.startup_gate;

    // THE TRANSPORT IS READ FIRST, and only the word `disconnected`
    // counts. Every other value - `connected`, `unknown`, absent - falls
    // through, because this browser holds a socket to at most ONE session
    // and knowing nothing about the rest is the normal case, not a fault.
    // A light we cannot refresh must not keep asserting the last status it
    // happened to see.
    if (s.transport === 'disconnected') {
        return { inner: 'disconnected', outer: 'off' };
    }

    // A dead pane is dead whatever else is true of it, and an unread flag
    // must not paint a corpse as something to go and read.
    if (status === 'dead' || status === 'stopped') {
        return { inner: 'dead', outer: 'off' };
    }

    // Blocked on a keypress at startup. Measured by the startup gate,
    // which is a separate probe from the hook stream.
    if (gate === 'awaiting_startup_prompt') {
        return { inner: 'waiting-input', outer: 'active' };
    }

    // THE AGENT IS STOPPED. `question` is a PermissionRequest and nothing
    // else since the 2026-09-08 split - it gets the louder inner hue,
    // because a yes/no nobody has answered is the one state on this screen
    // that will not resolve itself.
    if (status === 'question') {
        return { inner: 'waiting-permission', outer: 'active' };
    }

    // Claude asked to be looked at and is NOT blocked. Its own inner state
    // and its own hue since the five-colour pass: the owner's rule is "if
    // the session is fully stopped waiting for a response, then yellow. if
    // it's still working but needs something from me, make it light blue".
    // This is the only state on the second side of that sentence, so it
    // cannot share a name with the two yellow ones above.
    if (status === 'notice') {
        return { inner: 'notice', outer: 'active' };
    }

    // `running` is the pre-hook-era spelling and still arrives from a
    // stale cached response.
    //
    // A WORKING SESSION IS SOLID GREEN, unread flag or not. Taking the
    // unread halo here would paint the finished-turn ring around a running
    // session and say two contradictory things at once. Unread on a
    // session that is moving resolves itself the moment it stops.
    if (status === 'working' || status === 'working_subagent' || status === 'running') {
        return { inner: 'working', outer: 'active' };
    }

    // THE FINISHED TURN NOBODY HAS LOOKED AT: a green ring around the same
    // faint grey centre `unknown` shows. The inner state is still `done` -
    // the CHAT is at rest, and the RING is what says there is something
    // here for the user. Only the ring's colour changes; see
    // client/css/status-led.css.
    if (status === 'finished_unread') {
        return { inner: 'done', outer: 'unread' };
    }

    // READ AND AT REST. The dot goes to the neutral grey `idle` and the
    // ring stays lit-and-still in that same grey, so a session the user has
    // looked at is visibly calmer than one they have not, without the LED
    // changing size. The `unread` branch is defensive rather than reachable
    // from a well-formed row (the server derives this pair from the flag on
    // every path - src/core/session_status.derive_read_state), but if the
    // two ever arrive contradictory the flag must not be swallowed: it
    // renders identically to `finished_unread` above so the group roll-up
    // in session-status-summary.js cannot disagree with the row under it.
    if (status === 'idle') {
        return unread
            ? { inner: 'done', outer: 'unread' }
            : { inner: 'idle', outer: 'steady' };
    }

    // Everything else. NOT `done`: not having measured is not the same as
    // having measured rest, and collapsing the two is the false green this
    // project keeps paying for. It takes no unread ring either - a green
    // ring is a claim that a turn FINISHED here, and nothing was measured.
    return { inner: 'unknown', outer: 'dim' };
}
