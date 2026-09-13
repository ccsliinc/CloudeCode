/**
 * The seam that keeps the still-legacy archive modules working while
 * the ported client is the only implementation. HOST CODE, AND IT LIVES
 * OUTSIDE `history/` ON PURPOSE.
 *
 * WHY A SEAM AT ALL. `client/js/api-archive.js` put thirteen methods on
 * `API.prototype`, and twelve modules that belong to slices 3 and 5 to 9
 * call them as `api.listArchiveHosts()` on `window.API` - twenty-five
 * call sites this slice may not touch. Deleting the file without putting
 * the methods back would break every one of them.
 *
 * THIS IS NOT A DUAL PATH, AND THE DIFFERENCE IS WHAT "NO DUAL PATH"
 * MEANS. A dual path is two IMPLEMENTATIONS, which drift. There is one
 * implementation, in `history/client.ts`, in TypeScript, holding a
 * declared grant; what is installed below is DELEGATION and nothing
 * else - no path is built here, no parameter is renamed here, no
 * deadline is chosen here. Each of slices 3 and 5 to 9 deletes the call
 * sites it owns, and when the last one goes, so does this file. That is
 * the same seam `window.CloudeWeb` has been for every earlier slice,
 * pointed at `window.API` because that is where these particular callers
 * already hold their reference.
 *
 * EVERY INSTALLED METHOD GOES THROUGH THE GRANT. That is the whole
 * security claim of this slice and it is the thing to check when reading
 * this file: nothing below calls `fetch`, and nothing below reaches the
 * transport except through the `ArchiveClient` it was handed, which
 * reaches it only through `ScreenApi.call`. A legacy module that now
 * calls `api.getArchiveBody(7)` is, from this commit, making a call the
 * host checked against `['/archive', '/features']` - which is strictly
 * MORE contained than what it had before, when it held the whole of
 * `window.API`.
 *
 * `API.prototype` AND NOT THE INSTANCE, matching what `api-archive.js`
 * did. `window.API` is one instance built at the end of `api.js` and
 * roughly a hundred existing call sites hold it; extending the prototype
 * leaves every one of them, and the app's single refresh mutex,
 * untouched.
 */
import type { ArchiveClient } from './history/index';

/** The methods this seam publishes, in the order `api-archive.js` had them. */
const METHOD_NAMES = [
    'callEnvelope',
    'listArchiveHosts',
    'listArchiveCorpora',
    'listArchiveProjects',
    'listArchiveMergedProjects',
    'listArchiveUnattributed',
    'listArchiveTranscripts',
    'getArchiveTranscript',
    'listArchiveLines',
    'listArchiveMessages',
    'getArchiveBody',
    'listArchiveSubagents',
    'searchArchive',
    'getArchiveProjectForCwd',
    'preflightArchiveExport',
] as const;

/** One installed method name. */
export type ArchiveMethodName = (typeof METHOD_NAMES)[number];

/** The names, for a test to assert against rather than re-list. */
export const ARCHIVE_METHOD_NAMES: readonly ArchiveMethodName[] = METHOD_NAMES;

/** What the installer writes onto, i.e. `window.API`'s constructor. */
interface ApiConstructor {
    prototype: Record<string, unknown>;
}

/**
 * Install the archive read surface onto a constructor's prototype.
 *
 * Description: A NAMED REFUSAL, NEVER A THROW, when there is nothing to
 *   install onto. `client/dist/app.js` is a deferred module and `api.js`
 *   is a classic script, so the constructor is there by the time this
 *   runs - but a page that failed to load `api.js` must get one warning
 *   naming the cause rather than a module-level exception that takes the
 *   whole bundle down, including the parts that have nothing to do with
 *   the archive.
 *
 *   IT IS IDEMPOTENT. Installing twice writes the same delegating
 *   functions over themselves; nothing accumulates and no state is held.
 * Inputs: ctor - the API constructor, or null/undefined. client - the
 *   granted archive client every method delegates to.
 * Output: true when the methods were installed, false when refused.
 * Example: installArchiveApi(window.API?.constructor, client);
 */
export function installArchiveApi(
    ctor: ApiConstructor | null | undefined, client: ArchiveClient,
): boolean {
    if (!ctor || !ctor.prototype) {
        console.warn(
            '[plugins] the API constructor is not available, so the archive '
            + 'read surface was not installed. The archive screen will report '
            + 'that it could not reach the server.');
        return false;
    }
    if (!client) {
        console.warn('[plugins] no archive client was built, so the archive '
                     + 'read surface was not installed.');
        return false;
    }

    const proto = ctor.prototype;
    for (const name of METHOD_NAMES) {
        // BOUND TO THE CLIENT, NOT TO THE API INSTANCE. The method must
        // run against the granted client whatever `this` is at the call
        // site, and the legacy callers all invoke it as `api.method()`,
        // which would otherwise rebind `this` to the API instance and
        // put the ungranted client back in reach.
        const fn = client[name] as (...args: unknown[]) => unknown;
        proto[name] = (...args: unknown[]) => fn.apply(client, args);
    }
    // The deadline table, which legacy callers read as
    // `api.ARCHIVE_TIMEOUTS.<class>` when they call `callEnvelope`
    // directly. It moved out of `api.js`'s constructor in this commit,
    // so this is its only definition reaching the legacy tree.
    proto.ARCHIVE_TIMEOUTS = client.ARCHIVE_TIMEOUTS;
    return true;
}

/**
 * Install onto whatever `window.API` was built from.
 *
 * Description: resolved LAZILY at call time for the same reason
 *   `api-transport.ts` resolves its globals lazily - depending on a
 *   script tag's position at import time is a dependency on a file that
 *   does not import this one.
 * Inputs: client - the granted archive client.
 * Output: true when installed.
 * Example: installArchiveApiOnWindow(history.client);
 */
export function installArchiveApiOnWindow(client: ArchiveClient): boolean {
    const g = globalThis as { API?: { constructor?: ApiConstructor } };
    const instance = g.API;
    const ctor = instance ? (instance.constructor as ApiConstructor) : null;
    return installArchiveApi(ctor, client);
}
