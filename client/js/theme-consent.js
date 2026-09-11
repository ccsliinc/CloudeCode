/**
 * Whether a theme's effects.js may run, and where that answer is kept.
 *
 * THE GATE LIVES HERE AND NOT IN registry.js, AND THAT IS THE POINT.
 * The rule that matters about a security gate is what it REFUSES, and a
 * test that can only drive it through registry.js has to stand up a
 * document, a localStorage and a dynamic import before it can ask. So the
 * decision is a pure function and the execution is a callback the caller
 * passes in: `gateEffects` NEVER calls `inject` unless the ladder
 * answered `run`, and a test proves that by handing it a spy and an
 * unconsented theme. A gate that never refuses would pass every
 * happy-path test ever written against it.
 *
 * SIX OUTCOMES, ONE OF WHICH RUNS. `src/core/theme_script_consent.py`
 * holds the same ladder in the same order, and both files say why: every
 * way of NOT KNOWING resolves to a refusal, so the worst this can do is
 * leave a theme looking plainer than it should.
 *
 * WHERE THE RECORD LIVES, AND WHY IT MOVED. It used to be
 * `cloude.themeJsAllowlist` in this browser's localStorage, so a "never"
 * clicked on a phone bound on the phone alone and had to be repeated on
 * every other machine. It is now the server-owned `theme_script_consent`
 * preference, which means a refusal set anywhere binds everywhere.
 *
 * WHAT MAKES SHARING A GRANT SAFE IS THE DIGEST. An "always allow"
 * records the sha256 of the exact effects.js it was granted for, which
 * the server stamps onto the manifest as `effectsDigest`. Edit that file
 * and the grant stops matching, so the user is asked again about the
 * script that now exists rather than inheriting a yes given to a
 * different one. A grant names bytes, not a name.
 *
 * THE LEGACY LOCAL ALLOWLIST IS READ FOR ITS REFUSALS AND NEVER FOR ITS
 * GRANTS. A `false` in the old key is a restriction the user already
 * stated, and honouring it can only reduce what runs, so it carries over
 * for free. A `true` in it names no digest at all, so there is nothing to
 * bind a grant to and it is ignored: those users are asked once more,
 * and what they approve the second time is an artifact rather than a
 * label. This is also why the settings import in #46 refuses to carry
 * this key - see `client/js/settings-import.js`.
 *
 * A DENIAL OUTRANKS AN UNREADABLE RECORD, AND AN UNREADABLE RECORD
 * OUTRANKS A GRANT. If the preference block could not be read we cannot
 * show that no newer "never" exists, and honouring a cached yes there is
 * exactly the "a cached approval cannot outrank a newer global Never"
 * this feature was asked for. The cost of refusing is an animation that
 * does not play.
 */

console.log('[ThemeConsent Module] Loading...');

(function () {
    /** The preference field the shared record lives in. */
    const FIELD = 'theme_script_consent';

    /** The pre-#45 per-browser key, read for refusals only. */
    const LEGACY_KEY = 'cloude.themeJsAllowlist';

    const DECISION_ALWAYS = 'always';
    const DECISION_NEVER = 'never';
    const DECISION_ONCE = 'once';

    const SOURCE_BUILTIN = 'builtin';

    const RUN = 'run';
    const SKIP_NO_SCRIPT = 'skip_no_script';
    const SKIP_DENIED = 'skip_denied';
    const SKIP_DENIED_UNSAVED = 'skip_denied_unsaved';
    const SKIP_UNVERIFIABLE = 'skip_unverifiable';
    const PROMPT = 'prompt';
    const PROMPT_CHANGED = 'prompt_changed';

    const RUNG_NO_SCRIPT = 'no_script';
    const RUNG_DENIED = 'denied';
    const RUNG_RECORD_UNREADABLE = 'record_unreadable';
    const RUNG_BUILTIN = 'builtin';
    const RUNG_DIGEST_UNAVAILABLE = 'digest_unavailable';
    const RUNG_DIGEST_MISMATCH = 'digest_mismatch';
    const RUNG_GRANTED = 'granted';
    const RUNG_NO_RECORD = 'no_record';

    const DIGEST_RE = /^[0-9a-f]{64}$/;

    /**
     * WHAT A THEME ID MAY BE IS DELIBERATELY NOT MIRRORED HERE, unlike
     * DIGEST_RE above. The server's `THEME_ID_RE` is the authority on what
     * its own store can key on, and a second copy in the browser would
     * only be useful for pre-empting a write - which means a copy that
     * drifted would refuse a write the server would have taken. The gate
     * handles it REACTIVELY instead, through `persisted()` below, which is
     * right whatever the write failed for: a rejected key, a network
     * outage, a stale revision. See src/core/theme_script_consent.py for
     * the rule and the reason behind every character it excludes.
     */

    /**
     * The statuses that mean the shared record actually took the write.
     *
     * `unchanged` counts: the preference layer answers it when the value
     * on the server already equals the one being written, which is a
     * recorded refusal and not a failed one. Everything else - a stale
     * revision, a refused request, a validator that would not key on this
     * theme id - left nothing on disk.
     */
    const PERSISTED_STATUSES = ['committed', 'unchanged'];

    /**
     * Answer whether one theme's effects.js may run right now.
     *
     * Description: PURE. The rungs, in order: no script at all, a
     *   recorded refusal (which outranks everything below, the bundled
     *   bypass included), a record we could not read, a bundled theme,
     *   a script whose bytes we could not name, a grant naming DIFFERENT
     *   bytes, a grant naming THESE bytes, and finally nothing on
     *   record. Only `run` executes.
     * Inputs: input (object) -
     *   declaresScript (boolean), source (string), servedDigest
     *   (string|null), record (object|null), recordReadable (boolean).
     * Output: {outcome: string, rung: string, digest: (string|null)}.
     * Example:
     *   ThemeConsent.decide({declaresScript: true, source: 'user',
     *     servedDigest: d, record: null, recordReadable: true}).outcome
     *   // 'prompt'
     */
    function decide(input) {
        const spec = input || {};
        if (!spec.declaresScript) {
            return result(SKIP_NO_SCRIPT, RUNG_NO_SCRIPT, null);
        }

        const record = (spec.record && typeof spec.record === 'object')
            ? spec.record : null;
        const decision = record ? record.decision : null;
        const served = typeof spec.servedDigest === 'string'
            ? spec.servedDigest : null;

        if (decision === DECISION_NEVER) {
            return result(SKIP_DENIED, RUNG_DENIED, served);
        }
        if (spec.recordReadable === false) {
            return result(SKIP_UNVERIFIABLE, RUNG_RECORD_UNREADABLE, served);
        }
        if (spec.source === SOURCE_BUILTIN) {
            return result(RUN, RUNG_BUILTIN, served);
        }
        if (!served || !DIGEST_RE.test(served)) {
            return result(SKIP_UNVERIFIABLE, RUNG_DIGEST_UNAVAILABLE, null);
        }
        if (decision === DECISION_ALWAYS) {
            if (typeof record.digest === 'string' && record.digest === served) {
                return result(RUN, RUNG_GRANTED, served);
            }
            return result(PROMPT_CHANGED, RUNG_DIGEST_MISMATCH, served);
        }
        return result(PROMPT, RUNG_NO_RECORD, served);
    }

    function result(outcome, rung, digest) {
        return { outcome: outcome, rung: rung, digest: digest || null };
    }

    /**
     * The entry to store for one answered prompt, or null to store nothing.
     *
     * Description: `once` answers null, because a temporary allowance is
     *   a property of one sitting at one machine and sharing it would
     *   make it standing. An `always` with no usable digest also answers
     *   null: a grant that names no bytes is unbounded, and refusing to
     *   build one here means no caller can write one by accident.
     * Inputs: decision (string); digest (string|null).
     * Output: object|null.
     * Example: ThemeConsent.recordFor('never', null)
     *          // {decision: 'never'}
     */
    function recordFor(decision, digest) {
        if (decision === DECISION_NEVER) {
            // A refusal is about the theme, not about one version of its
            // script, so it carries no digest.
            return { decision: DECISION_NEVER };
        }
        if (decision === DECISION_ALWAYS) {
            if (typeof digest === 'string' && DIGEST_RE.test(digest)) {
                return { decision: DECISION_ALWAYS, digest: digest };
            }
            return null;
        }
        return null;
    }

    /**
     * Which themes moved INTO a refusal between two versions of the map.
     *
     * Description: what a client must tear down when another device
     *   commits a change. A theme that merely lost its grant is not in
     *   here: nothing is running that was not allowed, and it will be
     *   asked about next time it is applied.
     * Inputs: before (object|null); after (object|null).
     * Output: string[] - theme ids, sorted.
     * Example: ThemeConsent.revocationsBetween({}, {m: {decision: 'never'}})
     *          // ['m']
     */
    function revocationsBetween(before, after) {
        const prior = (before && typeof before === 'object') ? before : {};
        const current = (after && typeof after === 'object') ? after : {};
        const moved = [];
        Object.keys(current).forEach(function (id) {
            const entry = current[id];
            if (!entry || entry.decision !== DECISION_NEVER) return;
            const was = prior[id];
            if (was && was.decision === DECISION_NEVER) return;
            moved.push(id);
        });
        return moved.sort();
    }

    /**
     * Read the shared record, and say whether it could be read at all.
     *
     * Description: a read that did not happen is not a read of nothing.
     *   `readable` is false when the preference module is absent or its
     *   own hydration failed, and the ladder turns that into a refusal
     *   rather than into "no record, so ask" - asking would let a user
     *   re-grant something another device revoked while we were blind.
     *   The legacy per-browser key is folded in for its REFUSALS only;
     *   see this file's header.
     * Inputs: none.
     * Output: {map: object, readable: boolean}.
     * Example: ThemeConsent.readRecord().readable
     */
    function readRecord() {
        const legacy = readLegacyRefusals();
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.get !== 'function') {
            return { map: legacy, readable: false };
        }
        if (typeof prefs.status === 'function' && prefs.status() !== prefs.HYDRATED) {
            return { map: legacy, readable: false };
        }
        const shared = prefs.get(FIELD, null);
        const map = Object.create(null);
        Object.keys(legacy).forEach(function (id) { map[id] = legacy[id]; });
        if (shared && typeof shared === 'object') {
            Object.keys(shared).forEach(function (id) {
                const entry = shared[id];
                if (!entry || typeof entry !== 'object') return;
                // A local refusal is never overridden by a shared grant.
                // Deny wins in both directions and regardless of which
                // was written last, which is the property that makes
                // sharing a restriction safe in the first place.
                if (map[id] && map[id].decision === DECISION_NEVER) return;
                map[id] = entry;
            });
        }
        return { map: map, readable: true };
    }

    /**
     * The pre-#45 local allowlist, projected to refusals only.
     *
     * Inputs: none.
     * Output: object - theme id to `{decision: 'never'}`, possibly empty.
     */
    function readLegacyRefusals() {
        const out = Object.create(null);
        let raw;
        try {
            raw = globalThis.localStorage
                ? globalThis.localStorage.getItem(LEGACY_KEY) : null;
        } catch (err) {
            // Deliberately swallowed: storage can be disabled outright,
            // and a browser that cannot read its own legacy key still
            // has the shared record, which is the authority anyway.
            return out;
        }
        if (!raw) return out;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return out;
        }
        if (!parsed || typeof parsed !== 'object') return out;
        Object.keys(parsed).forEach(function (id) {
            // `true` is ignored on purpose - it names no digest, so there
            // is nothing for a grant to be bound to.
            if (parsed[id] === false) out[id] = { decision: DECISION_NEVER };
        });
        return out;
    }

    /**
     * The stored entry for one theme, or null.
     *
     * Inputs: themeId (string).
     * Output: object|null.
     */
    function entryFor(themeId) {
        const held = readRecord();
        if (!held.readable) return null;
        return held.map[themeId] || null;
    }

    /**
     * Persist one answered prompt into the shared record.
     *
     * Description: a partial update of ONE field, merged from the record
     *   this browser holds, so a decision about one theme never rewrites
     *   the answers for the others. A `once` writes nothing at all and
     *   says so, rather than being filtered out somewhere further down.
     * Inputs: themeId (string); decision (string); digest (string|null).
     * Output: Promise<{status: string}> - the preference layer's own
     *   status, or `{status: 'not_stored'}` for a decision that is never
     *   persisted, or `{status: 'refused'}` when there is nowhere to
     *   write.
     * Example: await ThemeConsent.remember('matrix', 'never', null);
     */
    async function remember(themeId, decision, digest) {
        const entry = recordFor(decision, digest);
        if (!entry) return { status: 'not_stored' };

        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.set !== 'function') {
            return { status: 'refused', detail: 'preferences are unavailable' };
        }
        const current = prefs.get(FIELD, null);
        const next = {};
        if (current && typeof current === 'object') {
            Object.keys(current).forEach(function (id) { next[id] = current[id]; });
        }
        next[themeId] = entry;
        return prefs.set(FIELD, next);
    }

    /** What the user is told when their "never" could not be written down. */
    const UNSAVED_REFUSAL_COPY = 'this theme\'s script is blocked for now, but '
        + 'the choice could not be saved. you will be asked again next time.';

    /**
     * Whether a `remember()` result means the record actually took it.
     *
     * Description: the shared record is the ONLY durable home for a
     *   decision, so anything short of a commit means the user's answer
     *   exists nowhere but this page. Said as a predicate rather than an
     *   inline comparison because "was it saved" is the question the
     *   honesty of the whole prompt turns on.
     * Inputs: outcome (object|null) - what `remember` returned.
     * Output: boolean.
     * Example: ThemeConsent.persisted({status: 'committed'}) // true
     */
    function persisted(outcome) {
        if (!outcome || typeof outcome.status !== 'string') return false;
        return PERSISTED_STATUSES.indexOf(outcome.status) !== -1;
    }

    /**
     * Tell the user something the gate could not do.
     *
     * Description: the COPY lives here beside the decision that produces
     *   it, so the sentence and the fact it describes cannot drift; the
     *   caller supplies only the channel. A caller that supplies none
     *   still gets the fact in the log, because a message nobody could
     *   deliver is not a reason to go back to saying nothing.
     * Inputs: spec (object) - the gateEffects spec, possibly carrying
     *   `notify`; message (string) - lowercase user-facing text;
     *   info (object) - context for the log, never for the user.
     * Output: undefined.
     */
    function report(spec, message, info) {
        console.warn('[ThemeConsent] ' + message, info);
        const notify = (spec && typeof spec.notify === 'function')
            ? spec.notify : null;
        if (!notify) return;
        try {
            notify(message, info);
        } catch (err) {
            // Deliberately swallowed: failing to SHOW the warning must not
            // turn a refusal that already held into a thrown error. The
            // script is blocked either way, and the line above recorded it.
            console.warn('[ThemeConsent] could not report to the user', err);
        }
    }

    /**
     * Run the whole gate for one manifest, executing only on `run`.
     *
     * Description: THE ONE ENTRY POINT, and the one a negative control
     *   drives. `inject` is called on exactly one path - the ladder, or
     *   the user's answer to a prompt, having resolved to `run`. Every
     *   other path returns without touching it. An `always` the server
     *   refused to store degrades to a one-sitting allowance rather than
     *   to silence: the user consented in front of us a moment ago,
     *   which is the strongest evidence there is, but nothing about that
     *   moment survives the page.
     * Inputs: spec (object) -
     *   manifest (object) - the theme manifest, carrying `effects`,
     *     `effectsDigest`, `source` and `id`.
     *   inject (function) - called with the manifest when, and only
     *     when, execution is permitted.
     *   prompt (function|undefined) - `(manifest, info) =>
     *     Promise<'always'|'once'|'never'|null>`. Absent means a prompt
     *     cannot be shown, which refuses.
     *   notify (function|undefined) - `(message, info) => void`, called
     *     with lowercase user-facing text when the gate held but could
     *     not record why. Absent logs instead; see `report`.
     * Output: Promise<string> - the outcome that was acted on.
     *
     * A REFUSAL THAT WAS NOT WRITTEN DOWN ANSWERS `skip_denied_unsaved`,
     * NEVER `skip_denied`. Both block the script, so this is not a hole in
     * the gate - it is the difference between a standing decision and one
     * that dies with the page, and the user is the only person who can act
     * on it. It shipped reporting `skip_denied` either way, so clicking
     * "never" on a theme the server's validator will not key on (a folder
     * name outside `THEME_ID_RE`) visibly took effect, was silently gone on
     * reload, and never reached another device.
     *
     * Example:
     *   await ThemeConsent.gateEffects({manifest: m, inject: run,
     *     prompt: ask, notify: tell});
     */
    async function gateEffects(spec) {
        const manifest = (spec && spec.manifest) || null;
        const inject = (spec && typeof spec.inject === 'function') ? spec.inject : null;
        const prompt = (spec && typeof spec.prompt === 'function') ? spec.prompt : null;
        if (!manifest || !inject) return SKIP_UNVERIFIABLE;

        const held = readRecord();
        const verdict = decide({
            declaresScript: !!manifest.effects,
            source: manifest.source,
            servedDigest: manifest.effectsDigest,
            record: held.map[manifest.id] || null,
            recordReadable: held.readable,
        });

        if (verdict.outcome === RUN) {
            inject(manifest);
            return RUN;
        }
        if (verdict.outcome !== PROMPT && verdict.outcome !== PROMPT_CHANGED) {
            if (verdict.outcome !== SKIP_NO_SCRIPT) {
                console.log('[ThemeConsent] effects skipped for ' + manifest.id
                    + ' (' + verdict.rung + ')');
            }
            return verdict.outcome;
        }
        if (!prompt) return SKIP_UNVERIFIABLE;

        let answer;
        try {
            answer = await prompt(manifest, {
                changed: verdict.outcome === PROMPT_CHANGED,
                digest: verdict.digest,
            });
        } catch (err) {
            // Deliberately swallowed and REFUSED: a prompt that failed
            // is a question the user never answered, and the whole point
            // of this gate is that silence is not a yes.
            console.warn('[ThemeConsent] prompt failed, refusing', err);
            return SKIP_UNVERIFIABLE;
        }

        if (answer === DECISION_NEVER) {
            const kept = await remember(manifest.id, DECISION_NEVER, null);
            if (!persisted(kept)) {
                report(spec, UNSAVED_REFUSAL_COPY, {
                    themeId: manifest.id,
                    status: (kept && kept.status) || 'unknown',
                    detail: (kept && kept.detail) || null,
                });
                return SKIP_DENIED_UNSAVED;
            }
            return SKIP_DENIED;
        }
        if (answer === DECISION_ONCE) {
            inject(manifest);
            return RUN;
        }
        if (answer !== DECISION_ALWAYS) {
            // A dismissed prompt, or anything unrecognised. Fail closed.
            return SKIP_UNVERIFIABLE;
        }

        const saved = await remember(manifest.id, DECISION_ALWAYS, verdict.digest);
        if (saved && saved.status === 'stale_revision') {
            // Another device committed first. Re-read and re-decide
            // rather than running on the answer we just gave: what it
            // committed may have been a refusal for this very theme.
            const again = readRecord();
            const second = decide({
                declaresScript: true,
                source: manifest.source,
                servedDigest: manifest.effectsDigest,
                record: again.map[manifest.id] || null,
                recordReadable: again.readable,
            });
            if (second.outcome !== RUN) return second.outcome;
        }
        inject(manifest);
        return RUN;
    }

    /**
     * Start listening for a refusal committed on another device.
     *
     * Description: subscribes to the preference layer's change events
     *   and tears down the effects of any theme that moved INTO a
     *   refusal. Idempotent - calling it twice subscribes once.
     * Inputs: none.
     * Output: boolean - whether a subscription is now in place.
     * Example: ThemeConsent.watch();
     */
    function watch() {
        if (watching) return true;
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.subscribe !== 'function') return false;
        lastSeen = snapshot();
        prefs.subscribe(function (name) {
            if (name !== FIELD) return;
            const now = snapshot();
            const revoked = revocationsBetween(lastSeen, now);
            lastSeen = now;
            if (!revoked.length) return;
            const themes = globalThis.Themes;
            if (!themes || typeof themes.revokeEffects !== 'function') return;
            revoked.forEach(function (id) {
                try {
                    themes.revokeEffects(id);
                } catch (err) {
                    // Deliberately swallowed per theme: one teardown
                    // throwing must not stop the others being torn down,
                    // and the refusal is already recorded either way.
                    console.warn('[ThemeConsent] teardown threw for ' + id, err);
                }
            });
        });
        watching = true;
        return true;
    }

    let watching = false;
    let lastSeen = Object.create(null);

    function snapshot() {
        const prefs = globalThis.Preferences;
        if (!prefs || typeof prefs.get !== 'function') return Object.create(null);
        const held = prefs.get(FIELD, null);
        return (held && typeof held === 'object') ? held : Object.create(null);
    }

    const api = {
        FIELD: FIELD,
        LEGACY_KEY: LEGACY_KEY,
        DECISION_ALWAYS: DECISION_ALWAYS,
        DECISION_NEVER: DECISION_NEVER,
        DECISION_ONCE: DECISION_ONCE,
        RUN: RUN,
        SKIP_NO_SCRIPT: SKIP_NO_SCRIPT,
        SKIP_DENIED: SKIP_DENIED,
        SKIP_DENIED_UNSAVED: SKIP_DENIED_UNSAVED,
        SKIP_UNVERIFIABLE: SKIP_UNVERIFIABLE,
        UNSAVED_REFUSAL_COPY: UNSAVED_REFUSAL_COPY,
        PROMPT: PROMPT,
        PROMPT_CHANGED: PROMPT_CHANGED,
        RUNG_DENIED: RUNG_DENIED,
        RUNG_RECORD_UNREADABLE: RUNG_RECORD_UNREADABLE,
        RUNG_BUILTIN: RUNG_BUILTIN,
        RUNG_DIGEST_UNAVAILABLE: RUNG_DIGEST_UNAVAILABLE,
        RUNG_DIGEST_MISMATCH: RUNG_DIGEST_MISMATCH,
        RUNG_GRANTED: RUNG_GRANTED,
        RUNG_NO_RECORD: RUNG_NO_RECORD,
        RUNG_NO_SCRIPT: RUNG_NO_SCRIPT,
        decide: decide,
        persisted: persisted,
        recordFor: recordFor,
        revocationsBetween: revocationsBetween,
        readRecord: readRecord,
        entryFor: entryFor,
        remember: remember,
        gateEffects: gateEffects,
        watch: watch,
    };

    // Published on globalThis rather than window by name so the same file
    // loads unchanged in a browser and under `node --test`, matching
    // client/js/preferences.js and client/js/status-led.js.
    globalThis.ThemeConsent = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    // Self-wiring rather than a call added to app.js: the subscription is
    // this module's own business, app.js is already past its line budget,
    // and a browser that loaded a partial page still gets a working gate
    // because `watch` refuses quietly when the preference layer is absent.
    watch();

    console.log('[ThemeConsent Module] Loaded');
})();
