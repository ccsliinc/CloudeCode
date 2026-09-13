/**
 * A warning that cannot take the bundle down.
 *
 * WHY THIS EXISTS, AND IT IS A DEFECT THIS SLICE PAID FOR. The seam
 * installers run at MODULE LOAD - `main.ts` calls them as the bundle
 * evaluates - and each warns by name when the thing it installs onto is
 * absent, which is right: a silent no-op is the hardest defect to trace.
 * But `console.warn` is not guaranteed to exist. A host may supply a
 * partial console, and one really does:
 * `tests/test_session_row_menu_superset.node.mjs` runs the REAL compiled
 * bundle in a vm whose console is `{ log() {} }`, deliberately, so that
 * its assertions are about the shipped path rather than a fixture. A
 * bare `console.warn` there threw a TypeError DURING BUNDLE EVALUATION,
 * so nothing after the call site was defined and all sixteen of that
 * suite's cases failed - none of them about the archive.
 *
 * THE MEASUREMENT THAT MISSED IT IS THE LESSON. Slice 2's node run was
 * taken BEFORE its rebuild, so it read the previous bundle and reported
 * 200 of 200 passing. The suite that catches this is the one that loads
 * `client/dist/app.js` itself, so it can only ever be as current as the
 * artifact on disk. REBUILD BEFORE THE NODE RUN, not after.
 *
 * So a diagnostic must never be able to break the thing it is
 * diagnosing. This checks the method before calling it and is otherwise
 * exactly `console.warn`.
 */

/** As much of a console as this needs, all of it optional. */
interface MaybeConsole {
    warn?: (...args: unknown[]) => void;
    log?: (...args: unknown[]) => void;
}

/**
 * Warn, if the host can be warned.
 *
 * Description: prefers `console.warn`, falls back to `console.log`, and
 *   does nothing at all when neither is callable. Doing nothing is the
 *   correct last resort: the alternative is throwing out of a diagnostic
 *   path, which converts a message about a missing optional dependency
 *   into a dead bundle.
 * Inputs: message - the sentence, which should name what was unavailable
 *   and what the user will see as a result.
 * Output: void.
 * Example: seamWarn('[plugins] the API client is not loaded; ...');
 */
export function seamWarn(message: string): void {
    const c = (globalThis as { console?: MaybeConsole }).console;
    if (!c) return;
    if (typeof c.warn === 'function') { c.warn(message); return; }
    if (typeof c.log === 'function') c.log(message);
}
