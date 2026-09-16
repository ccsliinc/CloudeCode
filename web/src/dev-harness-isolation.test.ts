/**
 * THE HARNESS'S CONTAINMENT, AS TESTS RATHER THAN AS PROMISES.
 *
 * `web/dev-harness/` is SCAFFOLDING: it mounts the real `NavRail` and
 * the real `TranscriptList` so a person can click them before the
 * application shell that will host them exists. Three claims are made
 * for it in issue #173's commitments and in the harness's own headers,
 * and a claim about a directory is worth what it can be measured
 * against.
 *
 *   1. Nothing under `web/src/` depends on it, so deleting the directory
 *      cannot break the shipped bundle.
 *   2. It introduces NO class name. Every rule it writes is a scoped
 *      ELEMENT selector, so nothing it styles can be a node rendered by
 *      the real components or reached by the twelve archive stylesheets.
 *   3. It uses no `:global(...)`, which is the one construct that would
 *      let a scoped rule escape its component and reach those nodes.
 *
 * IT LIVES UNDER `src/` BECAUSE THAT IS WHERE VITEST LOOKS, and its
 * filename says what it is about rather than which slice it sits beside.
 * The test reads the tree off disk on purpose: a test that imported the
 * harness would itself be the dependency claim 1 forbids.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `web/`, the root both trees hang off. */
const WEB = fileURLToPath(new URL('..', import.meta.url));

/** The scaffolding directory this file exists to fence in. */
const HARNESS = join(WEB, 'dev-harness');

/** The shipped source tree, which may not depend on the scaffolding. */
const SRC = join(WEB, 'src');

/**
 * Every file under a directory, recursively.
 *
 * Description: skips `node_modules` so a stray install cannot make the
 *   walk unbounded. Returns absolute paths.
 * Inputs: dir - an absolute directory path.
 * Output: string[] - absolute file paths.
 * Example: walk('/tmp/web/src')
 */
function walk(dir: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) found.push(...walk(full));
        else found.push(full);
    }
    return found;
}

/** The harness's own source files, the ones these rules are about. */
function harnessSources(): string[] {
    return walk(HARNESS).filter((f) => /\.(ts|svelte|html)$/.test(f));
}

/**
 * One file's CODE, with its comments removed.
 *
 * Description: THE RULES BELOW ARE ABOUT WHAT THE HARNESS COMPILES TO,
 *   NOT ABOUT WHAT ITS HEADERS SAY. Every one of those headers explains
 *   the rule it is subject to, and two of them quote the very construct
 *   being banned, so a scan of the raw text reports a file for
 *   documenting the rule it obeys. Block comments and HTML comments are
 *   stripped; line comments are left alone, because `//` also appears in
 *   a URL and a rule that has to be right cannot afford that ambiguity.
 * Inputs: file - an absolute path.
 * Output: the file's text with `/* ... *\/` and `<!-- ... -->` removed.
 */
function codeOf(file: string): string {
    return readFileSync(file, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('the dev preview harness is deletable scaffolding', () => {
    it('is imported by nothing under src/, so removing it breaks no build', () => {
        const offenders: string[] = [];
        for (const file of walk(SRC)) {
            if (!/\.(ts|svelte)$/.test(file)) continue;
            const text = readFileSync(file, 'utf8');
            // Any import that walks up out of `src/` and into the
            // harness. Matched on the PATH rather than on a symbol,
            // because the claim is about the directory.
            if (/from\s+['"][^'"]*dev-harness[^'"]*['"]/.test(text)
                || /import\s+['"][^'"]*dev-harness[^'"]*['"]/.test(text)) {
                // This file names the directory in prose and in a path
                // string, and is itself the test. It is not an import.
                if (relative(SRC, file) !== 'dev-harness-isolation.test.ts') {
                    offenders.push(relative(WEB, file));
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('has files to check, so a rename cannot make these rules vacuous', () => {
        // THE NEGATIVE CONTROL FOR THE TWO RULES BELOW. Both iterate the
        // harness's files and assert nothing was found; an empty list
        // would pass them both while measuring nothing at all.
        expect(harnessSources().length).toBeGreaterThan(5);
    });
});

describe('the harness cannot style the real components', () => {
    it('writes no class attribute, so it introduces no class name', () => {
        const offenders: string[] = [];
        for (const file of harnessSources()) {
            // `class=` on an element. The real components' own class
            // names arrive from inside those components; the harness
            // markup carries none of its own.
            if (/\sclass\s*=\s*["'{]/.test(codeOf(file))) {
                offenders.push(relative(WEB, file));
            }
        }
        expect(offenders).toEqual([]);
    });

    it('uses no :global(), so every rule stays inside its component', () => {
        const offenders: string[] = [];
        for (const file of harnessSources()) {
            if (codeOf(file).includes(':global(')) offenders.push(relative(WEB, file));
        }
        expect(offenders).toEqual([]);
    });

    it('ships no stylesheet of its own, so nothing it wrote is loadable elsewhere', () => {
        const stylesheets = walk(HARNESS).filter((f) => f.endsWith('.css'));
        expect(stylesheets.map((f) => relative(WEB, f))).toEqual([]);
    });
});
