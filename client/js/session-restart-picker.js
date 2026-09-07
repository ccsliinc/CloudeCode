/**
 * RESTART, WITH A CHOICE OF WRAPPER - and an honest answer first.
 * ----------------------------------------------------------------------
 * "when resuming/restarting a session can we pick a new wrapper"
 *
 * Moving a session onto another launch wrapper (claude-chrome, say) used
 * to mean hand-editing `sessions.agent_type` in cloude.db. This panel is
 * what replaces that.
 *
 * IT IS A WARNING BEFORE IT IS A PICKER, and that order matters. The
 * respawn ladder gates on tmux's `#{pane_start_command}`: when that field
 * is EMPTY the restart lands on the `shell` rung and hands back a LOGIN
 * SHELL instead of an agent, silently. A picker that let someone
 * confidently choose claude-chrome and then dropped them at a zsh prompt
 * would be worse than no picker at all. So this panel opens by asking
 * `GET /sessions/restart/preview` - a read-only route that spawns
 * nothing - and paints the PREDICTED outcome next to every choice,
 * including the one where nothing is picked.
 *
 * THE THREE ANSWERS ARE THREE ANSWERS. "will start the agent", "will
 * return a plain shell" and "cannot be determined" are rendered
 * differently and the last never renders as the first. A choice whose
 * predicted rung is not actionable cannot be confirmed at all - the
 * button disables and says why.
 *
 * IT IS ALSO THE CONFIRMATION. A restart destroys what is in the pane,
 * so it must be confirmed - but a second modal after this one would ask
 * the user to agree twice to a decision this panel already spelled out
 * in full. The explicit "restart" button here IS the confirmation, and
 * the sentence above it is a better one than a generic dialog could
 * write. It reuses `.modal-overlay` / `.modal-content` so it is the same
 * object on screen as every other dialog in the app.
 *
 * ACTIVITY STATUS INFORMS, IT NEVER REFUSES. `activity_state` is known to
 * read `working` for about four minutes after a resume before it
 * self-corrects, so a hard block on it would refuse a restart the user
 * can plainly see is needed. When the row says the session is busy this
 * panel says so, in words, above the button - and then lets the user
 * decide.
 *
 * A LIVE SESSION GETS AN ANSWER AND STILL GETS NO BUTTON. The server
 * reports two things about every choice: what it would COME BACK AS
 * (`projected_kind`, which ignores liveness) and whether a restart may
 * act on it right now (`actionable_now`, which does not). The first is
 * what the badge and the sentence say, because "this one would come back
 * a plain shell" is useful about a session that is still running and is
 * the only useful thing there is to say about one. The second, and only
 * the second, enables the radio. A PREDICTION IS NEVER A PERMISSION.
 *
 * WHAT IT DOES NOT DO: replace a LIVE session's agent. Restart revives a
 * pane whose process has exited; it does not close and recreate a running
 * one. That is a different operation with its own unsolved problems (a
 * new row that has to re-carry attribution, theme, unread, group filing
 * and position) and is tracked separately.
 *
 * Load AFTER api.js and app.js; BEFORE session-sidebar-clicks.js.
 */

console.log('[SessionRestartPicker Module] Loading...');

(function () {
    'use strict';

    /**
     * Short badge for each predicted rung. The SENTENCE always comes from
     * the server (`detail`) so the wording lives in one place; this is
     * only the two- or three-word tag that lets the eye sort the list
     * without reading every line.
     * @type {Object<string, string>}
     */
    var KIND_BADGE = {
        agent: 'would start the agent',
        replay: 'would replay the recorded command',
        shell: 'would return a plain shell',
        not_dead: 'still running',
        transcript_missing: 'its conversation is gone',
        cannot_determine: 'cannot be determined',
    };

    /**
     * Rungs a user is allowed to commit to. Mirrors
     * ACTIONABLE_RESPAWN_KINDS in src/core/session_respawn.py. The server
     * is the authority (`actionable` / `actionable_now`); this exists so a
     * payload missing that field fails CLOSED rather than open.
     * @type {Array<string>}
     */
    var ACTIONABLE = ['agent', 'replay', 'shell'];

    /** The open panel element, or null. Only ever one. */
    var overlayEl = null;

    /**
     * Description: HTML-escape for text and attributes. Routed through
     *   SessionSidebarRows when present so this module owns no second
     *   escaper; the inline fallback keeps the panel safe if that module
     *   has not loaded.
     * Inputs: value (any).
     * Output: string, safe inside a double-quoted attribute or as text.
     */
    function esc(value) {
        if (window.SessionSidebarRows) return window.SessionSidebarRows.esc(value);
        var div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;');
    }

    /**
     * Description: can this predicted rung be acted on?
     * Inputs: kind (string) - a ladder verdict.
     * Output: boolean - false for not_dead, cannot_determine and anything
     *   unrecognised. An unknown verdict is treated as NOT actionable,
     *   because a client that guesses yes about a rung it has never heard
     *   of is exactly the failure this panel exists to prevent.
     */
    function isActionable(kind) {
        return ACTIONABLE.indexOf(kind) !== -1;
    }

    /**
     * Description: build one selectable row.
     * Inputs:
     *   id (string) - DOM id for the input.
     *   value (string) - the agent_type this row stands for, '' for the
     *     "leave it as it is" row.
     *   title (string) - the row's heading.
     *   spec (object) - {kind, projectedKind, detail, actionableNow,
     *     current, checked}. `kind` is what a restart does RIGHT NOW;
     *     `projectedKind` is what this choice would come back AS.
     * Output: string - HTML for one <label>.
     */
    function optionHtml(id, value, title, spec) {
        // TWO DIFFERENT FACTS, TWO DIFFERENT USES, and the server keeps
        // them apart so this can too:
        //   projectedKind  what this choice would COME BACK AS. It is the
        //                  badge and the sentence, because it is the
        //                  question the user is actually asking, and it
        //                  is the only one that says anything at all
        //                  about a session that is still running.
        //   actionableNow  whether a restart may act on it right now. It
        //                  is the ONLY thing that enables the radio. A
        //                  prediction is never a permission.
        var kind = spec.projectedKind || spec.kind || 'cannot_determine';
        // BOTH, and it is belt and braces on purpose. The server's
        // `actionable_now` is the authority; `isActionable` refuses a rung
        // this client has never heard of, so a future verdict added
        // server-side cannot be offered by an old client that has no idea
        // what it means.
        var canPick = spec.actionableNow === true && isActionable(spec.kind);
        var disabled = canPick ? '' : ' disabled';
        var checked = spec.checked ? ' checked' : '';
        var current = spec.current
            ? '<span class="restart-picker__current">current</span>'
            : '';
        return (
            '<label class="restart-picker__option' + (canPick ? '' : ' is-unavailable')
            + '" for="' + esc(id) + '">'
            + '<input type="radio" name="restart-picker-choice" id="' + esc(id) + '" '
            + 'value="' + esc(value) + '" data-kind="' + esc(kind) + '" '
            + 'data-now-kind="' + esc(spec.kind || '') + '"'
            + disabled + checked + '>'
            + '<span class="restart-picker__body">'
            + '<span class="restart-picker__title">' + esc(title) + current + '</span>'
            + '<span class="restart-picker__kind" data-kind="' + esc(kind) + '">'
            + esc(KIND_BADGE[kind] || 'cannot be determined') + '</span>'
            + '<span class="restart-picker__detail">' + esc(spec.detail || '')
            + '</span>'
            + '</span></label>'
        );
    }

    /**
     * Description: the whole option list, "leave it as it is" first.
     *
     *   THE BASELINE ROW LEADS ON PURPOSE. It is the row that exposes the
     *   shell landmine: on a pane with no recorded start command it reads
     *   "returns a plain shell", which is the fact the user most needs
     *   before deciding anything.
     * Inputs: preview (object) - the RestartPreviewResponse body.
     * Output: string - HTML.
     */
    function optionsHtml(preview) {
        var unchanged = preview.unchanged || {};
        var projected = preview.projected || {};
        var baselineTitle = preview.current_agent_type
            ? 'leave it on ' + preview.current_agent_type
            : 'leave it as it is';
        var out = [
            optionHtml('restart-choice-keep', '', baselineTitle, {
                kind: unchanged.kind || 'cannot_determine',
                projectedKind: projected.kind || unchanged.kind
                    || 'cannot_determine',
                detail: projected.detail || unchanged.detail
                    || 'what this would run could not be determined',
                actionableNow: unchanged.actionable === true,
                current: false,
                checked: true,
            }),
        ];
        (preview.options || []).forEach(function (o, i) {
            out.push(optionHtml(
                'restart-choice-' + i,
                o.agent_type,
                o.label || o.agent_type,
                {
                    kind: o.kind,
                    projectedKind: o.projected_kind || o.kind,
                    detail: o.projected_detail || o.detail,
                    actionableNow: o.actionable_now === true,
                    current: !!o.is_current,
                    checked: false,
                }
            ));
        });
        return out.join('');
    }

    /**
     * Description: the sentence shown when the wrapper list itself could
     *   not be read. NOT the same as "no wrappers configured", and it is
     *   spelled out rather than left to an empty list, because an empty
     *   list is what "you have not made any wrappers" also looks like.
     * Inputs: preview (object).
     * Output: string - HTML, or '' when there is nothing to say.
     */
    function noticeHtml(preview) {
        var out = '';
        if (preview.pane_state === 'alive') {
            // SAID BEFORE THE LIST, not discovered by clicking a dead
            // button. The options below still show what each one WOULD
            // come back as, which is the useful half, so this sentence
            // has to draw the line between the two out loud.
            out += '<div class="restart-picker__notice">this session is still '
                + 'running, so nothing here can be restarted yet. what each '
                + 'choice would come back as is shown anyway.</div>';
        } else if (preview.pane_state === 'unknown') {
            out += '<div class="restart-picker__notice">tmux did not answer '
                + 'about this pane, so whether it can be restarted could not '
                + 'be determined. that is not the same as it being fine.</div>';
        }
        return out + wrapperNoticeHtml(preview);
    }

    /**
     * Description: the wrapper-list half of the notices, split out so the
     *   pane-state half above reads as one thought.
     * Inputs: preview (object).
     * Output: string - HTML, or '' when there is nothing to say.
     */
    function wrapperNoticeHtml(preview) {
        if (preview.wrappers_status === 'unavailable') {
            return '<div class="restart-picker__notice">the launch wrapper list '
                + 'could not be read, so no other wrapper can be offered here. '
                + 'this is not the same as having none configured.</div>';
        }
        if (!(preview.options || []).length) {
            return '<div class="restart-picker__notice">no launch wrappers are '
                + 'configured, so there is nothing else to switch to.</div>';
        }
        return '';
    }

    /**
     * Description: the busy line. Informational, never a block - see the
     *   module docblock on why `activity_state` may not be trusted to
     *   refuse.
     * Inputs: status (string|null) - the row's activity status.
     * Output: string - HTML, or '' when there is nothing to warn about.
     */
    function busyHtml(status) {
        var key = window.SessionStatusUI
            ? window.SessionStatusUI.normalizeStatus(status)
            : 'unknown';
        if (key === 'working' || key === 'question') {
            return '<div class="restart-picker__notice">this row currently reads '
                + '"' + esc(key) + '". that signal can lag a few minutes behind '
                + 'what the session is really doing, so it is shown rather than '
                + 'acted on.</div>';
        }
        return '';
    }

    /**
     * Description: tear the panel down and settle the promise.
     * Inputs: resolve (function). value (object|null) - the result.
     * Output: void.
     */
    function dismiss(resolve, value) {
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        resolve(value);
    }

    /**
     * Description: paint the panel and wait for the user to decide.
     * Inputs:
     *   displayName (string) - the session name as the user sees it.
     *   preview (object) - the RestartPreviewResponse body.
     *   status (string|null) - the row's activity status.
     * Output: Promise<{agentType: string|null}|null> - null on every
     *   dismissal path (cancel, Escape, backdrop), so a restart can only
     *   ever fire from an explicit click on the restart button.
     */
    function present(displayName, preview, status) {
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay restart-picker';
            overlay.innerHTML =
                '<div class="modal-content restart-picker__content" role="dialog" '
                + 'aria-modal="true" aria-label="restart ' + esc(displayName) + '">'
                + '<div class="modal-header">&raquo; restart</div>'
                + '<div class="modal-body">'
                + '<div class="modal-message">restart "' + esc(displayName) + '"</div>'
                + '<div class="modal-description">this stops what is in the pane '
                + 'and starts the choice below in it. the transcript is not '
                + 'deleted.</div>'
                + noticeHtml(preview)
                + busyHtml(status)
                + '<div class="restart-picker__options" role="radiogroup" '
                + 'aria-label="what to restart with">'
                + optionsHtml(preview)
                + '</div>'
                + '<div class="restart-picker__why" id="restart-picker-why"></div>'
                + '</div>'
                + '<div class="modal-footer">'
                + '<button type="button" class="modal-btn modal-btn-secondary" '
                + 'id="restart-picker-cancel">cancel</button>'
                + '<button type="button" class="modal-btn modal-btn-primary" '
                + 'id="restart-picker-go">restart</button>'
                + '</div></div>';

            document.body.appendChild(overlay);
            overlayEl = overlay;

            var go = overlay.querySelector('#restart-picker-go');
            var why = overlay.querySelector('#restart-picker-why');

            /**
             * Description: keep the button and its explanation in step
             *   with the selected radio. The button is DISABLED whenever
             *   the predicted rung is not actionable, so a user cannot
             *   commit to an outcome the server has already said it will
             *   refuse.
             * Inputs: none. Output: void.
             */
            function sync() {
                var picked = overlay.querySelector(
                    'input[name="restart-picker-choice"]:checked');
                // THE BUTTON FOLLOWS THE RADIO'S OWN DISABLED STATE, which
                // the server's `actionable_now` set. It deliberately does
                // NOT follow `data-kind`, because that carries the
                // PROJECTED rung - a live session's options project
                // 'agent' and must still not be restartable. Reading the
                // prediction here would hand out exactly the permission
                // the server withheld.
                var ok = !!picked && !picked.disabled;
                go.disabled = !ok;
                var nowKind = picked
                    ? picked.getAttribute('data-now-kind')
                    : '';
                var projected = picked ? picked.getAttribute('data-kind') : '';
                if (ok) {
                    why.textContent = projected === 'shell'
                        ? 'this will not start an agent. it opens a plain shell.'
                        : '';
                    return;
                }
                if (nowKind === 'not_dead') {
                    why.textContent = 'this session is still running, so there '
                        + 'is nothing to restart. close it first, or leave it '
                        + 'alone.';
                    return;
                }
                if (nowKind === 'transcript_missing'
                    || projected === 'transcript_missing') {
                    // NOT a could-not-determine. The transcript this would
                    // resume was looked for and is not there, so restarting
                    // would open a pane that exits at once - the exact
                    // false green this app keeps paying for.
                    why.textContent = 'the conversation this would resume is '
                        + 'not on this machine, so restarting it would open a '
                        + 'pane that exits straight away. pick a wrapper '
                        + 'instead to start a fresh one.';
                    return;
                }
                why.textContent = 'what this would run cannot be determined, so '
                    + 'it will not be started.';
            }

            overlay.addEventListener('change', sync);
            sync();

            overlay.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    dismiss(resolve, null);
                }
            });
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) dismiss(resolve, null);
            });
            overlay.querySelector('#restart-picker-cancel')
                .addEventListener('click', function () {
                    dismiss(resolve, null);
                });
            go.addEventListener('click', function () {
                if (go.disabled) return;
                var picked = overlay.querySelector(
                    'input[name="restart-picker-choice"]:checked');
                var value = picked ? picked.value : '';
                dismiss(resolve, { agentType: value || null });
            });

            var first = overlay.querySelector(
                'input[name="restart-picker-choice"]:checked');
            if (first && typeof first.focus === 'function') first.focus();
        });
    }

    /**
     * Description: THE entry point. Fetches the read-only preview, shows
     *   the panel, and reports what the user chose.
     *
     *   A PREVIEW THAT FAILS DOES NOT SILENTLY BECOME A RESTART. When the
     *   route cannot be reached there is no honest prediction to show, so
     *   this returns null and the caller reports that it could not find
     *   out what a restart would do. Proceeding blind is precisely the
     *   behaviour that made the shell rung dangerous.
     * Inputs:
     *   tmuxName (string) - literal tmux session name.
     *   displayName (string) - what the row calls it.
     *   status (string|null) - the row's activity status, shown not acted on.
     * Output: Promise<{agentType: string|null}|null> - null when the user
     *   cancelled OR the preview could not be fetched. `error` is set on
     *   the returned object shape only in the latter case, via
     *   `lastError()`.
     */
    var lastErrorText = '';

    function open(tmuxName, displayName, status) {
        lastErrorText = '';
        return window.API.restartPreview(tmuxName).then(function (preview) {
            return present(displayName || tmuxName, preview, status);
        }).catch(function (err) {
            lastErrorText = (err && err.message) || String(err);
            console.error('SessionRestartPicker: preview failed:', err);
            return null;
        });
    }

    /**
     * Description: why the last `open()` returned null without asking the
     *   user anything, or '' when it returned null because they
     *   cancelled. Lets the caller tell a cancel apart from a failure
     *   without a second return channel.
     * Inputs: none. Output: string.
     */
    function lastError() {
        return lastErrorText;
    }

    window.SessionRestartPicker = {
        KIND_BADGE: KIND_BADGE,
        isActionable: isActionable,
        optionsHtml: optionsHtml,
        noticeHtml: noticeHtml,
        wrapperNoticeHtml: wrapperNoticeHtml,
        busyHtml: busyHtml,
        present: present,
        open: open,
        lastError: lastError,
    };
})();

console.log('[SessionRestartPicker Module] Exported as window.SessionRestartPicker');
