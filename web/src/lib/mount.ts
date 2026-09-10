/**
 * The one mount seam between the legacy tree and the compiled tree.
 *
 * WHY THIS EXISTS AT ALL. The strangler migration moves one panel at a
 * time out of `client/js` and into `web/src`, and every panel it moves
 * lands inside a container the LEGACY code created. So there has to be
 * exactly one way for legacy JavaScript to say "the thing that used to
 * render here is a Svelte component now", and it has to be a direct
 * call: an event bus would put an indirection between the line that used
 * to render and the line that renders now, and the whole point of a
 * strangler slice is that the two are the same line.
 *
 * ONE HANDLE PER CONTAINER ID, AND THE OLD ONE IS UNMOUNTED FIRST.
 * Svelte 5's `mount()` APPENDS to its target and returns a handle that
 * owns the reactive effects behind those nodes. Calling it twice on one
 * container paints the panel twice and leaks the first set of effects,
 * which keep running, keep subscribing and keep answering. `unmount()`
 * is the only correct inverse, so this module records the handle and
 * calls it. Nobody outside this file may call `mount()` on an element
 * that is in the document.
 *
 * IT DOES NOT CLEAR THE CONTAINER, and that is deliberate. `unmount()`
 * removes the nodes Svelte created and nothing else, which is exactly
 * right while a container is shared with legacy markup mid-migration. A
 * helper that also wiped the container would be a second, hidden
 * behaviour that a later slice could not turn off, and it would delete
 * sibling content the legacy parent still believes it owns.
 *
 * A MISSING CONTAINER IS A NO-OP, NOT A THROW. The legacy renderers this
 * replaces all open with `if (!slot) return;` - a panel whose container
 * has not been written yet is a normal state during boot, not a fault.
 * It is warned about rather than swallowed, because a mount that
 * silently does nothing is indistinguishable from a component that
 * renders nothing.
 */
import { mount, unmount, type Component } from 'svelte';

/** What is recorded for a live panel: its handle and where it was put. */
interface PanelRecord {
    /** The element `mount()` was given as its target. */
    target: Element;
    /** The handle `mount()` returned, i.e. the component's exports. */
    instance: Record<string, unknown>;
}

/** Live panels, keyed by the id of the container they were mounted into. */
const panels = new Map<string, PanelRecord>();

/**
 * Mount a Svelte component into an existing element, replacing whatever
 * this helper mounted there before.
 *
 * Description: looks the container up by id, unmounts the panel this
 *   module previously mounted under that id (if any), then mounts
 *   `component` into it and records the new handle. The container is
 *   never cleared and never created - it belongs to whoever wrote it.
 *
 *   THE STALE-TARGET CASE IS HANDLED RATHER THAN ASSUMED AWAY. If a
 *   legacy parent replaced the container element between two calls, the
 *   recorded handle points at detached nodes. Unmounting it is still
 *   correct and still necessary: the nodes are gone but the effects
 *   behind them are not, and only `unmount()` stops those.
 * Inputs:
 *   id (string) - the container's `id` attribute, e.g. 'attribution-prompt'.
 *   component (Component) - the compiled Svelte 5 component to mount.
 *   props (object, optional) - initial props, passed through unchanged.
 * Output: Record<string, unknown> | null - the mount handle, or null when
 *   no element carries that id, in which case nothing was mounted.
 * Example:
 *   window.CloudeWeb.mountPanel('attribution-prompt', AttributionPrompt, {});
 */
export function mountPanel<Props extends Record<string, unknown>>(
    id: string,
    component: Component<Props, Record<string, unknown>>,
    props?: Props,
): Record<string, unknown> | null {
    const target = document.getElementById(id);
    if (!target) {
        // Warned, not thrown: the legacy renderers this replaces all
        // treat a missing container as a normal early-boot state. A
        // silent return would make a mis-spelled id look like a
        // component that chose to render nothing.
        console.warn('CloudeWeb.mountPanel: no element with id', id);
        unmountPanel(id);
        return null;
    }
    unmountPanel(id);
    const instance = mount(component, {
        target,
        props: (props ?? {}) as Props,
    }) as Record<string, unknown>;
    panels.set(id, { target, instance });
    return instance;
}

/**
 * Unmount the panel this module mounted under a container id.
 *
 * Description: the inverse of :func:`mountPanel`, and the only thing that
 *   stops a mounted panel's reactive effects. Safe to call for an id that
 *   holds nothing. `outro: false` makes it synchronous, so the container
 *   is clean before the caller does anything else with it.
 * Inputs: id (string) - the container id the panel was mounted under.
 * Output: boolean - true when a panel was there and was unmounted.
 * Example: window.CloudeWeb.unmountPanel('attribution-prompt')  // true
 */
export function unmountPanel(id: string): boolean {
    const record = panels.get(id);
    if (!record) return false;
    panels.delete(id);
    unmount(record.instance, { outro: false });
    return true;
}

/**
 * Mount a panel ONLY if this module does not already hold a live one on
 * the element that currently carries that id.
 *
 * Description: SLICE 4 NEEDED THIS AND SLICES 1 AND 2 DID NOT, because
 *   those two panels are mounted at one moment each. The project tree's
 *   legacy entry point, `renderProjectList()`, is called on EVERY 5s poll
 *   tick and from five other places, and it is now one call to this. A
 *   plain `mountPanel` there would unmount and rebuild the whole tree
 *   every five seconds - the exact repaint the slice exists to delete,
 *   reintroduced by the seam rather than by the renderer.
 *
 *   THE TEST IS THE ELEMENT, NOT THE ID, and that is the part worth
 *   reading twice. A legacy parent can replace `#project-list` wholesale;
 *   the recorded handle then points at nodes that are no longer in the
 *   document, and the panel is invisible while still holding live
 *   effects. Comparing the recorded target against the element the id
 *   resolves to NOW catches that and remounts, which is correct in both
 *   directions: same element means the panel is already there, different
 *   element means the container was replaced under us.
 * Inputs: id, component, props - as :func:`mountPanel`.
 * Output: Record<string, unknown> | null - the live handle, or null when
 *   no element carries that id.
 * Example: ensurePanel('project-list', ProjectTree, {});
 */
export function ensurePanel<Props extends Record<string, unknown>>(
    id: string,
    component: Component<Props, Record<string, unknown>>,
    props?: Props,
): Record<string, unknown> | null {
    const target = document.getElementById(id);
    const existing = panels.get(id);
    if (existing && target && existing.target === target) {
        return existing.instance;
    }
    return mountPanel(id, component, props);
}
