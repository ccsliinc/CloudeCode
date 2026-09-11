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
    for (const file of legacyFiles(path.join(repoRoot, 'client', 'js'))) {
        const rel = path.relative(repoRoot, file);
        const src = code(fs.readFileSync(file, 'utf8'));
        const re = /window\.Launchpad\.([A-Za-z_][A-Za-z0-9_]*)/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(src)) !== null) {
            const member = match[1] ?? '';
            if (!member) continue;
            const seen = uses.get(member) ?? [];
            if (!seen.includes(rel)) seen.push(rel);
            uses.set(member, seen);
        }
    }
    return uses;
}

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
        const missing = [...uses.keys()].filter((member) => !SHIM_MEMBERS.includes(member));
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
            'sessionRecords',
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
