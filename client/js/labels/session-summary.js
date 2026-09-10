/**
 * The group summary label, assembled once for both trees.
 *
 * WHAT THIS REPLACES. `session-status-summary.js` used to build this
 * sentence inline with `+`, a ternary for the plural and a comma glued on
 * for the unread clause. Every one of those is untranslatable: a
 * concatenation fixes word order, a `=== 1` ternary is only correct for
 * languages with two plural forms, and punctuation outside the message
 * cannot move when a translation needs it elsewhere.
 *
 * WHY IT IS A SHARED MODULE AND NOT A FUNCTION IN EACH TREE. The catalog
 * being single-source is the important half, but two assemblers reading
 * it can still drift on WHICH keys they combine and in what order, and
 * that drift renders as two different sentences for one state. So the
 * assembly lives here, as a plain ES module: the Svelte tree imports it
 * directly, and `client/js/i18n/boot.js` publishes it as
 * `globalThis.CloudeLabels` for the legacy classic scripts. One function,
 * one catalog, two callers.
 *
 * THIS IS THE SHAPE EVERY PORTED SURFACE SHOULD TAKE. A slice that moves
 * a screen into Svelte puts its label logic in a sibling of this file and
 * gets the legacy side for free, instead of leaving a string behind in a
 * file with a delete date on it. See .claude/notes/i18n-design.md.
 *
 * PURE. It takes a summary object and a `t`, and touches nothing else -
 * no DOM, no globals, no locale of its own. The `t` is passed in rather
 * than imported so a test can drive it with any locale, including the
 * pseudo one, without moving the running app's.
 */

/**
 * The catalog keys this label is built from, in one place.
 *
 * Description: exported because the coverage test asserts that every one
 *   of them exists, and because a reader looking for "where does that
 *   sentence come from" should find the answer without reading the
 *   function.
 *
 *   DELIBERATELY NOT ANNOTATED `Object<string, string>`. That is an
 *   index signature, so every lookup types as possibly-undefined and
 *   every caller has to prove otherwise. Inference from the literal
 *   below gives the six exact properties instead, which is both
 *   stricter and true.
 */
export const SUMMARY_KEYS = {
    none: 'session.summary.none',
    bucketPrefix: 'session.summary.bucket.',
    sessions: 'session.summary.sessions',
    unread: 'session.summary.unread_count',
    line: 'session.summary.line',
    lineWithUnread: 'session.summary.line_with_unread',
};

/**
 * Build the summary sentence for a group of sessions.
 *
 * Description: PURE. Reproduces exactly what `summaryHtml` used to
 *   compose by hand, and `web/src/lib/session-summary-label.parity.test.ts`
 *   holds it to that across the whole matrix of bucket, total and unread
 *   count.
 *
 *   THE ZERO CASE IS CHOSEN HERE, NOT BY THE PLURAL RULE, and the
 *   distinction is the one people get wrong. English resolves
 *   `Intl.PluralRules().select(0)` to `other`, so a plural set alone
 *   would render "0 sessions", which is grammatical and is still the
 *   wrong copy. "no sessions" is a DIFFERENT MESSAGE and picking it is a
 *   product decision, so it lives in a branch a reader can see rather
 *   than in a `zero` category a translator would have to guess at.
 * Inputs:
 *   summary (Object|null) - `{bucket, total, unreadCount}` as
 *     `SessionStatusSummary.summarizeStates` returns.
 *   t (Function) - the accessor, `(key, params) => string`.
 * Output: string - the finished sentence, already localised.
 * Example:
 *   sessionSummaryLabel({bucket: 'working', total: 2, unreadCount: 1}, t)
 *   // 'working - 2 sessions, 1 unread'
 * Example:
 *   sessionSummaryLabel({bucket: 'unknown', total: 0, unreadCount: 0}, t)
 *   // 'no sessions'
 */
export function sessionSummaryLabel(summary, t) {
    const s = summary || {};
    const total = typeof s.total === 'number' ? s.total : 0;
    const unread = typeof s.unreadCount === 'number' ? s.unreadCount : 0;

    if (total === 0) return t(SUMMARY_KEYS.none);

    const bucket = t(SUMMARY_KEYS.bucketPrefix + String(s.bucket));
    const sessions = t(SUMMARY_KEYS.sessions, { count: total });
    if (unread > 0) {
        return t(SUMMARY_KEYS.lineWithUnread, {
            bucket,
            sessions,
            unread: t(SUMMARY_KEYS.unread, { count: unread }),
        });
    }
    return t(SUMMARY_KEYS.line, { bucket, sessions });
}
