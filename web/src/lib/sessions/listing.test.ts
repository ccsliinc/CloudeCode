/**
 * The three-outcome listing latch, and the sentences under it.
 *
 * PORTED FROM tests/test_running_sessions_unknown.node.mjs, which keeps
 * the half that asserts the rendered NEEDS ATTENTION block (slice 5).
 *
 * THE THIRD OUTCOME IS THE WHOLE SUBJECT. A probe that did not answer
 * must never be indistinguishable from a machine with zero sessions. The
 * version this replaced logged loudly and then fell back to `[]`, which
 * is worse than a silent catch: the console told the truth while the
 * screen rendered a dead tmux server as a healthy one, and the loud log
 * made the problem look solved.
 */
import { describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import { isPseudo, PSEUDO_LOCALE } from '../../../../client/js/i18n/pseudo.js';
import {
    attributionFailedDetail,
    listingDetail,
    LISTING_KEYS,
    projectsLoadFailed,
    recordsMalformedDetail,
    serverDetail,
    sessionsMalformedDetail,
} from '../../../../client/js/labels/session-listing.js';
import {
    DEFAULT_REASON,
    emptyListing,
    listingReasonFromError,
    noteListingUnknown,
    statusFromError,
} from './listing';

/** The real runtime, in English, as a component would get it. */
const en = createI18n({ locale: 'en' }) as { t(k: string, p?: unknown): string };
const t = (k: string, p?: Record<string, unknown> | null) => en.t(k, p);

describe('the latch', () => {
    test('a fresh verdict is ok with nothing said', () => {
        expect(emptyListing()).toEqual({ ok: true, reason: null, detail: null, sources: [] });
    });

    test('once false it never flips back within the tick', () => {
        // A second probe succeeding does not un-break the first, because
        // the row set is still incomplete.
        const s = emptyListing();
        noteListingUnknown(s, 'attachable', 'timeout', 'tmux did not answer');
        noteListingUnknown(s, 'live', 'http_500', 'something else');
        expect(s.ok).toBe(false);
    });

    test('the FIRST reason and detail win, because they explain the gap', () => {
        const s = emptyListing();
        noteListingUnknown(s, 'attachable', 'timeout', 'tmux did not answer');
        noteListingUnknown(s, 'live', 'http_500', 'something else');
        expect(s.reason).toBe('timeout');
        expect(s.detail).toBe('tmux did not answer');
    });

    test('both failing probes are named, and neither is named twice', () => {
        const s = emptyListing();
        noteListingUnknown(s, 'attachable', 'timeout', 'a');
        noteListingUnknown(s, 'live', 'http_500', 'b');
        noteListingUnknown(s, 'live', 'http_500', 'b');
        expect(s.sources).toEqual(['attachable', 'live']);
    });

    test('a failure with no reason still records one', () => {
        // A blank reason would render as a row with nothing wrong.
        const s = emptyListing();
        noteListingUnknown(s, 'live', null, null);
        expect(s.reason).toBe(DEFAULT_REASON);
        expect(s.ok).toBe(false);
    });
});

describe('the status behind a rejection', () => {
    test.each([
        ['a numeric status wins', Object.assign(new Error('x'), { status: 503 }), 503],
        ['HTTP <code> is parsed out of the message', new Error('HTTP 500'), 500],
        ['the auth message means 401', new Error('Authentication required, please sign in'), 401],
        ['an unrecognised message answers null', new Error('socket hang up'), null],
        ['a non-error answers null', null, null],
    ])('%s', (_label, err, expected) => {
        expect(statusFromError(err)).toBe(expected);
    });

    test('null is NOT zero, and the reason token says so', () => {
        // "could not determine the status" and "status zero" are different
        // facts; only the first is honest about a network failure.
        expect(listingReasonFromError(new Error('boom'), null)).toBe('network_error');
        expect(listingReasonFromError(new Error('boom'), 0)).toBe('network_error');
    });
});

describe('the reason token', () => {
    test("the server's own listing_reason wins", () => {
        // The client repeats the server's verdict rather than inventing a
        // parallel vocabulary.
        const err = Object.assign(new Error('HTTP 503'), {
            detail: { listing_reason: 'tmux_missing' },
        });
        expect(listingReasonFromError(err, 503)).toBe('tmux_missing');
    });

    test('an empty listing_reason is not an answer and falls through', () => {
        const err = Object.assign(new Error('HTTP 503'), { detail: { listing_reason: '' } });
        expect(listingReasonFromError(err, 503)).toBe('http_503');
    });

    test.each([
        [401, 'unauthorized'],
        [500, 'http_500'],
        [503, 'http_503'],
    ])('status %i reads %s', (status, expected) => {
        expect(listingReasonFromError(new Error('x'), status)).toBe(expected);
    });
});

describe('the sentence under a CANNOT DETERMINE row', () => {
    test("the server's own listing_detail outranks every catalog message", () => {
        const err = Object.assign(new Error('HTTP 503'), {
            detail: { listing_detail: 'tmux exited 2: no server running' },
        });
        expect(listingDetail(err, 503, t)).toBe('tmux exited 2: no server running');
    });

    test('...then its generic message', () => {
        const err = Object.assign(new Error('HTTP 500'), { detail: { message: 'db is down' } });
        expect(serverDetail(err)).toBe('db is down');
        expect(listingDetail(err, 500, t)).toBe('db is down');
    });

    test('a 401 tells the user what to DO about it', () => {
        expect(listingDetail(new Error('x'), 401, t)).toBe(t(LISTING_KEYS.detailUnauthorized));
    });

    test('a 503 names the listing that could not be read', () => {
        expect(listingDetail(new Error('x'), 503, t)).toBe(t(LISTING_KEYS.detailTmuxUnreadable));
    });

    test('any other status is reported with the number in it', () => {
        expect(listingDetail(new Error('x'), 418, t)).toContain('418');
    });

    test("the error's own message is used before the generic fallback", () => {
        expect(listingDetail(new Error('socket hang up'), null, t)).toBe('socket hang up');
    });

    test('and it is NEVER empty, because a blank cell is not an explanation', () => {
        for (const [err, status] of [
            [null, null], [new Error(''), null], [{}, null], [undefined, 0],
        ] as Array<[unknown, number | null]>) {
            expect(listingDetail(err, status, t).length).toBeGreaterThan(0);
        }
    });
});

describe('the malformed and failed sentences', () => {
    test('the two malformed bodies are named separately', () => {
        // Two probes answering different questions. A translator may want
        // to name each, and a reader certainly does.
        expect(sessionsMalformedDetail(t)).not.toBe(recordsMalformedDetail(t));
        expect(sessionsMalformedDetail(t).length).toBeGreaterThan(0);
        expect(recordsMalformedDetail(t).length).toBeGreaterThan(0);
    });

    test('a rejected attribution fetch keeps the transport fact', () => {
        expect(attributionFailedDetail(new Error('connect ECONNREFUSED'), t))
            .toBe('connect ECONNREFUSED');
    });

    test('...and falls back to a real sentence when there is none', () => {
        expect(attributionFailedDetail(null, t)).toBe(t(LISTING_KEYS.unreachable));
    });

    test('the projects failure is ONE message with a hole, not a concatenation', () => {
        // It was `'failed to load projects: ' + error.message`. The colon
        // and the word order belong to the message now.
        const sentence = projectsLoadFailed(new Error('HTTP 500'), t);
        expect(sentence).toContain('HTTP 500');
        expect(sentence).toBe(t(LISTING_KEYS.projectsLoadFailed, { reason: 'HTTP 500' }));
    });
});

describe('every sentence this layer prints really comes from the catalog', () => {
    // THE BEHAVIOURAL i18n GUARD. In the pseudo locale a message is
    // wrapped in a balanced bracketed span, so a sentence assembled from a
    // hardcoded fragment is visibly not one. See .claude/notes/i18n-design.md.
    const pseudo = createI18n({ locale: PSEUDO_LOCALE }) as { t(k: string, p?: unknown): string };
    const pt = (k: string, p?: Record<string, unknown> | null) => pseudo.t(k, p);

    test.each([
        ['401', () => listingDetail(new Error('x'), 401, pt)],
        ['503', () => listingDetail(new Error('x'), 503, pt)],
        ['another status', () => listingDetail(new Error('x'), 418, pt)],
        ['no status at all', () => listingDetail({}, null, pt)],
        ['malformed sessions', () => sessionsMalformedDetail(pt)],
        ['malformed records', () => recordsMalformedDetail(pt)],
        ['attribution failed', () => attributionFailedDetail(null, pt)],
        ['projects failed', () => projectsLoadFailed(new Error('HTTP 500'), pt)],
    ])('%s is fully pseudo-localised', (_label, build) => {
        expect(isPseudo(build())).toBe(true);
    });

    test('NEGATIVE CONTROL: a server sentence is passed through, NOT localised', () => {
        // Server strings are deliberately out of scope this round. This
        // asserts the guard above is capable of telling the difference,
        // and documents that this one case is meant to fail it.
        const err = Object.assign(new Error('x'), {
            detail: { listing_detail: 'tmux exited 2' },
        });
        expect(isPseudo(listingDetail(err, 503, pt))).toBe(false);
    });

    test('every key this surface names exists in the catalog', () => {
        for (const key of Object.values(LISTING_KEYS) as string[]) {
            expect(en.t(key), key).not.toBe(key);
        }
    });
});
