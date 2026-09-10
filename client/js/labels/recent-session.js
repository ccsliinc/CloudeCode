/**
 * Every sentence the RECENT group says, assembled in one place.
 *
 * WHAT THIS REPLACES. `Launchpad._renderRecentSessionRowHtml`,
 * `renderRecentSessions`, `_restartPlan`, `_restartNotice`,
 * `_deleteSessionRecord` and `_forkSession` each built their copy inline:
 * a `n === 1 ? '1 recent' : n + ' recent'` ternary, a
 * `` ` "${title}"` `` fragment glued into the middle of a restart
 * message, and a dozen bare literals in markup templates. Every one of
 * those is untranslatable. A concatenation fixes word order, a `=== 1`
 * ternary is only correct for a two-form language, and a fragment
 * assembled outside a message cannot be moved by a translation to where
 * that language actually wants the name.
 *
 * THE NAMED / UNNAMED PAIRS ARE THE POINT, not verbosity. `_restartNotice`
 * built `` const named = result.title_carried ? ` "${x}"` : ''; `` and
 * interpolated it into three different sentences. That is exactly the
 * shape `.claude/notes/i18n-design.md` measured as the trap: a hardcoded
 * fragment passed as a PARAMETER is wrapped by the outer message, so the
 * balanced-span check passes and only the source scan catches it. Two
 * whole keys per outcome costs a translator nothing and cannot drift.
 *
 * PURE, AND `t` IS AN ARGUMENT. It touches no DOM, no globals and no
 * locale of its own, so a test can drive it in the pseudo locale without
 * moving the running app's. Same shape as ./session-summary.js, which is
 * the worked example this file follows.
 *
 * THIS FILE IS SCANNED BY THE COVERAGE GUARD (`PORTED_FILES` in
 * web/src/lib/i18n/coverage.test.ts). A string literal here that reads
 * like a sentence fails the build, which is the whole reason the copy
 * lives in the catalog and only the KEYS live here.
 */

/**
 * The catalog keys this surface is built from, in one place.
 *
 * Description: exported so the coverage test can assert every one of
 *   them exists in the catalog, and so a reader chasing "where does that
 *   sentence come from" finds the answer without reading a function.
 *   Grouped by the domain concept rather than by where it is painted -
 *   the launchpad is being rewritten around these and a key that named a
 *   screen would die with it.
 */
export const RECENT_KEYS = {
    /** The group's own count, and the slot when it cannot be determined. */
    count: 'session.recent.count',
    countUnavailable: 'session.recent.count.unavailable',
    /** The three-outcome block: a state that is not `ok`. */
    unavailableTitle: 'session.recent.unavailable.title',
    unavailableDetail: 'session.recent.unavailable.detail',
    loadFailed: 'session.recent.load_failed',
    /** `ok` with nothing in it, while the archive filter is on. */
    emptyIncludingArchived: 'session.recent.empty_including_archived',
    /** A lifecycle a restart may act on. */
    lifecycleEnded: 'session.recent.lifecycle.ended',
    /** What a row is called when nothing named it. */
    nameFallback: 'session.name.fallback',
    /** The soft archive: its control, its badge and its filter. */
    archiveAction: 'session.archive.action',
    archiveActionTitle: 'session.archive.action.title',
    archiveActionAria: 'session.archive.action.aria',
    archiveBadge: 'session.archive.badge',
    archiveBadgeTitle: 'session.archive.badge.title',
    archiveShow: 'session.archive.show',
    archiveHide: 'session.archive.hide',
    archiveFailedNoId: 'session.archive.failed.no_id',
    archiveFailed: 'session.archive.failed',
    /** Restart, and the four things the server can answer about it. */
    restartAction: 'session.restart.action',
    restartFailed: 'session.restart.failed',
    restartUnidentified: 'session.restart.unidentified',
    restartUnidentifiedNamed: 'session.restart.unidentified.named',
    restartUnsaid: 'session.restart.unsaid',
    restartNoneRecorded: 'session.restart.none_recorded',
    restartNoneRecordedNamed: 'session.restart.none_recorded.named',
    restartUnknown: 'session.restart.unknown',
    restartUnknownNamed: 'session.restart.unknown.named',
    restartRowNotReused: 'session.restart.row_not_reused',
    restartRowNotReusedNamed: 'session.restart.row_not_reused.named',
    /** Fork, and its one refusal that is not a failure. */
    forkFailedNoName: 'session.fork.failed.no_name',
    forkFailedNoConversation: 'session.fork.failed.no_conversation',
    forkFailed: 'session.fork.failed',
    forkLineageUnrecorded: 'session.fork.lineage_unrecorded',
    /** The `{reason}` slot when an error carried no message of its own. */
    serverUnreachable: 'error.server_unreachable',
};

/**
 * Pick the named or the unnamed variant of one message.
 *
 * Description: the ONE place the named/unnamed branch is decided, so the
 *   nine restart messages cannot each grow their own idea of what an
 *   empty title means. A title that is absent, null, or whitespace is
 *   the SAME case as no title at all - a sentence reading `restarted ""`
 *   is worse than one that simply does not name anything.
 * Inputs:
 *   plainKey (string) - the catalog key with no `{title}` hole.
 *   namedKey (string) - the catalog key that carries `{title}`.
 *   title (string|null|undefined) - the user's own label for the row.
 *   t (function) - `(key, params) => string`.
 * Output: string - one assembled sentence.
 * Example: pickNamed(K.restartUnknown, K.restartUnknownNamed, 'Media', t)
 */
function pickNamed(plainKey, namedKey, title, t) {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    return trimmed ? t(namedKey, { title: trimmed }) : t(plainKey);
}

/**
 * The count shown beside the group heading.
 *
 * Description: a plural set, selected by `Intl.PluralRules` on `count`.
 *   English renders both forms identically and that is not a reason to
 *   collapse it: a locale with a `few` or a `many` needs the set, and
 *   the ternary this replaces could not express one.
 * Inputs: count (number) - how many rows are on screen. t (function).
 * Output: string.
 * Example: recentCountLabel(1, t)  // '1 recent'
 */
export function recentCountLabel(count, t) {
    return t(RECENT_KEYS.count, { count });
}

/**
 * The count slot when the group's state is not `ok`.
 *
 * Inputs: t (function). Output: string.
 * Example: recentCountUnavailableLabel(t)  // 'cannot determine'
 */
export function recentCountUnavailableLabel(t) {
    return t(RECENT_KEYS.countUnavailable);
}

/**
 * The detail line of the three-outcome block.
 *
 * Description: THE SERVER'S OWN NOTICE WINS. It knows which probe failed
 *   and why, and this fallback exists only for a body that arrived
 *   without one. The fallback says what was not done rather than
 *   anything a reader could take as "there is nothing here", because an
 *   empty list is precisely what this whole block exists to not be.
 * Inputs: notice (string|null|undefined) - the wire's `notice`.
 *   t (function).
 * Output: string.
 * Example: unavailableDetail(null, t)
 */
export function unavailableDetail(notice, t) {
    const trimmed = typeof notice === 'string' ? notice.trim() : '';
    return trimmed || t(RECENT_KEYS.unavailableDetail);
}

/**
 * The notice for a fetch that threw before any state was read.
 *
 * Description: a client-side failure has no server notice to prefer, so
 *   this is the whole sentence. The reason is a parameter rather than a
 *   concatenation so a translation can put it wherever it belongs.
 * Inputs: error (Error|null|undefined) - what the fetch threw.
 *   t (function).
 * Output: string.
 * Example: loadFailedNotice(new Error('timeout'), t)
 */
export function loadFailedNotice(error, t) {
    return t(RECENT_KEYS.loadFailed, { reason: reasonOf(error, t) });
}

/**
 * An error's own message, or the generic one when it carried none.
 *
 * Description: shared by every failure sentence in this file, so
 *   `undefined` can never reach a `{reason}` hole and render the
 *   parameter name on screen.
 * Inputs: error (unknown) - anything a rejected promise handed back.
 *   t (function).
 * Output: string.
 * Example: reasonOf(new Error('timeout'), t)  // 'timeout'
 */
export function reasonOf(error, t) {
    const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message || '').trim()
        : '';
    return message || t(RECENT_KEYS.serverUnreachable);
}

/**
 * Turn a restart response into the one sentence the user must see.
 *
 * THREE OUTCOMES, NEVER TWO, and this is the port of
 * `Launchpad._restartNotice` rather than a rewrite of it. `conversation`
 * is `resumed` (the old conversation continues in a new tmux session),
 * `none_recorded` (the replaced row never learned a claude session uuid,
 * so this is a NEW conversation wearing the old name) or `unknown` (the
 * row could not be read). Rendering the second or third like the first
 * is the defect the whole restart change repaired: a blank session
 * presented as a continued one.
 *
 * A RESUMED RESTART WHOSE LINEAGE STAMP FAILED STILL GETS A SENTENCE.
 * The session exists and works; it is simply not linked back to the one
 * it replaced, which is neither a failure nor a clean success.
 *
 * Inputs: result (object|null) - the RestartSessionResponse body.
 *   t (function).
 * Output: string|null - null ONLY for a fully clean resume, so a
 *   non-null return means "say this".
 * Example: restartNotice({ conversation: 'none_recorded' }, t)
 */
export function restartNotice(result, t) {
    if (!result) return t(RECENT_KEYS.restartUnsaid);
    const kind = result.conversation;
    const title = result.title_carried;
    if (kind === 'none_recorded') {
        return pickNamed(
            RECENT_KEYS.restartNoneRecorded,
            RECENT_KEYS.restartNoneRecordedNamed,
            title, t,
        );
    }
    if (kind !== 'resumed') {
        return pickNamed(
            RECENT_KEYS.restartUnknown, RECENT_KEYS.restartUnknownNamed, title, t,
        );
    }
    if (result.row_reused === false) {
        // THE SERVER'S OWN `detail` WINS when it sent one: it can name
        // the row it could not keep, which this generic sentence cannot.
        const detail = typeof result.detail === 'string' ? result.detail.trim() : '';
        if (detail) return detail;
        return pickNamed(
            RECENT_KEYS.restartRowNotReused,
            RECENT_KEYS.restartRowNotReusedNamed,
            title, t,
        );
    }
    return null;
}

/**
 * The sentence for a restart that could not identify what it replaced.
 *
 * Description: the `create_unidentified` half of the restart plan. A
 *   session IS still created - the user asked for one, and the name,
 *   directory and agent are all still worth carrying - and this notice
 *   is non-null so the caller MUST say what could not be determined.
 *   The third outcome, not a silent degrade to a blank console.
 * Inputs: title (string|null) - the row's own label, if it had one.
 *   t (function).
 * Output: string.
 * Example: unidentifiedRestartNotice('Media', t)
 */
export function unidentifiedRestartNotice(title, t) {
    return pickNamed(
        RECENT_KEYS.restartUnidentified,
        RECENT_KEYS.restartUnidentifiedNamed,
        title, t,
    );
}

/**
 * The sentence for a fork that failed, by why it failed.
 *
 * Description: a 409 is a REFUSAL and is reported as one - forking
 *   anyway would start a brand new conversation wearing a fork label and
 *   the user would believe they had branched their work. Every other
 *   status is a plain failure carrying the server's reason.
 * Inputs: error (object|null) - the rejected value, `status` read off it.
 *   t (function).
 * Output: string.
 * Example: forkFailureNotice({ status: 409 }, t)
 */
export function forkFailureNotice(error, t) {
    const status = error && typeof error === 'object' ? error.status : null;
    if (status === 409) return t(RECENT_KEYS.forkFailedNoConversation);
    return t(RECENT_KEYS.forkFailed, { reason: reasonOf(error, t) });
}
