/**
 * Read THIS browser's settings for the one-time import. Allowlist only.
 *
 * IT NEVER ITERATES STORAGE, AND THAT IS THE SECURITY PROPERTY. There is
 * no `for (let i = 0; i < localStorage.length; i++)` here and there must
 * never be one. Every key this module reads is a literal in the table
 * below, so `claude_tunnel_token` and `claude_refresh_token` are outside
 * the payload BY CONSTRUCTION rather than by a filter somebody has to
 * remember to update when the next secret is added. A scrape with a
 * denylist is one forgotten entry away from uploading a credential; an
 * allowlist of literals cannot be.
 *
 * THREE KEYS ARE DELIBERATELY ABSENT FROM THE TABLE.
 *
 *   * `cloude.themeJsAllowlist` - a theme script approval. #46's rule is
 *     "never infer theme-script approval from a theme selection", and
 *     this is the same rule one step further: never carry an approval at
 *     all. The local record names a theme id and no digest, so importing
 *     it would mint exactly the unbounded standing grant #45 exists to
 *     make unexpressible. The server refuses the field by name too, so
 *     this is a belt and its braces.
 *   * `cloude.theme.vars` - a paint cache, fully derivable from the
 *     theme id. There is nothing here for a preference to own.
 *   * `cloude.audio.muted` and `cloude.audio.settingsVersion` - local
 *     migration bookkeeping. The first is a retired key a migration
 *     exists to ERASE, and resurrecting it through an import is the one
 *     thing it must not do.
 *
 * VALUES ARE TRANSLATED, NOT COPIED. localStorage holds strings; the
 * preference block is typed. `'on'` becomes `true`, a stringified float
 * becomes a number, a JSON envelope is parsed. A value that will not
 * translate is OMITTED rather than sent as a guess: the server would
 * refuse it anyway, and a preview row reading "rejected" for a value
 * this browser never really held would be a lie in the one place the
 * user is being asked to trust what they are shown.
 *
 * THE MASTER VOLUME READS THE LEGACY KEY EXACTLY AS THE APP DOES. The
 * current key is `cloude.audio.master` and `cloude.audio.volume` is a
 * fallback consulted only when the first is absent - the same order
 * `themeAudioSettings.readVolume()` uses, restated here rather than
 * re-derived, so an import cannot resurrect a pre-v2 gain the migration
 * exists to delete.
 */

console.log('[SettingsImportCollect Module] Loading...');

(function () {
    const MIN_MASTER_VOLUME = 0.35;
    const SIDEBAR_DENSITIES = ['compact', 'cozy', 'detailed'];
    const LAUNCHPAD_SECTION_IDS = ['running-sessions', 'recent-sessions', 'recent-projects'];
    const MODEL_ID_RE = /^(?!-)[A-Za-z0-9._~/-]{1,120}$/;

    /**
     * The whole allowlist, as literals. Nothing else is ever read.
     *
     * Each entry maps ONE preference field to the browser key or keys it
     * comes from, and a reader that turns the stored string into the
     * typed value the server validates.
     */
    const SOURCES = [
        { field: 'theme', keys: ['cloude.theme'], read: readTheme },
        { field: 'audio_enabled', keys: ['cloude.audio.enabled'], read: readAudioEnabled },
        {
            field: 'audio_master_volume',
            keys: ['cloude.audio.master', 'cloude.audio.volume'],
            read: readMasterVolume,
        },
        {
            field: 'launch_last_model',
            keys: ['cloude_provider_last_model'],
            read: readLastModel,
        },
        {
            field: 'sidebar_density',
            keys: ['cloude.session.sidebar.density'],
            read: readDensity,
        },
        {
            field: 'sidebar_arrangement',
            keys: ['cloude.session.sidebar.arrangement'],
            read: readArrangement,
        },
        {
            field: 'sidebar_pinned',
            keys: ['cloude.session.sidebar.pinned'],
            read: readOneZero,
        },
        {
            field: 'config_editor_pinned',
            keys: ['cloude.configEditor.pinned'],
            read: readOneZero,
        },
        {
            field: 'config_editor_collapsed',
            keys: ['cloude.configEditor.collapsed'],
            read: readBooleanMap,
        },
        {
            field: 'launchpad_collapsed',
            keys: ['cloude.launchpad.collapsed'],
            read: readLaunchpadCollapsed,
        },
    ];

    /**
     * Every browser key this module may read, for a test to assert on.
     *
     * Inputs: none.
     * Output: string[] - sorted, deduplicated.
     */
    function readableKeys() {
        const seen = {};
        SOURCES.forEach(function (source) {
            source.keys.forEach(function (key) { seen[key] = true; });
        });
        return Object.keys(seen).sort();
    }

    /**
     * Every preference field this module can offer.
     *
     * Inputs: none.
     * Output: string[] - sorted.
     */
    function fields() {
        return SOURCES.map(function (s) { return s.field; }).sort();
    }

    /**
     * Collect this browser's offerable settings.
     *
     * Description: reads ONLY the literal keys in `SOURCES`. A key that
     *   is absent, unreadable or will not translate is OMITTED, so the
     *   result is what this browser really holds rather than a snapshot
     *   padded with defaults - a default offered as a value is how an
     *   import overwrites a real setting with nothing.
     * Inputs:
     *   storage (Storage|undefined) - injectable for tests; defaults to
     *     `globalThis.localStorage`.
     *   allowed (string[]|undefined) - the server's own importable list,
     *     from `GET /settings/import/state`. When given, a field not in
     *     it is not collected, so the client never has to carry a second
     *     copy of the allowlist that could drift.
     * Output: object - preference field to value, possibly empty.
     * Example: SettingsImportCollect.collect(localStorage, allowed)
     */
    function collect(storage, allowed) {
        const store = storage || globalThis.localStorage;
        const out = {};
        if (!store || typeof store.getItem !== 'function') return out;

        const permitted = Array.isArray(allowed) ? allowed : null;
        SOURCES.forEach(function (source) {
            if (permitted && permitted.indexOf(source.field) === -1) return;
            const raw = source.keys.map(function (key) {
                try {
                    return store.getItem(key);
                } catch (err) {
                    // Deliberately swallowed per key: storage can be
                    // disabled or a single read can throw, and one
                    // unreadable key must not cost the user the rest of
                    // their settings.
                    return null;
                }
            });
            const value = source.read(raw);
            if (value !== undefined) out[source.field] = value;
        });
        return out;
    }

    // ---- readers. Each takes the raw strings for its keys, in order. --

    function readTheme(raw) {
        const value = raw[0];
        if (typeof value !== 'string' || !value) return undefined;
        return value;
    }

    function readAudioEnabled(raw) {
        if (raw[0] === 'on') return true;
        if (raw[0] === 'off') return false;
        return undefined;
    }

    function readMasterVolume(raw) {
        // Current key first, legacy key only as a fallback - the same
        // order themeAudioSettings.readVolume uses.
        const current = parseVolumeEnvelope(raw[0]);
        if (current !== undefined) return current;
        return parseBareVolume(raw[1]);
    }

    function parseVolumeEnvelope(value) {
        if (typeof value !== 'string' || !value) return undefined;
        let parsed;
        try {
            parsed = JSON.parse(value);
        } catch (err) {
            return undefined;
        }
        if (!parsed || typeof parsed !== 'object') return undefined;
        return clampVolume(parsed.v);
    }

    function parseBareVolume(value) {
        if (typeof value !== 'string' || !value) return undefined;
        return clampVolume(Number(value));
    }

    function clampVolume(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
        if (value < MIN_MASTER_VOLUME) return MIN_MASTER_VOLUME;
        if (value > 1) return 1;
        return value;
    }

    function readLastModel(raw) {
        const value = raw[0];
        if (typeof value !== 'string') return undefined;
        // The empty string is this key's own spelling of "claude, no
        // OpenRouter model", and it is a real choice rather than an
        // absence, so it is offered.
        if (value === '') return '';
        return MODEL_ID_RE.test(value) ? value : undefined;
    }

    function readDensity(raw) {
        const value = raw[0];
        return SIDEBAR_DENSITIES.indexOf(value) === -1 ? undefined : value;
    }

    function readOneZero(raw) {
        if (raw[0] === '1') return true;
        if (raw[0] === '0') return false;
        return undefined;
    }

    function readArrangement(raw) {
        const parsed = parseObject(raw[0]);
        if (parsed === undefined) return undefined;
        const out = {
            v: typeof parsed.v === 'number' ? parsed.v : 1,
            pinned: stringList(parsed.pinned),
            order: stringList(parsed.order),
            collapsed: stringList(parsed.collapsed),
        };
        if (!out.pinned.length && !out.order.length && !out.collapsed.length) {
            // An empty arrangement is not a preference anybody set.
            return undefined;
        }
        return out;
    }

    function readBooleanMap(raw) {
        const parsed = parseObject(raw[0]);
        if (parsed === undefined) return undefined;
        const out = {};
        Object.keys(parsed).forEach(function (key) {
            if (typeof parsed[key] === 'boolean') out[key] = parsed[key];
        });
        return Object.keys(out).length ? out : undefined;
    }

    function readLaunchpadCollapsed(raw) {
        const parsed = readBooleanMap(raw);
        if (parsed === undefined) return undefined;
        const out = {};
        Object.keys(parsed).forEach(function (key) {
            // The server validates this set too; filtering here keeps a
            // stale section id from refusing the whole field.
            if (LAUNCHPAD_SECTION_IDS.indexOf(key) !== -1) out[key] = parsed[key];
        });
        return Object.keys(out).length ? out : undefined;
    }

    function parseObject(value) {
        if (typeof value !== 'string' || !value) return undefined;
        let parsed;
        try {
            parsed = JSON.parse(value);
        } catch (err) {
            return undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        return parsed;
    }

    function stringList(value) {
        if (!Array.isArray(value)) return [];
        return value.filter(function (item) {
            return typeof item === 'string' && item.length > 0;
        });
    }

    const api = {
        collect: collect,
        readableKeys: readableKeys,
        fields: fields,
    };

    globalThis.SettingsImportCollect = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[SettingsImportCollect Module] Loaded');
})();
