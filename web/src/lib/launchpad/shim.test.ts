/**
 * The shim carries exactly what the legacy tree still reaches for.
 *
 * THIS IS THE GUARD THAT MAKES DELETING `client/js/launchpad.js` SAFE.
 * Six slices moved who calls what, so the member list is DERIVED from
 * the tree rather than trusted: the test greps `client/js` for
 * `window.Launchpad.<member>` and requires the two sets to agree in BOTH
 * directions. A member the tree uses and the shim lacks is a TypeError
 * at whatever moment that screen is reached; a member the shim carries
 * and nothing uses is dead weight that makes the next person think the
 * migration is not finished.
 *
 * IT LOOKS THROUGH ALIASES NOW, AND IT HAS TO. The first version of
 * this scanner matched the literal `window.Launchpad.<member>` inside
 * `client/js` and nothing else, so it reported the shim COMPLETE while
 * three separate callers reached a member the shim did not carry:
 * `web/src/lib/launchpad/recent-actions.ts` (archive, fork and restart)
 * and `web/src/lib/launchpad/running-host.ts` both go through
 * `const lp = ...Launchpad`, and `client/js/session-row-menu-actions.js`
 * does the same. Every one of them degrades to `console.error` when the
 * member is absent, so the failure was silent in the app AND invisible
 * here. Measured in a real browser against the shipped bundle: a refused
 * archive produced a console line and ZERO cards.
 *
 * So the scanner resolves ALIASES to a fixpoint and scans the compiled
 * tree as well as the legacy one. `aliasedUseFinds` below is the
 * negative control that keeps it honest - it names the three real files
 * and fails if the resolver stops seeing them, because a resolver that
 * quietly matched nothing would make both directions pass vacuously
 * exactly the way the old one did.
 *
 * ONE MEMBER IS WRITTEN RATHER THAN READ. `client/js/providers.js`
 * ASSIGNS `showProviderModal` onto the object, so the grep has to see an
 * assignment as a use. It is also the reason the shim merges into what
 * is already on `window` instead of assigning a fresh object: the bundle
 * is a deferred module and providers.js, a classic script, got there
 * first.
 *
 * IT ALSO ASSERTS THE FILE IS GONE. A resurrected `launchpad.js` would
 * publish a second `window.Launchpad` and every assertion here would
 * still pass while the app ran on the wrong one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { SHIM_MEMBERS } from './shim';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** Every `.js` under `client/js`, recursively. */
function legacyFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...legacyFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * Every source file in the COMPILED tree that could reach the shim.
 *
 * Description: the compiled tree talks to `window.Launchpad` too - the
 *   shim is a seam, not a one-way door - so a scan that stopped at
 *   `client/js` could only ever see half the callers. Tests and the
 *   shim's own module are excluded: the shim names every member by
 *   definition, and a test naming one is not a caller.
 * Inputs: dir - directory to walk.
 * Output: absolute paths.
 */
function compiledFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { out.push(...compiledFiles(full)); continue; }
        if (entry.name.includes('.test.')) continue;
        if (entry.name === 'shim.ts') continue;
        if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Strip comments, so a file may NAME a member it no longer calls. */
function code(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/**
 * Every `window.Launchpad.<member>` the legacy tree reaches, with where.
 *
 * Description: a real read or write, never a mention in prose - the
 * comments are stripped first, which matters because several files
 * document members that moved slices ago.
 * Inputs: none. Output: member name to the files that use it.
 */
function legacyUses(): Map<string, string[]> {
    const uses = new Map<string, string[]>();
    const files = [
        ...legacyFiles(path.join(repoRoot, 'client', 'js')),
        ...compiledFiles(path.join(repoRoot, 'web', 'src')),
    ];
    for (const file of files) {
        const rel = path.relative(repoRoot, file);
        const src = code(fs.readFileSync(file, 'utf8'));
        for (const member of membersReachedIn(src)) {
            const seen = uses.get(member) ?? [];
            if (!seen.includes(rel)) seen.push(rel);
            uses.set(member, seen);
        }
    }
    return uses;
}

/**
 * Local names that stand for `window.Launchpad` in one file.
 *
 * Description: resolved to a FIXPOINT, because the real shapes are two
 *   hops deep. `recent-actions.ts` writes
 *   `const lp = (): LegacyLaunchpad => (window as ...).Launchpad || {}`
 *   and then `const target = lp()`, so `target` is an alias of an alias.
 *   One pass would see `lp` and stop, one pass short of the member that
 *   actually went missing.
 *
 *   Deliberately NOT a parser, and its rule is narrow on purpose: a
 *   declaration is an alias only when its right-hand side literally
 *   reads `.Launchpad`, or calls a name already known to be one. That
 *   dot is what keeps `LegacyLaunchpad` (a TYPE name, in every one of
 *   these files) from being mistaken for the object.
 *
 * STATED LIMIT: a FUNCTION that returns the shim is not followed.
 *   `project-tree-host.ts` has `function legacy() { ... return w.Launchpad }`
 *   and calls `legacy().selectProject`, which this does not see. It is
 *   recorded here rather than papered over; closing it needs a real
 *   parser, and the shapes above are the ones that hid a member.
 *
 * Inputs: src - file text, comments already stripped.
 * Output: the set of names standing for the shim, dotted literals first.
 */
function aliasesIn(src: string): Set<string> {
    const aliases = new Set<string>(['window.Launchpad', 'globalThis.Launchpad']);
    const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]{0,160})?=\s*([\s\S]{0,300}?);/g;
    for (let changed = true, guard = 0; changed && guard < 8; guard++) {
        changed = false;
        decl.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = decl.exec(src)) !== null) {
            const name = m[1] ?? '';
            const rhs = m[2] ?? '';
            if (!name || aliases.has(name)) continue;
            const direct = /\.Launchpad\b/.test(rhs);
            const viaAlias = [...aliases].some(
                (a) => !a.includes('.') && new RegExp(`\\b${a}\\s*\\(`).test(rhs),
            );
            if (direct || viaAlias) { aliases.add(name); changed = true; }
        }
    }
    return aliases;
}

/**
 * Every shim member one file reaches, through any alias.
 *
 * Inputs: src - file text, comments already stripped.
 * Output: member names.
 */
function membersReachedIn(src: string): Set<string> {
    const found = new Set<string>();
    for (const alias of aliasesIn(src)) {
        const base = alias.replace(/\./g, '\\.');
        // `lp.member`, `lp().member` and `lp()?.member` all count.
        const re = new RegExp(`\\b${base}\\s*(?:\\(\\s*\\))?\\??\\.([A-Za-z_][\\w]*)`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const member = m[1] ?? '';
            if (member) found.add(member);
        }
    }
    return found;
}

/**
 * Members the tree reaches that the shim deliberately does NOT carry.
 *
 * A NAMED GAP, NOT A SILENCED ONE. Each entry is a real call that
 * returns a degraded answer today, kept here so the guard stays loud
 * about everything else while these are visible rather than forgotten.
 */
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([
    [
        'loadSessionAttribution',
        'web/src/lib/launchpad/recent-actions.ts repaints the attribution card after '
        + 'an archive or a fork. Optional on its own interface and guarded with a '
        + 'typeof check, so it degrades to "no repaint" rather than throwing. The '
        + 'store already owns this data; wiring a forwarder is a migration decision, '
        + 'not a bug fix.',
    ],
    [
        'renderProjectList',
        'Same file, same shape: repaint the project tree after a recent-session '
        + 'action. Guarded and optional, degrades to "no repaint".',
    ],
    [
        'runningSessions',
        'Same file: the legacy array of live rows, read through a guard that answers '
        + '[] when it is absent. `sessionStore` is the live source now.',
    ],
    [
        '_formatRelativeTime',
        'web/src/lib/launchpad/attribution.ts asks the legacy singleton for the '
        + 'attribution card\'s age string and renders "unknown" without it. Its own '
        + 'comment says slice 5 moves the implementation into this tree; adding a '
        + 'forwarder here would just be a second place to look until it does.',
    ],
]);

describe('client/js/launchpad.js is gone', () => {
    test('the file does not exist', () => {
        expect(fs.existsSync(path.join(repoRoot, 'client/js/launchpad.js'))).toBe(false);
    });

    test('and client/index.html does not try to load it', () => {
        // A tag with no file behind it is a 404 the app would survive
        // and a `window.Launchpad` nobody notices is missing.
        const html = fs.readFileSync(path.join(repoRoot, 'client/index.html'), 'utf8');
        expect(html).not.toContain('src="/static/js/launchpad.js"');
    });

    test('nothing in client/js constructs a Launchpad of its own', () => {
        for (const file of legacyFiles(path.join(repoRoot, 'client', 'js'))) {
            expect(code(fs.readFileSync(file, 'utf8')), file).not.toMatch(
                /window\.Launchpad\s*=\s*new\b/,
            );
        }
    });
});

describe('the shim and its callers agree, in both directions', () => {
    test('every member the legacy tree uses is on the shim', () => {
        // THE MUTATION TARGET. Dropping a member from SHIM_MEMBERS, or
        // from the object `publishLaunchpadShim` builds, fails here and
        // names the file that would have broken.
        const uses = legacyUses();
        const missing = [...uses.keys()].filter(
            (member) => !SHIM_MEMBERS.includes(member) && !KNOWN_GAPS.has(member),
        );
        expect(
            missing,
            `these are reached in client/js and the shim does not carry them: ${JSON.stringify(
                [...uses.entries()].filter(([m]) => missing.includes(m)),
            )}`,
        ).toEqual([]);
    });

    test('and every member on the shim is actually reached', () => {
        const uses = legacyUses();
        const unused = SHIM_MEMBERS.filter((member) => !uses.has(member));
        expect(unused, `the shim carries members nothing uses: ${unused.join(', ')}`).toEqual([]);
    });

    test('the set is what slice 7 measured, not what the plan predicted', () => {
        // Named rather than counted, so a swap of two members cannot
        // pass. The plan listed twelve; six slices of movement plus the
        // three call sites this slice resolved leave these eight.
        expect([...SHIM_MEMBERS].sort()).toEqual([
            '_deriveRunningSessionDisplayName',
            'init',
            'launchpadScreen',
            'loadProjects',
            'loadRunningSessions',
            'openProjectByName',
            'selectProject',
            'sessionRecords',
            'showError',
            'showProviderModal',
        ]);
    });

    test('NEGATIVE CONTROL: the grep really does find a use', () => {
        // A scanner that found nothing would make both directions above
        // pass vacuously.
        const uses = legacyUses();
        expect(uses.get('openProjectByName')).toContain('client/js/router.js');
        expect(uses.get('init')).toContain('client/js/app.js');
        expect(uses.get('showProviderModal')).toContain('client/js/providers.js');
    });

    test('NEGATIVE CONTROL: the scanner really does see through an alias', () => {
        // The three callers the LITERAL scanner was blind to. If this
        // stops finding them the guard has gone back to reporting a
        // complete shim while a member is missing, which is exactly how
        // `showError` reached production absent.
        const uses = legacyUses();
        const seen = uses.get('showError') ?? [];
        expect(seen).toContain('web/src/lib/launchpad/recent-actions.ts');
        expect(seen).toContain('web/src/lib/launchpad/running-host.ts');
        expect(seen).toContain('client/js/session-row-menu-actions.js');
        // And the second member the same blindness hid: without it the
        // row menu's "new session in this folder" did nothing at all.
        expect(uses.get('selectProject') ?? []).toContain('client/js/session-row-menu-actions.js');
    });

    test('NEGATIVE CONTROL: an alias to something else is not an alias to the shim', () => {
        // A resolver that treated every local const as an alias would
        // find every member everywhere and pass vacuously.
        const decoy = 'const notTheShim = window.SomethingElse; notTheShim.totallyMadeUpMember();';
        expect([...membersReachedIn(decoy)]).not.toContain('totallyMadeUpMember');
    });
});

describe('the three call sites slice 6 left are resolved, not forwarded', () => {
    const read = (rel: string) => code(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

    test('providers.js escapes with its own helper', () => {
        const src = read('client/js/providers.js');
        expect(src).not.toContain('Launchpad._escapeHtml');
        expect(src).toContain('function escapeForMarkup');
    });

    test('providers.js confirms through App, which owned the modal all along', () => {
        const src = read('client/js/providers.js');
        expect(src).not.toContain('Launchpad.showConfirmModal');
        expect(src).toContain('window.App.showConfirmModal');
    });

    test('terminal-commands-panel.js creates a console through the bundle', () => {
        const src = read('client/js/terminal-commands-panel.js');
        expect(src).not.toContain('Launchpad.createConsoleSession');
        expect(src).toContain('window.CloudeWeb');
    });
});
