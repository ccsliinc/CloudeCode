/**
 * The four archive routes. PORTED from `tests/test_archive_deeplink.node.mjs`,
 * deleted in the same commit, case for case and assertion for assertion.
 *
 * WHAT A PORT MEANS HERE. The cases and their reasons are the original's.
 * What changed is the harness (`node:test` style counters to Vitest) and
 * the way the subject is reached (a `vm` sandbox reading
 * `client/js/archive-deeplink.js` became an import). Nothing was
 * rewritten against the new implementation, because rewriting a test
 * against the code it is meant to check is how a port ships a behaviour
 * change with a green run.
 *
 * THE BEST TEST IN HERE IS THE ORDERING ONE and it is kept verbatim in
 * spirit: it substitutes a deliberately RELAXED transcript pattern,
 * proves the regression is real in the wrong order, and only then proves
 * the right order rescues it. A test that merely asserted the anchoring
 * would pass for a pattern list in either order.
 */
import { describe, expect, test } from 'vitest';
import {
    build, buildLinePath, buildProjectPath, buildRootPath, buildTranscriptPath,
    parse, parseWith, QUERY_ALLOWLIST, ROUTE_PATTERNS, type RoutePattern,
} from './route';

/**
 * A real 147-character opaque resume cursor, measured 2026-08-31 from a
 * budget_exhausted search. It must never reach a URL.
 */
const RESUME_CURSOR =
    'eyJ2IjoxLCJ0X2lkIjo1NzY3LCJ0X2luZ2VzdGVkX2F0IjoiMjAyNi0wOC0yOFQwOTox'
    + 'NDoyMloiLCJsaW5lX25vIjoxNjk1LCJieXRlcyI6MTIzNDU2NzgsInNjYW5uZWQiOjk4'
    + 'NzY1NDMyMX0';

describe('parsing the four routes', () => {
    test('the line route parses to both ids', () => {
        const r = parse('/archive/t/5767/l/1695');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.route.view).toBe('line');
        expect(r.route.transcriptId).toBe(5767);
        expect(r.route.lineNo).toBe(1695);
        // Numbers, not strings. A view doing lineNo + 1 on '1695' gets
        // '16951', which scrolls nowhere and reports nothing.
        expect(typeof r.route.transcriptId).toBe('number');
        expect(typeof r.route.lineNo).toBe('number');
    });

    test('the transcript, project and root routes parse', () => {
        const t = parse('/archive/t/5767');
        expect(t.ok).toBe(true);
        if (t.ok) {
            expect(t.route.view).toBe('transcript');
            expect(t.route.transcriptId).toBe(5767);
            // No line was addressed, so lineNo is null.
            expect(t.route.lineNo).toBeNull();
        }

        const p = parse('/archive/p/12');
        expect(p.ok).toBe(true);
        if (p.ok) {
            expect(p.route.view).toBe('project');
            expect(p.route.projectId).toBe(12);
        }

        const root = parse('/archive');
        expect(root.ok).toBe(true);
        if (root.ok) expect(root.route.view).toBe('root');

        const rootSlash = parse('/archive/');
        expect(rootSlash.ok).toBe(true);
        if (rootSlash.ok) expect(rootSlash.route.view).toBe('root');
    });
});

describe('the ordering assertion', () => {
    test('the line route is not swallowed by the transcript pattern', () => {
        const r = parse('/archive/t/5767/l/1695');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.route.view).toBe('line');
        // The line number must survive: being dropped lands the reader
        // at line 0 of the right transcript with no error.
        expect(r.route.lineNo).toBe(1695);
    });

    test('ROUTE_PATTERNS declares line BEFORE transcript', () => {
        const views = ROUTE_PATTERNS.map((p) => p.view);
        expect(views.indexOf('line')).toBeLessThan(views.indexOf('transcript'));
    });

    test('ORDERING, not anchoring, is what protects the line route', () => {
        // Relax the transcript pattern exactly the way a future edit
        // would: drop the trailing `$` so it matches a prefix.
        const relaxedTranscript: RoutePattern = {
            view: 'transcript',
            rx: /^\/archive\/t\/([0-9]+)/,      // note: no $, no /?$
            keys: ['transcriptId'],
        };
        const line = ROUTE_PATTERNS.filter((p) => p.view === 'line')[0] as RoutePattern;
        const others = ROUTE_PATTERNS.filter(
            (p) => p.view !== 'line' && p.view !== 'transcript');

        // WRONG ORDER: the relaxed transcript pattern first. This is the
        // regression, and it must be demonstrable - otherwise the
        // assertion below proves nothing.
        const wrongOrder = [relaxedTranscript, line].concat(others);
        const bad = parseWith(wrongOrder, '/archive/t/5767/l/1695');
        expect(bad.ok).toBe(true);
        if (bad.ok) {
            // EXPECTED THE REGRESSION: a relaxed transcript pattern
            // placed first swallows the line route, and drops the line
            // number with no error.
            expect(bad.route.view).toBe('transcript');
            expect(bad.route.lineNo).toBeNull();
        }

        // RIGHT ORDER: line first, transcript still relaxed. The
        // ordering alone rescues it.
        const rightOrder = [line, relaxedTranscript].concat(others);
        const good = parseWith(rightOrder, '/archive/t/5767/l/1695');
        expect(good.ok).toBe(true);
        if (good.ok) {
            expect(good.route.view).toBe('line');
            expect(good.route.lineNo).toBe(1695);
        }
    });
});

describe('non-numeric ids are refused, loudly, naming the segment', () => {
    test('a session_ref in the path yields cannot-determine naming the segment', () => {
        const r = parse('/archive/t/journal');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        // Not a silent redirect, and not a no-match fall-through.
        expect(r.token).toBe('cannot-determine');
        expect(r.reason).toContain('journal');
        expect(r.reason).toContain('numeric');
        expect((r as Record<string, unknown>).route).toBeUndefined();
    });

    test('every non-numeric transcript id is refused', () => {
        for (const bad of ['journal', 'audit', 'agent-a877057',
                           'aaaaaaaa-0000-4000-8000-000000000001',
                           '5767abc', 'abc5767', '57.67', '-5767', '0x1', '',
                           ' 5767', '5767 ', '+5767', '5_767']) {
            const r = parse(`/archive/t/${bad}`);
            expect(r.ok, `/archive/t/${bad} must not parse`).toBe(false);
            if (r.ok) continue;
            // It is under /archive, so it is a cannot-determine, not a
            // fall-through to another router.
            expect(r.token).not.toBe('no-match');
        }
    });

    test('a non-numeric line number is refused and named', () => {
        const r = parse('/archive/t/5767/l/first');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.token).toBe('cannot-determine');
        expect(r.reason).toContain('first');
        expect(r.reason).toContain('line number');
    });

    test('a non-numeric project id is refused and named', () => {
        const r = parse('/archive/p/mine');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.token).toBe('cannot-determine');
        expect(r.reason).toContain('mine');
        expect(r.reason).toContain('project id');
    });

    test('a path outside /archive is no-match, so the router falls through', () => {
        for (const p of ['/', '/session/cloude_api', '/archived', '/arch',
                         '/archives/t/1', '']) {
            const r = parse(p);
            expect(r.ok, `${p} must not parse as an archive route`).toBe(false);
            if (r.ok) continue;
            expect(r.token, `${p} must fall through, not refuse`).toBe('no-match');
        }
    });
});

describe('round trips', () => {
    test('all four routes round-trip exactly', () => {
        for (const p of ['/archive', '/archive/p/12', '/archive/t/5767',
                         '/archive/t/5767/l/1695']) {
            const parsed = parse(p);
            expect(parsed.ok, `${p} must parse`).toBe(true);
            if (!parsed.ok) continue;
            expect(build(parsed.route), `${p} did not survive a round trip`).toBe(p);
        }
    });

    test('the query survives a round trip', () => {
        const parsed = parse('/archive/t/5767', '?q=hazard');
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.route.query.q).toBe('hazard');
            expect(build(parsed.route)).toBe('/archive/t/5767?q=hazard');
        }

        const both = parse('/archive/p/12', '?q=hazard&scope=transcript');
        expect(both.ok).toBe(true);
        if (both.ok) {
            expect(both.route.query.q).toBe('hazard');
            expect(both.route.query.scope).toBe('transcript');
            expect(build(both.route)).toBe('/archive/p/12?q=hazard&scope=transcript');
        }
    });

    test('a query value needing escaping round-trips', () => {
        const parsed = parse('/archive/t/5767', '?q=a%20b%26c');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.route.query.q).toBe('a b&c');
        const built = build(parsed.route) as string;
        const again = parse('/archive/t/5767', built.split('?')[1]);
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.route.query.q).toBe('a b&c');
    });
});

describe('no builder accepts a session_ref', () => {
    test('buildTranscriptPath refuses a session_ref, returning null', () => {
        const refs: unknown[] = ['journal', 'audit', 'agent-a877057',
            'aaaaaaaa-0000-4000-8000-000000000001', '5767abc', '', null,
            undefined, {}, [], -1, 1.5, NaN, Infinity];
        for (const ref of refs) {
            expect(buildTranscriptPath(ref as string),
                   `buildTranscriptPath(${JSON.stringify(ref)}) must be null`)
                .toBeNull();
        }
    });

    test('buildLinePath and buildProjectPath refuse non-numeric ids', () => {
        expect(buildLinePath('journal', 1695)).toBeNull();
        expect(buildLinePath(5767, 'first')).toBeNull();
        expect(buildProjectPath('mine')).toBeNull();
        expect(build({ view: 'transcript', transcriptId: 'journal' as unknown as number }))
            .toBeNull();
        expect(build({ view: 'nonsense' as never, transcriptId: 5767 })).toBeNull();
        expect(build(null)).toBeNull();
    });

    test('POSITIVE CONTROL: the builders DO build for numeric ids', () => {
        // Without this, the refusal assertions above pass for a builder
        // that returns null unconditionally.
        expect(buildTranscriptPath(5767)).toBe('/archive/t/5767');
        expect(buildTranscriptPath('5767')).toBe('/archive/t/5767');
        expect(buildLinePath(5767, 1695)).toBe('/archive/t/5767/l/1695');
        expect(buildProjectPath(12)).toBe('/archive/p/12');
        expect(buildRootPath()).toBe('/archive');
    });
});

describe('no resume cursor ever reaches a URL', () => {
    test('a resume cursor appears nowhere in any built URL', () => {
        const searchState = {
            q: 'hazard',
            scope: 'project',
            resume_cursor: RESUME_CURSOR,
            cursor: RESUME_CURSOR,
            next_cursor: RESUME_CURSOR,
            resumeCursor: RESUME_CURSOR,
        };
        // Fixture check: the measured length.
        expect(RESUME_CURSOR.length).toBe(147);

        const built = [
            buildRootPath(searchState),
            buildProjectPath(12, searchState),
            buildTranscriptPath(5767, searchState),
            buildLinePath(5767, 1695, searchState),
            build({ view: 'line', transcriptId: 5767, lineNo: 1695,
                    query: searchState as unknown as Record<string, string> }),
        ];
        for (const url of built) {
            expect(typeof url).toBe('string');
            const u = url as string;
            expect(u.indexOf(RESUME_CURSOR), `the cursor reached ${u}`).toBe(-1);
            // Not merely the whole cursor: no recognisable fragment of
            // it, and no cursor-ish parameter name either.
            expect(u.indexOf(RESUME_CURSOR.slice(0, 24))).toBe(-1);
            for (const key of ['cursor', 'resume', 'next_cursor']) {
                expect(u.indexOf(key), `'${key}' reached ${u}`).toBe(-1);
            }
            // The allowlisted parameters DID survive, so this is not
            // passing by emitting nothing.
            expect(u).toContain('q=hazard');
            expect(u).toContain('scope=project');
        }
    });

    test('the query allowlist drops anything not declared', () => {
        const built = buildTranscriptPath(5767, {
            q: 'hazard', scope: 'project',
            token: 'secret-bearer-value', password: 'x', body_id: 379,
        }) as string;
        expect(built).toBe('/archive/t/5767?q=hazard&scope=project');
        for (const leaked of ['token', 'password', 'body_id', 'secret-bearer-value']) {
            expect(built.indexOf(leaked)).toBe(-1);
        }
    });

    test('parse also drops non-allowlisted query parameters', () => {
        const r = parse('/archive/t/5767',
                        `?q=hazard&cursor=${RESUME_CURSOR}&token=abc`);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.route.query.q).toBe('hazard');
        // A cursor arriving in a pasted URL must not be carried forward.
        expect(r.route.query.cursor).toBeUndefined();
        expect(r.route.query.token).toBeUndefined();
        expect((build(r.route) as string).indexOf(RESUME_CURSOR)).toBe(-1);
    });

    test('QUERY_ALLOWLIST is an allowlist, and it is short', () => {
        // A parameter added here becomes publishable in a shareable URL;
        // this assertion exists so that is a deliberate edit, not drift.
        expect(Array.from(QUERY_ALLOWLIST)).toEqual(['q', 'scope']);
    });
});

describe('malformed input does not throw', () => {
    test('malformed paths and queries return a refusal rather than throwing', () => {
        const cases: [unknown, unknown][] = [
            [null, null], [undefined, undefined], [42, 42],
            ['/archive/t/5767', '?q=%E0%A4%A'],
            ['/archive/t/5767', '?%E0%A4%A=x'],
            ['/archive/t/5767', '???'],
            ['/archive/t/5767/l/1695/extra', ''],
            ['/archive/t//l/1695', ''],
        ];
        for (const [p, s] of cases) {
            const r = parse(p as string, s as string);
            expect(typeof r).toBe('object');
            expect(typeof r.ok).toBe('boolean');
            if (!r.ok) expect(typeof r.reason).toBe('string');
        }
    });
});
