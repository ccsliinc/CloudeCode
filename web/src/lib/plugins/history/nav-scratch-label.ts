/**
 * WHAT A THROWAWAY DIRECTORY IS CALLED ON A 49px CARD.
 *
 * THE SERVER MEASURED A NAMELESSNESS, NOT A FAILURE. `scratch_path` is
 * the cwd rung saying it read the working directory the transcripts
 * recorded and found a per-run temp directory: `/private/tmp`,
 * `/private/var/folders/...`, `/tmp`. 17 of this install's 98 archive
 * projects are exactly that. They are not projects, they were never
 * meant to be, and the server refuses to invent a name for one - which
 * is correct, and leaves the client holding the presentation question.
 *
 * THE PATH ITSELF IS NOT AN ANSWER. The longest of the 17 is 178
 * characters; the rail gives the name about 200px at 320px wide, so
 * every one of them ellipsises to a prefix that reads
 * `/private/tmp/claude-501/-Users-jsugamele-Library-Mobile-Docu...`.
 * Seventeen cards of that is noise sitting where the reader's scan
 * target goes, and worse, they all begin with the same 40 characters,
 * so the one field that could tell them apart is the half that gets cut.
 *
 * SO THE LABEL IS COMPOSED THE SAME WAY THE DERIVED NAMES ARE:
 * `<qualifier> / <leaf>`. `scratch / renametest`,
 * `scratch / cc_rht_work_ko0irget`. The qualifier is a fixed word, not
 * a lookup, and it is the first thing read - so the row says "throwaway"
 * before it says anything else. The leaf is the last component of the
 * MEASURED cwd, carried verbatim, and it is the only part that differs
 * between the 17.
 *
 * THIS IS NOT A NAME AND MUST NEVER BE COUNTED AS ONE. `AppName.named`
 * stays false for a scratch row, `data-app-named` is not written, and
 * `Presentation.fromApp` stays false. Nothing here claims the app
 * database said anything; it labels a measured temp directory as a
 * temp directory. A future reader looking for "how many projects are
 * named" must still get the same number it got before this file
 * existed.
 *
 * THE FULL PATH STAYS REACHABLE, which is the whole licence for
 * shortening it. It is on the card's own hover sentence and in the
 * details modal's `Full path` field, which now falls back to
 * `app_name_cwd` because the archive's own `observed_cwd` is null for
 * 100 of 100 projects on this install.
 *
 * Pure data. No DOM, no fetch, no state.
 */

/** The fixed first half of a scratch label. Lowercase, like all UI copy. */
export const SCRATCH_QUALIFIER = 'scratch';

/** What sits between the qualifier and the leaf. Matches a derived name. */
export const SCRATCH_SEPARATOR = ' / ';

/**
 * The last real component of a path, or null.
 *
 * Description: trailing slashes are dropped first, so `/private/tmp/`
 *   and `/private/tmp` answer the same thing. A path that is nothing
 *   but separators has no leaf and says so rather than answering with
 *   an empty string, because an empty string would compose a label
 *   ending in a bare separator.
 * Inputs: cwd (unknown) - whatever arrived in `app_name_cwd`.
 * Output: string | null - the leaf, or null when there is not one.
 * Example: scratchLeaf('/private/var/folders/p6/T/cc_rht_work_ko0irget')
 *   // -> 'cc_rht_work_ko0irget'
 * Example: scratchLeaf('/')   // -> null
 */
export function scratchLeaf(cwd: unknown): string | null {
    if (typeof cwd !== 'string') return null;
    const parts = cwd.split('/').filter((part) => part !== '');
    // `noUncheckedIndexedAccess` types this as possibly undefined even
    // after the length guard, and the guard is kept anyway: it says the
    // intent, and the coalesce is what satisfies the compiler.
    const leaf = (parts[parts.length - 1] ?? '').trim();
    return leaf ? leaf : null;
}

/**
 * The label a scratch row shows on its face.
 *
 * Description: the leaf is a DISAMBIGUATOR, not a name, so the label
 *   degrades to the bare qualifier rather than to the path when there
 *   is no leaf to add. `/private/tmp` has a leaf of `tmp`, which is
 *   thin but true and is what that directory is actually called.
 * Inputs: cwd (unknown) - the measured working directory, or null.
 * Output: string - never empty, so a card can never paint a blank label.
 * Example: scratchLabel('/private/tmp/permtest-45244')
 *   // -> 'scratch / permtest-45244'
 * Example: scratchLabel(null)   // -> 'scratch'
 */
export function scratchLabel(cwd: unknown): string {
    const leaf = scratchLeaf(cwd);
    return leaf === null
        ? SCRATCH_QUALIFIER
        : `${SCRATCH_QUALIFIER}${SCRATCH_SEPARATOR}${leaf}`;
}
