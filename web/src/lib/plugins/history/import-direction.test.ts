/**
 * `history/` IS A LEAF, AND THIS IS WHAT SAYS SO.
 *
 * WHY IT IS WRITTEN NOW AND NOT LATER. Section 10.5 of
 * `docs/history-archive-scope.md` calls this "the single highest-value
 * item" on its free-now list, and the reason is about timing rather than
 * value: during a rewrite this costs one file, and afterwards it is near
 * impossible, because by then there are violations and each one is an
 * argument. There are none today. This is the cheapest minute in the
 * whole nine-slice plan.
 *
 * THE ARROW IT PINS, in one sentence: the module may depend on the
 * host's published seams, and the host may depend only on the `Plugin`
 * object. Concretely, two rules.
 *
 *   OUTSIDE-IN. Nothing outside `plugins/history/` may import a path
 *   INSIDE it. `plugins/history/index` and `plugins/history` are the one
 *   permitted target, because that file IS the public shape: the id, the
 *   contributions, the routePrefix and the apiPrefixes. The moment
 *   something outside imports `history/route` or a future
 *   `history/reader/VirtualList.svelte`, the boundary is gone and nobody
 *   notices until the next port.
 *
 *   INSIDE-OUT. Nothing inside may import from `launchpad/`, `sessions/`
 *   or `terminal-search/`. A feature that reaches sideways into another
 *   feature is not extractable, and section 10 wants this directory
 *   liftable some day.
 *
 * IT READS THE SOURCE RATHER THAN THE MODULE GRAPH, deliberately. A
 * runtime check can only see what a test happened to import, so a
 * violation in a module nothing pulled in would pass. Reading every file
 * on disk cannot miss one, and it catches a type-only import, which
 * erases at build time and is still a dependency in every sense that
 * matters to an extraction.
 *
 * EVERY RULE CARRIES A POSITIVE CONTROL. A scanner that found no files,
 * or a matcher that matched no imports, would report a clean tree
 * forever. The controls below assert that the scan actually saw the
 * files and actually parsed the imports it is judging.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `web/src`. */
const SRC = fileURLToPath(new URL('../../..', import.meta.url));

/** Absolute path to `web/src/lib/plugins/history`. */
const HISTORY = fileURLToPath(new URL('.', import.meta.url));

/** Directories inside `web/src/lib` this module may not reach into. */
const SIBLING_FEATURES: readonly string[] = ['launchpad', 'sessions', 'terminal-search'];

/** Every source file under a directory, recursively, as absolute paths. */
function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { out.push(...filesUnder(full)); continue; }
        if (/\.(ts|svelte|js)$/.test(name)) out.push(full);
    }
    return out;
}

/**
 * Every module specifier a file imports or re-exports.
 *
 * Description: matches `import ... from 'x'`, `export ... from 'x'`,
 *   bare `import 'x'`, dynamic `import('x')` and `import type ... from
 *   'x'`. A TYPE-ONLY import counts: it erases at build time and is
 *   still a dependency for anyone lifting this directory out.
 * Inputs: source - the file's text.
 * Output: the specifiers, in source order.
 */
function specifiersIn(source: string): string[] {
    const out: string[] = [];
    const patterns = [
        /(?:^|\n)\s*(?:import|export)\s[^;\n]*?\sfrom\s*['"]([^'"]+)['"]/g,
        /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const rx of patterns) {
        let m: RegExpExecArray | null;
        while ((m = rx.exec(source)) !== null) out.push(m[1] as string);
    }
    return out;
}

/**
 * The file's text with block and line comments removed.
 *
 * Description: THE GLOBAL SCAN BELOW READS CODE, NOT PROSE, AND THIS IS
 *   WHY. Its first run failed on `availability.ts` and `crumb-resolve.ts`,
 *   both of which SAY the words "window.API" in a header paragraph
 *   explaining that the port stopped reaching for it. A rule about what
 *   the code does must not be satisfiable or breakable by what a comment
 *   says about it - and the direction of that first failure is the
 *   instructive one: the test was wrong and the code was right, which is
 *   the pair a matcher this blunt will keep producing until it reads
 *   only what runs.
 * Inputs: source - the file's text. Output: the same text with comments
 *   blanked, line structure preserved.
 */
function withoutComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Does a relative specifier from `file` land inside `history/`? */
function pointsIntoHistory(file: string, spec: string): boolean {
    if (!spec.startsWith('.')) return false;
    const resolved = join(file, '..', spec);
    return resolved.startsWith(HISTORY);
}

/** Is that specifier the one permitted target, `history/index`? */
function isPublicShape(file: string, spec: string): boolean {
    const resolved = join(file, '..', spec);
    return resolved === join(HISTORY, 'index')
        || resolved === join(HISTORY, 'index.ts')
        || resolved === HISTORY.replace(/\/$/, '');
}

describe('OUTSIDE-IN: nothing outside history/ imports a path inside it', () => {
    /** Every file under web/src that is NOT inside history/. */
    const outside = filesUnder(SRC).filter((f) => !f.startsWith(HISTORY));

    test('POSITIVE CONTROL: the scan actually found the tree', () => {
        // Without this, every assertion below passes for a scanner that
        // found nothing. These are floors, not exact counts, so adding a
        // file does not fail the suite.
        expect(outside.length, 'the scan found no files outside history/')
            .toBeGreaterThan(50);
        expect(outside.some((f) => f.endsWith('/builtin.ts'))).toBe(true);
        expect(outside.some((f) => f.endsWith('/main.ts'))).toBe(true);
    });

    test('POSITIVE CONTROL: something outside DOES import the public shape', () => {
        // The rule below is vacuous if nothing outside imports history/
        // at all. `builtin.ts` must, or the plugin does not ship.
        const importers = outside.filter((f) =>
            specifiersIn(readFileSync(f, 'utf8'))
                .some((s) => pointsIntoHistory(f, s)));
        expect(importers.length,
               'nothing outside imports history/, so this rule proves nothing')
            .toBeGreaterThan(0);
        expect(importers.some((f) => f.endsWith('/builtin.ts'))).toBe(true);
    });

    test('the only permitted target is history/index', () => {
        const violations: string[] = [];
        for (const file of outside) {
            for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
                if (!pointsIntoHistory(file, spec)) continue;
                if (isPublicShape(file, spec)) continue;
                violations.push(`${relative(SRC, file)} imports "${spec}"`);
            }
        }
        expect(violations,
               'history/ has one public shape: its Plugin object. Import '
               + 'plugins/history/index, or publish what you need from it.')
            .toEqual([]);
    });
});

describe('INSIDE-OUT: history/ reaches no sibling feature', () => {
    const inside = filesUnder(HISTORY);

    test('POSITIVE CONTROL: the scan actually found history/, and its imports', () => {
        expect(inside.length).toBeGreaterThan(3);
        const specs = inside.flatMap((f) => specifiersIn(readFileSync(f, 'utf8')));
        // A matcher that parsed no imports would report a clean tree
        // forever, so assert it parsed some, including a real one.
        expect(specs.length).toBeGreaterThan(5);
        expect(specs).toContain('../types');
    });

    test('no file inside imports launchpad/, sessions/ or terminal-search/', () => {
        const violations: string[] = [];
        for (const file of inside) {
            for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
                const resolved = spec.startsWith('.')
                    ? join(file, '..', spec) : spec;
                for (const feature of SIBLING_FEATURES) {
                    const asPath = join(SRC, 'lib', feature);
                    const hit = resolved.startsWith(asPath + '/')
                        || resolved === asPath
                        || spec.includes(`lib/${feature}/`);
                    if (hit) violations.push(`${relative(SRC, file)} imports "${spec}"`);
                }
            }
        }
        expect(violations,
               'a feature that reaches sideways into another feature is not '
               + 'extractable. Take what you need through PluginContext or '
               + 'the granted client.')
            .toEqual([]);
    });

    test('no file inside reaches a host global instead of an injected seam', () => {
        // Item 3 of the scope's free-now list: any host reach goes
        // through the PluginContext or the granted client, never
        // `window`. `window` appears once, in route.ts's `syncUrl`,
        // which takes an injected window and falls back to the real one
        // ONLY when a caller passed none - the same shape the vanilla
        // module had. Anything reaching a NAMED app global is the
        // violation this catches.
        const banned = ['window.App', 'window.API', 'window.Router',
                        'window.Launchpad', 'window.ArchiveScreen',
                        'globalThis.App', 'globalThis.API'];
        const violations: string[] = [];
        for (const file of inside) {
            if (file.endsWith('.test.ts')) continue;
            const source = withoutComments(readFileSync(file, 'utf8'));
            for (const name of banned) {
                if (source.includes(name)) {
                    violations.push(`${relative(SRC, file)} reaches ${name}`);
                }
            }
        }
        expect(violations,
               'the host is injected, not reached for. See history-host.ts, '
               + 'which lives OUTSIDE this directory for exactly this reason.')
            .toEqual([]);
    });
});
