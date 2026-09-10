/**
 * The bar that asks what to do after you come back.
 * ----------------------------------------------------------------------
 * The half of punchlist item 1 that touches the page.
 * `terminal-away-gap.js` owns every rule and every sentence; this owns
 * the measurement of the absence, the element, and the three actions.
 *
 * HOW AN ABSENCE IS MEASURED, AND WHY NOT BY A VISIBILITY EVENT ALONE. A
 * phone that sleeps does not reliably fire anything: the tab may already
 * be hidden, the OS suspends the process, and what comes back is a
 * browser whose timers simply stopped. So the measurement is a
 * HEARTBEAT: while the page is visible we stamp the wall clock every
 * `HEARTBEAT_MS`, and the gap between the last stamp and the next tick
 * IS the absence, measured rather than inferred. `visibilitychange` is
 * wired too, because a tab switch does fire it and gives the same answer
 * a beat sooner.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. A websocket that drops and
 * reattaches while the user is sitting there watching raises no bar.
 * That is not an absence: the user saw it happen, and
 * `terminal-reconnect-buffer.js` already keeps their screen across it.
 * The bar is about coming BACK.
 *
 * IT IS AN OVERLAY, NOT A ROW. `.terminal-container` is a flex column
 * and an in-flow child of it takes rows away from `#terminal`. The
 * ResizeObserver reads that as a real geometry change, ships a
 * pty_resize, tmux raises SIGWINCH and claude answers with `ESC[2J`,
 * which on the alternate screen erases the entire visible conversation.
 * A bar that wiped the screen it is asking you about would be a very
 * good joke and a very bad feature. `#localServersContainer` paid for
 * this lesson already - see `.local-servers` in `styles.css`.
 *
 * THE REPORT IS FETCHED ONCE, WHEN THE BAR APPEARS. It is a small
 * read-only GET, and it is what lets the offer print the caveat about
 * what "full history" would actually do BEFORE the user presses it.
 * Fetching it lazily would mean the one user who never presses summary
 * is the one user who is never told.
 *
 * Loaded as a plain script (no build step). Self-installing. Exposes
 * `window.TerminalAwayBar` for the tests and for a manual re-arm.
 */
(function () {
    'use strict';

    /** The element id, so a second install can never stack two bars. */
    var BAR_ID = 'awayBar';

    var state = {
        lastAliveAt: Date.now(),
        timer: null,
        bar: null,
        report: null,
        windowStart: null
    };

    /** @returns {object} the rules module, or a throwing stand-in. */
    function gap() {
        return window.TerminalAwayGap;
    }

    /**
     * The session this tab is attached to, if any.
     *
     * @returns {string|null} a session id, or null when nothing is
     *   attached or the terminal screen is not the one on show. A bar
     *   over the launchpad would be asking about a terminal the user is
     *   not looking at.
     * @example
     *   attachedSessionId() // 'ses_fb8dd410'
     */
    function attachedSessionId() {
        try {
            var app = window.App;
            if (app && app.currentScreen && app.currentScreen !== 'terminal') return null;
            var ctl = window.TerminalController;
            if (!ctl || typeof ctl._sessionId !== 'function') return null;
            return ctl._sessionId();
        } catch (err) {
            // Deliberately swallowed: not being able to name the session
            // means no bar, which is the pre-existing behaviour.
            console.warn('TerminalAwayBar: session read failed', err);
            return null;
        }
    }

    /**
     * Ask the server what happened during the window.
     *
     * @param {string} sessionId - the attached session.
     * @param {number} sinceMs - epoch ms of the last moment we were here.
     * @returns {Promise<object|null>} the report body, or null on any
     *   failure. Null is rendered as "unknown", never as "nothing".
     * @example
     *   await fetchReport('ses_1', Date.now() - 600000)
     */
    async function fetchReport(sessionId, sinceMs) {
        try {
            if (!window.API || typeof window.API.call !== 'function') return null;
            var qs = '?session_id=' + encodeURIComponent(sessionId)
                + '&since=' + encodeURIComponent(new Date(sinceMs).toISOString());
            return await window.API.call('/sessions/away/summary' + qs);
        } catch (err) {
            // Deliberately swallowed: the bar still offers all three
            // choices without a report, it just says less.
            console.warn('TerminalAwayBar: report fetch failed', err);
            return null;
        }
    }

    /**
     * Paint tmux's capture into the live terminal.
     *
     * DESTRUCTIVE BY REQUEST. `\x1b[?1049l` leaves the alternate screen,
     * so for a full-screen agent this replaces the conversation the
     * browser was holding with the captured frame. That is precisely
     * what the user asked for, having been shown the caveat, and it is
     * why nothing on this path runs without a press. `term.reset()` is
     * NOT called: reset would also throw away xterm's own normal-buffer
     * scrollback, which is history the capture cannot replace.
     *
     * @param {string} sessionId - the attached session.
     * @returns {Promise<boolean>} true when bytes were painted.
     * @example
     *   await paintFullHistory('ses_1')
     */
    async function paintFullHistory(sessionId) {
        var ctl = window.TerminalController;
        var term = ctl && ctl.term;
        if (!term || typeof term.write !== 'function') return false;
        try {
            var info = await window.API.getSession(sessionId, {
                includeScrollback: true,
                cols: term.cols,
                rows: term.rows
            });
            var b64 = info && info.initial_scrollback_b64;
            if (!b64) return false;
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
            term.write('\x1b[?1049l\x1b[2J\x1b[H');
            term.write(bytes, function () {
                if (typeof ctl._forceScrollToBottom === 'function') {
                    ctl._forceScrollToBottom();
                }
            });
            return true;
        } catch (err) {
            // Deliberately swallowed: a failed replay leaves the live
            // stream exactly as it was. The user is told in the bar.
            console.warn('TerminalAwayBar: full history replay failed', err);
            return false;
        }
    }

    /** Remove the bar and forget the window it was about. */
    function dismiss() {
        if (state.bar && state.bar.parentNode) state.bar.parentNode.removeChild(state.bar);
        state.bar = null;
        state.report = null;
        state.windowStart = null;
    }

    /**
     * Write a list of sentences into the bar's body.
     *
     * @param {string[]} lines - already-built sentences.
     * @returns {void}
     * @example
     *   renderBody(['at least 2 turns finished'])
     */
    function renderBody(lines) {
        if (!state.bar) return;
        var body = state.bar.querySelector('.away-bar-body');
        if (!body) return;
        body.textContent = '';
        var ul = document.createElement('ul');
        (lines || []).forEach(function (line) {
            var li = document.createElement('li');
            li.textContent = line;
            ul.appendChild(li);
        });
        body.appendChild(ul);
        body.hidden = false;
    }

    /**
     * Run one of the three answers.
     *
     * @param {string} choice - a member of `TerminalAwayGap.CHOICES`.
     * @param {string} sessionId - the attached session.
     * @returns {Promise<void>}
     * @example
     *   await act('summary', 'ses_1')
     */
    async function act(choice, sessionId) {
        var G = gap();
        G.writeRememberedChoice(window.localStorage, choice);
        if (choice === G.CHOICE.CONTINUE) {
            dismiss();
            return;
        }
        if (choice === G.CHOICE.SUMMARY) {
            renderBody(G.summaryLines(state.report, Date.now()));
            return;
        }
        var painted = await paintFullHistory(sessionId);
        if (painted) {
            dismiss();
            return;
        }
        renderBody(['full history could not be replayed, nothing on screen was changed']);
    }

    /**
     * Build and attach the bar for one measured absence.
     *
     * @param {object} plan - from `TerminalAwayGap.barPlan`.
     * @param {string} sessionId - the attached session.
     * @returns {void}
     * @example
     *   render({awayLabel: 'away 5 min', choices: ['full','summary','continue']}, 'ses_1')
     */
    function render(plan, sessionId) {
        var host = document.querySelector('.terminal-container');
        if (!host || document.getElementById(BAR_ID)) return;
        var G = gap();

        var bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.className = 'away-bar';
        bar.setAttribute('role', 'status');

        var head = document.createElement('div');
        head.className = 'away-bar-head';
        var label = document.createElement('span');
        label.className = 'away-bar-label';
        label.textContent = plan.awayLabel;
        head.appendChild(label);
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'away-bar-close';
        close.setAttribute('aria-label', 'dismiss');
        close.textContent = 'close';
        close.addEventListener('click', dismiss);
        head.appendChild(close);
        bar.appendChild(head);

        var actions = document.createElement('div');
        actions.className = 'away-bar-actions';
        var copy = {};
        copy[G.CHOICE.FULL] = 'show full history';
        copy[G.CHOICE.SUMMARY] = 'show summary';
        copy[G.CHOICE.CONTINUE] = 'just continue';
        plan.choices.forEach(function (choice) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'away-bar-choice';
            btn.setAttribute('data-choice', choice);
            btn.textContent = copy[choice] || choice;
            if (plan.remembered === choice) {
                btn.classList.add('is-remembered');
                btn.setAttribute('aria-pressed', 'true');
            }
            btn.addEventListener('click', function () { act(choice, sessionId); });
            actions.appendChild(btn);
        });
        bar.appendChild(actions);

        var caveat = document.createElement('p');
        caveat.className = 'away-bar-caveat';
        caveat.textContent = G.historyCaveat(state.report);
        bar.appendChild(caveat);

        var body = document.createElement('div');
        body.className = 'away-bar-body';
        body.hidden = true;
        bar.appendChild(body);

        host.appendChild(bar);
        state.bar = bar;
    }

    /**
     * A gap was measured. Decide, fetch, and show.
     *
     * @param {number} awayMs - the measured absence.
     * @param {number} sinceMs - epoch ms the absence started at.
     * @returns {Promise<string>} the verdict, for the tests and the log.
     * @example
     *   await offer(300000, Date.now() - 300000) // 'offer'
     */
    async function offer(awayMs, sinceMs) {
        var G = gap();
        if (!G) return 'skip_no_rules';
        if (state.bar) return 'skip_already_open';
        var sessionId = attachedSessionId();
        var plan = G.barPlan({
            awayMs: awayMs,
            hasSession: !!sessionId,
            remembered: G.readRememberedChoice(window.localStorage)
        });
        if (!plan) {
            return G.decideAwayPrompt({ awayMs: awayMs, hasSession: !!sessionId });
        }
        state.windowStart = sinceMs;
        state.report = await fetchReport(sessionId, sinceMs);
        render(plan, sessionId);
        console.log('[AWAY-BAR] offered awayMs=' + Math.round(awayMs)
            + ' session=' + sessionId
            + ' coverage=' + ((state.report && state.report.coverage) || 'unknown'));
        return 'offer';
    }

    /**
     * One heartbeat: measure the gap since the last stamp, then re-stamp.
     *
     * A HIDDEN PAGE IS NEVER STAMPED, and that is the whole reason this
     * returns early instead of stamping and returning. Browsers throttle
     * a background tab's timers rather than stopping them, so a tick
     * that re-stamped while hidden would keep resetting the very window
     * it is supposed to be measuring, and a phone away for an hour would
     * come back reporting one minute. The last stamp before hiding is
     * the correct start of the absence and must be left alone.
     *
     * The tolerance is one whole beat: a timer that fires a little late
     * on a busy phone is not an absence, and the threshold is twelve
     * beats wide anyway.
     *
     * @returns {void}
     * @example
     *   tick()
     */
    function tick() {
        if (document.visibilityState === 'hidden') return;
        var G = gap();
        var now = Date.now();
        var beat = (G && G.HEARTBEAT_MS) || 5000;
        var elapsed = now - state.lastAliveAt;
        state.lastAliveAt = now;
        if (elapsed > beat * 2) offer(elapsed, now - elapsed);
    }

    /**
     * Visibility changed.
     *
     * Going HIDDEN stamps: that moment is the last one we were here, and
     * it is the start of the absence. Coming back measures against it.
     */
    function onVisible() {
        if (document.visibilityState === 'hidden') {
            state.lastAliveAt = Date.now();
            return;
        }
        var now = Date.now();
        var elapsed = now - state.lastAliveAt;
        state.lastAliveAt = now;
        offer(elapsed, now - elapsed);
    }

    /**
     * Start the heartbeat and wire the visibility listener. Idempotent.
     *
     * @returns {void}
     * @example
     *   window.TerminalAwayBar.install()
     */
    function install() {
        if (state.timer) return;
        var G = gap();
        state.lastAliveAt = Date.now();
        state.timer = setInterval(tick, (G && G.HEARTBEAT_MS) || 5000);
        document.addEventListener('visibilitychange', onVisible);
    }

    window.TerminalAwayBar = {
        BAR_ID: BAR_ID,
        install: install,
        offer: offer,
        dismiss: dismiss,
        _state: state
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install);
    } else {
        install();
    }
})();
