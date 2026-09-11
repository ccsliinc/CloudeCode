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
import {
    forkFailureNotice,
    loadFailedNotice,
    RECENT_KEYS,
    recentCountLabel,
    recentCountUnavailableLabel,
    restartNotice,
    unavailableDetail,
    unidentifiedRestartNotice,
} from '../../../../client/js/labels/recent-session.js';
import {
    attentionReason,
    attentionTitle,
    archivedNoticeText,
    authorityBannerText,
    PROJECT_TREE_KEYS,
    presenceBadgeText,
    sessionCountLabel,
    workTitle,
} from '../../../../client/js/labels/project-tree.js';
import { ATTENTION_REASON } from '../launchpad/project-groups';
import { FAMILY_PILL_KEYS, familyPillView } from '../launchpad/agent-family-pill';
import {
    RUNNING_SESSION_KEYS,
    listingAttentionDetail,
    relativeAge,
    rowActionFailed,
    runningCountLabel,
    runningCountUnavailableLabel,
} from '../../../../client/js/labels/running-session.js';
import {
    PROJECT_WORK_UNRECORDED_KEY,
    SESSION_WORK_UNRECORDED_KEY,
    workAttrs,
} from '../launchpad/project-node';
import { summaryLabel } from '../session-summary-label';
import {
    PROJECT_CREATE_KEYS,
    cloneFailure,
    nameRefusal,
    uniqueNameFailure,
} from '../../../../client/js/labels/project-create.js';
import { validateName } from '../launchpad/project-folder';

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
    // Slice 2, the RECENT sessions section. The assembler first, then
    // every file the section is built from - the component included,
    // because a literal in a TEMPLATE is exactly as untranslated as one
    // in a function and is the easier of the two to write by accident.
    'client/js/labels/recent-session.js',
    'web/src/lib/launchpad/recent.ts',
    'web/src/lib/launchpad/recent-actions.ts',
    'web/src/lib/launchpad/recent-chrome.ts',
    'web/src/lib/launchpad/recent-visibility.ts',
    'web/src/lib/launchpad/RecentSessions.svelte',
    'web/src/lib/sessions/store.svelte.ts',
    'web/src/lib/ui/prefs.svelte.ts',
    // Slice 3, the session data layer. The assembler first, then every
    // module the layer is built from. `listing.ts` is on the list even
    // though it deliberately holds no copy at all - a reason token is an
    // identifier, not a sentence - because the way that rule breaks is
    // somebody adding a human explanation beside a token, and the scan is
    // what catches it.
    'client/js/labels/session-listing.js',
    'web/src/lib/sessions/listing.ts',
    'web/src/lib/sessions/running.ts',
    'web/src/lib/sessions/attribution.ts',
    'web/src/lib/sessions/poller.ts',
    'web/src/lib/sessions/host.ts',
    'web/src/lib/sessions/env.ts',
    'web/src/lib/sessions/types.ts',
    // Slice 4, the project tree. The assembler first, then every module
    // and component the tree is built from. The COMPONENTS are on the
    // list for the reason slice 2 gave: a literal in a TEMPLATE is
    // exactly as untranslated as one in a function and is the easier of
    // the two to write by accident.
    'client/js/labels/project-tree.js',
    'web/src/lib/launchpad/project-groups.ts',
    'web/src/lib/launchpad/project-node.ts',
    'web/src/lib/launchpad/project-chrome.ts',
    'web/src/lib/launchpad/project-chrome-control.ts',
    'web/src/lib/launchpad/project-tree-host.ts',
    'web/src/lib/launchpad/agent-family-pill.ts',
    'web/src/lib/launchpad/tree-collapse.svelte.ts',
    'web/src/lib/launchpad/ProjectTree.svelte',
    'web/src/lib/launchpad/ProjectNode.svelte',
    'web/src/lib/launchpad/ProjectSessionRow.svelte',
    'web/src/lib/launchpad/EndedSessionRow.svelte',
    'web/src/lib/launchpad/TreeSessionRows.svelte',
    'web/src/lib/launchpad/NoProjectGroup.svelte',
    'web/src/lib/launchpad/AttentionGroup.svelte',
    'web/src/lib/launchpad/AgentFamilyPill.svelte',
    // Slice 5, the running-sessions list. The assembler first, then every
    // module and component the list is built from. The plugin is on the
    // list because slice 5 moved its two labels into the catalog: the
    // card renders that contribution as an inline control, and every
    // user-visible string on this surface goes through the string layer.
    'client/js/labels/running-session.js',
    'web/src/lib/launchpad/running-row.ts',
    'web/src/lib/launchpad/running-actions.ts',
    'web/src/lib/launchpad/running-host.ts',
    'web/src/lib/launchpad/running-chrome.ts',
    'web/src/lib/launchpad/RunningSessions.svelte',
    'web/src/lib/launchpad/RunningSessionRow.svelte',
    'web/src/lib/launchpad/RunningSessionName.svelte',
    'web/src/lib/launchpad/StartupGateBadge.svelte',
    'web/src/lib/launchpad/WrapperPill.svelte',
    'web/src/lib/sessions/session-label.ts',
    'web/src/lib/plugins/mark-unread/index.ts',
    // Slice 6, the modals and the create flows. The assembler first, then
    // every module and component the flows are built from. The MODALS are
    // on the list for the reason slice 2 gave about templates, and the
    // FLOWS are on it for a reason of their own: `create-flow.ts` and
    // `open-folder-flow.ts` both raise sentences the user reads on a
    // failure path, and one of them used to THROW its English rather than
    // render it - the exact shape slice 5's guard caught one surface over.
    'client/js/labels/project-create.js',
    'web/src/lib/launchpad/project-folder.ts',
    'web/src/lib/launchpad/create-flow.ts',
    'web/src/lib/launchpad/create-host.ts',
    'web/src/lib/launchpad/entry-flows.ts',
    'web/src/lib/launchpad/open-folder-flow.ts',
    'web/src/lib/launchpad/project-actions.ts',
    'web/src/lib/launchpad/modals.ts',
    'web/src/lib/launchpad/modal-types.ts',
    'web/src/lib/modal.ts',
    'web/src/lib/launchpad/ModalShell.svelte',
    'web/src/lib/launchpad/ChoiceModal.svelte',
    'web/src/lib/launchpad/CloneModal.svelte',
    'web/src/lib/launchpad/EditProjectModal.svelte',
    'web/src/lib/launchpad/ProjectFolderModal.svelte',
    'web/src/lib/launchpad/ProjectNameModal.svelte',
    // Slice 7, the shell and the navigation glue. The assembler first,
    // then the markup and every module beside it. The NAVIGATION files
    // are on the list for a reason of their own: slice 6 found a create
    // flow that THREW its english rather than rendering it, and
    // `selectProject`'s deep-link refusal is the same shape - a sentence
    // that is thrown as well as shown. It carries a key.
    'client/js/labels/home-screen.js',
    'web/src/lib/launchpad/HomeScreen.svelte',
    'web/src/lib/launchpad/HelpDisclosure.svelte',
    'web/src/lib/launchpad/RichText.svelte',
    'web/src/lib/launchpad/rich-text.ts',
    'web/src/lib/launchpad/home-screen-host.ts',
    'web/src/lib/launchpad/home-chrome.ts',
    'web/src/lib/launchpad/home-sections.ts',
    'web/src/lib/launchpad/home-anchors.ts',
    'web/src/lib/launchpad/new-fab.ts',
    'web/src/lib/launchpad/panels.ts',
    'web/src/lib/launchpad/navigation.ts',
    'web/src/lib/launchpad/nav-host.ts',
    'web/src/lib/launchpad/deep-link.ts',
    'web/src/lib/launchpad/status-report.ts',
    'web/src/lib/launchpad/shim.ts',
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
 *
 *   HTML COMMENTS ARE STRIPPED TOO, and slice 4 is what forced it. A
 *   `.svelte` file's header comment is `<!-- -->`, not a JSDoc block, and
 *   the ones in this migration quote the copy they are explaining - so
 *   `"I retired this"` inside a comment about two badges was reported as
 *   untranslated copy. A comment is not copy whichever syntax it wears.
 *
 *   `class="..."` VALUES ARE STRIPPED, and slice 6 is what forced that.
 *   A multi-class attribute like `class="modal-btn modal-btn-primary"` is
 *   two space-separated words of two-plus letters, which is exactly what
 *   `looksLikeCopy` looks for, and it is a contract with a stylesheet
 *   rather than something a human reads. ONLY `class` is stripped:
 *   `title`, `aria-label` and `placeholder` all carry real copy and stay
 *   in the scan, which the negative control below asserts.
 *
 *   `rel="..."` VALUES ARE STRIPPED TOO, and slice 7 forced that. The
 *   home bar's outbound link carries `rel="noopener noreferrer"`, which
 *   is two space-separated words of two-plus letters and is a contract
 *   with the BROWSER - it is never rendered and translating it would
 *   disable the protection it buys. Unlike `class`, there is no case in
 *   which a `rel` value is copy at all.
 * Inputs: src (string) - a source file.
 * Output: string - the same source with comments and diagnostics removed.
 * Example: scannable("console.log('a b'); const x = 'c d';")
 *   // "; const x = 'c d';"
 */
function scannable(src: string): string {
    let out = src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ')
        .replace(/\bclass=("[^"]*"|'[^']*')/g, 'class=""')
        .replace(/\brel=("[^"]*"|'[^']*')/g, 'rel=""');
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
    if (WIRE_LITERALS.has(literal)) return false;
    if (COMMAND_LITERALS.has(literal)) return false;
    return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(literal);
}

/**
 * Fragments of the SERVER's own error text, matched but never rendered.
 *
 * SLICE 6 FORCED THIS LIST AND IT IS DELIBERATELY SHORT AND EXPLICIT.
 * `cloneFailure` and the create flow decide which of their own catalog
 * sentences to show by looking for a signature substring the backend
 * embeds in its detail text - `already exists`, `not authenticated`, and
 * so on. Those substrings are a wire protocol in all but name: they are
 * what the server SAYS, they are never shown to anyone, and translating
 * them would break the match rather than translate anything.
 *
 * Every sentence those matchers RETURN is a catalog message, which is the
 * half that matters. Adding to this list is a decision to be reviewed,
 * not a way around the guard: nothing here may be a sentence, and the
 * negative control below asserts the list has not started swallowing one.
 */
const WIRE_LITERALS = new Set([
    'already exists',
    'already running',
    'not authenticated',
    'not found',
    'repo not found',
    'repository not found',
    'gh auth login',
    'gh cli not',
    'install with `brew install gh`',
    'timed out',
]);

/**
 * Shell commands the help panel SHOWS, and must never translate.
 *
 * SLICE 7 FORCED THIS LIST AND IT IS A DIFFERENT KIND FROM THE ONE
 * ABOVE. A wire literal is what the SERVER says and is matched but never
 * rendered; these are rendered verbatim and never matched. A command is
 * typed into a terminal and has to work byte for byte - a translated
 * `tmux -L cloude` is a broken instruction, and the socket name in it is
 * the same `-L cloude` the whole app depends on. They live in
 * `client/js/labels/home-screen.js` as DATA beside the catalog, and the
 * prose that introduces them is a catalog message like everything else.
 *
 * Nothing here may be a sentence, which the negative control asserts.
 */
const COMMAND_LITERALS = new Set([
    'tmux -L cloude new -s mywork; claude',
    'tmux -L cloude new -s mywork "claude --dangerously-skip-permissions; exec $SHELL"',
    'tmux -L cloude new -s mywork \\"$SHELL -ic \'cld; exec $SHELL\'\\"',
]);

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
        expect(PORTED_FILES.length).toBeGreaterThanOrEqual(70);
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
        // ...and the two exemption lists have not started swallowing a
        // sentence: every entry in them must be something the scanner
        // WOULD otherwise have flagged, and none may read as prose.
        for (const command of COMMAND_LITERALS) {
            expect(/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(command), command).toBe(true);
            expect(command.includes('tmux -L cloude'), command).toBe(true);
        }
        expect(stringLiterals(scannable('<a rel="noopener noreferrer">')).filter(looksLikeCopy))
            .toEqual([]);
        expect(stringLiterals(scannable('<a title="noopener noreferrer">')).filter(looksLikeCopy))
            .toEqual(['noopener noreferrer']);
        expect(stringLiterals(scannable("t('session.summary.none');")).filter(looksLikeCopy))
            .toEqual([]);
        expect(stringLiterals(scannable("console.error('no string layer here');")).filter(looksLikeCopy))
            .toEqual([]);
        // ...including a Svelte header comment, which is where slice 4's
        // components explain themselves.
        expect(stringLiterals(scannable('<!-- it says \'the folder is gone\' -->'))
            .filter(looksLikeCopy)).toEqual([]);
        // ...and a multi-class attribute, which is a stylesheet contract.
        expect(stringLiterals(scannable('<button class="modal-btn modal-btn-primary">'))
            .filter(looksLikeCopy)).toEqual([]);
        // ...while EVERY OTHER ATTRIBUTE still carries real copy and is
        // still scanned. Without this, stripping `class` would have
        // quietly stopped covering the accessible names.
        expect(stringLiterals(scannable('<span title="folder not found">'))
            .filter(looksLikeCopy)).toEqual(['folder not found']);
        expect(stringLiterals(scannable('<span aria-label="archive project">'))
            .filter(looksLikeCopy)).toEqual(['archive project']);
        expect(stringLiterals(scannable('<input placeholder="paste your url here">'))
            .filter(looksLikeCopy)).toEqual(['paste your url here']);
        // ...and the wire-literal list is NOT a hole big enough to hide a
        // sentence in: every entry is a fragment, none is copy.
        for (const literal of WIRE_LITERALS) {
            expect(literal.split(/\s+/).length, literal).toBeLessThanOrEqual(5);
            expect(literal, literal).not.toMatch(/[.!?]$/);
        }
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

// ---- guard 1, applied to slice 2's surface ---------------------------

describe('the RECENT surface really reads the catalog too', () => {
    /**
     * A pseudo-locale translator over the derived pseudo catalog.
     *
     * Inputs: none. Output: `(key, params) => string`.
     */
    function pseudoT(): (k: string, p?: Record<string, unknown> | null) => string {
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        return (k, p) => i18n.t(k, p);
    }

    /**
     * Every sentence this section can say, with HOW MANY catalog
     * messages each is built from.
     *
     * ONE MESSAGE EACH, AND THAT IS THE DESIGN RATHER THAN A WEAKNESS.
     * The code this replaced glued a ` "title"` fragment into the middle
     * of three restart sentences and built its count with a `+`. Every
     * one of those is now a WHOLE message with a `{title}` or `{count}`
     * hole, so the assembly a translator sees is the sentence, not the
     * pieces. A count of 1 therefore asserts that nothing was
     * re-fragmented: a sentence rebuilt from two messages would read 2,
     * and one rebuilt from a message plus a literal would read 1 but
     * fail `isPseudo` unless the literal went in through a parameter -
     * which is the case the SOURCE guard below is the only thing that
     * catches, and is why both guards exist.
     */
    const CASES: Array<[string, string, number]> = (() => {
        const t = pseudoT();
        return [
            ['count one', recentCountLabel(1, t), 1],
            ['count many', recentCountLabel(19, t), 1],
            ['count unavailable', recentCountUnavailableLabel(t), 1],
            ['unavailable title', t(RECENT_KEYS.unavailableTitle), 1],
            ['unavailable detail fallback', unavailableDetail(null, t), 1],
            ['load failed', loadFailedNotice(new Error('timeout'), t), 1],
            ['load failed, no message', loadFailedNotice(new Error(''), t), 2],
            ['empty with archived', t(RECENT_KEYS.emptyIncludingArchived), 1],
            ['ended', t(RECENT_KEYS.lifecycleEnded), 1],
            ['name fallback', t(RECENT_KEYS.nameFallback), 1],
            ['archive action', t(RECENT_KEYS.archiveAction), 1],
            ['archive title', t(RECENT_KEYS.archiveActionTitle), 1],
            ['archive aria', t(RECENT_KEYS.archiveActionAria), 1],
            ['archive badge', t(RECENT_KEYS.archiveBadge), 1],
            ['archive badge title', t(RECENT_KEYS.archiveBadgeTitle), 1],
            ['archive show', t(RECENT_KEYS.archiveShow), 1],
            ['archive hide', t(RECENT_KEYS.archiveHide), 1],
            ['archive no id', t(RECENT_KEYS.archiveFailedNoId), 1],
            ['restart action', t(RECENT_KEYS.restartAction), 1],
            ['restart, nothing said', restartNotice(null, t), 1],
            ['restart none_recorded', restartNotice({ conversation: 'none_recorded' }, t), 1],
            ['restart none_recorded named',
                restartNotice({ conversation: 'none_recorded', title_carried: 'Media' }, t), 1],
            ['restart unknown', restartNotice({ conversation: 'unknown' }, t), 1],
            ['restart unknown named',
                restartNotice({ conversation: 'zzz', title_carried: 'Media' }, t), 1],
            ['restart row lost',
                restartNotice({ conversation: 'resumed', row_reused: false }, t), 1],
            ['restart row lost named',
                restartNotice({ conversation: 'resumed', row_reused: false, title_carried: 'Media' }, t), 1],
            ['restart unidentified', unidentifiedRestartNotice('', t), 1],
            ['restart unidentified named', unidentifiedRestartNotice('Media', t), 1],
            ['fork 409', forkFailureNotice({ status: 409 }, t), 1],
            ['fork failed', forkFailureNotice({ message: 'boom' }, t), 1],
            ['fork failed, no message', forkFailureNotice({}, t), 2],
            ['fork lineage', t(RECENT_KEYS.forkLineageUnrecorded), 1],
        ] as Array<[string, string, number]>;
    })();

    test.each(CASES)('%s is fully pseudo-localised', (_name, rendered) => {
        expect(isPseudo(rendered), rendered).toBe(true);
    });

    test.each(CASES)('%s is built from exactly the expected message count',
        (_name, rendered, expected) => {
            expect(pseudoCount(rendered), rendered).toBe(expected);
        });

    test('a clean resume still says NOTHING, in any locale', () => {
        // The one case that must NOT produce a sentence. A guard that
        // required every path to render copy would push a message into
        // the one place the design says stay quiet.
        expect(restartNotice({ conversation: 'resumed', row_reused: true }, pseudoT()))
            .toBeNull();
    });

    test('the counts still format inside the pseudo locale', () => {
        const t = pseudoT();
        expect(recentCountLabel(19, t)).toContain('19');
        expect(recentCountLabel(1234, t)).toContain('1,234');
    });

    test("a user's own title is NOT pseudo-localised, because it is data", () => {
        // The distinction the whole layer rests on: a catalog message is
        // translated, the value interpolated into it is the user's own
        // text and must survive verbatim.
        expect(unidentifiedRestartNotice('Media Compression', pseudoT()))
            .toContain('Media Compression');
    });

    test('every key this surface asks for exists in the catalog', () => {
        for (const key of Object.values(RECENT_KEYS)) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
    });
});

// ---- guard 1, applied to slice 4's surface ---------------------------

describe('the PROJECT TREE really reads the catalog too', () => {
    /**
     * A pseudo-locale translator over the derived pseudo catalog.
     *
     * Inputs: none. Output: `(key, params) => string`.
     */
    function pseudoT(): (k: string, p?: Record<string, unknown> | null) => string {
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        return (k, p) => i18n.t(k, p);
    }

    /**
     * Every sentence the tree can say, with HOW MANY catalog messages
     * each is built from.
     *
     * THE COUNT IS THE HALF `isPseudo` CANNOT SEE. A hardcoded fragment
     * interpolated INTO a message is wrapped by the outer message, so the
     * bracket span still balances and the sentence still looks
     * translated. It was MEASURED to pass the span check and fail this
     * one, which is why both exist. Every entry here is 1 because every
     * sentence is a WHOLE message with a hole in it, never an assembly:
     * a value of 2 would mean somebody re-fragmented one.
     */
    const CASES: Array<[string, string, number]> = (() => {
        const t = pseudoT();
        return [
            ['session count one', sessionCountLabel(1, t), 1],
            ['session count many', sessionCountLabel(19, t), 1],
            ['attention title one', attentionTitle(1, t), 1],
            ['attention title many', attentionTitle(3, t), 1],
            ['archived count', archivedNoticeText({ kind: 'count', count: 2 }, t) as string, 1],
            ['archived unknown', archivedNoticeText({ kind: 'unknown' }, t) as string, 1],
            ['authority unknown', authorityBannerText({ kind: 'unknown' }, t) as string, 1],
            ['presence missing', presenceBadgeText('missing', null, t) as string, 1],
            // TWO, and correctly so: the detail slot is filled by ANOTHER
            // catalog message when the server sent no reason. That is a
            // composition of two real messages, not a glued fragment.
            ['presence unreachable, no reason',
                presenceBadgeText('unreachable', null, t) as string, 2],
            ['no project group', t(PROJECT_TREE_KEYS.noProject), 1],
            ['attention head', t(PROJECT_TREE_KEYS.attentionHead), 1],
            ['toggle aria', t(PROJECT_TREE_KEYS.toggleAria, { name: 'api' }), 1],
            ['empty title', t(PROJECT_TREE_KEYS.emptyTitle), 1],
            ['empty hint', t(PROJECT_TREE_KEYS.emptyHint), 1],
            ['archived badge', t(PROJECT_TREE_KEYS.badgeArchived), 1],
            ['edit action', t(PROJECT_TREE_KEYS.actionEdit), 1],
            ['archive title', t(PROJECT_TREE_KEYS.actionArchiveTitle), 1],
            ['restore title', t(PROJECT_TREE_KEYS.actionRestoreTitle), 1],
            ['archived show', t(PROJECT_TREE_KEYS.archivedShow), 1],
            ['archived hide', t(PROJECT_TREE_KEYS.archivedHide), 1],
            ['badge tmux', t(PROJECT_TREE_KEYS.badgeTmux), 1],
            ['badge external', t(PROJECT_TREE_KEYS.badgeExternal), 1],
            ['badge ended', t(PROJECT_TREE_KEYS.badgeEnded), 1],
            ['project work unrecorded',
                workTitle(workAttrs(null, PROJECT_WORK_UNRECORDED_KEY), t) as string, 1],
            ['session work unrecorded',
                workTitle(workAttrs(null, SESSION_WORK_UNRECORDED_KEY), t) as string, 1],
            ['family unknown label', t(FAMILY_PILL_KEYS.unknownLabel), 1],
            ['family fact title',
                t(familyPillView('codex', 'wrapper').titleKey,
                    familyPillView('codex', 'wrapper').titleParams), 1],
            ['family guess title',
                t(familyPillView('claude', 'fingerprint').titleKey,
                    familyPillView('claude', 'fingerprint').titleParams), 1],
            ['family inferred title',
                t(familyPillView('claude', 'inferred_process').titleKey, {}), 1],
            ['family unknown title', t(familyPillView(null, null).titleKey, {}), 1],
        ] as Array<[string, string, number]>;
    })();

    test.each(CASES)('%s is fully pseudo-localised', (_name, rendered) => {
        expect(isPseudo(rendered), rendered).toBe(true);
    });

    test.each(CASES)('%s is built from exactly the expected message count',
        (_name, rendered, expected) => {
            expect(pseudoCount(rendered), rendered).toBe(expected);
        });

    test('ALL SEVEN attention reasons are catalog messages', () => {
        const t = pseudoT();
        for (const reasonKey of Object.values(ATTENTION_REASON)) {
            const rendered = attentionReason({ reasonKey }, t);
            expect(isPseudo(rendered), `${reasonKey} -> ${rendered}`).toBe(true);
            expect(pseudoCount(rendered), reasonKey).toBe(1);
        }
    });

    test("the SERVER's own detail is NOT translated, because it is data", () => {
        // The distinction the whole layer rests on. When the records
        // fetch fails the server says which read failed, and that
        // sentence arrives on the wire - it has no key and must survive
        // verbatim, exactly like a user's own session title.
        const rendered = attentionReason(
            { reasonKey: ATTENTION_REASON.listingUnreadable, detail: 'the server answered HTTP 500' },
            pseudoT(),
        );
        expect(rendered).toBe('the server answered HTTP 500');
        expect(isPseudo(rendered)).toBe(false);
    });

    test("and the SERVER's authority message is not translated either", () => {
        expect(authorityBannerText(
            { kind: 'degraded', mode: 'db_unreadable', writable: false, message: 'raw' },
            pseudoT(),
        )).toBe('raw');
    });

    test('the counts still format inside the pseudo locale', () => {
        const t = pseudoT();
        expect(sessionCountLabel(19, t)).toContain('19');
        expect(sessionCountLabel(1234, t)).toContain('1,234');
        expect(archivedNoticeText({ kind: 'count', count: 1234 }, t)).toContain('1,234');
    });

    test('a project NAME is NOT pseudo-localised, because it is the user\'s text', () => {
        expect(pseudoT()(PROJECT_TREE_KEYS.toggleAria, { name: 'My Project' }))
            .toContain('My Project');
    });

    test('the three cases that must say NOTHING still say nothing, in any locale', () => {
        // A guard that required every path to render copy would push a
        // message into the places the design says stay quiet.
        const t = pseudoT();
        expect(archivedNoticeText({ kind: 'silent' }, t)).toBeNull();
        expect(authorityBannerText({ kind: 'none' }, t)).toBeNull();
        expect(presenceBadgeText('unchecked', null, t)).toBeNull();
        expect(presenceBadgeText('present', null, t)).toBeNull();
        expect(workTitle(workAttrs('2026-09-01', PROJECT_WORK_UNRECORDED_KEY), t)).toBeNull();
    });

    test('every key this surface asks for exists in the catalog', () => {
        for (const key of Object.values(PROJECT_TREE_KEYS)) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
        for (const key of Object.values(FAMILY_PILL_KEYS)) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
        for (const key of Object.values(ATTENTION_REASON)) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
    });
});


// ---- guard 1, applied to slice 5's surface ---------------------------

describe('the RUNNING SESSIONS surface really reads the catalog too', () => {
    /**
     * A pseudo-locale translator over the derived pseudo catalog.
     *
     * Inputs: none. Output: `(key, params) => string`.
     */
    function pseudoT(): (k: string, p?: Record<string, unknown> | null) => string {
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        return (k, p) => i18n.t(k, p);
    }

    test('the heading count is fully pseudo-localised, in both outcomes', () => {
        const t = pseudoT();
        for (const n of [0, 1, 2, 19]) {
            const rendered = runningCountLabel(n, t);
            expect(isPseudo(rendered), `${n} -> ${rendered}`).toBe(true);
            expect(pseudoCount(rendered), `${n}`).toBe(1);
        }
        expect(isPseudo(runningCountUnavailableLabel(t))).toBe(true);
    });

    test('the count still formats, and a plural set is really being selected', () => {
        const t = pseudoT();
        expect(runningCountLabel(1234, t)).toContain('1,234');
        // The one-form and the other-form are DIFFERENT messages in the
        // pseudo catalog, so a ternary that happened to return the same
        // string for both would not be caught by the span check alone.
        expect(runningCountLabel(1, t)).not.toBe(runningCountLabel(2, t));
    });

    test('EVERY AGE BUCKET is a message, and the unknown one is its own', () => {
        // `${n}s ago` built by concatenation is untranslatable twice over:
        // the unit and the word order are both part of the sentence.
        const t = pseudoT();
        const now = 2_000_000_000_000;
        const at = (secondsAgo: number) => relativeAge(
            Math.floor(now / 1000) - secondsAgo, t, now,
        );
        for (const secondsAgo of [5, 90, 7200, 200000]) {
            const rendered = at(secondsAgo);
            expect(isPseudo(rendered), `${secondsAgo} -> ${rendered}`).toBe(true);
            expect(pseudoCount(rendered), `${secondsAgo}`).toBe(1);
        }
        // A MISSING EPOCH IS ITS OWN MESSAGE, never a zero.
        const unknown = relativeAge(null, t, now);
        expect(isPseudo(unknown)).toBe(true);
        expect(unknown).not.toContain('0');
    });

    test('the four age buckets say four different things', () => {
        // NEGATIVE CONTROL. Four keys that all resolved to one message
        // would pass every span check above.
        const t = pseudoT();
        const now = 2_000_000_000_000;
        const at = (s: number) => relativeAge(Math.floor(now / 1000) - s, t, now);
        const rendered = new Set([at(5), at(90), at(7200), at(200000)]);
        expect(rendered.size).toBe(4);
    });

    test('the attention detail wraps the SERVER text without translating it', () => {
        // The distinction the whole layer rests on: this app's own words
        // are messages, and the server's own sentence is DATA that has to
        // survive verbatim. The outer message is pseudo-localised, the
        // detail inside it is not.
        const t = pseudoT();
        const rendered = listingAttentionDetail(
            { ok: false, reason: 'http_503',
                detail: 'the server answered HTTP 503', sources: ['live'] },
            t,
        );
        expect(isPseudo(rendered), rendered).toBe(true);
        expect(rendered).toContain('the server answered HTTP 503');
        expect(rendered).toContain('http_503');
        // ONE message, because the detail, the source and the reason are
        // all data rather than copy.
        expect(pseudoCount(rendered)).toBe(1);
    });

    test('and BOTH of its fallbacks are messages, not literals', () => {
        // The count is what catches this: a hardcoded fragment passed as a
        // PARAMETER is wrapped by the outer message, so the span check
        // cannot see it. Two messages here, not one.
        const t = pseudoT();
        const rendered = listingAttentionDetail(
            { ok: false, reason: null, detail: null, sources: [] }, t,
        );
        expect(isPseudo(rendered), rendered).toBe(true);
        expect(pseudoCount(rendered)).toBe(3);
    });

    test('a failed row action names the action through the catalog', () => {
        const t = pseudoT();
        const rendered = rowActionFailed(t('session.action.close'), 'HTTP 500', t);
        expect(isPseudo(rendered), rendered).toBe(true);
        expect(pseudoCount(rendered)).toBe(2);
        expect(rendered).toContain('HTTP 500');
    });

    test('a session LABEL is NOT pseudo-localised, because it is the user\'s text', () => {
        expect(pseudoT()(RUNNING_SESSION_KEYS.wrapperTitle, { label: 'claude (chrome)' }))
            .toContain('claude (chrome)');
    });

    test('every key this surface asks for exists in the catalog', () => {
        for (const key of Object.values(RUNNING_SESSION_KEYS)) {
            expect(Object.prototype.hasOwnProperty.call(enCatalog, key), key).toBe(true);
        }
    });

    test('and the surface asks for more than a handful of them', () => {
        // A guard over an empty key set would pass forever.
        expect(Object.keys(RUNNING_SESSION_KEYS).length).toBeGreaterThanOrEqual(40);
    });
});

// ---- guard 1, applied to slice 6's surface ---------------------------

describe('the MODALS and the CREATE flows really read the catalog', () => {
    /** A pseudo-locale translator over the derived pseudo catalog. */
    function pseudoT(): (k: string, p?: Record<string, unknown> | null) => string {
        const i18n = createI18n({ locale: PSEUDO_LOCALE }) as I18nLike;
        return (k, p) => i18n.t(k, p);
    }

    /**
     * Every sentence this surface can say, with HOW MANY catalog
     * messages each is built from.
     *
     * ONE MESSAGE EACH, INCLUDING THE REFUSALS. The seven ways a project
     * name can be refused are seven WHOLE messages with a `{char}` or a
     * `{max}` hole, not one message with the rule glued in. That matters
     * more here than anywhere else on this screen: the refusal is the
     * only thing between a user and a folder they did not ask for, so it
     * has to be a sentence a translator can move as a sentence.
     */
    const CASES: Array<[string, string, number]> = (() => {
        const t = pseudoT();
        return [
            ['refused: required', nameRefusal(validateName(''), t), 1],
            ['refused: slash', nameRefusal(validateName('a/b'), t), 1],
            ['refused: backslash', nameRefusal(validateName('a\\b'), t), 1],
            ['refused: null byte',
                nameRefusal(validateName(`a${String.fromCharCode(0)}b`), t), 1],
            ['refused: control', nameRefusal(validateName('a\nb'), t), 1],
            ['refused: reserved', nameRefusal(validateName('..'), t), 1],
            ['refused: leading dot', nameRefusal(validateName('.hidden'), t), 1],
            ['refused: too long', nameRefusal(validateName('x'.repeat(300)), t), 1],
            ['folder step title', t(PROJECT_CREATE_KEYS.folderTitle), 1],
            ['folder step prompt', t(PROJECT_CREATE_KEYS.folderChoosePrompt), 1],
            ['folder step no default', t(PROJECT_CREATE_KEYS.folderParentUnavailable), 1],
            ['folder step no picker', t(PROJECT_CREATE_KEYS.folderPickerUnavailable), 1],
            ['new project menu', t(PROJECT_CREATE_KEYS.newProjectTitle), 1],
            ['new session cannot determine',
                t(PROJECT_CREATE_KEYS.newSessionCannotDetermine), 1],
            ['new session none', t(PROJECT_CREATE_KEYS.newSessionNone), 1],
            ['archive confirm', t(PROJECT_CREATE_KEYS.archiveMessage, { name: 'api' }), 1],
            ['archive details', t(PROJECT_CREATE_KEYS.archiveDetails), 1],
            ['archive failed',
                t(PROJECT_CREATE_KEYS.archiveFailed, { reason: 'boom' }), 1],
            ['create failed', t(PROJECT_CREATE_KEYS.createFailed, { reason: 'boom' }), 1],
            ['clone: auth', cloneFailure(new Error('gh auth login required'), t), 1],
            ['clone: not found', cloneFailure(new Error('repository not found'), t), 1],
            ['clone: exists', cloneFailure(new Error('already exists'), t), 1],
            ['clone: no gh', cloneFailure(new Error('gh cli not installed'), t), 1],
            ['clone: timeout', cloneFailure(new Error('timed out'), t), 1],
            ['clone: nothing said', cloneFailure(new Error(''), t), 1],
            ['THE THROWN SENTENCE',
                uniqueNameFailure({ cloudeKey: PROJECT_CREATE_KEYS.uniqueNameFailed }, t), 1],
        ] as Array<[string, string, number]>;
    })();

    test.each(CASES)('%s is fully pseudo-localised', (_name, rendered) => {
        expect(isPseudo(rendered), rendered).toBe(true);
    });

    test.each(CASES)('%s is built from exactly its own messages', (_name, rendered, count) => {
        expect(pseudoCount(rendered), rendered).toBe(count);
    });

    test('an ACCEPTED name says nothing at all', () => {
        // A validator that always found something to say would pass every
        // assertion above and refuse every project on the machine.
        expect(nameRefusal(validateName('Punchlist Test'), pseudoT())).toBe(null);
    });

    test("the SERVER's own detail is passed through verbatim, not translated", () => {
        // The clone mapper falls back to what the server said, because
        // this client has never seen that text and cannot have a key for
        // it. So it is deliberately NOT pseudo, and that is the rule
        // rather than a gap: `attentionReason` does the same thing for
        // the same reason.
        const t = pseudoT();
        expect(cloneFailure(new Error('HTTP 500: the disk is on fire'), t)).toBe(
            'the disk is on fire',
        );
    });

    test('a thrown error with no key keeps its own message', () => {
        // An error from the API is the server talking; only the error
        // this app throws itself carries a key.
        expect(uniqueNameFailure(new Error('disk is full'), pseudoT())).toBe('disk is full');
    });
});
