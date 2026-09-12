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
 * The balanced `{...}` body belonging to a binding at `from`.
 *
 * Description: A FIXED CHARACTER WINDOW WAS TRIED FIRST AND IT WAS
 *   WRONG, loudly enough to be worth recording. 600 characters starting
 *   at `function win` runs straight past that function's body and into
 *   the `function legacy` beneath it, whose return DOES read
 *   `.Launchpad` - so `win` was registered as an alias and the scan then
 *   reported members literally named `Launchpad`, `CloudeWeb` and
 *   `launchpad`. An over-matching resolver is the same failure as a
 *   blind one wearing the opposite face.
 *
 *   So the body is BRACE MATCHED. Candidate opening braces are tried in
 *   order and the first balanced block containing a `return` is the
 *   body, which steps over an object TYPE in the signature
 *   (`function f(o: { a: number })`) rather than mistaking it for the
 *   body. Braces inside strings and template literals are not tracked;
 *   that is a stated limit, and it can only ever end the body EARLY,
 *   which drops an alias rather than inventing one.
 * Inputs: src - file text. from - index of the binding's match.
 * Output: the body text, or '' when none balances.
 * Example: bodyAt('function f() { return 1; }', 0)  // '{ return 1; }'
 */
function bodyAt(src: string, from: number): string {
    let search = from;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const open = src.indexOf('{', search);
        if (open === -1) return '';
        let depth = 0;
        for (let i = open; i < src.length; i += 1) {
            const ch = src[i];
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    const block = src.slice(open, i + 1);
                    if (/\breturn\b/.test(block)) return block;
                    search = i + 1;
                    break;
                }
            }
        }
        if (depth !== 0) return '';
    }
    return '';
}

/**
 * Does this function body hand its caller the shim.
 *
 * Description: keyed on the RETURN EXPRESSION, never on the body as a
 *   whole, and that is the whole precision of it. `running-host.ts` has
 *   `function legacy(): LegacyWindow { return hostWindow() ... }` which
 *   returns the WINDOW and is reached as `legacy().Launchpad.showError`;
 *   treating it as an alias would report a member literally named
 *   `Launchpad`. `project-tree-host.ts` has
 *   `function legacy() { ... return (w && w.Launchpad) || null; }` which
 *   returns the shim itself. Only the second reads `.Launchpad` INSIDE a
 *   return, so only the second is an alias.
 * Inputs: body - the balanced function body.
 *   aliases - names already known to stand for the shim.
 * Output: true when a return expression yields the shim.
 * Example: returnsTheShim('{ return w.Launchpad || null; }', new Set())
 */
function returnsTheShim(body: string, aliases: ReadonlySet<string>): boolean {
    const ret = /\breturn\b([^;]{0,300})/g;
    let m: RegExpExecArray | null;
    while ((m = ret.exec(body)) !== null) {
        const expr = m[1] ?? '';
        if (/\.Launchpad\b/.test(expr)) return true;
        for (const a of aliases) {
            if (a.includes('.')) continue;
            if (new RegExp(`\\b${a}\\s*\\(`).test(expr)) return true;
        }
    }
    return false;
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
 * A FUNCTION THAT RETURNS THE SHIM IS NOW FOLLOWED, AND CLOSING THAT
 *   FOUND A REAL DEFECT THE SAME HOUR. This resolver used to stop at
 *   declarations, and recorded the gap in prose: "a FUNCTION that returns
 *   the shim is not followed. `project-tree-host.ts` has
 *   `function legacy() { ... return w.Launchpad }` and calls
 *   `legacy().selectProject`, which this does not see." That file also
 *   calls `legacy()._explainRefusedProject`, which NOTHING implements -
 *   not `launchpad.js`, which is deleted, and not the shim. So clicking a
 *   REFUSED project row logged a line and explained nothing on screen,
 *   and the guard reported the shim complete throughout. It is the same
 *   defect `running-host.ts` documents for the two methods it already
 *   rewired, one file over.
 *
 *   A FUNCTION BINDING IS MATCHED, NOT A CALL. `function name`,
 *   `const name = function` and `const name = (...) =>` all bind, and the
 *   `return` scan above decides. The arrow-with-expression-body form is
 *   already caught by the declaration rule, because its right-hand side
 *   IS the expression.
 *
 * STATED LIMIT, AND IT CANNOT BE CLOSED BY A MATCHER. Computed access
 *   (`lp[name]`, `lp['showError']`) is not resolved. For a literal key it
 *   could be; for a VARIABLE key no static rule can be, because the name
 *   is not in the file. Rather than close half of it and read as closed,
 *   neither half is claimed - and the measurement that makes that
 *   acceptable is that the codebase contains ZERO bracket accesses on the
 *   shim today. `noComputedShimAccess` below is the test that keeps that
 *   true, which is a stronger guarantee than a resolver: it refuses the
 *   form outright instead of chasing it.
 *
 * Inputs: src - file text, comments already stripped.
 * Output: the set of names standing for the shim, dotted literals first.
 */
function aliasesIn(src: string): Set<string> {
    const aliases = new Set<string>(['window.Launchpad', 'globalThis.Launchpad']);
    const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]{0,160})?=\s*([\s\S]{0,300}?);/g;
    const fn = new RegExp(
        '(?:function\\s+([A-Za-z_$][\\w$]*)'
        + '|(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]{0,160})?=\\s*'
        + '(?:async\\s*)?(?:function\\b|\\([^)]{0,160}\\)\\s*(?::[^=>;]{0,160})?=>\\s*\\{))',
        'g',
    );
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
        fn.lastIndex = 0;
        while ((m = fn.exec(src)) !== null) {
            const name = m[1] || m[2] || '';
            if (!name || aliases.has(name)) continue;
            const body = bodyAt(src, m.index + (m[0] ?? '').length);
            if (returnsTheShim(body, aliases)) { aliases.add(name); changed = true; }
        }
    }
    return aliases;
}

/**
 * Every shim member one file reaches by DESTRUCTURING it.
 *
 * Description: `const { showError } = window.Launchpad` reaches
 *   `showError` just as surely as `lp.showError` does, and the dotted
 *   matcher cannot see it. There is no such call in this codebase today -
 *   measured, zero - so this is written for the one somebody adds next,
 *   which is precisely the case a guard exists to catch. The KEY is what
 *   counts: `{ showError: report }` reaches `showError`, and `{ a = 1 }`
 *   reaches `a`.
 * Inputs: src - file text, comments stripped. aliases - from `aliasesIn`.
 * Output: member names.
 * Example: destructuredMembersIn('const {showError} = window.Launchpad;', a)
 */
function destructuredMembersIn(src: string, aliases: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();
    const re = /(?:const|let|var)\s*\{([^}]{1,300})\}\s*(?::[^=;]{0,160})?=\s*([^;]{0,300});/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const keys = m[1] ?? '';
        const rhs = m[2] ?? '';
        const direct = /\.Launchpad\b/.test(rhs);
        const viaAlias = [...aliases].some(
            (a) => !a.includes('.') && new RegExp(`\\b${a}\\b`).test(rhs),
        );
        if (!direct && !viaAlias) continue;
        for (const part of keys.split(',')) {
            const key = part.split(':')[0]?.split('=')[0]?.trim() ?? '';
            if (/^[A-Za-z_$][\w$]*$/.test(key)) found.add(key);
        }
    }
    return found;
}

/**
 * Every shim member one file reaches, through any alias.
 *
 * Inputs: src - file text, comments already stripped.
 * Output: member names.
 */
function membersReachedIn(src: string): Set<string> {
    const found = new Set<string>();
    const aliases = aliasesIn(src);
    for (const alias of aliases) {
        const base = alias.replace(/\./g, '\\.');
        // `lp.member`, `lp().member` and `lp()?.member` all count.
        const re = new RegExp(`\\b${base}\\s*(?:\\(\\s*\\))?\\??\\.([A-Za-z_][\\w]*)`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const member = m[1] ?? '';
            if (member) found.add(member);
        }
    }
    for (const member of destructuredMembersIn(src, aliases)) found.add(member);
    return found;
}

/**
 * Members the tree reaches that the shim deliberately does NOT carry.
 *
 * A NAMED GAP, NOT A SILENCED ONE. Each entry would be a real call that
 * returns a degraded answer today, kept here so the guard stays loud
 * about everything else while these are visible rather than forgotten.
 *
 * IT IS EMPTY, AND KEEPING IT EMPTY IS THE POINT. It held four, and all
 * four are now resolved AT THE CALLER rather than forwarded: none of
 * them became a shim member, because in every case the tree had already
 * grown the real thing and the caller was simply still pointed at the
 * retired global.
 *
 *   - `_formatRelativeTime` -> `relativeAge`, slice 5's four translated
 *     messages plus a refusal. The entry claimed slice 5 "moves the
 *     implementation into this tree" as future work; slice 5 had already
 *     landed it, so the note was waiting for something that had arrived.
 *   - `loadSessionAttribution` -> `CloudeWeb.launchpad`, which `main.ts`
 *     publishes for this exact caller.
 *   - `runningSessions` -> `CloudeWeb.launchpad.sessions`. The entry
 *     read this as a tidy degrade to `[]`; it is not. `visibleRecentRows`
 *     short-circuits on an empty live list, so `[]` disabled the
 *     de-duplication and painted running sessions twice.
 *   - `renderProjectList` -> DELETED at the caller. The tree is a
 *     `$derived` now, so the imperative repaint is retired rather than
 *     missing.
 *
 * ADDING AN ENTRY HERE IS A REAL DECISION AND COSTS THE USER SOMETHING.
 * Three of the four above were recorded as harmless and two were not.
 * If you add one, say what the user sees, not what the code does.
 */
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([]);

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

/**
 * Every alias in a file that is reached with a COMPUTED key.
 *
 * Description: the one form the resolver cannot follow, so it is
 *   REFUSED rather than chased. `lp['showError']` could be read; `lp[k]`
 *   cannot, because `k` is not in the file, and a resolver that closed
 *   only the literal half would report itself complete while the other
 *   half walked past it. Measured: zero such accesses exist today, so
 *   refusing the form costs nothing and keeps the scanner's claim honest.
 * Inputs: src - file text, comments stripped.
 * Output: the alias names reached with a bracket.
 */
function computedAccessIn(src: string): string[] {
    const hits: string[] = [];
    for (const alias of aliasesIn(src)) {
        const base = alias.replace(/\./g, '\\.');
        const re = new RegExp(`\\b${base}\\s*(?:\\(\\s*\\))?\\??\\[`);
        if (re.test(src)) hits.push(alias);
    }
    return hits;
}

describe('the scanner resolves what callers actually write', () => {
    test('NEGATIVE CONTROL: a function that RETURNS the shim is followed', () => {
        // THE BLIND SPOT THAT HID A REAL DEFECT. Until this was closed
        // the resolver stopped at declarations, and `project-tree-host.ts`
        // reaches the shim through `function legacy()`. It calls
        // `legacy()._explainRefusedProject`, which nothing implements, so
        // clicking a refused project row explained nothing - and the
        // guard reported the shim complete the whole time. Asserted on a
        // fixture rather than on that file, so this keeps testing the
        // RESOLVER after the caller is fixed.
        const src = [
            'function legacy() {',
            '    const w = win();',
            '    return (w && w.Launchpad) || null;',
            '}',
            'legacy().someMember();',
        ].join('\n');
        expect([...membersReachedIn(src)]).toContain('someMember');
    });

    test('NEGATIVE CONTROL: a function returning the WINDOW is not the shim', () => {
        // THE OVER-MATCH THAT WAS ACTUALLY HIT while closing the above. A
        // fixed character window starting at one function ran into the
        // NEXT function's body, so `running-host.ts`'s `legacy()` - which
        // returns the WINDOW and is read as `legacy().Launchpad.showError`
        // - registered as an alias and the scan reported members called
        // `Launchpad`, `CloudeWeb` and `launchpad`. An over-matching guard
        // is the same failure as a blind one, wearing the other face.
        const src = [
            'function win() {',
            '    return globalThis;',
            '}',
            'function legacy() {',
            '    const w = win();',
            '    return (w && w.Launchpad) || null;',
            '}',
            'win().notAShimMember();',
        ].join('\n');
        const found = [...membersReachedIn(src)];
        expect(found).not.toContain('notAShimMember');
        expect(found).not.toContain('Launchpad');
    });

    test('NEGATIVE CONTROL: a DESTRUCTURED member is reached', () => {
        // No caller writes this today - measured, zero - so this is
        // written for the one somebody adds next, which is exactly the
        // case a guard exists to catch rather than to discover later.
        const src = 'const { showError, selectProject } = window.Launchpad;';
        const found = [...membersReachedIn(src)];
        expect(found).toContain('showError');
        expect(found).toContain('selectProject');
    });

    test('a destructure of something else is not a destructure of the shim', () => {
        const src = 'const { totallyMadeUpMember } = window.SomethingElse;';
        expect([...membersReachedIn(src)]).not.toContain('totallyMadeUpMember');
    });

    test('NOBODY reaches the shim with a computed key, which is the form the scanner refuses', () => {
        // THE STATED LIMIT, ENFORCED RATHER THAN DOCUMENTED. `lp[k]`
        // cannot be resolved by any static rule, because `k` is not in the
        // file. So instead of pretending to follow it, the form is banned
        // while it is still unused: a member reached this way would be
        // invisible to every assertion above, which is precisely the
        // "green while measuring nothing" this guard exists to prevent.
        const offenders: string[] = [];
        const files = [
            ...legacyFiles(path.join(repoRoot, 'client', 'js')),
            ...compiledFiles(path.join(repoRoot, 'web', 'src')),
        ];
        for (const file of files) {
            const src = code(fs.readFileSync(file, 'utf8'));
            for (const alias of computedAccessIn(src)) {
                offenders.push(`${path.relative(repoRoot, file)} via ${alias}`);
            }
        }
        expect(
            offenders,
            'computed access on the shim cannot be scanned; reach the member by name',
        ).toEqual([]);
    });

    test('NEGATIVE CONTROL: the computed-access detector really does detect', () => {
        // Without this, the test above passes whether the detector works
        // or is a function that returns an empty array.
        expect(computedAccessIn("const lp = window.Launchpad; lp['showError']();"))
            .toContain('lp');
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
