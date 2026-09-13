/**
 * The prompt rail's model: one tick per prompt the user typed, so a long
 * session can be walked by turn instead of by scrollbar.
 *
 * PORTED FROM `client/js/terminal-prompt-rail.js`. That file was model
 * AND DOM; this is the model, and `PromptRail.svelte` beside it is the
 * DOM. The scanner and the tick geometry it calls
 * (`client/js/terminal-prompt-scan.js`) are unchanged and stay vanilla.
 *
 * WHAT A TICK POINTS AT, AND WHY IT IS A MARKER. A prompt is found at an
 * absolute buffer row, and that number goes STALE the moment xterm trims
 * the buffer at its 50000-line limit: every remaining row shifts down, so
 * a jump to a remembered number drifts further from the prompt as the
 * session runs. `term.registerMarker` returns an object whose `.line`
 * xterm itself decrements on each trim, and which DISPOSES ITSELF when
 * its row falls out of scrollback. One marker is therefore both the
 * corrected line and the notification that the prompt is gone; a
 * disposed one is dropped, never jumped to.
 *
 * THE OFFSET IS RELATIVE AND THE LINE IS ABSOLUTE, WHICH IS xterm's
 * ASYMMETRY, NOT OURS. `registerMarker(offset)` marks
 * `baseY + cursorY + offset`, so an absolute row is passed as
 * `line - baseY - cursorY`, usually a large NEGATIVE number, while
 * `scrollToLine` takes the absolute line back. Getting that backwards
 * gives a rail whose every tick jumps to the bottom of the buffer, which
 * reads as a broken jump rather than as a broken marker.
 *
 * WHAT IT COSTS WHILE OPEN. The rescan walks the whole buffer, so it is
 * trailing-throttled at 300 ms behind `onWriteParsed`, and its listeners
 * are attached by `show()` and disposed by `hide()`: a CLOSED rail costs
 * nothing at all. The scroll handler is rAF-throttled and only moves the
 * "you are here" tick.
 *
 * EVERY REACTIVE FIELD IS `$state.raw` AND IS REPLACED, NEVER MUTATED.
 * A deep `$state` proxy over the prompt list would wrap the xterm MARKER
 * objects held inside it, which is a proxy standing between us and an
 * object whose whole job is to be identical to the one xterm is
 * updating. Every update here rebuilds the array anyway, which is what
 * `$state.raw` is for.
 */
import type {
    DisposableLike,
    MarkerLike,
    PromptScanApi,
    RailPrompt,
    TermLike,
    Tick,
} from './types';

/** Trailing throttle on the rescan, in ms. */
export const REFRESH_THROTTLE_MS = 300;

/** What the rail reaches for outside itself. */
export interface RailHost {
    term(): TermLike | null;
    promptScan(): PromptScanApi | null;
    isRule(): ((text: string) => boolean) | undefined;
}

/** One tick, as `PromptTick.svelte` renders it. */
export interface TickView {
    /** The first ordinal this tick stands for; the click target's id. */
    ordinal: number;
    /** Pixels from the top of the strip. */
    y: number;
    /** No prompt behind this tick matches the query. */
    dim: boolean;
    /** The viewport is sitting on one of this tick's prompts. */
    current: boolean;
    /** More than one prompt merged into this tick. */
    cluster: boolean;
    /** `#n of N`, or `#a-#b of N`, plus the first prompt's preview. */
    tip: string;
}

/** The rail's state and the operations the panel drives it with. */
export class RailModel {
    /** Every prompt currently on the rail, newest last. */
    prompts = $state.raw<RailPrompt[]>([]);
    /** The tick geometry for those prompts, from the pure layout. */
    ticks = $state.raw<Tick[]>([]);
    /** The ordinal the viewport is sitting on, 0 for none. */
    currentOrdinal = $state(0);
    /** The strip's measured height, 0 before it has a box. */
    railHeight = $state(0);

    #host: RailHost;
    #onJump: (prompt: RailPrompt) => void;
    #el: HTMLElement | null = null;
    #shown = $state(false);
    #filter: ((text: string) => boolean) | null = null;
    #bufferLength = 0;
    #writeSub: DisposableLike | null = null;
    #scrollSub: DisposableLike | null = null;
    #throttle: ReturnType<typeof setTimeout> | null = null;
    #rafPending = false;

    /**
     * Inputs: host (RailHost) - resolved per call, never cached, because
     *   the terminal is replaced on a session swap. onJump - notified
     *   after a successful jump, optional.
     */
    constructor(host: RailHost, onJump?: (prompt: RailPrompt) => void) {
        this.#host = host;
        this.#onJump = onJump ?? (() => {});
    }

    /**
     * Is the strip off screen?
     *
     * Description: TWO INDEPENDENT REASONS, folded here so the component
     *   renders a real `hidden` attribute rather than a display override.
     *   Not shown at all, or shown with nothing to show - the alternate
     *   screen and an empty buffer both reach the second through an empty
     *   prompt list.
     */
    get hidden(): boolean {
        return !this.#shown || this.prompts.length === 0;
    }

    /** How many prompts pass the current filter. */
    get filtered(): number {
        return this.prompts.filter((p) => p.matches).length;
    }

    /** The ticks, decorated with everything the component paints. */
    get tickViews(): TickView[] {
        const total = this.prompts.length;
        return this.ticks.map((tick) => {
            let anyMatch = false;
            let isCurrent = false;
            for (const ordinal of tick.ordinals) {
                const p = this.#byOrdinal(ordinal);
                if (p?.matches) anyMatch = true;
                if (ordinal === this.currentOrdinal) isCurrent = true;
            }
            return {
                // A tick the layout produced always names at least one
                // prompt; the 0 is what the type system asks for, and it
                // resolves to no prompt, which is the honest answer if
                // one ever arrived empty.
                ordinal: tick.ordinals[0] ?? 0,
                y: tick.y,
                dim: !anyMatch,
                current: isCurrent,
                cluster: tick.ordinals.length > 1,
                tip: this.#tipFor(tick, total),
            };
        });
    }

    /**
     * Hand the model the strip element so it can measure itself.
     *
     * Description: the height is a MEASUREMENT and cannot live in a
     *   stylesheet or in a prop; the tick layout is proportional to it.
     * Inputs: el (HTMLElement | null).
     * Output: void.
     * Example: rail.setElement(stripEl);
     */
    setElement(el: HTMLElement | null): void {
        this.#el = el;
    }

    /**
     * Rescan the buffer and rebuild every tick.
     *
     * Description: hides the rail on the alternate screen (a TUI has no
     *   scrollback and none of our prompts) and when the scan found
     *   nothing, both by leaving the prompt list empty.
     * Inputs: none. Output: void.
     * Example: rail.refresh();
     */
    refresh(): void {
        const term = this.#host.term();
        const buf = term?.buffer?.active;
        this.#releaseMarkers();
        if (!term || !buf || buf.type === 'alternate') {
            this.prompts = [];
            this.ticks = [];
            return;
        }
        const scanner = this.#host.promptScan();
        const found = scanner
            ? scanner.scan(buf, {
                cols: term.cols,
                baseY: buf.baseY,
                rows: term.rows,
                isRule: this.#host.isRule(),
            })
            : [];
        this.prompts = found.map((p) => ({
            ...p,
            marker: this.#markerFor(term, buf.baseY ?? 0, buf.cursorY ?? 0, p.line),
            matches: this.#verdict(p.text),
        }));
        this.#bufferLength = typeof buf.length === 'number' ? buf.length : 0;
        this.#relayout();
        this.currentOrdinal = this.#ordinalAt(
            typeof buf.viewportY === 'number' ? buf.viewportY : 0,
        );
    }

    /**
     * Filter the rail.
     *
     * Description: non-matching ticks are DIMMED, never removed, so the
     *   rail keeps its shape and the one the user was reaching for does
     *   not move out from under the pointer as they type.
     * Inputs: pred - (text) => boolean, or null to clear.
     * Output: void.
     * Example: rail.setFilter(engine.predicate('hazard'));
     */
    setFilter(pred: ((text: string) => boolean) | null): void {
        this.#filter = typeof pred === 'function' ? pred : null;
        this.prompts = this.prompts.map((p) => ({ ...p, matches: this.#verdict(p.text) }));
    }

    /**
     * The viewport moved.
     *
     * Description: moves the current tick only; no rescan.
     * Inputs: y (number) - the absolute top row on screen.
     * Output: void.
     */
    setViewport(y: number): void {
        this.currentOrdinal = this.#ordinalAt(y);
    }

    /**
     * The ordinal of the tick nearest a point down the strip.
     *
     * Description: THE TAP TARGET IS THE 24px STRIP AND NOT THE 12x3
     *   MARK INSIDE IT, and this is the whole of that mapping. It reads
     *   the y the layout ALREADY placed each tick at rather than
     *   re-deriving one from a prompt's line, because two derivations of
     *   one tick's position are two answers the moment they disagree,
     *   and the tick a finger aimed at is the one drawn on screen.
     *
     *   NEAREST, WITH NO DISTANCE CAP, deliberately: a tap on the strip
     *   means "take me to the closest turn", and a cap would give the
     *   control a dead zone whose edge nothing on screen draws. The far
     *   miss it admits is one jump, visible and reversible; a tap that
     *   does nothing reads as a broken control.
     *
     *   THE FIRST TICK WINS A TIE (`<`, not `<=`), so a point exactly
     *   between two ticks resolves the same way every time.
     * Inputs: offsetY (number) - pixels from the top of the strip.
     * Output: number - that tick's first ordinal; 0 when the rail has no
     *   ticks or the reading is not a finite number, which `jumpTo`
     *   refuses.
     * Example: rail.ordinalNear(212) // 7
     */
    ordinalNear(offsetY: number): number {
        if (!Number.isFinite(offsetY)) return 0;
        let best: Tick | null = null;
        let bestGap = Infinity;
        for (const tick of this.ticks) {
            const gap = Math.abs(tick.y - offsetY);
            if (gap < bestGap) {
                bestGap = gap;
                best = tick;
            }
        }
        return best?.ordinals[0] ?? 0;
    }

    /**
     * Jump to a prompt by ordinal.
     *
     * Inputs: ordinal (number).
     * Output: boolean - false when there is no such prompt, its row has
     *   been trimmed away, or the terminal refused.
     * Example: rail.jumpTo(7);
     */
    jumpTo(ordinal: number): boolean {
        const p = this.#byOrdinal(ordinal);
        if (!p || p.marker?.isDisposed) return false;
        const term = this.#host.term();
        if (!term || typeof term.scrollToLine !== 'function') return false;
        try {
            term.scrollToLine(this.#lineOf(p));
        } catch {
            return false;
        }
        this.currentOrdinal = ordinal;
        this.#onJump(p);
        return true;
    }

    /**
     * Step through the MATCHING prompts, wrapping at both ends.
     *
     * Description: walking only the matches is what makes Up and Down
     *   mean "the next turn that mentions this" while a query is typed,
     *   and "the next turn" when it is empty.
     * Inputs: delta (number) - negative for previous, else next.
     * Output: boolean, as jumpTo.
     */
    jump(delta: number): boolean {
        const list = this.prompts.filter((p) => p.matches);
        if (list.length === 0) return false;
        const at = list.findIndex((p) => p.ordinal === this.currentOrdinal);
        let next: number;
        if (at === -1) next = delta < 0 ? list.length - 1 : 0;
        else {
            next = at + (delta < 0 ? -1 : 1);
            if (next < 0) next = list.length - 1;
            if (next >= list.length) next = 0;
        }
        const target = list[next];
        return target ? this.jumpTo(target.ordinal) : false;
    }

    /** Attach, scan, paint. Inputs: none. Output: void. */
    show(): void {
        this.#shown = true;
        this.#listen();
        this.refresh();
    }

    /** Hide and stop observing. A closed rail costs nothing. Output: void. */
    hide(): void {
        this.#unlisten();
        this.#shown = false;
    }

    /** Hide and release every marker. Inputs: none. Output: void. */
    dispose(): void {
        this.hide();
        this.#releaseMarkers();
        this.prompts = [];
        this.ticks = [];
    }

    /** Recompute the strip height and the tick layout. */
    #relayout(): void {
        const kept = this.prompts.filter((p) => !p.marker?.isDisposed);
        if (kept.length !== this.prompts.length) this.prompts = kept;
        this.railHeight = this.#measureHeight();
        const scanner = this.#host.promptScan();
        this.ticks = scanner
            ? scanner.layoutTicks(
                kept.map((p) => ({ ordinal: p.ordinal, line: this.#lineOf(p) })),
                this.#bufferLength,
                this.railHeight,
            )
            : [];
    }

    /** The strip's own box, falling back to its parent's. */
    #measureHeight(): number {
        const own = this.#el?.clientHeight ?? 0;
        if (own > 0) return own;
        return this.#el?.parentElement?.clientHeight ?? 0;
    }

    /** Does this prompt pass the current filter? No filter means yes. */
    #verdict(text: string): boolean {
        if (!this.#filter) return true;
        try {
            return !!this.#filter(text);
        } catch {
            return true;
        }
    }

    /** Mark one ABSOLUTE row. A refusal is survivable: the prompt keeps
     *  its scanned line and stops tracking trims. */
    #markerFor(
        term: TermLike,
        baseY: number,
        cursorY: number,
        line: number,
    ): MarkerLike | null {
        if (typeof term.registerMarker !== 'function') return null;
        try {
            return term.registerMarker(Math.round(line - baseY - cursorY)) ?? null;
        } catch {
            return null;
        }
    }

    /** The row a prompt is at NOW: the marker's, or the scanned one. */
    #lineOf(p: RailPrompt): number {
        if (p.marker && !p.marker.isDisposed && typeof p.marker.line === 'number') {
            return p.marker.line;
        }
        return p.line;
    }

    /** Drop every marker we hold. Before a rescan, and on dispose. */
    #releaseMarkers(): void {
        for (const p of this.prompts) {
            const m = p.marker;
            if (m && typeof m.dispose === 'function' && !m.isDisposed) {
                try {
                    m.dispose();
                } catch {
                    /* already gone */
                }
            }
        }
    }

    /** Which prompt this viewport row sits on. 0 when none. */
    #ordinalAt(y: number): number {
        const scanner = this.#host.promptScan();
        return scanner ? scanner.currentOrdinalFor(this.prompts, y) : 0;
    }

    /** The prompt carrying this ordinal, or null. */
    #byOrdinal(ordinal: number): RailPrompt | null {
        return this.prompts.find((p) => p.ordinal === ordinal) ?? null;
    }

    /** `#n of N`, or `#a-#b of N` for a cluster, plus the preview. */
    #tipFor(tick: Tick, total: number): string {
        const head = tick.ordinals[0] ?? 0;
        const last = tick.ordinals[tick.ordinals.length - 1] ?? head;
        const range = tick.ordinals.length > 1 ? `#${head}-#${last}` : `#${head}`;
        const sentence = `${range} of ${total}`;
        const first = this.#byOrdinal(head);
        return first?.preview ? `${sentence}  ${first.preview}` : sentence;
    }

    /** Attach the two terminal listeners. Idempotent. */
    #listen(): void {
        const term = this.#host.term();
        if (!term || this.#writeSub) return;
        try {
            if (typeof term.onWriteParsed === 'function') {
                this.#writeSub = term.onWriteParsed(() => this.#scheduleRefresh());
            }
            if (typeof term.onScroll === 'function') {
                this.#scrollSub = term.onScroll(() => this.#scheduleViewport());
            }
        } catch (err) {
            console.warn('TerminalSearch: could not observe the terminal', err);
        }
    }

    /** Detach them, and drop a pending rescan with them. */
    #unlisten(): void {
        this.#writeSub?.dispose?.();
        this.#scrollSub?.dispose?.();
        this.#writeSub = null;
        this.#scrollSub = null;
        if (this.#throttle !== null) {
            clearTimeout(this.#throttle);
            this.#throttle = null;
        }
    }

    /** Trailing throttle: the LAST write in a burst pays for the scan. */
    #scheduleRefresh(): void {
        if (this.#throttle !== null) return;
        this.#throttle = setTimeout(() => {
            this.#throttle = null;
            this.refresh();
        }, REFRESH_THROTTLE_MS);
    }

    /** rAF-throttled "you are here" update. No rescan. */
    #scheduleViewport(): void {
        if (this.#rafPending) return;
        this.#rafPending = true;
        const run = (): void => {
            this.#rafPending = false;
            const buf = this.#host.term()?.buffer?.active;
            if (buf) this.setViewport(typeof buf.viewportY === 'number' ? buf.viewportY : 0);
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
    }
}
