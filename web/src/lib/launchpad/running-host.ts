/**
 * Everything the running-sessions list reaches OUTSIDE itself, behind one
 * interface.
 *
 * WHY AN INTERFACE RATHER THAN DIRECT `window` READS. This surface is the
 * busiest seam in the migration: it talks to five legacy modules that are
 * SHARED with the sidebar and must not move (`SessionRowActions`,
 * `SessionRestartPicker`, `SessionRestartReturn`, `SessionThemeTint`,
 * `SessionTransport`), to three legacy Launchpad methods that belong to
 * slice 7, to `window.API`, and to this bundle's own plugin bridge. A
 * component reading all of that directly would be untestable without a
 * browser and unreadable with one. A test hands in a recorder and asserts
 * what the list ASKED FOR, which is the only half this slice owns.
 *
 * EVERY MEMBER RESOLVES ITS GLOBAL AT CALL TIME. The bundle is a deferred
 * module and the legacy tree is a set of classic scripts, so a value read
 * while this module's body runs is whatever happened to be published by
 * then. `browserRunningHost()` may therefore be built at any moment,
 * including before the legacy tree has finished loading.
 *
 * `window` IS NOT `globalThis`. They are the same object in a browser and
 * are NOT in a node `vm` sandbox, where the harness hangs a plain object
 * on the context. Slice 3 lost a debugging round to that; everything here
 * goes through `hostWindow()`.
 *
 * A MISSING MODULE IS LOUD AND REFUSES. Not one member here guesses: a
 * destructive action whose confirmation module is absent does NOT run,
 * and a restart with no picker does NOT start. The alternative is a
 * second, unreviewed confirmation path, which is how a one-click
 * irreversible action gets shipped by accident.
 */
import { hostWindow } from '../sessions/env';
import type { ThemeColors } from './running-row';
import { t } from '../i18n/index.svelte';
import { attachRunningSession, returnToActiveSession } from './navigation';
import { browserNavHost } from './nav-host';

/** One destructive-or-restart control, as the shared module names it. */
export interface RowActionDescriptor {
    /** `close`, `remove` or `restart`, from `SessionRowActions`. */
    id: string;
    /** The glyph name in `client/js/icons/glyphs.js`. */
    glyph: string;
    /** The catalog key for the label, title and aria-label. */
    labelKey: string;
    /** `restart` carries an extra class, as it always has. */
    extraClass: string;
}

/** What the restart picker answers with when the user confirms. */
export interface RestartChoice {
    agentType?: string | null;
    confirmRestartLive?: boolean;
}

/** What `POST /sessions/respawn` answers with. */
export interface RespawnResult {
    ok?: boolean;
    detail?: string | null;
    agent_type_persisted?: boolean;
    [key: string]: unknown;
}

/** What `SessionRestartReturn.reopen` answers with. */
export interface ReopenResult {
    status: string;
    detail?: string | null;
}

/**
 * The api client was not loaded when a row tried to act.
 *
 * WHY A TYPE AND NOT A MESSAGE. This is a LOAD-ORDER fault, not a user
 * state - `client/index.html` loads `api.js` well before the bundle - but
 * it reaches the screen anyway, because `running-actions.ts` catches it
 * and prints the reason. A thrown Error carrying a sentence would be copy
 * living outside the catalog, in the one place nobody looks for copy, and
 * the pseudo-locale guard caught exactly that. So it carries NO message
 * and `reasonFrom` names it from the catalog like any other sentence.
 */
export class ApiUnavailableError extends Error {
    constructor() {
        super('api_unavailable');
        this.name = 'ApiUnavailableError';
    }
}

/** The verdict `SessionLabel.validate` returns for a typed label. */
export interface LabelVerdict {
    ok: boolean;
    reason?: string;
    value?: string;
}

/** One item the `session-card-action` surface offers for a row. */
export interface CardAction {
    id: string;
    label: string;
    order: number;
}

/** Everything outside the running-sessions list that it reaches. */
export interface RunningHost {
    // ---- what a row may offer -----------------------------------------
    /**
     * Which controls this status earns, in render order.
     *
     * MENU OR INLINE, NEVER BOTH, and `SessionRowActions.actionsFor` is
     * the ONE thing that decides. A live row gets close AND restart; a
     * dead row gets restart AND remove; an `unknown` status is never
     * treated as dead. A second status list on this surface is how the
     * launcher and the sidebar came to disagree about one session.
     */
    actionsFor(status: string | null | undefined): RowActionDescriptor[];
    /** The enabled `session-card-action` contributions for one row. */
    cardActions(name: string, unread: boolean): CardAction[];
    /** Run one contribution by id. False when it is not ours or not enabled. */
    runCardAction(id: string, name: string, unread: boolean): Promise<boolean>;
    /** The theme manifest's accent and display name, or null. */
    themeColors(themeId: string): ThemeColors | null;
    /** This browser's socket state for a session, or undefined. */
    transportFor(name: string): string | undefined;
    /** The maximum LABEL length, from the module that mirrors the server. */
    labelMaxChars(): number;
    /** The shared label rule. NOT a local regex: a second copy drifts. */
    validateLabel(value: string): LabelVerdict;

    // ---- what a row may do --------------------------------------------
    /** Ask the user to confirm a destructive action, naming the session. */
    confirmAction(action: string, displayName: string): Promise<boolean>;
    /** Whether this action needs confirming at all. Restart does not. */
    requiresConfirm(action: string): boolean;
    /** The user-facing name of an action, for a failure sentence. */
    actionLabel(action: string): string;
    /** `PATCH /sessions/{id}/name`. */
    renameSession(sessionId: string, label: string): Promise<unknown>;
    /** `DELETE /sessions/{id}` - the full teardown for a bound session. */
    destroySession(sessionId: string): Promise<unknown>;
    /** `DELETE /sessions/external/{name}` - a direct kill, no adoption. */
    destroyExternalSession(name: string): Promise<unknown>;
    /** Resolve a live session id for a tmux name, or null. */
    resolveSessionId(tmuxName: string): Promise<string | null>;
    /** Open the restart picker. null means the user declined or it failed. */
    openRestartPicker(
        tmuxName: string,
        display: string,
        status: string | null,
    ): Promise<RestartChoice | null>;
    /** Why the picker could not predict anything, or null. */
    restartPickerError(): string | null;
    /**
     * Whether the restart picker module is loaded at all.
     *
     * TWO DIFFERENT FACTS LOOK THE SAME WITHOUT THIS. `openRestartPicker`
     * answering null means either the user declined or the module is
     * absent, and only the second is worth a sentence - telling a user
     * who just pressed cancel that the picker failed to load is a lie,
     * and saying nothing when it really did fail leaves a control that
     * does nothing.
     */
    hasRestartPicker(): boolean;
    /** `POST /sessions/respawn`. */
    respawnSession(
        tmuxName: string,
        agentType: string | null,
        confirmLive: boolean,
    ): Promise<RespawnResult>;
    /** Put the user back into the session that was just restarted. */
    reopenAfterRestart(result: RespawnResult): Promise<ReopenResult>;
    /** Copy this conversation into a new session. OWNED rows only. */
    forkSession(tmuxName: string): Promise<void>;
    /** Jump into a session this browser already holds a backend for. */
    returnToActive(sessionId: string | null): Promise<void>;
    /** Open or adopt a session by tmux name. */
    attachSession(name: string): Promise<void>;
    /** Refetch and re-merge the running-session set. */
    refresh(): Promise<void>;
    /** Say something went wrong, on the legacy inline error surface. */
    showError(message: string): void;
}

/** The shared row-action module's own shape, as this file uses it. */
interface LegacyRowActions {
    ACTION_CLOSE: string;
    ACTION_REMOVE: string;
    ACTION_RESTART: string;
    actionsFor(status: string | null | undefined): string[];
    labelFor(action: string): string;
    requiresConfirm(action: string): boolean;
    confirm(action: string, displayName: string): Promise<boolean>;
}

/** The rest of the legacy surface this file reads, all optional. */
interface LegacyWindow {
    SessionRowActions?: LegacyRowActions;
    SessionThemeTint?: { colorsFor(id: string): ThemeColors | null };
    SessionTransport?: { stateFor(name: string): string | undefined };
    SessionLabel?: { LABEL_MAX_CHARS?: number; validate?(v: string): LabelVerdict };
    SessionRestartPicker?: {
        open(n: string, d: string, s: string | null): Promise<RestartChoice | null>;
        lastError(): string | null;
    };
    SessionRestartReturn?: { reopen(r: RespawnResult): Promise<ReopenResult> };
    UIFlags?: { showMarkUnreadControl(): boolean };
    API?: {
        renameSession(id: string, label: string): Promise<unknown>;
        destroySession(id: string): Promise<unknown>;
        destroyExternalSession(name: string): Promise<unknown>;
        listSessions?(): Promise<unknown[]>;
        respawnSession(
            name: string, agentType: string | null, confirmLive: boolean,
        ): Promise<RespawnResult>;
    };
    Launchpad?: {
        showError?(message: string): void;
        _returnToActiveRunningSession?(id: string | null): Promise<void>;
        _handleAttachRunningSession?(name: string): Promise<void>;
    };
    CloudeWeb?: {
        launchpad?: {
            forkSession?(name: string | null): Promise<void>;
            loadRunningSessions?(): Promise<void>;
        };
        sessionCardMenuItems?(row: unknown, ctx: unknown): CardAction[];
        runSessionCardAction?(
            id: string, row: unknown, ctx: unknown,
        ): Promise<boolean>;
    };
}

/** Which glyph each action draws. Names from client/js/icons/glyphs.js. */
const ACTION_GLYPHS: Record<string, string> = {
    close: 'close',
    remove: 'trash',
    restart: 'restart',
};

/** Which catalog key each action's label comes from. */
const ACTION_LABEL_KEYS: Record<string, string> = {
    close: 'session.action.close',
    remove: 'session.action.remove',
    restart: 'session.action.restart',
};

/** The legacy globals, looked up on every call. */
function legacy(): LegacyWindow {
    return (hostWindow() as unknown as LegacyWindow) || {};
}

/**
 * Report that something the list needed was not there.
 *
 * Description: LOUD, NEVER SILENT. Every member below degrades to
 *   refusing when a module is missing, and a control that does nothing
 *   for a reason nobody logged is indistinguishable from a broken app.
 *   A diagnostic, not user copy.
 * Inputs: what - the member that was absent. Output: void.
 * Example: missing('SessionRowActions')
 */
function missing(what: string): void {
    console.error('CloudeWeb: the running-sessions list could not reach', what);
}

/**
 * The feature flags a `session-card-action` is judged by.
 *
 * Description: FLAGS DEFAULT ON, AND ABSENCE MEANS ON. `UIFlags` answers
 *   its own default until its probe lands and whenever it cannot run at
 *   all, so a failed read never takes a control away. The same shape
 *   `client/js/session-row-menu-plugins.js` builds for the sidebar, so
 *   both surfaces hide together off one config key.
 * Inputs: none. Output: the flags block.
 */
function pluginFlags(): Record<string, boolean> {
    const flags = legacy().UIFlags;
    return {
        show_mark_unread_control: flags ? flags.showMarkUnreadControl() : true,
    };
}

/**
 * Build the host the real browser uses.
 *
 * Description: closures over nothing. Each member resolves its global
 *   when called.
 * Inputs: none. Output: RunningHost.
 * Example: const host = browserRunningHost();
 */
export function browserRunningHost(): RunningHost {
    return {
        actionsFor(status: string | null | undefined): RowActionDescriptor[] {
            const mod = legacy().SessionRowActions;
            if (!mod || typeof mod.actionsFor !== 'function') {
                missing('SessionRowActions.actionsFor');
                // REFUSE RATHER THAN GUESS. An empty list paints a row
                // with no controls, which is honest; inventing `close`
                // here would be a second status list beside the one that
                // could not be read.
                return [];
            }
            return mod.actionsFor(status).map((id) => ({
                id,
                glyph: ACTION_GLYPHS[id] ?? 'close',
                labelKey: ACTION_LABEL_KEYS[id] ?? ACTION_LABEL_KEYS.close!,
                extraClass: id === mod.ACTION_RESTART
                    ? 'session-row-action-restart'
                    : '',
            }));
        },
        cardActions(name: string, unread: boolean): CardAction[] {
            const web = legacy().CloudeWeb;
            if (!web || typeof web.sessionCardMenuItems !== 'function') {
                // GUARD THE FUNCTION, NOT THE RESULT. An EMPTY list is
                // exactly what `show_mark_unread_control: false` looks
                // like and stays silent; an absent function is a bundle
                // that failed to load and is not.
                missing('CloudeWeb.sessionCardMenuItems');
                return [];
            }
            return web.sessionCardMenuItems(
                { name, unread },
                { flags: pluginFlags(), refresh: () => {} },
            );
        },
        async runCardAction(
            id: string, name: string, unread: boolean,
        ): Promise<boolean> {
            const web = legacy().CloudeWeb;
            if (!web || typeof web.runSessionCardAction !== 'function') {
                missing('CloudeWeb.runSessionCardAction');
                return false;
            }
            const refresh = async () => {
                await this.refresh();
            };
            return web.runSessionCardAction(
                id, { name, unread }, { flags: pluginFlags(), refresh },
            );
        },
        themeColors(themeId: string): ThemeColors | null {
            const tint = legacy().SessionThemeTint;
            if (!tint || typeof tint.colorsFor !== 'function') return null;
            return tint.colorsFor(themeId);
        },
        transportFor(name: string): string | undefined {
            const transport = legacy().SessionTransport;
            if (!transport || typeof transport.stateFor !== 'function') {
                return undefined;
            }
            return transport.stateFor(name);
        },
        labelMaxChars(): number {
            // The LABEL's limit, from the one module that mirrors the
            // server. It was a hardcoded 64 - the old tmux-name limit -
            // which silently truncated any longer label at the maxlength
            // with no error anywhere, because a maxlength reports nothing.
            const mod = legacy().SessionLabel;
            return (mod && mod.LABEL_MAX_CHARS) || 200;
        },
        validateLabel(value: string): LabelVerdict {
            const mod = legacy().SessionLabel;
            if (!mod || typeof mod.validate !== 'function') {
                missing('SessionLabel.validate');
                return { ok: false };
            }
            return mod.validate(value);
        },
        async confirmAction(action: string, displayName: string): Promise<boolean> {
            const mod = legacy().SessionRowActions;
            if (!mod || typeof mod.confirm !== 'function') {
                // FAIL CLOSED. A destructive action must never proceed
                // because its confirmation failed to load.
                missing('SessionRowActions.confirm');
                return false;
            }
            return mod.confirm(action, displayName);
        },
        requiresConfirm(action: string): boolean {
            const mod = legacy().SessionRowActions;
            if (!mod || typeof mod.requiresConfirm !== 'function') return true;
            return mod.requiresConfirm(action);
        },
        actionLabel(action: string): string {
            const mod = legacy().SessionRowActions;
            if (!mod || typeof mod.labelFor !== 'function') return action;
            return mod.labelFor(action);
        },
        async renameSession(sessionId: string, label: string): Promise<unknown> {
            const api = legacy().API;
            if (!api) throw new ApiUnavailableError();
            return api.renameSession(sessionId, label);
        },
        async destroySession(sessionId: string): Promise<unknown> {
            const api = legacy().API;
            if (!api) throw new ApiUnavailableError();
            return api.destroySession(sessionId);
        },
        async destroyExternalSession(name: string): Promise<unknown> {
            const api = legacy().API;
            if (!api) throw new ApiUnavailableError();
            return api.destroyExternalSession(name);
        },
        async resolveSessionId(tmuxName: string): Promise<string | null> {
            // A LIVE SESSION BOUND TO THIS NAME MUST GO THROUGH THE FULL
            // TEARDOWN. `DELETE /sessions/{id}` tears down the backend,
            // the idle watcher, the tunnels and the metadata and then
            // kills tmux; the external endpoint only kills tmux. Asking
            // which one applies is what keeps a bound session from being
            // orphaned behind a dead pane.
            const api = legacy().API;
            if (!api || typeof api.listSessions !== 'function') return null;
            const live = await api.listSessions().catch(() => [] as unknown[]);
            if (!Array.isArray(live)) return null;
            const match = live.find((row) => {
                const info = row as { tmux_session?: string };
                return info && info.tmux_session === tmuxName;
            }) as { session?: { id?: string }; id?: string } | undefined;
            if (!match) return null;
            return (match.session && match.session.id) || match.id || null;
        },
        async openRestartPicker(
            tmuxName: string, display: string, status: string | null,
        ): Promise<RestartChoice | null> {
            const picker = legacy().SessionRestartPicker;
            if (!picker || typeof picker.open !== 'function') return null;
            return picker.open(tmuxName, display, status);
        },
        hasRestartPicker(): boolean {
            const picker = legacy().SessionRestartPicker;
            return !!picker && typeof picker.open === 'function';
        },
        restartPickerError(): string | null {
            const picker = legacy().SessionRestartPicker;
            if (!picker || typeof picker.lastError !== 'function') return null;
            return picker.lastError();
        },
        async respawnSession(
            tmuxName: string, agentType: string | null, confirmLive: boolean,
        ): Promise<RespawnResult> {
            const api = legacy().API;
            if (!api) throw new ApiUnavailableError();
            return api.respawnSession(tmuxName, agentType, confirmLive);
        },
        async reopenAfterRestart(result: RespawnResult): Promise<ReopenResult> {
            const back = legacy().SessionRestartReturn;
            if (!back || typeof back.reopen !== 'function') {
                return { status: 'not_reopened', detail: null };
            }
            return back.reopen(result);
        },
        async forkSession(tmuxName: string): Promise<void> {
            // THE SAME IMPLEMENTATION THE RECENT ROWS USE. Slice 2 moved
            // it into this tree and exported it so this surface would not
            // keep a second copy of the 409 refusal.
            const web = legacy().CloudeWeb;
            const fn = web && web.launchpad && web.launchpad.forkSession;
            if (typeof fn !== 'function') {
                missing('CloudeWeb.launchpad.forkSession');
                return;
            }
            await fn(tmuxName);
        },
        async returnToActive(sessionId: string | null): Promise<void> {
        // THE COMPILED PATH, NOT THE DELETED LEGACY METHOD. This reached
        // for ``window.Launchpad._returnToActiveRunningSession`` until the
        // 1.4.0 integration, and slice 7 deleted that method with
        // client/js/launchpad.js while ``shim.ts`` republished eight
        // members that do not include it. So the guard below always took
        // its ``missing()`` branch and CLICKING A RUNNING SESSION ROW ON
        // THE HOME SCREEN DID NOTHING - logged, never thrown, invisible to
        // every unit test because the test hands in a recorder and asserts
        // what the list ASKED FOR. The other party's browser-driven perf
        // harness is what caught it. ``navigation.ts`` already carries the
        // full port of both paths, unit tested, called by the deep-link
        // resolver; these two surfaces were simply never pointed at it.
            await returnToActiveSession(sessionId, browserNavHost(), t);
        },
        async attachSession(name: string): Promise<void> {
            // Same rewire as returnToActive above, same reason.
            await attachRunningSession(name, browserNavHost(), t);
        },
        async refresh(): Promise<void> {
            const web = legacy().CloudeWeb;
            const fn = web && web.launchpad && web.launchpad.loadRunningSessions;
            if (typeof fn !== 'function') {
                missing('CloudeWeb.launchpad.loadRunningSessions');
                return;
            }
            await fn();
        },
        showError(message: string): void {
            const lp = legacy().Launchpad;
            if (!lp || typeof lp.showError !== 'function') {
                missing('Launchpad.showError');
                return;
            }
            lp.showError(message);
        },
    };
}
