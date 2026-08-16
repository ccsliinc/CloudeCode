/**
 * ThemeAudio - per-theme background music.
 *
 * Ships dormant: nothing plays until a theme manifest carries an `audio`
 * block AND the user opts the session in from the session editor FAB
 * menu ("play music"), which is also the user gesture browsers require.
 *
 * Manifest shape (optional, per client/css/themes/<name>/theme.json):
 *   "audio": {
 *     "src":         "/static/assets/audio/<slug>.m4a",
 *     "srcFallback": "/static/assets/audio/<slug>.ogg",
 *     "volume":      0.5,   // 0..1 target gain after fade-in
 *     "fadeMs":      1500   // crossfade duration in ms
 *   }
 *
 * WHY TWO FORMATS, AND WHY m4a IS FIRST. The clips first shipped as Ogg
 * Vorbis only, and on iOS that is SILENT. Measured on iPhone 16e,
 * iOS 26.1 / Safari 26.1, 2026-08-16:
 *
 *   canPlayType('audio/ogg; codecs=vorbis') -> "probably"
 *   <audio src="....ogg">  -> error MEDIA_ERR_SRC_NOT_SUPPORTED (4)
 *   <audio src="....m4a">  -> loadedmetadata, duration 164.98
 *
 * canPlayType LIES here: WebKit recognises the Ogg container, claims
 * Vorbis, then fails to decode. So a canPlayType-based probe would still
 * pick the ogg on iOS and still be silent. The order is therefore FIXED
 * (AAC first, decoded by every current engine) and the fallback is driven
 * by a real load ERROR, never by asking the browser what it supports.
 *
 * GAIN BUDGET (read before lowering any of these numbers). The clips are
 * loudnorm'd to about -24 LUFS, already quiet. The master and the
 * per-theme volume MULTIPLY, so two individually sane numbers compound:
 * the original 0.28 x 0.3 gave a linear gain of 0.084, i.e. -21.5 dB on
 * top of -24 LUFS, roughly -45 LUFS at the speaker - inaudible on a phone.
 * The master now defaults to 1.0 and manifests carry 0.45..0.60, landing
 * near -31..-28 LUFS: present, still background.
 *
 * `src` MUST be same-origin. src/main.py declares no `media-src`, so media
 * falls back to `default-src 'self'` and any remote URL is blocked.
 *
 * Public surface (singleton on window.ThemeAudio):
 *   init()                       - call once on app load
 *   setTheme(audioConfig|null)   - called by the themes registry on every
 *                                  applyTheme(); null fades out to silence
 *   toggleMute()                 - gesture handler; returns new muted state
 *   isMuted()                    - boolean for UI
 *   getLastPlayError()           - name of the last play() rejection, or null
 *   getVolume() / setVolume(v)   - master 0..1, persisted; no UI yet
 *
 * Persistence:
 *   localStorage['cloude.audio.muted']  -> 'true' | 'false'  (default 'true')
 *   localStorage['cloude.audio.volume'] -> '1' (float 0..1 as string)
 *
 * Engine: MediaElementAudioSourceNode -> GainNode -> destination, which
 * gives clean linearRampToValueAtTime crossfades. Clips are same-origin so
 * createMediaElementSource neither taints nor CORS-fails. The
 * requestAnimationFrame ramp is the fallback for when AudioContext
 * construction itself fails; behaviour matches, only the curve is coarser.
 * Looping uses `el.loop`, which still has an audible gap in every engine in
 * 2026; acceptable for ambience. The upgrade path is AudioBufferSourceNode
 * (fetch -> decodeAudioData), at the cost of a full in-memory load.
 *
 * Page Visibility: pause when document.hidden, resume when visible if not
 * muted. Explicit, because browsers do not universally pause backgrounded
 * tabs.
 *
 * Autoplay: the AudioContext is built lazily on the first toggleMute(), so
 * it is always constructed inside a user gesture. setTheme() before that
 * only preloads; it never calls play().
 */(function () {
    'use strict';

    if (window.ThemeAudio) {
        // Idempotent — never re-init on hot reload or double-script-tag.
        return;
    }

    var LS_MUTED = 'cloude.audio.muted';
    var LS_VOLUME = 'cloude.audio.volume';
    // The user's master gain. Defaults to unity: the per-theme volume in
    // the manifest is the ONLY attenuation in the normal path, so the two
    // numbers cannot quietly multiply each other into silence.
    var DEFAULT_MASTER_VOLUME = 1.0;

    // Target gain for a theme whose manifest declares audio but omits a
    // volume. Deliberately mid-scale, not unity.
    var DEFAULT_TRACK_VOLUME = 0.5;

    // ---- State ----
    var initialized = false;
    var muted = true;                         // default muted — overridden in init()
    var globalVolume = DEFAULT_MASTER_VOLUME; // 0..1; multiplied with per-theme volume
    var currentConfig = null;          // last audioConfig passed to setTheme()

    // Current playback node (one of two engines — see init/_engineKind).
    // Both engines share the same node shape so the rest of the code is uniform.
    //   { audio: HTMLAudioElement, src: string, volume: number, fadeMs: number,
    //     gain?: GainNode, sourceNode?: MediaElementAudioSourceNode,
    //     rafHandle?: number }
    var currentNode = null;
    var outgoingNode = null; // held during crossfade only


    // Web Audio (lazy-init on first user gesture)
    var audioCtx = null;
    var engineKind = null; // 'webaudio' | 'element' | null (decided on first play)

    // ---- LocalStorage helpers (defensive — never throw) ----
    function _readMuted() {
        try {
            var v = localStorage.getItem(LS_MUTED);
            // Default to muted; only an explicit 'false' unmutes.
            return v === null ? true : v !== 'false';
        } catch (_) { return true; }
    }
    function _writeMuted(b) {
        try { localStorage.setItem(LS_MUTED, b ? 'true' : 'false'); } catch (_) { /* ignore */ }
    }
    function _readVolume() {
        try {
            var v = localStorage.getItem(LS_VOLUME);
            if (v === null) return DEFAULT_MASTER_VOLUME;
            var n = parseFloat(v);
            if (isFinite(n) && n >= 0 && n <= 1) return n;
            return DEFAULT_MASTER_VOLUME;
        } catch (_) { return DEFAULT_MASTER_VOLUME; }
    }
    function _writeVolume(v) {
        try { localStorage.setItem(LS_VOLUME, String(v)); } catch (_) { /* ignore */ }
    }

    // ---- AudioContext lifecycle ----
    function _ensureAudioCtx() {
        if (audioCtx) return audioCtx;
        try {
            var Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            audioCtx = new Ctor();
            return audioCtx;
        } catch (e) {
            console.warn('ThemeAudio: AudioContext construction failed', e);
            return null;
        }
    }

    function _resumeCtxIfSuspended() {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(function (e) {
                console.warn('ThemeAudio: ctx.resume() rejected', e);
            });
        }
    }

    // ---- Node construction ----
    /**
     * Handle a media load error on a node: advance to the next declared
     * format if there is one, otherwise tear the node down.
     *
     * Retrying reuses the SAME element, so the Web Audio graph hanging off
     * it (MediaElementAudioSourceNode -> GainNode) survives the swap.
     * createMediaElementSource can only ever be called once per element,
     * so building a fresh element here would throw on the second attempt.
     *
     * @param {object} node - the node whose element errored.
     * @returns {void}
     */
    function _onNodeError(node) {
        var el = node.audio;
        var code = el && el.error ? el.error.code : null;
        var next = node.sourceIndex + 1;

        if (next < node.sources.length) {
            console.warn('ThemeAudio: ' + node.sources[node.sourceIndex] +
                ' failed (code ' + code + '), trying ' + node.sources[next]);
            node.sourceIndex = next;
            node.loadedSrc = node.sources[next];
            try {
                el.src = node.sources[next];
                el.load();
            } catch (e) {
                console.warn('ThemeAudio: fallback src swap threw', e);
                return;
            }
            // load() resets the element, so re-assert the state the node was
            // in. Volume is re-ramped rather than set, so a mid-fade swap
            // does not click.
            if (node === currentNode && !muted && !document.hidden) {
                _resumeCtxIfSuspended();
                _tryPlay(node);
                window.ThemeAudioNode.ramp(node, _effectiveTarget(node), node.fadeMs, audioCtx);
            }
            return;
        }

        console.warn('ThemeAudio: no playable source for', node.sources.join(', '),
            '(last error code ' + code + ')');
        window.ThemeAudioNode.teardown(node);
        if (currentNode === node) currentNode = null;
        if (outgoingNode === node) outgoingNode = null;
    }

    /**
     * Build a playback node for the given audio config. Returns null if the
     * config is missing or src is empty. Does NOT call .play() — caller decides.
     *
     * The node holds an <audio> element (always) plus optional Web Audio graph
     * (GainNode + MediaElementAudioSourceNode) if the engine has been settled
     * on 'webaudio'. If 'element' mode, gain is null and volume is driven by
     * the element's .volume property directly (ThemeAudioNode.ramp).
     *
     * @param {{src: string, srcFallback?: string, volume?: number,
     *          fadeMs?: number}|null} cfg - a manifest `audio` block.
     * @returns {object|null} the playback node, or null for an unusable cfg.
     */
    function _makeNode(cfg) {
        if (!cfg || typeof cfg !== 'object' || !cfg.src || typeof cfg.src !== 'string') {
            return null;
        }
        var el = new Audio();
        // crossorigin BEFORE src per spec — Safari/WebKit caches the request
        // mode at src-set time.
        el.crossOrigin = 'anonymous';
        el.loop = true;
        el.preload = 'auto';
        el.volume = 0; // start silent; fade-in handles the ramp

        var node = {
            audio: el,
            // Ordered candidate list, best-supported format first. See the
            // header: this order is FIXED rather than chosen by canPlayType,
            // because canPlayType claims Ogg Vorbis works on iOS and it does
            // not. `src` tracks whichever candidate is currently loaded so
            // setTheme()'s same-track no-op still compares correctly.
            sources: window.ThemeAudioNode.candidates(cfg),
            sourceIndex: 0,
            // `src` is the track's IDENTITY (always the manifest's primary),
            // which is what setTheme() compares to decide "same track". It
            // must NOT follow a fallback swap, or re-applying the same theme
            // after a fallback would look like a track change and restart it.
            src: cfg.src,
            // `loadedSrc` is the candidate actually on the element right now.
            loadedSrc: cfg.src,
            targetVolume: typeof cfg.volume === 'number' ? cfg.volume : DEFAULT_TRACK_VOLUME,
            fadeMs: typeof cfg.fadeMs === 'number' && cfg.fadeMs >= 0 ? cfg.fadeMs : 1500,
            gain: null,
            sourceNode: null,
            rafHandle: null
        };

        // A load error is not automatically fatal any more: if another format
        // is declared, try it before giving up. Only an exhausted candidate
        // list tears the node down.
        el.addEventListener('error', function () { _onNodeError(node); });

        el.src = node.sources[0];

        // Try to wire Web Audio graph. If createMediaElementSource fails
        // (CORS taint, codec issues, etc.), fall back to 'element' mode for
        // the rest of the session.
        if (engineKind !== 'element') {
            var ctx = _ensureAudioCtx();
            if (ctx) {
                try {
                    var src = ctx.createMediaElementSource(el);
                    var gain = ctx.createGain();
                    gain.gain.value = 0;
                    src.connect(gain).connect(ctx.destination);
                    node.gain = gain;
                    node.sourceNode = src;
                    engineKind = 'webaudio';
                } catch (e) {
                    // CORS taint or other graph-construction failure.
                    // Drop to element mode permanently for this session.
                    console.warn('ThemeAudio: WebAudio graph failed, falling back to element mode', e);
                    engineKind = 'element';
                }
            } else {
                engineKind = 'element';
            }
        }

        return node;
    }

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
                    window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, audioCtx);
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
            window.ThemeAudioNode.ramp(outgoingNode, 0, outFade, audioCtx);
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
            window.ThemeAudioNode.ramp(node, _effectiveTarget(node), node.fadeMs, audioCtx);
        }
    }

    /**
     * Toggle mute. MUST be called from a user-gesture handler (header button
     * click) for the FIRST unmute — that's the only way the autoplay grant
     * gets issued to the AudioContext.
     *
     * Returns the new muted state (boolean).
     */
    function toggleMute() {
        muted = !muted;
        _writeMuted(muted);

        if (muted) {
            // Mute: ramp current track to 0, then pause (don't tear down —
            // user may unmute again and we want the buffer warm).
            if (currentNode) {
                window.ThemeAudioNode.ramp(currentNode, 0, Math.min(currentNode.fadeMs, 400), audioCtx);
                setTimeout(function () {
                    if (currentNode && muted) {
                        try { currentNode.audio.pause(); } catch (_) { /* ignore */ }
                    }
                }, Math.min(currentNode.fadeMs, 400) + 20);
            }
        } else {
            // Unmute: this is (likely) the user-gesture moment. Resume ctx
            // and play.
            _resumeCtxIfSuspended();
            if (currentNode && !document.hidden) {
                _tryPlay(currentNode);
                window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, audioCtx);
            }
        }
        return muted;
    }

    function isMuted() { return muted; }

    /**
     * The name of the last play() rejection, or null if the last attempt
     * was clean. A rejected play() produces no error event and no
     * exception, so without this there is nothing to inspect.
     *
     * @returns {string|null}
     */
    function getLastPlayError() { return window.ThemeAudioNode.getLastPlayError(); }
    function getVolume() { return globalVolume; }
    function setVolume(v) {
        var clamped = Math.max(0, Math.min(1, v));
        globalVolume = clamped;
        _writeVolume(clamped);
        if (currentNode && !muted && !document.hidden) {
            window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), 200, audioCtx);
        }
    }

    // ---- Page Visibility ----
    function _onVisibilityChange() {
        if (document.hidden) {
            if (currentNode) {
                window.ThemeAudioNode.ramp(currentNode, 0, 200, audioCtx);
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
                window.ThemeAudioNode.ramp(currentNode, _effectiveTarget(currentNode), currentNode.fadeMs, audioCtx);
            }
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;

        muted = _readMuted();
        globalVolume = _readVolume();

        document.addEventListener('visibilitychange', _onVisibilityChange);
        console.log('ThemeAudio: initialized — muted=' + muted + ' volume=' + globalVolume);
    }

    window.ThemeAudio = {
        init: init,
        setTheme: setTheme,
        toggleMute: toggleMute,
        isMuted: isMuted,
        getLastPlayError: getLastPlayError,
        getVolume: getVolume,
        setVolume: setVolume
    };
})();
