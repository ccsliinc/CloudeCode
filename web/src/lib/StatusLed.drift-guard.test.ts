/**
 * THE DRIFT GUARD: proves the TypeScript LED port's INNER_STATES and
 * OUTER_STATES are the shipped legacy vocabularies, read off disk, order
 * included - not a hand-written list the porter might misremember.
 *
 * Split out of StatusLed.test.ts, formerly the first two cases inside
 * describe('the vocabularies'). The rest of that describe block - the
 * behavioural assertions about the port's own vocabularies that need no
 * legacy sandbox - now lives in StatusLed.behaviour.test.ts. The sandbox
 * loader both this file and StatusLed.parity.test.ts share lives in
 * led-legacy-fixture.ts.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test } from 'vitest';

import * as Led from './led';
import { legacy } from './led-legacy-fixture';

describe('the vocabularies', () => {
    test('THE DRIFT GUARD: the port\'s vocabularies ARE the legacy ones', () => {
        // THIS IS THE CASE THAT CATCHES A SILENT PORT ROT, and it is here
        // because the LED has already rotted once this way. Every matrix
        // loop below enumerates `Led.INNER_STATES` and `Led.OUTER_STATES`
        // - the PORT's own lists. If a release grew, renamed or reordered
        // a state in client/js/status-led.js, those loops would keep
        // covering the old set perfectly, every byte-for-byte comparison
        // would keep passing, and the new state would simply never be
        // visited. A clean rebase would report nothing, because the two
        // files do not conflict: they are different files.
        //
        // The block below pins the port against a HAND-WRITTEN list, which
        // proves only that the port agrees with what its author
        // remembered. This one pins it against the shipped module itself,
        // read off disk, so the two cannot come apart unnoticed. Order is
        // compared too: `resolveInner` falls back on membership, but the
        // docs and the stylesheet both read these as an ordered set.
        const real = legacy();
        expect([...Led.INNER_STATES]).toEqual(real.INNER_STATES);
        expect([...Led.OUTER_STATES]).toEqual(real.OUTER_STATES);
    });

    test('NEGATIVE CONTROL: the drift guard can actually fail', () => {
        // A comparison against a list that came back empty or undefined
        // would pass vacuously and guard nothing.
        const real = legacy();
        expect(real.INNER_STATES.length).toBeGreaterThan(0);
        expect(real.OUTER_STATES.length).toBeGreaterThan(0);
        expect([...Led.INNER_STATES]).not.toEqual([...real.INNER_STATES, 'banana']);
        expect([...Led.INNER_STATES]).not.toEqual(real.OUTER_STATES);
    });
});
