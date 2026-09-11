/**
 * THE FOLDER STEP'S RULES, and nothing else.
 *
 * PORTED FROM `client/js/project-create-folder.js`, deleted in the same
 * commit. That file mixed two things: these pure rules and a modal that
 * drew itself with `innerHTML`. The modal is now
 * `ProjectFolderModal.svelte`; the rules are here, because they are the
 * half that has to be right and the half a browser is the worst place to
 * test.
 *
 * WHY A NAME IS REFUSED AND NEVER REWRITTEN. A sanitiser that quietly
 * turns `a/b` into `a-b` creates a folder the user did not ask for and
 * cannot find later, and `sessions.working_dir` keeps that folder for the
 * life of the project. Spaces are LEGAL and are used verbatim, because
 * the owner's own projects have them. This is the client half of the
 * rule; `src/core/project_directory.py` is the authority and refuses the
 * same names on the server, so a client that skipped this check would
 * still be refused - this exists to answer without a round trip.
 *
 * A VERDICT CARRIES A CODE, NOT A SENTENCE. The code names the rule that
 * refused; `client/js/labels/project-create.js` turns it into the
 * lowercase sentence the modal shows. Two reasons, and the second is the
 * load-bearing one: the copy has to go through the catalog like every
 * other user-visible string, and a rule that returns English cannot be
 * compared to the python rule without comparing two languages at once.
 * The en catalog values are byte-identical to the python messages, so
 * nothing a user reads changed when this moved.
 */

/**
 * Characters that can never appear in a project folder name: the path
 * separator, the other platform's separator, and NUL (which terminates
 * the string the kernel actually receives). Spaces are absent from this
 * list ON PURPOSE. Mirrors `ILLEGAL_NAME_CHARS` in
 * `src/core/project_directory.py`.
 */
export const ILLEGAL_CHARS = ['/', '\\', '\u0000'] as const;

/** Longest single path component macOS accepts, in bytes (NAME_MAX). */
export const MAX_NAME_BYTES = 255;

/** Which rule refused a name. One code per rule, never a shared "bad". */
export type NameRefusalCode =
    | 'required'
    | 'illegal_char'
    | 'illegal_null'
    | 'control_chars'
    | 'reserved'
    | 'leading_dot'
    | 'too_long';

/** The outcome of checking a project name, named rather than boolean. */
export interface NameVerdict {
    /** True only when the name is usable as one path component. */
    ok: boolean;
    /** Which rule refused, or null when nothing did. */
    code: NameRefusalCode | null;
    /** What the refusal message needs interpolated, e.g. the character. */
    params: Record<string, string | number>;
}

/** The one shape an accepted name comes back as. */
const ACCEPTED: NameVerdict = { ok: true, code: null, params: {} };

/**
 * Check a project name is usable as a single path component.
 *
 * Description: rejects rather than rewrites, in the order the server
 *   checks so the two cannot report different rules for one name. The
 *   length limit is counted in BYTES because the kernel counts bytes and
 *   one emoji is four of them.
 * Inputs: name (unknown) - the project name exactly as typed. Anything
 *   that is not a string is treated as absent rather than coerced.
 * Output: NameVerdict.
 * Example: validateName('a/b')
 *   // {ok: false, code: 'illegal_char', params: {char: '/'}}
 */
export function validateName(name: unknown): NameVerdict {
    const raw = typeof name === 'string' ? name : '';
    const trimmed = raw.trim();

    if (!trimmed) return { ok: false, code: 'required', params: {} };

    for (const char of ILLEGAL_CHARS) {
        if (trimmed.indexOf(char) !== -1) {
            if (char === '\u0000') {
                return { ok: false, code: 'illegal_null', params: {} };
            }
            return { ok: false, code: 'illegal_char', params: { char } };
        }
    }
    for (let i = 0; i < trimmed.length; i += 1) {
        const code = trimmed.charCodeAt(i);
        if (code < 32 || code === 127) {
            return { ok: false, code: 'control_chars', params: {} };
        }
    }
    if (trimmed === '.' || trimmed === '..') {
        return { ok: false, code: 'reserved', params: {} };
    }
    if (trimmed.charAt(0) === '.') {
        return { ok: false, code: 'leading_dot', params: {} };
    }
    if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) {
        return { ok: false, code: 'too_long', params: { max: MAX_NAME_BYTES } };
    }
    return ACCEPTED;
}

/**
 * Join a parent folder and a project name into the path that will exist.
 *
 * Description: exactly one separator between them however many trailing
 *   slashes the parent carried, and the NAME IS USED AS TYPED (trimmed
 *   only) so the folder on disk matches what the preview showed. This is
 *   a PREVIEW, not the path that is posted: the server is handed the
 *   parent and joins it itself, after `realpath`, so the row records the
 *   long spelling of a symlinked parent rather than whatever the client
 *   displayed.
 * Inputs: parent (unknown) - the chosen parent folder; name (unknown).
 * Output: string - the composed path, or '' when either side is missing.
 * Example: composePath('/a/b/', 'My App')  // '/a/b/My App'
 */
export function composePath(parent: unknown, name: unknown): string {
    const p = typeof parent === 'string' ? parent.trim() : '';
    const n = typeof name === 'string' ? name.trim() : '';
    if (!p || !n) return '';
    const base = p === '/' ? '' : p.replace(/\/+$/, '');
    return `${base}/${n}`;
}
