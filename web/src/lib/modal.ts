/**
 * The one way a transient overlay is put on screen, and taken off again.
 *
 * WHY IT IS NOT `mountPanel`. A panel is keyed by the id of a container
 * the legacy tree wrote, lives for as long as that screen does, and is
 * replaced in place. A modal has no container until it is opened, exists
 * to be closed, and ANSWERS: every method this replaced returned a
 * promise that resolved with what the user chose. Keying overlays by id
 * would make two simultaneous modals impossible to express and would put
 * a modal's lifetime in a map that outlives it. So this is a second seam,
 * deliberately, and it is still exactly one seam: nothing outside this
 * file may call Svelte's `mount()` for an overlay.
 *
 * THE PROMISE IS THE PORT. `showProjectNameModal`, `_showChoiceModal`,
 * `showEditProjectModal`, `ProjectCreateFolder.choose` and
 * `showCloneFromGithubModal` each built a `new Promise` around an
 * `innerHTML` overlay and resolved it from a click handler. Their callers
 * are unchanged by this move because the shape they see is unchanged: a
 * promise resolving with a value, or with `null` when the user cancelled.
 *
 * A CANCEL IS ALWAYS `null`, AND IT IS ALWAYS A NO-OP. Every caller in
 * this migration treats `null` as "do nothing", which is the rule
 * `showConfirmModal` has always held itself to. A modal that resolved
 * `undefined` on one path and `null` on another would make that check
 * `!= null` somewhere, and `!= null` is how a falsy real answer becomes a
 * cancel.
 *
 * IT CLEANS UP ON EVERY PATH, including a component that throws while
 * mounting. `unmount()` is the only thing that stops a component's
 * reactive effects; removing the host element alone would leave them
 * running against detached nodes, which is the leak `mountPanel`'s header
 * describes one surface up.
 */
import { mount, unmount, type Component } from 'svelte';

/** What every modal component is handed so it can answer. */
export interface Closable<Result> {
    /** Resolve the open promise once. Later calls are ignored. */
    close(value: Result | null): void;
}

/** How many overlays this module currently holds open. */
let openCount = 0;

/**
 * Open a modal component and resolve with whatever it closes with.
 *
 * Description: creates a host element, appends it to `document.body`,
 *   mounts `component` into it with `close` added to its props, and
 *   resolves the returned promise the first time `close` is called. The
 *   host is removed and the component unmounted before the promise
 *   settles, so a caller that opens another modal in its `.then` cannot
 *   stack a dead overlay under a live one.
 *
 *   THE HOST IS A PLAIN `<div>` WITH NO CLASS. The overlay element with
 *   `.modal-overlay` is the component's own root, exactly as it was when
 *   these were built by hand, so `client/css/modal-stack.css` keeps
 *   stacking them the way it always has and nothing in the stylesheet had
 *   to move for this migration.
 * Inputs:
 *   component (Component) - the compiled Svelte 5 modal.
 *   props (object, optional) - passed through unchanged, minus `close`,
 *     which this supplies.
 * Output: Promise<Result | null> - the value the modal closed with, or
 *   null when it was cancelled or could not be mounted.
 * Example:
 *   const details = await openModal(ProjectNameModal, { title: 'x' });
 */
export function openModal<Result, Props extends Record<string, unknown>>(
    component: Component<Props & Closable<Result>, Record<string, unknown>>,
    props?: Props,
): Promise<Result | null> {
    return new Promise<Result | null>((resolve) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        openCount += 1;

        let settled = false;
        let instance: Record<string, unknown> | null = null;

        const finish = (value: Result | null): void => {
            if (settled) return;
            settled = true;
            openCount -= 1;
            if (instance) unmount(instance, { outro: false });
            if (host.parentNode) host.parentNode.removeChild(host);
            resolve(value);
        };

        try {
            instance = mount(component, {
                target: host,
                props: { ...(props ?? {}), close: finish } as Props & Closable<Result>,
            }) as Record<string, unknown>;
        } catch (error) {
            // A modal that cannot mount must not leave an empty host in
            // the document, and must not hang its caller forever. Logged
            // rather than swallowed: this is a build or props fault, and
            // a cancel that nobody asked for looks identical to a user
            // pressing escape.
            console.error('CloudeWeb.openModal: the modal failed to mount', error);
            finish(null);
        }
    });
}

/**
 * How many modals this module currently has open.
 *
 * Description: exists for tests and for a caller that must not stack a
 *   second overlay, not for styling - the z-order is `modal-stack.css`'s
 *   job and always has been.
 * Inputs: none.
 * Output: number.
 * Example: expect(openModalCount()).toBe(0);
 */
export function openModalCount(): number {
    return openCount;
}
