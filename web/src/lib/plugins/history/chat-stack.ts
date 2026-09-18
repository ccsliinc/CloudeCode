/**
 * THE DRILL CHAIN: which conversation you are in, and how you get back.
 *
 * Ported from the state half of `client/js/archive-chat-stack.js`; the
 * breadcrumb markup is `ChatChain.svelte`.
 *
 * WHAT IT STACKS AND WHY. "then you can drill down into and view the
 * subagent the same way." The word doing the work there is SAME. A
 * subagent is not a different kind of thing with a different viewer; it
 * is a transcript, rendered by this same chat view, which means it can
 * itself contain subagents, which means the nesting has NO FIXED DEPTH -
 * measured, the corpus links 924 transcripts at depth 2, 519 at 3, 274
 * at 4 and 158 at 5. So the way back cannot be one "back" button holding
 * one previous transcript id. It has to be a stack, and every level of
 * it has to be individually reachable, or somebody four levels down has
 * to click back four times to reach the top. IT IS LOAD-BEARING: without
 * it a drill is a one-way trip.
 *
 * IT IS NOT A RENDER CACHE. Each level is fetched when it becomes
 * current; see `ChatView.svelte`'s `loadCurrent`. Caching the chain
 * would mean a level rendered from a snapshot taken before the reader
 * drilled, and the reader has no way to know which levels are stale.
 *
 * A LEVEL WHOSE LABEL IS NOT KNOWN SAYS SO. A breadcrumb that invents
 * "Subagent" for a row the server never named is a fact manufactured by
 * the navigation, and it is exactly the kind of plausible filler that
 * stops people asking why the name is missing.
 *
 * THE ROOT LEVEL IS ALWAYS PRESENT once `reset` has named one and can
 * never be popped. Truncating to zero would leave the view holding no
 * transcript with no way to say which one it lost.
 *
 * Pure: no DOM, no framework, no globals.
 */

/** One level of the chain. Every field distinguishes absent from empty. */
export interface ChainLevel {
    readonly transcriptId: string | number | null;
    /** Null when the server never named this level. */
    readonly label: string | null;
    readonly agentId: string | number | null;
    /** The subagent's rank among its siblings, when one was claimed. */
    readonly ordinal: number | null;
}

/** What a caller may hand `reset` or `push`. */
export interface ChainSpec {
    readonly transcriptId?: string | number | null;
    readonly label?: unknown;
    readonly agentId?: string | number | null;
    readonly ordinal?: unknown;
}

/** The chain. */
export interface ChatStack {
    reset(spec: ChainSpec | null): ChainLevel;
    push(spec: ChainSpec | null): ChainLevel | null;
    truncateTo(index: number): ChainLevel | null;
    pop(): ChainLevel | null;
    relabelRoot(label: string): boolean;
    levels(): ChainLevel[];
    depth(): number;
    current(): ChainLevel | null;
    isRoot(): boolean;
}

/**
 * Normalise one level.
 *
 * Description: keeps `undefined` and `null` distinct from a string, so
 *   an unnamed level renders as unknown rather than as the literal
 *   string "undefined".
 * Inputs: spec.
 * Output: a ChainLevel.
 */
function normalise(spec: ChainSpec | null | undefined): ChainLevel {
    const s = spec || {};
    return {
        transcriptId: s.transcriptId === undefined ? null : s.transcriptId,
        label: (typeof s.label === 'string' && s.label !== '') ? s.label : null,
        agentId: s.agentId === undefined ? null : s.agentId,
        ordinal: Number.isInteger(s.ordinal) ? s.ordinal as number : null,
    };
}

/**
 * Build a drill chain.
 *
 * Description: empty until `reset()` names a root, because a chain with
 *   no root is not a shallow chain, it is an unasked question.
 * Inputs: none.
 * Output: a ChatStack.
 * Example:
 *   const st = createStack();
 *   st.reset({transcriptId: 4, label: 'main'});
 *   st.push({transcriptId: 91, label: 'Explore', agentId: 'a1'});
 *   st.depth(); // -> 2
 */
export function createStack(): ChatStack {
    let levels: ChainLevel[] = [];

    return {
        /**
         * Start a new chain at one transcript, discarding any previous.
         *
         * Description: opening a transcript from the list is a new
         *   question, not a step deeper into the old one.
         */
        reset(spec: ChainSpec | null): ChainLevel {
            const root = normalise(spec);
            levels = [root];
            return root;
        },

        /**
         * Descend into a subagent.
         *
         * Description: a push onto an EMPTY chain is refused rather than
         *   silently becoming a reset: it would mean the view drilled
         *   into a subagent without ever having opened a parent, which is
         *   a bug worth seeing.
         */
        push(spec: ChainSpec | null): ChainLevel | null {
            if (levels.length === 0) return null;
            const lvl = normalise(spec);
            levels.push(lvl);
            return lvl;
        },

        /**
         * Go back UP to a level by its index, dropping everything below.
         *
         * Description: this is what makes a four-deep chain one click
         *   from the top instead of four. An index naming no level is a
         *   NO-OP, not a truncation to nothing.
         */
        truncateTo(index: number): ChainLevel | null {
            if (!Number.isInteger(index)) return null;
            if (index < 0 || index >= levels.length) return null;
            levels = levels.slice(0, index + 1);
            return levels[levels.length - 1] ?? null;
        },

        /** Go up exactly one level. A no-op at the root. */
        pop(): ChainLevel | null {
            if (levels.length <= 1) return null;
            levels.pop();
            return levels[levels.length - 1] ?? null;
        },

        /**
         * Give the ROOT the name its header carries, once it arrives.
         *
         * Description: the root only. A late header must never relabel a
         *   level the reader has already drilled into, and a chain with
         *   no root has nothing to name.
         * Inputs: label - the name the header supplied.
         * Output: whether anything was renamed.
         */
        relabelRoot(label: string): boolean {
            const root = levels[0];
            if (!root) return false;
            if (typeof label !== 'string' || label === '') return false;
            if (root.label === label) return false;
            levels = [{ ...root, label }, ...levels.slice(1)];
            return true;
        },

        /** A copy of the chain, root first. */
        levels: () => levels.slice(),
        /** How deep it is. */
        depth: () => levels.length,
        /** The level being viewed. */
        current: () => levels[levels.length - 1] ?? null,
        /** Is the view at the top. */
        isRoot: () => levels.length <= 1,
    };
}

/**
 * The text one breadcrumb level reads as.
 *
 * Description: an unnamed level says so rather than being filled in.
 * Inputs: level.
 * Output: the crumb's words.
 * Example: crumbText({transcriptId: 91, label: 'Explore', agentId: null,
 *   ordinal: 2}) // -> '2. Explore (t91)'
 */
export function crumbText(level: ChainLevel): string {
    const rank = level.ordinal !== null ? `${level.ordinal}. ` : '';
    const name = level.label !== null ? level.label : 'name NOT KNOWN';
    const id = level.transcriptId !== null ? ` (t${level.transcriptId})` : '';
    return `${rank}${name}${id}`;
}
