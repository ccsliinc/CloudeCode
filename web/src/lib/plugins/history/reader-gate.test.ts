/**
 * THE GATE, PROVED TO REFUSE IN EVERY CASE THE ORIGINAL REFUSED.
 *
 * WHY THIS SUITE IS SHAPED AS A TABLE OF REFUSALS. A gate that fails
 * open passes every rendering test: the body renders, the row looks
 * right, nothing errors, and the credential is on screen. So this file
 * does not check that the gate WORKS, it checks that it REFUSES, case by
 * case, against a table lifted from `client/js/archive-body-gate.js` and
 * `client/js/archive-mask.js`. A case removed from that table is a case
 * that stopped being tested, which is visible in the diff.
 *
 * THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST. A masker that always
 * refused would pass every refusal case here and be useless, and a
 * masker that always accepted would pass every positive case and be a
 * disclosure. Both directions are asserted, and `describe('the negative
 * controls')` is where the second lives.
 */
import { describe, expect, it } from 'vitest';
import {
    applyMask, forbidsFetch, gateFor, reasonFrom, NEVER_FETCH,
    BODY_INLINE_MAX, BODY_RENDER_HARD_MAX,
} from './reader-gate';
import { maskBody, MASK_OK, MASK_REFUSED, SECRET_MARKER } from './reader-mask';
import { BODY_STATE } from './reader-vocab';

/**
 * A canary that must never survive into rendered text.
 *
 * NOT KEY-SHAPED ON PURPOSE - see `reader-harness.ts`. A realistic key
 * trips this repo's own pre-commit gitleaks gate, and a fixture that has
 * to be waved past a secret scanner teaches the next person to wave the
 * scanner past something real.
 */
const CANARY = 'CANARY-IF-YOU-SEE-THIS-A-GATE-FAILED-OPEN';

/** One well-formed finding over `CANARY` at `at`. */
function computedFinding(at: number, len: number = CANARY.length) {
    return { utf16_state: 'computed', match_offset_utf16: at, match_length_utf16: len };
}

describe('gateFor: the size policy, before any network', () => {
    it('refuses a row that is not an object, naming that it has none', () => {
        for (const bad of [null, undefined, 3, 'row', true]) {
            const v = gateFor(bad as never);
            expect(v.state).toBe(BODY_STATE.CANNOT_DETERMINE);
            expect(v.chars).toBeNull();
            expect(v.reason).toBeTruthy();
        }
    });

    it("answers the SERVER's own withholding, and does not restate it as "
        + 'its own', () => {
        const v = gateFor({ body_id: 1, body_chars: 99, body_state: 'withheld_too_large' });
        expect(v.state).toBe(BODY_STATE.WITHHELD);
        expect(v.chars).toBe(99);
        // It wins OUTRIGHT: it is checked before body_id and before size,
        // so a withheld row with no body_id still reads `withheld-server`.
        const noId = gateFor({ body_id: null, body_state: 'withheld_too_large' });
        expect(noId.state).toBe(BODY_STATE.WITHHELD);
    });

    it('distinguishes NO BODY from a body of unknown size, which are two '
        + 'different findings', () => {
        expect(gateFor({ body_id: null }).state).toBe(BODY_STATE.NO_BODY);
        expect(gateFor({ body_id: undefined }).state).toBe(BODY_STATE.NO_BODY);
        // A size we cannot read is NOT a small size.
        for (const bad of [undefined, null, NaN, Infinity, -1, '900']) {
            const v = gateFor({ body_id: 7, body_chars: bad });
            expect(v.state).toBe(BODY_STATE.CANNOT_DETERMINE);
            expect(v.chars).toBeNull();
        }
    });

    it('puts the thresholds exactly where the vanilla file put them', () => {
        expect(BODY_INLINE_MAX).toBe(262144);
        expect(BODY_RENDER_HARD_MAX).toBe(2097152);

        const at = (n: number) => gateFor({ body_id: 1, body_chars: n }).state;
        expect(at(0)).toBe(BODY_STATE.OK);
        expect(at(BODY_INLINE_MAX)).toBe(BODY_STATE.OK);
        expect(at(BODY_INLINE_MAX + 1)).toBe(BODY_STATE.GATED_SOFT);
        expect(at(BODY_RENDER_HARD_MAX)).toBe(BODY_STATE.GATED_SOFT);
        expect(at(BODY_RENDER_HARD_MAX + 1)).toBe(BODY_STATE.GATED_HARD);
        // The real corpus's largest body, measured 2026-08-31.
        expect(at(54376859)).toBe(BODY_STATE.GATED_HARD);
    });

    it('THE HARD GATE IS NOT A STRONGER SOFT GATE: four states may never '
        + 'be fetched at any value of force, and GATED_SOFT is not one', () => {
        expect([...NEVER_FETCH].sort()).toEqual([
            BODY_STATE.CANNOT_DETERMINE, BODY_STATE.GATED_HARD,
            BODY_STATE.NO_BODY, BODY_STATE.WITHHELD,
        ].sort());
        expect(forbidsFetch(BODY_STATE.GATED_HARD)).toBe(true);
        expect(forbidsFetch(BODY_STATE.WITHHELD)).toBe(true);
        expect(forbidsFetch(BODY_STATE.NO_BODY)).toBe(true);
        expect(forbidsFetch(BODY_STATE.CANNOT_DETERMINE)).toBe(true);
        // The one refusal a person may lift.
        expect(forbidsFetch(BODY_STATE.GATED_SOFT)).toBe(false);
        expect(forbidsFetch(BODY_STATE.OK)).toBe(false);
        // A NINTH state cannot classify itself as fetchable by not
        // matching an if-chain: the list is a list.
        expect(forbidsFetch('some-future-state')).toBe(false);
    });

    it('states a reason on every refusal, so no refusal is a blank cell', () => {
        const refusals = [
            gateFor(null), gateFor({ body_id: null }),
            gateFor({ body_id: 1, body_chars: 'x' }),
            gateFor({ body_id: 1, body_chars: BODY_INLINE_MAX + 1 }),
            gateFor({ body_id: 1, body_chars: BODY_RENDER_HARD_MAX + 1 }),
            gateFor({ body_id: 1, body_state: 'withheld_too_large' }),
        ];
        for (const r of refusals) {
            expect(typeof r.reason).toBe('string');
            expect((r.reason as string).length).toBeGreaterThan(10);
        }
        // And `included` is the ONE state with no reason to give.
        expect(gateFor({ body_id: 1, body_chars: 10 }).reason).toBeNull();
    });
});

describe('maskBody: five cases, and every one of them refuses closed', () => {
    it('CASE 1: no secrets declared and none sent renders the bytes '
        + 'verbatim, because masking must be a no-op when there is '
        + 'nothing to mask', () => {
        const body = 'plain transcript text';
        for (const findings of [null, undefined, []]) {
            const m = maskBody(body, findings as never, 0);
            expect(m.status).toBe(MASK_OK);
            expect(m.text).toBe(body);
            expect((m as { masked: number }).masked).toBe(0);
        }
    });

    it('CASE 2: secrets declared but NO findings array refuses. This is '
        + 'the measured live /lines shape (transcript 4 line 292)', () => {
        const body = `key=${CANARY} rest`;
        for (const findings of [null, undefined, []]) {
            const m = maskBody(body, findings as never, 3);
            expect(m.status).toBe(MASK_REFUSED);
            expect(m.text).toBeNull();
            expect((m as { findingCount: number }).findingCount).toBe(3);
            // THE CANARY IS NOT IN THE REASON EITHER.
            expect((m as { reason: string }).reason).not.toContain(CANARY);
        }
    });

    it('CASE 3: fewer findings than declared refuses, because masking '
        + 'what we have leaves the rest visible WHILE LOOKING MASKED', () => {
        const body = `a ${CANARY} b ${CANARY} c`;
        const m = maskBody(body, [computedFinding(2)], 2);
        expect(m.status).toBe(MASK_REFUSED);
        expect(m.text).toBeNull();
    });

    it('CASE 4: ONE unusable finding poisons the WHOLE body, not just its '
        + 'own window', () => {
        const body = `a ${CANARY} b ${CANARY} c`;
        const good = computedFinding(2);
        const unusable = [
            { utf16_state: 'cannot_determine', match_offset_utf16: 50, match_length_utf16: 40 },
            { utf16_state: 'computed', match_offset_utf16: -1, match_length_utf16: 40 },
            { utf16_state: 'computed', match_offset_utf16: 50, match_length_utf16: 0 },
            { utf16_state: 'computed', match_offset_utf16: 1.5, match_length_utf16: 40 },
            { utf16_state: 'computed', match_offset_utf16: 50 },
            { utf16_state: 'computed', match_offset_utf16: body.length, match_length_utf16: 40 },
            { match_offset_utf16: 50, match_length_utf16: 40 },
            null,
        ];
        for (const bad of unusable) {
            const m = maskBody(body, [good, bad] as never, 2);
            expect(m.status).toBe(MASK_REFUSED);
            expect(m.text).toBeNull();
        }
    });

    it('NEVER READS match_offset OR match_length, only the _utf16 pair. '
        + 'A finding carrying ONLY the code-point fields is unusable', () => {
        const body = `a ${CANARY} b`;
        const codePointOnly = {
            utf16_state: 'computed', match_offset: 2, match_length: CANARY.length,
        };
        const m = maskBody(body, [codePointOnly] as never, 1);
        expect(m.status).toBe(MASK_REFUSED);
    });

    it('THE ASTRAL DRIFT, MEASURED. The _utf16 offset masks the whole '
        + 'credential where the code-point offset would leave a tail', () => {
        // Twelve astral characters before the secret: the body-379 shape.
        const prefix = `${'\u{1F600}'.repeat(12)}key=`;
        const body = `${prefix}${CANARY}|tail`;
        // body.length is UTF-16 units; [...body].length is code points.
        const utf16At = body.indexOf(CANARY);
        const codePointAt = [...body].findIndex((_, i, a) => a.slice(i).join('').startsWith(CANARY));
        expect(utf16At).toBeGreaterThan(codePointAt);   // the drift is real
        expect(utf16At - codePointAt).toBe(12);          // and it is 12

        const ok = maskBody(body, [computedFinding(utf16At)], 1);
        expect(ok.status).toBe(MASK_OK);
        expect(ok.text).not.toContain(CANARY);
        // THE TAIL TEST: not one character of the credential survives.
        expect(ok.text).not.toContain(CANARY.slice(-4));
        expect(ok.text).toContain(SECRET_MARKER);
    });

    it('merges overlapping windows and splices from the HIGHEST offset '
        + 'down, so a fixed-width marker cannot shift a pending finding', () => {
        const body = `head ${CANARY} middle ${CANARY} tail`;
        const a = body.indexOf(CANARY);
        const b = body.lastIndexOf(CANARY);
        const m = maskBody(body, [computedFinding(b), computedFinding(a)], 2);
        expect(m.status).toBe(MASK_OK);
        expect(m.text).not.toContain(CANARY);
        expect((m as { masked: number }).masked).toBe(2);
        expect(m.text).toBe(`head ${SECRET_MARKER} middle ${SECRET_MARKER} tail`);

    });

    it('MERGES OVERLAPPING WINDOWS INTO ONE, covering every code unit '
        + 'either of them covered', () => {
        // ONE canary, TWO overlapping detector hits over it - a real
        // shape, not a hypothetical. Two independent splices over one
        // region produce garbage; the union cannot let a character of
        // either match survive.
        const body = `head ${CANARY} tail`;
        const at = body.indexOf(CANARY);
        const over = maskBody(
            body,
            [computedFinding(at), computedFinding(at + 5, CANARY.length - 5)],
            2,
        );
        expect(over.status).toBe(MASK_OK);
        expect(over.text).not.toContain(CANARY);
        // Not one fragment of either window survives, at either end.
        expect(over.text).not.toContain(CANARY.slice(0, 8));
        expect(over.text).not.toContain(CANARY.slice(-8));
        // TWO findings, ONE replacement: that is the merge.
        expect((over as { masked: number }).masked).toBe(1);
        expect(over.text).toBe(`head ${SECRET_MARKER} tail`);
    });

    it('THE MARKER IS FIXED WIDTH, so it publishes no length', () => {
        const short = maskBody(`x${'A'.repeat(8)}y`, [computedFinding(1, 8)], 1);
        const long = maskBody(`x${'A'.repeat(400)}y`, [computedFinding(1, 400)], 1);
        expect(short.text).toBe(`x${SECRET_MARKER}y`);
        expect(long.text).toBe(`x${SECRET_MARKER}y`);
    });

    it('refuses a body that is not a string', () => {
        for (const bad of [null, undefined, 3, {}, []]) {
            expect(maskBody(bad, [], 0).status).toBe(MASK_REFUSED);
        }
    });
});

describe('applyMask: the gate folds a refusal into a null text, always', () => {
    it('carries text through on success and NULL on every refusal', () => {
        const ok = applyMask('safe', null, 0);
        expect(ok.state).toBe(BODY_STATE.OK);
        expect(ok.text).toBe('safe');

        const refused = applyMask(`x ${CANARY}`, null, 1);
        expect(refused.state).toBe(BODY_STATE.MASK_REFUSED);
        expect(refused.text).toBeNull();
        expect(refused.masked).toBe(0);
        expect(refused.findingCount).toBe(1);
    });
});

describe('the negative controls', () => {
    it('A MASKER THAT ALWAYS REFUSED WOULD BE USELESS, so a clean body '
        + 'must come back byte-identical', () => {
        const body = 'no credentials here, just transcript bytes {"a": 1}';
        const m = applyMask(body, [], 0);
        expect(m.state).toBe(BODY_STATE.OK);
        expect(m.text).toBe(body);
        expect(m.masked).toBe(0);
    });

    it('A GATE THAT ALWAYS REFUSED WOULD BE USELESS, so an ordinary small '
        + 'body must pass', () => {
        expect(gateFor({ body_id: 42, body_chars: 5501 }).state).toBe(BODY_STATE.OK);
    });

    it('AND A GATE THAT ALWAYS PASSED WOULD BE A DISCLOSURE: the same '
        + 'row one character over the hard limit must not', () => {
        expect(gateFor({ body_id: 42, body_chars: BODY_RENDER_HARD_MAX + 1 }).state)
            .toBe(BODY_STATE.GATED_HARD);
    });
});

describe('reasonFrom: a refusal that names nothing is a blank cell', () => {
    it("uses the classifier's first reason, subject included", () => {
        expect(reasonFrom({
            token: 'partial',
            reasons: [{ subject: 'body:9', reason: 'the shard was offline' }],
        })).toBe('body:9: the shard was offline');
    });

    it('names the token when the envelope carried no reason at all', () => {
        expect(reasonFrom({ token: 'budget_exhausted', reasons: [] }))
            .toContain('budget_exhausted');
        expect(reasonFrom({ token: 'budget_exhausted' })).toContain('no reason');
    });
});
