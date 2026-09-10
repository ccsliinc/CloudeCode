/**
 * The away-gap decision, and every sentence the away bar prints.
 * ----------------------------------------------------------------------
 * Owns one question: this browser has just come back after being away -
 * should the user be OFFERED a choice about what to repaint, and what
 * does the offer say?
 *
 * WHY THIS EXISTS. Today the app decides alone.
 * `terminal-reconnect-buffer.js` keeps the browser buffer when the same
 * session already has content on screen and otherwise wipes it and
 * paints one `tmux capture-pane`. Both are reasonable and neither is
 * ever offered. The owner's ask, recorded in `.claude/TODO.md` item 1
 * and quoted verbatim there, is the OPTION rather than a better silent
 * default: full history, a summary of what happened, or just carry on.
 *
 * THE BAR ALWAYS SHOWS, EVEN WHEN A CHOICE IS REMEMBERED. The remembered
 * value pre-selects; it never auto-runs and never suppresses the bar. A
 * remembered choice that acted on its own would be exactly the silent
 * default this feature exists to remove, wearing the user's own
 * preference as a disguise.
 *
 * NOTHING HERE TOUCHES THE RECONNECT BUFFER'S KEEP RULE. This layer sits
 * on top: `terminal-reconnect-buffer.js` still decides what a reconnect
 * does on its own, and the bar only offers to do something MORE
 * afterwards, when the user asks for it.
 *
 * PURE. No DOM, no fetch, no timers, no globals beyond the one export.
 * `terminal-away-bar.js` is the half that touches the page.
 *
 * Loaded as a plain script (no build step). Exposes
 * `window.TerminalAwayGap`.
 */
(function () {
    'use strict';

    /**
     * How long the browser must have been away before the bar is
     * offered at all.
     *
     * 60 seconds. A blip - a wifi hiccup, a tab switch, a server
     * restart the user watched happen - is not an absence, and a bar
     * that appears after one would be noise the user learns to dismiss
     * without reading, which is worse than no bar. Long enough to mean
     * "you went away", short enough that a phone locked at a red light
     * still gets asked.
     * @type {number}
     */
    var AWAY_THRESHOLD_MS = 60000;

    /**
     * How often the bar module stamps "the page was alive at this
     * moment" while it is visible.
     *
     * This is what makes a SLEEP detectable at all: a suspended browser
     * stops firing timers, so the gap between the last stamp and the
     * next tick IS the absence, measured rather than inferred from a
     * visibility event that a locked phone may never send.
     * @type {number}
     */
    var HEARTBEAT_MS = 5000;

    /**
     * The three answers the bar accepts. Named rather than bare strings
     * so a typo at a call site is a load-time `undefined` instead of a
     * comparison that silently never matches.
     */
    var CHOICE = {
        FULL: 'full',
        SUMMARY: 'summary',
        CONTINUE: 'continue'
    };

    /** Every valid choice, for validating what came out of storage. */
    var CHOICES = [CHOICE.FULL, CHOICE.SUMMARY, CHOICE.CONTINUE];

    /**
     * localStorage key holding the last choice, per device.
     *
     * Per DEVICE and not per session on purpose: the preference is about
     * how this person likes to come back on this phone, and a key per
     * session would never accumulate enough uses to be worth reading.
     * @type {string}
     */
    var STORAGE_KEY = 'cloude.away.lastChoice';

    /** Verdicts from `decideAwayPrompt`. */
    var VERDICT = {
        OFFER: 'offer',
        SKIP_SHORT_BLIP: 'skip_short_blip',
        SKIP_NO_SESSION: 'skip_no_session'
    };

    /**
     * Render a duration in plain words.
     *
     * Deliberately coarse. The bar is answering "how long was I gone",
     * not timing anything, and "away 3 min" reads while "away 3 min 12
     * sec" has to be parsed.
     *
     * @param {number} ms - a duration in milliseconds.
     * @returns {string} e.g. 'less than a minute', '3 min', '2 hr 5 min'.
     *   Returns 'an unknown time' for a negative, missing or non-finite
     *   input, which is a refusal rather than a confident zero.
     * @example
     *   formatAway(90000) // '1 min'
     */
    function formatAway(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
            return 'an unknown time';
        }
        var totalMinutes = Math.floor(ms / 60000);
        if (totalMinutes < 1) return 'less than a minute';
        if (totalMinutes < 60) return totalMinutes + ' min';
        var hours = Math.floor(totalMinutes / 60);
        var minutes = totalMinutes % 60;
        return minutes ? hours + ' hr ' + minutes + ' min' : hours + ' hr';
    }

    /**
     * Should the bar be offered for this return?
     *
     * @param {object} [input]
     * @param {number} [input.awayMs] - measured absence.
     * @param {boolean} [input.hasSession] - true when a session is
     *   actually attached. With nothing on screen there is nothing to
     *   repaint and nothing to summarise.
     * @param {number} [input.thresholdMs] - override for tests.
     * @returns {string} one of `VERDICT`.
     * @example
     *   decideAwayPrompt({awayMs: 120000, hasSession: true}) // 'offer'
     */
    function decideAwayPrompt(input) {
        var o = input || {};
        if (o.hasSession !== true) return VERDICT.SKIP_NO_SESSION;
        var threshold = typeof o.thresholdMs === 'number' && o.thresholdMs >= 0
            ? o.thresholdMs
            : AWAY_THRESHOLD_MS;
        var away = typeof o.awayMs === 'number' && isFinite(o.awayMs) ? o.awayMs : 0;
        if (away < threshold) return VERDICT.SKIP_SHORT_BLIP;
        return VERDICT.OFFER;
    }

    /**
     * Read the remembered choice, tolerating a storage that throws.
     *
     * Private-mode Safari throws on access rather than returning null,
     * and an unknown value may be left over from an older build, so both
     * are treated the same way: no memory.
     *
     * @param {object|null} storage - a localStorage-like object.
     * @returns {string|null} a member of `CHOICES`, or null.
     * @example
     *   readRememberedChoice(window.localStorage) // 'summary' or null
     */
    function readRememberedChoice(storage) {
        try {
            if (!storage || typeof storage.getItem !== 'function') return null;
            var raw = storage.getItem(STORAGE_KEY);
            return CHOICES.indexOf(raw) === -1 ? null : raw;
        } catch (err) {
            // Deliberately swallowed: an unreadable store means no
            // preference, which is a fully working state for this bar.
            console.warn('TerminalAwayGap: choice read failed', err);
            return null;
        }
    }

    /**
     * Remember a choice for next time. Never throws.
     *
     * @param {object|null} storage - a localStorage-like object.
     * @param {string} choice - must be a member of `CHOICES`.
     * @returns {boolean} true when it was stored.
     * @example
     *   writeRememberedChoice(window.localStorage, 'full') // true
     */
    function writeRememberedChoice(storage, choice) {
        if (CHOICES.indexOf(choice) === -1) return false;
        try {
            if (!storage || typeof storage.setItem !== 'function') return false;
            storage.setItem(STORAGE_KEY, choice);
            return true;
        } catch (err) {
            // Deliberately swallowed: a full or blocked store costs the
            // preference, not the feature.
            console.warn('TerminalAwayGap: choice write failed', err);
            return false;
        }
    }

    /**
     * The whole bar decision, ready to render.
     *
     * @param {object} [input]
     * @param {number} [input.awayMs] - measured absence.
     * @param {boolean} [input.hasSession] - see `decideAwayPrompt`.
     * @param {string|null} [input.remembered] - from `readRememberedChoice`.
     * @param {number} [input.thresholdMs] - override for tests.
     * @returns {object|null} null when no bar is offered, otherwise
     *   `{awayLabel, awayMs, remembered, choices}`. `remembered` is a
     *   PRE-SELECTION and nothing else: `choices` is always the full set
     *   and the bar is always shown.
     * @example
     *   barPlan({awayMs: 300000, hasSession: true, remembered: 'summary'})
     *   // {awayLabel: 'away 5 min', ...}
     */
    function barPlan(input) {
        var o = input || {};
        if (decideAwayPrompt(o) !== VERDICT.OFFER) return null;
        return {
            awayMs: o.awayMs,
            awayLabel: 'away ' + formatAway(o.awayMs),
            remembered: CHOICES.indexOf(o.remembered) === -1 ? null : o.remembered,
            choices: CHOICES.slice()
        };
    }

    /**
     * Parse a timestamp the server sent.
     *
     * Every timestamp this app stores is naive UTC and serialises with
     * no zone, which `Date.parse` reads as LOCAL time - an hours-wide
     * error that would render as "last activity 5 hr ago" on a session
     * that just spoke. So a string carrying no zone gets a `Z`, and one
     * that already carries a zone is left exactly as it is.
     *
     * @param {string} text - an ISO-8601 timestamp.
     * @returns {number} epoch milliseconds, or NaN when unparseable.
     * @example
     *   parseServerTime('2026-09-08T10:00:00') // treated as UTC
     */
    function parseServerTime(text) {
        if (typeof text !== 'string' || !text) return NaN;
        var zoned = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text);
        return Date.parse(zoned ? text : text + 'Z');
    }

    /**
     * Turn the server's away report into the lines the summary prints.
     *
     * THE TURN COUNT IS A FLOOR. The server counts toast RECORDS, and
     * `SessionManager.record_toast` coalesces an unacked `Stop` in place,
     * so twelve finished turns can be one record. Every coalesced kind
     * is therefore printed as "at least N". See
     * `src/core/session_away_report.py`.
     *
     * A NULL IS NOT A FALSE. `permission_open` and `notice_open` are
     * three-valued; an unread signal prints as unknown rather than as
     * "nothing is waiting on you", which is the claim that would send
     * someone away from a blocked agent.
     *
     * @param {object|null} report - the `/sessions/away/summary` body.
     * @param {number} nowMs - the client's clock, for the age of the last
     *   activity.
     * @returns {string[]} lowercase sentences, in reading order. Never
     *   empty: a quiet window still prints what it knows.
     * @example
     *   summaryLines({counts: {stop: 2}}, Date.now())
     *   // ['at least 2 turns finished', 'last activity not recorded']
     */
    function summaryLines(report, nowMs) {
        var r = report || {};
        var counts = r.counts || {};
        var lines = [];

        var stop = typeof counts.stop === 'number' ? counts.stop : 0;
        if (stop > 0) {
            lines.push('at least ' + stop + (stop === 1 ? ' turn' : ' turns') + ' finished');
        }
        var notes = typeof counts.notification === 'number' ? counts.notification : 0;
        if (notes > 0) {
            lines.push(notes + (notes === 1 ? ' notification' : ' notifications'));
        }
        var asks = typeof counts.permission_request === 'number'
            ? counts.permission_request
            : 0;
        if (asks > 0) {
            lines.push(asks + (asks === 1 ? ' permission request' : ' permission requests'));
        }
        if (!lines.length) lines.push('nothing recorded while you were away');

        if (r.permission_open === true) {
            lines.push('a permission request is still open');
        } else if (r.permission_open !== false) {
            lines.push('whether a permission request is open is unknown');
        }
        if (r.notice_open === true) lines.push('claude asked to be looked at');

        if (r.last_activity_at) {
            var ts = parseServerTime(r.last_activity_at);
            if (isFinite(ts) && typeof nowMs === 'number') {
                lines.push('last activity ' + formatAway(nowMs - ts) + ' ago');
            } else {
                lines.push('last activity not recorded');
            }
        } else {
            lines.push('last activity not recorded');
        }

        if (r.coverage === 'partial_server_restarted') {
            lines.push('the server restarted while you were away, so this covers only part of it');
        } else if (r.coverage !== 'complete') {
            lines.push('how much of this window was recorded is unknown');
        }
        return lines;
    }

    /**
     * What "show full history" would actually give you, in one sentence.
     *
     * Worth saying out loud: tmux keeps NO scrollback for a pane on the
     * alternate screen, and every Claude Code session lives there. A
     * replay of one is the current frame, painted over the conversation
     * the browser is already holding. Offering "full history" without
     * that sentence would be offering something the app cannot deliver.
     *
     * @param {object|null} report - the `/sessions/away/summary` body.
     * @returns {string} a lowercase sentence, never empty.
     * @example
     *   historyCaveat({history: {mode: 'screen_only', bound_lines: 3000}})
     *   // 'this pane is a full-screen app, so tmux kept no scrollback ...'
     */
    function historyCaveat(report) {
        var h = (report || {}).history || {};
        var bound = typeof h.bound_lines === 'number' ? h.bound_lines : null;
        if (h.mode === 'screen_only') {
            return 'this pane is a full-screen app, so tmux kept no scrollback for it:'
                + ' full history repaints the current screen and replaces the history'
                + ' your browser is holding';
        }
        if (h.mode === 'scrollback') {
            return 'full history repaints the last '
                + (bound === null ? 'few thousand' : bound) + ' lines tmux kept';
        }
        return 'the pane could not be read, so what full history would repaint is unknown';
    }

    window.TerminalAwayGap = {
        AWAY_THRESHOLD_MS: AWAY_THRESHOLD_MS,
        HEARTBEAT_MS: HEARTBEAT_MS,
        STORAGE_KEY: STORAGE_KEY,
        CHOICE: CHOICE,
        CHOICES: CHOICES,
        VERDICT: VERDICT,
        formatAway: formatAway,
        parseServerTime: parseServerTime,
        decideAwayPrompt: decideAwayPrompt,
        readRememberedChoice: readRememberedChoice,
        writeRememberedChoice: writeRememberedChoice,
        barPlan: barPlan,
        summaryLines: summaryLines,
        historyCaveat: historyCaveat
    };
})();
