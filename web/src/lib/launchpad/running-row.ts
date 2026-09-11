/**
 * What one running-session card decides about itself, as pure data.
 *
 * EVERY DECISION ON THE CARD IS HERE AND NONE OF THEM IS IN A TEMPLATE.
 * The legacy `renderRunningSessions` interleaved eleven such decisions
 * with the markup that expressed them, which is why "does a detached row
 * get a pencil" could only be answered by reading a 220-line string
 * builder. Each one is a named function with a named outcome type, and
 * `./running-row.test.ts` drives them without a document.
 *
 * NO COPY, ONLY KEYS. Every user-visible sentence is a catalog key from
 * `client/js/labels/running-session.js`; the component resolves them.
 * That is what lets the pseudo-locale coverage guard see this file.
 *
 * THE PENCIL'S TWO REFUSAL STATES ARE REACHABLE ONLY FOR A ROW WITH NO
 * NAME AT ALL, and that is a measurement rather than a design. Every row
 * the merge produces carries a tmux `name`, so on a healthy screen every
 * pencil is live; the refusals survive because a row that cannot be
 * addressed must still DRAW the control and say why, and because the
 * sidebar's own predicate answers the same three states for the same
 * fields. See ./running-row.test.ts, which drives all three.
 *
 * THREE OUTCOMES, THREE TIMES OVER, AND NONE OF THEM COLLAPSES INTO TWO.
 * The rename pencil, the ownership flag and the startup gate are each a
 * measured yes, a measured no, and a CANNOT DETERMINE that is a real
 * answer rather than a missing one. `== null` is used deliberately where
 * a null must be told apart from a false; `!value` would fold the two.
 */
import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
import type { RunningSessionRow } from '../sessions/types';

/** The three states the rename pencil can be in. It is never absent. */
export type RenameState = 'renameable' | 'unavailable' | 'unknown_owner';

/** What the pencil renders, in whichever of its three states applies. */
export interface RenamePencilView {
    state: RenameState;
    /**
     * The handle the editor is opened against, or null when it cannot be
     * opened. Only the `renameable` state carries one, which is what
     * keeps the other two out of the click path by construction.
     */
    renameKey: string | null;
    /** The catalog key for `title` and `aria-label`. Always present. */
    reasonKey: string;
    /** The class the stylesheet targets. Two classes, three states. */
    className: string;
}

/**
 * Which of the three rename states this row is in.
 *
 * Description: A TMUX NAME IS ENOUGH. This used to require `session_id`,
 *   which the manager only holds for an OPEN session, so every row the
 *   app had not adopted drew a dead pencil - including a user's own
 *   running sessions, all of them at once after a restart. Rename is
 *   out-of-band now: it keys the row by tmux name and addresses the
 *   conversation by claude uuid, and needs neither the session open nor
 *   the pane touched.
 *
 *   THE CONTROL IS NEVER OMITTED. An absent affordance is
 *   indistinguishable from a broken one - the user cannot tell "you may
 *   not do this" from "this app forgot to draw the button" - so the two
 *   states that cannot act say why, in `title` AND `aria-label`.
 *
 *   `created_by_cloude == null` catches null and undefined and nothing
 *   else, deliberately. `!row.created_by_cloude` would fold a genuine
 *   unknown into "external" and invent an answer; `server_status.py`
 *   fills that field with `ownership_by_name.get(name)`, which yields
 *   None for a name the ownership map never answered for.
 * Inputs: row - a running-session row.
 * Output: RenamePencilView.
 * Example: renamePencilView({name: 'cloude_api', created_by_cloude: true})
 *   // {state: 'renameable', renameKey: 'cloude_api', ...}
 */
export function renamePencilView(row: RunningSessionRow): RenamePencilView {
    // TWO HANDLES, NOT THREE, AND THE MISSING ONE COULD NEVER FIRE. The
    // legacy chain read `session_id || tmux_session || name`, and the
    // middle rung has never had a value on this surface: the merge in
    // ./../sessions/running.ts builds every row from an
    // `AttachableSession`, which carries `name` and no `tmux_session`,
    // and the live-only branch sets `name` from the tmux name too. A rung
    // that has never been observed to fire is unmeasured, not proven, and
    // this one is provably unreachable - it is dropped rather than carried
    // forward looking like a fallback somebody relies on.
    //
    // `session_id` is only populated by the `/sessions/list` merge and
    // therefore really means "this session is open right now"; `name` is
    // the tmux handle every row has. That second rung is what made the
    // pencil follow the NAME rather than the open state.
    const renameKey = row.session_id || row.name || null;
    if (renameKey) {
        return {
            state: 'renameable',
            renameKey,
            reasonKey: RUNNING_SESSION_KEYS.renameAction,
            className: 'running-session-rename',
        };
    }
    if (row.created_by_cloude == null) {
        return {
            state: 'unknown_owner',
            renameKey: null,
            reasonKey: RUNNING_SESSION_KEYS.renameUnknownOwner,
            className: 'running-session-rename-unavailable',
        };
    }
    return {
        state: 'unavailable',
        renameKey: null,
        reasonKey: row.created_by_cloude
            ? RUNNING_SESSION_KEYS.renameUnopened
            : RUNNING_SESSION_KEYS.renameUnadopted,
        className: 'running-session-rename-unavailable',
    };
}

/**
 * The durable row id for the bottom-right badge, or null.
 *
 * Description: RENDERS NOTHING WHEN THERE IS NO ID, and that is
 *   deliberate. An EXTERNAL tmux session the app never created genuinely
 *   has no row; printing `#?` or `#0` there would invent an identity for
 *   a session we have no record of, which is worse than a blank corner.
 *   Zero is NOT treated as absent - a row id of 0 is a row id.
 * Inputs: row - a running-session row.
 * Output: string | null - the id as text.
 * Example: sessionRowId({session_row_id: 7})  // '7'
 */
export function sessionRowId(row: RunningSessionRow): string | null {
    const id = row.session_row_id;
    // ZERO IS NOT ABSENT. `== null` would be shorter and would also fold
    // a row id of 0 into "no id", which is a row this app really can mint.
    if (id === null || id === undefined || (id as unknown) === '') return null;
    return String(id);
}

/**
 * Whether this row offers the fork control.
 *
 * Description: OWNED SESSIONS ONLY. An external tmux session has no row
 *   of ours and therefore no recorded conversation to copy, and the
 *   server refuses the request with a 409. Offering a control that is
 *   going to be refused is worse than not offering it, because the
 *   refusal arrives after the click.
 * Inputs: row. Output: boolean.
 * Example: offersFork({created_by_cloude: false})  // false
 */
export function offersFork(row: RunningSessionRow): boolean {
    return !!row.created_by_cloude;
}

/** What the launch-wrapper pill renders, or null for no pill at all. */
export interface WrapperPillView {
    /** The label the user typed into settings. Never the internal id. */
    label: string;
}

/**
 * The launch-wrapper pill for one row, or null.
 *
 * Description: WHICH claude, which the family pill beside it cannot
 *   answer - a session started through `claude (chrome)` and one started
 *   through `claude` render the identical family pill, because they are
 *   the identical family.
 *
 *   NOTHING IS RENDERED WHEN NO WRAPPER CAN BE NAMED, and that is the
 *   OPPOSITE of the family pill's rule rather than an inconsistency. The
 *   family pill must say "unknown family" out loud because "what is
 *   running here" always has an answer and failing to know it is
 *   information. "Which wrapper" does not always have one: a session
 *   launched as a bare shell was launched through no wrapper at all, and
 *   a pill reading "unknown wrapper" would report a gap where there is
 *   none. The family pill standing beside it is what tells the two
 *   apart.
 *
 *   A NON-STRING RENDERS NOTHING rather than `[object Object]`.
 * Inputs: label - `agent_wrapper_label` off the wrapper level.
 * Output: WrapperPillView | null.
 * Example: wrapperPillView('claude (chrome)')  // {label: 'claude (chrome)'}
 */
export function wrapperPillView(
    label: string | null | undefined,
): WrapperPillView | null {
    if (typeof label !== 'string') return null;
    const text = label.trim();
    if (!text) return null;
    return { label: text };
}

/** What the per-session theme cue renders, or null for an unthemed row. */
export interface ThemeCueView {
    /** The id, reduced to what is safe in an attribute value. */
    themeId: string;
    /** An `rgb(...)` string from the theme manifest's accent. */
    accent: string;
    /** The manifest's display name, or the id when it has none. */
    name: string;
}

/** The shape `SessionThemeTint.colorsFor` answers with. */
export interface ThemeColors {
    accent: string;
    label: string;
}

/**
 * The theme cue for one row, or null for all three not-themed cases.
 *
 * Description: the COLOURS come from `client/js/session-theme-tint.js`,
 *   which stays legacy because the sidebar row draws the same cue from
 *   it. Only its DATA half is consumed here (`colorsFor`), never its
 *   markup half, so there is one source for what a theme looks like and
 *   two renderers for it - the same arrangement the glyphs have.
 *
 *   AN UNKNOWN ID IS NOT CACHED BY THAT MODULE, on purpose: the theme
 *   registry fills in asynchronously, so "unknown right now" has to stay
 *   askable on the next paint. This function inherits that, which is why
 *   it takes the lookup as an argument rather than memoizing anything.
 *
 *   THE ID IS SCRUBBED TO `[A-Za-z0-9_-]`. Svelte escapes attribute
 *   values, so this is not an injection guard; it is what keeps the
 *   attribute a stylesheet can select on, and an id that survives as
 *   empty yields an untinted row rather than a partial one.
 * Inputs: themeId - the row's `pinned_theme`. colorsFor - the lookup.
 * Output: ThemeCueView | null.
 * Example: themeCueView('dracula', lookup)
 */
export function themeCueView(
    themeId: string | null | undefined,
    colorsFor: (id: string) => ThemeColors | null,
): ThemeCueView | null {
    if (!themeId) return null;
    const safeId = String(themeId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;
    const colors = colorsFor(themeId);
    if (!colors || !colors.accent) return null;
    return {
        themeId: safeId,
        accent: colors.accent,
        name: colors.label || String(themeId),
    };
}

/**
 * Whether this row is blocked at a startup prompt.
 *
 * Description: THE SIGNAL IS THE ABSENCE OF A HOOK, measured server-side;
 *   this only decides whether to paint it. A STRICT equality against the
 *   one measured value, never a truthiness test: `!!row.startup_gate`
 *   would be true for `unknown` and for `ready` alike, and `unknown`
 *   means the probe did not answer. Only a measured block paints.
 * Inputs: gate - the raw `startup_gate` off the WRAPPER level.
 * Output: boolean.
 * Example: awaitingStartup('unknown')  // false
 */
export function awaitingStartup(gate: string | null | undefined): boolean {
    return gate === 'awaiting_startup_prompt';
}
