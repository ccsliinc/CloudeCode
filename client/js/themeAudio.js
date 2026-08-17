/**
 * ThemeAudio - per-theme background music.
 *
 * Ships dormant: nothing plays until a theme manifest carries an `audio`
 * block AND the user opts the session in from the session editor FAB
 * menu ("play music"), which is also the user gesture browsers require.
 *
 * Manifest shape: the optional `audio` block of
 * client/css/themes/<name>/theme.json - src, srcFallback, volume, fadeMs.
 * The authoritative definition is ThemeAudioManifest in src/models.py,
 * because that model is what decides which fields survive the API.
 *
 * FORMAT ORDER IS FIXED, m4a first: iOS returns "probably" for Ogg Vorbis
 * from canPlayType and then fails to decode it, so the fallback is driven
 * by a real load ERROR rather than a capability probe. The measurements
 * are in ThemeAudioNode.candidates() in themeAudioNode.js.
 *
 * GAIN BUDGET (read before lowering any of these numbers). The clips are
 * loudnorm'd to about -24 LUFS. The master and the per-theme volume
 * MULTIPLY: the original 0.28 x 0.3 was a linear gain of 0.084, roughly
 * -45 LUFS at the speaker and inaudible on a phone. The master now
 * defaults to 1.0 and manifests carry 0.45..0.60. A THIRD multiplier, the
 * element's own `.volume`, attenuates UPSTREAM of the Web Audio graph -
 * see ThemeAudioNode.makeNode() for the measurement.
 *
 * `src` MUST be same-origin. src/main.py declares no `media-src`, so media
 * falls back to `default-src 'self'` and any remote URL is blocked.
 *
 * TWO GATES, NOT ONE. Sound requires BOTH:
 *
 *   1. APP SOUND, the master switch in the header kebab, labelled "app
 *      sound (all sessions)". Persisted, default OFF.
 *   2. The PER-SESSION music opt-in, owned by session-theme-menu.js and
 *      keyed by tmux session name. Applied on every attach, default OFF.
 *
 * These used to be the SAME boolean, so an attach silently overwrote the
 * header switch with the per-session default of OFF without repainting the
 * button. An attach now sets gate 2 and cannot touch gate 1.
 *
 * Gate 2 is OPEN whenever no session is in scope, so the header switch
 * alone plays the home theme. syncForSession() sets it from the attached
 * session's stored opt-in, and re-opens it on detach - a closed gate
 * surviving a detach was its own silent-mute bug.
 *
 * Public surface (singleton on window.ThemeAudio): init(), setTheme(cfg|null)
 * driven by the themes registry, the two gate pairs setAppSound/isAppSoundOn
 * and setSessionEnabled/isSessionEnabled, toggleMute() and isMuted() for the
 * effective state, getLastPlayError(), getStatus() for diagnosis, and
 * getVolume()/setVolume() for the master, which still has no UI. Each is
 * documented at its definition.
 *
 * Persistence and the upgrade migration live in themeAudioSettings.js. A
 * `cloude:audio-state` CustomEvent fires on `document` whenever either gate
 * changes, so the header button repaints when something other than its own
 * click moved the state.
 *
 * Engine: MediaElementAudioSourceNode -> GainNode -> destination, for clean
 * linearRampToValueAtTime crossfades. The requestAnimationFrame ramp is the
 * fallback for when AudioContext construction fails; same behaviour, coarser
 * curve. Looping uses `el.loop`, which still gaps audibly in 2026 and is
 * acceptable for ambience; the upgrade path is AudioBufferSourceNode.
 *
 * Page Visibility: pause when document.hidden, resume when visible if not
 * muted. Explicit, because browsers do not universally pause backgrounded
 * tabs.
 *
 * Autoplay: setTheme() only preloads, it never calls play(). The
 * AudioContext is built by makeNode(), which is NOT inside a gesture, so it
 * starts suspended; the first unmute resumes it from inside the gesture.
 *
 * WHERE THE MANIFEST COMES FROM, and why this module was dead code until
 * 2026-08-16. setTheme() is fed from GET /api/v1/themes, NOT from
 * theme.json on disk, and that endpoint's Pydantic response_model dropped
 * the `audio` block, so this module received null for every theme and
 * correctly played nothing. If sound disappears again, check the API
 * payload before anything in here.
 *
 * REPORTING FAILURE. Every audio bug this feature has shipped was silent.
 * getStatus() exposes the raw facts and themeAudioStatus.js turns them into
 * the sentence the music control shows the user.
 */(function () {
    'use strict';

    if (window.ThemeAudio) {
        // Idempotent — never re-init on hot reload or double-script-tag.
        return;
    }

    var Settings = window.ThemeAudioSettings;

    // The user's master gain. Defaults to unity: the per-theme volume in
    // the manifest is the ONLY attenuation in the normal path, so the two
    // numbers cannot quietly multiply each other into silence.
    var DEFAULT_MASTER_VOLUME = Settings.DEFAULT_MASTER_VOLUME;

    // ---- State ----
    var initialized = false;
    // Gate 1: the header master switch. Persisted, default off.
    var appSoundOn = false;
    // Gate 2: the per-session opt-in. In-memory; session-theme-menu.js
    // sets it on every attach. True until then so the header switch alone
    // can play the home theme.
    var sessionOn = true;
    // Derived from the two gates above — never assigned directly.
    var muted = true;
    var globalVolume = DEFAULT_MASTER_VOLUME; // 0..1; multiplied with per-theme volume
    var currentConfig = null;          // last audioConfig passed to setTheme()

    // Current playback node. The node shape and the choice of engine
    // (webaudio vs element) both live in themeAudioNode.js, which also
    // owns the shared AudioContext; this file only holds which node is
    // playing and which is fading out.
    var currentNode = null;
    var outgoingNode = null; // held during crossfade only

    // ---- Gate plumbing ----
    /**
     * Tell listeners (the header button) that a gate moved. Fired for any
     * change, including ones the header did not cause, because the header
     * used to repaint only on its own click and therefore lied whenever
     * something else muted the app.
     *
     * @returns {void}
     */
    function _emitChange() {
        try {
            if (typeof document === 'undefined' ||
                typeof document.dispatchEvent !== 'function' ||
                typeof CustomEvent !== 'function') {
                return;
            }
            document.dispatchEvent(new CustomEvent('cloude:audio-state', {
                detail: { appSoundOn: appSoundOn, sessionOn: sessionOn, muted: muted }
            }));
        } catch (err) { /* an event is never worth an exception */ }
    }

    /**
     * Start or stop playback to match the current gate state. Idempotent:
     * safe to call when nothing actually changed.
     *
     * @returns {void}
     */
    function _applyGate() {
        if (muted) {
            if (!currentNode) return;
            var outMs = Math.min(currentNode.fadeMs, 400);
            window.ThemeAudioNode.ramp(currentNode, 0, outMs, _ctx());
            setTimeout(function () {
                if (currentNode && muted) {
                    try { currentNode.audio.pause(); } catch (_) { /* ignore */ }
                }
            }, outMs + 20);
            return;
        }
        // Unmuting is normally the user-gesture moment, so resume the
        // context here rather than at construction time.
        _resumeCtxIfSuspended();
        if (currentNode && !document.hidden) {
            _tryPlay(currentNode);
            window.ThemeAudioNode.ramp(
                currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, _ctx());
        }
    }

    /**
     * Recompute the effective mute from the two gates and act on it.
     *
     * @returns {boolean} the new effective muted state.
     */
    function _recompute() {
        var next = !(appSoundOn && sessionOn);
        var changed = next !== muted;
        muted = next;
        if (changed) _applyGate();
        _emitChange();
        return muted;
    }

    // ---- Node construction ----
    /**
     * Policy callbacks handed to ThemeAudioNode.makeNode(). The mechanics
     * of building and retrying a node live in that module; these four
     * answers are the only things it needs from the policy layer, and
     * keeping them as callbacks is what lets the two files stay separate.
     */
    var nodeHost = {
        /**
         * Is this node the one currently in play?
         *
         * @param {object} node - a playback node.
         * @returns {boolean}
         */
        isCurrent: function (node) { return node === currentNode; },

        /**
         * Should audio be running right now?
         *
         * @returns {boolean}
         */
        shouldPlay: function () { return !muted && !document.hidden; },

        /**
         * The node's gain target once the master is applied.
         *
         * @param {object} node - a playback node.
         * @returns {number} 0..1.
         */
        effectiveTarget: function (node) { return _effectiveTarget(node); },

        /**
         * Forget a node whose sources are all exhausted.
         *
         * @param {object} node - the node being dropped.
         * @returns {void}
         */
        onDrop: function (node) {
            if (currentNode === node) currentNode = null;
            if (outgoingNode === node) outgoingNode = null;
        }
    };

    /**
     * Build a playback node for a manifest `audio` block.
     *
     * @param {object|null} cfg - a manifest `audio` block.
     * @returns {object|null} the node, or null for an unusable cfg.
     */
    function _makeNode(cfg) {
        return window.ThemeAudioNode.makeNode(cfg, nodeHost);
    }

    /**
     * The shared AudioContext, or null. Owned by ThemeAudioNode.
     *
     * @returns {AudioContext|null}
     */
    function _ctx() { return window.ThemeAudioNode.getCtx(); }

    /**
     * Resume the AudioContext if the browser suspended it.
     *
     * @returns {void}
     */
    function _resumeCtxIfSuspended() { window.ThemeAudioNode.resumeCtx(); }

    // ---- Effective volume helpers ----
    function _effectiveTarget(node) {
        if (!node) return 0;
        return node.targetVolume * globalVolume;
    }

    // ---- Play / pause primitives (respect muted + autoplay grant) ----
    /**
     * Start a node. Mechanics and rejection logging live in ThemeAudioNode.
     *
     * @param {object} node - the playback node.
     * @returns {void}
     */
    function _tryPlay(node) {
        window.ThemeAudioNode.play(node);
    }

    // ---- Public API ----

    /**
     * Apply a new audio configuration. Pass null to fade out the current track
     * without starting a replacement (e.g. when the active theme has no audio).
     *
     * Called by Themes.applyTheme() on every theme switch — must be cheap and
     * idempotent when the same config is passed twice.
     */
    function setTheme(audioConfig) {
        // Same-src no-op (avoid teardown+rebuild when applyTheme fires for an
        // unrelated reason like cssVars repaint).
        var newSrc = audioConfig && audioConfig.src ? audioConfig.src : null;
        var curSrc = currentNode ? currentNode.src : null;
        if (newSrc === curSrc) {
            currentConfig = audioConfig;
            // Update target gain in case theme changed volume/fadeMs only.
            if (currentNode && audioConfig) {
                currentNode.targetVolume = typeof audioConfig.volume === 'number'
                    ? audioConfig.volume : currentNode.targetVolume;
                currentNode.fadeMs = typeof audioConfig.fadeMs === 'number' && audioConfig.fadeMs >= 0
                    ? audioConfig.fadeMs : currentNode.fadeMs;
                if (!muted && !document.hidden) {
                    window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, _ctx());
                }
            }
            return;
        }

        currentConfig = audioConfig;

        // Fade out + tear down any outgoing track.
        if (outgoingNode) {
            window.ThemeAudioNode.teardown(outgoingNode);
            outgoingNode = null;
        }
        if (currentNode) {
            outgoingNode = currentNode;
            var outFade = outgoingNode.fadeMs;
            window.ThemeAudioNode.ramp(outgoingNode, 0, outFade, _ctx());
            (function (n, ms) {
                setTimeout(function () {
                    if (n === outgoingNode) {
                        window.ThemeAudioNode.teardown(n);
                        outgoingNode = null;
                    }
                }, ms + 50);
            })(outgoingNode, outFade);
            currentNode = null;
        }

        // No new track requested — just silence.
        if (!audioConfig) return;

        var node = _makeNode(audioConfig);
        if (!node) return;
        currentNode = node;

        // If unmuted and visible, fade in immediately. Otherwise the track is
        // preloaded but silent; first unmute or visibility-return will play it.
        if (!muted && !document.hidden) {
            _resumeCtxIfSuspended();
            _tryPlay(node);
            window.ThemeAudioNode.ramp(node, _effectiveTarget(node), node.fadeMs, _ctx());
        }
    }

    /**
     * Set gate 1, the app sound master switch. Persisted. MUST be called
     * from a user-gesture handler the FIRST time it turns sound on -
     * that is the only way the autoplay grant reaches the AudioContext.
     *
     * @param {boolean} on - true to allow sound, false to mute everything.
     * @returns {boolean} the new EFFECTIVE muted state.
     */
    function setAppSound(on) {
        appSoundOn = !!on;
        Settings.writeAppSoundOn(localStorage, appSoundOn);
        return _recompute();
    }

    /**
     * Is gate 1 (app sound, all sessions) on?
     *
     * @returns {boolean}
     */
    function isAppSoundOn() { return appSoundOn; }

    /**
     * Set gate 2, the current session's music opt-in. NOT persisted here:
     * session-theme-menu.js owns the per-session key, because it is the
     * thing that knows which session is attached.
     *
     * @param {boolean} on - true if this session opted into music.
     * @returns {boolean} the new EFFECTIVE muted state.
     */
    function setSessionEnabled(on) {
        sessionOn = !!on;
        return _recompute();
    }

    /**
     * Is gate 2 (this session's music opt-in) on?
     *
     * @returns {boolean}
     */
    function isSessionEnabled() { return sessionOn; }

    /**
     * Flip the app sound master switch. Kept as the header button's
     * handler; it drives gate 1 only, so an attach can no longer undo it.
     *
     * @returns {boolean} the new EFFECTIVE muted state.
     */
    function toggleMute() {
        return setAppSound(!appSoundOn);
    }

    /**
     * The effective gate: silent unless BOTH app sound and the session
     * opt-in are on.
     *
     * @returns {boolean}
     */
    function isMuted() { return muted; }

    /**
     * The name of the last play() rejection, or null if the last attempt
     * was clean. A rejected play() produces no error event and no
     * exception, so without this there is nothing to inspect.
     *
     * @returns {string|null}
     */
    function getLastPlayError() { return window.ThemeAudioNode.getLastPlayError(); }

    /**
     * A snapshot of everything that decides whether sound is coming out.
     *
     * Facts only, no interpretation: themeAudioStatus.js owns the mapping
     * from this shape to a sentence. Never throws, because it is called
     * from paint paths.
     *
     * @returns {{appSoundOn: boolean, sessionOn: boolean, muted: boolean,
     *            masterVolume: number, hidden: boolean, hasTrack: boolean,
     *            playError: string|null, loadError: string|null,
     *            node: null|{src: string, loadedSrc: string, paused: boolean,
     *                        currentTime: number, engine: string|null,
     *                        effectiveGain: number}}}
     */
    function getStatus() {
        var Node = window.ThemeAudioNode;
        return {
            appSoundOn: appSoundOn,
            sessionOn: sessionOn,
            muted: muted,
            masterVolume: globalVolume,
            hidden: typeof document !== 'undefined' && !!document.hidden,
            hasTrack: !!(currentConfig && currentConfig.src),
            playError: Node ? Node.getLastPlayError() : null,
            loadError: Node && typeof Node.getLastLoadError === 'function'
                ? Node.getLastLoadError() : null,
            node: Node && typeof Node.snapshot === 'function'
                ? Node.snapshot(currentNode) : null
        };
    }
    function getVolume() { return globalVolume; }
    function setVolume(v) {
        var clamped = Math.max(0, Math.min(1, v));
        globalVolume = clamped;
        Settings.writeVolume(localStorage, clamped);
        if (currentNode && !muted && !document.hidden) {
            window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), 200, _ctx());
        }
    }

    // ---- Page Visibility ----
    function _onVisibilityChange() {
        if (document.hidden) {
            if (currentNode) {
                window.ThemeAudioNode.ramp(currentNode, 0, 200, _ctx());
                setTimeout(function () {
                    if (currentNode && document.hidden) {
                        try { currentNode.audio.pause(); } catch (_) { /* ignore */ }
                    }
                }, 220);
            }
        } else {
            if (!muted && currentNode) {
                _resumeCtxIfSuspended();
                _tryPlay(currentNode);
                window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, _ctx());
            }
        }
    }

    /**
     * Read persisted settings and wire the visibility handler. Call once.
     *
     * The migration runs BEFORE the volume is read, so a master volume
     * left over from the old attenuating gain budget is dropped rather
     * than silently overriding the new unity default. See
     * themeAudioSettings.js for why that value cannot simply be trusted.
     *
     * @returns {void}
     */
    function init() {
        if (initialized) return;
        initialized = true;

        var m = Settings.migrate(localStorage);
        if (m.migrated) {
            console.log('ThemeAudio: migrated settings v' + m.fromVersion +
                ' -> v' + Settings.SETTINGS_VERSION +
                (m.clearedVolume === null
                    ? ''
                    : ' (dropped stale master volume ' + m.clearedVolume + ')'));
        }

        appSoundOn = Settings.readAppSoundOn(localStorage);
        globalVolume = Settings.readVolume(localStorage);
        muted = !(appSoundOn && sessionOn);

        document.addEventListener('visibilitychange', _onVisibilityChange);
        console.log('ThemeAudio: initialized - appSound=' + appSoundOn +
            ' session=' + sessionOn + ' muted=' + muted + ' volume=' + globalVolume);
    }

    window.ThemeAudio = {
        init: init,
        setTheme: setTheme,
        toggleMute: toggleMute,
        isMuted: isMuted,
        setAppSound: setAppSound,
        isAppSoundOn: isAppSoundOn,
        setSessionEnabled: setSessionEnabled,
        isSessionEnabled: isSessionEnabled,
        getLastPlayError: getLastPlayError,
        getStatus: getStatus,
        getVolume: getVolume,
        setVolume: setVolume
    };
})();
