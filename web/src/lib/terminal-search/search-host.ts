/**
 * Everything outside this slice that the search panel reaches.
 *
 * WHY A HOST AND NOT A DIRECT `window.X` READ, the same argument
 * `web/src/lib/sessions/host.ts` makes one screen over. The panel's
 * interesting behaviour is almost all REFUSAL - a session that changed
 * underneath it, a history load that could not run, an archive that is
 * switched off - and every one of those is hard to produce on purpose in
 * a browser and trivial to hand in through an injected host.
 *
 * NOTHING IS CACHED, AND THAT IS A CORRECTNESS RULE RATHER THAN A STYLE.
 * The xterm terminal is REPLACED on a session swap and `term.reset()`
 * wipes handler slots, so every accessor below resolves through
 * `window` at the moment it is called. A field holding "the terminal"
 * is a field describing the session the user left.
 *
 * FIVE OF THE SIX MODULES IT REACHES STAY VANILLA ON PURPOSE. The
 * scanner, the tick geometry, the add-on wrapper, the history load and
 * the deep-dive link are framework-free and heavily tested where they
 * are; this slice ports the UI and keeps calling them, exactly as the
 * launchpad slices keep calling `window.API`.
 */
import { hostDocument, hostWindow } from '../sessions/env';
import type {
    DeepDiveApi,
    HistoryApi,
    PromptScanApi,
    SearchEngineApi,
    TermLike,
} from './types';

/** The terminal controller, as this slice reads it. */
interface ControllerLike {
    term?: TermLike | null;
    _sessionId?(): string | null;
    _currentSession?: unknown;
}

/** Everything the panel, the rail and the key router reach for. */
export interface SearchHost {
    /** The live xterm instance, read fresh. Null when none is attached. */
    term(): TermLike | null;
    /** This tab's session id, or null while a connect is in flight. */
    sessionId(): string | null;
    /** The session record the deep-dive lookup needs, or null. */
    currentSession(): unknown;
    /** xterm's search add-on wrapper, or null when it did not load. */
    engine(): SearchEngineApi | null;
    /** The non-destructive tmux history pull, or null. */
    history(): HistoryApi | null;
    /** The archive widen-out, or null when the archive is unavailable. */
    deepDive(): DeepDiveApi | null;
    /** The pure prompt scanner and tick geometry, or null. */
    promptScan(): PromptScanApi | null;
    /** The box-drawing rule test the scanner uses to find the input box. */
    isRule(): ((text: string) => boolean) | undefined;
    /** Is a modal already holding the keyboard? */
    modalOpen(): boolean;
    /** Is the terminal screen the one on display? */
    terminalScreenActive(): boolean;
    /** Put the keyboard back in the pane. Swallows its own failure. */
    focusTerm(): void;
}

/** A window carrying the legacy globals this slice reads. */
interface SearchGlobals {
    TerminalController?: ControllerLike;
    TerminalSearchEngine?: SearchEngineApi;
    TerminalHistory?: HistoryApi;
    DeepDive?: DeepDiveApi;
    TerminalPromptScan?: PromptScanApi;
    AltScreenScroll?: { isRule?: (text: string) => boolean };
    ModalStack?: { depth?(): number };
}

/** The legacy globals, or an empty object in a realm that has no window. */
function globals(): SearchGlobals {
    return (hostWindow() as unknown as SearchGlobals) ?? {};
}

/**
 * Is this terminal on xterm's alternate screen (vim, less, a TUI)?
 *
 * Description: A TERMINAL THAT CANNOT BE ASKED ANSWERS FALSE, and the
 *   direction is deliberate rather than convenient. `false` lets Ctrl+F
 *   open the panel, which costs a user one panel they close; `true`
 *   would swallow Ctrl+F inside `less`, where it is page-down and there
 *   is no other way down.
 * Inputs: term (TermLike | null).
 * Output: boolean.
 * Example: onAlternateScreen(host.term())  // false
 */
export function onAlternateScreen(term: TermLike | null): boolean {
    try {
        return term?.buffer?.active?.type === 'alternate';
    } catch {
        return false;
    }
}

/**
 * The host that talks to the running app.
 *
 * Description: RESOLVED PER CALL, never captured at import, for the same
 *   reason `main.ts` promises the bundle touches no global at load: the
 *   node harnesses evaluate this bundle in a sandbox with no
 *   `TerminalController` at all.
 * Inputs: none.
 * Output: SearchHost.
 * Example: const host = browserSearchHost();
 */
export function browserSearchHost(): SearchHost {
    const ctl = (): ControllerLike | null => globals().TerminalController ?? null;
    return {
        term: () => ctl()?.term ?? null,
        sessionId: () => {
            const c = ctl();
            if (!c || typeof c._sessionId !== 'function') return null;
            try {
                return c._sessionId();
            } catch {
                return null;
            }
        },
        currentSession: () => ctl()?._currentSession ?? null,
        engine: () => globals().TerminalSearchEngine ?? null,
        history: () => globals().TerminalHistory ?? null,
        deepDive: () => globals().DeepDive ?? null,
        promptScan: () => globals().TerminalPromptScan ?? null,
        isRule: () => {
            const alt = globals().AltScreenScroll;
            return typeof alt?.isRule === 'function' ? alt.isRule : undefined;
        },
        // A MISSING ModalStack ANSWERS "NO MODAL". The guard exists to
        // stay out of a modal's way, not to become a load-order
        // dependency of the search panel.
        modalOpen: () => {
            const ms = globals().ModalStack;
            if (!ms || typeof ms.depth !== 'function') return false;
            try {
                return ms.depth() > 0;
            } catch {
                return false;
            }
        },
        terminalScreenActive: () => {
            const el = hostDocument()?.getElementById('terminal-screen');
            return !!el?.classList?.contains('active');
        },
        focusTerm: () => {
            try {
                ctl()?.term?.focus?.();
            } catch (err) {
                console.warn('TerminalSearch: could not refocus the pane', err);
            }
        },
    };
}
