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
};
