/**
 * The pure half of the string layer: pick a form, fill the holes.
 *
 * NOTHING IN HERE READS STATE. No current locale, no catalog registry, no
 * globals, no DOM. Every input arrives as an argument and the same
 * arguments always produce the same string, which is what makes this the
 * only part that needs exhaustive tests. `runtime.js` next door owns the
 * mutable half - which locale is current, and who to tell when it moves.
 *
 * NO LIBRARY, AND THE REASON IS THE CONTENT SECURITY POLICY. Every ICU
 * MessageFormat runtime worth using compiles a message into a function,
 * and `script-src 'self'` refuses `new Function` and `eval` outright, so
 * the ones that would work at all are the ones that ship a parser for a
 * feature set this app uses a fraction of. `Intl.PluralRules` and
 * `Intl.NumberFormat` are already in the browser, are already correct for
 * every locale CLDR covers, and cost no bytes. Against this project's
 * dependency policy (prefer the standard library) that is not a close
 * call.
 *
 * THE `Intl` OBJECTS ARE MEMOIZED BECAUSE CONSTRUCTING THEM IS THE
 * EXPENSIVE PART. A group header re-renders per paint and a sidebar can
 * hold twenty of them, so building a fresh `Intl.PluralRules` per call
 * would put locale-data lookup on the render path. Formatting through a
 * cached instance does not.
 */

/** CLDR plural categories, in the order CLDR lists them. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** The parameter name that selects a plural form. */
export const COUNT_PARAM = 'count';

/** Cached `Intl.PluralRules`, keyed by BCP-47 tag. */
const pluralRulesCache = new Map();

/** Cached `Intl.NumberFormat`, keyed by BCP-47 tag. */
const numberFormatCache = new Map();

/**
 * A cached `Intl.PluralRules` for a locale, falling back to en.
 *
 * Description: an unusable tag is a programming error in a catalog's
 *   `intlLocale`, not a user-facing failure, so it degrades to `en`
 *   rather than throwing on a render path. The pseudo-locale reaches
 *   this with `en` on purpose - `pseudo` is a registry key, not a tag,
 *   and `new Intl.PluralRules('pseudo')` throws RangeError.
 * Inputs: locale (string) - a BCP-47 tag.
 * Output: Intl.PluralRules.
 * Example: pluralRulesFor('en').select(1) === 'one'
 */
export function pluralRulesFor(locale) {
    const key = typeof locale === 'string' && locale ? locale : 'en';
    let rules = pluralRulesCache.get(key);
    if (rules) return rules;
    try {
        rules = new Intl.PluralRules(key);
    } catch (err) {
        // RangeError is the only thing this constructor throws, and it
        // means the tag is malformed. Logged rather than swallowed
        // because a catalog shipping a bad tag is a bug someone has to
        // fix, and rendering English is the least-wrong thing meanwhile.
        if (err instanceof RangeError) {
            console.error('[i18n] unusable locale tag for plurals:', key, err.message);
            rules = pluralRulesFor('en');
        } else {
            throw err;
        }
    }
    pluralRulesCache.set(key, rules);
    return rules;
}

/**
 * A cached `Intl.NumberFormat` for a locale, falling back to en.
 *
 * Description: as :func:`pluralRulesFor`, and cached for the same reason.
 *   This is what makes 1234 render `1,234` in en and `1.234` in de
 *   without a single call site knowing that difference exists.
 * Inputs: locale (string) - a BCP-47 tag.
 * Output: Intl.NumberFormat.
 * Example: numberFormatFor('en').format(1234) === '1,234'
 */
export function numberFormatFor(locale) {
    const key = typeof locale === 'string' && locale ? locale : 'en';
    let fmt = numberFormatCache.get(key);
    if (fmt) return fmt;
    try {
        fmt = new Intl.NumberFormat(key);
    } catch (err) {
        if (err instanceof RangeError) {
            console.error('[i18n] unusable locale tag for numbers:', key, err.message);
            fmt = numberFormatFor('en');
        } else {
            throw err;
        }
    }
    numberFormatCache.set(key, fmt);
    return fmt;
}

/**
 * Choose the form of a message: the string itself, or a plural branch.
 *
 * Description: PURE. A string entry is its own only form. An object entry
 *   is a plural set: the category comes from `Intl.PluralRules` applied
 *   to the `count` parameter, and `other` is the fallback whenever the
 *   selected category is absent - which is the normal case, since English
 *   ships `one` and `other` while `select` can return `few` for a locale
 *   whose catalog has not been written yet.
 *
 *   A PLURAL SET WITH NO `count` RESOLVES TO `other` AND SAYS SO. It is a
 *   caller bug, and `other` is the form most likely to read sensibly, so
 *   it is reported rather than thrown: a missing parameter must not blank
 *   a sidebar.
 * Inputs:
 *   entry (string|Object|undefined) - the raw catalog value.
 *   params (Object|null) - the interpolation parameters.
 *   locale (string) - BCP-47 tag for plural selection.
 *   onProblem (Function|null) - called with a one-line reason when the
 *     entry could not be resolved cleanly. Optional.
 * Output: string|null - the chosen template, or null when `entry` is not
 *   a usable catalog value at all.
 * Example: selectForm({one: '{count} session', other: '{count} sessions'},
 *                     {count: 1}, 'en')  // '{count} session'
 */
export function selectForm(entry, params, locale, onProblem) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;

    const p = params || {};
    const count = p[COUNT_PARAM];
    let category = 'other';
    if (typeof count === 'number' && Number.isFinite(count)) {
        category = pluralRulesFor(locale).select(count);
    } else if (onProblem) {
        onProblem('plural set used without a numeric `count` parameter');
    }

    const chosen = Object.prototype.hasOwnProperty.call(entry, category)
        ? entry[category]
        : entry.other;
    if (typeof chosen !== 'string') {
        if (onProblem) {
            onProblem('plural set has no `other` form');
        }
        return null;
    }
    return chosen;
}

/**
 * Fill `{name}` holes in a template.
 *
 * Description: PURE, and deliberately not a parser. One regex pass over
 *   `{identifier}`. A parameter whose value is a NUMBER is formatted
 *   through `Intl.NumberFormat` so digit grouping follows the locale
 *   without any call site knowing; every other value is stringified as
 *   is. A hole with no matching parameter is LEFT VERBATIM rather than
 *   blanked, so `{count}` on screen names the parameter that went
 *   missing, and it is reported.
 *
 *   NOTHING IS ESCAPED HERE. The result is text. Callers that put it into
 *   markup escape it themselves, exactly as they did before this layer
 *   existed; escaping here would double-escape every one of them.
 * Inputs:
 *   template (string) - a message form.
 *   params (Object|null) - values by name.
 *   locale (string) - BCP-47 tag for number formatting.
 *   onProblem (Function|null) - called with a one-line reason per
 *     unmatched hole. Optional.
 * Output: string.
 * Example: interpolate('{count} sessions', {count: 1234}, 'en')
 *   // '1,234 sessions'
 */
export function interpolate(template, params, locale, onProblem) {
    if (typeof template !== 'string') return '';
    if (template.indexOf('{') === -1) return template;
    const p = params || {};
    return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
        if (!Object.prototype.hasOwnProperty.call(p, name)) {
            if (onProblem) onProblem('no value for {' + name + '}');
            return whole;
        }
        const value = p[name];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return numberFormatFor(locale).format(value);
        }
        if (value === null || value === undefined) {
            if (onProblem) onProblem('{' + name + '} is null or undefined');
            return whole;
        }
        return String(value);
    });
}

/**
 * Resolve one catalog entry into finished text.
 *
 * Description: PURE, and the whole of the formatting contract in one
 *   call: choose a plural form, then fill the holes. Everything mutable
 *   about a translation - which catalog, which locale, what to do about a
 *   key nobody wrote - belongs to `runtime.js` and is passed in here.
 * Inputs:
 *   entry (string|Object|undefined) - the raw catalog value.
 *   params (Object|null) - interpolation parameters.
 *   locale (string) - BCP-47 tag.
 *   onProblem (Function|null) - reported problems, one line each.
 * Output: string|null - the finished text, or null when the entry was
 *   not usable, which is how the caller tells a missing key apart from a
 *   message that legitimately renders empty.
 * Example: formatEntry('{bucket} - {sessions}',
 *            {bucket: 'working', sessions: '2 sessions'}, 'en')
 *   // 'working - 2 sessions'
 */
export function formatEntry(entry, params, locale, onProblem) {
    const form = selectForm(entry, params, locale, onProblem);
    if (form === null) return null;
    return interpolate(form, params, locale, onProblem);
}
