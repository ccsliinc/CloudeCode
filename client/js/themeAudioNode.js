/**
 * ThemeAudioNode - the mechanics of one playback node.
 *
 * Split out of themeAudio.js, which owns the POLICY (is the session opted
 * in, is the tab visible, which theme is active) while this file owns the
 * MECHANICS (build the element, ramp its gain, start it, tear it down).
 * The two were one file and it grew past the 500-line limit; the seam is
 * real rather than arbitrary, because everything here is stateless with
 * respect to mute and visibility and takes the node as an argument.
 *
 * A "node" is a plain object owned by themeAudio.js:
 *   {
 *     audio: HTMLAudioElement,   // always present
 *     sources: string[],         // candidate URLs, best format first
 *     sourceIndex: number,       // index into sources currently loaded
 *     src: string,               // track IDENTITY (manifest primary)
 *     loadedSrc: string,         // candidate actually on the element
 *     targetVolume: number,      // 0..1 from the manifest
 *     fadeMs: number,
 *     gain: GainNode|null,       // null in element mode
 *     sourceNode: MediaElementAudioSourceNode|null,
 *     rafHandle: number|null     // element-mode ramp handle
 *   }
 *
 * Exposed as window.ThemeAudioNode. Loaded BEFORE themeAudio.js.
 */
(function () {
    'use strict';

    if (window.ThemeAudioNode) {
        // Idempotent - never re-init on hot reload or a double script tag.
        return;
    }

    /** Name of the most recent play() rejection, or null after a clean one. */
    var lastPlayError = null;

    /**
     * The ordered list of URLs to try for one manifest `audio` block.
     *
     * The order is FIXED, not chosen by canPlayType: on iOS, canPlayType
     * returns "probably" for Ogg Vorbis and the decode then fails with
     * MEDIA_ERR_SRC_NOT_SUPPORTED, so a capability probe would pick the
     * unplayable file. See the header of themeAudio.js for the measurement.
     *
     * @param {{src: string, srcFallback?: string}} cfg - a manifest block.
     * @returns {string[]} candidates, primary first, duplicates dropped.
     */
    function candidates(cfg) {
        var out = [cfg.src];
        if (typeof cfg.srcFallback === 'string' && cfg.srcFallback &&
            cfg.srcFallback !== cfg.src) {
            out.push(cfg.srcFallback);
        }
        return out;
    }

    /**
     * Ramp a node to `target` over `durationMs`.
     *
     * In webaudio mode this is GainNode automation; in element mode a
     * requestAnimationFrame loop driving audio.volume. Either way the
     * current value is anchored first, so back-to-back ramps never click.
     *
     * @param {object} node - the playback node.
     * @param {number} target - 0..1 destination gain.
     * @param {number} durationMs - ramp length in ms.
     * @param {AudioContext|null} ctx - the shared context, or null.
     * @returns {void}
     */
    function ramp(node, target, durationMs, ctx) {
        if (!node || !node.audio) return;
        var clamped = Math.max(0, Math.min(1, target));
        var dur = Math.max(0, durationMs);

        if (node.gain && ctx) {
            var now = ctx.currentTime;
            try {
                node.gain.gain.cancelScheduledValues(now);
                node.gain.gain.setValueAtTime(node.gain.gain.value, now);
                node.gain.gain.linearRampToValueAtTime(clamped, now + dur / 1000);
            } catch (e) {
                console.warn('ThemeAudioNode: gain ramp threw', e);
            }
            return;
        }

        if (node.rafHandle != null) {
            try { cancelAnimationFrame(node.rafHandle); } catch (_) { /* ignore */ }
            node.rafHandle = null;
        }
        var startVol = node.audio.volume;
        var startT = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        /**
         * One frame of the element-mode ramp.
         *
         * @param {number} t - the rAF timestamp.
         * @returns {void}
         */
        function step(t) {
            if (!node.audio) return; // torn down mid-ramp
            var k = dur === 0 ? 1 : Math.min(1, (t - startT) / dur);
            try {
                node.audio.volume = startVol + (clamped - startVol) * k;
            } catch (_) { /* ignore */ }
            node.rafHandle = k < 1 ? requestAnimationFrame(step) : null;
        }
        node.rafHandle = requestAnimationFrame(step);
    }

    /**
     * Stop a node, disconnect its Web Audio graph and drop the buffer.
     *
     * @param {object|null} node - the playback node, or null.
     * @returns {void}
     */
    function teardown(node) {
        if (!node) return;
        try { node.audio.pause(); } catch (_) { /* ignore */ }
        if (node.rafHandle != null) {
            try { cancelAnimationFrame(node.rafHandle); } catch (_) { /* ignore */ }
            node.rafHandle = null;
        }
        if (node.sourceNode) {
            try { node.sourceNode.disconnect(); } catch (_) { /* ignore */ }
            node.sourceNode = null;
        }
        if (node.gain) {
            try { node.gain.disconnect(); } catch (_) { /* ignore */ }
            node.gain = null;
        }
        // Detach src so the browser stops decoding and buffering.
        try {
            node.audio.removeAttribute('src');
            node.audio.load();
        } catch (_) { /* ignore */ }
    }

    /**
     * Start a node, recording any rejection.
     *
     * A rejected play() is invisible by construction: no error event, no
     * exception, just silence. It is logged even in the expected case,
     * because "the user tapped and heard nothing" is precisely the bug this
     * module has already shipped once, and the console is the only place
     * that failure is visible.
     *
     * NotAllowedError means the autoplay grant is missing - expected before
     * the first tap, and a REAL problem after one, because it means the
     * play() call lost its user activation. AbortError is a rapid
     * pause/play during a theme swap and is benign.
     *
     * @param {object} node - the playback node.
     * @returns {void}
     */
    function play(node) {
        if (!node || !node.audio) return;
        var p;
        try {
            p = node.audio.play();
        } catch (e) {
            lastPlayError = e && e.name ? e.name : 'Error';
            console.warn('ThemeAudioNode: play() threw', e);
            return;
        }
        lastPlayError = null;
        if (p && typeof p.then === 'function') {
            p.catch(function (err) {
                var name = err && err.name ? err.name : 'Error';
                lastPlayError = name;
                if (name === 'AbortError') return;
                console.warn('ThemeAudioNode: play() rejected', name, err && err.message);
            });
        }
    }

    /**
     * The name of the last play() rejection, or null if it was clean.
     *
     * @returns {string|null}
     */
    function getLastPlayError() {
        return lastPlayError;
    }

    window.ThemeAudioNode = {
        candidates: candidates,
        ramp: ramp,
        teardown: teardown,
        play: play,
        getLastPlayError: getLastPlayError
    };
})();
