/**
 * The search panel's lifecycle: open, type, walk, close.
 *
 * PORTED FROM `client/js/terminal-search.js`, rule for rule. That file
 * built its own DOM; this holds the state and `SearchPanel.svelte`
 * renders it. What has NOT changed is every decision it made.
 *
 * NOTHING IS CACHED ACROSS A SESSION. The terminal object is replaced on
 * a session swap and `term.reset()` wipes handler slots, so the term and
 * the session id are READ from the host at every use. A panel left open
 * across a switch would filter one session's rail with another session's
 * query, so the open session is recorded as `#openedFor` and any
 * mismatch closes the panel.
 *
 * A NULL SESSION ID IS NOT A MISMATCH. The controller answers null while
 * a connect is in flight, and closing on that would shut the panel
 * during a reconnect of the very session it is searching.
 *
 * THE PANEL IS AN OVERLAY, NEVER AN IN-FLOW CHILD, and that constraint
 * lives in `SearchPanel.svelte`'s styles rather than here. The argument
 * is worth repeating because it is the reason the whole feature is
 * shaped this way: `.terminal-container` is a flex column, so an in-flow
 * child of it takes rows away from `#terminal`, the ResizeObserver reads
 * that as a real geometry change, and the SIGWINCH that follows makes
 * claude answer with `ESC[2J`. A panel for FINDING things in the
 * scrollback that erased the scrollback on its way in would be an
 * excellent joke.
 */
import { countLabel } from './count-label';
import { RailModel } from './rail-model.svelte';
import { onAlternateScreen, type SearchHost } from './search-host';
import type { KeyRoutingTarget } from './search-keys';
import type { EngineResults, HistoryState, TermLike } from './types';

/** Milliseconds of quiet before a typed query is run. */
export const TYPE_DEBOUNCE_MS = 120;

/** How often, while open, the panel re-checks it is still on its session. */
export const SESSION_WATCH_MS = 750;

/**
 * Below this many characters the archive refuses a search. The number
 * belongs to DeepDive, which is the module that has to live with the
 * server's floor; this is only the fallback for a page where that script
 * did not load, and on such a page the button is disabled for a
 * different reason anyway.
 */
const DEEP_DIVE_MIN_CHARS_FALLBACK = 2;

/** The panel's state, and every decision it makes. */
export class SearchController implements KeyRoutingTarget {
    /** Is the panel on screen? */
    opened = $state(false);
    /** What is in the query field. */
    query = $state('');
    /** How far the tmux history pull got, for this open. */
    history = $state<HistoryState>(null);
    /** The add-on's last report, or null for NOT COUNTED YET. */
    results = $state.raw<EngineResults | null>(null);
    /** Why deep dive is unavailable, or null when it is available. */
    deepRefusal = $state<string | null>(null);
    /** The rail, built once and driven by this controller. */
    rail: RailModel;

    #host: SearchHost;
    #openedFor: string | null = null;
    #panelEl: HTMLElement | null = null;
    #inputEl: HTMLInputElement | null = null;
    #typeTimer: ReturnType<typeof setTimeout> | null = null;
    #watch: ReturnType<typeof setInterval> | null = null;
    #unsubscribeResults: (() => void) | null = null;

    /** Inputs: host (SearchHost) - everything outside this slice. */
    constructor(host: SearchHost) {
        this.#host = host;
        this.rail = new RailModel({
            term: () => host.term(),
            promptScan: () => host.promptScan(),
            isRule: () => host.isRule(),
        });
    }

    /** The words on the counter. */
    get countText(): string {
        return countLabel({
            history: this.history,
            query: this.query,
            results: this.results,
        });
    }

    /** Is deep dive pressable? */
    get deepEnabled(): boolean {
        return this.deepRefusal === null;
    }

    /**
     * The deep-dive control's tooltip: what it does, or why it will not.
     *
     * Description: DISABLED SAYS WHY. A control that is dead with no
     *   explanation reads as broken; one that says why reads as a rule.
     */
    get deepTitle(): string {
        return this.deepRefusal ?? 'search every past conversation in this project folder';
    }

    /** Hand over the panel element, so a key can be tested against it. */
    setPanelElement(el: HTMLElement | null): void {
        this.#panelEl = el;
    }

    /** Hand over the query field, so open() can focus it. */
    setInputElement(el: HTMLInputElement | null): void {
        this.#inputEl = el;
    }

    // ------------------------------------------------ KeyRoutingTarget

    isOpen(): boolean {
        return this.opened;
    }

    containsTarget(node: unknown): boolean {
        if (!this.opened || !this.#panelEl) return false;
        return this.#panelEl.contains(node as Node | null);
    }

    alternate(): boolean {
        return onAlternateScreen(this.#host.term());
    }

    screenActive(): boolean {
        return this.#host.terminalScreenActive();
    }

    modalOpen(): boolean {
        return this.#host.modalOpen();
    }

    // ------------------------------------------------------ lifecycle

    /**
     * Show the panel for the session currently attached.
     *
     * Description: a second call REFOCUSES rather than closing - Cmd+F
     *   is "find", not "toggle find", and the close controls are Esc and
     *   the X.
     * Inputs: none. Output: void.
     */
    open(): void {
        if (this.opened) {
            this.focusInput();
            return;
        }
        const term = this.#host.term();
        if (!term) return;

        this.opened = true;
        this.#openedFor = this.#host.sessionId();
        this.results = null;
        this.history = null;

        const engine = this.#host.engine();
        if (engine) {
            engine.attach(term);
            this.#unsubscribeResults = engine.onResults((r) => {
                this.results = r;
            });
        }

        this.rail.show();
        this.#loadHistory(term);
        this.refreshDeepDive();
        this.focusInput();
        this.#watch = setInterval(() => this.#checkSessionStillOurs(), SESSION_WATCH_MS);
    }

    /**
     * Hide the panel, drop every highlight, give the keyboard back.
     *
     * Inputs: none. Output: void.
     */
    close(): void {
        if (!this.opened) return;
        this.opened = false;
        this.#openedFor = null;
        this.history = null;
        this.results = null;
        if (this.#typeTimer !== null) {
            clearTimeout(this.#typeTimer);
            this.#typeTimer = null;
        }
        if (this.#watch !== null) {
            clearInterval(this.#watch);
            this.#watch = null;
        }
        if (this.#unsubscribeResults) {
            this.#unsubscribeResults();
            this.#unsubscribeResults = null;
        }
        this.#host.engine()?.clear();
        this.rail.hide();
        this.#host.focusTerm();
    }

    /** Toggle, for the header button and the tools menu row. Output: void. */
    toggle(): void {
        if (this.opened) this.close();
        else this.open();
    }

    /**
     * Debounced input, so a fast typist pays one search and not ten.
     *
     * Inputs: none - the query is already bound. Output: void.
     */
    onType(): void {
        if (this.#typeTimer !== null) clearTimeout(this.#typeTimer);
        this.#typeTimer = setTimeout(() => {
            this.#typeTimer = null;
            if (this.opened) this.runQuery();
        }, TYPE_DEBOUNCE_MS);
    }

    /**
     * Run the current query and re-filter the rail.
     *
     * Inputs: none. Output: void.
     */
    runQuery(): void {
        const engine = this.#host.engine();
        engine?.find(this.query, { incremental: true }, 'next');
        this.rail.setFilter(engine ? engine.predicate(this.query) : null);
        this.refreshDeepDive();
    }

    /** Walk matches. Inputs: dir - 'next' or 'prev'. Output: void. */
    step(dir: 'next' | 'prev'): void {
        const engine = this.#host.engine();
        if (!engine || !this.query) return;
        if (dir === 'prev') engine.prev();
        else engine.next();
    }

    /** Move the viewport one prompt along the rail. Inputs: delta. */
    jump(delta: number): void {
        this.rail.jump(delta);
    }

    /**
     * Caret into the field, selecting what is there, so a second Cmd+F
     * replaces the query rather than appending.
     *
     * Description: guarded the way `client/js/paste-fallback.js` guards
     *   its own focus - iOS throws on a selection for a field it has not
     *   laid out yet.
     * Inputs: none. Output: void.
     */
    focusInput(): void {
        if (!this.#inputEl) return;
        try {
            this.#inputEl.focus({ preventScroll: true });
            this.#inputEl.select?.();
        } catch (err) {
            console.warn('TerminalSearch: could not focus the search field', err);
        }
    }

    /**
     * Enable or disable deep dive, with a reason on the disabled state.
     *
     * Inputs: none. Output: void.
     */
    refreshDeepDive(): void {
        const dd = this.#host.deepDive();
        const q = this.query;
        if (!dd || typeof dd.hrefFor !== 'function') {
            this.deepRefusal = 'the conversation archive is not available';
            return;
        }
        const floor =
            typeof dd.MIN_QUERY_CHARS === 'number'
                ? dd.MIN_QUERY_CHARS
                : DEEP_DIVE_MIN_CHARS_FALLBACK;
        if (q.length < floor) {
            this.deepRefusal = `type at least ${floor} characters`;
            return;
        }
        const forQuery = q;
        const forSession = this.#openedFor;
        Promise.resolve(dd.hrefFor(this.#host.currentSession(), q))
            .then((href) => {
                // Claim at the gesture, check at the write: the answer is
                // only about the query and the session it was asked for.
                if (!this.opened || this.query !== forQuery) return;
                if (this.#openedFor !== forSession) return;
                this.deepRefusal = href ? null : 'no archived conversations for this folder';
            })
            .catch((err: unknown) => {
                if (!this.opened || this.query !== forQuery) return;
                console.warn('TerminalSearch: deep dive lookup failed', err);
                this.deepRefusal = 'could not reach the conversation archive';
            });
    }

    /** Hand the query to the archive explorer. Inputs: none. Output: void. */
    openDeepDive(): void {
        const dd = this.#host.deepDive();
        if (!dd || typeof dd.open !== 'function' || !this.deepEnabled) return;
        Promise.resolve(dd.open(this.#host.currentSession(), this.query)).catch(
            (err: unknown) => {
                console.warn('TerminalSearch: deep dive navigation failed', err);
            },
        );
    }

    /**
     * Pull the tmux scrollback in.
     *
     * Description: NEVER AWAITED by the open path - the panel is usable
     *   over the visible buffer while it is in flight.
     * Inputs: term (TermLike) - the live terminal. Output: void.
     */
    #loadHistory(term: TermLike): void {
        const hist = this.#host.history();
        if (!hist || typeof hist.ensureLoaded !== 'function') {
            this.history = 'unavailable';
            return;
        }
        this.history = 'pending';
        const forSession = this.#openedFor;
        Promise.resolve(hist.ensureLoaded(term, forSession))
            .then((r) => {
                if (!this.opened || this.#openedFor !== forSession) return;
                this.history = r?.loaded ? r.loaded : 'unavailable';
                this.rail.refresh();
                if (this.query) this.runQuery();
            })
            .catch((err: unknown) => {
                if (!this.opened || this.#openedFor !== forSession) return;
                console.warn('TerminalSearch: history load failed', err);
                this.history = 'unavailable';
            });
    }

    /** Close if the tab moved to another session underneath us. */
    #checkSessionStillOurs(): void {
        if (!this.opened) return;
        const now = this.#host.sessionId();
        if (now === null || this.#openedFor === null) return;
        if (now !== this.#openedFor) this.close();
    }
}
