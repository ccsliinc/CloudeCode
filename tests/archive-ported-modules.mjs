// THE PORTED ARCHIVE MODULES, LOADED FOR A NODE SUITE WHOSE SUBJECT IS
// SOMETHING ELSE.
//
// WHY THIS EXISTS. `client/js/archive-state.js`, `archive-keys.js`,
// `archive-keys-help.js` and `archive-format.js` are now
// `web/src/lib/plugins/history/` and are compiled into
// `client/dist/app.js` rather than loaded as classic scripts. Nineteen
// node suites used to `vm`-load one of those four purely as a
// COLLABORATOR - they are about the nav rail, the reader, the transcript
// list, search or export, and they needed something on `window` for
// those subjects to talk to.
//
// Those suites did not lose their subject, so they did not move. What
// they need is the four globals, and this installs them.
//
// IT IS NOT A DOUBLE, WHICH IS THE WHOLE POINT AND IS WHY IT LOOKS LIKE
// THIS. `tests/archive-seam-stub.mjs` - the slice 1 equivalent - is a
// recorder, and that is right for a seam whose job is to be called. It
// is WRONG here: measured before this file was written, by swapping a
// marker double in and running all nineteen suites, THREE of them
// (test_archive_nav_cards, test_archive_nav_list,
// test_archive_reader_shell) assert on rendered text that real
// formatting produces. A double would have to reproduce formatBytes to
// keep them green, which is a second implementation of the thing this
// slice exists to make singular. So this loads the REAL modules and the
// collaborator behaviour is unchanged by construction.
//
// HOW IT LOADS TYPESCRIPT. Node 26 strips types natively, so it can
// EXECUTE these modules; what it cannot do is FIND them, because
// `web/src` is written for Vite, which resolves an extensionless
// relative import against a list of extensions. `registerHooks` below
// closes exactly that gap: it appends an extension to a relative
// specifier that did not otherwise resolve, and defers to the default
// resolver in every other case. No transform, no configuration, and a
// module node can already find is untouched.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Extensions tried, in the order Vite tries them. */
const EXTENSIONS = ['.ts', '.js', '/index.ts', '/index.js'];

/** Registered once per process, however many suites import this file. */
let hooked = false;

/** Teach node to resolve `./foo` to `./foo.ts`, and nothing else. */
function ensureHook() {
    if (hooked) return;
    hooked = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            try {
                return nextResolve(specifier, context);
            } catch (err) {
                if (!specifier.startsWith('.') || !context.parentURL) throw err;
                for (const ext of EXTENSIONS) {
                    const candidate = new URL(specifier + ext, context.parentURL);
                    if (existsSync(fileURLToPath(candidate))) {
                        return nextResolve(specifier + ext, context);
                    }
                }
                throw err;
            }
        },
    });
}

/** The loaded public shape, memoised so N suites do one import. */
let loaded = null;

/**
 * Load the history plugin's public shape.
 *
 * Description: imports `history/index.ts`, which is the ONE module
 *   anything outside the directory may take - the same boundary
 *   `import-direction.test.ts` pins for `web/src`. A suite that reached
 *   `history/state.ts` directly would be asserting against a private
 *   module and would silently start failing the day it moved.
 * Inputs: none. Output: Promise of the module namespace.
 */
export async function loadHistoryModules() {
    if (loaded) return loaded;
    ensureHook();
    loaded = await import('../web/src/lib/plugins/history/index.ts');
    return loaded;
}

/**
 * Load the modules once and hand back a SYNCHRONOUS installer.
 *
 * Description: two steps rather than one async call, because the vm
 *   context in these suites is built inside an ordinary (non-async)
 *   helper function, and an `await` there would mean making every one of
 *   them async and every caller await it. A suite awaits this ONCE at
 *   the top of the file and then installs synchronously wherever it
 *   builds a context.
 *
 *   THE TWO INJECTIONS ARE READ OFF THE CONTEXT'S OWN WINDOW AT CALL
 *   TIME, not captured here: a suite that vm-loads `archive-outcome.js`
 *   beside this gets the real classifier, and one that does not gets the
 *   same named refusal the browser gives. Same for `ModalStack`.
 * Inputs: none. Output: Promise of `(contextWindow) => void`.
 * Example:
 *   const installArchiveGlobals = await archiveGlobalsInstaller();
 *   // ... later, inside the ordinary helper that builds the context:
 *   installArchiveGlobals(fakeWindow);
 */
export async function archiveGlobalsInstaller() {
    const m = await loadHistoryModules();

    return function install(contextWindow) {
        contextWindow.ArchiveFormat = m.archiveFormat;

        contextWindow.ArchiveState = m.createArchiveState({
            classify: (e) => contextWindow.ArchiveOutcome.classify(e),
            isRenderable: (t) => contextWindow.ArchiveOutcome.isRenderable(t),
            hasMore: (e) => contextWindow.ArchiveOutcome.hasMore(e),
        });

        const openHelp = (options) => m.openHelp({
            modalStack: contextWindow.ModalStack || null, ...(options || {}) });

        contextWindow.ArchiveKeysHelp = {
            openHelp,
            buildHelpTable: m.buildHelpTable,
            HELP_MODAL_ATTR: m.HELP_MODAL_ATTR,
            HELP_MODAL_NAME: m.HELP_MODAL_NAME,
            HELP_ROOT_CLASS: m.HELP_ROOT_CLASS,
            HELP_CLOSE_ACTION: m.HELP_CLOSE_ACTION,
        };

        contextWindow.ArchiveKeys = {
            resolve: m.resolve,
            resolveEscape: m.resolveEscape,
            bindings: m.bindings,
            createSelection: m.createSelection,
            hasCommandModifier: m.hasCommandModifier,
            ACTIONS: m.ACTIONS,
            PLAIN_KEYS: m.PLAIN_KEYS,
            NAMED_KEYS: m.NAMED_KEYS,
            openHelp,
            HELP_MODAL_ATTR: m.HELP_MODAL_ATTR,
            HELP_MODAL_NAME: m.HELP_MODAL_NAME,
        };
    };
}
