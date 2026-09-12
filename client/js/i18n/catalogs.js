/**
 * The locale registry: every catalog this build ships, by key.
 *
 * ADDING A SECOND LOCALE IS TWO LINES HERE AND ONE NEW FILE. Copy
 * catalog.en.js to catalog.<tag>.js, translate the values, leave the keys
 * alone, then import it below and add one entry. Nothing else in the app
 * changes, and nothing needs a build step it did not already have.
 *
 * EVERY CATALOG IS BUNDLED, NOT FETCHED. `default-src 'self'` and this
 * project's no-remote-assets rule mean there is no CDN to lazy-load a
 * locale from, and a same-origin fetch would make the first paint async
 * and put a language flash on every page load. Locales are small - the
 * whole en catalog is under 2 KB - so shipping them all costs less than
 * the machinery for shipping one would.
 *
 * THE PSEUDO-LOCALE IS REGISTERED HERE TOO, AND IT IS DERIVED. It is a
 * coverage test rather than a language (see pseudo.js). It cannot be
 * selected by a browser because `pseudo` is not a BCP-47 tag and no
 * `navigator.languages` will ever contain it; only the explicit override
 * reaches it.
 */
import en, { intlLocale as enIntlLocale } from './catalog.en.js';
import { pseudoCatalog, PSEUDO_LOCALE } from './pseudo.js';

/** The locale used when nothing else resolves. */
export const DEFAULT_LOCALE = 'en';

/**
 * Every catalog, by registry key.
 *
 * Description: `messages` is the flat key table; `intl` is the BCP-47 tag
 *   handed to `Intl.PluralRules` and `Intl.NumberFormat`. They are
 *   separate because a registry key need not be a language tag, which is
 *   exactly the pseudo-locale's situation.
 * @type {Object<string, {messages: Object, intl: string}>}
 */
export const CATALOGS = {
    en: { messages: en, intl: enIntlLocale },
    [PSEUDO_LOCALE]: {
        messages: pseudoCatalog(en),
        // English plural rules on purpose: the pseudo-locale exists to
        // test COVERAGE, and it must keep selecting the same forms the
        // default catalog does or its output stops being comparable.
        intl: enIntlLocale,
    },
};

/**
 * The registry keys, for a settings UI and for tests.
 *
 * Inputs: none. Output: string[].
 * Example: availableLocales()  // ['en', 'pseudo']
 */
export function availableLocales() {
    return Object.keys(CATALOGS);
}
