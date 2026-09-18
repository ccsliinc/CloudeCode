/**
 * THE HARNESS OWNS TWO PIECES OF VIEW STATE AND HAS TO MOVE BOTH.
 *
 * THE DEFECT THIS EXISTS FOR, reported by the owner from a real browser:
 * "left bar, clicking doesnt switch projects. or it does and if you are
 * in a session it does not pull back." Both halves of that sentence are
 * one bug. `DevPreviewHarness.svelte` renders the reader when `openId`
 * is set and the listing otherwise, testing `openId` FIRST, and its
 * selection handler moved `scope` without clearing `openId`. So a click
 * in the rail really did change the listing, really did fetch it, and
 * really did apply it - behind a transcript that stayed on screen.
 * Nothing threw and nothing logged, which is why it reads from the
 * outside as a rail that has stopped responding.
 *
 * IT READS THE FILE OFF DISK RATHER THAN IMPORTING IT, exactly as
 * `dev-harness-isolation.test.ts` does and for the same reason: an
 * import from `src/` into `web/dev-harness/` is the dependency that
 * file's first rule forbids, and the harness has to stay deletable. The
 * cost is that this is a test about SOURCE SHAPE rather than about
 * behaviour, and it is written to be honest about that - it locates the
 * one function and asserts what that function writes, rather than
 * grepping the whole file for a string that could sit anywhere.
 *
 * THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF. A test that only
 * checked "the file mentions openId" would have passed against the
 * broken version, which declared `openId`, rendered on it and cleared it
 * from a different function. So the assertions below are scoped to the
 * body of `select` and the file is proved to have been found and parsed
 * before any of them run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `web/`, the root both trees hang off. */
const WEB = fileURLToPath(new URL('..', import.meta.url));

/** The harness component that owns both pieces of view state. */
const COMPONENT = join(WEB, 'dev-harness', 'DevPreviewHarness.svelte');

/**
 * The body of one top level `function name(...) { ... }` in a source
 * file, by brace matching.
 *
 * Description: brace matching rather than a regex, because a regex for
 *   a balanced body is a regex that silently returns the wrong span the
 *   first time the function contains an object literal - and this one
 *   does. A function that cannot be found returns null so the caller
 *   refuses loudly instead of asserting against an empty string, which
 *   every `toContain` would fail and every `not.toContain` would pass.
 * Inputs: source - the whole file. name - the function's name.
 * Output: the body between its outermost braces, or null.
 * Example: bodyOf('function f() { return 1; }', 'f')   // -> ' return 1; '
 */
function bodyOf(source: string, name: string): string | null {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) return null;
    const open = source.indexOf('{', source.indexOf(')', start));
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    return null;
}

/** The component's text, read once. */
const SOURCE = readFileSync(COMPONENT, 'utf8');

describe('picking a project in the rail also leaves an open transcript', () => {
    it('finds the selection handler at all, so the rules below measure something', () => {
        // The negative control for every assertion in this file. A
        // renamed or restructured handler must fail HERE, with a
        // sentence, rather than making the rules below vacuously true.
        expect(bodyOf(SOURCE, 'select')).not.toBeNull();
    });

    it('clears the reader, because the reader branch outranks the listing', () => {
        const body = bodyOf(SOURCE, 'select') || '';
        expect(body).toMatch(/openId\s*=\s*null/);
    });

    it('still starts the new listing, so the clear did not replace the work', () => {
        // The other half of the same click. A handler that closed the
        // reader and forgot the scope would pass the rule above and
        // leave the rail just as dead, one branch further down.
        const body = bodyOf(SOURCE, 'select') || '';
        expect(body).toMatch(/scope\s*=\s*\{/);
        expect(body).toMatch(/chosenLabel\s*=/);
    });
});

describe('the pane caption does not render a second name of its own', () => {
    it('reads the rail\'s own labelFor rather than the raw slug field', () => {
        // `full_path` is the SLUG, an encoding of the path that cannot be
        // inverted. Printing it beside a rail row that is painting
        // `display_name` puts two renderers of one name on screen, and
        // they disagree the moment a project has a name at all.
        const body = bodyOf(SOURCE, 'labelOf') || '';
        expect(bodyOf(SOURCE, 'labelOf')).not.toBeNull();
        expect(body).toContain('labelFor(');
        expect(body).not.toContain('full_path');
    });
});
