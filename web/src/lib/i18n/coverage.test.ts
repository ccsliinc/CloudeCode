/**
 * THE COVERAGE GUARD: what fails when someone hardcodes a string again.
 *
 * A string layer nobody can regress is worth having; one that quietly
 * loses a screen at a time is not. A hardcoded literal is INVISIBLE by
 * construction - it renders correctly, reads correctly, and is simply
 * never translated. So there are two independent guards here, and they
 * fail for different reasons on purpose.
 *
 *   1. THE BEHAVIOURAL GUARD. Render the ported surface in the
 *      pseudo-locale and require every user-visible string to come back
 *      fully bracketed. A hardcoded literal cannot follow a locale
 *      change, so it comes back bare and the assertion fails. This is the
 *      strong one: it tests what the user would see.
 *   2. THE SOURCE GUARD. Read the ported files and refuse any string
 *      literal that looks like a sentence. This is the fast one: it names
 *      the file and the literal, so the failure is actionable without
 *      running a screen.
 *
 * Both were MUTATION-PROVEN when they shipped: a literal was reintroduced
 * into client/js/labels/session-summary.js, both tests were confirmed to
 * fail, and it was reverted. A guard nobody has watched fail is a guard
 * nobody has tested.
 *
 * PORTED_FILES IS THE LIST SLICES 2 TO 7 APPEND TO. Adding a file here is
 * the last step of porting a screen, and it is what makes the guard grow
 * with the migration instead of only covering the first surface. See
 * .claude/notes/i18n-design.md.
 *
 * Run with: npm test   (from web/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import { isPseudo, pseudoCount, PSEUDO_LOCALE } from '../../../../client/js/i18n/pseudo.js';
import enCatalog from '../../../../client/js/i18n/catalog.en.js';
import { SUMMARY_KEYS } from '../../../../client/js/labels/session-summary.js';
import { summaryLabel } from '../session-summary-label';

/** Repo root, three levels up from web/src/lib/i18n. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Files whose user-visible strings have been ported to the catalog.
 *
 * APPEND TO THIS WHEN YOU PORT A SCREEN. A file listed here may not carry
 * a hardcoded sentence; a file not listed is simply not covered yet, and
 * the count assertion below is what stops this list quietly emptying.
 */
const PORTED_FILES = [
    'client/js/labels/session-summary.js',
    'client/js/session-status-summary.js',
    'web/src/lib/session-summary-label.ts',
];

interface I18nLike {
    t(key: string, params?: Record<string, unknown> | null): string;
    readonly locale: string;
}

// ---- guard 1: the behavioural one ------------------------------------

describe('the pseudo locale proves the surface really reads the catalog', () => {
    /**
     * Every summary shape the ported surface can be asked to render,
     * with HOW MANY catalog messages each one must be built from.
     *
     * The count is the second half of the guard. `isPseudo` cannot see a
     * hardcoded fragment passed as a PARAMETER, because the outer message
     * wraps it; the count can, because a hardcoded bucket word means one
     * fewer catalog lookup. Zero sessions is one message; a plain line is
     * three (the line, the bucket, the count); a line with unread is four.
     */
    const CASES: Array<[{ bucket: string; total: number; unreadCount: number }, number]> = [
        [{ bucket: 'unknown', total: 0, unreadCount: 0 }, 1],
        [{ bucket: 'working', total: 1, unreadCount: 0 }, 3],
        [{ bucket: 'working', total: 2, unreadCount: 0 }, 3],
        [{ bucket: 'unread', total: 2, unreadCount: 1 }, 4],
        [{ bucket: 'permission', total: 19, unreadCount: 3 }, 4],
        [{ bucket: 'done', total: 1, unreadCount: 1 }, 4],
        [{ bucket: 'dead', total: 3, unreadCount: 0 }, 3],
        [{ bucket: 'input', total: 2, unreadCount: 2 }, 4],
    ];

    test('every rendered sentence is fully pseudo-localised', () => {
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        const t = (k: string, p?: Record<string, unknown> | null) => i18n.t(k, p);
        for (const [summary] of CASES) {
            const label = summaryLabel(summary, t);
            // FULLY bracketed with a BALANCED span, not merely starting
            // and ending with a bracket: a sentence built by gluing a
            // translated part onto a hardcoded one would do that too.
            expect(isPseudo(label), `${JSON.stringify(summary)} -> ${label}`).toBe(true);
        }
    });

    test('and it is built from exactly the expected number of messages', () => {
        // THE GUARD FOR THE CASE `isPseudo` CANNOT SEE. A bucket word or a
        // count hardcoded and interpolated into the line would still be
        // wrapped by the outer message; it would not raise this count.
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        const t = (k: string, p?: Record<string, unknown> | null) => i18n.t(k, p);
        for (const [summary, expected] of CASES) {
            const label = summaryLabel(summary, t);
            expect(
                pseudoCount(label),
                `${JSON.stringify(summary)} -> ${label}`,
            ).toBe(expected);
        }
    });

    test('the counts still format inside the pseudo locale', () => {
        // A pseudo-locale that broke interpolation would fail for its own
        // reasons and stop being evidence about anything else.
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        const t = (k: string, p?: Record<string, unknown> | null) => i18n.t(k, p);
        expect(summaryLabel({ bucket: 'working', total: 19, unreadCount: 3 }, t))
            .toContain('19');
        expect(summaryLabel({ bucket: 'working', total: 1234, unreadCount: 0 }, t))
            .toContain('1,234');
    });

    test('NEGATIVE CONTROL: an unported sentence is NOT pseudo, so the guard can fail', () => {
        // Without this, a guard whose `isPseudo` always answered true
        // would pass every assertion above and prove nothing.
        expect(isPseudo('working - 2 sessions')).toBe(false);
        expect(isPseudo('⟦working ~~~⟧, 1 unread')).toBe(false);
        // TWO bracketed runs with a hardcoded fragment between them: the
        // shape a starts-with/ends-with check would wrongly accept.
        expect(isPseudo('⟦a ~⟧ and ⟦b ~⟧')).toBe(false);
        expect(isPseudo('')).toBe(false);
        // ...while a legitimately NESTED composition is accepted.
        expect(isPseudo('⟦⟦a ~⟧ - ⟦b ~⟧ ~⟧')).toBe(true);
        expect(pseudoCount('⟦⟦a ~⟧ - ⟦b ~⟧ ~⟧')).toBe(3);
    });

    test('the pseudo catalog has exactly the default catalog keys, never fewer', () => {
        // It is derived, so it cannot go stale - this asserts that it
        // really is derived rather than a copy somebody made once.
        const i18n = createI18n({ locale: 'en' }) as unknown as {
            catalogFor(k: string): { messages: Record<string, unknown> };
        };
        const en = Object.keys(i18n.catalogFor('en').messages).sort();
        const pseudo = Object.keys(i18n.catalogFor(PSEUDO_LOCALE).messages).sort();
        expect(pseudo).toEqual(en);
        expect(en.length).toBeGreaterThan(15);
    });
});

// ---- guard 2: the source one -----------------------------------------

/**
 * Strip comments, then strip every `console.*(...)` call.
 *
 * Description: comments legitimately contain prose, and so do developer
 *   diagnostics - a `console.error` explaining that the string layer is
 *   missing is not user-visible copy and must not be flagged. Everything
 *   left is a literal that could reach a screen. The console stripper
 *   counts parentheses rather than matching a regex, because these calls
 *   run across several lines.
 * Inputs: src (string) - a source file.
 * Output: string - the same source with comments and diagnostics removed.
 * Example: scannable("console.log('a b'); const x = 'c d';")
 *   // "; const x = 'c d';"
 */
function scannable(src: string): string {
    let out = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ');
    let index = out.indexOf('console.');
    while (index !== -1) {
        const open = out.indexOf('(', index);
        if (open === -1) break;
        let depth = 0;
        let i = open;
        for (; i < out.length; i++) {
            if (out[i] === '(') depth++;
            else if (out[i] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        out = out.slice(0, index) + ' ' + out.slice(Math.min(i + 1, out.length));
        index = out.indexOf('console.', index);
    }
    return out;
}

/** Every single- or double-quoted literal in a source string. */
function stringLiterals(src: string): string[] {
    const found: string[] = [];
    const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        found.push(m[1] ?? m[2] ?? '');
    }
    return found;
}

/**
 * Whether a literal reads like a sentence a user would see.
 *
 * Description: two or more space-separated words of two-plus letters. A
 *   dotted catalog key has no spaces and never matches; an identifier, a
 *   CSS class and a single word never match either. The bar is
 *   deliberately low-precision in the SAFE direction: it flags things a
 *   human then has to look at, which is the right trade for a guard.
 * Inputs: literal (string).
 * Output: boolean.
 * Example: looksLikeCopy('no sessions')  // true
 * Example: looksLikeCopy('session.summary.none')  // false
 */
function looksLikeCopy(literal: string): boolean {
    if (literal.includes('.') && !literal.includes(' ')) return false;
    return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(literal);
}

describe('a ported file may not carry a hardcoded sentence', () => {
    test.each(PORTED_FILES)('%s holds no user-visible literal', (rel) => {
        const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const offenders = stringLiterals(scannable(src)).filter(looksLikeCopy);
        expect(
            offenders,
            `${rel} holds copy that should be a catalog key: ${JSON.stringify(offenders)}`,
        ).toEqual([]);
    });

    test('the list of ported files is not empty and the files exist', () => {
        // A guard that silently scanned nothing would pass forever.
        expect(PORTED_FILES.length).toBeGreaterThanOrEqual(3);
        for (const rel of PORTED_FILES) {
            expect(fs.existsSync(path.join(repoRoot, rel)), rel).toBe(true);
        }
    });

    test('NEGATIVE CONTROL: the scanner does find a literal when there is one', () => {
        // The mutation test in one assertion: if this ever stops failing
        // on obvious copy, the guard above has stopped guarding.
        expect(stringLiterals(scannable("const a = 'no sessions';")).filter(looksLikeCopy))
            .toEqual(['no sessions']);
        // ...and does not flag the things that are not copy.
        expect(stringLiterals(scannable("t('session.summary.none');")).filter(looksLikeCopy))
            .toEqual([]);
        expect(stringLiterals(scannable("console.error('no string layer here');")).filter(looksLikeCopy))
            .toEqual([]);
    });
});

describe('the catalog itself stays honest', () => {
    test('every key the ported surface asks for exists', () => {
        const keys = [
            SUMMARY_KEYS.none,
            SUMMARY_KEYS.sessions,
            SUMMARY_KEYS.unread,
            SUMMARY_KEYS.line,
            SUMMARY_KEYS.lineWithUnread,
        ];
        for (const key of keys) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
        for (const bucket of ['permission', 'input', 'working', 'unread', 'done', 'dead', 'unknown']) {
            const key = SUMMARY_KEYS.bucketPrefix + bucket;
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
    });

    test('UI copy is lowercase and plain, and a catalog is not an exemption', () => {
        // CLAUDE.md's voice rule. A catalog is exactly the place a rule
        // like this stops being enforced unless something enforces it.
        const values: string[] = [];
        for (const value of Object.values(enCatalog as Record<string, unknown>)) {
            if (typeof value === 'string') values.push(value);
            else if (value && typeof value === 'object') {
                values.push(...(Object.values(value as Record<string, string>)));
            }
        }
        expect(values.length).toBeGreaterThan(15);
        for (const value of values) {
            // No leading capital, and no sentence-initial capital anywhere.
            expect(value, value).not.toMatch(/^[A-Z]/);
            // No em-dash or en-dash, per the project's voice rule.
            expect(value, value).not.toMatch(/[–—]/);
        }
    });

    test('every plural set carries the mandatory `other` form', () => {
        for (const [key, value] of Object.entries(enCatalog as Record<string, unknown>)) {
            if (value && typeof value === 'object') {
                expect(
                    Object.prototype.hasOwnProperty.call(value, 'other'),
                    `${key} is a plural set with no \`other\``,
                ).toBe(true);
            }
        }
    });
});
