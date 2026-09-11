/**
 * A shared CSS-custom-property diff writer, for every theme paint path
 * that sets variables on an element's inline style - :root for the page
 * (registry.js's paintCssVars) and #terminal-screen for the terminal
 * scope (registry.js's paintTerminalScope).
 *
 * WHY A DIFF WRITER, NOT A WHOLE-CALL SKIP. Setting a CSS custom property
 * to the value it already holds still invalidates style for everything
 * that depends on it - a full ~30-variable palette reapplied unchanged
 * is real recalculation for zero visual difference. The fix has to be
 * PER PROPERTY. A whole-call skip keyed on "is this the same theme id"
 * would also skip a genuine value change hiding behind an unchanged id
 * (a manifest whose cssVars differ from what is actually applied right
 * now, for any reason), and it would skip exactly the thing this project
 * cannot afford to skip: REMOVING a variable the outgoing set does not
 * carry. `6f79e90` made paintTerminalScope move the CSS scope and the
 * xterm palette TOGETHER, precisely so a variable is removed rather than
 * orphaned when the pin takes the scope off the agent; a skip that also
 * skipped that removal would reintroduce stale styling under a different
 * name. So removal here is UNCONDITIONAL - it is never gated on whether
 * anything else changed - and only the per-property SET is what gets to
 * check "is this already the value on the element" before writing.
 *
 * THIS FILE OWNS NO POLICY ABOUT WHEN TO REPAINT, only how to apply one
 * property set once the caller has decided to. It does not touch xterm
 * listeners, audio, effects.js or persistence - those stay exactly where
 * they already lived, firing on every call as before. Folding this
 * writer's per-property skip into a caller that also skipped THOSE would
 * be a very different, much riskier change; this file structurally
 * cannot do that, because it never reaches into anything but one style
 * object and one plain values map.
 *
 * Exports window.ThemeVarWriter.
 */

console.log('[ThemeVarWriter Module] Loading...');

(function () {
    'use strict';

    /**
     * Description: apply one set of CSS custom properties to `style`,
     *   comparing against the values a previous call recorded, so an
     *   unchanged value is never re-set - only ever removed
     *   unconditionally when it drops out of the next set, or set when
     *   it is new or has changed.
     * Inputs: style (CSSStyleDeclaration) - the inline style to write.
     *         previous (object|null) - name -> value this element was
     *           last painted with by THIS writer, or null/empty for a
     *           first paint.
     *         next (object|null) - name -> value to paint now.
     * Output: object - {values, skipped, total} where `values` is the
     *   name -> value map now in force (hand this back in as `previous`
     *   next time), `skipped` is how many property SETS were unnecessary
     *   (already that value) and were not written, and `total` is how
     *   many properties `next` declared.
     * Example:
     *   var applied = ThemeVarWriter.applyVarDiff(
     *       document.documentElement.style, {}, {'--bg': '#000'});
     *   // applied.values -> {'--bg': '#000'}, applied.skipped -> 0
     */
    function applyVarDiff(style, previous, next) {
        var prev = previous || {};
        var nextVars = next || {};
        var nextNames = Object.keys(nextVars);
        var i;
        var nextSet = Object.create(null);
        for (i = 0; i < nextNames.length; i++) nextSet[nextNames[i]] = true;

        // REMOVAL IS NEVER SKIPPED. A name the previous paint set that
        // this one does not carry is unset unconditionally - there is no
        // "unchanged" reading of "this variable stopped applying".
        var prevNames = Object.keys(prev);
        for (i = 0; i < prevNames.length; i++) {
            var stale = prevNames[i];
            if (!nextSet[stale]) {
                try { style.removeProperty(stale); } catch (_) { /* ignore */ }
            }
        }

        var values = {};
        var skipped = 0;
        for (i = 0; i < nextNames.length; i++) {
            var name = nextNames[i];
            var value = String(nextVars[name]);
            if (Object.prototype.hasOwnProperty.call(prev, name) && prev[name] === value) {
                // UNCHANGED VALUE - the only thing this writer skips. No
                // setProperty call, so nothing for the engine to
                // re-invalidate every dependent style over.
                values[name] = value;
                skipped++;
                continue;
            }
            try { style.setProperty(name, value); } catch (_) { /* ignore bad vars */ }
            values[name] = value;
        }

        return { values: values, skipped: skipped, total: nextNames.length };
    }

    window.ThemeVarWriter = { applyVarDiff: applyVarDiff };
    console.log('[ThemeVarWriter Module] Exported as window.ThemeVarWriter');
})();
