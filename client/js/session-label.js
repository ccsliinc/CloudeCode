/**
 * THE ONE PLACE THAT DECIDES WHAT A SESSION IS CALLED ON SCREEN.
 *
 * A session's NAME IS A LABEL - free-form text a human typed, stored as
 * ``sessions.title`` and delivered as ``label``. The tmux session name is
 * an internal handle derived from that label once, at creation, and never
 * moved again. Keeping them separate is what stops a rename from moving
 * the field session identity is keyed on.
 *
 * WHY THIS IS A MODULE AND NOT A METHOD. Five surfaces render a session's
 * name: the launchpad rows, the browser tab title, the in-page header, a
 * toast card and the attribution prompt. Every one of them has to answer
 * the same question - what do I show when this session has no label? -
 * and a session with no label is not an edge case: it is EVERY session
 * that existed before labels did, plus every external session this app
 * never created. Three surfaces each answering that question separately
 * will drift, and the drift is invisible, because each one looks correct
 * on its own. So the rule lives here, once, and the surfaces call it.
 *
 * THE RULE HAS THREE OUTCOMES, NOT TWO:
 *
 *   1. a label      -> the label, verbatim. Whatever a human typed, and
 *                      that is the whole point of the feature: spaces,
 *                      ``:``, ``.``, quotes and ``$`` are all legal in a
 *                      label because a label is never handed to tmux.
 *   2. no label     -> the ``cloude_``-stripped tmux name. This is
 *                      EXACTLY what every one of these surfaces rendered
 *                      before labels existed, so a session with no label
 *                      looks precisely as it always did.
 *   3. neither      -> null, meaning THIS SESSION CANNOT BE NAMED. Never
 *                      an empty string, never the literal word "null",
 *                      never a silent blank - rendering nothing where a
 *                      name goes is worse than rendering the handle, and
 *                      far worse than saying you do not know.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Outcome 3 is returned, not rendered.
 * The surfaces word it differently on purpose - the tab title falls back
 * to the bare brand, a toast card says so in a sentence - and that is a
 * difference in WORDING, not a second fallback rule. A caller that
 * renders null as a blank has a bug; a caller that renders it as its own
 * sentence is correct.
 *
 * NOT AN IDENTITY, EITHER. Two sessions may carry the same label, and a
 * label matches nothing on the server. Anything that LOOKS UP a session -
 * the deep-link slug matcher, group membership, the adopt POST body, the
 * pinned-theme PATCH URL - must keep using the tmux name. This module is
 * for what a human reads and for nothing else.
 */
(function () {
    'use strict';

    /**
     * The prefix this app puts on the tmux names it creates. Stripped for
     * display because it is an artefact of the launcher, not anything a
     * user typed. Mirrors APP_TMUX_PREFIX in src/core/session_label.py.
     */
    var APP_TMUX_PREFIX = 'cloude_';

    /**
     * What a surface shows for outcome 3. A sentence, because a blank
     * cell and an unknowable one look identical to a reader and mean
     * opposite things.
     */
    var UNKNOWN = 'unknown session';

    /**
     * Trim a value only if it is genuinely a string.
     *
     * Description: a JSON ``null`` arrives as null and a mis-shaped
     * payload could carry a number or an object. None of those is a
     * name, and ``String(null)`` would put the literal word "null" in a
     * browser tab, which is the exact failure this returns null for.
     * Inputs: value (*) - anything.
     * Output: string|null - the trimmed string, or null.
     */
    function cleanString(value) {
        if (typeof value !== 'string') return null;
        var trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }

    /**
     * Strip the app's tmux prefix for display.
     *
     * Inputs: tmuxName (string|null).
     * Output: string|null - the display form, or null when nothing is
     *   left (a name that is ONLY the prefix strips to the empty string,
     *   which must not be rendered as a nameless row).
     * Example: SessionLabel.stripAppPrefix('cloude_Media')  -> 'Media'
     */
    function stripAppPrefix(tmuxName) {
        var name = cleanString(tmuxName);
        if (name === null) return null;
        if (name.indexOf(APP_TMUX_PREFIX) === 0) {
            name = name.slice(APP_TMUX_PREFIX.length);
        }
        return name.length ? name : null;
    }

    /**
     * The string a HUMAN should see for one session, or null.
     *
     * Description: the whole fallback rule, and the only copy of it.
     * Inputs: row (object|null) - reads ``label`` and ``name``. Either
     *   may be absent, empty or the wrong type.
     * Output: string|null - see outcomes 1-3 in the module header. Never
     *   an empty string.
     * Example: SessionLabel.resolve({name: 'cloude_Media',
     *            label: 'Media Compression'})  -> 'Media Compression'
     */
    function resolve(row) {
        if (!row || typeof row !== 'object') return null;
        var label = cleanString(row.label);
        if (label !== null) return label;
        return stripAppPrefix(row.name);
    }

    /**
     * The same rule, for a toast's field names.
     *
     * Description: a toast carries ``session_label`` / ``session_name``
     * rather than ``label`` / ``name``, because a toast already has a
     * ``title`` of its own and the two would collide. That is a SHAPE
     * difference, not a policy difference, so it is normalised into
     * :func:`resolve` rather than given a second copy of the chain.
     * Inputs: toast (object|null) - a server-shape toast.
     * Output: string|null - same three outcomes as :func:`resolve`.
     * Example: SessionLabel.resolveToast({session_name: 'cloude_a'}) -> 'a'
     */
    function resolveToast(toast) {
        if (!toast || typeof toast !== 'object') return null;
        return resolve({ label: toast.session_label, name: toast.session_name });
    }

    window.SessionLabel = {
        APP_TMUX_PREFIX: APP_TMUX_PREFIX,
        UNKNOWN: UNKNOWN,
        stripAppPrefix: stripAppPrefix,
        resolve: resolve,
        resolveToast: resolveToast,
    };
})();
