/**
 * The folder picker this slice keeps, and the stylesheet contract it
 * shares with the modals that moved.
 *
 * PORTED FROM tests/test_folder_picker_modal.node.mjs and
 * tests/test_folder_picker_path_overflow.node.mjs, both deleted in the
 * same commit.
 *
 * `client/js/folder-picker-modal.js` IS NOT MIGRATED BY THIS SLICE and is
 * still a classic script. What changed around it is that its only caller
 * moved into the bundle and STOPPED INJECTING AN ESCAPER: it has carried
 * its own default since it was extracted from launchpad.js, and the
 * launchpad copy that used to be handed in is deleted. So the assertions
 * here are the shape of the module, the fact that nothing has grown a
 * second copy of it, and the load order that keeps it reachable.
 *
 * THE CSS HALF IS NOT ABOUT THE PICKER ALONE. `.folder-picker-path` is
 * shared by two very different elements: the editable address bar inside
 * the picker, and the read-only `<div>` that the project modals use to
 * show a full path - which after this slice is
 * `ProjectFolderModal.svelte`'s preview and `ProjectNameModal.svelte`'s
 * folder hint. A path has no spaces for the browser to break on, so
 * without an explicit wrap a long iCloud path runs straight out of the
 * box and is silently clipped. That box is where a user reads the folder
 * their project is about to be created in, which is the whole point of
 * the folder step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** Read a file from the repo. */
function repoFile(...parts: string[]): string {
    return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

/** Strip comment lines so prose about code is not read as code. */
function codeOnly(src: string): string {
    return src
        .split('\n')
        .filter((line) => {
            const s = line.trim();
            return !s.startsWith('*') && !s.startsWith('//') && !s.startsWith('/*');
        })
        .join('\n');
}

describe('the extracted picker is still one module with one entry point', () => {
    const source = repoFile('client', 'js', 'folder-picker-modal.js');

    test('it publishes exactly the one entry point it promises', () => {
        expect(source).toMatch(/window\.FolderPickerModal\s*=/);
        expect(codeOnly(source)).toMatch(/open\s*[:(]/);
    });

    test('it reaches for no controller state', () => {
        // A `this` here would mean it had grown a hidden dependency on
        // whatever calls it, which is the coupling the extraction removed.
        expect(/\bthis\./.test(codeOnly(source))).toBe(false);
    });

    test('it carries its own escaper, so a caller need not inject one', () => {
        // SLICE 6's CHANGE. The launchpad delegate used to pass
        // `escapeHtml`; nothing passes one now, so the default has to be
        // real rather than a fallback nobody exercises.
        expect(codeOnly(source)).toMatch(/defaultEscapeHtml/);
    });

    test('nothing in the compiled tree keeps a second copy of the picker', () => {
        // The extraction is only worth anything while there is one of it.
        const host = repoFile('web', 'src', 'lib', 'launchpad', 'create-host.ts');
        expect(host).toMatch(/FolderPickerModal/);
        for (const file of ['ProjectFolderModal.svelte', 'open-folder-flow.ts']) {
            const src = repoFile('web', 'src', 'lib', 'launchpad', file);
            expect(src, file).not.toMatch(/folder-picker-toolbar/);
        }
    });

    test('the compiled tree opens it WITHOUT injecting an escaper', () => {
        const host = codeOnly(repoFile('web', 'src', 'lib', 'launchpad', 'create-host.ts'));
        expect(host).toMatch(/picker\.open\(\)/);
        expect(host).not.toMatch(/escapeHtml/);
    });

    test('launchpad.js no longer mentions it at all', () => {
        // Its delegate, `showFolderPickerModal`, moved with the flow.
        expect(codeOnly(repoFile('client', 'js', 'launchpad.js'))).not.toMatch(
            /FolderPickerModal/,
        );
    });

    test('the index page still loads it, and before the bundle', () => {
        const html = repoFile('client', 'index.html');
        const picker = html.indexOf('/static/js/folder-picker-modal.js');
        const bundle = html.indexOf('/static/dist/app.js');
        expect(picker, 'folder-picker-modal.js is never loaded at all').not.toBe(-1);
        expect(bundle, 'the bundle is never loaded at all').not.toBe(-1);
        expect(picker).toBeLessThan(bundle);
    });

    test('project-create-folder.js is gone, and nothing still loads it', () => {
        // Slice 6 deleted it: its rules are project-folder.ts and its
        // modal is ProjectFolderModal.svelte.
        expect(fs.existsSync(path.join(repoRoot, 'client/js/project-create-folder.js'))).toBe(
            false,
        );
        expect(repoFile('client', 'index.html')).not.toMatch(
            /<script[^>]*project-create-folder\.js/,
        );
    });
});

// ---- the stylesheet contract ----------------------------------------

/** One flat CSS rule. */
interface Rule {
    selector: string;
    body: string;
}

/**
 * Split a stylesheet into flat rules, comments stripped first.
 *
 * Description: deliberately NOT a real parser - these are flat,
 *   hand-written sheets, and a selector quoted in prose must not read as
 *   a live rule, which is what stripping comments first buys.
 * Inputs: source (string) - CSS text.
 * Output: Rule[].
 * Example: rules('.a { color: red; }')[0]!.selector  // '.a'
 */
function rules(source: string): Rule[] {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Rule[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
        const selector = m[1]!.trim().replace(/\s+/g, ' ');
        if (!selector || selector.startsWith('@')) continue;
        out.push({ selector, body: m[2] ?? '' });
    }
    return out;
}

/** Every rule whose selector list contains exactly `wanted`. */
function bySelector(ruleList: Rule[], wanted: string): Rule[] {
    return ruleList.filter((r) => r.selector.split(',').some((s) => s.trim() === wanted));
}

/** One longhand declaration out of a rule body, or null. */
function decl(body: string, prop: string): string | null {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
    return m ? m[1]!.trim() : null;
}

describe('a full path wraps rather than overrunning its box', () => {
    const styleRules = rules(repoFile('client', 'css', 'styles.css'));

    test('.folder-picker-path wraps', () => {
        const hits = bySelector(styleRules, '.folder-picker-path');
        expect(hits, 'expected exactly one `.folder-picker-path` base rule').toHaveLength(1);
        expect(decl(hits[0]!.body, 'word-break')).toBe('break-all');
        expect(decl(hits[0]!.body, 'overflow-wrap')).toBeTruthy();
    });

    test('it matches .folder-picker-status wrap treatment', () => {
        const pathRule = bySelector(styleRules, '.folder-picker-path')[0]!;
        const status = bySelector(styleRules, '.folder-picker-status')[0]!;
        expect(status, '.folder-picker-status rule not found').toBeTruthy();
        expect(decl(pathRule.body, 'word-break')).toBe(decl(status.body, 'word-break'));
    });

    test('the dead :focus and ::placeholder rules on it are gone', () => {
        // They were only ever meaningful on the `<input>` usage, which
        // carries `.modal-input` alongside and gets them from there.
        expect(bySelector(styleRules, '.folder-picker-path:focus')).toEqual([]);
        expect(bySelector(styleRules, '.folder-picker-path::placeholder')).toEqual([]);
    });

    test('.modal-input still supplies real :focus and ::placeholder styling', () => {
        const focus = bySelector(styleRules, '.modal-input:focus');
        const placeholder = bySelector(styleRules, '.modal-input::placeholder');
        expect(focus.length, '.modal-input:focus rule not found').toBeGreaterThan(0);
        expect(placeholder.length, '.modal-input::placeholder rule not found').toBeGreaterThan(0);
        expect(decl(focus[0]!.body, 'box-shadow')).toBeTruthy();
        expect(decl(placeholder[0]!.body, 'color')).toBeTruthy();
    });
});
