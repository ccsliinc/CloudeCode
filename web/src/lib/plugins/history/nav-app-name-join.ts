/**
 * CARRY THE APP DATABASE'S NAME FIELDS ONTO THE ROWS THE RAIL ACTUALLY
 * RENDERS, BECAUSE THE TWO ROUTES THAT FEED IT DO NOT CARRY THEM.
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED RATHER THAN READ. Three routes
 * return project nodes and only ONE of them is decorated with the app
 * database's name. Measured in-process against the live databases on
 * 2026-09-19, 100 nodes each:
 *
 *   GET /archive/projects                 100 of 100 carry
 *                                         `app_name_source`, 81 carry a
 *                                         real `app_display_name`.
 *                                         CALLED BY NO VIEW.
 *   GET /archive/overlay/projects           0 of 100 carry either.
 *                                         This is the MERGED view, the
 *                                         default and the only one
 *                                         reachable by clicking.
 *   GET /archive/corpora/{id}/projects      0 of 100 carry either.
 *                                         This is the by-machine view's
 *                                         project level.
 *
 * `src/api/archive_routes.py` calls `_name_projects` on the first and
 * on neither of the others. So `appNameFor` was answering ABSENT for
 * every row on every screen - correctly, because `app_name_source` was
 * null - and `presentationFor` fell through to the slug exactly as it
 * is designed to. THE RAIL WAS NEVER WRONG. The field never arrived.
 *
 * WHY THIS IS A CLIENT-SIDE JOIN AND NOT A SERVER FIX. The server fix
 * is one line on each of those two routes and is plainly the better
 * one; it was out of scope for the change this file shipped in. When it
 * lands, THIS MODULE BECOMES A NO-OP BY CONSTRUCTION rather than a
 * competing answer - see `SKIPS A ROW THE SERVER ALREADY DECORATED`
 * below, which is the whole reason it is safe to have both.
 *
 * THERE IS STILL EXACTLY ONE RESOLVER. `nav-app-name.ts` decides what a
 * name is and which of the eight `app_name_source` values may draw one.
 * Nothing here judges a name, reads a source, or renders anything: it
 * moves seven fields from one row onto another and stops. The refusals
 * are untouched because the refusals are not here.
 *
 * THE KEY IS `project_id`, AND IT WAS MEASURED BEFORE IT WAS CHOSEN.
 * Over the live corpus it is unique in all three listings (100 of 100)
 * and intersects the decorated listing 100 of 100. `full_path` is the
 * obvious alternative and is WORSE: the per-corpus rows carry it as
 * null and put the slug on `slug` instead, so a `full_path` join would
 * silently name nothing in the by-machine view while looking correct in
 * the merged one - which is the exact shape of failure this whole area
 * keeps producing.
 *
 * A DUPLICATE KEY IS DROPPED, NOT PICKED BETWEEN. Two decorated rows
 * under one `project_id` means the index cannot say which name belongs
 * to that row, so the key is removed from the index entirely and the
 * row keeps its path. A join that guessed would put a real, confident,
 * WRONG project name on a card, which is worse than the slug it
 * replaced.
 *
 * AND A LISTING THAT DID NOT RUN IS NOT A LISTING OF NOTHING. `complete`
 * is true only when a decorated envelope actually produced a row array.
 * A refusal, a transport error, a grant refusal or a body that is not a
 * list all yield an index that is not complete, and `joinAppNames` then
 * returns its input UNCHANGED - which is the pre-feature behaviour, the
 * slug, and is honest. Same discipline as `StatusMap.complete` and
 * `InstanceIndex.complete` on the Python side, and the same sentence
 * underneath it.
 *
 * Pure data. No DOM, no fetch, no state.
 */
import type { EnvelopeResult } from '../types';
import type { NavRowData } from './nav-row';
import {
    APP_DESCRIPTION_FIELD, APP_NAME_ANCHOR_FIELD, APP_NAME_CWD_FIELD,
    APP_NAME_EVIDENCE_FIELD, APP_NAME_FIELD, APP_NAME_SOURCE_FIELD,
    APP_PROJECT_ID_FIELD,
} from './nav-app-name';

/**
 * The row property both listings are joined on. Measured unique across
 * all three project surfaces on the live corpus; see the header for why
 * `full_path` is not it.
 */
export const APP_NAME_JOIN_KEY = 'project_id';

/**
 * EVERY FIELD THAT MOVES, AND NO OTHERS. Imported from `nav-app-name.ts`
 * rather than spelled again, so the set the resolver READS and the set
 * this module CARRIES cannot drift apart. A field added there and not
 * here would arrive on the decorated route and never reach the rail,
 * which is the bug this module was written to fix, reintroduced one
 * field at a time.
 */
export const APP_NAME_FIELDS: readonly string[] = Object.freeze([
    APP_NAME_FIELD,
    APP_NAME_SOURCE_FIELD,
    APP_DESCRIPTION_FIELD,
    APP_PROJECT_ID_FIELD,
    APP_NAME_EVIDENCE_FIELD,
    APP_NAME_CWD_FIELD,
    APP_NAME_ANCHOR_FIELD,
]);

/** The app-name fields of one decorated row, keyed for transfer. */
export type AppNamePatch = Readonly<Record<string, unknown>>;

/** What a decorated listing yielded, and whether it yielded anything. */
export interface AppNameIndex {
    /** `project_id` as a string, to the fields that row carried. */
    readonly patches: ReadonlyMap<string, AppNamePatch>;
    /**
     * True ONLY when a decorated listing actually produced a row array.
     * A real answer of zero rows is complete; a refusal is not. A caller
     * must not treat an incomplete index as "nothing matched".
     */
    readonly complete: boolean;
    /**
     * Keys seen more than once and therefore REMOVED from `patches`.
     * Kept so a caller can say how many rows went unnamed for a reason
     * that is not "the server had no name for them".
     */
    readonly duplicates: readonly string[];
}

/** The index a caller holds before it has asked for one, or after a refusal. */
export function emptyAppNameIndex(): AppNameIndex {
    return { patches: new Map(), complete: false, duplicates: [] };
}

/** The rows off an envelope result, or null when there is no row array. */
function rowsOf(result: EnvelopeResult | null | undefined): readonly unknown[] | null {
    if (!result || result.transportError || result.refusedByGrant) return null;
    const env = result.envelope;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    const rows = (env as Record<string, unknown>).result;
    return Array.isArray(rows) ? rows : null;
}

/** One row's join key as a string, or null when it has no usable one. */
function keyOf(row: unknown): string | null {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const id = (row as Record<string, unknown>)[APP_NAME_JOIN_KEY];
    if (typeof id === 'number' && isFinite(id)) return String(id);
    return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Build the join index from a decorated project listing.
 *
 * Description: reads `GET /archive/projects`, which is the one route
 *   that carries the app database's names. A row with no usable
 *   `project_id` is skipped; a key seen twice is REMOVED rather than
 *   resolved, because two names under one id is an unanswerable
 *   question and a card wearing the wrong project's name is worse than
 *   one wearing its path.
 *
 *   A ROW CARRYING NO `app_name_source` STILL ENTERS THE INDEX, with an
 *   empty patch. It is a measured "this route said nothing about this
 *   project", and it must not be confused with the route not having
 *   been read. `joinAppNames` writes nothing for an empty patch, so the
 *   target row is left exactly as it arrived.
 * Inputs: result (EnvelopeResult | null) - what the decorated route
 *   returned, transport failures and grant refusals included.
 * Output: AppNameIndex - `complete` false whenever no row array was
 *   produced, which is the caller's signal to change nothing.
 * Example: buildAppNameIndex(await client.listArchiveNamedProjects())
 */
export function buildAppNameIndex(
    result: EnvelopeResult | null | undefined,
): AppNameIndex {
    const rows = rowsOf(result);
    if (rows === null) return emptyAppNameIndex();

    const patches = new Map<string, AppNamePatch>();
    const duplicates: string[] = [];
    for (const row of rows) {
        const key = keyOf(row);
        if (key === null) continue;
        if (patches.has(key) || duplicates.indexOf(key) !== -1) {
            // Seen twice: the index cannot answer for this key at all.
            patches.delete(key);
            if (duplicates.indexOf(key) === -1) duplicates.push(key);
            continue;
        }
        const src = row as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const field of APP_NAME_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(src, field)) {
                patch[field] = src[field];
            }
        }
        patches.set(key, Object.freeze(patch));
    }
    return { patches, complete: true, duplicates: Object.freeze(duplicates) };
}

/**
 * Carry the indexed app-name fields onto one listing's rows.
 *
 * Description: THREE RULES, AND EACH ONE IS A REFUSAL.
 *
 *   AN INCOMPLETE INDEX CHANGES NOTHING. The decorated route refused,
 *   timed out or answered with something that is not a list, so this
 *   returns its input by reference. The rail then draws what it drew
 *   before this feature existed: the path.
 *
 *   IT SKIPS A ROW THE SERVER ALREADY DECORATED. A row that arrives
 *   carrying `app_name_source` has been answered by the server itself,
 *   and the server outranks a join performed in a browser. This is what
 *   makes the module a no-op the day `/archive/overlay/projects` starts
 *   decorating, rather than a second opinion that can disagree with the
 *   first - and it is why there is still one source of truth for a
 *   project's name.
 *
 *   A KEY WITH NO PATCH LEAVES ITS ROW ALONE. Not "no name": no
 *   statement. `appNameFor` then reads a null source and returns ABSENT,
 *   exactly as it does today.
 *
 *   Nothing is mutated. A row that gains fields is a NEW object, so a
 *   caller holding the original listing still holds the bytes the server
 *   sent.
 * Inputs: rows (readonly NavRowData[] | null) - the listing to decorate.
 *   index (AppNameIndex) - from `buildAppNameIndex`.
 * Output: the decorated rows, or the input array itself when no row
 *   changed.
 * Example: applyAppNames(nodes, index)[0].app_display_name  // 'Media'
 */
export function applyAppNames(
    rows: readonly NavRowData[] | null | undefined,
    index: AppNameIndex | null | undefined,
): readonly NavRowData[] {
    const list = Array.isArray(rows) ? rows : [];
    if (!index || !index.complete || index.patches.size === 0) return list;

    let changed = false;
    const out = list.map((row) => {
        if (!row || typeof row !== 'object') return row;
        const src = row as Record<string, unknown>;
        // The server already answered for this row. It outranks us.
        if (Object.prototype.hasOwnProperty.call(src, APP_NAME_SOURCE_FIELD)
            && src[APP_NAME_SOURCE_FIELD] !== null
            && src[APP_NAME_SOURCE_FIELD] !== undefined) {
            return row;
        }
        const key = keyOf(row);
        if (key === null) return row;
        const patch = index.patches.get(key);
        if (!patch) return row;
        const keys = Object.keys(patch);
        if (keys.length === 0) return row;
        changed = true;
        return { ...src, ...patch } as unknown as NavRowData;
    });
    return changed ? out : list;
}

/**
 * Apply the index to a whole envelope result, preserving its shape.
 *
 * Description: the seam the client calls, so a caller of
 *   `listArchiveMergedProjects` keeps receiving an `EnvelopeResult` and
 *   nothing downstream learns that two requests were made. The status,
 *   the headers, the transport error, the grant flag and every other
 *   key of the envelope - `meta`, `result_status`, the unattributed
 *   counts - are carried through untouched; only `result` is rebuilt,
 *   and only when a row actually changed.
 * Inputs: result (EnvelopeResult) - the listing to decorate.
 *   index (AppNameIndex) - from `buildAppNameIndex`.
 * Output: EnvelopeResult - the same object when nothing changed.
 * Example: joinAppNames(await client.listArchiveMergedProjects(), index)
 */
export function joinAppNames(
    result: EnvelopeResult,
    index: AppNameIndex | null | undefined,
): EnvelopeResult {
    const rows = rowsOf(result);
    if (rows === null) return result;
    const next = applyAppNames(rows as readonly NavRowData[], index);
    if (next === rows) return result;
    const env = result.envelope as Record<string, unknown>;
    return { ...result, envelope: { ...env, result: next } };
}
