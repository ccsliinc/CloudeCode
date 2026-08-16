/**
 * ThemeAudioSettings - persistence and upgrade migration for the theme
 * background music settings.
 *
 * Split out of themeAudio.js because this is the one part of the audio
 * feature that has to reason about VALUES WRITTEN BY AN OLDER BUILD.
 * Everything else in the module only ever sees the current session's
 * state; this file is where an upgrade is allowed to change its mind
 * about what a stored string means.
 *
 * WHY A VERSION STAMP EXISTS AT ALL. Up to and including v0.7.2 the
 * master volume was an ATTENUATOR that defaulted to 0.3 and multiplied
 * with the per-theme manifest volume. Two individually sane numbers
 * compounded: 0.28 x 0.3 is a linear gain of 0.084, about -21.5 dB on
 * top of a -24 LUFS clip, which is inaudible on a phone. The fix made
 * the master UNITY and left the manifest as the only attenuation.
 *
 * That fix is invisible to anyone who already has a value under
 * `cloude.audio.volume`, because a stored value overrides the default by
 * construction - which is exactly the shape of upgrade bug that no test
 * against a fresh browser can ever see. So the migration below drops any
 * master volume written under the old budget and lets the new default
 * apply. Nothing is lost: no UI ever set that key deliberately, it was
 * only ever reachable from `ThemeAudio.setVolume()` in a console.
 *
 * Keys owned here:
 *   cloude.audio.muted           'true' | 'false'  - the APP SOUND master
 *                                switch (header kebab). Default 'true',
 *                                i.e. app sound off until asked for.
 *   cloude.audio.volume          float 0..1 as a string - master gain.
 *   cloude.audio.settingsVersion integer as a string - schema stamp.
 *
 * The per-session music opt-in (`cloude.audio.session.<tmux name>`) is
 * NOT owned here; it belongs to session-theme-menu.js, which is the
 * thing that knows what a session is.
 *
 * Every function takes the storage object explicitly rather than
 * reaching for `localStorage`, so the migration is unit-testable against
 * a plain object. Storage access is wrapped: Safari in private mode
 * throws on setItem, and an audio setting is never worth an exception.
 *
 * Exposed as window.ThemeAudioSettings. Loaded BEFORE themeAudio.js.
 */
(function () {
    'use strict';

    if (window.ThemeAudioSettings) {
        // Idempotent - never re-init on hot reload or a double script tag.
        return;
    }

    /** APP SOUND master switch. Stored inverted, as a mute flag. */
    var LS_MUTED = 'cloude.audio.muted';
    /** Master gain, 0..1, as a string. */
    var LS_VOLUME = 'cloude.audio.volume';
    /** Schema stamp, so an upgrade can reinterpret the keys above. */
    var LS_VERSION = 'cloude.audio.settingsVersion';

    /**
     * Current settings schema version.
     *
     * 1 (implicit, unstamped) - master volume is an attenuator, default 0.3.
     * 2                       - master volume is unity; the per-theme
     *                           manifest volume is the only attenuation.
     */
    var SETTINGS_VERSION = 2;

    /**
     * The master gain when nothing is stored. Unity on purpose: the
     * manifest volume is the only attenuation in the normal path, so the
     * two numbers cannot quietly multiply each other into silence.
     */
    var DEFAULT_MASTER_VOLUME = 1.0;

    /**
     * Read a key, never throwing.
     *
     * @param {object} storage - a localStorage-like object.
     * @param {string} key - the key to read.
     * @returns {string|null} the stored string, or null if absent/unusable.
     */
    function _get(storage, key) {
        try {
            var v = storage.getItem(key);
            return v === undefined ? null : v;
        } catch (err) {
            return null;
        }
    }

    /**
     * Write a key, never throwing.
     *
     * @param {object} storage - a localStorage-like object.
     * @param {string} key - the key to write.
     * @param {string} value - the value to store.
     * @returns {void}
     */
    function _set(storage, key, value) {
        try {
            storage.setItem(key, String(value));
        } catch (err) {
            /* private mode, quota, or a storage-less environment */
        }
    }

    /**
     * Remove a key, never throwing. Falls back to writing the supplied
     * replacement when the storage object has no removeItem (some test
     * doubles and a few embedded webviews).
     *
     * @param {object} storage - a localStorage-like object.
     * @param {string} key - the key to drop.
     * @param {string} fallbackValue - written when removeItem is absent.
     * @returns {void}
     */
    function _remove(storage, key, fallbackValue) {
        try {
            if (typeof storage.removeItem === 'function') {
                storage.removeItem(key);
                return;
            }
        } catch (err) {
            /* fall through to the overwrite */
        }
        _set(storage, key, fallbackValue);
    }

    /**
     * The stored schema version. An unstamped store is version 1, which
     * is every browser that ran a build before this migration shipped.
     *
     * @param {object} storage - a localStorage-like object.
     * @returns {number} the stored version, or 1 when absent/unparseable.
     */
    function readVersion(storage) {
        var raw = _get(storage, LS_VERSION);
        if (raw === null) return 1;
        var n = parseInt(raw, 10);
        return isFinite(n) && n > 0 ? n : 1;
    }

    /**
     * Bring a store up to SETTINGS_VERSION. Idempotent: running it twice
     * is a no-op, and running it on a fresh browser only stamps.
     *
     * v1 -> v2 drops any stored master volume. See the file header: those
     * values were written under a gain budget where the master attenuated,
     * and keeping one silently re-applies the old inaudible gain on top of
     * the new manifest volumes. The mute flag is NOT touched, because its
     * meaning did not change.
     *
     * @param {object} storage - a localStorage-like object.
     * @returns {{migrated: boolean, fromVersion: number, clearedVolume: string|null}}
     *          clearedVolume is the discarded string, for logging, or null.
     */
    function migrate(storage) {
        var from = readVersion(storage);
        if (from >= SETTINGS_VERSION) {
            return { migrated: false, fromVersion: from, clearedVolume: null };
        }

        var stale = _get(storage, LS_VOLUME);
        if (stale !== null) {
            _remove(storage, LS_VOLUME, String(DEFAULT_MASTER_VOLUME));
        }
        _set(storage, LS_VERSION, String(SETTINGS_VERSION));

        return { migrated: true, fromVersion: from, clearedVolume: stale };
    }

    /**
     * Is the app sound master switch on?
     *
     * Stored as a MUTE flag for backward compatibility, so only an
     * explicit 'false' counts as on. Default off: nothing makes noise
     * until the user asks for it.
     *
     * @param {object} storage - a localStorage-like object.
     * @returns {boolean}
     */
    function readAppSoundOn(storage) {
        return _get(storage, LS_MUTED) === 'false';
    }

    /**
     * Persist the app sound master switch.
     *
     * @param {object} storage - a localStorage-like object.
     * @param {boolean} on - true to allow sound, false to mute everything.
     * @returns {void}
     */
    function writeAppSoundOn(storage, on) {
        _set(storage, LS_MUTED, on ? 'false' : 'true');
    }

    /**
     * The master gain, 0..1. Out-of-range and unparseable values fall
     * back to the default rather than attenuating by accident.
     *
     * @param {object} storage - a localStorage-like object.
     * @returns {number} 0..1.
     */
    function readVolume(storage) {
        var raw = _get(storage, LS_VOLUME);
        if (raw === null) return DEFAULT_MASTER_VOLUME;
        var n = parseFloat(raw);
        if (isFinite(n) && n >= 0 && n <= 1) return n;
        return DEFAULT_MASTER_VOLUME;
    }

    /**
     * Persist the master gain.
     *
     * @param {object} storage - a localStorage-like object.
     * @param {number} v - 0..1.
     * @returns {void}
     */
    function writeVolume(storage, v) {
        _set(storage, LS_VOLUME, String(v));
    }

    window.ThemeAudioSettings = {
        LS_MUTED: LS_MUTED,
        LS_VOLUME: LS_VOLUME,
        LS_VERSION: LS_VERSION,
        SETTINGS_VERSION: SETTINGS_VERSION,
        DEFAULT_MASTER_VOLUME: DEFAULT_MASTER_VOLUME,
        readVersion: readVersion,
        migrate: migrate,
        readAppSoundOn: readAppSoundOn,
        writeAppSoundOn: writeAppSoundOn,
        readVolume: readVolume,
        writeVolume: writeVolume
    };
})();
