/**
 * The "+" speed dial: its dispatch table, its placement, and its teardown.
 *
 * IT IS WIRED IMPERATIVELY AND THAT IS DELIBERATE. The menu is
 * `position: fixed` and has to be measured against a trigger that moves
 * whenever `.launchpad-scroll` scrolls, the viewport rotates or the iOS
 * URL bar collapses - so it reaches `AnchorPopover.place`, which is a
 * classic script, on a listener set. Expressing that as reactive state
 * would mean a rune that re-runs on every scroll event, which is the
 * repaint trap this migration exists to remove, one surface down.
 *
 * RIGHT-EDGE-FLUSH IS LOAD-BEARING. `AnchorPopover` puts the menu ABOVE
 * the trigger with their right edges aligned, drops it below only when
 * there is no room above, and clamps into the visual viewport either way.
 * The pills share a right edge (`align-items: flex-end`) and each row is
 * `row-reverse`, so the icons form one straight column under the "+".
 * Any placement rule that moved the menu's right edge off the trigger's
 * would break that alignment, and `.launchpad-scroll` would be free to
 * clip the menu however low the heading has been scrolled.
 *
 * EVERY LISTENER IT ADDS IS RETURNED AS A TEARDOWN. The legacy version
 * registered four document-level listeners per wire and had no way to
 * remove them; a component that mounts and unmounts needs the other half,
 * and the poller teardown slice 3 added is the precedent.
 */
import { hostDocument, hostWindow } from '../sessions/env';

/** The class that marks the menu open. */
export const OPEN_CLASS = 'new-fab--open';

/** How long the backdrop's fade-out is given before it is hidden. */
export const BACKDROP_FADE_MS = 200;

/** What one FAB action does when chosen. */
export type FabAction = () => unknown;

/** The elements the FAB is made of, resolved once per wire. */
interface FabParts {
    fab: HTMLElement;
    trigger: HTMLElement;
    backdrop: HTMLElement;
}

/** Resolve the three elements, or null when the markup is not up. */
function fabParts(): FabParts | null {
    const doc = hostDocument();
    const fab = doc?.getElementById('new-fab');
    const trigger = doc?.getElementById('new-fab-trigger');
    const backdrop = doc?.getElementById('new-fab-backdrop');
    if (!fab || !trigger || !backdrop) return null;
    return { fab, trigger, backdrop };
}

/**
 * Place the fan-out menu against the "+" trigger.
 *
 * Inputs: none. Output: void - a no-op when the popover module or the
 *   markup is absent, which is the normal state before the first render.
 * Example: placeNewFabMenu();
 */
export function placeNewFabMenu(): void {
    const doc = hostDocument();
    const win = hostWindow() as unknown as Record<string, unknown> | undefined;
    const trigger = doc?.getElementById('new-fab-trigger');
    const menu = doc?.querySelector('#new-fab .new-fab__menu');
    const popover = win?.AnchorPopover as
        | { place(menu: Element, trigger: Element): void }
        | undefined;
    if (!trigger || !menu || !popover) return;
    popover.place(menu, trigger);
}

/** Whether the menu is currently open. */
export function isNewFabOpen(): boolean {
    return !!hostDocument()?.getElementById('new-fab')?.classList.contains(OPEN_CLASS);
}

/** The reposition listener, held so close can remove exactly what open added. */
let reposition: (() => void) | null = null;

/**
 * Open the menu, idempotently.
 *
 * Description: measures and places BEFORE the open class lands, so the
 *   menu animates in at its final position rather than sliding there.
 *   The items are already laid out (opacity 0 and a transform, neither of
 *   which affects layout), so it measures its true size here.
 * Inputs: none. Output: void.
 * Example: openNewFab();
 */
export function openNewFab(): void {
    const parts = fabParts();
    if (!parts) return;
    const win = hostWindow();
    placeNewFabMenu();
    parts.fab.classList.add(OPEN_CLASS);
    if (!reposition) reposition = () => placeNewFabMenu();
    win?.addEventListener('resize', reposition);
    win?.addEventListener('scroll', reposition, true);
    win?.visualViewport?.addEventListener('resize', reposition);
    win?.visualViewport?.addEventListener('scroll', reposition);
    parts.trigger.setAttribute('aria-expanded', 'true');
    parts.backdrop.hidden = false;
    parts.backdrop.setAttribute('data-open', '1');
    parts.fab
        .querySelectorAll('.new-fab__item')
        .forEach((item) => item.setAttribute('tabindex', '0'));
}

/**
 * Close the menu, idempotently.
 *
 * Inputs: none. Output: void.
 * Example: closeNewFab();
 */
export function closeNewFab(): void {
    const parts = fabParts();
    if (!parts) return;
    const win = hostWindow();
    parts.fab.classList.remove(OPEN_CLASS);
    if (reposition) {
        win?.removeEventListener('resize', reposition);
        win?.removeEventListener('scroll', reposition, true);
        win?.visualViewport?.removeEventListener('resize', reposition);
        win?.visualViewport?.removeEventListener('scroll', reposition);
    }
    parts.trigger.setAttribute('aria-expanded', 'false');
    parts.backdrop.removeAttribute('data-open');
    // Hidden AFTER the fade-out so it does not intercept clicks mid-fade.
    setTimeout(() => {
        parts.backdrop.hidden = true;
    }, BACKDROP_FADE_MS);
    parts.fab
        .querySelectorAll('.new-fab__item')
        .forEach((item) => item.setAttribute('tabindex', '-1'));
}

/** Open when closed, close when open. */
export function toggleNewFab(): void {
    if (isNewFabOpen()) closeNewFab();
    else openNewFab();
}

/**
 * Wire the speed dial to a dispatch table.
 *
 * Description: items dispatch by their `data-action` attribute through
 *   delegation on the FAB itself, so the table is the only place an
 *   action is named and an unknown one closes the menu and says so
 *   rather than doing nothing. The handler is deferred a tick so the
 *   close animation gets a frame before any modal opens over it.
 * Inputs: actions - data-action to handler.
 * Output: a teardown that removes every listener this added, or null
 *   when the markup was not there to wire.
 * Example: const off = wireNewFab({'new-console': () => createConsole()});
 */
export function wireNewFab(actions: Record<string, FabAction>): (() => void) | null {
    const parts = fabParts();
    const doc = hostDocument();
    if (!parts || !doc) {
        console.warn('CloudeWeb: new-fab markup missing, the speed dial is not wired');
        return null;
    }
    const offs: Array<() => void> = [];
    const on = (
        target: EventTarget,
        type: string,
        handler: EventListener,
        capture?: boolean,
    ) => {
        target.addEventListener(type, handler, capture);
        offs.push(() => target.removeEventListener(type, handler, capture));
    };

    on(parts.trigger, 'click', ((event: Event) => {
        event.stopPropagation();
        toggleNewFab();
    }) as EventListener);

    on(parts.fab, 'click', ((event: Event) => {
        const item = (event.target as Element | null)?.closest?.('.new-fab__item');
        if (!item || !parts.fab.contains(item)) return;
        event.stopPropagation();
        const action = item.getAttribute('data-action') || '';
        const run = actions[action];
        closeNewFab();
        if (typeof run !== 'function') {
            console.warn('CloudeWeb: unknown FAB action', action);
            return;
        }
        setTimeout(run, 0);
    }) as EventListener);

    on(parts.backdrop, 'click', (() => closeNewFab()) as EventListener);

    on(doc, 'keydown', ((event: Event) => {
        if ((event as KeyboardEvent).key === 'Escape' && isNewFabOpen()) closeNewFab();
    }) as EventListener);

    on(doc, 'click', ((event: Event) => {
        if (!isNewFabOpen()) return;
        if (parts.fab.contains(event.target as Node)) return;
        closeNewFab();
    }) as EventListener);

    return () => {
        for (const off of offs) off();
        offs.length = 0;
    };
}
