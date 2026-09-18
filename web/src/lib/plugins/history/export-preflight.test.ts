/**
 * THE THREE INTEGRITY OUTCOMES, AND THE ONE THAT MAY NEVER BE INFERRED.
 *
 * `verified` IS THE ONLY STATE THAT MAY BE STYLED AS SUCCESS, and the
 * tests below drive every way of NOT reaching it: a 200 with no headers,
 * a 200 with one hash, a 200 whose hashes disagree, a 200 the server did
 * not claim. Every one of them must land somewhere other than VERIFIED.
 * A preflight that inferred success from a 200 would pass a naive happy
 * path and be wrong about 1.1 percent of this archive, silently.
 */
import { describe, expect, it } from 'vitest';
import {
    classifyPreflight, collisionWarning, downloadCapability, filenameFrom,
    shasumCommand,
} from './export-preflight';
import { STATES } from './export-vocab';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** A 200 preflight with the headers a verified export carries. */
function verified(over: Record<string, string> = {}) {
    return {
        httpStatus: 200,
        headers: {
            'x-archive-verified': 'true',
            'x-archive-expected-sha256': SHA,
            'x-archive-actual-sha256': SHA,
            'x-archive-expected-bytes': '1234',
            'content-disposition': 'attachment; filename="journal.jsonl"',
            ...over,
        },
    };
}

describe('the three integrity outcomes', () => {
    it('VERIFIED only when the server SAID so and both hashes agree', () => {
        const info = classifyPreflight(verified());
        expect(info.state).toBe(STATES.VERIFIED);
        expect(info.verified).toBe(true);
        expect(info.filename).toBe('journal.jsonl');
        expect(info.expectedBytes).toBe('1234');
    });

    it('NEVER infers VERIFIED from a 200 - four separate ways of failing '
        + 'to be verified, none of which may claim it', () => {
        // No claim header at all.
        expect(classifyPreflight(verified({ 'x-archive-verified': '' })).verified)
            .toBe(false);
        // Claimed, but the hashes disagree.
        expect(classifyPreflight(verified({ 'x-archive-actual-sha256': OTHER })).verified)
            .toBe(false);
        // Claimed, but there is no actual hash: this is the streaming
        // shape, and it lands on UNVERIFIABLE rather than on a failure.
        const streamed = classifyPreflight({
            httpStatus: 200,
            headers: { 'x-archive-verified': 'true', 'x-archive-expected-sha256': SHA },
        });
        expect(streamed.state).toBe(STATES.UNVERIFIABLE);
        expect(streamed.verified).toBe(false);
        // A bare 200 with nothing on it establishes nothing either way.
        const bare = classifyPreflight({ httpStatus: 200, headers: {} });
        expect(bare.state).toBe(STATES.CANNOT_DETERMINE);
        expect(bare.reason).toContain('NOT KNOWN');
    });

    it('a 413 is a ROUTE TO THE STREAMING PATH, not a failure', () => {
        const info = classifyPreflight({
            httpStatus: 413,
            envelope: { meta: { stream_href: '/archive/transcripts/4/export' } },
        });
        expect(info.state).toBe(STATES.UNVERIFIABLE);
        expect(info.streamHref).toBe('/archive/transcripts/4/export');
        expect(info.reason).toContain('not known to be corrupt');
    });

    it('a 503 is the server declining to START - nothing failed and '
        + 'nothing was downloaded', () => {
        const info = classifyPreflight({ httpStatus: 503 });
        expect(info.state).toBe(STATES.BUSY);
        expect(info.reason).toContain('Nothing was downloaded and nothing failed');
    });

    it('a 404 is a MEASURED absence, and says so', () => {
        expect(classifyPreflight({ httpStatus: 404 }).state).toBe(STATES.NOT_FOUND);
    });

    it('a transport failure establishes NOTHING and says that too', () => {
        const info = classifyPreflight({ transportError: 'timed out' });
        expect(info.state).toBe(STATES.CANNOT_DETERMINE);
        expect(info.reason).toContain('Nothing is known');
        expect(info.verified).toBe(false);
    });

    it('reads a real Headers object as well as a plain map', () => {
        const h = new Headers({
            'x-archive-verified': 'true',
            'x-archive-expected-sha256': SHA,
            'x-archive-actual-sha256': SHA,
        });
        expect(classifyPreflight({ httpStatus: 200, headers: h }).verified).toBe(true);
    });
});

describe('the download blocker and the collision warning', () => {
    it('reports the download as blocked, with the measurement behind it', () => {
        const cap = downloadCapability();
        expect(cap.canDownload).toBe(false);
        expect(cap.reason).toContain('401');
        expect(cap.reason).toContain('ticket');
    });

    it('does not guess about a name it was not given a count for', () => {
        const w = collisionWarning('journal.jsonl', null);
        expect(w).toContain('NOT KNOWN');
        // And it does NOT claim uniqueness, which is the quiet wrong
        // answer. Matched as the POSITIVE phrase: the sentence does say
        // "not unique in this archive", which is the opposite claim and
        // must survive.
        expect(w).not.toMatch(/\bis unique\b/);
        expect(w).toContain('not unique');
    });

    it('warns on a real collision and stays quiet on a real singleton', () => {
        expect(collisionWarning('journal.jsonl', 14)).toContain('14 transcripts');
        expect(collisionWarning('journal.jsonl', 1)).toBeNull();
        expect(collisionWarning(null, 14)).toBeNull();
    });

    it('hands over the measurement the server could not do, naming the '
        + 'absence when there is no expected hash to compare against', () => {
        expect(shasumCommand('a.jsonl', SHA)).toContain(`# expect: ${SHA}`);
        expect(shasumCommand(null, null)).toContain('NOT KNOWN');
    });

    it('parses a filename, and refuses rather than inventing one', () => {
        expect(filenameFrom('attachment; filename="a.jsonl"')).toBe('a.jsonl');
        expect(filenameFrom('attachment')).toBeNull();
        expect(filenameFrom(null)).toBeNull();
    });
});
