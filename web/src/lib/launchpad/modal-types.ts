/**
 * What each modal in slice 6 resolves with, in one place.
 *
 * THESE ARE THE RETURN TYPES OF THE PROMISES THE LEGACY METHODS RETURNED,
 * written down. `showProjectNameModal` resolved `{name, description}` or
 * `null`; `_showChoiceModal` resolved a key or `null`;
 * `ProjectCreateFolder.choose` resolved `{parent, path}` or `null`. None
 * of that was typed, so a caller reading `.path` off a cancel got
 * `undefined` and found out at runtime.
 *
 * THEY LIVE IN A `.ts` FILE AND NOT IN THE COMPONENTS because a Svelte
 * instance script cannot export, and a type defined in a component is a
 * type only that component can name. The components import these; so do
 * the flows, which is what makes the flow and the modal provably agree
 * about what a cancel looks like.
 *
 * A CANCEL IS `null` EVERYWHERE. Never `undefined`, never a falsy real
 * value - see the header of `web/src/lib/modal.ts` for why that matters.
 */

/** What the name step collects. */
export interface ProjectDetails {
    /** The project name exactly as typed, trimmed at the ends only. */
    name: string;
    /** The optional one-line description, trimmed, '' when not given. */
    description: string;
}

/** One row in the one-of-N picker. */
export interface ChoiceItem {
    /** What the picker resolves with when this row is chosen. */
    key: string;
    /** The row's visible label, already translated. */
    label: string;
    /** A second line under the label, already translated. */
    sub?: string | null;
    /** True renders the row visible and named but unselectable. */
    disabled?: boolean;
    /** Why it is disabled, shown in place of `sub`. */
    reason?: string | null;
}

/** Everything the one-of-N picker needs to render. */
export interface ChoiceOptions {
    /** The header sentence, already translated. */
    title: string;
    /** The keyboard hint under the list, already translated. */
    hint?: string;
    items: ChoiceItem[];
    /**
     * What to say when `items` is empty. The CALLER supplies it because
     * "you have none" and "I could not find out" are different answers
     * and only the caller knows which one it has.
     */
    emptyMessage?: string | null;
    /** `info` or `unknown`, which is the class the empty box wears. */
    emptyKind?: string;
}

/** What the folder step resolves with. */
export interface FolderChoice {
    /**
     * The chosen PARENT, which is what is posted as `project_parent_dir`.
     * The server joins the name to it and canonicalises with `realpath`.
     */
    parent: string;
    /**
     * The composed path, for display and for tests. It is NOT posted:
     * a client-composed path would record the short spelling of a
     * symlinked parent, which is how one directory becomes two projects.
     */
    path: string;
}

/** What the edit modal resolves with. */
export interface EditResult {
    name: string;
    description: string;
}

/** The project row the clone endpoint hands back. */
export interface ClonedProject {
    name: string;
    path: string;
    description?: string | null;
}
