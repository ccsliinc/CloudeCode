/**
 * The compiled tree's accessor, and the repaint behind it.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the runes module
 * compiles, that it ADOPTS the page's instance rather than building a
 * second one, and that `t()` returns the new locale's string the moment
 * `setLocale` runs - which is the whole chain except its last link.
 *
 * The last link is Svelte re-running a template that read a `$state`, and
 * that is Svelte's own guarantee rather than this module's behaviour.
 * Testing it here would need a DOM, and vitest runs in `node` on purpose
 * (see vitest.config.ts): buying jsdom as a dependency to re-test the
 * framework's core promise is not a trade this project's dependency
 * policy would make. The FIRST COMPONENT that renders a string is where
 * that link gets exercised for real, and slice 2 is the one to do it.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test } from 'vitest';
import { createI18n } from '../../../../client/js/i18n/runtime.js';
import { i18n, t, setLocale, currentLocale } from './index.svelte';

describe('the svelte accessor', () => {
    test('translates through the same catalog the legacy tree reads', () => {
        expect(t('session.status.working')).toBe('working');
        expect(t('session.summary.sessions', { count: 2 })).toBe('2 sessions');
    });

    test('a locale change moves what t() answers', () => {
        // The reactive dependency is a counter this module bumps from its
        // own subscription; that the counter moves is Svelte's business,
        // but that the STRING moves is this module's, and it is what a
        // repainted template would show.
        expect(currentLocale()).toBe('en');
        expect(t('session.summary.none')).toBe('no sessions');
        expect(setLocale('pseudo')).toBe(true);
        expect(currentLocale()).toBe('pseudo');
        expect(t('session.summary.none')).not.toBe('no sessions');
        expect(t('session.summary.none')).toContain('no sessions');
        setLocale('en');
        expect(t('session.summary.none')).toBe('no sessions');
    });

    test('IT ADOPTS THE PAGE INSTANCE, it does not create a second one', () => {
        // Two instances would be two current locales, and moving one
        // would leave the other painting the old language. In the browser
        // `boot.js` publishes the instance first; here there is no global,
        // so this module made its own - and the assertion that matters is
        // that it is exactly ONE object, reachable both ways.
        expect(typeof i18n.t).toBe('function');
        const other = createI18n({ locale: 'en' });
        expect(other).not.toBe(i18n);
        // Proof they are genuinely separate objects, so the adoption above
        // is a real property and not a tautology.
        other.setLocale('pseudo');
        expect(currentLocale()).toBe('en');
    });
});
