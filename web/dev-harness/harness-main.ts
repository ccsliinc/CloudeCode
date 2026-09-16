/**
 * THE DEVELOPMENT PREVIEW HARNESS'S ENTRY POINT. SCAFFOLDING, NOT SLICE 3.
 *
 * Run it with `npm run dev:harness` from `web/`. It is never built, is
 * not reachable from `web/src/main.ts`, and contributes nothing to
 * `client/dist/`. Delete `web/dev-harness/` when the real application
 * shell arrives.
 *
 * ORDER MATTERS HERE AND IT IS THE ONLY THING THIS FILE DECIDES.
 * `./harness-legacy` is imported FIRST because it runs the three vanilla
 * IIFEs that publish `window.ArchiveOutcome`, `window.ArchiveFuzzy` and
 * `window.ModalStack`, and `HarnessRoot` reads all three during its own
 * construction. `installHarnessApiGlobal()` runs next, before any
 * component can issue a request, because the granted transport reads
 * `window.API` lazily at CALL time but the first call happens inside
 * `NavRail`'s mount.
 */
import { mount } from 'svelte';
import './harness-legacy';
import { installHarnessApiGlobal } from './harness-api';
import HarnessRoot from './HarnessRoot.svelte';

/** The one mount point in `index.html`. It carries no class, on purpose. */
const ROOT_ID = 'dev-harness-root';

/**
 * Mount the harness.
 *
 * Description: a MISSING ROOT IS A NAMED REFUSAL rather than a thrown
 *   null dereference, so a person who edits `index.html` and breaks the
 *   id reads what happened instead of a stack trace from inside Svelte.
 * Inputs: none. Output: void.
 */
function start(): void {
    installHarnessApiGlobal();
    const target = document.getElementById(ROOT_ID);
    if (!target) {
        console.error(`[dev-harness] there is no #${ROOT_ID} in the page, so `
            + 'nothing was mounted.');
        return;
    }
    mount(HarnessRoot, { target });
}

start();
