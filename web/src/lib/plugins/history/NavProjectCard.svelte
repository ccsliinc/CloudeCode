<!--
  NavProjectCard - one project as a bordered card.

  THE TWO COUNTS ARE ONE SENTENCE, NOT TWO NUMBERS: "27 sessions of 718
  total". The word `of` does the whole job, and it is a separate element
  so it can be styled down without touching the figure and so a test can
  assert the connective is present. The reasoning and the measurements
  are in `nav-card.ts`; this file only draws what that module resolved.

  NO HOST PILLS ON THE FACE. They were removed at the owner's
  instruction - "the machine pills are probably not necessary to display,
  but should fold into an info button" - and they are not deleted, they
  MOVED: the modal names every machine and links back to that machine's
  list. `.archive-nav__hosts` and `.archive-nav__host-badge` are
  therefore in the vocabulary and drawn by nothing, exactly as in the
  vanilla card, which kept `renderHostBadges` for the same reason.

  WHEN, BESIDE HOW MUCH. This is the value the rail's default order is
  built on, and a card ordered by a number it does not show asks the
  reader to take the ordering on trust.

  PARKED, AND IT SAYS SO. A card sitting at the end of a
  most-recent-first list looks like the oldest project in the archive;
  this marker is the only thing that distinguishes "we could not place
  it" from "it really is the oldest". Marked as an attribute as well as
  in words, so a test asserts the classification rather than the wording.

  THE INFO CONTROL MUST NOT ALSO SELECT. The card face selects the
  project; the `i` stops the event on its way to opening the modal, or
  the transcript list reloads behind a dialog nobody asked it to load
  behind.
-->
<script lang="ts">
    import { CLASS, NODE_KINDS, NODE_MOD, type NodeKind } from './nav-vocab';
    import { idFor, titleFor, type NavRowData } from './nav-row';
    import { countsLine, presentationFor, type OverlayFallback, type Presentation } from './nav-card';
    import { activityCell, type UnsortedReason } from './nav-order';
    import NavLabel from './NavLabel.svelte';

    interface Props {
        row: NavRowData;
        /** The client-side overlay fallback, or null. */
        overlay?: OverlayFallback | null;
        /** Matched character indices from the fuzzy filter, or null. */
        positions?: readonly number[] | null;
        /** Which field those positions were measured against, or null. */
        matchField?: string | null;
        /** Why this card is not in the current order, or null. */
        unsorted?: UnsortedReason | null;
        /** Open this project. */
        onActivate?: (kind: NodeKind, id: number | string | null, row: NavRowData) => void;
        /** Open the details modal for it. */
        onInfo?: (row: NavRowData, presentation: Presentation) => void;
    }

    let {
        row, overlay = null, positions = null, matchField = null,
        unsorted = null, onActivate, onInfo,
    }: Props = $props();

    const kind: NodeKind = NODE_KINDS.PROJECT;
    const id = $derived(idFor(kind, row));
    const pres = $derived(presentationFor(row, overlay));
    const counts = $derived(countsLine(row));
    const when = $derived(activityCell(row));
    const tip = $derived(titleFor(kind, row));
    const title = $derived(tip ? `${pres.name}\n${tip}` : pres.name);
    /**
     * The fuzzy positions index the field the MATCHER read. The name on
     * the face may be an overlay override it never saw, so the marks are
     * applied only when the two are the same string.
     */
    const marked = $derived(
        !!matchField && String(row[matchField] ?? '') === pres.name,
    );
</script>

<li
    class="{CLASS.node} {NODE_MOD[kind]}"
    data-node-kind={kind}
    data-node-id={id === null ? '' : String(id)}
    data-project-group={pres.group}
    data-project-hidden={pres.hidden ? 'true' : undefined}
    data-project-renamed={pres.renamed ? 'true' : undefined}
    data-unsorted={unsorted ? unsorted.short : undefined}
>
    <div class={CLASS.card}>
        <button
            class="{CLASS.row} {CLASS.cardMain}"
            type="button"
            data-action="select"
            {title}
            onclick={() => onActivate?.(kind, id, row)}
        >
            <span class={CLASS.label}>
                <NavLabel text={pres.name} {positions} matched={marked} />
            </span>

            <span class={CLASS.counts} title={counts.title}>
                <span
                    class="{CLASS.count} {CLASS.countSessions}"
                    data-count="sessions"
                    data-session-state={counts.session.state}
                >
                    <span class={CLASS.countValue}>{counts.sessionText}</span>
                    <span class={CLASS.countNoun}>sessions</span>
                </span>
                <span class="{CLASS.count} {CLASS.countTotal}" data-count="transcripts">
                    <span class={CLASS.countOf}>of</span>
                    <span class={CLASS.countValue}>{counts.totalText}</span>
                    <span class={CLASS.countNoun}>total</span>
                </span>
            </span>

            {#if when}
                <span
                    class="{CLASS.when}{when.known ? '' : ` ${CLASS.whenUnknown}`}"
                    title={when.title}
                >{when.text}</span>
            {/if}
        </button>

        <button
            class={CLASS.infoBtn}
            type="button"
            data-action="info"
            aria-label="Details for {pres.name}"
            title="Machines, full path and details for {pres.name}"
            onclick={(e) => { e.stopPropagation(); e.preventDefault(); onInfo?.(row, pres); }}
        >i</button>

        {#if unsorted}
            <span class={CLASS.unsorted} title={unsorted.title}
            >not in this order: {unsorted.short}</span>
        {/if}
    </div>
</li>
