/**
 * The search panel's key routing, as a pure decision plus one listener.
 *
 * PORTED FROM `client/js/terminal-search-keys.js` WITHOUT A RULE
 * CHANGED. The vanilla module worked and was tested; this is the same
 * ladder in TypeScript, and the suite beside it is the same set of
 * refusals.
 *
 * WHY THE RULES ARE THEIR OWN FILE. A chord that reaches xterm does not
 * fail quietly, it TYPES INTO SOMEBODY'S SHELL, so these rules are the
 * part of the feature most worth testing exhaustively - and a router
 * entangled with a panel can only be tested by building the panel and
 * watching what it does. Most of this module's rules are REFUSALS
 * (Ctrl+F inside `less`, Cmd+G with nothing open, Cmd+F over a modal),
 * and a suite that only drove the openings would pass against a router
 * that never refuses.
 *
 * THE CHORDS, AND THE ONE THAT WAS REFUSED. Ctrl+S was the obvious pick
 * and is unusable: it is claude's own `chat:stash`, and XOFF in any
 * shell, so binding it would freeze a terminal on a mistyped hotkey.
 *
 *   Cmd+F        open, or refocus an open panel. The browser's own Find
 *                is BLIND to xterm - the terminal is painted, not DOM -
 *                so the native dialog searches an empty page and looks
 *                broken. Taking the chord is a fix, not a theft.
 *   Ctrl+F       the same, but ONLY on the normal buffer. On the
 *                alternate screen it is vim and less page-down, and a
 *                pager you cannot page is worse than no search at all.
 *   Cmd/Ctrl+G   next match, Shift for previous, and ONLY while the panel
 *                is open: Ctrl+G is readline's abort the rest of the time.
 *   Esc          close, but only from inside the panel. Esc typed at the
 *                pane belongs to claude.
 *   Enter        next, Shift+Enter previous, inside the panel.
 *   Up / Down    walk the prompt rail, inside the panel.
 *
 * THREE LEVELS OF SWALLOWING, AND THE MIDDLE ONE IS THE SUBTLE ONE.
 *   'both'  preventDefault AND stopPropagation - a chord we act on.
 *   'stop'  stopPropagation ONLY - an ordinary character typed in the
 *           field. Stopping it is what keeps it out of the pane;
 *           PREVENTING it would also stop the field receiving the
 *           character the user just typed, so the box would take no
 *           input at all while looking perfectly normal.
 *   'none'  we did not recognise it; it is not ours to touch.
 *
 * UNKNOWN IS NOT NORMAL, for the alternate-screen flag. A caller that
 * cannot measure the buffer passes `alternate: false`, so Ctrl+F opens.
 * That direction is deliberate: being wrong costs one panel the user
 * closes, against a Ctrl+F swallowed inside `less` with no way down.
 */

/** What a keystroke was decided to mean. */
export type KeyAction =
    | 'none'
    | 'open'
    | 'next'
    | 'prev'
    | 'close'
    | 'jump-up'
    | 'jump-down'
    | 'shield';

/** How much of the event to swallow. */
export type KeyConsume = 'both' | 'stop' | 'none';

/** One routed decision. */
export interface KeyDecision {
    action: KeyAction;
    consume: KeyConsume;
}

/** The caller's measured world at the moment the key arrived. */
export interface KeyContext {
    open?: boolean;
    inPanel?: boolean;
    alternate?: boolean;
    screenActive?: boolean;
    modalOpen?: boolean;
}

/** The fields of a keydown this router reads. */
export interface KeyLike {
    type?: string;
    key?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
}

/** The one "do nothing" answer, so no caller has to build it. */
const NONE: KeyDecision = { action: 'none', consume: 'none' };

/**
 * Decide what one keydown means.
 *
 * Inputs:
 *   e (KeyLike) - needs key, metaKey, ctrlKey, altKey, shiftKey. A
 *     non-keydown `type` is refused.
 *   ctx (KeyContext) - the caller's measured world. Every field is read
 *     as a boolean; a missing one reads false.
 * Output: KeyDecision.
 * Example:
 *   route({type: 'keydown', key: 'f', metaKey: true}, {screenActive: true})
 *   // => {action: 'open', consume: 'both'}
 */
export function route(e: KeyLike | null | undefined, ctx?: KeyContext): KeyDecision {
    if (!e || e.type !== 'keydown') return NONE;
    const c = ctx ?? {};
    const open = !!c.open;
    const inPanel = open && !!c.inPanel;

    const key = e.key;
    const meta = !!e.metaKey;
    const ctrl = !!e.ctrlKey;
    const alt = !!e.altKey;
    const shift = !!e.shiftKey;

    // Cmd+F / Ctrl+F. Exactly one of the two modifiers, never both and
    // never with Alt: Cmd+Alt+F and Ctrl+Cmd+F are somebody else's
    // chords and claiming them is how a hotkey earns a bug report from a
    // user who has never opened this panel.
    if ((key === 'f' || key === 'F') && !alt && meta !== ctrl) {
        if (ctrl && c.alternate) return NONE;
        if (!open && (!c.screenActive || c.modalOpen)) return NONE;
        return { action: 'open', consume: 'both' };
    }

    if (!open) return NONE;

    // Cmd+G / Ctrl+G, either modifier, only while open.
    if ((key === 'g' || key === 'G') && !alt && (meta || ctrl)) {
        return { action: shift ? 'prev' : 'next', consume: 'both' };
    }

    // Everything below is about keys typed INSIDE the panel. A key aimed
    // at the pane while the panel happens to be open is the pane's, and
    // that includes Escape.
    if (!inPanel) return NONE;

    if (key === 'Escape') return { action: 'close', consume: 'both' };
    if (key === 'Enter') return { action: shift ? 'prev' : 'next', consume: 'both' };
    if (key === 'ArrowUp') return { action: 'jump-up', consume: 'both' };
    if (key === 'ArrowDown') return { action: 'jump-down', consume: 'both' };

    // A plain character, a paste chord, a Home, a Backspace: the field's
    // business, and nobody else's.
    return { action: 'shield', consume: 'stop' };
}

/** What a routed decision is performed against. */
export interface KeyRoutingTarget {
    isOpen(): boolean;
    /** Is this event's target inside the panel? */
    containsTarget(node: unknown): boolean;
    alternate(): boolean;
    screenActive(): boolean;
    modalOpen(): boolean;
    open(): void;
    close(): void;
    step(dir: 'next' | 'prev'): void;
    jump(delta: number): void;
}

/**
 * Install the ONE document listener that performs those decisions.
 *
 * Description: CAPTURE PHASE, AND THE PHASE IS THE WHOLE CORRECTNESS
 *   ARGUMENT. xterm's textarea turns keystrokes into pty bytes, so a
 *   chord that reaches it does not merely fail to open a panel, it types
 *   into somebody's shell. A capture listener on `document` sees the key
 *   before any descendant does, and a `stopPropagation()` there means
 *   the event never reaches the terminal at all.
 *
 *   ONE LISTENER, INSTALLED ONCE, FROM THE MOUNT. The panel component is
 *   mounted and unmounted with the screen; the chord has to work at any
 *   moment the terminal screen is up, including before the panel has
 *   ever been opened, so the listener cannot live in the component.
 *
 *   THE VANILLA CARRIED A SECOND, BUBBLE-PHASE COPY on the panel element
 *   purely so the node mini-DOM - which has no capture phase - could
 *   observe the shield. The vitest suite beside this runs in jsdom,
 *   which has a real capture phase, so the copy and the WeakSet of
 *   already-handled events that kept the two from acting twice are both
 *   gone. In a browser the capture listener always won and the bubble
 *   one never ran, so nothing that shipped behaves differently.
 * Inputs:
 *   target (KeyRoutingTarget) - normally the SearchController.
 *   doc (Document) - the document to listen on.
 * Output: () => void - removes the listener.
 * Example: const stop = installKeyRouting(controller, document);
 */
export function installKeyRouting(target: KeyRoutingTarget, doc: Document): () => void {
    const onKeyDown = (event: Event): void => {
        const e = event as KeyboardEvent;
        const decision = route(e as KeyLike, {
            open: target.isOpen(),
            inPanel: target.containsTarget(e.target),
            alternate: target.alternate(),
            screenActive: target.screenActive(),
            modalOpen: target.modalOpen(),
        });
        if (decision.action === 'none') return;
        if (decision.consume === 'both') e.preventDefault?.();
        if (decision.consume !== 'none') e.stopPropagation?.();

        // 'shield' has no branch: keeping the key off the pane, which the
        // stopPropagation above just did, IS the whole action.
        switch (decision.action) {
            case 'open':
                target.open();
                break;
            case 'close':
                target.close();
                break;
            case 'next':
            case 'prev':
                target.step(decision.action);
                break;
            case 'jump-up':
                target.jump(-1);
                break;
            case 'jump-down':
                target.jump(1);
                break;
            default:
                break;
        }
    };
    doc.addEventListener('keydown', onKeyDown, true);
    return () => doc.removeEventListener('keydown', onKeyDown, true);
}
