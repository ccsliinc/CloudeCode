<!--
  SearchPanel - scoped archive search, its coverage statement, its TWO
  distinct resume affordances, and the one export that leaves this app.

  SHELL-INDEPENDENT, exactly as slices 5, 6 and 7 are. It takes its
  client, its outcome classifier, its open handler and - the FOURTH SHELL
  GAP - its `copyText`, and assumes NOTHING about what is around it. It
  mounts into any container, declares no position, owns no scrollport and
  reaches for no global. Adam's shell replacement can put it anywhere.

  THE FOURTH GAP: THERE IS NO CLIPBOARD SEAM IN `app-screen`. The
  documented three are the scrollport, the modal host and the frame
  scheduler. This surface needs a fourth, because a composed export has
  to reach the person somehow and every route to that is a HOST
  capability: `navigator.clipboard` is permission-gated, origin-gated and
  absent under jsdom, and an `<a download>` needs a document the plugin
  does not own. So `copyText` is an injected prop with a THREE-OUTCOME
  contract - it resolves true when the host actually delivered the text,
  false when it tried and could not, and is ABSENT when the host has no
  such capability at all. The three render differently: an absent
  capability disables the control with a stated reason, and a failed
  attempt says it failed. A boolean would fold the last two together and
  a silent no-op would be the worst of the three.

  TWO CURSORS, TWO MEANINGS, NEVER CROSSED. The resume control reads
  `affordance.cursor`, which `search-envelope.ts` resolved from exactly
  ONE named meta field per scan status. This component never touches
  `meta`, so it CANNOT pick the wrong cursor. `data-resume-kind`
  distinguishes more-hits from more-scope from nothing on STRUCTURE and
  not only on prose.

  THE COVERAGE LINE RENDERS ON EVERY OUTCOME INCLUDING `ok`, because
  `result_status: ok` is compatible with having read one transcript out
  of 3,416.

  `omit: ['resume']` ON THE OUTCOME BLOCK IS THE FIX FOR TWO IDENTICAL
  PRIMARY BUTTONS. This panel draws its own kind-aware resume control, so
  the generic block is told not to draw one. Measured before the option
  existed: a partial search painted "Resume the scan" twice, a few
  hundred pixels apart, from two modules that did not know about each
  other.

  NOTHING HERE READS A SNIPPET. Hits arrive as `HitView`s from
  `search-run.ts`, which built them through the egress door, and the
  export goes through the same door again in `export-compose.ts`.
-->
<script lang="ts">
    import SearchHit from './SearchHit.svelte';
    import OutcomeBlock from './OutcomeBlock.svelte';
    import { ACTIONS, CLASS, RESUME_KINDS } from './search-vocab';
    import { createSearchRunner, emptySearch, type SearchQuery, type SearchState,
             type SearchTransport } from './search-run';
    import { outcomeBlock, type OutcomeReason } from './outcome-view';
    import { composeExport } from './export-compose';
    import { COMPOSED_FORMATS, type ComposedFormat } from './export-vocab';

    /** What this panel needs from the injected outcome classifier. */
    interface Classifier {
        classify(envelope: unknown): { token: string; reasons?: readonly OutcomeReason[] };
    }

    interface Props {
        /** The granted archive client. Slice 2's, injected, never reached for. */
        client: SearchTransport;
        /** The outcome classifier slices 5, 6 and 7 also consume. */
        outcome: Classifier;
        /** Open one hit in a reader. Absent leaves the controls inert. */
        onOpenHit?: (transcriptId: number | string, lineNo: number | null) => void;
        /**
         * THE FOURTH SHELL GAP. Deliver composed text to the person.
         * Resolves true on delivery, false on a failed attempt. ABSENT
         * means the host has no such capability, which is a third,
         * different state and renders as a disabled control.
         */
        copyText?: (text: string, filename: string) => Promise<boolean>;
    }

    let { client, outcome, onOpenHit, copyText }: Props = $props();

    /**
     * The runner, built on FIRST USE rather than at construction.
     *
     * Description: reading a `$props()` value in the component body is
     *   `state_referenced_locally` - it captures the INITIAL value, so a
     *   host that swapped the client would keep talking to the old one
     *   with no warning at runtime. Building it inside a function reads
     *   the live prop. It is memoised because the runner OWNS the
     *   accumulated hits and the resume cursor, and rebuilding it per
     *   call would silently discard both halfway through a resume chain.
     * Output: the one runner for this mount.
     */
    let built: ReturnType<typeof createSearchRunner> | null = null;
    function runner(): ReturnType<typeof createSearchRunner> {
        if (!built) built = createSearchRunner(client, outcome);
        return built;
    }

    let view = $state<SearchState>(emptySearch());
    /** What the last export attempt did, or null before any. */
    let exportNote = $state<string | null>(null);

    /**
     * The outcome block's model, or null when there is nothing to say.
     *
     * Description: rendered for every token that is NOT a plain `ok`,
     *   and it sits ALONGSIDE any hits that did arrive rather than
     *   replacing them - a partial search with 20 hits has both a result
     *   set and an incompleteness to state, and hiding either is a lie.
     */
    const block = $derived.by(() => {
        if (view.token === null || view.token === 'ok') return null;
        const reasons = view.envelope === null
            ? null
            : outcome.classify(view.envelope).reasons ?? null;
        return outcomeBlock(view.token, view.envelope, reasons, null, ['resume']);
    });

    /** True when a resume control should be drawn at all. */
    const showResume = $derived(
        view.affordance !== null
        && (view.affordance.kind === RESUME_KINDS.MORE_HITS
            || view.affordance.kind === RESUME_KINDS.MORE_SCOPE),
    );

    /**
     * Run a NEW search.
     *
     * Description: EXPORTED so a host drives this panel without reaching
     *   into it, exactly as `TranscriptReader.open()` is. Discards prior
     *   hits: a new question does not inherit an old answer's coverage.
     * Inputs: query - scope and terms.
     * Output: the outcome token, so a caller can branch without reading
     *   state back out.
     * Example: await panel.run({q: 'restic', projectId: 12})
     */
    export async function run(query: SearchQuery): Promise<string | null> {
        view = { ...view, running: true };
        view = await runner().run(query);
        exportNote = null;
        return view.token;
    }

    /**
     * Continue along the ONE dimension the scan status named.
     *
     * Description: both kinds APPEND. More matches add rows; more scope
     *   adds whatever the newly-read transcripts hold. Neither discards
     *   what was already found.
     * Output: the outcome token.
     */
    export async function resume(): Promise<string | null> {
        view = await runner().resume();
        return view.token;
    }

    /**
     * The current state, for a host that wants to read it.
     *
     * Description: NOT NAMED `state`, and that is not a style choice. In
     *   Svelte 5 a `$`-prefixed identifier is a STORE SUBSCRIPTION of the
     *   same name, so declaring `function state()` in this module turns
     *   every `$state(...)` rune call in it into `$state` the store read,
     *   and the component dies at construction with `store_invalid_shape`
     *   pointing at a line in the header comment. Caught by
     *   `mask-egress.test.ts` mounting the panel; nothing else in this
     *   slice would have.
     */
    export function currentState(): SearchState {
        return view;
    }

    /**
     * Compose the current results and hand them to the host.
     *
     * Description: EVERY line goes through `mask-egress.ts` inside
     *   `composeExport`. This function holds no raw hit and cannot pass
     *   one anywhere except into that composer. A refused preview becomes
     *   a stated substitution line, never an omission, and the count of
     *   substitutions is reported back to the person so an export that
     *   withheld most of itself says so.
     * Inputs: format - text or json.
     * Output: nothing. The outcome is reported in `exportNote`.
     */
    async function doExport(format: ComposedFormat): Promise<void> {
        if (!copyText) {
            exportNote = 'export is unavailable: this shell supplied no way to hand '
                + 'text to you.';
            return;
        }
        // THE VIEWS ARE THE WHOLE INPUT. Each carries the egress verdict
        // the list beside it is painting from, so the file and the screen
        // are two consumers of ONE decision rather than two calls to the
        // door that could disagree. No raw hit exists in this scope.
        const composed = composeExport(
            view.hits,
            { query: runner().query()?.q ?? '', coverage: view.coverage, scan: view.scan },
            format,
        );
        const delivered = await copyText(composed.text, composed.filename);
        exportNote = delivered
            ? `exported ${composed.hits} hit(s) as ${composed.filename}. `
                + `${composed.substituted} preview(s) were withheld or absent and are `
                + 'named in the file.'
            : 'the shell could not deliver the export. nothing left this app.';
    }
</script>

<section class={CLASS.root}>
    <p class={CLASS.coverage}>{view.coverage}</p>

    <ul class={CLASS.hits}>
        {#each view.hits as hit, i (`${hit.transcriptId}:${hit.lineNo}:${i}`)}
            <SearchHit view={hit} onOpen={onOpenHit} />
        {/each}
    </ul>

    <div class={CLASS.footer}>
        {#if block}
            <OutcomeBlock model={block} transportError={view.transportError} />
        {/if}

        {#if view.affordance}
            <div class={CLASS.resume} data-resume-kind={view.affordance.kind}>
                <p class={CLASS.resumeReason}>{view.affordance.reason}</p>
                {#if showResume}
                    <button
                        class={CLASS.resumeBtn}
                        type="button"
                        data-action={view.affordance.kind === RESUME_KINDS.MORE_HITS
                            ? ACTIONS.LOAD_MORE_HITS
                            : ACTIONS.RESUME_SCAN}
                        data-cursor-field={view.affordance.field}
                        disabled={view.affordance.blocked}
                        data-blocked-reason={view.affordance.blocked
                            ? view.affordance.reason
                            : null}
                        onclick={() => { void resume(); }}
                    >{view.affordance.label}</button>
                {/if}
            </div>
        {/if}

        {#if view.hits.length > 0}
            <div class={CLASS.resume} data-resume-kind="export">
                <button
                    class={CLASS.resumeBtn}
                    type="button"
                    data-action="export-text"
                    disabled={!copyText}
                    data-blocked-reason={copyText
                        ? null
                        : 'this shell supplied no way to hand text to you'}
                    onclick={() => { void doExport(COMPOSED_FORMATS.TEXT); }}
                >export these results</button>
                {#if exportNote}
                    <p class={CLASS.resumeReason}>{exportNote}</p>
                {/if}
            </div>
        {/if}

        {#if view.transportError && !block}
            <p class={CLASS.transportReason}>{view.transportError}</p>
        {/if}
    </div>
</section>
