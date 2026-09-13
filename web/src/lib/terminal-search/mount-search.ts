/**
 * Mount the search panel, and the three ways anything opens it.
 *
 * THE FIRST COMPILED THING ON THE TERMINAL SCREEN. Every slice before
 * this one was mounted by a legacy caller at the line its own render used
 * to run on; there is no such line here, because `client/js/terminal.js`
 * never rendered this panel - `terminal-search.js` mounted itself at
 * script load. So this mounts from `main.ts`, on the same condition that
 * file used: the terminal screen exists in the document.
 *
 * IT STILL GOES THROUGH `mountPanel`. The container is
 * `.terminal-container`, which `client/index.html` owns and which now
 * carries an id so the one mount path can address it. `mountPanel` does
 * not clear its container, which is what makes it safe to share with
 * `#terminal` and with anything else the legacy tree injects beside it.
 *
 * THE DOCUMENT LISTENER IS INSTALLED HERE AND NOT IN THE COMPONENT. The
 * chord has to work at any moment the terminal screen is up, including
 * before the panel has ever been opened, so it cannot be owned by
 * something whose lifetime is the panel's.
 *
 * IDEMPOTENT, AND IT HOLDS ONE CONTROLLER FOR THE LIFE OF THE PAGE. Two
 * controllers would mean two rails registering two sets of xterm markers
 * over one buffer, and two document listeners each acting on the same
 * key.
 */
import { ensurePanel, unmountPanel } from '../mount';
import { hostDocument, hostWindow } from '../sessions/env';
import SearchPanel from './SearchPanel.svelte';
import { SearchController } from './search-controller.svelte';
import { browserSearchHost, type SearchHost } from './search-host';
import { installKeyRouting } from './search-keys';

/** The id `client/index.html` gives `.terminal-container`. */
export const SEARCH_CONTAINER_ID = 'terminal-container';

/** The header control that opens the panel on a desktop. */
const HEADER_BUTTON_ID = 'terminalSearchBtn';

/** The one controller, or null before the first mount. */
let controller: SearchController | null = null;

/** Everything the mount registered, so it can be undone. */
let teardown: Array<() => void> = [];

/**
 * Mount the panel and install the chord listener, once.
 *
 * Inputs: host (SearchHost, optional) - defaults to the legacy globals;
 *   a caller passes one in only to test.
 * Output: SearchController | null - null when there is no terminal
 *   screen in this document, which is a normal state on a page that has
 *   not got one rather than a fault.
 * Example: window.CloudeWeb.mountTerminalSearch();
 */
export function mountTerminalSearch(host?: SearchHost): SearchController | null {
    if (controller) return controller;
    // THE MOUNT RUNS AT BUNDLE LOAD, so it has to survive every realm
    // this file is ever evaluated in - including the node harnesses,
    // which build a `document` object holding only the handful of
    // members the thing they are measuring uses. A missing lookup and a
    // lookup that answers nothing mean the same thing here, which is
    // that there is no terminal screen to mount into.
    const doc = hostDocument();
    if (!doc || typeof doc.getElementById !== 'function') return null;
    const target = doc.getElementById(SEARCH_CONTAINER_ID);
    if (!target || typeof target.appendChild !== 'function') return null;

    const built = new SearchController(host ?? browserSearchHost());
    controller = built;
    ensurePanel(SEARCH_CONTAINER_ID, SearchPanel as never, { controller: built } as never);
    teardown.push(installKeyRouting(built, doc));

    // A DESTROYED SESSION CLOSES THE PANEL. Its query is about a session
    // that no longer exists, and the rail behind it holds markers into a
    // buffer nothing is writing to.
    const win = hostWindow();
    if (win && typeof win.addEventListener === 'function') {
        const onDestroyed = (): void => built.close();
        win.addEventListener('session-destroyed', onDestroyed);
        teardown.push(() => win.removeEventListener('session-destroyed', onDestroyed));
    }

    wireHeaderButton(doc, built);
    return built;
}

/**
 * Wire the desktop header control.
 *
 * Description: NO INLINE `onclick`, EVER. `src/main.py` stamps
 *   `script-src 'self'`, which forbids inline handlers, and a button
 *   carrying one would be present, sized, visible and completely dead
 *   with nothing but a console violation to say so.
 * Inputs: doc (Document), ctl (SearchController).
 * Output: void.
 */
function wireHeaderButton(doc: Document, ctl: SearchController): void {
    const btn = doc.getElementById(HEADER_BUTTON_ID);
    if (!btn || btn.getAttribute('data-search-wired') === '1') return;
    btn.setAttribute('data-search-wired', '1');
    const onClick = (): void => ctl.toggle();
    btn.addEventListener('click', onClick);
    teardown.push(() => {
        btn.removeEventListener('click', onClick);
        btn.removeAttribute('data-search-wired');
    });
}

/**
 * Open the panel, mounting it first if nothing has yet.
 *
 * Description: the entry point for the terminal tools menu's search row
 *   on a phone. `open`, not `toggle`: that row is only reachable from an
 *   open menu and the menu closes before it runs, so a toggle there
 *   could only ever mean "open".
 * Inputs: none. Output: void.
 * Example: window.CloudeWeb.openTerminalSearch();
 */
export function openTerminalSearch(): void {
    (controller ?? mountTerminalSearch())?.open();
}

/**
 * Toggle the panel, mounting it first if nothing has yet.
 *
 * Inputs: none. Output: void.
 * Example: window.CloudeWeb.toggleTerminalSearch();
 */
export function toggleTerminalSearch(): void {
    (controller ?? mountTerminalSearch())?.toggle();
}

/**
 * Is the panel on screen? For a caller that has to ask rather than act.
 *
 * Inputs: none. Output: boolean.
 * Example: window.CloudeWeb.terminalSearchIsOpen();
 */
export function terminalSearchIsOpen(): boolean {
    return controller?.isOpen() ?? false;
}

/**
 * Undo the mount: the listener, the wire, the panel and the markers.
 *
 * Description: nothing in the app calls this - the panel is created once
 *   and lives for the page - and it exists so the mount has an owner
 *   that can end it and so a test can prove it is reversible.
 * Inputs: none. Output: void.
 * Example: unmountTerminalSearch();
 */
export function unmountTerminalSearch(): void {
    controller?.close();
    controller?.rail.dispose();
    for (const undo of teardown) undo();
    teardown = [];
    unmountPanel(SEARCH_CONTAINER_ID);
    controller = null;
}
