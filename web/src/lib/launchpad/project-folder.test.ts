/**
 * The folder step's rules, and the refusal sentences they render.
 *
 * PORTED FROM tests/test_project_create_folder.node.mjs, deleted in the
 * same commit. Every assertion that file made is here; what is new is the
 * half about the string layer, which did not exist when it was written,
 * and the explicit naming of the RULE each case holds.
 *
 * THE PARITY WITH PYTHON IS ASSERTED, NOT ASSUMED. `validateName` here
 * and `validate_project_dir_name` in src/core/project_directory.py refuse
 * the same names for the same reasons, and the en catalog values are the
 * python messages byte for byte. A client that drifted from the server
 * would refuse a name the server accepts, or worse, accept one it
 * refuses and hand the user a 400 from a modal that had already closed.
 */
import { describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import {
    PROJECT_CREATE_KEYS,
    nameRefusal,
} from '../../../../client/js/labels/project-create.js';
import { ILLEGAL_CHARS, MAX_NAME_BYTES, composePath, validateName } from './project-folder';

/** A real translator over the shipped en catalog. */
function enT(): (key: string, params?: Record<string, unknown> | null) => string {
    const i18n = createI18n({ locale: 'en' }) as {
        t(key: string, params?: Record<string, unknown> | null): string;
    };
    return (key, params) => i18n.t(key, params);
}

describe('composePath joins a parent and a name, and nothing else', () => {
    test('a parent and a name join with exactly one separator', () => {
        expect(composePath('/a/b', 'My App')).toBe('/a/b/My App');
    });

    test('trailing slashes on the parent do not double the separator', () => {
        expect(composePath('/a/b/', 'My App')).toBe('/a/b/My App');
        expect(composePath('/a/b///', 'My App')).toBe('/a/b/My App');
    });

    test('the filesystem root composes without a doubled slash', () => {
        expect(composePath('/', 'My App')).toBe('/My App');
    });

    test('the long icloud spelling survives composition verbatim', () => {
        // GOTCHA 6. The short `~/Development` spelling is a symlink into
        // this path, and storing the short form is how one directory
        // becomes two projects. Nothing here may shorten it.
        const parent =
            '/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development';
        expect(composePath(parent, 'Cloude Code')).toBe(`${parent}/Cloude Code`);
    });

    test('surrounding whitespace is trimmed from both sides', () => {
        expect(composePath('  /a/b  ', '  My App  ')).toBe('/a/b/My App');
    });

    test('a missing parent or name composes nothing, never a bare slash', () => {
        expect(composePath('', 'My App')).toBe('');
        expect(composePath('/a/b', '')).toBe('');
        expect(composePath(null, undefined)).toBe('');
    });

    test('RULE: the composed path never carries the generated-id shape', () => {
        // The defect this whole step exists to prevent, asserted on the
        // one string a user is shown before anything is created.
        const composed = composePath('/Users/me/Development', 'Punchlist Test');
        expect(composed).toBe('/Users/me/Development/Punchlist Test');
        expect(/\/ses_[0-9a-f]{8}$/.test(composed)).toBe(false);
    });
});

describe('RULE: a project name is REFUSED, never rewritten', () => {
    test('a name with spaces is accepted and used exactly as typed', () => {
        // The owner's own projects have spaces. A sanitiser would make a
        // folder he could not find.
        const verdict = validateName('Punchlist Test');
        expect(verdict.ok).toBe(true);
        expect(verdict.code).toBe(null);
        expect(composePath('/Users/me/Development', 'Punchlist Test')).toBe(
            '/Users/me/Development/Punchlist Test',
        );
    });

    test('ordinary names are accepted', () => {
        for (const name of ['api', 'my-app', 'my_app', 'App 2', 'v1.2', 'a']) {
            expect(validateName(name).ok, name).toBe(true);
        }
    });

    test('a forward slash is refused by name, and the name is unchanged', () => {
        const verdict = validateName('a/b');
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('illegal_char');
        expect(verdict.params.char).toBe('/');
        // THE MUTATION THIS CATCHES: sanitising `a/b` to `a-b` and
        // returning ok. Nothing in the verdict may carry a rewritten
        // name, because a verdict is not where a name comes from.
        expect(Object.values(verdict.params)).not.toContain('a-b');
    });

    test('the refusal is a sentence a user can act on', () => {
        const t = enT();
        expect(nameRefusal(validateName('a/b'), t)).toBe("a project name cannot contain '/'");
        expect(nameRefusal(validateName(''), t)).toBe('a project name is required');
        expect(nameRefusal(validateName('.hidden'), t)).toBe(
            'a project name cannot start with a dot',
        );
        expect(nameRefusal(validateName('..'), t)).toBe("a project name cannot be '.' or '..'");
        expect(nameRefusal(validateName('bad\nname'), t)).toBe(
            'a project name cannot contain control characters',
        );
        expect(nameRefusal(validateName('x'.repeat(MAX_NAME_BYTES + 1)), t)).toBe(
            'a project name cannot be longer than 255 bytes',
        );
        // An ACCEPTED name has nothing to say.
        expect(nameRefusal(validateName('api'), t)).toBe(null);
    });

    test('a backslash is refused', () => {
        expect(validateName('back\\slash').ok).toBe(false);
        expect(validateName('back\\slash').params.char).toBe('\\');
    });

    test('a null byte is refused and named as one, not as a character', () => {
        const verdict = validateName(`a${String.fromCharCode(0)}b`);
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('illegal_null');
        expect(nameRefusal(verdict, enT())).toBe('a project name cannot contain a null character');
    });

    test('dot, dot-dot and a traversal segment are refused', () => {
        expect(validateName('.').code).toBe('reserved');
        expect(validateName('..').code).toBe('reserved');
        // `../escape` trips the separator rule first, which is the same
        // order the server checks in.
        expect(validateName('../escape').ok).toBe(false);
    });

    test('a leading dot is refused so the project is not invisible', () => {
        expect(validateName('.hidden').code).toBe('leading_dot');
    });

    test('control characters are refused', () => {
        expect(validateName('bad\nname').code).toBe('control_chars');
        expect(validateName('bad\tname').code).toBe('control_chars');
        expect(validateName(`bad${String.fromCharCode(127)}name`).code).toBe('control_chars');
    });

    test('an empty or whitespace-only name is refused', () => {
        expect(validateName('').code).toBe('required');
        expect(validateName('   ').code).toBe('required');
        expect(validateName(null).code).toBe('required');
        expect(validateName(undefined).code).toBe('required');
    });

    test('the length limit is counted in bytes, not characters', () => {
        expect(validateName('x'.repeat(MAX_NAME_BYTES)).ok).toBe(true);
        expect(validateName('x'.repeat(MAX_NAME_BYTES + 1)).ok).toBe(false);
        // One emoji is four bytes and the kernel counts bytes.
        expect(validateName('\u{1F600}'.repeat(64)).ok).toBe(false);
    });

    test('a space is NOT on the illegal list, and the other three are', () => {
        // The list is the rule. A space here would refuse most of the
        // owner's projects, which is the opposite of what it is for.
        expect(ILLEGAL_CHARS).toContain('/');
        expect(ILLEGAL_CHARS).toContain('\\');
        expect(ILLEGAL_CHARS).toContain(String.fromCharCode(0));
        expect(ILLEGAL_CHARS as readonly string[]).not.toContain(' ');
    });

    test('NEGATIVE CONTROL: the checker does not refuse everything', () => {
        // A validator that always refused would pass every assertion
        // above about refusals and be useless.
        const accepted = ['api', 'Punchlist Test', 'v1.2', 'a b c'].filter(
            (n) => validateName(n).ok,
        );
        expect(accepted).toHaveLength(4);
    });

    test('every refusal renders a lowercase sentence with no dashes', () => {
        const t = enT();
        const refusals = ['', 'a/b', '.', '.hidden', 'bad\nname', 'x'.repeat(300)]
            .map((n) => nameRefusal(validateName(n), t))
            .filter((s): s is string => typeof s === 'string');
        expect(refusals).toHaveLength(6);
        for (const sentence of refusals) {
            expect(sentence, sentence).not.toMatch(/^[A-Z]/);
            expect(sentence, sentence).not.toMatch(/[–—]/);
        }
    });

    test('every refusal code has a key, and the keys exist in the catalog', () => {
        const t = enT();
        const codes = [
            'required',
            'illegal_char',
            'illegal_null',
            'control_chars',
            'reserved',
            'leading_dot',
            'too_long',
        ];
        for (const code of codes) {
            const sentence = nameRefusal({ ok: false, code, params: { char: '/', max: 255 } }, t);
            // A missing key renders the key itself, which is the string
            // layer's loud failure mode. Seeing a dotted key here means
            // the catalog is missing a message.
            expect(sentence, code).not.toMatch(/^project\./);
        }
        expect(Object.keys(PROJECT_CREATE_KEYS).length).toBeGreaterThan(40);
    });
});
