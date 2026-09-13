/**
 * The duck types this slice reads, and nothing more.
 *
 * WHY DUCK TYPES AND NOT xterm's OWN. `@xterm/xterm` is not a dependency
 * of `web/` and must not become one: the terminal is a VENDORED CLASSIC
 * SCRIPT (`client/vendor/xterm/xterm.js`) that publishes `Terminal` onto
 * `window`, and adding the npm package here would put a SECOND copy of
 * xterm's types - and eventually its code - in a tree whose whole
 * contract is that it ships one bundle with nothing remote in it.
 *
 * SO EVERY MEMBER BELOW IS OPTIONAL, and that is not laziness. The
 * vanilla modules this ports read every one of them through a `typeof`
 * guard at USE time, because a terminal is replaced on a session swap
 * and `term.reset()` wipes handler slots. Typing them as required would
 * describe an object this code has never been allowed to assume it has.
 */

/** An xterm disposable: the return of `onWriteParsed` and friends. */
export interface DisposableLike {
    dispose?(): void;
}

/**
 * A marker xterm keeps in step with buffer trims.
 *
 * `line` is decremented by xterm itself on every trim and the marker
 * DISPOSES ITSELF when its row falls out of scrollback, which is why one
 * marker is both the corrected row and the notification that the prompt
 * is gone.
 */
export interface MarkerLike {
    line?: number;
    isDisposed?: boolean;
    dispose?(): void;
}

/** The active buffer, as the scanner and the rail read it. */
export interface BufferLike {
    type?: string;
    baseY?: number;
    cursorY?: number;
    viewportY?: number;
    length?: number;
}

/** The xterm terminal, as this slice reads it. */
export interface TermLike {
    cols?: number;
    rows?: number;
    buffer?: { active?: BufferLike };
    registerMarker?(offset: number): MarkerLike | null | undefined;
    scrollToLine?(line: number): void;
    focus?(): void;
    onWriteParsed?(cb: () => void): DisposableLike;
    onScroll?(cb: () => void): DisposableLike;
}

/** One prompt as `client/js/terminal-prompt-scan.js` reports it. */
export interface ScannedPrompt {
    ordinal: number;
    line: number;
    text: string;
    preview: string;
}

/** A scanned prompt once the rail has bound a marker and a filter verdict. */
export interface RailPrompt extends ScannedPrompt {
    marker: MarkerLike | null;
    matches: boolean;
}

/** One tick on the rail: the prompts it stands for, and where it sits. */
export interface Tick {
    ordinals: number[];
    y: number;
}

/** `window.TerminalPromptScan`, the pure scanner and the tick geometry. */
export interface PromptScanApi {
    scan(
        buffer: BufferLike,
        opts: {
            cols?: number;
            baseY?: number;
            rows?: number;
            isRule?: (text: string) => boolean;
        },
    ): ScannedPrompt[];
    layoutTicks(
        prompts: Array<{ ordinal: number; line: number }>,
        bufferLength: number,
        railHeight: number,
    ): Tick[];
    currentOrdinalFor(
        prompts: Array<{ ordinal: number; line: number }>,
        viewportY: number,
    ): number;
}

/**
 * What xterm's search add-on reports back, as the engine passes it on.
 *
 * `resultCount` NULL MEANS NOT COUNTED YET, never zero: the add-on
 * reports -1 while it is still counting and the engine translates that.
 */
export interface EngineResults {
    resultIndex?: number | null;
    resultCount?: number | null;
    limit?: number | null;
}

/** `window.TerminalSearchEngine`, the add-on wrapper. */
export interface SearchEngineApi {
    attach(term: TermLike): unknown;
    find(query: string, opts: Record<string, unknown>, dir: 'next' | 'prev'): unknown;
    next(): unknown;
    prev(): unknown;
    clear(): unknown;
    onResults(cb: (results: EngineResults) => void): () => void;
    predicate(query: string, opts?: Record<string, unknown>): (text: string) => boolean;
}

/**
 * How far the tmux history load got.
 *
 * `null` is "not started", and it is kept apart from `unavailable`: not
 * having looked is not the same as having looked and found nothing.
 */
export type HistoryState = null | 'pending' | 'painted' | 'already' | 'unavailable';

/** `window.TerminalHistory`, the non-destructive scrollback pull. */
export interface HistoryApi {
    ensureLoaded(
        term: TermLike,
        sessionId: string | null,
    ): Promise<{ loaded?: HistoryState }>;
}

/** `window.DeepDive`, the widen-to-the-archive link. */
export interface DeepDiveApi {
    hrefFor(session: unknown, query: string): Promise<string | null> | string | null;
    open(session: unknown, query: string): Promise<boolean> | boolean;
    MIN_QUERY_CHARS?: number;
}
