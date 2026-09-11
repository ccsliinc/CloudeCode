/**
 * The string a HUMAN should see for one session, in this tree.
 *
 * A SESSION'S NAME IS A LABEL. It is free-form - spaces, punctuation,
 * mixed case - and it lives on the row as `sessions.title`, arriving here
 * as `label`. The tmux session name is an internal handle derived from
 * that label once, at creation, and never moved again. Keeping them
 * separate is what stops a rename from moving the field session identity
 * is keyed on, which used to split one session into two rows.
 *
 * DELEGATED, NOT DUPLICATED. `client/js/session-label.js` holds the
 * fallback chain and is read by the sidebar row, the tab title, the
 * in-page header, a toast card and the attribution prompt. Slice 5 makes
 * this tree a sixth caller rather than a second answer: the tab title and
 * the home card disagreeing about what a session is called is a bug this
 * app has already shipped once.
 *
 * THE MODULE IS REACHED AT CALL TIME, NOT AT IMPORT TIME. It is a classic
 * script published on `window`, and this bundle is a deferred module, so
 * reading it while this file's body runs would capture whatever happened
 * to be there. The same rule every `t()` consumer in this tree follows.
 *
 * `window` IS NOT `globalThis`, and that cost slice 3 a debugging round:
 * they are the same object in a browser and are NOT in a node `vm`
 * sandbox. Everything here goes through `hostWindow()`.
 */
import { hostWindow } from './env';

/**
 * What a row must carry to be nameable. Both fields are optional.
 *
 * NO INDEX SIGNATURE, DELIBERATELY. One here would force every concrete
 * row type in this tree to declare one too, which is the opposite of what
 * this is for: the point is that anything carrying a label and a name can
 * be named, not that only loosely-typed objects can.
 */
export interface NameableRow {
    label?: string | null;
    name?: string | null;
}

/** The shared legacy module's own shape, as this file uses it. */
interface LegacySessionLabel {
    resolve(row: NameableRow): string;
    UNKNOWN: string;
    LABEL_MAX_CHARS?: number;
    validate?(value: string): { ok: boolean; reason?: string; value?: string };
}

/** The legacy module, or null when it has not been loaded. */
export function legacySessionLabel(): LegacySessionLabel | null {
    const w = hostWindow() as unknown as
        { SessionLabel?: LegacySessionLabel } | undefined;
    return (w && w.SessionLabel) || null;
}

/**
 * Strip the `cloude_` namespace prefix for display.
 *
 * Description: the LAST rung of the fallback chain, and the only part of
 *   it this file implements, because it is also what a caller with no
 *   row at all needs - a confirm dialog naming a tmux handle it was
 *   handed directly, for instance. Non-cloude (external) names are
 *   rendered verbatim.
 * Inputs: tmuxName - the literal tmux session name.
 * Output: string.
 * Example: derivedDisplayName('cloude_api')  // 'api'
 */
export function derivedDisplayName(tmuxName: string | null | undefined): string {
    const name = tmuxName || '';
    return name.startsWith('cloude_') ? name.slice('cloude_'.length) : name;
}

/**
 * The display name for one session row.
 *
 * Description: FALLBACK IS THE OLD BEHAVIOUR, EXACTLY. A row with no
 *   label - any session created before labels existed, and any external
 *   session this app never made - renders the `cloude_`-stripped tmux
 *   name just as it always did. An empty-string label counts as no
 *   label: rendering blank would be worse than rendering the handle.
 *
 *   A ROW WITH NEITHER IS A THING TO SAY, NOT A BLANK CELL. The shared
 *   module answers its own `UNKNOWN` for that case, and this passes it
 *   through rather than inventing a second wording for it.
 * Inputs: row - anything carrying `label` and `name`.
 * Output: string - never empty when a name exists.
 * Example: sessionDisplayLabel({name: 'cloude_M', label: 'Media'})  // 'Media'
 */
export function sessionDisplayLabel(row: NameableRow | null | undefined): string {
    const safe = row || {};
    const shared = legacySessionLabel();
    if (shared && typeof shared.resolve === 'function') {
        return shared.resolve(safe) || shared.UNKNOWN;
    }
    // client/js/session-label.js is loaded before the bundle by
    // client/index.html. If it somehow is not, fall back to the same
    // inline chain the legacy method carried rather than rendering
    // nothing - a missing script must not blank every session name on
    // the home screen. Said out loud, because a silent degrade here is
    // indistinguishable from a server that sent no labels.
    console.error('CloudeWeb: SessionLabel is not loaded, naming sessions by handle');
    const label = typeof safe.label === 'string' ? safe.label.trim() : '';
    if (label) return label;
    return derivedDisplayName(typeof safe.name === 'string' ? safe.name : '');
}
