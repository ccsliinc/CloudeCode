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
// THE TWELVE ARCHIVE STYLESHEETS, WHICH THIS PAGE WAS NOT LOADING.
//
// Measured in a real browser 2026-09-17, on this harness: `.archive-reader`
// computed `display: block` and `.archive-reader__scroller` computed
// `overflow-y: visible`, because NOT ONE of `client/css/archive*.css` was
// linked here. Every archive component previewed on this page was rendering
// in Chrome's user-agent defaults - which is EXACTLY the failure
// `tests/test_archive_tlist_styled.node.mjs` was written for, reproduced by
// the preview that was supposed to catch it.
//
// For the reader it is not cosmetic. `.archive-reader__scroller` is what
// declares `overflow-y: auto`, so without these files there IS no scrollport:
// the scroller grows to fit its content (measured 40,809px tall), the render
// window covers everything, and the virtualisation is INERT while looking
// perfect. A preview of a windowed list that is not windowing is worse than
// no preview.
//
// IMPORTING IS NOT EDITING. Commitment 2 is that none of these twelve files
// changes; this adds a reference to them from harness scaffolding, and they
// are read byte-for-byte as they sit on disk.
// THE ORDER IS client/index.html's, NOT ALPHABETICAL, AND THAT IS THE
// WHOLE POINT. Four of these twelve override another by LOAD ORDER
// alone, at equal specificity, and index.html says so in as many words
// beside each link: archive-nav-card.css overrides the rail's generic
// project row and so must follow archive-nav.css (and archive-outcomes
// .css), archive-nav-info.css follows the card it belongs to,
// archive-align.css follows archive-reader.css, and archive-panes.css
// follows archive-tlist.css.
//
// Imported alphabetically - which is how this list was first written -
// archive-nav-card.css lands BEFORE archive-nav.css and loses every
// tie. Measured: `.archive-nav__count--sessions { color: accent;
// font-weight: 600 }` was outranked by `.archive-nav__count { color:
// var(--color-fg-muted) }`, so the sessions figure rendered MUTED and
// at weight 400 - it looked like a deliberately quiet number, and the
// four signals the card's header says tell the two counts apart were
// silently down to three. Nothing errored, and both columns of the
// parity page were wrong in exactly the same way, so the comparison
// between them still read as perfect agreement.
//
// A HARNESS THAT LOADS THE RIGHT FILES IN THE WRONG ORDER IS NOT
// SHOWING THE APP. Keep this list in index.html's order, and when a
// stylesheet is added there, add it HERE in the same position.
import '../../client/css/archive-outcomes.css';
import '../../client/css/archive-screen.css';
import '../../client/css/archive-nav.css';
import '../../client/css/archive-nav-card.css';
import '../../client/css/archive-nav-info.css';
import '../../client/css/archive-reader.css';
import '../../client/css/archive-chat.css';
import '../../client/css/archive-search.css';
import '../../client/css/archive-export.css';
import '../../client/css/archive-tlist.css';
import '../../client/css/archive-align.css';
import '../../client/css/archive-panes.css';
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
