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

  THE NAME MAY COME FROM THE APP DATABASE, AND ONLY ON TWO RUNGS. The
  archive's own `display_name` is null for 100 of 100 projects on this
  install, so the face has been drawing the SLUG. The server now sends
  `app_display_name` beside it with an `app_name_source` saying how it
  was matched; `nav-app-name.ts` holds the refusal and this file only
  draws what `presentationFor` resolved. 27 of 100 legitimately do not
  resolve and those cards still draw the path, which is the correct
  answer and not a gap.

  THE SOURCE IS ON THE ELEMENT, NOT ONLY IN THE TOOLTIP. `data-app-name-
  source` carries the rung verbatim and `data-app-named` says whether
  the face is showing the app's name, so a test asserts the refusal
  rather than reading prose out of a title attribute.
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
    /**
     * The hover sentence. THE DESCRIPTION AND THE REFUSAL BOTH LIVE
     * HERE BECAUSE HERE COSTS NO PIXELS. `app_description` exists on 4
     * of 100 projects and one of them is the only thing that tells two
     * confusingly similar entries apart, so it has to be reachable; a
     * line on the face would cost every card height, on a card this
     * change is shortening. The refusal is the same bargain in reverse:
     * a card drawing a path can say WHY on hover, and 27 of them do.
     */
    const title = $derived([
        pres.name,
        tip,
        pres.app.description ? `about: ${pres.app.description}` : '',
        pres.app.refusal,
    ].filter(Boolean).join('\n'));
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
    data-app-name-source={pres.app.source ?? undefined}
    data-app-named={pres.fromApp ? 'true' : undefined}
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

            <!--
              THE CLOSING BRACKETS ARE HUGGED, AND IT IS THE WHOLE POINT
              OF THIS BLOCK. Every span below sits in ONE inline
              formatting context, so a newline in the SOURCE between two
              of them collapses to a rendered SPACE - on top of the
              margin the stylesheet already put there for exactly that
              job. The vanilla renderer builds this run with
              `appendChild` and emits no text node at all, so the two
              were never spacing this sentence the same way.

              Measured on the parity page, 98 rows, per gap:
                4 -> sessions   vanilla 4.34px   ours 12.06px
                sessions -> of  vanilla 6.39px   ours 12.96px
                of -> 262       vanilla 4.34px   ours 12.06px
                262 -> total    vanilla 4.34px   ours 12.06px
              That is about 29px of extra space inside one line, which
              is why the run read as four loose tokens rather than as
              the one sentence the stylesheet's header says it is, and
              why it ellipsised sooner than it had to.

              IT IS INVISIBLE TO A BOX MEASUREMENT, which is how it
              survived a 98-row parity pass that found zero
              disagreements. The run is `white-space: nowrap` inside a
              truncating block of fixed width, so 29px of extra word
              space changes no element's box - it is spent out of the
              ellipsis budget instead. Compare the TEXT, not only the
              geometry, when a run looks wrong and measures right.
            --><span class={CLASS.counts} title={counts.title}><span
                    class="{CLASS.count} {CLASS.countSessions}"
                    data-count="sessions"
                    data-session-state={counts.session.state}
                ><span class={CLASS.countValue}>{counts.sessionText}</span><span
                    class={CLASS.countNoun}>sessions</span></span><span
                    class="{CLASS.count} {CLASS.countTotal}"
                    data-count="transcripts"
                ><span class={CLASS.countOf}>of</span><span
                    class={CLASS.countValue}>{counts.totalText}</span><span
                    class={CLASS.countNoun}>total</span></span></span>

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

<!--
  THE DENSITY PASS LIVES HERE, SCOPED, AND NOT IN client/css.

  WHY NOT THE SHARED STYLESHEET. `client/css/archive-nav-card.css` is
  loaded by the vanilla app that is still shipping. A rule added there
  would compact the LIVE rail, not only this port, which is a change
  nobody asked for on a screen this work is not replacing yet. Svelte's
  own scoping is the one mechanism that cannot reach the vanilla tree:
  these rules match only elements this component wrote. The cost is one
  generated `svelte-<hash>` class in the markup, which is named in
  `nav-vocab.ts` and admitted by `NavRail.commitments.test.ts` rather
  than quietly tolerated.

  IT IS A HIERARCHY CHANGE, NOT A SHRINK. Every number below was
  measured before and after on the parity page's 98 real rows.

  1. THE METADATA WAS TALLER THAN THE NAME IT DESCRIBED. Measured: the
     counts line occupied 21.55px against the project name's 16.00px,
     so the secondary line owned 35 percent more vertical space than
     the primary one. The cause is a UNIT, not a size:
     `line-height: 1.45` is unitless, so it inherits as a FACTOR, and
     the sessions figure at `1.15em` (14.72px) therefore computed its
     OWN line-height at 21.34px and inflated the strut of 15.78px that
     the block had asked for. Declaring the line-height as a LENGTH
     ends that: a length is inherited as a length, so a larger inline
     child can no longer rescale the line box it sits in.

     It was also visibly OFF-CENTRE because of it. The "of 718 total"
     half of the sentence sat 4.00px below the top of its line box and
     2.55px above the bottom - a 1.45px imbalance on a run that reads
     as one line. That is the "spacing on the session count is not
     right" complaint, and it is geometry rather than taste.

  2. THE ACCENT WAS SPENT ON THE NOUN AS WELL AS THE FIGURE. `sessions`
     and `total` inherited the accent colour and the 600 weight from
     their own count span, so the whole phrase read as a headline
     beside a truncated project name. The FIGURE carries the
     information; the noun is a unit label. Only the figure keeps the
     accent now.

     THE FOUR SIGNALS THAT TELL THE TWO COUNTS APART ARE ALL STILL
     THERE, which is the constraint this had to respect: different
     words, the `of` connective, the size step (`1.15em`, untouched),
     and accent against muted. The contrast measurement in
     `archive-nav-card.css`'s header - accent 8.80:1 and muted 5.70:1
     on legacy_windows - is a decision about the FIGURE and the FIGURE
     still carries it. The noun moves from accent to the same muted
     token the total already used, so it is not dropping below
     anything that was measured.

  3. THE TYPE SCALE. The name stays at 0.9rem/14.4rem and weight 600
     and is deliberately NOT shrunk: it is the only thing anyone scans
     a 98 row rail for, and compacting a list by making its scan target
     smaller buys height at the cost of the job the list does. The two
     metadata fields drop one step to 0.625rem/10px, which puts the
     name at 1.44x the metadata. Before, the step was 14.4/10.88 =
     1.32, which is inside the range a reader reads as "the same size,
     slightly off" rather than as a deliberate tier.

  4. THE VERTICAL PADDING AND GAPS come in only after the above,
     because they are the part that is purely taste. 9px to 7px, 3px
     gaps to 2px, 6px between cards to 5px.

  HORIZONTAL SPACING IS UNTOUCHED ON PURPOSE. The 12px left padding is
  the text's relationship to the 3px inset accent rail and the 6px
  right is the info button's divider; neither is density and both would
  cost the card its shape.

  5. THE COUNTS AND THE DATE SHARE ONE LINE, AND THE TRUNCATION WAS
     SOLVED RATHER THAN ACCEPTED. This was refused once, on the correct
     measurement that both runs are `nowrap` and the counts run already
     ellipsises on four-digit totals - so a naive merge would truncate
     the DATE, which is the value the rail's default order is built on.
     The owner has since asked for it in as many words, so it is built,
     and the refusal's own reasoning is what picks the mechanism.

     `card-main` is a GRID, not a flex row, and that is the whole fix.
     Two tracks, `minmax(0, 1fr) auto`: the `auto` track is sized by the
     date's own content and therefore CANNOT be compressed, and the
     `minmax(0, ...)` track lets the counts shrink below their intrinsic
     width, which is the one thing a default `1fr` refuses to do. So the
     date always renders in full and the counts spend the shortfall on
     their existing ellipsis. THE ELLIPSIS ALREADY WORKS on that run and
     was not re-invented: `.archive-nav__counts` is a block of inline
     text precisely so `text-overflow` applies to it, which the shared
     stylesheet's own header explains at length.

     WHAT GETS CUT FIRST IS THE LEAST LOAD-BEARING THING ON THE CARD.
     The run reads "4 sessions of 262 total" and the ellipsis eats it
     from the right, so the order of loss is `total`, then the total
     FIGURE, then `of` - the session count, which is the number a person
     is actually scanning for, is the last thing to go, and the full
     sentence plus both figures stay on the block's `title`.

     A FLEX ROW WAS TRIED FIRST AND IS WRONG HERE. Flex would put the
     ellipsis on a flex ITEM whose own children overflow, which does not
     ellipsise at all - the shared stylesheet records that exact failure
     happening once already, with `scrollWidth === clientWidth` on a
     visibly chopped row, so every programmatic check called it clean.
-->
<style>
    /* The gap between cards. Part of the card metaphor at zero radius,
     * so it is reduced rather than removed. */
    .archive-nav__node--project {
        margin-bottom: 5px;
    }

    .archive-nav__node--project .archive-nav__card-main {
        /* Vertical only. The 12px left and 6px right are the accent
         * rail's and the info divider's, not density. */
        padding-top: 7px;
        padding-bottom: 7px;
        /* TWO TRACKS, AND THE DATE'S IS `auto` ON PURPOSE. The shared
         * sheet declares one `minmax(0, 1fr)` column and stacks all
         * three children. The second track here is sized by the date's
         * own content, so it can never be compressed; the first keeps
         * the `minmax(0, ...)` floor the shared rule already had, which
         * is what lets the counts shrink past their intrinsic width and
         * reach their own ellipsis. A bare `1fr` would refuse to, and
         * the row would push the date out of the card instead. */
        grid-template-columns: minmax(0, 1fr) auto;
        row-gap: 2px;
        /* Wide enough that a truncated counts run cannot be misread as
         * running into the date. */
        column-gap: 10px;
        align-items: baseline;
    }

    /* The name keeps its own line: it is the scan target and is already
     * truncating on a rail this narrow. */
    .archive-nav__node--project .archive-nav__label {
        grid-column: 1 / -1;
    }

    .archive-nav__node--project .archive-nav__counts {
        grid-column: 1;
    }

    /* Right-aligned against the info divider, so the dates form a
     * column a reader can scan down rather than sitting ragged behind
     * counts runs of four different lengths. */
    .archive-nav__node--project .archive-nav__when {
        grid-column: 2;
        justify-self: end;
    }

    /* THE LINE-HEIGHT IS A LENGTH, NOT A FACTOR. See the note above:
     * a unitless value is inherited by the 1.15em sessions figure and
     * rescaled by it, which is what inflated this line box to 21.55px
     * and pushed its text off centre. 14px is chosen against the 10px
     * font: it clears the 11.5px figure's content box and leaves the
     * run symmetric in its own line. */
    .archive-nav__node--project .archive-nav__counts,
    .archive-nav__node--project .archive-nav__when {
        font-size: 0.625rem;
        line-height: 14px;
    }

    /* THE SIZE ABOVE IS NOT INHERITED BY THE TWO COUNT GROUPS, AND
     * BELIEVING IT WAS IS HOW THIS SHIPPED HALF DONE ONCE ALREADY.
     * `archive-nav.css` declares `.archive-nav__count { font-size:
     * 0.8rem }` directly on both of them, so setting the size on their
     * container demoted nothing anybody could see: measured, the
     * container read 10px while the visible run was still 12.8px and
     * the sessions figure still 14.72px, exactly as before the change.
     * The line-height above IS inherited, which is why the line box
     * shrank and made it look as though the demotion had landed.
     * Measure the text, not the box that holds it. */
    .archive-nav__node--project .archive-nav__count {
        font-size: 0.625rem;
    }

    /* The unit label recedes; the figure beside it keeps the accent. */
    .archive-nav__node--project .archive-nav__count-noun {
        color: var(--color-fg-muted);
        font-weight: 400;
    }
</style>
