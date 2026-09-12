/**
 * Mount, boot and tear down the home screen.
 *
 * WHAT `Launchpad.init()` USED TO BE, minus the 900 lines of markup and
 * wiring it carried. It mounts one component into the container
 * `client/index.html` already owns, and the component wires its own
 * chrome and mounts the four panels. Nothing here builds a string.
 *
 * `ensurePanel`, NOT `mountPanel`, AND THE DIFFERENCE IS VISIBLE TO THE
 * USER. `mountPanel` unmounts first and then APPENDS, so a second call
 * would destroy the mounted shell and rebuild it - and the status light
 * and the audio toggle, which `app.js` and `globalAudioToggle.js` MOVED
 * into the home bar, would go with the old DOM and never come back,
 * because their owners only re-place on a screen change. `app.js` guards
 * against a second init with `Launchpad.launchpadScreen`, and this guards
 * again, because one of those guards is going to be edited some day.
 *
 * THE POLLER IS STARTED HERE AND STOPPABLE HERE. That is the half
 * `launchpad.js` never had: the word `clearInterval` appeared nowhere in
 * that file, so the 5s tick outlived every teardown there has ever been.
 */
import { ensurePanel, unmountPanel } from '../mount';
import HomeScreen from './HomeScreen.svelte';
import { SCREEN_ID } from './home-anchors';
import { unmountLaunchpadPanels } from './panels';
import { closeNewFab, type FabAction } from './new-fab';
import { hostDocument } from '../sessions/env';

/** The element the shell is mounted into, once it has been. */
let screenEl: HTMLElement | null = null;

/** Whether the shell is up, and what `app.js` reads as "already inited". */
export function launchpadScreen(): HTMLElement | null {
    return screenEl;
}

/**
 * Mount the home screen shell, idempotently.
 *
 * Inputs: fabActions - what each `data-action` on the speed dial runs.
 * Output: the container, or null when it is not in the document.
 * Example: mountHomeScreen({'new-console': () => createConsole()});
 */
export function mountHomeScreen(fabActions: Record<string, FabAction>): HTMLElement | null {
    const target = hostDocument()?.getElementById(SCREEN_ID) ?? null;
    if (!target) {
        console.error('CloudeWeb: #' + SCREEN_ID + ' is not in the document, the home screen cannot mount');
        return null;
    }
    ensurePanel(SCREEN_ID, HomeScreen as never, { fabActions } as never);
    screenEl = target;
    return target;
}

/**
 * Tear the home screen down: its panels, then its shell.
 *
 * Description: nothing in the app calls this - the screen is created
 *   once and lives for the page - and it exists so the mount has an
 *   owner that can end it and so a test can prove the mount is
 *   reversible. The FAB is closed first because its backdrop is in
 *   `client/index.html`, OUTSIDE this shell, and would otherwise be left
 *   visible over a screen that no longer exists.
 * Inputs: none. Output: void.
 * Example: unmountHomeScreen();
 */
export function unmountHomeScreen(): void {
    closeNewFab();
    unmountLaunchpadPanels();
    unmountPanel(SCREEN_ID);
    screenEl = null;
}
