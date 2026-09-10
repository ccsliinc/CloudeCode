/**
 * The default message catalog: en.
 *
 * THIS FILE IS DATA, NOT CODE, AND THAT IS A LOAD-BEARING RULE. No
 * functions, no template literals, no imports, no computed keys. Two
 * reasons. First, a value that can run is a value that can reach for
 * something the other tree does not have, and this one file is read by
 * the legacy browser client, the Svelte bundle, vitest and the node
 * suite. Second, the server emits user-visible prose too (see
 * docs/notifications.md and the restart refusal sentences), and bringing
 * it into this same key namespace later is only cheap while this file
 * converts to a Python dict by inspection.
 *
 * THE SHAPE. Keys are flat, dotted strings. A STRING value is a message.
 * An OBJECT value is a plural set keyed by CLDR plural category, and
 * `other` is mandatory in every one of them. There is no nesting, so an
 * object value can never be ambiguous.
 *
 * KEYS NAME WHAT A STRING MEANS, NEVER WHERE IT APPEARS. `session.summary
 * .none`, never `sidebar.groupheader.emptylabel`. Slices 2 to 7 of the
 * Svelte migration are going to rewrite the screens these strings appear
 * on; a key that names a screen dies with it, and the retranslation that
 * follows is the cost this whole design exists to avoid.
 *
 * INTERPOLATION IS `{name}` AND NOTHING ELSE. No expressions, no
 * formatting directives, no nested selects. A mini-language inside a
 * message is the road back to a runtime compiler, and `script-src 'self'`
 * refuses those outright. A parameter whose value is a number is run
 * through `Intl.NumberFormat` automatically; the parameter named `count`
 * is additionally what selects the plural category.
 *
 * PUNCTUATION LIVES INSIDE THE MESSAGE. `session.summary.line` carries
 * its own separator rather than the caller concatenating one, because
 * word order and punctuation are exactly what a translation changes.
 * A message assembled by `+` in a caller cannot be translated at all.
 *
 * VOICE: lowercase and plain, per CLAUDE.md. That rule applies to every
 * value in here and a catalog is not an exemption from it.
 */

/**
 * The BCP-47 tag this catalog is written in.
 *
 * Description: kept beside the messages rather than derived from the file
 *   name, because `Intl.PluralRules` and `Intl.NumberFormat` need a real
 *   tag and the pseudo-locale's registry key is not one.
 * @type {string}
 */
export const intlLocale = 'en';

/**
 * The messages.
 *
 * Description: flat, dotted keys. String values are messages; object
 *   values are plural sets keyed by CLDR category.
 * @type {Object<string, string|Object<string, string>>}
 */
export default {
    // ---- session status vocabulary -----------------------------------
    // Ported verbatim from client/js/session-status-ui.js STATUS_LABELS.
    // Note there is no `running` key: `running` is a BACK-COMPAT ALIAS
    // for `working` from a pre-hook server, and an alias is a code
    // concern. Two identical strings in a catalog are two strings a
    // translator has to keep in step by hand, for no reason.
    'session.status.dead': 'dead - process exited',
    'session.status.question': 'your turn - claude needs your permission',
    'session.status.notice': 'your turn - claude wants your attention',
    'session.status.working_subagent': 'working - a subagent is active',
    'session.status.working': 'working',
    'session.status.finished_unread': 'done - unread',
    'session.status.idle': 'idle - read, nothing running',
    'session.status.stopped': 'ended - the session is no longer running',
    // NOT MEASURED, not "nothing is happening".
    'session.status.unknown': 'not measured',

    // ---- where a status came from ------------------------------------
    // Provenance, never state. `none` is deliberately absent: when
    // nothing measured the status there is nothing to credit.
    'session.status.source.hook': 'via hooks',
    'session.status.source.transcript': 'via transcript',
    'session.status.source.seed_row': 'via the session record',
    'session.status.source.tmux': 'via tmux',

    // ---- the group summary line --------------------------------------
    // What a sidebar group header and the launchpad top bar put in the
    // LED's title and aria-label.

    // AN EXPLICIT ZERO, NOT A CLDR `zero` CATEGORY. English resolves
    // `Intl.PluralRules().select(0)` to `other`, so "0 sessions" would be
    // grammatically correct and is still the wrong copy. Choosing this
    // message is the CALLER's decision, and keeping the two apart is why
    // the plural set below needs no `zero` case.
    'session.summary.none': 'no sessions',

    // The bucket words. One key each rather than one message with a
    // select, because a select is a mini-language and because these are
    // seven independent words a translator will want to see listed.
    'session.summary.bucket.permission': 'permission',
    'session.summary.bucket.input': 'input',
    'session.summary.bucket.working': 'working',
    'session.summary.bucket.unread': 'unread',
    'session.summary.bucket.done': 'done',
    'session.summary.bucket.dead': 'dead',
    'session.summary.bucket.unknown': 'unknown',

    // A plural set. English needs `one` and `other`; a locale that needs
    // `zero`, `two`, `few` or `many` adds them in ITS OWN catalog and
    // nothing here changes. `other` is the mandatory fallback.
    'session.summary.sessions': {
        one: '{count} session',
        other: '{count} sessions',
    },
    // Identical in English and NOT therefore redundant: `unread` is an
    // adjective agreeing with a noun this message does not carry, so
    // plenty of languages inflect it where English does not.
    'session.summary.unread_count': {
        one: '{count} unread',
        other: '{count} unread',
    },

    // The assembled line. The separator and the comma are IN the message
    // so a translation can move or replace them.
    'session.summary.line': '{bucket} - {sessions}',
    'session.summary.line_with_unread': '{bucket} - {sessions}, {unread}',

    // ---- a session's own name ----------------------------------------
    // What a row is called when nothing named it. Not "untitled", which
    // reads as a state the user put it in; this one is just the noun.
    'session.name.fallback': 'session',

    // ---- the recent group --------------------------------------------
    // Stored history, read from the sessions table rather than probed
    // from tmux. Keys name the DOMAIN, so they survive the launchpad
    // being rewritten around them.

    // A PLURAL SET EVEN THOUGH BOTH FORMS ARE IDENTICAL IN ENGLISH. The
    // code this replaced was `n === 1 ? '1 recent' : n + ' recent'`, and
    // that ternary is a two-form plural in disguise: correct for English
    // and wrong for every language with a `few` or a `many`. Written as
    // a set, a translator can inflect it without touching code.
    'session.recent.count': {
        one: '{count} recent',
        other: '{count} recent',
    },
    // The same slot when the group could not be determined at all. Not a
    // number, so not part of the set above.
    'session.recent.count.unavailable': 'cannot determine',

    // THE THREE-OUTCOME BLOCK. `GET /sessions/recent` answers `ok`,
    // `probe_unavailable` or `never_probed`, and anything but `ok` must
    // say so rather than render an empty list, which is indistinguishable
    // from "you have no history". The shout is kept because uncertainty
    // is what it marks; the sentence starts lowercase because the voice
    // rule applies to a catalog too.
    'session.recent.unavailable.title': 'recent sessions CANNOT BE DETERMINED',
    // The detail line's FALLBACK ONLY. The server sends its own `notice`
    // for this state and that is preferred; this is what fills the slot
    // when a body arrives without one, and it says what was not done
    // rather than implying there is nothing there.
    'session.recent.unavailable.detail': 'the last read of the stored session records did not answer',
    // The client-side failure, where there is no server notice to use.
    'session.recent.load_failed': 'recent sessions could not be loaded: {reason}',
    // AN EMPTY RESULT WITH THE ARCHIVE FILTER ON IS A REAL ANSWER, and
    // it needs saying: the section stays up so the toggle that turned it
    // on is still reachable.
    'session.recent.empty_including_archived': 'no recent or archived sessions',
    // A lifecycle we can act on, as a word. `.recent-session-lifecycle`
    // carries `text-transform: uppercase`, so CASING IS THE
    // STYLESHEET'S JOB and this value is lowercase like every other.
    'session.recent.lifecycle.ended': 'ended',

    // ---- archiving a session ------------------------------------------
    // A SOFT ARCHIVE, NEVER A DELETE. `DELETE /sessions/records/{uuid}`
    // stamps `archived_at`; the row keeps every column and a restart is
    // what brings it back. The class names and the localStorage key still
    // say "deleted" on purpose (changing the key would silently reset the
    // preference for everyone who set it) - only the copy says archive,
    // and tests/test_no_delete_wording keeps it that way.
    'session.archive.action': 'archive',
    'session.archive.action.title': 'archive this session from your lists (the record is kept)',
    'session.archive.action.aria': 'archive this session from your lists',
    // Uppercased by `.recent-session-deleted` in the stylesheet.
    'session.archive.badge': 'archived',
    'session.archive.badge.title': 'you archived this from your lists; restart brings it back',
    'session.archive.show': 'show archived sessions',
    'session.archive.hide': 'hide archived sessions',
    'session.archive.failed.no_id': 'cannot archive: this row carries no session id',
    'session.archive.failed': 'failed to archive session: {reason}',

    // ---- restarting a session -----------------------------------------
    'session.restart.action': 'restart',
    'session.restart.failed': 'failed to restart session: {reason}',
    // TWO KEYS PER OUTCOME, NAMED AND UNNAMED, NEVER ONE WITH A GLUED-ON
    // FRAGMENT. The code this replaces built ` "title"` in the caller and
    // interpolated it, which is the exact shape the coverage guard's
    // bracket count exists to catch: a fragment assembled by `+` outside
    // a message cannot be translated, and where the name sits in the
    // sentence is one of the things a translation moves.
    'session.restart.unidentified': 'started a new session: this row carries no stored session id, so whether it had a conversation to continue CANNOT BE DETERMINED and none was resumed',
    'session.restart.unidentified.named': 'started a new session called "{title}": this row carries no stored session id, so whether it had a conversation to continue CANNOT BE DETERMINED and none was resumed',
    // The server answered, but said nothing about the conversation.
    'session.restart.unsaid': 'restarted, but the server did not say what happened to the conversation: CANNOT DETERMINE whether it was resumed',
    'session.restart.none_recorded': 'restarted, but this session never recorded a claude conversation, so a NEW conversation was started - nothing was resumed',
    'session.restart.none_recorded.named': 'restarted "{title}", but this session never recorded a claude conversation, so a NEW conversation was started - nothing was resumed',
    'session.restart.unknown': 'restarted, but whether the previous conversation was resumed CANNOT BE DETERMINED',
    'session.restart.unknown.named': 'restarted "{title}", but whether the previous conversation was resumed CANNOT BE DETERMINED',
    'session.restart.row_not_reused': 'restarted and resumed the conversation, but it could not keep its original record and may appear as a second entry',
    'session.restart.row_not_reused.named': 'restarted "{title}" and resumed the conversation, but it could not keep its original record and may appear as a second entry',

    // ---- forking a session --------------------------------------------
    // The parent is not changed by a fork: it keeps running, stays
    // listed and can be forked again.
    'session.fork.failed.no_name': 'cannot fork: this row carries no session name',
    'session.fork.failed.no_conversation': 'cannot fork: this session has no claude conversation yet, so there is nothing to branch from',
    'session.fork.failed': 'failed to fork session: {reason}',
    // NOT AN ERROR AND NOT A CLEAN SUCCESS. The fork exists and works,
    // the link back to its parent did not land. Said out loud.
    'session.fork.lineage_unrecorded': 'forked, but the link back to the parent was not recorded',

    // ---- the session listing's three-outcome block ---------------------
    // The SECOND LINE under a CANNOT DETERMINE row. The first line is a
    // machine reason token (`http_500`, `tmux_missing`), which is an
    // identifier compared against the server's own vocabulary and is
    // deliberately NOT translated - see client/js/labels/session-listing.js.
    // The server's own `listing_detail` outranks every one of these when it
    // sent one, because it knows which tmux command failed and this does not.
    'session.listing.detail.unauthorized': 'sign in again to see your sessions',
    'session.listing.detail.tmux_unreadable': 'the server could not read the tmux session list',
    'session.listing.detail.http_status': 'the server answered HTTP {status}',
    // A 200 whose body is not the array it promised is an UNPARSEABLE list,
    // never an empty one. Two keys rather than one because the two probes
    // answer different questions and a translator may want to name each.
    'session.listing.detail.malformed_sessions': 'the server did not return a session array',
    'session.listing.detail.malformed_records': 'the server did not return a session record array',

    // ---- the project list ----------------------------------------------
    // Replaces a `'failed to load projects: ' + error.message` concatenation.
    // The colon and the word order belong to the message now, which is
    // exactly what a translation needs to be able to move.
    'project.list.load_failed': 'failed to load projects: {reason}',
    // The empty state. TWO KEYS, not one string with a line break in it:
    // the hint is a separate element with its own styling, and gluing
    // them would make a translator move a `<br>`.
    'project.list.empty': 'no projects yet',
    'project.list.empty.hint': 'use + new to add one',

    // ---- the project tree ----------------------------------------------
    // The two-level project-to-session tree on the home screen. Keys name
    // the DOMAIN, so they survived launchpad.js being rewritten around
    // them in slice 4 and will survive slice 7 deleting it.

    // The synthetic group for sessions whose working directory WAS read
    // and sits inside no known project. A MEASURED answer, so it reads as
    // an ordinary group and never as a warning.
    'project.tree.no_project': 'no project',
    // The child count on a group header. A plural set rather than the
    // `n === 1 ? '' : 's'` ternary it replaces, which is a two-form
    // plural in disguise: right for English, wrong for anything with a
    // `few` or a `many`.
    'project.tree.session_count': {
        one: '{count} session',
        other: '{count} sessions',
    },
    // Uppercased by `.project-node__attention-head` in the stylesheet, so
    // the value is lowercase like every other message. The shout is the
    // stylesheet's, the words are the catalog's.
    'project.tree.attention.head': 'needs attention',
    'project.tree.attention.title': {
        one: '{count} session could not be attributed to a project',
        other: '{count} sessions could not be attributed to a project',
    },
    'project.node.toggle.aria': 'toggle details for {name}',

    // THE SEVEN REASONS A SESSION CANNOT BE PLACED, and they are seven
    // separate messages on purpose. Each one names a DIFFERENT thing that
    // did not happen, and collapsing any two of them would render an
    // unproven answer as a measured one - which is the false green this
    // whole screen exists to remove. See
    // web/src/lib/launchpad/project-groups.ts for the ladder order.
    //
    // The FIRST one is a fallback: the server sends its own detail when
    // the records fetch fails, and that outranks this, because it knows
    // which read failed and this does not.
    'project.attention.listing_unreadable': 'project attribution could not be read',
    'project.attention.ambiguous_name': 'two stored session records for this name could not be told apart',
    'project.attention.no_record': 'no stored attribution for this session',
    'project.attention.dir_unreadable': 'working directory could not be read',
    'project.attention.no_project_id': 'project attribution missing an id',
    'project.attention.ended_dir_unreadable': 'ended; working directory could not be read',
    'project.attention.ended_no_project_id': 'ended; project attribution missing an id',

    // ---- what the project list says about ITSELF ------------------------
    // THREE OUTCOMES for the archived dimension, and the third is why
    // these exist: "there are no archived projects" and "the request that
    // would have told you failed" render identically otherwise, because
    // both are an absence of archived rows on screen. There is no key for
    // the not-asked case; that one renders nothing at all.
    'project.archived.notice.count': 'showing archived: {count}',
    'project.archived.notice.unknown': 'archived projects CANNOT BE DETERMINED - they could not be loaded. this is NOT a claim that there are none; the list below may be stale or incomplete.',
    // The authority fetch itself did not answer. It claims nothing in
    // either direction, deliberately: not having looked is not a fault.
    // The DEGRADED banner has no key, because the server sends its own
    // sentence and that is data rather than copy.
    'project.authority.unknown': 'the source of these projects CANNOT BE DETERMINED - the authority check did not answer. this is not a claim that anything is wrong, and not a claim that it is fine.',

    // ---- a project row's two independent badges -------------------------
    // ORTHOGONAL DIMENSIONS. A project can be archived AND missing, and
    // the two say different things: "I retired this" against "the folder
    // is gone". Archiving never disables a row.
    'project.presence.missing': 'folder MISSING - not found on disk',
    'project.presence.unreachable': 'folder presence CANNOT BE DETERMINED - {detail}',
    'project.presence.unreachable.detail_unknown': 'reason unknown',
    // Uppercased by `.project-archived-badge` in the stylesheet.
    'project.badge.archived': 'archived',

    // ---- a project row's controls ---------------------------------------
    // Archive is the ONLY destructive-shaped control on the row. The
    // hard-delete button is gone from the UI on the owner's instruction:
    // "sessions and projects can be archived not deleted".
    'project.action.edit': 'edit project',
    'project.action.archive.title': 'archive project - keeps it and its sessions, hides it from this list',
    'project.action.archive.aria': 'archive project',
    'project.action.restore.title': 'restore project to the list',
    'project.action.restore.aria': 'restore project',
    'project.archived.show': 'show archived projects',
    'project.archived.hide': 'hide archived projects',

    // ---- work recency ----------------------------------------------------
    // TWO KEYS, NOT ONE, because a project and a session are ordered
    // against different populations and the sentence names which. Both
    // exist so an UNRECORDED row is visibly distinct instead of silently
    // last: "nothing has happened here yet" must never read as "this is
    // the stalest thing you own".
    'project.work.unrecorded': 'no work recorded in this project yet - ordered below every project that has been worked in',
    'session.work.unrecorded': 'no work recorded yet - ordered below every session that has been worked in',

    // ---- who owns a session ----------------------------------------------
    // Uppercased by `.badge` in the stylesheet.
    'session.badge.tmux': 'tmux',
    'session.badge.external': 'external',
    'session.badge.ended': 'ended',

    // ---- the agent-family pill --------------------------------------------
    // A THREE-OUTCOME rule about what is running in a pane, plus a rule
    // about how sure we are. A null family renders LITERALLY as unknown,
    // never as a family name and never silently as nothing.
    'session.agent.family.unknown': 'unknown family',
    'session.agent.family.title.fact': 'agent family: {family}',
    // A GUESS AND A FACT MUST NOT LOOK IDENTICAL, and the hover says so
    // in words as well as the pill saying it with a dashed border.
    'session.agent.family.title.guess': 'guessed from session output ({source})',
    // `inferred_process` is the STRONGEST guess and keeps its own
    // sentence, because "guessed from session output" would be false: it
    // was read off the process actually running in the pane.
    'session.agent.family.title.inferred_process': 'read from the process running in this pane, not from a launch',
    'session.agent.family.title.unknown': 'could not determine which agent this session is running',

    // ---- generic failure reasons --------------------------------------
    // The `{reason}` slot's value when an error carried no message.
    'error.server_unreachable': 'the server could not be reached',
};
