/**
 * The canonical slug-to-session matcher, and nothing else.
 *
 * THE ONE PLACE THAT DECIDES whether a decoded deep-link slug refers to a
 * given running session, used by BOTH directions of the feature so they
 * can never drift:
 *   - OUTBOUND (build): `App._syncSessionUrl()` turns a live
 *     `tmux_session` into a URL slug with the same display rule.
 *   - INBOUND (resolve): this runs that rule over every candidate row and
 *     compares, exact first, then case-insensitively.
 *
 * SYMMETRIC WITH THE DISPLAY TITLE TOO, not only the slug. The outbound
 * URL this app builds always uses the tmux-derived slug - but a deep link
 * built some other way (a pasted title, a fork label copied from the
 * header: `<parent title>(fork)`, `src/core/session_fork.py`'s
 * `fork_label`) names the SAME session and must resolve to it. Both
 * `/sessions/attachable` and `/sessions/list` rows carry `label`, so once
 * the slug match misses, the title is checked against that field before
 * giving up.
 *
 * IT IS PURE, which is the point of it living here rather than in the
 * navigation glue: the four rungs are the part worth testing, and they
 * are testable with an array and a string.
 */
import { derivedDisplayName } from '../sessions/session-label';
import type { RunningSessionRow } from '../sessions/types';

/**
 * The running row a decoded deep-link target names, or null.
 *
 * Description: four rungs in order - slug exact, slug case-insensitive,
 *   label exact, label case-insensitive. Null means NO MATCH, which is a
 *   different thing from "the listing did not run"; the caller owns that
 *   distinction and must not infer it from here.
 * Inputs: rows - the merged running rows; target - decoded, validated
 *   name from the URL. Despite the name it may be a slug OR a title.
 * Output: the matching row, or null.
 * Example: findRunningSessionBySlug(rows, 'api-2');
 */
export function findRunningSessionBySlug(
    rows: readonly RunningSessionRow[] | null | undefined,
    target: string,
): RunningSessionRow | null {
    const all = rows || [];
    const wanted = String(target ?? '');
    const bySlug =
        all.find((row) => derivedDisplayName(row.name ?? null) === wanted) ||
        all.find(
            (row) =>
                (derivedDisplayName(row.name ?? null) || '').toLowerCase() ===
                wanted.toLowerCase(),
        );
    if (bySlug) return bySlug;

    const trimmed = wanted.trim();
    if (!trimmed) return null;
    const byLabel =
        all.find((row) => typeof row.label === 'string' && row.label.trim() === trimmed) ||
        all.find(
            (row) =>
                typeof row.label === 'string' &&
                row.label.trim().toLowerCase() === trimmed.toLowerCase(),
        );
    return byLabel || null;
}
