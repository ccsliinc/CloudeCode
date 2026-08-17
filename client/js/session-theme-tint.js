/**
 * SessionThemeTint - paints a session row in the colours of that
 * session's own theme.
 *
 * WHY. Per-session themes exist so you can tell your sessions apart at a
 * glance once you are INSIDE one (see session-theme-menu.js). Outside
 * one - in the sidebar list and on the home screen - every row looked
 * identical, so the whole point of picking a theme evaporated exactly
 * where you are choosing which session to enter. This module carries the
 * identity out to the list.
 *
 * WHAT IT PAINTS, AND WHAT IT DELIBERATELY DOES NOT. Every cue is drawn
 * from the theme's OWN `--color-accent`:
 *
 *   1. a 3px inline-start rail and a 1px ring, both as inset box-shadows
 *      rather than borders, so they cost no layout and do not collide
 *      with the `.running-session-row.owned/.external` left border that
 *      already encodes ownership. On the home screen the two read as a
 *      two-tone edge: ownership outside, session theme inside.
 *   2. a low-alpha wash of the same accent over the row background - ON
 *      THE SIDEBAR ROW ONLY, see below - layered as a background-IMAGE
 *      so the row's existing background-color (hover, and the active-row
 *      highlight) still shows through underneath.
 *
 * It does NOT touch the row's text colour, its badges, its status dot or
 * its icons. Those keep the palette of the theme the USER IS LOOKING AT,
 * which is the only palette whose contrast against the surrounding page
 * anyone has reasoned about. A row that borrowed a light theme's
 * foreground into a dark app would be unreadable, and vice versa.
 *
 * WHY THE HOME ROW GETS NO WASH. The wash is the only cue that puts
 * anything behind text, so it is the only one that can cost contrast,
 * and the two surfaces are not equally able to afford it. The sidebar
 * name is `--color-fg`, which every theme picks to sit on its own
 * background; sweeping all 23 x 23 (host theme, session theme) pairs, a
 * 0.10 wash drops NO pair below 4.5:1. The home row's name is
 * `--color-accent` over `--color-accent-bg-soft`, and several themes
 * already sit barely above the floor there - jagermeister is 5.66:1
 * before any wash at all. At alpha 0.10 that costs 44 of the 529 pairs
 * their 4.5:1; even at 0.03 it costs 6. There is no alpha at which the
 * home wash is safe, so the home row gets the rail and the ring, which
 * are edges and sit behind nothing. The sweep is re-run as an assertion
 * in tests/test_session_theme_tint.node.mjs.
 *
 * NO THEME, UNKNOWN THEME, REGISTRY NOT READY: all three render exactly
 * as the row does today. `attrs()` returns an empty string and the row
 * carries no `data-session-theme`, so not one declaration in
 * session-theme-tint.css can match it. Three outcomes, and the two that
 * are not "themed" are the same one: leave it alone. In particular the
 * registry is populated asynchronously by `Themes.init()`, so an early
 * paint must degrade to today's row rather than to a default colour.
 *
 * Loads BEFORE session-sidebar-rows.js and launchpad.js.
 */
(function () {
    'use strict';

    /**
     * Alpha of the accent wash behind a sidebar row.
     *
     * 0.10 is not a taste value: it is the largest round alpha at which
     * all 529 (host theme, session theme) pairs keep the sidebar name
     * above the 4.5:1 body-text floor. Raising it is a contrast change,
     * not a styling tweak - re-run the sweep in the test if you touch it.
     */
    var WASH_ALPHA = 0.10;

    /**
     * Alpha of the 1px ring around a themed row. It sits on the row's
     * edge, behind no text, so it is free of the wash's constraint; it
     * is under 1 only so the ring reads as trim rather than as a second
     * border competing with the ownership one.
     */
    var RING_ALPHA = 0.45;

    /** Cache of theme id -> {accent, wash}, or null for "not themeable". */
    var cache = new Map();

    /**
     * Parse a `#rgb` or `#rrggbb` colour into its channels.
     *
     * @param {string} hex - colour text from a theme manifest.
     * @returns {?{r: number, g: number, b: number}} null for anything
     *   that is not a plain hex colour, which is the honest answer for a
     *   theme that expresses its accent some other way.
     */
    function parseHex(hex) {
        if (typeof hex !== 'string') return null;
        var h = hex.trim();
        if (h.charAt(0) !== '#') return null;
        h = h.slice(1);
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        var n = parseInt(h, 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    /**
     * The manifest for one theme id, from the client-side registry.
     *
     * @param {string} themeId - a theme id such as 'dracula'.
     * @returns {?object} the manifest, or null when the registry has not
     *   loaded yet or does not know the id.
     */
    function manifestFor(themeId) {
        if (!window.Themes || typeof window.Themes.listAll !== 'function') return null;
        var all;
        try {
            all = window.Themes.listAll();
        } catch (_) {
            return null;
        }
        if (!Array.isArray(all)) return null;
        for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].id === themeId) return all[i];
        }
        return null;
    }

    /**
     * The two colours a themed row is painted with.
     *
     * @param {?string} themeId - the session's pinned theme id, or null.
     * @returns {?{accent: string, wash: string, ring: string}} null
     *   whenever the row must render as an unthemed row does.
     */
    function colorsFor(themeId) {
        if (!themeId) return null;
        if (cache.has(themeId)) return cache.get(themeId);
        var manifest = manifestFor(themeId);
        // Not cached: the registry fills in asynchronously, so "unknown
        // right now" must stay askable on the next paint.
        if (!manifest || !manifest.cssVars) return null;
        var rgb = parseHex(manifest.cssVars['--color-accent']);
        if (!rgb) return null;
        var channels = rgb.r + ', ' + rgb.g + ', ' + rgb.b;
        var value = {
            accent: 'rgb(' + channels + ')',
            wash: 'rgba(' + channels + ', ' + WASH_ALPHA + ')',
            ring: 'rgba(' + channels + ', ' + RING_ALPHA + ')',
        };
        cache.set(themeId, value);
        return value;
    }

    /**
     * The HTML attributes that turn a session row into a themed one.
     *
     * Returns a leading-space-prefixed attribute fragment for splicing
     * straight into a row template, or `''` when the row must look
     * exactly as it does today.
     *
     * @param {?string} themeId - the session's pinned theme id, or null.
     * @returns {string} e.g. ` data-session-theme="dracula" style="..."`.
     */
    function attrs(themeId) {
        var colors = colorsFor(themeId);
        if (!colors) return '';
        var safeId = String(themeId).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeId) return '';
        return (
            ' data-session-theme="' + safeId + '"' +
            ' style="--session-theme-accent: ' + colors.accent + ';' +
            ' --session-theme-wash: ' + colors.wash + ';' +
            ' --session-theme-ring: ' + colors.ring + ';"'
        );
    }

    window.SessionThemeTint = {
        attrs: attrs,
        colorsFor: colorsFor,
        WASH_ALPHA: WASH_ALPHA,
        RING_ALPHA: RING_ALPHA,
    };
})();
