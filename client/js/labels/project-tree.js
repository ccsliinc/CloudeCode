/**
 * Every sentence the project tree can print, assembled in one place.
 *
 * SLICE 4's HALF OF THE STRING LAYER. The pattern is the one
 * `session-summary.js` and `recent-session.js` set: a pure ES module
 * taking `(data, t)`, imported directly by the Svelte tree and reachable
 * from the legacy tree through `globalThis.CloudeLabels`. A catalog
 * alone would still let two callers drift on WHICH keys they combine and
 * in what order, which renders as two different sentences for one state.
 *
 * WHY A REASON IS A KEY AND A DETAIL IS NOT. The seven NEEDS ATTENTION
 * reasons are this app's own explanations, so they are catalog messages.
 * The `detail` beside one of them is the SERVER's sentence about which
 * read failed, and it arrives on the wire; translating it here would
 * mean inventing a key namespace for text this client has never seen.
 * So `attentionReason` prefers the detail verbatim when it exists and
 * falls back to the message otherwise, which is the legacy rule
 * (`detail || 'project attribution could not be read'`) written out.
 *
 * NO STRING IN HERE IS A LITERAL. Everything is a `t()` call or a value
 * that came in as data, which is what
 * `web/src/lib/i18n/coverage.test.ts` scans this file for.
 */

/** Every key this surface asks the catalog for. */
export const PROJECT_TREE_KEYS = {
    emptyTitle: 'project.list.empty',
    emptyHint: 'project.list.empty.hint',
    noProject: 'project.tree.no_project',
    sessionCount: 'project.tree.session_count',
    attentionHead: 'project.tree.attention.head',
    attentionTitle: 'project.tree.attention.title',
    toggleAria: 'project.node.toggle.aria',
    archivedCount: 'project.archived.notice.count',
    archivedUnknown: 'project.archived.notice.unknown',
    authorityUnknown: 'project.authority.unknown',
    presenceMissing: 'project.presence.missing',
    presenceUnreachable: 'project.presence.unreachable',
    presenceUnreachableDetailUnknown: 'project.presence.unreachable.detail_unknown',
    badgeArchived: 'project.badge.archived',
    actionEdit: 'project.action.edit',
    actionArchiveTitle: 'project.action.archive.title',
    actionArchiveAria: 'project.action.archive.aria',
    actionRestoreTitle: 'project.action.restore.title',
    actionRestoreAria: 'project.action.restore.aria',
    archivedShow: 'project.archived.show',
    archivedHide: 'project.archived.hide',
    projectWorkUnrecorded: 'project.work.unrecorded',
    sessionWorkUnrecorded: 'session.work.unrecorded',
    badgeTmux: 'session.badge.tmux',
    badgeExternal: 'session.badge.external',
    badgeEnded: 'session.badge.ended',
    familyUnknown: 'session.agent.family.unknown',
};

/**
 * How many sessions a group holds, as a sentence.
 *
 * Description: a PLURAL SET, not the `n === 1 ? '' : 's'` ternary it
 *   replaces. That ternary is a two-form plural in disguise: correct for
 *   English and wrong for every language with a `few` or a `many`.
 * Inputs: count (number). t (function).
 * Output: string.
 * Example: sessionCountLabel(1, t)  // '1 session'
 */
export function sessionCountLabel(count, t) {
    return t(PROJECT_TREE_KEYS.sessionCount, { count: count });
}

/**
 * The NEEDS ATTENTION group's heading sentence.
 *
 * Inputs: count (number) - how many sessions could not be placed.
 *   t (function).
 * Output: string.
 * Example: attentionTitle(2, t)
 *   // '2 sessions could not be attributed to a project'
 */
export function attentionTitle(count, t) {
    return t(PROJECT_TREE_KEYS.attentionTitle, { count: count });
}

/**
 * The explanation shown beside one un-attributable session.
 *
 * Description: THE SERVER'S OWN DETAIL OUTRANKS THE CATALOG. When the
 *   whole records fetch failed the server said which read failed, and
 *   this tree cannot write that sentence. Every other reason is ours and
 *   comes from the catalog.
 * Inputs: item ({reasonKey, detail}) - one AttentionItem. t (function).
 * Output: string.
 * Example: attentionReason({reasonKey: 'project.attention.no_record'}, t)
 *   // 'no stored attribution for this session'
 */
export function attentionReason(item, t) {
    if (!item) return '';
    const detail = item.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    return t(item.reasonKey);
}

/**
 * The archived dimension's status line, or null when it says nothing.
 *
 * Description: THREE OUTCOMES, and returning null for the first is the
 *   point. The toggle being off means nothing was asked, and a line
 *   saying "unknown" about a question nobody posed is furniture. A
 *   measured zero and a failed fetch are two DIFFERENT sentences, never
 *   one.
 * Inputs: notice ({kind, count}) - from project-chrome.archivedNotice.
 *   t (function).
 * Output: string|null.
 * Example: archivedNoticeText({kind: 'count', count: 0}, t)
 *   // 'showing archived: 0'
 */
export function archivedNoticeText(notice, t) {
    if (!notice) return null;
    if (notice.kind === 'count') {
        return t(PROJECT_TREE_KEYS.archivedCount, { count: notice.count });
    }
    if (notice.kind === 'unknown') return t(PROJECT_TREE_KEYS.archivedUnknown);
    return null;
}

/**
 * The provenance banner's sentence, or null when the healthy case draws
 * nothing.
 *
 * Description: the DEGRADED case renders the SERVER's own message, not a
 *   catalog one, because the server knows which datastore read failed
 *   and that writes are refused. The unknown case is ours.
 * Inputs: banner ({kind, message}) - from project-chrome.authorityBanner.
 *   t (function).
 * Output: string|null.
 * Example: authorityBannerText({kind: 'unknown'}, t)
 */
export function authorityBannerText(banner, t) {
    if (!banner) return null;
    if (banner.kind === 'unknown') return t(PROJECT_TREE_KEYS.authorityUnknown);
    if (banner.kind === 'degraded') return banner.message || '';
    return null;
}

/**
 * The presence badge's text, or null when the row draws no badge.
 *
 * Description: `unchecked` and `present` BOTH draw nothing, and that is
 *   deliberate: not yet probed is not evidence of anything wrong.
 *   `missing` and `unreachable` are never the same string, because
 *   collapsing "your project is gone" and "I could not check" into one
 *   look is the exact bug the presence table exists to expose.
 * Inputs: state (string) - the PresenceState. detail (string|null) - the
 *   server's reason, for `unreachable`. t (function).
 * Output: string|null.
 * Example: presenceBadgeText('missing', null, t)
 */
export function presenceBadgeText(state, detail, t) {
    if (state === 'missing') return t(PROJECT_TREE_KEYS.presenceMissing);
    if (state === 'unreachable') {
        const reason = (typeof detail === 'string' && detail.trim())
            ? detail
            : t(PROJECT_TREE_KEYS.presenceUnreachableDetailUnknown);
        return t(PROJECT_TREE_KEYS.presenceUnreachable, { detail: reason });
    }
    return null;
}

/**
 * The hover text for one work-recency attribute set, or null.
 *
 * Description: a RECORDED row hovers nothing - the timestamp is on the
 *   element for the stylesheet and for anything reading the DOM. Only
 *   the UNRECORDED case has something to say, and what it says is that
 *   nothing has happened here yet rather than that this is the oldest
 *   thing you own.
 * Inputs: work ({state, titleKey}). t (function).
 * Output: string|null.
 * Example: workTitle({state: 'unrecorded', titleKey: 'project.work.unrecorded'}, t)
 */
export function workTitle(work, t) {
    if (!work || !work.titleKey) return null;
    return t(work.titleKey);
}
