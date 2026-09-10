/**
 * The endpoints the launchpad's session data layer reads, as one object.
 *
 * WHY A HOST AND NOT A DIRECT `window.API` CALL. The store owns four
 * fetches, a join and a 5s tick, and every rule it encodes is a rule
 * about what happens when one of those fetches DOES NOT ANSWER. A store
 * that reached for `window.API` itself could only be tested in a browser,
 * which is precisely where those failure paths are hardest to produce on
 * purpose. Injected, a test hands in a rejection and reads the verdict.
 *
 * `.claude/notes/svelte-migration-launchpad.md` rules out an adapter
 * layer over `api.js`, and this is not one: it is a set of function
 * references with the argument lists `api.js` already has, resolved
 * LAZILY so importing this module touches no global. There is no
 * response reshaping here and there must not be - the merge reads the
 * server's own field names, so a rename in this file would be a
 * translation layer between the wire and 274 lines of field-by-field
 * rules.
 */
import type {
    AttachableSession,
    ProjectAuthority,
    ProjectPresencePayload,
    ProjectRow,
    SessionListItem,
    SessionRecord,
} from './types';
import { hostWindow } from './env';

/** Everything the session store fetches. */
export interface SessionHost {
    getProjects(includeArchived: boolean): Promise<ProjectRow[]>;
    getProjectsPresence(): Promise<ProjectPresencePayload>;
    getProjectsAuthority(): Promise<ProjectAuthority>;
    listAttachableSessions(): Promise<AttachableSession[]>;
    /** Absent on an old single-session server, which is why it is optional. */
    listSessions?(): Promise<SessionListItem[]>;
    getCurrentSession(): Promise<SessionListItem | null>;
    listSessionRecords(): Promise<SessionRecord[]>;
}

/** The subset of `window.API` this layer calls. */
interface LegacyApi {
    getProjects(includeArchived: boolean): Promise<ProjectRow[]>;
    getProjectsPresence(): Promise<ProjectPresencePayload>;
    getProjectsAuthority(): Promise<ProjectAuthority>;
    listAttachableSessions(): Promise<AttachableSession[]>;
    listSessions?(): Promise<SessionListItem[]>;
    getCurrentSession(): Promise<SessionListItem | null>;
    listSessionRecords(): Promise<SessionRecord[]>;
}

/**
 * The host that talks to the running app's `window.API`.
 *
 * Description: RESOLVED PER CALL, not captured at import. `main.ts`
 *   promises that loading the bundle does no work and touches no global,
 *   and a module-scope `window.API` read would break that contract the
 *   way a module-scope `localStorage` read already broke it once - the
 *   node harnesses evaluate this bundle in a sandbox with neither.
 *
 *   `listSessions` is forwarded only when the running `window.API`
 *   actually has it, so the store's back-compat fallback to
 *   `getCurrentSession()` fires on the same condition the legacy
 *   `typeof window.API.listSessions === 'function'` test fired on.
 * Inputs: none.
 * Output: SessionHost.
 * Example: const host = browserSessionHost();
 */
export function browserSessionHost(): SessionHost {
    const api = (): LegacyApi =>
        (hostWindow() as unknown as { API: LegacyApi } | undefined)?.API as LegacyApi;
    const host: SessionHost = {
        getProjects: (includeArchived) => api().getProjects(includeArchived),
        getProjectsPresence: () => api().getProjectsPresence(),
        getProjectsAuthority: () => api().getProjectsAuthority(),
        listAttachableSessions: () => api().listAttachableSessions(),
        getCurrentSession: () => api().getCurrentSession(),
        listSessionRecords: () => api().listSessionRecords(),
    };
    Object.defineProperty(host, 'listSessions', {
        enumerable: true,
        get() {
            const live = api();
            if (live && typeof live.listSessions === 'function') {
                return () => live.listSessions!();
            }
            return undefined;
        },
    });
    return host;
}
