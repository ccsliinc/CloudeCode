/**
 * The pseudo-locale: the coverage test, not a translation.
 *
 * WHAT IT IS FOR. A string that never went through `t()` is invisible.
 * It renders correctly, it reads correctly, and it is simply never
 * translated - and you find out when a customer does. Switching to a
 * locale that visibly MARKS everything it touches turns that invisible
 * bug into an obvious one: any text on screen without brackets around it
 * is a string somebody hardcoded.
 *
 * IT IS DERIVED FROM THE DEFAULT CATALOG, NEVER WRITTEN DOWN. A
 * hand-maintained pseudo catalog goes stale the first time somebody adds
 * a key and forgets it, and a stale coverage test reports coverage it
 * does not have. Generating it means it has exactly the keys `en` has,
 * always, with no way to drift.
 *
 * IT ALSO LENGTHENS, AND THAT IS THE SECOND BUG IT FINDS. German runs
 * roughly a third longer than English and Finnish longer still. The
 * surfaces at risk here are the fixed-width ones - the sidebar row, the
 * status pill, the terminal header - and padding every message by 40
 * percent makes a layout that cannot take a longer language fail in the
 * same pass that finds the unextracted strings. One artifact, two
 * defects.
 *
 * THE PADDING NEVER GOES INSIDE A `{placeholder}`. It is appended after
 * the message body, so interpolation still works and a pseudo-localised
 * plural still selects and still fills. A pseudo-locale that broke
 * formatting would be a test that fails for its own reasons.
 *
 * IT IS NOT REACHABLE BY ACCIDENT. `pseudo` is not a BCP-47 tag, so no
 * browser's `navigator.languages` can ever contain it; only an explicit
 * override selects it. See `runtime.js`.
 */

/** Wraps every pseudo-localised message. Chosen to be unmistakable. */
export const PSEUDO_OPEN = '⟦';

/** Closes every pseudo-localised message. */
export const PSEUDO_CLOSE = '⟧';

/** The character the padding is made of. */
export const PSEUDO_PAD = '~';

/** How much longer a pseudo message is, as a fraction of the original. */
export const PSEUDO_EXPANSION = 0.4;

/** The registry key. Deliberately not a valid BCP-47 tag - see header. */
export const PSEUDO_LOCALE = 'pseudo';

/**
 * Pseudo-localise one message form.
 *
 * Description: brackets it and pads it. Placeholders are untouched
 *   because the padding is appended to the whole body rather than
 *   inserted into it. Deterministic, so a test can assert the exact
 *   string rather than a shape.
 * Inputs: text (string) - one message form.
 * Output: string.
 * Example: pseudoText('working')  // '⟦working ~~~⟧'
 */
export function pseudoText(text) {
    if (typeof text !== 'string') return text;
    const pad = Math.max(1, Math.ceil(text.length * PSEUDO_EXPANSION));
    return PSEUDO_OPEN + text + ' ' + PSEUDO_PAD.repeat(pad) + PSEUDO_CLOSE;
}

/**
 * Whether a finished string went through the pseudo-locale, wholly.
 *
 * Description: THE ASSERTION THE COVERAGE TEST MAKES, and it is a
 *   BALANCED-SPAN check rather than a starts-with/ends-with one. A
 *   composed message nests: `session.summary.line` wraps the whole
 *   sentence and the bucket and count it interpolates are each wrapped
 *   too, so a correct label looks like `⟦⟦working ~⟧ - ⟦1 session ~⟧ ~⟧`.
 *   Testing only the two end characters would accept `⟦a⟧ and ⟦b⟧`, where
 *   the ` and ` between them is exactly the hardcoded fragment this
 *   exists to find. So the depth is walked, and it may only return to
 *   zero at the final character.
 *
 *   IT CANNOT SEE A LITERAL PASSED AS A PARAMETER into another message -
 *   the outer wrap would enclose it. That case is caught by the SOURCE
 *   guard instead, and by the bracket COUNT assertion beside this one in
 *   coverage.test.ts. Two guards, because neither covers the other's gap.
 * Inputs: text (unknown) - a rendered, user-visible string.
 * Output: boolean.
 * Example: isPseudo('⟦working ~~~⟧')  // true
 * Example: isPseudo('⟦a ~⟧ and ⟦b ~⟧')  // false
 */
export function isPseudo(text) {
    if (typeof text !== 'string' || text.length < 2) return false;
    if (!text.startsWith(PSEUDO_OPEN) || !text.endsWith(PSEUDO_CLOSE)) return false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === PSEUDO_OPEN) depth += 1;
        else if (ch === PSEUDO_CLOSE) {
            depth -= 1;
            if (depth < 0) return false;
            // Back to the top before the end means the string is two
            // bracketed runs with something unwrapped between them.
            if (depth === 0 && i !== text.length - 1) return false;
        }
    }
    return depth === 0;
}

/**
 * How many pseudo-localised messages went into one string.
 *
 * Description: one count per opening bracket, so a composed sentence
 *   reports the outer template plus every part interpolated into it. The
 *   coverage test asserts an EXACT number per case, which is what catches
 *   a hardcoded fragment passed in as a parameter - the one shape
 *   :func:`isPseudo` cannot see, because the outer message wraps it.
 * Inputs: text (string).
 * Output: number.
 * Example: pseudoDepthCount('⟦⟦a ~⟧ - ⟦b ~⟧ ~⟧')  // 3
 */
export function pseudoCount(text) {
    if (typeof text !== 'string') return 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === PSEUDO_OPEN) n += 1;
    }
    return n;
}

export function pseudoCatalog(source) {
    const out = {};
    for (const key of Object.keys(source || {})) {
        const value = source[key];
        if (typeof value === 'string') {
            out[key] = pseudoText(value);
            continue;
        }
        if (value && typeof value === 'object') {
            const forms = {};
            for (const category of Object.keys(value)) {
                forms[category] = pseudoText(value[category]);
            }
            out[key] = forms;
            continue;
        }
        // A value that is neither is a malformed catalog entry. Carried
        // through unchanged rather than dropped, so the missing-key
        // machinery downstream is what reports it, in one place.
        out[key] = value;
    }
    return out;
}
