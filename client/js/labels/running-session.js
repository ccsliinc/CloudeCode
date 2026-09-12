/**
 * Every sentence the running-sessions list can print, assembled here.
 *
 * SLICE 5's HALF OF THE STRING LAYER. Same pattern as
 * `session-summary.js`, `recent-session.js` and `project-tree.js`: a pure
 * ES module taking `(data, t)`, imported directly by the Svelte tree and
 * reachable from the legacy tree through `globalThis.CloudeLabels`. A
 * catalog alone would still let two callers drift on WHICH keys they
 * combine and in what order, which renders as two different sentences for
 * one state.
 *
 * THE AGE IS FOUR MESSAGES AND A REFUSAL, NOT A FORMAT STRING. The legacy
 * `_formatRelativeTime` built `${n}s ago` by concatenation, which is
 * untranslatable twice over: the unit and the word order are both part of
 * the sentence, and a count is a plural even when English happens not to
 * inflect it. A missing or non-numeric epoch answers `unknown` rather
 * than `0s ago`, because not having a timestamp is not the same fact as
 * having a very recent one.
 *
 * THE COUNT HAS NO ZERO MESSAGE, DELIBERATELY. The section HIDES on a
 * measured zero, so "0 running" is never on screen; a zero key would be
 * copy no translator could ever see in context. The UNMEASURED case is a
 * different message entirely, and that one does render.
 *
 * NO STRING IN HERE IS A LITERAL. Everything is a `t()` call or a value
 * that came in as data, which is what
 * `web/src/lib/i18n/coverage.test.ts` scans this file for.
 */

/** Every key this surface asks the catalog for. */
export const RUNNING_SESSION_KEYS = {
    attentionHead: 'session.listing.attention.head',
    attentionTitle: 'session.listing.attention.title',
    attentionDetail: 'session.listing.attention.detail',
    attentionSourcesUnknown: 'session.listing.attention.sources.unknown',
    attentionNote: 'session.listing.attention.note',
    count: 'session.running.count',
    countUnavailable: 'session.running.count.unavailable',
    rowIdTitle: 'session.row_id.title',
    ageSeconds: 'session.age.seconds',
    ageMinutes: 'session.age.minutes',
    ageHours: 'session.age.hours',
    ageDays: 'session.age.days',
    ageUnknown: 'session.age.unknown',
    renameAction: 'session.rename.action',
    renameUnopened: 'session.rename.unavailable.unopened',
    renameUnadopted: 'session.rename.unavailable.unadopted',
    renameUnknownOwner: 'session.rename.unavailable.unknown_owner',
    renameInputAria: 'session.rename.input.aria',
    renameFailed: 'session.rename.failed',
    renameFailedInUse: 'session.rename.failed.in_use',
    renameFailedInvalid: 'session.rename.failed.invalid',
    renameFailedMissing: 'session.rename.failed.missing',
    renameRuleUnavailable: 'session.rename.rule_unavailable',
    forkAction: 'session.fork.action',
    forkAria: 'session.fork.action.aria',
    forkTitle: 'session.fork.action.title',
    actionClose: 'session.action.close',
    actionRemove: 'session.action.remove',
    actionRestart: 'session.action.restart',
    actionFailed: 'session.action.failed',
    unreadClear: 'session.unread.clear',
    unreadSet: 'session.unread.set',
    startupGateLabel: 'session.startup_gate.label',
    startupGateReason: 'session.startup_gate.reason',
    themeSwatch: 'session.theme.swatch',
    wrapperTitle: 'session.wrapper.title',
    badgeTmux: 'session.badge.tmux',
    badgeExternal: 'session.badge.external',
    respawnNoPicker: 'session.respawn.no_picker',
    respawnUnpredictable: 'session.respawn.unpredictable',
    respawnFailed: 'session.respawn.failed',
    respawnNoReason: 'session.respawn.failed.no_reason',
    respawnChoiceUnsaved: 'session.respawn.choice_unsaved',
    respawnNoReopen: 'session.respawn.no_reopen',
    attachFailed: 'session.attach.failed',
    serverUnreachable: 'error.server_unreachable',
    apiUnavailable: 'session.api.unavailable',
};

/** Seconds in a minute, an hour and a day, named rather than inline. */
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * The heading's count line.
 *
 * Description: a PLURAL SET selected by `Intl.PluralRules`, never a
 *   `n === 1 ? a : b` ternary - that shape is only correct for two-form
 *   languages and is the single most common way a count goes wrong.
 * Inputs: count (number) - how many rows the list is showing.
 *   t (function) - the translator.
 * Output: string.
 * Example: runningCountLabel(1, t)  // '1 running'
 */
export function runningCountLabel(count, t) {
    return t(RUNNING_SESSION_KEYS.count, { count: count });
}

/**
 * What the heading says when the probe did not answer.
 *
 * Description: the heading must never assert a number the app did not
 *   measure. "you have no sessions" and "I could not find out" are
 *   different facts and this is the second one.
 * Inputs: t (function). Output: string.
 * Example: runningCountUnavailableLabel(t)  // 'count could not be determined'
 */
export function runningCountUnavailableLabel(t) {
    return t(RUNNING_SESSION_KEYS.countUnavailable);
}

/**
 * The NEEDS ATTENTION block's detail line.
 *
 * Description: THE SERVER'S OWN SENTENCE OUTRANKS THE CATALOG for the
 *   `detail` slot, exactly as `project-tree.js::attentionReason` does:
 *   that text arrives on the wire and translating it here would mean
 *   inventing a key namespace for text this client has never seen. The
 *   reason token is an identifier and rides through verbatim. Only the
 *   two fallbacks and the punctuation around them are catalog messages.
 * Inputs: listing (object) - `{reason, detail, sources}` as the store
 *     holds it. t (function).
 * Output: string.
 * Example: listingAttentionDetail({reason: 'probe_error', detail: null,
 *     sources: ['live']}, t)
 *   // 'the server could not be reached (live probe, probe_error)'
 */
export function listingAttentionDetail(listing, t) {
    const state = listing || {};
    const detail = state.detail || t(RUNNING_SESSION_KEYS.serverUnreachable);
    const sources = (state.sources && state.sources.length)
        ? state.sources.join(' + ')
        : t(RUNNING_SESSION_KEYS.attentionSourcesUnknown);
    return t(RUNNING_SESSION_KEYS.attentionDetail, {
        detail: detail,
        sources: sources,
        reason: state.reason || 'probe_error',
    });
}

/**
 * How long ago a session was created, in words.
 *
 * Description: FOUR MESSAGES AND A REFUSAL. A missing, null or
 *   non-numeric epoch answers the `unknown` message rather than a zero,
 *   because not having a timestamp is a different fact from having a very
 *   recent one. The delta is floored at zero so a clock that disagrees
 *   with the server cannot render a negative age.
 * Inputs: epochSeconds (number|null|undefined) - unix seconds.
 *   t (function). nowMs (number, optional) - injectable clock, so a test
 *     does not have to move the real one.
 * Output: string.
 * Example: relativeAge(Math.floor(Date.now() / 1000) - 90, t)  // '1m ago'
 */
export function relativeAge(epochSeconds, t, nowMs) {
    if (!epochSeconds || typeof epochSeconds !== 'number') {
        return t(RUNNING_SESSION_KEYS.ageUnknown);
    }
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const delta = Math.max(0, Math.floor(now / 1000) - epochSeconds);
    if (delta < MINUTE) {
        return t(RUNNING_SESSION_KEYS.ageSeconds, { count: delta });
    }
    if (delta < HOUR) {
        return t(RUNNING_SESSION_KEYS.ageMinutes, {
            count: Math.floor(delta / MINUTE),
        });
    }
    if (delta < DAY) {
        return t(RUNNING_SESSION_KEYS.ageHours, {
            count: Math.floor(delta / HOUR),
        });
    }
    return t(RUNNING_SESSION_KEYS.ageDays, { count: Math.floor(delta / DAY) });
}

/**
 * The sentence a failed destructive row action prints.
 *
 * Description: the action word is the user-facing label, not the internal
 *   id, so a failed `remove` does not read as a failed `ACTION_REMOVE`.
 * Inputs: actionLabel (string) - already-translated action name.
 *   reason (string). t (function).
 * Output: string.
 * Example: rowActionFailed('close session', 'HTTP 500', t)
 */
export function rowActionFailed(actionLabel, reason, t) {
    return t(RUNNING_SESSION_KEYS.actionFailed, {
        action: actionLabel,
        reason: reason,
    });
}
