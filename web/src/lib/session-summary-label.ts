/**
 * The group summary sentence, for the compiled tree.
 *
 * THIS FILE HOLDS NO COPY AND NO ASSEMBLY, WHICH IS THE POINT. Both live
 * in `client/js/labels/session-summary.js`, which this imports directly
 * and which the legacy tree reaches through the global `boot.js`
 * publishes. So the two trees are not two implementations that agree -
 * they are one implementation with two callers, and the only thing this
 * file adds is the reactive accessor.
 *
 * Compare `status-dot.ts`, which is a genuine PORT of a legacy module and
 * therefore needs a byte-for-byte parity test to stay honest. This needs
 * one too, and gets it, but for a narrower reason: to prove the shared
 * module really is shared and that neither caller has quietly grown its
 * own sentence.
 */
import { sessionSummaryLabel } from '../../../client/js/labels/session-summary.js';
import { t as reactiveT } from './i18n/index.svelte';

/** A group roll-up, as `SessionStatusSummary.summarizeStates` returns it. */
export interface SessionSummary {
    /** The winning bucket key, e.g. 'working'. */
    bucket?: string;
    /** How many sessions were folded. */
    total?: number;
    /** How many of them are unread. */
    unreadCount?: number;
}

/** The accessor shape, so a test can pass its own locale's. */
export type Translate = (key: string, params?: Record<string, unknown> | null) => string;

/**
 * The finished sentence for one group.
 *
 * Description: delegates to the shared assembler. `t` is a parameter with
 *   a default rather than a hard import so a test can drive it in the
 *   pseudo-locale without moving the running app's locale; every
 *   real caller omits it and gets the reactive one, which is what makes a
 *   component repaint when the locale changes.
 * Inputs:
 *   summary - a `summarizeStates` result.
 *   t - the accessor. Defaults to the reactive one.
 * Output: string.
 * Example:
 *   summaryLabel({ bucket: 'working', total: 2, unreadCount: 1 })
 *   // 'working - 2 sessions, 1 unread'
 */
export function summaryLabel(summary: SessionSummary, t: Translate = reactiveT): string {
    return sessionSummaryLabel(summary, t) as string;
}
