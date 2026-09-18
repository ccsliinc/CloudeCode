/**
 * THE THREE VANILLA MODULES AND THE REAL STYLESHEETS, LOADED READ ONLY.
 * SCAFFOLDING, NOT SLICE 3.
 *
 * WHY THE VANILLA MODULES ARE HERE AND NOT PORTED. Both components take
 * an `outcome` classifier and the transcript list takes a `fuzzy`
 * matcher; in the real app `archive-state-install.ts` supplies the first
 * from `window.ArchiveOutcome`, which is still `client/js/archive-outcome.js`
 * because interpreting `result_status` is deliberately ONE file in the
 * whole client and porting it belongs to a later slice. The harness
 * makes the same choice for the same reason: a second classifier written
 * for a preview is a second set of branches that would drift from the
 * one the app uses, and then the preview would be lying about exactly
 * the thing it exists to show. `window.ModalStack` is the third, and it
 * is what routes Escape out of the project details modal.
 *
 * THEY ARE IMPORTED FOR THEIR SIDE EFFECT. Each is an IIFE that assigns
 * one name onto `window`; importing the file runs it. NOTHING IS
 * WRITTEN BACK: this module reads `client/`, it never modifies it, and
 * Vite serves those files from disk without rewriting them.
 *
 * THE STYLESHEETS ARE LOADED IN `client/index.html`'s OWN ORDER, AND
 * THAT ORDER IS A FACT ABOUT THEM. `archive-outcomes.css` first so a
 * later archive sheet can override outcome presentation;
 * `archive-nav-card.css` after `archive-nav.css` because the card
 * overrides the generic row; `archive-nav-info.css` after that.
 * Reproducing the order is the only way the preview shows what the app
 * shows. LOADING A STYLESHEET IS NOT TOUCHING IT: commitment 2 of issue
 * #173 is that none of the twelve archive stylesheets is MODIFIED, and
 * none is. `git diff --stat client/css/` is the check.
 *
 * `styles.css` COMES FIRST BECAUSE IT DEFINES THE TOKENS. Every archive
 * sheet is written in terms of `--color-bg`, `--color-fg`, `--radius-md`
 * and friends, which are declared on `:root` in `client/css/styles.css`.
 * Without it the archive sheets resolve every colour to nothing and the
 * rail renders in Chrome's user-agent defaults, which is the exact
 * failure `archive-tlist.css`'s own header records having been shipped
 * once already.
 */

/* The token base and the modal stack's own presentation. */
import '../../client/css/styles.css';
import '../../client/css/modal-stack.css';

/* The archive sheets, in client/index.html's order. */
import '../../client/css/archive-outcomes.css';
import '../../client/css/archive-screen.css';
import '../../client/css/archive-nav.css';
import '../../client/css/archive-nav-card.css';
import '../../client/css/archive-nav-info.css';
import '../../client/css/archive-tlist.css';
import '../../client/css/archive-align.css';
import '../../client/css/archive-panes.css';
/*
 * THE READER'S AND THE CHAT VIEW'S OWN SHEETS. Slices 7 and 8 mount
 * components whose classes live here, and a harness that linked neither
 * would show them in Chrome's user-agent defaults while every automated
 * check passed - which is the exact failure `archive-tlist.css`'s own
 * header records having shipped once already. LOADING A STYLESHEET IS
 * NOT TOUCHING IT: commitment 2 of issue #173 is that none of the twelve
 * archive stylesheets is MODIFIED, and none is.
 */
import '../../client/css/archive-reader.css';
import '../../client/css/archive-chat.css';

/* The three globals the components' props are fed from. */
import '../../client/js/archive-outcome.js';
import '../../client/js/archive-fuzzy.js';
import '../../client/js/modal-stack.js';

import type { OutcomeClassifier } from '../src/lib/plugins/history/index';
import type { FuzzyMatcher, ModalStackLike } from '../src/lib/plugins/history/index';

/** As much of `window` as this module reads back after the imports. */
interface LegacyWindow {
    ArchiveOutcome?: OutcomeClassifier;
    ArchiveFuzzy?: FuzzyMatcher;
    ModalStack?: ModalStackLike;
}

/** The window, typed for the three names above. */
function legacyWindow(): LegacyWindow {
    return globalThis as LegacyWindow;
}

/**
 * The one classifier in the client, as the components' `outcome` prop.
 *
 * Description: THROWS when the module did not load, and does NOT invent
 *   a classification. Answering `ok` for an envelope nobody read would
 *   put a fabricated outcome in front of both components, which is the
 *   failure this codebase keeps paying for. The same refusal
 *   `archive-state-install.ts::lazyOutcome` makes, for the same reason.
 * Inputs: none.
 * Output: OutcomeClassifier.
 * Example: <NavRail {client} outcome={harnessOutcome()} {onSelect} />
 */
export function harnessOutcome(): OutcomeClassifier {
    const found = legacyWindow().ArchiveOutcome;
    if (!found || typeof found.classify !== 'function') {
        throw new ReferenceError(
            '[dev-harness] client/js/archive-outcome.js did not publish '
            + 'window.ArchiveOutcome, so an archive response cannot be '
            + 'classified.');
    }
    return found;
}

/**
 * The client-side fuzzy matcher, for the transcript list's filter boxes.
 *
 * Description: REFUSES WITH null rather than throwing, because the
 *   matcher is an OPTIONAL prop with a named degradation - no matcher
 *   means no client-side filtering and the list still pages and still
 *   renders. A missing classifier is fatal; a missing matcher is a
 *   missing feature, and the two must not be treated alike.
 * Inputs: none.
 * Output: FuzzyMatcher | null.
 * Example: <TranscriptList {client} fuzzy={harnessFuzzy()} ... />
 */
export function harnessFuzzy(): FuzzyMatcher | null {
    const found = legacyWindow().ArchiveFuzzy;
    if (!found || typeof found.rank !== 'function') {
        console.warn('[dev-harness] window.ArchiveFuzzy is unavailable, so the '
            + 'transcript list will page and render but not filter.');
        return null;
    }
    return found;
}

/**
 * The host's modal stack, for the rail's project details modal.
 *
 * Description: REFUSES WITH null, another named degradation - no stack
 *   means the modal paints correctly and loses Escape routing, which is
 *   what `NavInfoModal.svelte` already records.
 * Inputs: none.
 * Output: ModalStackLike | null.
 */
export function harnessModalStack(): ModalStackLike | null {
    const found = legacyWindow().ModalStack;
    if (!found || typeof found.push !== 'function') {
        console.warn('[dev-harness] window.ModalStack is unavailable, so Escape '
            + 'will not close the project details modal.');
        return null;
    }
    return found;
}
