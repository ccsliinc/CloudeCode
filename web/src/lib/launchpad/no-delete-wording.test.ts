/**
 * NO USER-FACING STRING ANYWHERE SAYS DELETE, DELETED OR DELETION.
 *
 * PORTED FROM tests/test_no_delete_wording.node.mjs, deleted in the same
 * commit, and DELIBERATELY A SUPERSET OF IT. The node original scanned
 * `client/index.html` and `client/js/**`. Slice 2 moved this section's
 * copy into `client/js/i18n/catalog.en.js` and its markup into
 * `web/src/**`, so a guard that still scanned only the old tree would
 * have kept passing while the words it forbids walked into the new one.
 * A guard that cannot see where the code went is worse than no guard,
 * because it reads green.
 *
 * WHY. The owner's model, verbatim (2026-09-08): "sessions and projects
 * can be archived not deleted. archived items are not visible unless the
 * checkbox is checked." Nothing an app action performs is a hard delete
 * from the user's point of view, so nothing the UI SAYS may claim one.
 * `DELETE /sessions/records/{uuid}` stamps `archived_at` and the row
 * keeps every column; a restart is what brings it back.
 *
 * WHAT COUNTS AS USER-FACING, AND WHY IT IS NOT A BARE SUBSTRING GREP.
 * `deleteSessionRecord`, `class="ended-session-delete"`,
 * `cloude.launchpad.deletedSessionsVisible`, `archiveRecord` - CLAUDE.md
 * is explicit that identifiers like these stay exactly as they are, and
 * this slice kept every one of them on purpose: renaming the localStorage
 * key would silently RESET the preference for everyone who set it. So
 * this file separates the copy a person reads from the identifier a
 * machine reads, in four steps:
 *
 *   1. Tokenize each source file into string literals only, so comments
 *      and bare code identifiers are never captured.
 *   2. Drop a literal that is identifier-shaped (a kebab token, a dotted
 *      key, a bare internal attribute) or is a console.* argument.
 *   3. When what remains looks like an HTML fragment, keep only the parts
 *      a person reads: text between tags, and the title / aria-label /
 *      aria-description / placeholder / alt values. `class="..."` and
 *      `data-*="..."` are never extracted, by construction.
 *   4. Otherwise check the whole string.
 *
 * A Svelte template is scanned with the HTML rules directly, because it
 * IS markup rather than a string containing markup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import enCatalog from '../../../../client/js/i18n/catalog.en.js';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** The word family this whole file exists to keep out of the UI. */
const DELETE_WORD = /\bdelet(?:e|ed|ion)\b/i;

/** Attributes whose VALUE a person actually reads on screen. */
const USER_FACING_ATTRS = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt'];

/** A CSS token, a dotted key, or any other bare identifier shape. */
const IDENTIFIER_SHAPE = /^[.#]?[a-zA-Z][a-zA-Z0-9]*(?:[.:_-]+[a-zA-Z0-9]+)*$/;

/** A standalone `class=`/`id=`/`data-*=` fragment. Never read by a user. */
const BARE_INTERNAL_ATTR = /^(?:class|id|data-[a-zA-Z0-9-]+)=(["'])[^"']*\1$/;

/** Characters before a `/` that mean it opens a regex, not a division. */
const CODE_CHAR_BEFORE_REGEX = /[([{,;:=!&|?+\-*%^~<>]$/;
/** Keywords before a `/` that mean the same. */
const KEYWORD_BEFORE_REGEX =
    /^(?:return|typeof|instanceof|in|of|new|delete|void|yield|case|do|else|throw)$/;

/**
 * Decide whether the `/` at `src[i]` opens a regex literal.
 *
 * Description: looks backward past whitespace to the previous
 *   significant character or keyword; a `/` after one of those cannot be
 *   division, because nothing to divide precedes it. This is the exact
 *   confusion a naive quote-tracking scanner hits on a
 *   `replace(/[<>&"']/g, ...)` - the quote characters inside that class
 *   corrupt every string boundary found afterwards unless the regex is
 *   recognised and skipped whole.
 * Inputs: src - the file text. i - index of the `/`.
 * Output: boolean.
 * Example: isRegexLiteralStart("x.replace(/a/, '')", 10)  // true
 */
function isRegexLiteralStart(src: string, i: number): boolean {
    // `charAt` rather than `[]`: `noUncheckedIndexedAccess` types an
    // index read as `string | undefined`, and an out-of-range read here
    // means "start of file", which is exactly what `charAt`'s empty
    // string tests as.
    let k = i - 1;
    while (k >= 0 && /\s/.test(src.charAt(k))) k--;
    if (k < 0) return true;
    if (CODE_CHAR_BEFORE_REGEX.test(src.charAt(k))) return true;
    let wordStart = k;
    while (wordStart >= 0 && /[a-zA-Z_$]/.test(src.charAt(wordStart))) wordStart--;
    return KEYWORD_BEFORE_REGEX.test(src.slice(wordStart + 1, k + 1));
}

/** One captured literal and where it started, for the console check. */
interface Literal { text: string; start: number }

/**
 * Tokenize source into string literals, skipping comments and regexes.
 *
 * Description: template literals are handled RECURSIVELY, so a template
 *   nested inside another's `${...}` closes on its OWN backtick rather
 *   than the outer literal's. A naive find-the-next-backtick scan treats
 *   the inner literal's opening backtick as the outer one's close and
 *   corrupts every boundary after it.
 * Inputs: src - the file text.
 * Output: every string literal, with its opening offset.
 * Example: tokenizeStringLiterals("const a = 'hi';")  // [{text:'hi',...}]
 */
function tokenizeStringLiterals(src: string): Literal[] {
    const out: Literal[] = [];
    const n = src.length;

    function walk(start: number, insideInterpolation: boolean): number {
        let i = start;
        let braceDepth = 0;
        while (i < n) {
            const c = src.charAt(i);
            const c2 = src.charAt(i + 1);
            if (c === '/' && c2 === '/') {
                i += 2;
                while (i < n && src[i] !== '\n') i++;
                continue;
            }
            if (c === '/' && c2 === '*') {
                i += 2;
                while (i < n && !(src[i] === '*' && src.charAt(i + 1) === '/')) i++;
                i += 2;
                continue;
            }
            if (c === '/' && isRegexLiteralStart(src, i)) {
                let j = i + 1;
                let inClass = false;
                while (j < n) {
                    if (src.charAt(j) === '\\') { j += 2; continue; }
                    if (src.charAt(j) === '[') { inClass = true; j++; continue; }
                    if (src.charAt(j) === ']') { inClass = false; j++; continue; }
                    if (src.charAt(j) === '/' && !inClass) break;
                    if (src.charAt(j) === '\n') break;
                    j++;
                }
                j++;
                while (j < n && /[a-zA-Z]/.test(src.charAt(j))) j++;
                i = j;
                continue;
            }
            if (c === '"' || c === "'") {
                const quote = c;
                const litStart = i;
                let j = i + 1;
                let buf = '';
                while (j < n && src.charAt(j) !== quote) {
                    if (src.charAt(j) === '\\') { buf += src.charAt(j + 1) || ''; j += 2; continue; }
                    buf += src.charAt(j);
                    j++;
                }
                out.push({ text: buf, start: litStart });
                i = j + 1;
                continue;
            }
            if (c === '`') {
                let j = i + 1;
                let buf = '';
                const litStart = i;
                while (j < n && src.charAt(j) !== '`') {
                    if (src.charAt(j) === '\\') { buf += src.charAt(j + 1) || ''; j += 2; continue; }
                    if (src.charAt(j) === '$' && src.charAt(j + 1) === '{') { j = walk(j + 2, true); continue; }
                    buf += src.charAt(j);
                    j++;
                }
                out.push({ text: buf, start: litStart });
                i = j + 1;
                continue;
            }
            if (insideInterpolation && c === '}' && braceDepth === 0) return i + 1;
            if (c === '{') { braceDepth++; i++; continue; }
            if (c === '}') { braceDepth--; i++; continue; }
            i++;
        }
        return i;
    }

    walk(0, false);
    return out;
}

/**
 * Pull the user-legible fragments out of one markup string.
 *
 * Inputs: text - markup, or a plain sentence.
 * Output: the fragments worth checking.
 * Example: fragmentsOfMarkup('<b>archive</b>')  // ['archive']
 */
function fragmentsOfMarkup(text: string): string[] {
    const fragments: string[] = [];
    // A capture group that matched always has a value; the `?? ''` is
    // what `noUncheckedIndexedAccess` needs to see, not a real case.
    for (const m of text.matchAll(/>([^<>]+)</g)) {
        const inner = (m[1] ?? '').trim();
        if (inner) fragments.push(inner);
    }
    for (const attr of USER_FACING_ATTRS) {
        for (const m of text.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))) {
            fragments.push(m[1] ?? '');
        }
    }
    return fragments;
}

/**
 * Pull the user-legible fragments out of one raw literal.
 *
 * Inputs: text - the literal. precedingSrc - up to 40 chars before its
 *   opening quote, used only to recognise a console.* call.
 * Output: fragments worth checking; empty for an identifier or a
 *   diagnostic.
 * Example: userFacingFragmentsOf('archive this', '')  // ['archive this']
 */
function userFacingFragmentsOf(text: string, precedingSrc: string): string[] {
    if (/console\s*\.\s*(?:log|warn|error|debug|info)\s*\($/.test(precedingSrc.trimEnd())) {
        return [];
    }
    const trimmed = text.trim();
    if (IDENTIFIER_SHAPE.test(trimmed) || BARE_INTERNAL_ATTR.test(trimmed)) return [];
    if (/<[a-zA-Z]/.test(text)) return fragmentsOfMarkup(text);
    return [text];
}

/** One violation, with enough context to fix it without re-running. */
interface Violation { file: string; fragment: string }

/**
 * Scan one JS/TS source file.
 *
 * Inputs: rel - the path relative to the repo root.
 * Output: every violation found.
 * Example: scanScript('client/js/launchpad.js')  // []
 */
function scanScript(rel: string): Violation[] {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const violations: Violation[] = [];
    for (const { text, start } of tokenizeStringLiterals(src)) {
        const preceding = src.slice(Math.max(0, start - 40), start);
        for (const fragment of userFacingFragmentsOf(text, preceding)) {
            if (DELETE_WORD.test(fragment)) violations.push({ file: rel, fragment });
        }
    }
    return violations;
}

/**
 * Scan one markup file: `client/index.html` or a `.svelte` template.
 *
 * Description: comments are stripped first, then any `<script>` body is
 *   handed to the JS scanner - a Svelte component's copy lives in both
 *   halves and each needs its own rules.
 * Inputs: rel - the path relative to the repo root.
 * Output: every violation found.
 * Example: scanMarkup('client/index.html')  // []
 */
function scanMarkup(rel: string): Violation[] {
    const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const stripped = raw
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
    const violations: Violation[] = [];
    const scripts = [...stripped.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    let markupOnly = stripped;
    for (const m of scripts) {
        markupOnly = markupOnly.replace(m[0], ' ');
        const body = m[1] ?? '';
        for (const { text, start } of tokenizeStringLiterals(body)) {
            const preceding = body.slice(Math.max(0, start - 40), start);
            for (const fragment of userFacingFragmentsOf(text, preceding)) {
                if (DELETE_WORD.test(fragment)) violations.push({ file: rel, fragment });
            }
        }
    }
    for (const fragment of fragmentsOfMarkup(markupOnly)) {
        if (DELETE_WORD.test(fragment)) violations.push({ file: rel, fragment });
    }
    return violations;
}

/**
 * Every file under a directory whose name ends in one of `exts`.
 *
 * Inputs: rel - directory relative to the repo root. exts - suffixes.
 * Output: repo-relative paths, deterministic order.
 * Example: listFiles('client/js', ['.js']).length  // 190
 */
function listFiles(rel: string, exts: string[]): string[] {
    const out: string[] = [];
    const abs = path.join(repoRoot, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) out.push(...listFiles(child, exts));
        else if (exts.some((e) => entry.name.endsWith(e))) out.push(child);
    }
    return out;
}

const scriptFiles = listFiles('client/js', ['.js']);
// Test files are excluded: their prose describes the rule and naming the
// forbidden word is how they do it. Source only.
const webFiles = listFiles('web/src', ['.ts', '.svelte'])
    .filter((f) => !f.endsWith('.test.ts'));

describe('the legacy tree still says archive', () => {
    test('the walk is not silently empty', () => {
        // A guard that scanned nothing would pass forever.
        expect(scriptFiles.length).toBeGreaterThan(100);
    });

    test('client/index.html has no delete-family copy', () => {
        expect(scanMarkup('client/index.html').map((v) => v.fragment)).toEqual([]);
    });

    test('no client/js file has delete-family copy', () => {
        const violations = scriptFiles.flatMap(scanScript);
        expect(violations).toEqual([]);
    });
});

describe('and so does the compiled tree, which is where slice 2 moved it', () => {
    test('the walk is not silently empty', () => {
        expect(webFiles.length).toBeGreaterThan(10);
    });

    test('no web/src source file has delete-family copy', () => {
        const violations = webFiles.flatMap((f) =>
            (f.endsWith('.svelte') ? scanMarkup : scanScript)(f));
        expect(violations).toEqual([]);
    });
});

describe('and so does the catalog, which is where the copy actually lives now', () => {
    test('no catalog message says delete, deleted or deletion', () => {
        // THE ONE THAT MATTERS MOST. Every sentence this section renders
        // is a value in here, so a guard that skipped the catalog would
        // be scanning the files where the copy no longer is.
        const offenders: string[] = [];
        for (const [key, value] of Object.entries(enCatalog as Record<string, unknown>)) {
            const forms = typeof value === 'string'
                ? [value]
                : Object.values((value ?? {}) as Record<string, string>);
            for (const form of forms) {
                if (DELETE_WORD.test(form)) offenders.push(`${key}: ${form}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the archive vocabulary is present, so the word was replaced not removed', () => {
        // Passing the test above by deleting the copy entirely would be
        // a different bug wearing a green tick.
        const values = Object.values(enCatalog as Record<string, unknown>)
            .flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v as object)))
            .join('\n');
        expect(values).toMatch(/\barchive\b/);
        expect(values).toMatch(/\barchived\b/);
    });
});

describe('NEGATIVE CONTROL: the scanner finds a violation when there is one', () => {
    test('plain copy is caught', () => {
        expect(userFacingFragmentsOf('delete this session', '').filter((f) => DELETE_WORD.test(f)))
            .toEqual(['delete this session']);
    });

    test('copy inside markup is caught, and the identifier beside it is not', () => {
        const markup = '<button class="ended-session-delete" title="delete it">delete</button>';
        const found = fragmentsOfMarkup(markup).filter((f) => DELETE_WORD.test(f));
        // The button's text and its title, and NOT the class name.
        expect(found.sort()).toEqual(['delete', 'delete it']);
    });

    test('an identifier, a dotted key and a console argument are never flagged', () => {
        expect(userFacingFragmentsOf('ended-session-delete', '')).toEqual([]);
        expect(userFacingFragmentsOf('cloude.launchpad.deletedSessionsVisible', '')).toEqual([]);
        expect(userFacingFragmentsOf('the record was deleted', "console.warn(")).toEqual([]);
        expect(userFacingFragmentsOf('class="recent-session-row--deleted"', '')).toEqual([]);
    });

    test('a nested template literal does not corrupt the boundaries after it', () => {
        // The shape a find-the-next-backtick scan gets wrong.
        const src = 'const a = `<ul>${x ? `<li>archive</li>` : ""}</ul>`; const b = "delete it";';
        const texts = tokenizeStringLiterals(src).map((l) => l.text);
        expect(texts).toContain('delete it');
    });
});
