/**
 * Status LED - the two-ring session indicator.
 *
 * WHY TWO RINGS AND NOT ONE DOT. The old `.status-dot` collapsed two
 * genuinely independent questions into one colour: WHAT is the chat doing
 * (is it working, is it blocked on me, is it dead) and WHETHER it wants my
 * attention (is there something unread here). One dot cannot answer both -
 * `finished_unread` had to exist as a whole extra state just to say "done,
 * and also unread", and there was no way at all to say "working, and also
 * unread". Two rings say both at once and need no combined state.
 *
 * So this module models the LED as TWO INDEPENDENT DIMENSIONS:
 *
 *   inner dot  - the chat's own status. One of INNER_STATES.
 *   outer halo - activity and attention. One of OUTER_STATES.
 *
 * THE RING CARRIES UNREAD, and the owner settled that on 2026-09-09.
 * Two lines of this project fixed the same reported defect - a ring
 * pulsing on sessions with nothing running - in opposite ways. One
 * retired the outer `unread` state and moved unread onto the inner dot;
 * this one kept the ring, stopped it breathing, and made it a crisp
 * still green. The owner picked THIS one. So `unread` is an outer state,
 * a finished turn nobody has read paints a green ring, and motion is
 * reserved for `active` - a light that MOVES is a session that is
 * moving, which is the whole of the original complaint. Do not
 * reintroduce the inner-dot-unread model; it was decided against, not
 * forgotten.
 *
 * BOTH RINGS ARE DRAWN ON ONE ELEMENT. The inner dot is the span's
 * fill and the outer ring and its glow are layers of ONE `box-shadow` on
 * that same span - there is no pseudo-element and there may not be one.
 * A box gets pixel-snapped independently of its parent's box, so a halo
 * drawn as its own box came apart from the dot by a device pixel
 * whenever the dot landed on a fractional x/y (routine in a flex row).
 * A box-shadow is painted from the element's own border box, so
 * concentric is the only geometry it can have. See the header of
 * client/css/status-led.css.
 *
 * They are set separately (`data-inner` / `data-outer`) and every
 * combination renders. That is deliberate: it is what lets a gallery
 * enumerate the whole matrix, and it is why neither vocabulary contains a
 * value that means something about the other one.
 *
 * PURE BY CONTRACT. `ledHtml()` touches no DOM, reads no globals, and
 * returns a string. It must stay that way - a standalone gallery page
 * embeds `client/css/status-led.css` and calls it directly, with none of
 * this app around it. No `document`, no `window`, no fetch.
 *
 * Colour and motion live entirely in `client/css/status-led.css`, keyed
 * off the two data attributes. There are no colour values in this file.
 *
 * Loads BEFORE client/js/session-status-ui.js, which maps this app's
 * `activity_status` onto these two dimensions and renders through here.
 */

console.log('[StatusLed Module] Loading...');

(function () {
    /**
     * Inner-dot vocabulary: what the chat itself is doing.
     *
     * `waiting-permission` and `waiting-input` are separate because they
     * ask different things of the user - one is "approve this tool call",
     * the other is "answer a question / press a key to get past a startup
     * prompt". BOTH ARE REACHABLE FROM LIVE DATA as of 2026-09-08: the
     * server split its single `question` state into `question` (a
     * PermissionRequest - the agent is stopped) and `notice` (a
     * Notification - it wants attention and is not stopped), and the
     * startup gate feeds `waiting-input` too. See docs/session-status.md.
     *
     * `notice` and `disconnected` were added on 2026-09-08 with the
     * FIVE-COLOUR pass. `notice` used to share `waiting-input`; it now has
     * its own name because it is the only state that is BOTH working and
     * asking for the user, and the owner asked for it to read light blue
     * rather than yellow ("if it's still working but needs something from
     * me, make it light blue"). `disconnected` is a TRANSPORT fact, not a
     * session fact: the browser's socket to this session is down, so no
     * status we are showing is fresh. It is red like `dead` and says
     * something different in words - see INNER_LABELS.
     *
     * `idle` was added on 2026-09-09 and is the READ half of rest.
     * Owner's report, verbatim: "i need the lights to go idle, (i think
     * thats gray) when i click on a tab. there needs to be a read/idle
     * color." Before it, opening a tab left the dot exactly as it was
     * and only the ring changed, which is too small a change to register
     * at a glance. `done` is the state a finished turn holds while the
     * green unread ring is around it; `idle` is what the dot becomes
     * once that ring goes. The ring still carries unread - see the
     * module header - and this pair is what makes its departure visible.
     *
     * @type {string[]}
     */
    const INNER_STATES = [
        'working',
        'waiting-permission',
        'waiting-input',
        'notice',
        'idle',
        'done',
        'dead',
        'disconnected',
        'unknown',
    ];

    /**
     * Outer-halo vocabulary: activity and attention.
     *
     * `active` means the session is MOVING and it breathes. `unread`
     * means a turn FINISHED here and nobody has looked: since the
     * five-colour pass it is a crisp, still green ring rather than a
     * breathing glow, because an outline that pulses stops reading as an
     * outline at nine pixels. Motion is therefore now a signal in its own
     * right - a light that moves is a session that is moving. Since
     * 2026-09-09 the ring's own DOT is cleared (the stylesheet does that
     * with the same `--led-fill` the `unknown` dot uses, so it reads as
     * one ring rather than as a ring around a second light), but the
     * CENTRE is not empty: it shows the same faint grey dot `unknown`
     * shows, via the halo bleeding through - only the ring recolours to
     * green. See client/css/status-led.css for the composition.
     *
     * @type {string[]}
     */
    const OUTER_STATES = ['active', 'steady', 'unread', 'off', 'dim'];

    /** @type {string} Fallback inner state for any unrecognised input. */
    const INNER_FALLBACK = 'unknown';

    /** @type {string} Fallback outer state for any unrecognised input. */
    const OUTER_FALLBACK = 'dim';

    /**
     * Human-readable label per inner state. The LED never conveys meaning
     * by colour alone - this text becomes the title and aria-label.
     * @type {Object<string, string>}
     */
    const INNER_LABELS = {
        working: 'working',
        'waiting-permission': 'stopped - waiting on your permission',
        'waiting-input': 'stopped - waiting on you',
        notice: 'still working - wants your attention',
        idle: 'idle - already read',
        done: 'done',
        // TWO RED STATES, TWO DIFFERENT FACTS, and the colour cannot say
        // which. `dead` is a pane whose process exited - the session is
        // still there, it can be restarted. `disconnected` is OUR socket
        // being down: the session may well be fine, we simply have no
        // live word from it. The words are the only thing separating
        // them, so they must not be paraphrases of each other.
        dead: 'dead - the process exited',
        disconnected: 'disconnected - no live connection to this session',
        unknown: 'status not measured',
    };

    /**
     * Human-readable suffix per outer state, appended to the inner label
     * only when it adds something the inner label does not already say.
     * @type {Object<string, string>}
     */
    const OUTER_LABELS = {
        active: '',
        steady: '',
        unread: 'unread',
        off: '',
        dim: '',
    };

    /**
     * Escape a value for interpolation into a double-quoted HTML attribute.
     *
     * Description: `&` is replaced first or later replacements would be
     *   re-escaped. Deliberately string-based, not the
     *   `textContent`/`innerHTML` trick used elsewhere in the client:
     *   that idiom does not escape quote characters and so is wrong for
     *   an attribute value. Also, this module may not touch the DOM.
     * Inputs:
     *   value (any) - stringified first; null/undefined become ''.
     * Output:
     *   string - safe between the quotes of an attribute.
     * Example:
     *   escapeAttr('a"b') -> 'a&quot;b'
     */
    function escapeAttr(value) {
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
     * Inputs: inner (string|null|undefined).
     * Output: string - a member of INNER_STATES.
     * Example: normalizeInner('nope') -> 'unknown'
     */
    function normalizeInner(inner) {
        return INNER_STATES.indexOf(inner) >= 0 ? inner : INNER_FALLBACK;
    }

    /**
     * Clamp any value onto a known outer state.
     *
     * Inputs: outer (string|null|undefined).
     * Output: string - a member of OUTER_STATES.
     * Example: normalizeOuter(undefined) -> 'dim'
     */
    function normalizeOuter(outer) {
        return OUTER_STATES.indexOf(outer) >= 0 ? outer : OUTER_FALLBACK;
    }

    /**
     * The accessible label for one (inner, outer) pair.
     *
     * Description: colour and motion never carry the meaning alone, so
     *   every LED ships this string as both `title` and `aria-label`. The
     *   outer half is appended only when it says something new - "done,
     *   unread" is worth two words, "working" plus `active` is not.
     * Inputs: inner (string), outer (string) - already normalized.
     * Output: string.
     * Example: ledLabel('done', 'unread') -> 'done, unread'
     */
    function ledLabel(inner, outer) {
        const head = INNER_LABELS[inner];
        const tail = OUTER_LABELS[outer];
        return tail ? head + ', ' + tail : head;
    }

    /**
     * Build the markup for one status LED.
     *
     * Description: PURE - no DOM, no globals, no side effects. Returns a
     *   single `<span>` carrying `data-inner` and `data-outer`; every
     *   colour and every animation is selected off those two attributes
     *   by client/css/status-led.css. Both rings are painted on that one
     *   span - fill for the inner state, box-shadow for the outer - so
     *   the LED occupies one inline box, drops into any row that used to
     *   hold a `.status-dot` with no layout change, and stays concentric
     *   by construction rather than by two boxes agreeing.
     *
     *   `role="img"` marks it a meaningful glyph rather than decoration.
     *   Unrecognised inputs are clamped rather than rejected, so a stale
     *   cached API response can never render an unstyled or unlabelled
     *   LED.
     * Inputs:
     *   opts (Object|null) - `{inner, outer, size, title}`. `inner` and
     *     `outer` are clamped onto the two vocabularies. `size` is an
     *     optional CSS length for the whole LED (default comes from the
     *     stylesheet); it is emitted as a custom property, never as a
     *     raw style rule, so the stylesheet keeps control of the ring
     *     and the glow around it. `title` overrides the derived
     *     label when a caller has a more specific sentence.
     * Output:
     *   string - HTML for one inline `<span>`.
     * Example:
     *   ledHtml({inner: 'working', outer: 'active'})
     *   // '<span class="status-led" data-inner="working"
     *   //    data-outer="active" role="img" title="working"
     *   //    aria-label="working"></span>'
     */
    function ledHtml(opts) {
        const o = opts || {};
        const inner = normalizeInner(o.inner);
        const outer = normalizeOuter(o.outer);
        const label = o.title == null ? ledLabel(inner, outer) : String(o.title);
        // Only a plain CSS length is accepted. Anything else is dropped
        // rather than sanitised: this value lands in a style attribute,
        // and an allowlist is the only version of that which is safe to
        // reason about.
        const size =
            typeof o.size === 'string' && /^[0-9]+(\.[0-9]+)?(px|rem|em)$/.test(o.size)
                ? o.size
                : '';
        const styleAttr = size ? ` style="--led-size: ${escapeAttr(size)}"` : '';
        // Extra classes for a caller that needs this element findable by
        // an existing selector (session-status-ui.js keeps the legacy
        // `status-dot` vocabulary on it). Restricted to a plain class-name
        // shape so the attribute cannot be broken out of.
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
     * Map this app's server-side signals onto the two LED dimensions.
     *
     * Description: THE ONE PLACE the unified `activity_status` vocabulary
     *   (src/core/session_status.py) is translated into (inner, outer).
     *   Every surface - sidebar row, launchpad card, terminal header,
     *   group header - renders through here, so a light cannot mean two
     *   things in two places.
     *
     *   Order matters and encodes the priority the user asked for:
     *   a dead transport outranks everything (nothing we are showing is
     *   fresh), then a dead pane (a corpse is not "busy"), then anything
     *   blocking on the user, then activity, then attention, then rest.
     *   `unread` is applied to the HALO independently of all of it, which
     *   is the whole reason there are two rings - see the module header.
     * Inputs:
     *   signals (Object|null) -
     *     `{activity_status, unread, startup_gate, transport}` as they
     *     arrive on a `/sessions/list` row, plus `transport` from
     *     client/js/session-transport.js for the one session this browser
     *     actually holds a socket to. All are optional; missing ones
     *     degrade to not-measured rather than to a confident answer.
     * Output:
     *   Object - `{inner, outer}`, both members of the vocabularies.
     * Example:
     *   ledStateFor({activity_status: 'idle', unread: true})
     *   // {inner: 'done', outer: 'unread'}
     * Example:
     *   ledStateFor({activity_status: 'idle'})
     *   // {inner: 'idle', outer: 'steady'}
     */
    function ledStateFor(signals) {
        const s = signals || {};
        const status = s.activity_status;
        const unread = !!s.unread;
        const gate = s.startup_gate;

        // THE TRANSPORT IS READ FIRST, and only the word `disconnected`
        // counts. Every other value - `connected`, `unknown`, absent -
        // falls through, because this browser holds a socket to at most
        // ONE session and knowing nothing about the rest is the normal
        // case, not a fault. A light we cannot refresh must not keep
        // asserting the last status it happened to see.
        if (s.transport === 'disconnected') {
            return { inner: 'disconnected', outer: 'off' };
        }

        // A dead pane is dead whatever else is true of it, and an unread
        // flag must not paint a corpse as something to go and read.
        if (status === 'dead' || status === 'stopped') {
            return { inner: 'dead', outer: 'off' };
        }

        // Blocked on a keypress at startup. Measured by the startup gate,
        // which is a separate probe from the hook stream, so it is
        // checked on its own rather than folded into `activity_status`.
        if (gate === 'awaiting_startup_prompt') {
            return { inner: 'waiting-input', outer: 'active' };
        }

        // THE AGENT IS STOPPED. `question` is a PermissionRequest and
        // nothing else since the 2026-09-08 split - it gets the louder
        // inner hue, because a yes/no nobody has answered is the one
        // state on this screen that will not resolve itself.
        if (status === 'question') {
            return { inner: 'waiting-permission', outer: 'active' };
        }

        // Claude asked to be looked at and is NOT blocked. Its own inner
        // state and its own hue since the five-colour pass: the owner's
        // rule is "if the session is fully stopped waiting for a
        // response, then yellow. if it's still working but needs
        // something from me, make it light blue". This is the only state
        // on the second side of that sentence, so it cannot share a name
        // with the two yellow ones above.
        if (status === 'notice') {
            return { inner: 'notice', outer: 'active' };
        }

        // `running` is the pre-hook-era spelling and still arrives from a
        // stale cached response; mapping it here rather than letting it
        // fall through keeps a half-upgraded deployment meaningful.
        //
        // A WORKING SESSION IS SOLID GREEN, unread flag or not. It used
        // to take the unread halo, which after the five-colour pass would
        // paint the finished-turn ring around a running session and say
        // two contradictory things at once. Unread on a session that is
        // moving resolves itself the moment it stops, and the row will
        // say so then.
        if (
            status === 'working' ||
            status === 'working_subagent' ||
            status === 'running'
        ) {
            return { inner: 'working', outer: 'active' };
        }

        // THE FINISHED TURN NOBODY HAS LOOKED AT. A green ring around the
        // same faint grey centre dot `unknown` shows: the owner asked
        // first for "a green outline and grey filled dot", then on
        // 2026-09-09 for the dot's own solid fill to go, "it should look
        // like the 'status not measured' dot, but the outline should be
        // green instead of light grey with the dark grey center", and
        // then - after a fix that cleared the centre too far, to nothing
        // - for the centre to come back exactly as `unknown` draws it:
        // "the green outline dot should look like this grey one on the
        // bottom, just the ring should be green instead of light gray".
        // The inner state is still `done` - the CHAT is at rest, and the
        // ring is what says there is something here for the user. Only
        // the ring's colour changes; see client/css/status-led.css. This
        // is what the envelope icon used to carry, before the icon was
        // removed from both surfaces.
        if (status === 'finished_unread') {
            return { inner: 'done', outer: 'unread' };
        }

        // READ AND AT REST. The dot goes to the NEUTRAL grey `idle` and
        // the ring stays lit-and-still in that same grey, so a session
        // the user has looked at is visibly calmer than one they have
        // not without the LED changing size. `unread` here is defensive
        // rather than reachable from a well-formed row - the server
        // derives this pair from the flag on every path, see
        // src/core/session_status.derive_read_state - but if the two
        // ever arrive contradictory the flag must not be swallowed, so
        // it renders identically to `finished_unread` above and the
        // group roll-up in session-status-summary.js cannot disagree
        // with the row under it.
        if (status === 'idle') {
            return unread
                ? { inner: 'done', outer: 'unread' }
                : { inner: 'idle', outer: 'steady' };
        }

        // Everything else - `unknown`, an absent field, a state this
        // client does not know yet. NOT `done`: not having measured is
        // not the same as having measured rest, and collapsing the two is
        // the false green this project keeps paying for. It takes no
        // unread ring either: a green ring is a claim that a turn
        // FINISHED here, and nothing was measured.
        return { inner: 'unknown', outer: 'dim' };
    }

    const api = {
        INNER_STATES: INNER_STATES.slice(),
        OUTER_STATES: OUTER_STATES.slice(),
        INNER_LABELS: INNER_LABELS,
        ledHtml: ledHtml,
        ledStateFor: ledStateFor,
        ledLabel: ledLabel,
        normalizeInner: normalizeInner,
        normalizeOuter: normalizeOuter,
    };

    // Published on the global object rather than on `window` by name, so
    // the same file loads unchanged in a browser, in a standalone gallery
    // page, and under `node --test` (which has a globalThis and no
    // window). This module has no other environment dependency; keep it
    // that way.
    globalThis.StatusLed = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[StatusLed Module] Loaded');
})();
