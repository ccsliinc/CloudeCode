/**
 * The archive read surface: the URL each method builds, the one contract
 * `callEnvelope` has to hold, and THE MIGRATED CALLERS GOING THROUGH THE
 * GRANT.
 *
 * PORTED from `tests/test_archive_api_calls.node.mjs`, deleted in the
 * same commit. Every case in that file is here, with its reason kept.
 * What is ADDED is the last section, and it is the load-bearing part of
 * this slice: slice 1 proved the grant MECHANISM four ways against
 * `createScreenApi` directly, so proving it again would prove nothing
 * new. What was unproven until now is that the thirteen ported methods
 * ACTUALLY REACH IT - a client that built its own fetch, or that checked
 * the grant after sending, would pass every positive case above and be
 * exactly the unbounded access this slice exists to remove.
 *
 * SO THE NEGATIVE CONTROLS HERE DRIVE REAL METHODS, NEVER `call`
 * DIRECTLY, and each asserts that THE TRANSPORT WAS NEVER INVOKED as
 * well as what came back. The return value alone is not enough: a client
 * that sent the request and then refused the response would satisfy an
 * assertion about the result and would still have leaked the call.
 *
 * NO NETWORK, and the URL is asserted rather than the behaviour, because
 * two parameter names differ between the argument list and the wire
 * (`includeBodies` -> `include_bodies`, `recordType` -> `record_type`)
 * and a mismatch there does not error: the server ignores the unknown
 * query parameter and answers a perfectly good envelope for a filter
 * nobody applied. That is a false green with no visible symptom.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createArchiveClient } from './client';
import { ARCHIVE_TIMEOUTS, archiveQuery } from './client-query';
import { createScreenApi } from '../screen-api';
import { API_PREFIXES } from './screen';
import type { EnvelopeResult } from '../types';

/** Where the shared archive envelope fixtures live. */
const FIXTURES = path.join(process.cwd(), '..', 'tests', 'fixtures', 'archive');

/** Read one committed envelope fixture. */
function fixture(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** What a transport double was asked to do. */
interface Recorded {
    readonly path: string;
    readonly init: Record<string, unknown> | undefined;
}

/**
 * Build a client on a recording transport, granted what the contribution
 * declares.
 *
 * Description: the grant is `API_PREFIXES` itself, imported rather than
 *   retyped, so this suite cannot pass against a grant the shipping
 *   contribution does not actually declare.
 * Inputs: result - what the transport resolves to.
 * Output: {client, calls}.
 */
function granted(result: Partial<EnvelopeResult> = {}) {
    const calls: Recorded[] = [];
    const api = createScreenApi(API_PREFIXES, (p, init) => {
        calls.push({ path: p, init });
        return Promise.resolve({
            envelope: { result_status: 'ok' }, httpStatus: 200, headers: null,
            transportError: null, refusedByGrant: false, ...result,
        });
    }, 'history-screen');
    return { client: createArchiveClient(api), calls };
}

/**
 * Build a client whose transport REJECTS, to stand in for a bug.
 * Used only to prove the never-rejects contract is total.
 */
function rejecting(err: unknown) {
    const api = createScreenApi(API_PREFIXES, () => Promise.reject(err), 'history-screen');
    return createArchiveClient(api);
}

/**
 * The two project listings each make a SECOND request, deliberately.
 *
 * Neither `/archive/overlay/projects` nor `/archive/corpora/{id}/
 * projects` carries the app database's name for a project - measured
 * against the live databases 2026-09-19, 0 of 100 rows on each - while
 * `/archive/projects` carries it on 100 of 100 and is read by no view.
 * So those two methods read the decorated route as well and join on
 * `project_id`. See `nav-app-name-join.ts`.
 *
 * Named here rather than allowed by a loosened count, so the extra call
 * is a recorded decision and any OTHER method growing one still fails.
 */
/**
 * Call one method and return the path it requested for its OWN data.
 *
 * Description: exactly one call, except for the two methods that join
 *   the app-name route, which make exactly two - and the extra one is
 *   asserted to be that route and no other.
 */
async function pathFor(
    fn: (c: ReturnType<typeof createArchiveClient>) => Promise<unknown>,
): Promise<string> {
    const { client, calls } = granted();
    await fn(client);
    const own = calls.filter((c) => c.path !== JOINS_APP_NAMES);
    expect(own.length,
           `expected exactly one call for the method's own data, saw `
           + `${calls.length}: ${calls.map((c) => c.path).join(', ')}`).toBe(1);
    expect(calls.length - own.length,
           'a method may make at most ONE app-name join call').toBeLessThanOrEqual(1);
    return own[0]!.path;
}

/** Every path the grant resolves to is absolute under this base. */
const BASE = '/api/v1';

const JOINS_APP_NAMES = `${BASE}/archive/projects`;

describe('the path each method builds', () => {
    test('every archive method builds the documented path', async () => {
        const cases: [(c: ReturnType<typeof createArchiveClient>) => Promise<unknown>, string][] = [
            [(a) => a.listArchiveHosts(), `${BASE}/archive/hosts`],
            [(a) => a.listArchiveCorpora(1), `${BASE}/archive/hosts/1/corpora`],
            [(a) => a.listArchiveProjects(2), `${BASE}/archive/corpora/2/projects`],
            [(a) => a.listArchiveUnattributed(2), `${BASE}/archive/corpora/2/unattributed`],
            [(a) => a.listArchiveTranscripts(12), `${BASE}/archive/projects/12/transcripts`],
            [(a) => a.getArchiveTranscript(5767), `${BASE}/archive/transcripts/5767`],
            [(a) => a.listArchiveLines(4), `${BASE}/archive/transcripts/4/lines`],
            [(a) => a.listArchiveMessages(4), `${BASE}/archive/transcripts/4/messages`],
            [(a) => a.getArchiveBody(87), `${BASE}/archive/bodies/87`],
            [(a) => a.listArchiveSubagents(4), `${BASE}/archive/transcripts/4/subagents`],
            [(a) => a.searchArchive({ q: 'x' }), `${BASE}/archive/search?q=x`],
            [(a) => a.preflightArchiveExport(4), `${BASE}/archive/transcripts/4/export`],
            [(a) => a.preflightArchiveExport(4, { verified: true }),
                `${BASE}/archive/transcripts/4/export/verified`],
        ];
        for (const [fn, expected] of cases) {
            expect(await pathFor(fn)).toBe(expected);
        }
    });

    test('the merged project list is fetched from the OVERLAY route', async () => {
        // THE RAIL IS THE ONLY WAY INTO THE ARCHIVE, and it paints from
        // this one call. Pointed at `/archive/projects` every card
        // renders the archive's own name and reports its overlay state
        // as absent, which is honest and is also the owner's rename
        // silently not applying - a failure with no error anywhere in
        // it. Pinned here because the difference between the two routes
        // is invisible at the call site: both return the same node shape
        // and both answer 200.
        expect(await pathFor((a) => a.listArchiveMergedProjects()))
            .toBe(`${BASE}/archive/overlay/projects`);
        expect(await pathFor((a) => a.listArchiveMergedProjects()))
            .not.toBe(`${BASE}/archive/projects`);
    });

    test('the two project listings ALSO read the decorated route, and '
        + 'the index is fetched once per client rather than once per '
        + 'call', async () => {
        // The overlay route and the per-corpus route carry no
        // `app_name_source` at all, so without this second read every
        // card in every view draws its slug. That is the defect this
        // join exists for, and it is pinned as two named paths rather
        // than as a call count, because a count says nothing about
        // WHICH route grew.
        const { client, calls } = granted();
        await client.listArchiveMergedProjects();
        expect(calls.map((c) => c.path).sort()).toEqual([
            `${BASE}/archive/overlay/projects`,
            JOINS_APP_NAMES,
        ].sort());

        // THE MEMO IS THE WHOLE COST CONTROL. Three more listings, and
        // the decorated route is not read again: the by-machine tree
        // expands a level at a time and would otherwise pay for this on
        // every corpus.
        await client.listArchiveMergedProjects();
        await client.listArchiveProjects(2);
        await client.listArchiveProjects(3);
        expect(calls.filter((c) => c.path === JOINS_APP_NAMES)).toHaveLength(1);
    });

    test('NO OTHER method reads the app-name route, so the join stays '
        + 'where it was put', async () => {
        const { client, calls } = granted();
        await client.listArchiveHosts();
        await client.listArchiveTranscripts(12);
        await client.getArchiveTranscript(5767);
        await client.listArchiveUnattributed(2);
        expect(calls.filter((c) => c.path === JOINS_APP_NAMES)).toHaveLength(0);
    });

    test('the RAW project route stays addressable', () => {
        // Two routes answer two questions. This asserts the raw one was
        // not deleted or redirected when the rail moved off it - a
        // regression that would leave nothing able to report the
        // archive's own names.
        const source = fs.readFileSync(
            path.join(process.cwd(), '..', 'src', 'api', 'archive_routes.py'), 'utf8');
        expect(source, 'GET /archive/projects is gone from archive_routes.py; the raw '
            + 'archive names are no longer addressable by anything')
            .toContain('"/archive/projects"');
    });

    test('paging params serialize, and unset params never reach the wire', async () => {
        expect(await pathFor((a) => a.listArchiveTranscripts(12, { limit: 50 })))
            .toBe(`${BASE}/archive/projects/12/transcripts?limit=50`);
        expect(await pathFor((a) => a.listArchiveTranscripts(12, { limit: 50, cursor: 'abc' })))
            .toBe(`${BASE}/archive/projects/12/transcripts?limit=50&cursor=abc`);
        // A null that reaches the wire as `cursor=null` is a malformed
        // cursor, and the server answers cannot_determine for it - a
        // third outcome this client would have inflicted on itself.
        expect(await pathFor((a) => a.listArchiveTranscripts(12, { limit: 50, cursor: null })))
            .toBe(`${BASE}/archive/projects/12/transcripts?limit=50`);
    });

    test('camelCase arguments reach the wire under their snake_case names', async () => {
        const url = await pathFor((a) => a.listArchiveLines(4, {
            limit: 3, includeBodies: true, maxPageBytes: 1048576,
            role: 'user', recordType: 'file-history-snapshot', model: 'opus',
        }));
        expect(url).toBe(`${BASE}/archive/transcripts/4/lines`
            + '?limit=3&include_bodies=true&max_page_bytes=1048576'
            + '&role=user&record_type=file-history-snapshot&model=opus');
        expect(url, 'a camelCase name leaked onto the wire, where the server would '
            + 'ignore it and answer for a filter nobody applied')
            .not.toContain('includeBodies');
    });

    test('startLine reaches the wire as start_line, and 0 SURVIVES', async () => {
        expect(await pathFor((a) => a.listArchiveLines(5767, { limit: 200, startLine: 7111 })))
            .toBe(`${BASE}/archive/transcripts/5767/lines?limit=200&start_line=7111`);
        // The trap this asserts against: `archiveQuery` drops '' as well
        // as null/undefined, and a falsy-value check written as
        // `if (!value)` would drop 0 too. start_line=0 is a REAL request
        // for the first line, and dropping it silently returns an
        // unpositioned page that happens to look right.
        expect(await pathFor((a) => a.listArchiveLines(5767, { startLine: 0 })))
            .toContain('start_line=0');
        expect(await pathFor((a) => a.listArchiveLines(5767, { limit: 5 })))
            .not.toContain('start_line');
    });

    test('sessionRefScheme reaches the wire as session_ref_scheme', async () => {
        expect(await pathFor(
            (a) => a.listArchiveTranscripts(12, { limit: 50, sessionRefScheme: 'uuid' })))
            .toBe(`${BASE}/archive/projects/12/transcripts?limit=50&session_ref_scheme=uuid`);
        const url = await pathFor((a) => a.listArchiveTranscripts(12, { limit: 50 }));
        expect(url, 'an unset filter must be an OMITTED parameter; sending an empty or '
            + 'literal value would be an unknown scheme and answer 400')
            .not.toContain('session_ref_scheme');
        expect(url).not.toContain('sessionRefScheme');
    });

    test('search maps every scope argument to its wire name', async () => {
        expect(await pathFor((a) => a.searchArchive({ q: 'restic', projectId: 12, limit: 3 })))
            .toBe(`${BASE}/archive/search?q=restic&project_id=12&limit=3`);
        expect(await pathFor((a) => a.searchArchive({
            q: 'a b', transcriptId: 5767, corpusId: 1, hostId: 2,
            cursor: 'cur', caseSensitive: true })))
            .toBe(`${BASE}/archive/search?q=a%20b&transcript_id=5767&corpus_id=1`
                + '&host_id=2&cursor=cur&case_sensitive=true');
    });

    test('path segments and query values are encoded', async () => {
        expect(await pathFor((a) => a.searchArchive({ q: 'a&b=c d/e' })))
            .toBe(`${BASE}/archive/search?q=a%26b%3Dc%20d%2Fe`);
        // A traversal attempt in a PATH SEGMENT is encoded, so it is a
        // literal segment rather than a climb - and the grant check
        // normalises before comparing anyway, so neither layer relies on
        // the other. Both are asserted; see the containment block below.
        expect(await pathFor((a) => a.listArchiveCorpora('1/../2')))
            .toBe(`${BASE}/archive/hosts/1%2F..%2F2/corpora`);
    });

    test('every path this client builds exists in the server route table', () => {
        // An independent measurement rather than a restatement of what
        // the client already believes: the route templates are read out
        // of the FastAPI source, so a client path that ages into a lie
        // fails here instead of answering 404 at runtime.
        const routes = new Set<string>();
        const apiDir = path.join(process.cwd(), '..', 'src', 'api');
        for (const f of fs.readdirSync(apiDir)) {
            if (!/^archive.*\.py$/.test(f)) continue;
            const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
            for (const m of src.matchAll(/@router\.(?:get|post|head)\("([^"]+)"/g)) {
                routes.add(m[1]!.replace(/\{[^}]+\}/g, '*'));
            }
        }
        expect(routes.size, `only found ${routes.size} archive routes in src/api`)
            .toBeGreaterThanOrEqual(12);
        const built = [
            '/archive/hosts', '/archive/hosts/1/corpora', '/archive/corpora/2/projects',
            '/archive/corpora/2/unattributed', '/archive/projects/12/transcripts',
            '/archive/transcripts/5767', '/archive/transcripts/4/lines',
            '/archive/bodies/87', '/archive/transcripts/4/subagents', '/archive/search',
            '/archive/transcripts/4/export', '/archive/transcripts/4/export/verified',
        ];
        for (const url of built) {
            const generic = url.replace(/\/\d+/g, '/*');
            expect(routes.has(generic),
                `the client builds ${url} but the server declares no such route`).toBe(true);
        }
    });
});

describe('the deadline table', () => {
    test('every request class carries the declared deadline', () => {
        expect(ARCHIVE_TIMEOUTS.hierarchy).toBe(10000);
        expect(ARCHIVE_TIMEOUTS.transcript).toBe(15000);
        expect(ARCHIVE_TIMEOUTS.body).toBe(30000);
        expect(ARCHIVE_TIMEOUTS.search).toBe(45000);
        expect(ARCHIVE_TIMEOUTS.exportPreflight).toBe(20000);
    });

    test('every method sends a deadline, so no view can wait forever', async () => {
        const { client, calls } = granted();
        await client.listArchiveHosts();
        expect(calls[0]!.init?.timeoutMs, 'a request with no deadline is a state that can '
            + 'never fail, so the loading view it feeds can never terminate')
            .toBe(ARCHIVE_TIMEOUTS.hierarchy);

        const body = granted();
        await body.client.getArchiveBody(7);
        expect(body.calls[0]!.init?.timeoutMs).toBe(ARCHIVE_TIMEOUTS.body);

        const search = granted();
        await search.client.searchArchive({ q: 'x' });
        expect(search.calls[0]!.init?.timeoutMs).toBe(ARCHIVE_TIMEOUTS.search);
    });
});

describe('archiveQuery keeps the values a falsy check would drop', () => {
    test('0 and false survive; null, undefined and empty do not', () => {
        expect(archiveQuery({ start_line: 0 })).toBe('?start_line=0');
        expect(archiveQuery({ case_sensitive: false })).toBe('?case_sensitive=false');
        expect(archiveQuery({ limit: null, cursor: undefined, q: '' })).toBe('');
        expect(archiveQuery({})).toBe('');
    });
});

describe('the callEnvelope contract: it never rejects', () => {
    test('a 404 carrying an envelope RESOLVES with it', async () => {
        const envelope = fixture('not_found_transcript.json');
        const { client } = granted({ envelope, httpStatus: 404 });
        const r = await client.getArchiveTranscript(99999);
        expect(r.httpStatus).toBe(404);
        expect((r.envelope as { result_status: string }).result_status).toBe('not_found');
        expect(r.transportError).toBe(null);
        expect(r.refusedByGrant, 'a 404 from the server is not a capability refusal')
            .toBe(false);
    });

    test('a 400 cannot_determine RESOLVES with its envelope', async () => {
        const envelope = fixture('cannot_cursor.json');
        const { client } = granted({ envelope, httpStatus: 400 });
        const r = await client.listArchiveTranscripts(12, { cursor: 'bad' });
        expect(r.httpStatus).toBe(400);
        expect((r.envelope as { unevaluated: { subject: string }[] }).unevaluated[0]!.subject)
            .toBe('cursor');
        expect(r.transportError).toBe(null);
    });

    test('a dead network RESOLVES with transportError', async () => {
        const { client } = granted({
            envelope: null, httpStatus: null,
            transportError: 'request failed: Failed to fetch',
        });
        const r = await client.listArchiveHosts();
        expect(r.envelope).toBe(null);
        expect(r.httpStatus).toBe(null);
        expect(r.transportError, 'the network failure reason was discarded, leaving an '
            + 'unexplainable finding').toMatch(/Failed to fetch/);
        expect(r.refusedByGrant, 'a dead network is not a capability refusal, and the two '
            + 'are different problems with different fixes').toBe(false);
    });

    test('an unforeseen rejection is caught and reported, never re-thrown', async () => {
        // The never-rejects contract has to be TOTAL or it is not a
        // contract. The transport resolves every transport outcome
        // itself, so nothing should reject here except the grant - but a
        // client whose guarantee only holds for the failures somebody
        // thought of is one unhandled rejection away from a blank screen.
        const client = rejecting(new TypeError('something nobody planned for'));
        const r = await client.listArchiveHosts();
        expect(r.transportError).toMatch(/something nobody planned for/);
        expect(r.refusedByGrant, 'an ordinary bug must not be reported as a security '
            + 'refusal, or the person debugging it goes looking at the grant')
            .toBe(false);
    });
});

describe('THE NEGATIVE CONTROL: a migrated caller goes through the grant', () => {
    /**
     * Build a client granted something that covers NO archive path, and
     * record whether the transport was reached at all.
     */
    function ungranted(grants: readonly string[]) {
        const calls: string[] = [];
        const api = createScreenApi(grants, (p) => {
            calls.push(p);
            return Promise.resolve({
                envelope: {}, httpStatus: 200, headers: null,
                transportError: null, refusedByGrant: false,
            });
        }, 'history-screen');
        return { client: createArchiveClient(api), calls };
    }

    test('POSITIVE CONTROL: the declared grant lets every method through', async () => {
        // Without this, a refusal below would be indistinguishable from
        // a client that is simply broken.
        const { client, calls } = granted();
        await client.listArchiveHosts();
        await client.getArchiveBody(7);
        await client.searchArchive({ q: 'x' });
        expect(calls.map((c) => c.path)).toEqual([
            `${BASE}/archive/hosts`, `${BASE}/archive/bodies/7`, `${BASE}/archive/search?q=x`,
        ]);
    });

    test('a method outside the grant is refused AND NEVER SENT', async () => {
        const { client, calls } = ungranted(['/features']);
        const r = await client.getArchiveBody(7);
        expect(r.refusedByGrant, 'the call was not reported as a capability refusal').toBe(true);
        expect(calls, 'THE REQUEST WAS SENT. A client that checks the grant after '
            + 'reaching the transport has already leaked the call, and would satisfy '
            + 'an assertion about the return value alone').toEqual([]);
    });

    test('a refusal is distinguishable from a 404 by SHAPE, not by wording', async () => {
        const notFound = granted({ envelope: fixture('not_found_transcript.json'),
                                   httpStatus: 404 });
        const refused = ungranted(['/features']);
        const a = await notFound.client.getArchiveTranscript(99999);
        const b = await refused.client.getArchiveTranscript(99999);
        // Three independent tells, so no caller has to parse a message.
        expect(a.refusedByGrant).toBe(false);
        expect(b.refusedByGrant).toBe(true);
        expect(a.httpStatus).toBe(404);
        expect(b.httpStatus, 'a refusal never reached the network, so it can carry no '
            + 'status; reporting one would make it look like a broken server')
            .toBe(null);
        expect(a.envelope).not.toBe(null);
        expect(b.envelope).toBe(null);
    });

    test('CONTAINMENT: a grant for /archive refuses /archived-thing', async () => {
        // Component-wise, never startsWith - the same defect
        // `project_directory.py` names, where `/Users/jsugamelevil`
        // reads as living under `/Users/jsugamele`. Driven through the
        // real `callEnvelope` rather than through the primitive, because
        // what is unproven is that THIS client reaches the check.
        const { client, calls } = ungranted(['/archive']);
        const ok = await client.callEnvelope('/archive/hosts');
        expect(ok.refusedByGrant, 'the positive half of containment failed, so the '
            + 'refusal below proves nothing').toBe(false);
        const bad = await client.callEnvelope('/archived-thing');
        expect(bad.refusedByGrant).toBe(true);
        expect(calls, 'only the granted path may have been sent')
            .toEqual([`${BASE}/archive/hosts`]);
    });

    test('CONTAINMENT: a grant for /archive refuses a path that climbs out', async () => {
        const { client, calls } = ungranted(['/archive']);
        const r = await client.callEnvelope('/archive/../sessions/respawn');
        expect(r.refusedByGrant, 'a path was compared AS WRITTEN rather than normalised, '
            + 'so a climb out of the grant crossed it').toBe(true);
        expect(calls).toEqual([]);
    });

    test('the contribution declares exactly the grant this client needs', () => {
        // The grant is DATA, reviewable in one line, and this is that
        // line. It is imported rather than retyped so the suite cannot
        // agree with itself about a value the shipping plugin does not
        // carry.
        expect([...API_PREFIXES].sort()).toEqual(['/archive', '/features']);
    });
});
