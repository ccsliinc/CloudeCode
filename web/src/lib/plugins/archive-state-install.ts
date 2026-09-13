/**
 * The seam that keeps the still-legacy archive modules working now that
 * state, keys, the help modal and formatting are ported. HOST CODE, AND
 * IT LIVES OUTSIDE `history/` ON PURPOSE.
 *
 * WHY A SEAM AT ALL. Eight modules belonging to slices 3 and 5 to 9 -
 * archive-screen, -nav, -nav-row, -reader, -reader-select, -line-render,
 * -tlist-row and -chat-view - reach `window.ArchiveState`,
 * `window.ArchiveKeys`, `window.ArchiveKeysHelp` and
 * `window.ArchiveFormat`. This slice may not touch them. Deleting the
 * four vanilla files without republishing those four names would break
 * every one.
 *
 * IT IS NOT A DUAL PATH. There is one implementation, in TypeScript,
 * under `history/`; what is published below is the same object the
 * bundle uses, not a copy of it. Each of slices 3 and 5 to 9 deletes the
 * callers it owns, and when the last one goes so does this file - the
 * same arrangement `archive-api-install.ts` has for the archive client.
 *
 * IT IS WHERE THE TWO INJECTIONS ARE SUPPLIED, WHICH IS THE REASON THIS
 * IS HOST CODE RATHER THAN AN EXPORT FROM INSIDE. `state.ts` needs
 * `archive-outcome.js`'s classifier and `keys-help.ts` needs the host's
 * `ModalStack`; both are globals belonging to code outside this
 * directory, and `import-direction.test.ts` refuses a named host global
 * inside `history/`. The dependency arrow points outward: the ported
 * modules declare the shape they need, and this file - which is allowed
 * to know `window` exists - hands them the real thing.
 *
 * BOTH ARE RESOLVED LAZILY, AT CALL TIME. `client/dist/app.js` is a
 * deferred module and the legacy IIFEs are classic scripts, so they have
 * all run by the time this evaluates - but `ModalStack` in particular is
 * published by a file whose position is not this module's business.
 * Reading them inside the functions is what makes the order irrelevant.
 */
import { createArchiveState, type OutcomeClassifier } from './history/index';
import { archiveFormat, openHelp, buildHelpTable, HELP_MODAL_ATTR,
         HELP_MODAL_NAME, HELP_ROOT_CLASS, HELP_CLOSE_ACTION,
         type ModalStackLike, type OpenHelpOptions } from './history/index';
import { ACTIONS, NAMED_KEYS, PLAIN_KEYS, bindings, createSelection,
         hasCommandModifier, resolve, resolveEscape } from './history/index';
import { seamWarn } from './seam-warn';

/** The four names the legacy archive modules reach for. */
export const ARCHIVE_GLOBAL_NAMES = [
    'ArchiveState', 'ArchiveKeys', 'ArchiveKeysHelp', 'ArchiveFormat',
] as const;

/** As much of `window` as this seam reads and writes. */
interface SeamWindow {
    ArchiveOutcome?: OutcomeClassifier;
    ModalStack?: ModalStackLike;
    [name: string]: unknown;
}

/**
 * A classifier that REFUSES rather than guesses when
 * `archive-outcome.js` has not loaded.
 *
 * Description: the vanilla reducer called `window.ArchiveOutcome.classify`
 *   inline and would have thrown a bare TypeError if the module were
 *   missing - an error naming the wrong cause, from inside a reducer.
 *   This names the missing module instead. It does NOT invent a
 *   classification: answering `ok` for an envelope nobody read would put
 *   a fabricated outcome into the one object the whole screen renders
 *   from, which is worse than a loud failure by exactly the margin this
 *   codebase keeps paying for.
 * Inputs: win - the window to read the real classifier off, at call time.
 * Output: OutcomeClassifier.
 */
function lazyOutcome(win: () => SeamWindow | null): OutcomeClassifier {
    function real(): OutcomeClassifier {
        const found = win()?.ArchiveOutcome;
        if (!found || typeof found.classify !== 'function') {
            throw new ReferenceError(
                'archive-outcome.js is not loaded, so an archive response '
                + 'cannot be classified. It is a member of the ARCHIVE lazy '
                + 'family in client/js/module-families.js.');
        }
        return found;
    }
    return {
        classify: (envelope) => real().classify(envelope),
        isRenderable: (token) => real().isRenderable(token),
        hasMore: (envelope) => real().hasMore(envelope),
    };
}

/**
 * Publish the four archive globals the legacy tree still reaches for.
 *
 * Description: idempotent - calling twice republishes the same objects
 *   and accumulates nothing. It OVERWRITES rather than merging, because
 *   each name has exactly one owner and a half-legacy half-ported object
 *   would be the dual path this migration forbids.
 * Inputs: target - the window to publish onto; the real one when absent.
 * Output: the names actually published.
 * Example: installArchiveGlobals();
 *          window.ArchiveKeys.resolve({key: 'j'}, {});  // 'next-row'
 */
export function installArchiveGlobals(
    target?: SeamWindow | null,
): readonly string[] {
    // NAMED `root` DELIBERATELY. `tests/test_client_cross_references.node.mjs`
    // scans for `window.X =`, `globalThis.X =`, `global.X =` or `root.X =`
    // to decide whether a global a client script READS is one anything
    // PUBLISHES. Assigning through a differently-named local would hide
    // these four publications from that guard, which would then report
    // eight legacy modules as reading globals nothing provides - a true
    // alarm about a false fact. `root` is the name that tree already uses
    // for exactly this.
    const root = target
        || (typeof window !== 'undefined' ? (window as unknown as SeamWindow) : null);
    if (!root) {
        seamWarn('[plugins] there is no window to publish the archive '
                     + 'globals onto; the legacy archive modules will not find them.');
        return [];
    }
    const win = () => root;

    root.ArchiveState = createArchiveState(lazyOutcome(win));

    root.ArchiveKeysHelp = {
        /**
         * The host's ModalStack is supplied HERE, so `keys-help.ts` never
         * names a global. A caller may still pass its own, which is what
         * a test does.
         */
        openHelp: (options?: OpenHelpOptions) => openHelp({
            modalStack: win().ModalStack || null,
            ...(options || {}),
        }),
        buildHelpTable,
        HELP_MODAL_ATTR,
        HELP_MODAL_NAME,
        HELP_ROOT_CLASS,
        HELP_CLOSE_ACTION,
    };

    root.ArchiveKeys = {
        resolve,
        resolveEscape,
        bindings,
        createSelection,
        hasCommandModifier,
        ACTIONS,
        PLAIN_KEYS,
        NAMED_KEYS,
        // RE-ATTACHED FOR THE LEGACY CALLERS, and only for them. Inside
        // the bundle `keys.ts` imports `keys-help.ts` directly, so the
        // vanilla file's load-order guard is a branch that can no longer
        // fire and was not ported. Every existing caller and test holds
        // `ArchiveKeys.openHelp`, so the NAME stays here.
        openHelp: (options?: OpenHelpOptions) => openHelp({
            modalStack: win().ModalStack || null,
            ...(options || {}),
        }),
        HELP_MODAL_ATTR,
        HELP_MODAL_NAME,
    };

    root.ArchiveFormat = archiveFormat;

    return ARCHIVE_GLOBAL_NAMES.slice();
}
