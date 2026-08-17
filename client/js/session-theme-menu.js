/**
 * Per-session theme picker + per-session background music.
 * ----------------------------------------------------------------------
 * The point of theming a tmux session INDIVIDUALLY is to tell your
 * sessions apart at a glance: the office box is green, the media box is
 * amber, and you know which one you are typing into before you read a
 * word. This module owns the picker and the music opt-in; the control
 * that opens it is the SESSION EDITOR FAB (#sessionEditorBtn,
 * session-editor-menu.js), which is deliberately separate from the
 * terminal tools FAB beside it - configuring a session and copying its
 * output are different jobs. The default theme and the home theme stay
 * where they are, in settings - this picker only ever changes the
 * session you are currently looking at.
 *
 * PERSISTENCE. Nothing is stored client-side. Picking a theme calls
 * `Themes.applyGlobal()`, which - because app.js has put the registry in
 * session scope via `setActiveSession(session.tmux_session)` - PATCHes
 * `/api/v1/sessions/<tmux name>/theme` instead of writing localStorage.
 * The server persists it twice, both keyed by the TMUX SESSION NAME:
 * `<working_dir>/.cc.theme` and `pinned_themes.json`. That name is
 * stable across reloads, across reconnects and across browsers, and it
 * is not a pid and not a client-side id. On re-attach the server hands
 * back `pinned_theme` on the SessionInfo and app.js re-applies it.
 *
 * AUDIO. The speaker button is the per-session opt-in for the background
 * music that belongs to that session's theme. It defaults OFF for every
 * session and is only ever turned on by an explicit tap, which is also
 * the user gesture browsers require before any audio may play - so there
 * is no autoplay path here even in principle. The opt-in is remembered
 * per tmux session name in localStorage; entering a session applies that
 * session's choice.
 *
 * NOTE ON WHAT ACTUALLY MAKES SOUND: this control drives ThemeAudio.
 * That used to be plumbing with nothing behind it; as of the theme-audio
 * work eight CC0 ogg tracks ship under /static/assets/audio/ and the
 * theme manifests in client/css/themes/<name>/theme.json declare an
 * `audio` block pointing at them. A theme WITHOUT one is still silent,
 * which is why nothing here fakes a playing state: the control reflects
 * the opt-in, and reports honestly when the active theme has no track.
 */
(function () {
    'use strict';

    /** localStorage key prefix for the per-session music opt-in. */
    var AUDIO_KEY_PREFIX = 'cloude.audio.session.';

    /**
     * How long to wait before the confirming playback check. Long enough
     * for a same-origin file to open and for play() to settle or reject,
     * short enough that the message still belongs to the tap.
     */
    var RECHECK_MS = 900;

    /** The open picker element, or null. */
    var pickerEl = null;

    /** Document-level dismiss handlers, bound only while open. */
    var onDocPointer = null;
    var onDocKey = null;

    /**
     * The tmux session name currently in scope, or null.
     *
     * @returns {string|null}
     */
    function activeSession() {
        if (!window.Themes || typeof window.Themes.getActiveSession !== 'function') {
            return null;
        }
        return window.Themes.getActiveSession();
    }

    /**
     * Has the user opted this session into background music?
     *
     * @param {string|null} name - tmux session name.
     * @returns {boolean} false by default and whenever storage is unusable.
     */
    function isAudioOn(name) {
        if (!name) return false;
        try {
            return localStorage.getItem(AUDIO_KEY_PREFIX + name) === 'on';
        } catch (err) {
            return false;
        }
    }

    /**
     * Record the per-session music opt-in.
     *
     * @param {string|null} name - tmux session name.
     * @param {boolean} on
     * @returns {void}
     */
    function setAudioOn(name, on) {
        if (!name) return;
        try {
            localStorage.setItem(AUDIO_KEY_PREFIX + name, on ? 'on' : 'off');
        } catch (err) {
            console.warn('SessionThemeMenu: could not persist audio opt-in', err);
        }
    }

    /**
     * Apply a session and its opt-in to ThemeAudio's one gate.
     *
     * There is no app-scoped master switch behind this any more. Audio is
     * session-only, so the session name is part of the gate: a null name
     * is the home screen and cannot open it.
     *
     * @param {string|null} name - the tmux session in scope, or null.
     * @param {boolean} on - true if that session opted into music.
     * @returns {void}
     */
    function applyAudioState(name, on) {
        if (!window.ThemeAudio ||
            typeof window.ThemeAudio.setSessionAudio !== 'function') {
            return;
        }
        try {
            window.ThemeAudio.setSessionAudio(name, on);
        } catch (err) {
            console.warn('SessionThemeMenu: ThemeAudio session gate failed', err);
        }
    }

    /**
     * Does the active theme actually declare a music track?
     *
     * @returns {boolean}
     */
    function activeThemeHasAudio() {
        if (!window.Themes || typeof window.Themes.getActiveGlobal !== 'function') {
            return false;
        }
        var active = window.Themes.getActiveGlobal();
        return !!(active && active.audio && active.audio.src);
    }

    /**
     * Repaint the audio button to the current per-session state.
     *
     * @param {HTMLElement} btn
     * @returns {void}
     */
    function paintAudioButton(btn) {
        if (!btn) return;
        var on = isAudioOn(activeSession());
        var label = on ? 'turn off music for this session' : 'play music for this session';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.setAttribute('data-tooltip', label);
        btn.classList.toggle('is-on', on);
    }

    /**
     * Close the picker if open.
     *
     * @returns {void}
     */
    function close() {
        if (onDocPointer) {
            document.removeEventListener('pointerdown', onDocPointer, true);
            onDocPointer = null;
        }
        if (onDocKey) {
            document.removeEventListener('keydown', onDocKey, true);
            onDocKey = null;
        }
        if (pickerEl) {
            pickerEl.remove();
            pickerEl = null;
        }
    }

    /**
     * Position the picker against its anchor. The placement rule (above
     * the anchor, right edges flush, clamped into the VISUAL viewport)
     * is shared with the session tools menu and lives in
     * client/js/anchor-popover.js - it used to be copied into every
     * anchored surface and the copies drifted.
     *
     * @param {HTMLElement} el - the picker.
     * @param {HTMLElement} anchor - the control it belongs to.
     * @returns {void}
     */
    function position(el, anchor) {
        if (!window.AnchorPopover) return;
        window.AnchorPopover.place(el, anchor);
    }

    /**
     * Open the theme picker anchored to a button.
     *
     * @param {HTMLElement} anchor - the theme button.
     * @returns {void}
     */
    function open(anchor) {
        close();
        if (!window.Themes || typeof window.Themes.listAll !== 'function') return;

        var session = activeSession();
        var themes = window.Themes.listAll();
        var activeId = (window.Themes.getActiveGlobal() || {}).id;

        pickerEl = document.createElement('div');
        pickerEl.className = 'cloude-session-theme';
        pickerEl.setAttribute('role', 'menu');
        pickerEl.setAttribute('aria-label', 'session theme');

        var head = document.createElement('div');
        head.className = 'cloude-session-theme__head';
        head.textContent = session
            ? 'theme for ' + session
            : 'theme';
        pickerEl.appendChild(head);

        var list = document.createElement('div');
        list.className = 'cloude-session-theme__list';
        themes.forEach(function (m) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'cloude-session-theme__item';
            row.setAttribute('role', 'menuitemradio');
            var selected = m.id === activeId;
            row.setAttribute('aria-checked', selected ? 'true' : 'false');
            if (selected) row.classList.add('is-active');
            row.textContent = (m.name || m.id).toLowerCase();
            row.addEventListener('click', function () {
                // applyGlobal PATCHes the server-side per-session pin
                // whenever a session is in scope; it only writes the
                // localStorage default when there is no session.
                window.Themes.applyGlobal(m.id);
                close();
            });
            list.appendChild(row);
        });
        pickerEl.appendChild(list);

        document.body.appendChild(pickerEl);
        position(pickerEl, anchor);

        // Deferred a tick so the tap that opened it does not close it.
        onDocPointer = function (e) {
            if (!pickerEl) return;
            if (pickerEl.contains(e.target)) return;
            if (anchor.contains(e.target)) return;
            close();
        };
        onDocKey = function (e) {
            if (e.key === 'Escape') close();
        };
        setTimeout(function () {
            document.addEventListener('pointerdown', onDocPointer, true);
            document.addEventListener('keydown', onDocKey, true);
        }, 0);
    }

    /**
     * Apply the stored music opt-in for the session being entered. Called
     * on every session attach so switching sessions switches the music
     * with them, and so a session never inherits the previous session's
     * unmuted state.
     *
     * ALSO called on every LEAVE, with no session in scope. That case does
     * not mute anything and does not have to: with no session the gate
     * cannot open, so the home screen is silent by construction. The old
     * code OPENED the gate here so that the header master switch alone
     * could play the home theme; that switch is gone, and "no audio on the
     * home screen at all" is the requirement it was violating.
     *
     * @param {HTMLElement} [audioBtn] - the button to repaint, if mounted.
     * @returns {void}
     */
    function syncForSession(audioBtn) {
        var name = activeSession();
        applyAudioState(name, name ? isAudioOn(name) : false);
        paintAudioButton(audioBtn || document.getElementById('sessionAudioBtn'));
    }

    /**
     * Flip this session's music opt-in and apply it.
     *
     * Lives here rather than inside a button handler because the opt-in
     * is now driven from a MENU ROW (the session editor's "play music"
     * row, session-editor-menu.js) that is rebuilt on every open, so
     * there is no long-lived button to hang the logic off. The old
     * wire() button form was removed once its buttons were deleted.
     *
     * @param {object} [termWrapper] - the Terminal wrapper, for the pill.
     * @param {HTMLElement} [btn] - a button to repaint, if one exists.
     * @returns {boolean} the new opt-in state.
     */
    function toggleAudio(termWrapper, btn) {
        var name = activeSession();
        var next = !isAudioOn(name);
        setAudioOn(name, next);

        // No master switch to lift any more. This row IS the control, so
        // one tap is the whole path from "I want sound" to sound, and
        // there is nothing left that can silently veto it.
        applyAudioState(name, next);
        paintAudioButton(btn);

        var pill = termWrapper && typeof termWrapper._showStatusPill === 'function'
            ? function (msg, kind) { termWrapper._showStatusPill(msg, kind || 'info'); }
            : null;
        if (next && pill) {
            reportPlayback(pill);
        }
        return next;
    }

    /**
     * Say out loud what turning music on actually achieved.
     *
     * The control used to report only two of the many ways this can fail,
     * and stayed silent for the rest - including the one that was actually
     * happening. Anything short of audible sound now produces a sentence.
     *
     * Two passes, because the answer is not knowable synchronously: the
     * element has to open the file and play() resolves on a later turn. The
     * first pass catches the gates and a missing track, the second catches
     * a decode failure or a blocked play. A `settling` verdict is treated
     * as "ask again", never as success.
     *
     * @param {function(string, string=): void} pill - status pill renderer.
     * @returns {void}
     */
    function reportPlayback(pill) {
        var Status = window.ThemeAudioStatus;
        var prefix = 'music on for this session';

        /**
         * Render one verdict.
         *
         * @param {{playing: boolean, settling: boolean, reason: string|null}} v
         * @param {boolean} isFinal - true on the confirming pass.
         * @returns {void}
         */
        function say(v, isFinal) {
            if (v.playing) {
                if (!isFinal) pill(prefix);
                return;
            }
            if (v.settling && !isFinal) return;
            pill(prefix + ' - but no sound: ' + v.reason, 'error');
        }

        if (!Status || typeof Status.current !== 'function') {
            // No diagnosis module: fall back to the one fact we can still
            // establish locally rather than claiming success.
            pill(activeThemeHasAudio()
                ? prefix
                : prefix + ' - but no sound: this theme has no music track',
                activeThemeHasAudio() ? 'info' : 'error');
            return;
        }

        var first = Status.current();
        say(first, false);
        if (first.playing) return;
        setTimeout(function () {
            var again = Status.current();
            if (again.playing) return;
            say(again, true);
        }, RECHECK_MS);
    }

    window.SessionThemeMenu = {
        toggleAudio: toggleAudio,
        open: open,
        close: close,
        syncForSession: syncForSession,
        isAudioOn: isAudioOn,
        setAudioOn: setAudioOn,
        AUDIO_KEY_PREFIX: AUDIO_KEY_PREFIX
    };
})();
