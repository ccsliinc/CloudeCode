/**
 * Per-device UI preferences, as runes, on the keys they already use.
 *
 * WHY THE KEYS ARE BYTE-IDENTICAL TO THE LEGACY ONES. Every value here
 * is already on a real user's machine under a name `client/js/launchpad.js`
 * chose. Renaming one does not migrate it, it SILENTLY RESETS it: the
 * read misses, the default wins, and the user's screen changes on the
 * upgrade with nothing to explain it. So the identifiers stay exactly as
 * they were even where the copy beside them has moved on - the archive
 * filter's key still says `deletedSessionsVisible` because that is what
 * is written on disk today, and only the sentence a person reads says
 * archive. Same precedent as the element ids.
 *
 * A THROWING READ OR WRITE IS NOT AN ERROR THE USER NEEDS TO SEE. A
 * private window, blocked site data or a browser set to refuse storage
 * all make `localStorage` throw on ACCESS, not merely return null. The
 * preference still works for this page load; it simply will not be
 * remembered, and a toast about that is noise. Every access is therefore
 * wrapped, and the failure is logged rather than swallowed.
 *
 * NOTHING IS READ AT IMPORT TIME, AND THAT IS NOT TIDINESS. The bundle's
 * own contract (see web/src/main.ts) is that LOADING it does no work:
 * it publishes one namespace and returns. A module-load `localStorage`
 * read breaks that, and it broke it loudly - the first draft read the
 * preference at import and `tests/test_session_row_menu_superset.node.mjs`
 * started failing, in a file that has nothing to do with this section. It
 * loads `client/dist/app.js` into a `vm` sandbox where `localStorage` is
 * absent and `console` carries no `warn`, so the read threw, the catch
 * reached for a function that did not exist, and the whole bundle failed
 * to evaluate. A side effect at import is a side effect every consumer
 * pays for, including the ones that only wanted the module to exist. So
 * the first ACCESS resolves it instead.
 *
 * THE RUNE IS THE SOURCE OF TRUTH FOR THE PAINT, localStorage is the
 * source of truth for the NEXT page load. They are written together and
 * the rune is never read back from storage after boot, so a second tab
 * changing the key cannot silently repaint this one mid-session - which
 * is the behaviour the legacy per-device preferences already had.
 */

/**
 * Is there a `console.warn` to reach for at all?
 *
 * Description: the second half of the incident in this file's header. A
 *   `vm` sandbox may publish a PARTIAL console, and reaching for a method
 *   that is not there turns a swallowed storage failure into a thrown
 *   TypeError - a diagnostic that takes down the thing it was reporting
 *   on.
 *
 *   IT IS A PREDICATE AND NOT A `warn()` WRAPPER, and that is because of
 *   a guard rather than a preference. `web/src/lib/i18n/coverage.test.ts`
 *   refuses a sentence-shaped literal in a ported file, and it recognises
 *   a developer diagnostic by the literal text `console.` in front of it.
 *   A wrapper hides that, so the two messages below read as user copy and
 *   the build fails - which it duly did. The guard is right: anything it
 *   cannot see is a diagnostic is a candidate for the catalog. So the
 *   call sites stay literal and only the test moves out.
 * Inputs: none.
 * Output: boolean.
 * Example: if (canWarn()) console.warn('...', err);
 */
function canWarn(): boolean {
    return typeof console !== 'undefined' && typeof console.warn === 'function';
}

/** The archive filter's durable key. Says `deleted` for the reason above. */
export const ARCHIVED_SESSIONS_VISIBLE_KEY = 'cloude.launchpad.deletedSessionsVisible';

/**
 * Read one boolean preference, defaulting OFF on anything unexpected.
 *
 * Description: only the exact string `'1'` reads as on, which is the
 *   legacy encoding. Anything else - absent, `'0'`, a value some other
 *   version wrote - is off, so a corrupt entry degrades to the default
 *   rather than to a coin flip.
 * Inputs: key - the localStorage key.
 * Output: boolean.
 * Example: readFlag(ARCHIVED_SESSIONS_VISIBLE_KEY)  // false
 */
export function readFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === '1';
    } catch (err) {
        if (canWarn()) console.warn('CloudeWeb: failed to read the preference', key, err);
        return false;
    }
}

/**
 * Persist one boolean preference in the legacy encoding.
 *
 * Inputs: key - the localStorage key. on - the new state.
 * Output: void. A throwing write is logged, never surfaced.
 * Example: writeFlag(ARCHIVED_SESSIONS_VISIBLE_KEY, true)
 */
export function writeFlag(key: string, on: boolean): void {
    try {
        localStorage.setItem(key, on ? '1' : '0');
    } catch (err) {
        if (canWarn()) console.warn('CloudeWeb: failed to persist the preference', key, err);
    }
}

/**
 * The archive filter. `null` until something has asked for it.
 *
 * The tri-state is what makes the read lazy without a second flag:
 * `null` means unresolved, and only a real boolean is a resolved answer.
 */
let archivedSessionsVisible = $state<boolean | null>(null);

/**
 * Resolve the archive filter on first access, then hold it.
 *
 * Description: this is where the legacy constructor's one-time read
 *   happens now. Once resolved the value is never re-read from storage,
 *   so a second tab changing the key cannot silently repaint this one
 *   mid-session - which is the behaviour the legacy per-device
 *   preferences already had.
 * Inputs: none. Output: boolean.
 * Example: resolveArchivedSessionsVisible()  // false
 */
function resolveArchivedSessionsVisible(): boolean {
    if (archivedSessionsVisible === null) {
        archivedSessionsVisible = readFlag(ARCHIVED_SESSIONS_VISIBLE_KEY);
    }
    return archivedSessionsVisible;
}

/**
 * The launchpad's per-device UI preferences.
 *
 * Description: exported as an OBJECT WITH ACCESSORS, not as the rune
 *   itself. A `$state` exported by value is read once at import and never
 *   again, so every consumer would hold a dead copy of the boolean; a
 *   getter re-reads it inside the caller's own effect and stays reactive
 *   across the module boundary.
 * Example: if (uiPrefs.archivedSessionsVisible) { ... }
 */
export const uiPrefs = {
    /** Whether archived session records are asked for and drawn. */
    get archivedSessionsVisible(): boolean {
        return resolveArchivedSessionsVisible();
    },

    /**
     * Set the archive filter, in memory and on disk together.
     *
     * Inputs: on - the new state.
     * Output: void.
     * Example: uiPrefs.setArchivedSessionsVisible(true)
     */
    setArchivedSessionsVisible(on: boolean): void {
        archivedSessionsVisible = !!on;
        writeFlag(ARCHIVED_SESSIONS_VISIBLE_KEY, archivedSessionsVisible);
    },

    /**
     * Re-read every preference from storage.
     *
     * Description: for a test that wrote the key directly, and for a
     *   caller that knows storage changed under it. Not called on a
     *   timer: a preference that repainted itself mid-session would be a
     *   behaviour the legacy code did not have.
     * Inputs: none. Output: void.
     * Example: uiPrefs.reload()
     */
    reload(): void {
        archivedSessionsVisible = readFlag(ARCHIVED_SESSIONS_VISIBLE_KEY);
    },

    /**
     * Forget every resolved value, so the next access re-reads storage.
     *
     * Description: for a test that needs the lazy read to happen again.
     *   Distinct from `reload()`, which reads NOW; this one reads on the
     *   next access, which is the state the module actually boots in.
     * Inputs: none. Output: void.
     * Example: uiPrefs.resetForTests()
     */
    resetForTests(): void {
        archivedSessionsVisible = null;
    },
};
