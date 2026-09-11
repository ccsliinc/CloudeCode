/**
 * The accessor, the missing-key contract, and locale selection.
 *
 * THE MISSING-KEY BEHAVIOUR IS A CONTRACT, NOT AN IMPLEMENTATION DETAIL,
 * which is why it is asserted here rather than left to whatever the
 * lookup happens to do. Three things were on the table and two are worse:
 * an empty string is invisible, a `???` placeholder is unattributable,
 * and the key names itself in a bug screenshot. It must also never throw,
 * because a label is not worth a blank sidebar.
 *
 * Run with: npm test   (from web/)
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createI18n, matchLocale } from '../../../../client/js/i18n/runtime.js';

interface I18nLike {
    t(key: string, params?: Record<string, unknown> | null): string;
    setLocale(next: string): boolean;
    onLocaleChange(fn: (locale: string) => void): () => void;
    readonly locale: string;
    readonly problems: string[];
}

let errors: unknown[][] = [];

beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args);
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the accessor', () => {
    test('resolves a plain message', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(i18n.t('session.status.working')).toBe('working');
        expect(i18n.t('session.summary.none')).toBe('no sessions');
    });

    test('resolves a plural, and formats the number', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(i18n.t('session.summary.sessions', { count: 1 })).toBe('1 session');
        expect(i18n.t('session.summary.sessions', { count: 2 })).toBe('2 sessions');
        expect(i18n.t('session.summary.sessions', { count: 1234 })).toBe('1,234 sessions');
    });

    test('interpolates a composed line', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(
            i18n.t('session.summary.line', { bucket: 'working', sessions: '2 sessions' }),
        ).toBe('working - 2 sessions');
    });
});

describe('a missing key', () => {
    test('renders the key itself and never throws', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(() => i18n.t('session.nope.not.a.key')).not.toThrow();
        expect(i18n.t('session.nope.not.a.key')).toBe('session.nope.not.a.key');
    });

    test('is reported LOUDLY, on console.error', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        i18n.t('session.nope.not.a.key');
        expect(errors.length).toBe(1);
        expect(String(errors[0])).toContain('session.nope.not.a.key');
        expect(String(errors[0])).toContain('missing key');
    });

    test('is reported ONCE, not once per row', () => {
        // A key missing on a two-hundred-row list must not drown the
        // console it exists to help.
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        for (let i = 0; i < 200; i++) i18n.t('session.nope.not.a.key');
        expect(errors.length).toBe(1);
    });

    test('a non-string key is refused rather than coerced', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(i18n.t(undefined as unknown as string)).toBe('');
        expect(errors.length).toBe(1);
    });

    test('NEGATIVE CONTROL: a key that EXISTS reports nothing', () => {
        // Without this, a reporter that fired on every call would pass
        // every test above and be useless.
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        i18n.t('session.status.working');
        expect(errors).toHaveLength(0);
        expect(i18n.problems).toHaveLength(0);
    });
});

describe('locale selection', () => {
    test('an exact tag wins', () => {
        expect(matchLocale(['en'], ['en', 'fr'])).toBe('en');
    });

    test('a regional tag falls back to its base language', () => {
        // en-GB and en-US both have to land on `en` without either being
        // listed, or every regional browser gets the default locale.
        expect(matchLocale(['en-GB'], ['en'])).toBe('en');
        expect(matchLocale(['EN-us'], ['en'])).toBe('en');
    });

    test('the first matching preference wins, not the first preference', () => {
        expect(matchLocale(['de', 'fr', 'en'], ['en', 'fr'])).toBe('fr');
    });

    test('NEGATIVE CONTROL: nothing matching returns null, never a guess', () => {
        expect(matchLocale(['de', 'ja'], ['en'])).toBeNull();
        expect(matchLocale([], ['en'])).toBeNull();
        expect(matchLocale(null, ['en'])).toBeNull();
    });

    test('the pseudo locale is unreachable from a browser preference', () => {
        // `pseudo` is not a BCP-47 tag, so no navigator.languages can ever
        // contain it. Only the explicit override selects it.
        expect(matchLocale(['pseudo'], ['en'])).toBeNull();
    });
});

describe('changing the locale', () => {
    test('moves the accessor and notifies subscribers exactly once', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        const seen: string[] = [];
        i18n.onLocaleChange((l) => seen.push(l));
        expect(i18n.t('session.summary.none')).toBe('no sessions');
        expect(i18n.setLocale('pseudo')).toBe(true);
        expect(seen).toEqual(['pseudo']);
        expect(i18n.t('session.summary.none')).not.toBe('no sessions');
        expect(i18n.locale).toBe('pseudo');
    });

    test('setting the locale it is already on is not a change', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        const seen: string[] = [];
        i18n.onLocaleChange((l) => seen.push(l));
        expect(i18n.setLocale('en')).toBe(false);
        expect(seen).toHaveLength(0);
    });

    test('an unknown locale is REFUSED, not accepted-and-empty', () => {
        // Accepting it would make every lookup fall through to the default
        // catalog and read like a translation gap instead of a bad setting.
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        expect(i18n.setLocale('klingon')).toBe(false);
        expect(i18n.locale).toBe('en');
        expect(errors.length).toBe(1);
    });

    test('unsubscribing actually stops the notifications', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        const seen: string[] = [];
        const off = i18n.onLocaleChange((l) => seen.push(l));
        off();
        i18n.setLocale('pseudo');
        expect(seen).toHaveLength(0);
    });

    test('a subscriber that throws does not stop the others', () => {
        const i18n = createI18n({ locale: 'en' }) as I18nLike;
        const seen: string[] = [];
        i18n.onLocaleChange(() => {
            throw new Error('bad subscriber');
        });
        i18n.onLocaleChange((l) => seen.push(l));
        expect(() => i18n.setLocale('pseudo')).not.toThrow();
        expect(seen).toEqual(['pseudo']);
    });

    test('two instances are independent, so a test cannot leak into its neighbour', () => {
        const a = createI18n({ locale: 'en' }) as I18nLike;
        const b = createI18n({ locale: 'en' }) as I18nLike;
        a.setLocale('pseudo');
        expect(b.locale).toBe('en');
        expect(b.t('session.summary.none')).toBe('no sessions');
    });
});
