/**
 * Stage C, the session-attribution prompt: everything about it that is
 * not markup.
 *
 * WHAT THIS IS A PORT OF. `client/js/launchpad.js` carried five methods
 * for this card - `loadAttributionPrompt`, `renderAttributionPrompt`,
 * `_bindAttributionPrompt`, `_adoptAttributed` and `_declineAttributed` -
 * plus two fields on the Launchpad singleton. They were deleted in the
 * same commit that added this file. The rules below are that code, moved
 * rather than rewritten, and the comments explaining WHY a rule is the
 * way it is came with it.
 *
 * WHY THE DECISION IS A PURE FUNCTION. `viewFor()` is the entire render
 * ladder - nothing / unavailable / pending - as a value, so the ladder
 * can be asserted in a Node test with no DOM at all, and the component
 * beside it is a switch over three cases. The three-outcome discipline
 * is the whole reason this card exists: 'unavailable' means whether
 * there is anything to ask CANNOT BE DETERMINED, which is a different
 * fact from 'none' and must never be rendered as one.
 *
 * WHY THE HOST IS INJECTED. The card talks to four globals the legacy
 * tree publishes (`window.API`, `window.Launchpad`, `window.SessionLabel`)
 * and none of them exist in a test process. :func:`browserHost` resolves
 * them at call time, so the browser gets the real ones and a test hands
 * in a recorder. This is a seam, not an adapter layer: no response is
 * reshaped and no endpoint is wrapped.
 */

/** One live tmux session the evidence ladder could not attribute. */
export interface UnattributedSession {
    /** The live tmux session name. Every adopt and decline is keyed on it. */
    tmux_name: string;
    /** tmux `#{session_created}`. Null when the instance could not be dated. */
    epoch?: number | null;
    /** `sessions.title` when the row carries one; falls back to `tmux_name`. */
    label?: string | null;
    /** Tier 5 and 6 sentences. Display only, never a verdict. */
    hints?: string[];
    /** 'no_admissible_evidence' or 'could_not_evaluate'. Never collapsed. */
    reason?: string;
}

/** The `GET /sessions/attribution-prompt` body. */
export interface SessionAttributionPrompt {
    /** 'none' | 'pending' | 'unavailable'. */
    state: string;
    sessions?: UnattributedSession[];
    /** The sentence above the list. Present only when there is something to act on. */
    notice?: string | null;
}

/** The `POST /sessions/attribution-decline` body, per session, never a count. */
export interface AttributionDeclineResponse {
    declined?: string[];
    not_eligible?: string[];
    unknown?: string[];
}

/** One row of the pending card, already resolved to the strings it paints. */
export interface AttributionRow {
    /** The raw tmux handle. The key the actions post under. */
    tmuxName: string;
    /** What the user is asked to recognise: the label if there is one. */
    shown: string;
    /** 'started ...' minus the word, or 'start time unknown'. */
    started: string;
    /** The sentence rendered for `reason`. */
    why: string;
    /** The raw reason, kept for the `data-reason` attribute. */
    reason: string;
    /** Tier sentences, already defaulted to an empty list. */
    hints: string[];
}

/** The three things this card can be. */
export type AttributionView =
    | { kind: 'nothing' }
    | { kind: 'unavailable'; notice: string }
    | { kind: 'pending'; notice: string; rows: AttributionRow[] };

/** Everything outside this module that the card needs to reach. */
export interface AttributionHost {
    /** `GET /sessions/attribution-prompt`. */
    fetchPrompt(): Promise<SessionAttributionPrompt>;
    /** `POST /sessions/adopt` for ONE session. */
    adoptSession(tmuxName: string): Promise<unknown>;
    /** `POST /sessions/attribution-decline` for a batch. */
    declineAttribution(tmuxNames: string[]): Promise<AttributionDeclineResponse>;
    /** The launchpad's inline, non-blocking error line. */
    showError(message: string): void;
    /** Re-read the running sessions list after an adopt has moved one. */
    refreshRunningSessions(): void;
    /** 'Ns ago' / 'Nm ago' / 'Nh ago' / 'Nd ago' for a unix epoch. */
    formatRelativeTime(epochSeconds: number): string;
    /** The one resolver for a session's displayed name, prefix kept. */
    resolveLabel(session: UnattributedSession): string | null;
}

/**
 * The sentence shown when the datastore could not be read.
 *
 * The server sends its own `notice` for this state; this is the fallback
 * for a body that arrived without one, and it says CANNOT BE DETERMINED
 * rather than anything that could be read as "nothing to do".
 */
export const UNAVAILABLE_FALLBACK_NOTICE = 'session attribution CANNOT BE DETERMINED';

/** What `reason` reads as, in words. A score would look authoritative. */
const WHY_BY_REASON: Record<string, string> = {
    could_not_evaluate: 'we could not complete the check for this one',
};

/** Every other reason, including a missing one. */
const WHY_DEFAULT = 'we found no record either way';

/**
 * Has the user closed the card in this page session?
 *
 * MODULE STATE, NOT COMPONENT STATE, AND NOT PERSISTED. In the legacy
 * code this was `attributionPromptClosed` on the Launchpad singleton: it
 * outlived every re-render of the card and died with the page. The
 * component is remounted on every `loadProjects()`, so component state
 * would forget the close on the next home-screen entry, and anything
 * durable would contradict the card's own footnote - "closing this
 * without answering brings it back next time". Module scope is the one
 * lifetime that matches.
 */
let closed = false;

/**
 * Whether the user has closed the card in this page session.
 *
 * Inputs: none. Output: boolean.
 * Example: isClosed()  // false
 */
export function isClosed(): boolean {
    return closed;
}

/**
 * Record that the user closed the card without answering.
 *
 * Description: not an answer, and not remembered past this page. The card
 *   comes back on the next load, which is what the footnote promises.
 * Inputs: none. Output: void.
 */
export function close(): void {
    closed = true;
}

/**
 * Forget the close. For tests, and for nothing else.
 *
 * Inputs: none. Output: void.
 */
export function resetClosedForTests(): void {
    closed = false;
}

/**
 * Resolve one unattributed session into the strings its row paints.
 *
 * Description: `shown` is what the user is asked to RECOGNISE and
 *   `tmuxName` is what the action is KEYED ON, and they are deliberately
 *   different. The label is resolved with the app prefix KEPT, which is
 *   the only surface that asks for that: the card's question is "did you
 *   start this?", one of its own hints is that the name matches the
 *   auto-generated form, and the user may need to match the exact string
 *   against their own `tmux ls`. Stripping the prefix would remove
 *   evidence from an evidence card.
 * Inputs:
 *   session (UnattributedSession) - one row of the prompt body.
 *   host (AttributionHost) - supplies the clock and the label resolver.
 * Output: AttributionRow.
 * Example:
 *   describeRow({tmux_name: 'cloude_a', epoch: 0, reason: 'x'}, host)
 *   // {tmuxName: 'cloude_a', shown: 'cloude_a', started: 'start time unknown', ...}
 */
export function describeRow(
    session: UnattributedSession,
    host: AttributionHost,
): AttributionRow {
    const tmuxName = session.tmux_name || '';
    const reason = session.reason || '';
    return {
        tmuxName,
        shown: host.resolveLabel(session) || tmuxName,
        // A zero epoch is as undatable as a missing one, which is why
        // this is a truthiness test and not a null check.
        started: session.epoch
            ? host.formatRelativeTime(session.epoch)
            : 'start time unknown',
        why: WHY_BY_REASON[reason] ?? WHY_DEFAULT,
        reason,
        hints: session.hints || [],
    };
}

/**
 * The whole render decision for the card, as a value.
 *
 * Description: the ladder, in the legacy order.
 *   1. No prompt at all (the fetch failed) renders NOTHING. A failed
 *      fetch is not the same fact as "there is nothing to ask", and
 *      showing the second for the first is the false green this whole
 *      feature exists to remove.
 *   2. The user having closed the card renders nothing.
 *   3. 'unavailable' renders its own line, with the server's notice or
 *      the CANNOT BE DETERMINED fallback.
 *   4. Anything that is not 'pending' with a non-empty session array
 *      renders nothing.
 *   5. Otherwise, the itemised card.
 * Inputs:
 *   prompt (SessionAttributionPrompt|null) - the fetched body, or null.
 *   host (AttributionHost) - passed through to :func:`describeRow`.
 *   hasClosed (boolean) - whether the user closed the card.
 * Output: AttributionView.
 * Example:
 *   viewFor({state: 'none'}, host, false)  // {kind: 'nothing'}
 */
export function viewFor(
    prompt: SessionAttributionPrompt | null | undefined,
    host: AttributionHost,
    hasClosed: boolean,
): AttributionView {
    if (!prompt || hasClosed) return { kind: 'nothing' };
    if (prompt.state === 'unavailable') {
        return {
            kind: 'unavailable',
            notice: prompt.notice || UNAVAILABLE_FALLBACK_NOTICE,
        };
    }
    if (
        prompt.state !== 'pending'
        || !Array.isArray(prompt.sessions)
        || prompt.sessions.length === 0
    ) {
        return { kind: 'nothing' };
    }
    return {
        kind: 'pending',
        notice: prompt.notice || '',
        rows: prompt.sessions.map((s) => describeRow(s, host)),
    };
}

/**
 * Fetch the question set. Non-fatal.
 *
 * Description: a failed fetch answers null, which renders as NOTHING -
 *   not as "no questions". The two are different facts.
 * Inputs: host (AttributionHost).
 * Output: Promise<SessionAttributionPrompt|null>.
 * Example: await loadPrompt(host)  // {state: 'none', sessions: []}
 */
export async function loadPrompt(
    host: AttributionHost,
): Promise<SessionAttributionPrompt | null> {
    try {
        return await host.fetchPrompt();
    } catch (error) {
        // Logged rather than swallowed: this is the only trace a user's
        // console keeps of a card that decided to paint nothing.
        console.error('Launchpad: attribution prompt fetch failed:', error);
        return null;
    }
}

/**
 * Adopt the named sessions through the EXISTING adopt path.
 *
 * Description: this records origin 'adopted', not 'created', and that
 *   distinction is deliberate. We did not create them as far as we can
 *   prove; we claimed them. An adopted session badges as ours for good,
 *   so the badge is right and no fact is invented.
 *
 *   ONE AT A TIME, ON PURPOSE. Each adopt reads this client's terminal
 *   grid and sets up a pipe on the pane; firing them as a batch would
 *   change the order the server sees them in for no gain. A failure is
 *   collected and reported by name rather than aborting the run, so one
 *   bad session cannot cost the user the other five.
 *
 *   IT DOES NOT REFRESH ANYTHING ITSELF. The legacy method reloaded the
 *   prompt and THEN the running sessions list, in that order, and the
 *   caller keeps that order rather than this function guessing at half
 *   of it.
 * Inputs:
 *   tmuxNames (string[]) - sessions to adopt. Empty is a no-op.
 *   host (AttributionHost).
 * Output: Promise<string[]> - the names that failed, in order.
 * Example: await adoptAttributed(['cloude_a'], host)  // []
 */
export async function adoptAttributed(
    tmuxNames: readonly string[],
    host: AttributionHost,
): Promise<string[]> {
    if (!tmuxNames || tmuxNames.length === 0) return [];
    const failed: string[] = [];
    for (const name of tmuxNames) {
        try {
            await host.adoptSession(name);
        } catch (error) {
            failed.push(name);
            console.error('Launchpad: adopt failed for', name, error);
        }
    }
    if (failed.length) host.showError('could not adopt: ' + failed.join(', '));
    return failed;
}

/**
 * Record "leave these as external", durably.
 *
 * Description: the server answers PER SESSION rather than with a count,
 *   because a name whose row is not 'observed' comes back in
 *   `not_eligible` instead of being counted as a success nobody
 *   measured. Both refusal lists are surfaced; a silent one would leave
 *   the user believing an answer was recorded that was not.
 *
 *   Note it does NOT refresh the running sessions list. Declining moves
 *   nothing - that asymmetry with adopt is the behaviour, not an
 *   oversight.
 * Inputs:
 *   tmuxNames (string[]) - the sessions the user left external. Empty is
 *     a no-op.
 *   host (AttributionHost).
 * Output: Promise<string[]> - the names that were NOT recorded.
 * Example: await declineAttributed(['cloude_a'], host)  // []
 */
export async function declineAttributed(
    tmuxNames: readonly string[],
    host: AttributionHost,
): Promise<string[]> {
    if (!tmuxNames || tmuxNames.length === 0) return [];
    try {
        const out = await host.declineAttribution([...tmuxNames]);
        const stuck = [...(out.not_eligible || []), ...(out.unknown || [])];
        if (stuck.length) host.showError('not recorded for: ' + stuck.join(', '));
        return stuck;
    } catch (error) {
        console.error('Launchpad: decline failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        host.showError('that answer was NOT recorded: ' + message);
        return [...tmuxNames];
    }
}

/** The shape of `window.API` this card uses. Hand-written, not generated. */
interface LegacyApi {
    getSessionAttributionPrompt(): Promise<SessionAttributionPrompt>;
    adoptSession(sessionName: string, confirmDetach?: boolean): Promise<unknown>;
    declineSessionAttribution(tmuxNames: string[]): Promise<AttributionDeclineResponse>;
}

/** The parts of `window.Launchpad` this card calls back into. */
interface LegacyLaunchpad {
    showError(message: string): void;
    loadRunningSessions(): unknown;
    _formatRelativeTime(epochSeconds: number): string;
}

/** The one resolver for a session's displayed name. */
interface LegacySessionLabel {
    resolve(
        row: { label?: string | null; name?: string | null },
        options?: { stripPrefix?: boolean },
    ): string | null;
}

declare global {
    interface Window {
        API?: LegacyApi;
        Launchpad?: LegacyLaunchpad;
        SessionLabel?: LegacySessionLabel;
    }
}

/**
 * The host backed by the legacy globals, resolved at CALL time.
 *
 * Description: every lookup happens inside the method, not when this
 *   object is built, because the bundle is a deferred module and the
 *   legacy scripts that publish these globals are classic scripts whose
 *   order relative to it is not this file's business. A global that is
 *   absent when a method runs is a real failure and throws, rather than
 *   being papered over with a no-op that would make a broken page look
 *   like an empty one. The two exceptions are the label resolver and the
 *   relative clock, which the legacy card already degraded on and which
 *   only affect one string in one row.
 * Inputs: none.
 * Output: AttributionHost.
 * Example: const host = browserHost(); await host.fetchPrompt();
 */
export function browserHost(): AttributionHost {
    /** The legacy API singleton, or a throw naming what is missing. */
    const api = (): LegacyApi => {
        const value = window.API;
        if (!value) throw new Error('window.API is not loaded');
        return value;
    };
    /** The legacy launchpad singleton, or a throw naming what is missing. */
    const launchpad = (): LegacyLaunchpad => {
        const value = window.Launchpad;
        if (!value) throw new Error('window.Launchpad is not loaded');
        return value;
    };
    return {
        fetchPrompt: () => api().getSessionAttributionPrompt(),
        adoptSession: (tmuxName) => api().adoptSession(tmuxName),
        declineAttribution: (tmuxNames) => api().declineSessionAttribution(tmuxNames),
        showError: (message) => launchpad().showError(message),
        refreshRunningSessions: () => {
            launchpad().loadRunningSessions();
        },
        // ONE implementation of the age string, and it is still the
        // legacy one. Slice 5 moves `_formatRelativeTime` into this tree;
        // copying it here first would mean two of them for the length of
        // the migration, and two of them is how they drift.
        formatRelativeTime: (epochSeconds) => {
            const lp = window.Launchpad;
            if (!lp || typeof lp._formatRelativeTime !== 'function') return 'unknown';
            return lp._formatRelativeTime(epochSeconds);
        },
        // stripPrefix:false is deliberate and this is the ONE surface
        // that asks for it. See describeRow().
        resolveLabel: (session) => {
            const resolver = window.SessionLabel;
            if (!resolver) return null;
            return resolver.resolve(
                { label: session.label, name: session.tmux_name },
                { stripPrefix: false },
            );
        },
    };
}
