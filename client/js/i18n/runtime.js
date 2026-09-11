/**
 * The mutable half of the string layer: which locale, and who to tell.
 *
 * `format.js` is pure and knows nothing. This owns the current locale,
 * the catalog lookup, what happens to a key nobody wrote, and the
 * subscription a Svelte component needs in order to repaint when the
 * locale moves.
 *
 * A MISSING KEY RENDERS THE KEY ITSELF, LOUDLY, AND NEVER THROWS. Three
 * behaviours were on the table and two are worse. An empty string is
 * invisible, so a screen quietly loses a label and nobody notices for a
 * release. A placeholder like `???` is visible and unattributable, so the
 * bug report says "there is a ??? on the sidebar" and somebody spends an
 * afternoon. The KEY is visible AND names itself: a screenshot of the bug
 * is the fix. It is reported through `console.error` on every path,
 * production included, because a missing key is a bug that shipped and
 * the console is where the next person looks. It is DEDUPED, because a
 * key missing on a two-hundred-row list must log once, not two hundred
 * times, or it drowns the console it was supposed to help.
 *
 * THE SAME RULE COVERS A MISSING RUNTIME. If `globalThis.CloudeI18n` is
 * absent - a bare `vm` sandbox in a test, or a module script that failed
 * to load - a legacy caller gets the key back. It does NOT get a second
 * copy of the strings. A fallback table is the dual path this whole
 * design exists to prevent, and a fallback that works is a fallback
 * nobody ever notices is being used.
 *
 * LOCALE SELECTION IS BROWSER-LOCAL FOR NOW, THROUGH A NAMED LADDER, AND
 * THAT IS A DECISION RATHER THAN AN OVERSIGHT. It is not wired into the
 * settings block, for two reasons. It has to resolve SYNCHRONOUSLY at
 * first paint, and a setting that arrives on an async config fetch paints
 * the wrong language and then flips, which is the most recognisable i18n
 * bug there is. And issue #43 is redesigning that block right now, so
 * building on it today is a design collision rather than a merge one.
 * The ladder IS the seam: making locale a server preference later is one
 * rung inserted at the top plus a `setLocale()` when the config lands,
 * and the repaint it needs already works.
 */
import { CATALOGS, DEFAULT_LOCALE, availableLocales } from './catalogs.js';
import { formatEntry } from './format.js';

/** Where an explicit locale choice is remembered, per browser. */
export const LOCALE_STORAGE_KEY = 'cloude.locale';

/** Fired on `window` when the locale moves, for non-Svelte listeners. */
export const LOCALE_CHANGED_EVENT = 'cloude:locale-changed';

/**
 * Read the explicit locale override, if this browser has one.
 *
 * Description: every access is guarded. `localStorage` is not merely
 *   empty in a private window or a node process - the accessor itself
 *   THROWS in some contexts (thumbnail capture, a browser set to block
 *   site data), which is the trap CLAUDE.md already names. A locale that
 *   could take down the first paint would be worse than no locale.
 * Inputs: none.
 * Output: string|null - the stored key, or null.
 * Example: storedLocale()  // 'pseudo'
 */
export function storedLocale() {
    try {
        const raw = globalThis.localStorage
            ? globalThis.localStorage.getItem(LOCALE_STORAGE_KEY)
            : null;
        return raw || null;
    } catch (err) {
        // Deliberately swallowed: an unreadable store is a normal
        // browser configuration, not a fault, and the ladder has three
        // more rungs. Logged at debug rather than error for that reason.
        console.debug('[i18n] locale override unreadable:', err && err.message);
        return null;
    }
}

/**
 * Match a list of preferred tags against the catalogs we ship.
 *
 * Description: PURE, and the reason it is separate from the ladder is
 *   that it is the only rung with a rule in it. An exact match wins; a
 *   PREFIX match is the fallback, so `en-GB` and `en-US` both land on
 *   `en` without either being listed. The comparison is case-insensitive
 *   because BCP-47 is, and `navigator.languages` is not consistent about
 *   it across browsers.
 * Inputs:
 *   preferred (string[]|null) - tags, most-wanted first.
 *   available (string[]) - registry keys.
 * Output: string|null - the winning key, or null when none match.
 * Example: matchLocale(['en-GB', 'fr'], ['en', 'fr'])  // 'en'
 */
export function matchLocale(preferred, available) {
    const list = Array.isArray(preferred) ? preferred : [];
    const have = new Map(
        (available || []).map((key) => [key.toLowerCase(), key]),
    );
    for (const raw of list) {
        if (typeof raw !== 'string' || !raw) continue;
        const tag = raw.toLowerCase();
        const exact = have.get(tag);
        if (exact) return exact;
        const base = tag.split('-')[0];
        const prefix = have.get(base);
        if (prefix) return prefix;
    }
    return null;
}

/**
 * The browser's preferred languages, defensively.
 *
 * Inputs: none. Output: string[] - possibly empty, never null.
 * Example: navigatorLocales()  // ['en-US', 'en']
 */
function navigatorLocales() {
    const nav = globalThis.navigator;
    if (!nav) return [];
    if (Array.isArray(nav.languages) && nav.languages.length) {
        return nav.languages.slice();
    }
    return typeof nav.language === 'string' && nav.language ? [nav.language] : [];
}

/**
 * Resolve the locale to start in.
 *
 * Description: THE LADDER, in order, and the order is the design.
 *   1. an explicit override in localStorage - what a settings UI writes,
 *      and the only way to reach the pseudo-locale;
 *   2. `navigator.languages`, prefix-matched, so `en-GB` finds `en`;
 *   3. DEFAULT_LOCALE.
 *   A server preference, when there is one, becomes rung 0.
 * Inputs: none.
 * Output: string - a key that is guaranteed to be in CATALOGS.
 * Example: resolveLocale()  // 'en'
 */
export function resolveLocale() {
    const keys = availableLocales();
    const override = storedLocale();
    if (override && Object.prototype.hasOwnProperty.call(CATALOGS, override)) {
        return override;
    }
    return matchLocale(navigatorLocales(), keys) || DEFAULT_LOCALE;
}

/**
 * Build an independent string layer.
 *
 * Description: A FACTORY RATHER THAN A MODULE SINGLETON, so a test can
 *   hold its own locale without moving the running app's, and so the
 *   pseudo-locale coverage test cannot leak into the test beside it. The
 *   browser has exactly one instance and `boot.js` is what publishes it.
 * Inputs:
 *   options (Object|null) - `{locale}` to start somewhere specific
 *     instead of running the ladder. Optional.
 * Output: Object - `{t, locale, setLocale, onLocaleChange,
 *   availableLocales, missingKeys, catalogFor}`.
 * Example: const i18n = createI18n({locale: 'pseudo'});
 *   i18n.t('session.summary.none')  // '⟦no sessions ~~~~⟧'
 */
export function createI18n(options) {
    const opts = options || {};
    let locale =
        opts.locale && Object.prototype.hasOwnProperty.call(CATALOGS, opts.locale)
            ? opts.locale
            : resolveLocale();

    /** Keys already reported, so one bad key logs once, not per row. */
    const reported = new Set();
    /** Locale-change subscribers. */
    const listeners = new Set();

    /**
     * Report a problem about one key, at most once per key per instance.
     * Inputs: key (string), reason (string). Output: void.
     */
    function report(key, reason) {
        const seen = key + '::' + reason;
        if (reported.has(seen)) return;
        reported.add(seen);
        console.error('[i18n] ' + reason + ': ' + key + ' (locale ' + locale + ')');
    }

    /**
     * Look a key up, in the current locale then in the default one.
     *
     * Description: the default catalog is the fallback so a partially
     *   translated locale renders English for the keys it has not got
     *   yet, rather than rendering raw keys. A key missing from BOTH is
     *   the missing-key case and is reported as such.
     * Inputs: key (string). Output: string|Object|undefined.
     */
    function lookup(key) {
        const current = CATALOGS[locale];
        if (current && Object.prototype.hasOwnProperty.call(current.messages, key)) {
            return current.messages[key];
        }
        const fallback = CATALOGS[DEFAULT_LOCALE];
        if (
            fallback &&
            Object.prototype.hasOwnProperty.call(fallback.messages, key)
        ) {
            report(key, 'key missing from locale, using ' + DEFAULT_LOCALE);
            return fallback.messages[key];
        }
        return undefined;
    }

    /**
     * Translate one key.
     *
     * Description: THE ONE ACCESSOR. Both trees call this and neither has
     *   a second table behind it. A missing key returns the key itself,
     *   loudly, and never throws - see the module header for why that is
     *   the least-bad of the three options.
     * Inputs:
     *   key (string) - a flat dotted catalog key.
     *   params (Object|null) - interpolation values. A numeric `count`
     *     additionally selects the plural form.
     * Output: string - never null, never undefined, never a throw.
     * Example: t('session.summary.sessions', {count: 2})  // '2 sessions'
     */
    function t(key, params) {
        if (typeof key !== 'string' || !key) {
            console.error('[i18n] t() called with a non-string key:', key);
            return '';
        }
        const entry = lookup(key);
        if (entry === undefined) {
            report(key, 'missing key');
            return key;
        }
        const intl = (CATALOGS[locale] || CATALOGS[DEFAULT_LOCALE]).intl;
        const out = formatEntry(entry, params, intl, (reason) => report(key, reason));
        if (out === null) {
            report(key, 'unusable catalog entry');
            return key;
        }
        return out;
    }

    /**
     * Change the locale, and tell everyone who asked.
     *
     * Description: ONE WRITER. Every surface repaints off this, the
     *   Svelte tree through `onLocaleChange` and any legacy listener
     *   through the `cloude:locale-changed` window event. An unknown key
     *   is refused rather than accepted, because accepting it would make
     *   every subsequent lookup fall through to the default catalog and
     *   look like a translation gap instead of a bad setting.
     * Inputs: next (string) - a registry key.
     * Output: boolean - true when the locale actually moved.
     * Example: setLocale('pseudo')  // true
     */
    function setLocale(next) {
        if (!Object.prototype.hasOwnProperty.call(CATALOGS, next)) {
            console.error('[i18n] no catalog for locale:', next);
            return false;
        }
        if (next === locale) return false;
        locale = next;
        // A key that was missing in the old locale may exist in the new
        // one, so the dedupe set is cleared: keeping it would suppress a
        // report that is now about a different catalog.
        reported.clear();
        try {
            if (globalThis.localStorage) {
                globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, next);
            }
        } catch (err) {
            // Swallowed with a reason: an unwritable store means the
            // choice does not survive a reload, which is a degraded
            // experience and not a failure of the change itself.
            console.debug('[i18n] locale choice not persisted:', err && err.message);
        }
        for (const fn of listeners) {
            try {
                fn(locale);
            } catch (err) {
                // One bad subscriber may not stop the others repainting.
                console.error('[i18n] locale listener threw:', err);
            }
        }
        if (globalThis.dispatchEvent && typeof CustomEvent === 'function') {
            globalThis.dispatchEvent(
                new CustomEvent(LOCALE_CHANGED_EVENT, { detail: { locale } }),
            );
        }
        return true;
    }

    /**
     * Subscribe to locale changes.
     *
     * Inputs: fn (Function) - called with the new locale key.
     * Output: Function - call it to unsubscribe.
     * Example: const off = onLocaleChange(() => repaint());
     */
    function onLocaleChange(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    return {
        t,
        setLocale,
        onLocaleChange,
        availableLocales,
        /** The current registry key. */
        get locale() {
            return locale;
        },
        /** Keys reported as problems, for a test to assert on. */
        get problems() {
            return Array.from(reported);
        },
        /** The raw catalog for a key, for the coverage test. */
        catalogFor(key) {
            return CATALOGS[key];
        },
    };
}
