/**
 * THE RUNNER: what a NEW question discards, what a RESUME keeps, and the
 * fact that it cannot pick the wrong cursor because it never reads one.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSearchRunner, emptySearch, TOKEN_TRANSPORT_ERROR } from './search-run';
import { EGRESS_TEXT } from './mask-egress';

/** A classifier standing in for the still-vanilla `archive-outcome.js`. */
const outcome = {
    classify: (e: unknown) => ({
        token: (e as { result_status?: string } | null)?.result_status ?? 'cannot-determine',
    }),
};

/** One hit the egress door clears. */
function hit(id: number, line: number) {
    return {
        transcript_id: id, session_ref: 'r', line_no: line, match_offset: 0,
        match_length: 1, snippet: `preview ${line}`, snippet_state: 'included',
        secret_finding_count: 0,
    };
}

/** One page, with the scan meta that makes it resumable a given way. */
function page(rows: unknown[], scan: Record<string, unknown>,
              paging: Record<string, unknown> = {}) {
    return {
        envelope: {
            result: rows, result_status: 'ok',
            meta: { scan, scope: { transcripts_in_scope: 10 }, paging },
        },
        transportError: null,
    };
}

describe('the search runner', () => {
    it('starts empty, with coverage stated rather than blank', () => {
        const s = emptySearch();
        expect(s.hits).toEqual([]);
        expect(s.coverage).toContain('NOT KNOWN');
        expect(s.affordance).toBeNull();
        expect(s.token).toBeNull();
    });

    it('hands out VIEWS, never raw hits, so nothing downstream can reach '
        + 'a snippet around the door', async () => {
        const r = createSearchRunner(
            { searchArchive: () => Promise.resolve(page([hit(4, 1)], { status: 'complete' })) },
            outcome,
        );
        const s = await r.run({ q: 'x' });
        expect(s.hits).toHaveLength(1);
        // A `HitView`, not a record: no `snippet`, no `transcript_id`.
        expect(s.hits[0]).not.toHaveProperty('snippet');
        expect(s.hits[0]).not.toHaveProperty('transcript_id');
        expect(s.hits[0]?.preview.kind).toBe(EGRESS_TEXT);
        expect(s.hits[0]?.transcriptLabel).toBe('transcript 4');
    });

    it('a RESUME appends, because both kinds continue ONE question', async () => {
        const searchArchive = vi.fn()
            .mockResolvedValueOnce(page([hit(4, 1)],
                { status: 'limit_reached' }, { next_cursor: 'C1' }))
            .mockResolvedValueOnce(page([hit(4, 2)],
                { status: 'complete' }));
        const r = createSearchRunner({ searchArchive }, outcome);
        await r.run({ q: 'x', projectId: 12 });
        const after = await r.resume();
        expect(after.hits.map((h) => h.lineNo)).toEqual([1, 2]);
        // The cursor went out on the SECOND call, and the scope did not
        // change: a resume is the same question, further along.
        expect(searchArchive.mock.calls[1]?.[0])
            .toEqual({ q: 'x', projectId: 12, cursor: 'C1' });
    });

    it('a NEW run DISCARDS, because a new question does not inherit an '
        + 'old answer\'s coverage', async () => {
        const searchArchive = vi.fn()
            .mockResolvedValueOnce(page([hit(4, 1)], { status: 'complete' }))
            .mockResolvedValueOnce(page([hit(9, 5)], { status: 'complete' }));
        const r = createSearchRunner({ searchArchive }, outcome);
        await r.run({ q: 'a' });
        const second = await r.run({ q: 'b' });
        expect(second.hits.map((h) => h.lineNo)).toEqual([5]);
        // And no cursor from the first answer leaks into the second ask.
        expect(searchArchive.mock.calls[1]?.[0]).toEqual({ q: 'b' });
    });

    it('a BLOCKED resume changes nothing and keeps its stated reason, '
        + 'rather than clearing the control or throwing', async () => {
        const searchArchive = vi.fn().mockResolvedValue(page(
            [hit(4, 1)], { status: 'budget_exhausted', resume_cursor: null },
        ));
        const r = createSearchRunner({ searchArchive }, outcome);
        const first = await r.run({ q: 'x' });
        expect(first.affordance?.blocked).toBe(true);
        const after = await r.resume();
        expect(after).toBe(first);
        // It did NOT ask the server anything on a blocked resume.
        expect(searchArchive).toHaveBeenCalledTimes(1);
    });

    it('a transport failure is its own token and carries no envelope, so '
        + 'nothing downstream classifies a silence as an answer', async () => {
        const r = createSearchRunner(
            { searchArchive: () => Promise.resolve({ transportError: 'timed out' }) },
            outcome,
        );
        const s = await r.run({ q: 'x' });
        expect(s.token).toBe(TOKEN_TRANSPORT_ERROR);
        expect(s.envelope).toBeNull();
        expect(s.hits).toEqual([]);
        expect(s.transportError).toBe('timed out');
    });

    it('NEVER touches meta itself - it can only send the cursor the '
        + 'affordance resolved, so it cannot pick the wrong one', async () => {
        // A crossed envelope: the scan says limit_reached (page cursor)
        // while a scan cursor is also present. The runner must send the
        // page cursor, or nothing.
        const searchArchive = vi.fn().mockResolvedValue(page(
            [], { status: 'limit_reached', resume_cursor: 'SCAN' }, { next_cursor: 'PAGE' },
        ));
        const r = createSearchRunner({ searchArchive }, outcome);
        await r.run({ q: 'x' });
        await r.resume();
        expect(searchArchive.mock.calls[1]?.[0]?.cursor).toBe('PAGE');
        expect(searchArchive.mock.calls[1]?.[0]?.cursor).not.toBe('SCAN');
    });
});
