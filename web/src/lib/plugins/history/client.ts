/**
 * The archive read surface, as a GRANTED client. PORTED from
 * `client/js/api-archive.js`, deleted in the same commit.
 *
 * WHAT MOVED AND WHAT DID NOT. Every path this file builds, every
 * camelCase-to-snake_case argument name, every deadline and the
 * never-rejects contract are the same as they were; this is a port, not
 * a redesign. What moved is WHERE THE CAPABILITY COMES FROM. The old
 * file did `Object.assign(API.prototype, ...)`, which gave the archive
 * the whole of `window.API`: a module that can call
 * `/archive/transcripts` could call `/sessions/respawn`. This one holds
 * a `ScreenApi` built from the contribution's declared `apiPrefixes` and
 * can reach nothing else.
 *
 * THE ENFORCEMENT IS NOT IN THIS FILE AND THAT IS THE POINT. Slice 1
 * built and proved it in `../screen-api.ts`: the path is resolved and
 * normalised, then compared to the grant COMPONENT-WISE, then either
 * sent or refused before anything leaves the browser. This slice moves
 * 523 lines of caller ONTO that mechanism and changes nothing about the
 * check itself. A reviewer looking for the security control should read
 * `screen-api.ts`; what to look for HERE is only that nothing reaches
 * the network by some other road, and the answer is that this module
 * imports no `fetch`, no `window` and no `API`.
 *
 * TWO CONTRACTS SURVIVED THE MOVE AND BOTH HAD TO BE RECONCILED BY HAND.
 * `callEnvelope` NEVER REJECTS, because a 404 here carries a complete
 * renderable envelope and a dead network is a finding a screen has to
 * paint. `ScreenApi.call` DOES reject, with a `GrantRefusedError`,
 * because a refusal that resolved would be indistinguishable from an
 * answer. So this file catches that one rejection and turns it into a
 * resolved `EnvelopeResult` carrying `refusedByGrant: true` - the
 * never-rejects contract holds for every caller, and the refusal stays
 * distinguishable from a 404 by a field rather than by a message string.
 * The throw and the console line that `screen-api.ts` produces are
 * untouched; this only decides what the ARCHIVE does with them.
 *
 * NOTHING HERE INTERPRETS `result_status`. That is
 * `archive-outcome.js`'s exclusive business, exactly as before, and the
 * moment a second place branches on it the two branch sets drift.
 */
import type { EnvelopeResult, ScreenApi } from '../types';
import { ARCHIVE_TIMEOUTS, archiveQuery, type ArchiveTimeouts } from './client-query';

/**
 * The route the rail's merged-project list comes from.
 *
 * Named rather than inlined because two routes serve the same node shape
 * and the difference between them is a behaviour, not a spelling:
 * `/archive/projects` is the archive's own names and
 * `/archive/overlay/projects` is those names with the owner's
 * presentation layered on. A reader who finds a bare string at the call
 * site cannot see that a choice was made there.
 */
const MERGED_PROJECTS_ENDPOINT = '/archive/overlay/projects';

/** Options a caller may pass through to one archive call. */
export interface ArchiveCallOptions {
    /**
     * Abort the request after this long. A request with no deadline is a
     * state that can never fail, so every method below sets one.
     */
    readonly timeoutMs?: number;
    /** Anything else the transport understands, passed through. */
    readonly [key: string]: unknown;
}

/** Paging arguments shared by most of the list endpoints. */
export interface PageOptions {
    readonly limit?: number | null;
    readonly cursor?: string | null;
}

/** The thirteen read endpoints, plus the call they all go through. */
export interface ArchiveClient {
    /** The deadline table, by request class. */
    readonly ARCHIVE_TIMEOUTS: ArchiveTimeouts;
    callEnvelope(endpoint: string, options?: ArchiveCallOptions): Promise<EnvelopeResult>;
    listArchiveHosts(): Promise<EnvelopeResult>;
    listArchiveCorpora(hostId: number | string, opts?: PageOptions): Promise<EnvelopeResult>;
    listArchiveProjects(corpusId: number | string, opts?: PageOptions): Promise<EnvelopeResult>;
    listArchiveMergedProjects(): Promise<EnvelopeResult>;
    listArchiveUnattributed(corpusId: number | string, opts?: PageOptions): Promise<EnvelopeResult>;
    listArchiveTranscripts(
        projectId: number | string,
        opts?: PageOptions & { readonly sessionRefScheme?: string | null },
    ): Promise<EnvelopeResult>;
    getArchiveTranscript(transcriptId: number | string): Promise<EnvelopeResult>;
    listArchiveLines(
        transcriptId: number | string, opts?: LineOptions,
    ): Promise<EnvelopeResult>;
    listArchiveMessages(
        transcriptId: number | string,
        opts?: PageOptions & { readonly startLine?: number | null },
    ): Promise<EnvelopeResult>;
    getArchiveBody(bodyId: number | string): Promise<EnvelopeResult>;
    listArchiveSubagents(
        transcriptId: number | string, opts?: PageOptions,
    ): Promise<EnvelopeResult>;
    searchArchive(opts?: SearchOptions): Promise<EnvelopeResult>;
    getArchiveProjectForCwd(cwd: string): Promise<EnvelopeResult>;
    preflightArchiveExport(
        transcriptId: number | string, opts?: { readonly verified?: boolean },
    ): Promise<EnvelopeResult>;
}

/** Arguments to the line spine. camelCase here, snake_case on the wire. */
export interface LineOptions extends PageOptions {
    readonly includeBodies?: boolean | null;
    readonly maxPageBytes?: number | null;
    readonly role?: string | null;
    readonly recordType?: string | null;
    readonly model?: string | null;
    readonly startLine?: number | null;
}

/** Arguments to search. Exactly one scope, unvalidated here on purpose. */
export interface SearchOptions extends PageOptions {
    readonly q?: string | null;
    readonly transcriptId?: number | string | null;
    readonly projectId?: number | string | null;
    readonly corpusId?: number | string | null;
    readonly hostId?: number | string | null;
    readonly caseSensitive?: boolean | null;
}

/**
 * Is this rejection the granted client refusing the path?
 *
 * Description: KEYED ON `name`, NOT ON `instanceof`. The bundle is
 *   minified, so a class name is not a fact about the build that ships,
 *   and `screen-api.ts` sets `name` explicitly for exactly this reason.
 * Inputs: err - whatever rejected.
 * Output: boolean.
 */
function isGrantRefusal(err: unknown): boolean {
    return !!err && typeof err === 'object'
        && (err as { name?: unknown }).name === 'GrantRefusedError';
}

/** The message off an unknown rejection, without assuming it is an Error. */
function messageOf(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
        return String((err as { message: unknown }).message);
    }
    return String(err);
}

/**
 * Build the archive client one screen is granted.
 *
 * Description: a factory taking the granted client rather than a module
 *   reaching for a global, so a test builds one against a double and
 *   never touches `window` - and so the grant this client holds is
 *   visibly the grant the contribution declared.
 * Inputs: api - the `ScreenApi` the host built from `apiPrefixes`.
 * Output: ArchiveClient.
 * Example:
 *   const client = createArchiveClient(api);
 *   const r = await client.getArchiveTranscript(99999);
 *   // r.httpStatus === 404, r.envelope.result_status === 'not_found'
 */
export function createArchiveClient(api: ScreenApi): ArchiveClient {
    /**
     * Perform one archive call and return the envelope WITHOUT throwing.
     *
     * Description: the choke point. Every method below goes through it,
     *   which is what made the capability one wrapper rather than a
     *   rewrite. It resolves on every path there is: the server
     *   answered, the server could not be reached, or the grant refused
     *   the path before anything was sent.
     * Inputs: endpoint - a path under /api/v1, leading slash.
     *   options - `timeoutMs` plus anything the transport reads.
     * Output: Promise<EnvelopeResult>, never rejected.
     */
    async function callEnvelope(
        endpoint: string, options: ArchiveCallOptions = {},
    ): Promise<EnvelopeResult> {
        try {
            const result = await api.call(endpoint, options as Record<string, unknown>);
            return result as EnvelopeResult;
        } catch (err) {
            // THE ONE REJECTION THIS LAYER EXPECTS. The transport
            // resolves every transport outcome itself, so a rejection
            // arriving here is the grant refusing - or something
            // genuinely unforeseen, which is reported as a transport
            // error with its reason kept rather than swallowed.
            const refused = isGrantRefusal(err);
            return {
                envelope: null,
                httpStatus: null,
                headers: null,
                transportError: messageOf(err),
                refusedByGrant: refused,
            };
        }
    }

    const t = ARCHIVE_TIMEOUTS;
    const enc = encodeURIComponent;

    return {
        ARCHIVE_TIMEOUTS: t,
        callEnvelope,

        /** Archive: every host that has contributed transcripts. */
        listArchiveHosts() {
            return callEnvelope('/archive/hosts', { timeoutMs: t.hierarchy });
        },

        /** Archive: the corpora collected from one host. */
        listArchiveCorpora(hostId, { limit, cursor } = {}) {
            const q = archiveQuery({ limit, cursor });
            return callEnvelope(`/archive/hosts/${enc(hostId)}/corpora${q}`,
                                { timeoutMs: t.hierarchy });
        },

        /** Archive: the projects inside one corpus. */
        listArchiveProjects(corpusId, { limit, cursor } = {}) {
            const q = archiveQuery({ limit, cursor });
            return callEnvelope(`/archive/corpora/${enc(corpusId)}/projects${q}`,
                                { timeoutMs: t.hierarchy });
        },

        /**
         * Archive: EVERY project as one list, machine demoted to a field.
         *
         * Takes no limit/cursor: the server does not paginate it,
         * because a page of a merged tree would let a caller conclude a
         * project lives on one machine because the row proving otherwise
         * fell on page 2.
         *
         * IT CALLS THE OVERLAY ROUTE AND NOT `/archive/projects`. Both
         * return the same merged nodes; the overlay adds the owner's
         * presentation - an override name where one exists, the group,
         * hidden projects filtered, and a per-node `overlay` block.
         * Pointed at the raw route the rail renders the archive's own
         * names and every card reports its overlay state as ABSENT,
         * which is honest and is also the owner's rename silently not
         * taking effect. Nothing is lost by moving: every node still
         * carries `archive_display_name`. `/archive/projects` is
         * deliberately still there for anything that wants the
         * archive's own truth.
         */
        listArchiveMergedProjects() {
            return callEnvelope(MERGED_PROJECTS_ENDPOINT, { timeoutMs: t.hierarchy });
        },

        /**
         * Archive: the transcripts in a corpus that belong to NO project.
         *
         * Its own endpoint because a transcript attributed to no project
         * is invisible from the project tree by construction. A thing
         * that cannot appear in an enumeration needs a shape of its own
         * or it is never seen at all.
         */
        listArchiveUnattributed(corpusId, { limit, cursor } = {}) {
            const q = archiveQuery({ limit, cursor });
            return callEnvelope(`/archive/corpora/${enc(corpusId)}/unattributed${q}`,
                                { timeoutMs: t.hierarchy });
        },

        /**
         * Archive: one project's transcripts, cursor-paged.
         *
         * `sessionRefScheme` goes out as `session_ref_scheme` and is a
         * SERVER-SIDE post-filter across the whole project, not a filter
         * of the page. It filters on that column and on nothing else, so
         * a caller must not render it as "these are the conversations".
         * A scheme the archive does not hold answers HTTP 400 with a
         * `cannot_determine` naming the schemes that exist, which is
         * deliberately NOT the same response as a scheme that exists and
         * matches nothing here - that is a 200 with an empty `result`.
         */
        listArchiveTranscripts(projectId, { limit, cursor, sessionRefScheme } = {}) {
            const q = archiveQuery({
                limit, cursor, session_ref_scheme: sessionRefScheme,
            });
            return callEnvelope(`/archive/projects/${enc(projectId)}/transcripts${q}`,
                                { timeoutMs: t.hierarchy });
        },

        /** Archive: one transcript's header record. */
        getArchiveTranscript(transcriptId) {
            return callEnvelope(`/archive/transcripts/${enc(transcriptId)}`,
                                { timeoutMs: t.transcript });
        },

        /**
         * Archive: the line spine of one transcript.
         *
         * `startLine` IS 0-BASED and is MUTUALLY EXCLUSIVE with
         * `cursor`: sending both is HTTP 400 naming `start_line`,
         * because they are two absolute statements about where the page
         * begins. Open a walk with `startLine`, continue it with the
         * `next_cursor` the server hands back. A `startLine` past the
         * last line is HTTP 404 naming that line - never an empty page,
         * which would read as the end of the transcript.
         *
         * NOTE `archiveQuery` DROPS the empty string but KEEPS 0, which
         * is load-bearing here: `startLine: 0` is a real request for the
         * first line and must reach the wire.
         */
        listArchiveLines(transcriptId, {
            limit, cursor, includeBodies, maxPageBytes, role, recordType, model,
            startLine,
        } = {}) {
            const q = archiveQuery({
                limit, cursor,
                start_line: startLine,
                include_bodies: includeBodies,
                max_page_bytes: maxPageBytes,
                role, record_type: recordType, model,
            });
            return callEnvelope(`/archive/transcripts/${enc(transcriptId)}/lines${q}`,
                                { timeoutMs: t.transcript });
        },

        /**
         * Archive: one transcript's turns, shaped for the CHAT view.
         *
         * The reading endpoint, as opposed to the line spine, which is
         * the byte-exact record. IT MAY NOT EXIST: this client shipped
         * alongside the route rather than after it, and a 404 from a
         * route that was never deployed is NOT an empty conversation.
         * Do not "fix" a caller that treats a 404 here as no messages.
         */
        listArchiveMessages(transcriptId, { limit, cursor, startLine } = {}) {
            const q = archiveQuery({ limit, cursor, start_line: startLine });
            return callEnvelope(`/archive/transcripts/${enc(transcriptId)}/messages${q}`,
                                { timeoutMs: t.transcript });
        },

        /**
         * Archive: one message body.
         *
         * The 30 s deadline is deliberately the longest of the read
         * paths: a single body in this corpus measured 54,376,879 bytes,
         * which is a legitimately slow transfer rather than a hung
         * request.
         */
        getArchiveBody(bodyId) {
            return callEnvelope(`/archive/bodies/${enc(bodyId)}`, { timeoutMs: t.body });
        },

        /** Archive: the subagent sessions spawned from one transcript. */
        listArchiveSubagents(transcriptId, { limit, cursor } = {}) {
            const q = archiveQuery({ limit, cursor });
            return callEnvelope(`/archive/transcripts/${enc(transcriptId)}/subagents${q}`,
                                { timeoutMs: t.transcript });
        },

        /**
         * Archive: search, scoped to exactly one of transcript / project
         * / corpus / host.
         *
         * The scope arguments are passed through AS GIVEN rather than
         * validated here: the server answers a two-scope request with a
         * cannot_determine envelope naming the conflict, and that is a
         * better message than anything this client could invent.
         */
        searchArchive({
            q, transcriptId, projectId, corpusId, hostId, limit, cursor, caseSensitive,
        } = {}) {
            const query = archiveQuery({
                q,
                transcript_id: transcriptId,
                project_id: projectId,
                corpus_id: corpusId,
                host_id: hostId,
                limit, cursor,
                case_sensitive: caseSensitive,
            });
            return callEnvelope(`/archive/search${query}`, { timeoutMs: t.search });
        },

        /**
         * Archive: the merged project node whose folder is this
         * directory. The lookup behind the terminal search panel's
         * "Deep dive".
         *
         * A ROUND TRIP RATHER THAN A FIND OVER THE MERGED LIST, because
         * the match is not a string comparison: `~/Development` is a
         * symlink into iCloud on the owner's box, so one directory has
         * several literal spellings and a transcript records whichever
         * was in force. Resolving those needs realpath and the $HOME
         * symlink table, neither of which a browser has.
         *
         * A miss is an `ok` envelope with a null `result`, NOT an error.
         * `meta.matched_by` names the rung that answered.
         */
        getArchiveProjectForCwd(cwd) {
            return callEnvelope(`/archive/projects/for-cwd?cwd=${enc(cwd)}`,
                                { timeoutMs: t.hierarchy });
        },

        /**
         * Archive: read an export's headers without consuming its body.
         *
         * A GET whose body is discarded, not a HEAD: the verified export
         * route computes its sha256 while streaming, and a HEAD would
         * report headers for work the server never did.
         *
         * This does NOT start a download and cannot: the export
         * endpoints are Bearer-only, and a browser navigation or an
         * `<a download>` click sends no Authorization header.
         */
        preflightArchiveExport(transcriptId, { verified } = {}) {
            const suffix = verified ? '/export/verified' : '/export';
            return callEnvelope(`/archive/transcripts/${enc(transcriptId)}${suffix}`,
                                { timeoutMs: t.exportPreflight });
        },
    };
}
