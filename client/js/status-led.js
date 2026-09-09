/**
 * Status LED - the two-ring session indicator.
 *
 * WHY TWO RINGS AND NOT ONE DOT. The old `.status-dot` collapsed two
 * genuinely independent questions into one colour: WHAT STATE the chat is
 * in (working, blocked on me, finished, dead) and WHETHER ANYTHING IS
 * RUNNING in it right now. Those are not the same question - an agent
 * stopped on a permission prompt is a live turn making no progress, and a
 * session that finished an hour ago and one still mid-tool-call are both
 * "not blocked". Two rings say both at once.
 *
 * So this module models the LED as TWO INDEPENDENT DIMENSIONS:
 *
 *   inner dot  - the chat's own status, INCLUDING read versus unread.
 *                One of INNER_STATES.
 *   outer ring - ACTIVITY ONLY. One of OUTER_STATES.
 *
 * THE RING MEANS ACTIVITY AND NOTHING ELSE (2026-09-09). The owner's
 * original spec, verbatim: "behind this is a larger glowing circle is
 * colored and pulsing on activity and steady on done". It had drifted:
 * `finished_unread` painted an amber breathing ring, so a session that
 * had merely finished a turn looked exactly like one with work running
 * in it. The owner's report: "the ring around some of the leds are not
 * gray, which means there should be background tasks. i dont think those
 * few have any background tasks." A pulsing ring is the loudest thing on
 * the screen and it was firing for the quietest state there is.
 *
 * So the outer `unread` state is RETIRED, and unread now lives entirely
 * on the inner dot: green `done` is finished-and-unread, grey `idle` is
 * finished-and-read. One dimension, one meaning - which is what the two
 * rings were for in the first place.
 *
 * BOTH ARE DRAWN ON ONE ELEMENT. The inner dot is the span's fill and
 * the outer ring is a box-shadow on that same span - there is no
 * pseudo-element and no second box. A box gets pixel-snapped
 * independently of its parent's box, so a halo drawn as its own box came
 * apart from the dot by a device pixel whenever the dot landed on a
 * fractional x/y; a box-shadow is painted from the element's own border
 * box and cannot. See the header of client/css/status-led.css.
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
     * `idle` and `done` are separate because they answer different
     * questions about a session at rest. `idle` is READ: a turn ended,
     * nothing is waiting, the user has already seen it - a NEUTRAL grey,
     * the calmest colour on the dial. `done` means "there is something
     * here you have not read yet". Since 2026-09-09 that pair is the
     * ONLY place unread is expressed: the ring says nothing about it,
     * so green versus grey is the whole signal and it carries no
     * animation with it.
     * Added 2026-09-09, owner's report verbatim: "i need the lights to go
     * idle, (i think thats gray) when i click on a tab. there needs to be
     * a read/idle color." Before this, opening a tab left the inner dot
     * green (`done`) whether or not it had been read, so the only visible
     * change was the outer ring - too subtle to register at a glance.
     *
     * @type {string[]}
     */
    const INNER_STATES = [
        'working',
        'waiting-permission',
        'waiting-input',
        'idle',
        'done',
        'dead',
        'unknown',
    ];

    /**
     * Outer-ring vocabulary: ACTIVITY, and nothing else.
     *
     * `active` is the only state that animates, and it means exactly one
     * thing: something is running in this session right now. `steady` is
     * lit and still - the agent is stopped waiting on the user, which is
     * a live turn that is not moving. `off` is at rest: finished, idle or
     * dead, read or unread alike. `dim` is not measured.
     *
     * `unread` WAS a member and was retired 2026-09-09 - see the module
     * header. It made the calmest state on the dial paint the loudest
     * ring, and a ring that means two things means neither.
     *
     * @type {string[]}
     */
    const OUTER_STATES = ['active', 'steady', 'off', 'dim'];

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
        'waiting-permission': 'waiting on you - permission',
        'waiting-input': 'waiting on you',
        idle: 'idle - already read',
        done: 'done - unread',
        dead: 'dead - process exited',
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
     *   outer half is appended only when it says something new, and
     *   since the ring carries activity alone - which the inner state
     *   already implies - no outer state adds a word today. The hook is
     *   kept because a future outer state might.
     * Inputs: inner (string), outer (string) - already normalized.
     * Output: string.
     * Example: ledLabel('done', 'off') -> 'done - unread'
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
     *     and glow around it. `title` overrides the derived
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
     *   dead outranks everything (a corpse is not "busy"), then anything
     *   blocking on the user, then activity, then rest.
     *
     *   THE RING IS DERIVED FROM ONE QUESTION: is something running in
     *   this session right now. `working` breathes, a stopped-but-live
     *   turn (`question` / `notice` / a startup prompt) is lit and still,
     *   and every resting or unmeasurable state leaves it off or dim.
     *   Unread never touches it - it is the inner dot's business, green
     *   for finished-and-unread against grey for read. See the module
     *   header for what that ring was claiming before 2026-09-09.
     * Inputs:
     *   signals (Object|null) - `{activity_status, unread, startup_gate}`
     *     exactly as they arrive on a `/sessions/list` row. All three are
     *     optional; missing ones degrade to not-measured rather than to a
     *     confident answer.
     * Output:
     *   Object - `{inner, outer}`, both members of the vocabularies.
     * Example:
     *   ledStateFor({activity_status: 'idle'})
     *   // {inner: 'idle', outer: 'off'}
     * Example:
     *   ledStateFor({activity_status: 'idle', unread: true})
     *   // {inner: 'done', outer: 'off'}
     */
    function ledStateFor(signals) {
        const s = signals || {};
        const status = s.activity_status;
        const unread = !!s.unread;
        const gate = s.startup_gate;

        // A dead pane is dead whatever else is true of it, and an unread
        // flag must not paint a corpse as something to go and read.
        if (status === 'dead' || status === 'stopped') {
            return { inner: 'dead', outer: 'off' };
        }

        // Blocked on a keypress at startup. Measured by the startup gate,
        // which is a separate probe from the hook stream, so it is
        // checked on its own rather than folded into `activity_status`.
        if (gate === 'awaiting_startup_prompt') {
            return { inner: 'waiting-input', outer: 'steady' };
        }

        // THE AGENT IS STOPPED. `question` is a PermissionRequest and
        // nothing else since the 2026-09-08 split - it gets the louder
        // inner hue, because a yes/no nobody has answered is the one
        // state on this screen that will not resolve itself.
        // The ring is STEADY, not breathing: the agent is stopped, and a
        // pulsing ring means something is running. Lit because the turn
        // is still open - a parked turn is not a resting session.
        if (status === 'question') {
            return { inner: 'waiting-permission', outer: 'steady' };
        }

        // Claude asked to be looked at and is NOT blocked. Same ring as a
        // permission prompt - both are live turns that are not moving -
        // and the calmer of the two inner hues, shared with the startup
        // gate above because both are "come and look", not "approve
        // this".
        if (status === 'notice') {
            return { inner: 'waiting-input', outer: 'steady' };
        }

        // `running` is the pre-hook-era spelling and still arrives from a
        // stale cached response; mapping it here rather than letting it
        // fall through keeps a half-upgraded deployment meaningful.
        if (
            status === 'working' ||
            status === 'working_subagent' ||
            status === 'running'
        ) {
            // THE ONLY BREATHING RING IN THE APP. Unread is deliberately
            // not consulted: a working session is working, and the ring
            // says so whether or not an earlier turn is still unread.
            return { inner: 'working', outer: 'active' };
        }

        // FINISHED AND UNREAD - the green dot, and NO ring. This is the
        // 2026-09-09 correction: it used to breathe an amber ring, which
        // read as background activity on the one state that means the
        // opposite. The dot's colour is the whole signal.
        if (status === 'finished_unread') {
            return { inner: 'done', outer: 'off' };
        }

        // READ AND AT REST. `idle` on the server already means "already
        // seen" (docs/session-status.md), so the ordinary case is the
        // NEUTRAL grey `idle` dot with the ring fully off - at rest reads
        // as at rest, not as a dim copy of `done`. The `unread` branch is
        // defensive rather than reachable from a well-formed row (the
        // server derives this pair from the flag on every path - see
        // src/core/session_status.derive_read_state), but if the two ever
        // arrive contradictory the flag must not be swallowed: it renders
        // identically to `finished_unread` so the header rollup in
        // session-status-summary.js cannot disagree with the row under it.
        if (status === 'idle') {
            return unread
                ? { inner: 'done', outer: 'off' }
                : { inner: 'idle', outer: 'off' };
        }

        // Everything else - `unknown`, an absent field, a state this
        // client does not know yet. NOT `done`: not having measured is
        // not the same as having measured rest, and collapsing the two is
        // the false green this project keeps paying for. The unread flag
        // does not move it either, for the same reason: a flag is not a
        // measurement of what the session is doing, and the ring is only
        // allowed to speak about activity that was measured.
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
