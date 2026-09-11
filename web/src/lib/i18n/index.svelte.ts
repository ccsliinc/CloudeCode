/**
 * The Svelte tree's door onto the one string layer.
 *
 * IT ADOPTS, IT DOES NOT CREATE. `client/js/i18n/boot.js` publishes
 * `globalThis.CloudeI18n` from its own module script, and that script is
 * loaded before this bundle. Building a second instance here would give
 * the page two current locales, and changing one would leave the other
 * painting the old language - the dual-path failure this design exists to
 * prevent, reappearing one level up from the catalog. A fresh instance is
 * built ONLY when no global exists, which is the vitest case and the
 * broken-boot case, and in both of those there is nothing to disagree
 * with.
 *
 * REACTIVITY IS ONE `$state` COUNTER, AND THAT IS DELIBERATELY ALL. The
 * catalog is not reactive and never needs to be; the only thing that
 * moves at runtime is WHICH locale is current. So a single module-scope
 * rune is bumped on every locale change and read by `t()`, which makes
 * any component template that calls `t()` a subscriber automatically -
 * no store, no context, no per-component wiring, and no chance of a
 * component forgetting to subscribe. Mirroring the whole catalog into
 * runes would be a second copy of state with nothing to gain.
 *
 * THE PURE CORE IS NOT IN HERE. `t()` below delegates to the runtime,
 * which delegates to `format.js`, which is pure and is where the
 * exhaustive tests live. This file adds exactly one thing: the repaint.
 */
import { createI18n } from '../../../../client/js/i18n/runtime.js';

/** The shape the runtime publishes, as this tree consumes it. */
export interface I18n {
    t(key: string, params?: Record<string, unknown> | null): string;
    setLocale(next: string): boolean;
    onLocaleChange(fn: (locale: string) => void): () => void;
    availableLocales(): string[];
    readonly locale: string;
    readonly problems: string[];
}

/**
 * The shared instance: the page's, when there is one.
 *
 * Description: see the header. In the browser this is the object
 *   `boot.js` published, so the legacy tree and this one are literally
 *   the same layer rather than two that agree.
 */
export const i18n: I18n =
    (globalThis as { CloudeI18n?: I18n }).CloudeI18n ?? (createI18n() as I18n);

/**
 * Bumped whenever the locale moves. The only reactive state here.
 *
 * A counter rather than the locale string itself because the value is
 * never read for its content - it exists to be a dependency - and a
 * monotonic number cannot accidentally compare equal after a change.
 */
let localeVersion = $state(0);

// One subscription for the whole tree, taken at module load. It is never
// unsubscribed: this module lives as long as the page does, and a
// teardown path that can never run is a branch nobody can test.
i18n.onLocaleChange(() => {
    localeVersion += 1;
});

/**
 * Translate a key, reactively.
 *
 * Description: THE ACCESSOR EVERY SVELTE COMPONENT USES. Identical output
 *   to the legacy `window.CloudeI18n.t` for identical input, because it
 *   is the same function - the only difference is that reading
 *   `localeVersion` first registers the calling template as a dependency,
 *   so a `setLocale()` anywhere repaints every component that renders a
 *   string.
 * Inputs:
 *   key - a flat dotted catalog key.
 *   params - interpolation values; a numeric `count` selects the plural.
 * Output: string - the key itself when it is missing, never a throw.
 * Example: t('session.summary.sessions', { count: 2 })  // '2 sessions'
 */
export function t(key: string, params?: Record<string, unknown> | null): string {
    // Read, so the surrounding template re-runs when the locale moves.
    // `void` because the value is a dependency and never an input.
    void localeVersion;
    return i18n.t(key, params);
}

/**
 * Change the locale for the whole page, both trees at once.
 *
 * Inputs: next - a registry key, e.g. 'en' or 'pseudo'.
 * Output: boolean - true when it moved.
 * Example: setLocale('pseudo')
 */
export function setLocale(next: string): boolean {
    return i18n.setLocale(next);
}

/**
 * The current locale key, reactively.
 *
 * Inputs: none. Output: string.
 * Example: currentLocale()  // 'en'
 */
export function currentLocale(): string {
    void localeVersion;
    return i18n.locale;
}
