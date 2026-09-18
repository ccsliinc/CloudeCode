<!--
  NavInfoModal - everything a project card has no room for.

  THE MODAL STACK IS A PROP, NOT A GLOBAL, AND THAT IS THE SECOND
  app-screen GAP THIS SLICE HIT. `client/js/modal-stack.js` is the ONE
  place that knows which modal is on top, and it owns the capture-phase
  Escape router, the background scroll lock, the covered-overlay inert
  marking and the focus restore. A hand-rolled overlay would register a
  second document-level Escape listener, which is the exact defect
  ModalStack was written to fix: one keypress reaching two handlers and
  collapsing the whole stack. `docs/archive-shell-contract.md` records
  `window.ModalStack` as a REQUIRED host global that survives all nine
  slices - but `AppScreen.mount(container, route, context, api)` has no
  way to hand one to a screen, and this tree reaches for no global. So it
  arrives as `stack`, the same temporary seam slice 6 used for its
  scrollport, and it is what gets replaced when the surface grows a way
  to say this.

  A NULL STACK IS A WORKING DIALOG WITH NO ESCAPE ROUTING, not a broken
  one: the close button and the backdrop still close it. That is
  degraded and visible, rather than an exception on the only way into the
  archive.

  THE OVERLAY IS PORTALLED, AND THAT IS NOT COSMETIC. `ModalStack`'s
  capture-phase Escape router refuses to act unless the top registered
  entry is the LAST `:scope > .modal-overlay` on `document.body`
  (`modal-stack.js:115`, `topIsOutermost`) - the check that stops an
  unregistered confirm dialog layered above the stack from having
  somebody else's Escape stolen from underneath it. An overlay rendered
  inside the rail's own subtree is not a child of body at all, so that
  query returns nothing, `topIsOutermost` answers false and ESCAPE
  SILENTLY STOPS CLOSING THE MODAL. Nothing throws and nothing logs. So
  `host` moves the overlay node to wherever the composition root says
  overlays live, in the SAME effect that registers it, before the push -
  an overlay pushed from a position the stack cannot see is exactly the
  failure being avoided.

  `.modal-overlay` IS `position: fixed; z-index: 9999` (styles.css:2195),
  so it covers the viewport from wherever it is parented, PROVIDED no
  ancestor creates a containing block. Measured before relying on it:
  `archive-nav.css` and `archive-panes.css` declare no `transform`, no
  `filter`, no `will-change` and no `contain`, so today an unportalled
  overlay still paints correctly and only its Escape routing is lost.
  That is precisely the kind of half-working that a portal removes.

  `modal-overlay` IS THE APP'S OWN CLASS and is not ours to rename.
  ModalStack enumerates `:scope > .modal-overlay` on the body to decide
  whether a foreign dialog has been layered over the stack; a different
  class here would make this modal invisible to that check.

  A MACHINE LIST THAT WAS NEVER REPORTED IS NOT AN EMPTY MACHINE LIST.
  See `nav-info.ts`.

  `tabindex="-1"` ON THE DIALOG IS A FORCED ADDITION, named because
  commitment 3 asks for that. The vanilla dialog carried `role="dialog"`
  with no tabindex, which the Svelte a11y checker flags: a container
  with an interactive role has to be focusable. It is an ATTRIBUTE, not
  a class and not a stylesheet edit, it makes the dialog programmatically
  focusable rather than tab-reachable, and it paints nothing.

  A CLICK ON THE BACKDROP CLOSES; A CLICK INSIDE MUST NOT. The dialog
  stops the event before it reaches the overlay rather than the overlay
  testing the target, because target testing breaks the moment a child is
  replaced.
-->
<script lang="ts">
    import { CLASS, INFO_CLASS } from './nav-vocab';
    import { countFor, renderCount, type NavRowData } from './nav-row';
    import { NODE_KINDS } from './nav-vocab';
    import { NOT_KNOWN } from './format';
    import {
        infoField, machineRows, machinesHeading, machinesUnevaluated,
    } from './nav-info';
    import { appNameSentence } from './nav-app-name';
    import type { ModalStackLike } from './keys-help';
    import { SESSION_REASONS, SESSION_STATES, sessionCountFor, type Presentation } from './nav-card';
    import NavOutcome from './NavOutcome.svelte';

    interface Props {
        row: NavRowData;
        /** The card's resolved presentation. */
        presentation: Presentation;
        /** The host's modal stack, or null. See the header. */
        stack?: ModalStackLike | null;
        /**
         * Where overlays live. `document.body` for this app, because
         * that is where `ModalStack` looks. Null leaves the overlay in
         * the rail's own subtree, which still PAINTS correctly and
         * loses Escape routing - see the header.
         */
        host?: Element | null;
        /** Turns an envelope into an element, for the machines refusal. */
        renderOutcome?: ((envelope: unknown) => Element | null) | null;
        /** Narrow the rail to one machine. This closes first. */
        onFilterHost?: (hostId: number | string, hostName: string) => void;
        /** Take the modal down. */
        onClose?: () => void;
    }

    let {
        row, presentation, stack = null, host = null, renderOutcome = null,
        onFilterHost, onClose,
    }: Props = $props();

    let overlayEl = $state<HTMLDivElement | null>(null);
    let closeEl = $state<HTMLButtonElement | null>(null);

    const heading = $derived(machinesHeading(row.hosts));
    const machines = $derived(machineRows(row));
    const session = $derived(sessionCountFor(row));

    /**
     * THE FULL PATH, AND WHY IT HAS A SECOND SOURCE NOW. `observed_cwd`
     * is the ARCHIVE's own record and it is null for 100 of 100
     * projects on this install, so this field said NOT KNOWN on every
     * card it was ever opened on. `app_name_cwd` is the working
     * directory the cwd naming rung read out of the transcripts
     * themselves, and it is the only place the real spelling survives.
     * It is a FALLBACK, not a replacement: the archive's own reading
     * wins whenever there is one, because a corpus collected on another
     * machine has no cwd rung behind it and its `observed_cwd` is then
     * the only honest answer there is.
     *
     * IT IS ALSO WHERE A SCRATCH ROW'S PATH STAYS REACHABLE. The card
     * face draws `scratch / <leaf>` for 17 projects precisely so a
     * 178-character temp path does not sit in the rail; that shortening
     * is only defensible while the long form is one click away.
     */
    const pathField = $derived(infoField(
        'Full path', row.observed_cwd ?? presentation.app.cwd,
        'NOT KNOWN - the server observed no working directory for this project',
    ));
    const slugField = $derived(infoField(
        'Slug', row.full_path ?? row.slug, 'NOT KNOWN - no slug was reported',
    ));
    /**
     * WHERE THE NAME CAME FROM, AND WHY IT IS A FIELD RATHER THAN A
     * SILENCE. The face shows one string; on 27 of 100 projects that
     * string is a path, and the person looking at it has no way to tell
     * "the app has no project here" from "the app database could not be
     * read". This says which, in a sentence, for both outcomes.
     */
    const nameSourceField = $derived(infoField(
        'Name from', appNameSentence(presentation.app),
        'NOT KNOWN - this server reported no naming provenance',
    ));
    /**
     * THE APP'S OWN DESCRIPTION, WHICH EXISTS ON 4 OF 100 PROJECTS AND
     * EARNS ITS PLACE ON ONE OF THEM: it is the only thing that tells a
     * confusing near-duplicate apart from its twin. It is drawn only
     * when there is one, because an empty "About" row on 96 cards is
     * furniture, and it rides the same approval as the name itself - a
     * description is a claim about a project row we would otherwise
     * have declined to name.
     */
    const descriptionField = $derived(presentation.app.description
        ? infoField('About', presentation.app.description, '')
        : null);
    const sessionField = $derived(infoField(
        'Your sessions',
        session.state === SESSION_STATES.KNOWN ? renderCount(session.value) : null,
        `${NOT_KNOWN} - ${SESSION_REASONS[session.state] || ''}`,
    ));
    const totalField = $derived(infoField(
        'All transcripts', renderCount(countFor(NODE_KINDS.PROJECT, row)), '',
    ));

    /**
     * Whether the overlay section says anything. A disabled rename box
     * that cannot save is furniture, and furniture in a dialog reads as a
     * broken feature, so the section is drawn only when there is a fact
     * in it.
     */
    const overlayInteresting = $derived(
        presentation.renamed || !!presentation.group || presentation.hidden
            || presentation.overlayStatus === 'cannot_determine',
    );

    // PORTALLED THEN REGISTERED, IN ONE EFFECT AND IN THAT ORDER.
    // `ModalStack.topIsOutermost` reads the DOM at the moment Escape is
    // pressed, so what matters is that the node is parented under `host`
    // before anything can ask - and doing both here means there is no
    // window in which a pushed overlay is somewhere the stack cannot see.
    // Popped and un-portalled on teardown, so the push and the removal
    // can never diverge; the vanilla module had to route every exit
    // through one idempotent close() to get the same property.
    $effect(() => {
        const el = overlayEl;
        if (!el) return;
        if (host && el.parentNode !== host) host.appendChild(el);
        if (stack) stack.push(el, { onEscape: () => onClose?.() });
        return () => {
            if (stack) stack.pop(el);
            // REMOVED HERE, NOT HANDED BACK. Moving the node back to the
            // subtree it came from was tried and it leaked: Svelte's own
            // teardown removes the nodes it is holding by reference, and
            // re-appending to a parent that is itself being torn down in
            // the same pass left the overlay on screen after close. The
            // node was moved by this effect, so this effect takes it
            // out; a double removal is a no-op.
            if (host) el.remove();
        };
    });

    // Focus lands on the close button, which is where the vanilla modal
    // put it. ModalStack restores the previously focused element on pop,
    // and that is the ONLY focus restoration anywhere in this path.
    $effect(() => { closeEl?.focus(); });

    /** Narrow the rail to one machine. Closes FIRST, as the original did. */
    function pickHost(hostId: number | string, hostName: string): void {
        onClose?.();
        onFilterHost?.(hostId, hostName);
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={overlayEl}
    class="{INFO_CLASS.appOverlay} {INFO_CLASS.overlay}"
    data-modal="archive-nav-info"
    onclick={() => onClose?.()}
>
    <div
        class={INFO_CLASS.root}
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-label="Details for {presentation.name}"
        onclick={(e) => e.stopPropagation()}
    >
        <div class={INFO_CLASS.head}>
            <h2 class={INFO_CLASS.title} title={presentation.name}>{presentation.name}</h2>
            <button
                bind:this={closeEl}
                class={INFO_CLASS.close}
                type="button"
                data-action="close"
                aria-label="Close details"
                onclick={() => onClose?.()}
            >Close</button>
        </div>

        <div class={INFO_CLASS.body}>
            <section class={INFO_CLASS.section} data-section="path">
                <h3 class={INFO_CLASS.sectionTitle}>Where it is</h3>
                {#each [pathField, slugField, nameSourceField] as f (f.term)}
                    <div class={INFO_CLASS.field}>
                        <span class={INFO_CLASS.term}>{f.term}</span>
                        <span
                            class="{INFO_CLASS.value}{f.known ? '' : ` ${INFO_CLASS.valueUnknown}`}"
                            data-known={f.known ? 'true' : 'false'}
                        >{f.value}</span>
                    </div>
                {/each}
                {#if descriptionField}
                    <div class={INFO_CLASS.field} data-field="app-description">
                        <span class={INFO_CLASS.term}>{descriptionField.term}</span>
                        <span class={INFO_CLASS.value} data-known="true"
                        >{descriptionField.value}</span>
                    </div>
                {/if}
            </section>

            <section class={INFO_CLASS.section} data-section="counts">
                <h3 class={INFO_CLASS.sectionTitle}>What is in it</h3>
                {#each [sessionField, totalField] as f (f.term)}
                    <div class={INFO_CLASS.field}>
                        <span class={INFO_CLASS.term}>{f.term}</span>
                        <span
                            class="{INFO_CLASS.value}{f.known ? '' : ` ${INFO_CLASS.valueUnknown}`}"
                            data-known={f.known ? 'true' : 'false'}
                        >{f.value}</span>
                    </div>
                {/each}
                <p class={INFO_CLASS.note}>
                    Sessions are top-level conversations (session_ref_scheme = uuid).
                    The transcript total also counts agent sidechain files, which are
                    about 93 percent of this archive.
                </p>
            </section>

            <section
                class="{INFO_CLASS.section} {INFO_CLASS.sectionMachines}"
                data-section="machines"
                data-machines={heading.known ? String(machines.length) : 'cannot-determine'}
            >
                <h3 class={INFO_CLASS.sectionTitle}>Machines</h3>
                {#if heading.known}
                    <p class={INFO_CLASS.lede}>{heading.text}</p>
                    <ul class={INFO_CLASS.machines}>
                        {#each machines as m (m.name)}
                            <li class={INFO_CLASS.machine} data-host-name={m.name}>
                                {#if m.linkable}
                                    <button
                                        class={INFO_CLASS.machineLink}
                                        type="button"
                                        data-action="filter-host"
                                        data-host-id={String(m.host_id)}
                                        title="Show only the projects collected from {m.name}"
                                        onclick={() => pickHost(m.host_id as number | string, m.name)}
                                    >
                                        <span class={INFO_CLASS.machineName}>{m.name}</span>
                                        <span class={INFO_CLASS.machineCount}
                                        >{renderCount(m.transcript_count)} transcripts here</span>
                                    </button>
                                {:else}
                                    <!-- Named, unlinked, and SAYING it is unlinked.
                                         Silently rendering it as plain text would read
                                         as a styling choice. -->
                                    <span
                                        class={INFO_CLASS.machineLink}
                                        data-action="none"
                                        title="This machine has no id on this row, so the rail cannot be narrowed to it from here."
                                    >
                                        <span class={INFO_CLASS.machineName}>{m.name}</span>
                                        <span class={INFO_CLASS.machineCount}
                                        >{renderCount(m.transcript_count)} transcripts here</span>
                                    </span>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                {:else}
                    <ul class={CLASS.children}>
                        <NavOutcome envelope={machinesUnevaluated()} render={renderOutcome} />
                    </ul>
                {/if}
            </section>

            {#if overlayInteresting}
                <section
                    class={INFO_CLASS.section}
                    data-section="overlay"
                    data-overlay-status={presentation.overlayStatus || 'absent'}
                >
                    <h3 class={INFO_CLASS.sectionTitle}>Your labels</h3>
                    {#if presentation.overlayStatus === 'cannot_determine'}
                        <!-- The server says this project has neither an
                             observed_cwd nor an id, so no overlay row CAN attach
                             to it. That is not "nothing set" and must not render
                             as a blank panel. -->
                        <p class={INFO_CLASS.note}>
                            {NOT_KNOWN} - this project cannot be addressed by the
                            overlay, so it can never carry a name, a group or a
                            hidden flag. Nothing was set and nothing can be.
                        </p>
                    {:else}
                        {#if presentation.renamed}
                            <!-- The server's own name stays on screen beside the
                                 override. A rename that HIDES what a thing really
                                 is turns the modal into the second place you
                                 cannot find out. -->
                            <div class={INFO_CLASS.field}>
                                <span class={INFO_CLASS.term}>Shown as</span>
                                <span class={INFO_CLASS.value} data-known="true"
                                >{presentation.name}</span>
                            </div>
                            <div class={INFO_CLASS.field}>
                                <span class={INFO_CLASS.term}>Actual name</span>
                                <span class={INFO_CLASS.value} data-known="true"
                                >{presentation.serverName}</span>
                            </div>
                        {/if}
                        {#if presentation.group}
                            <div class={INFO_CLASS.field}>
                                <span class={INFO_CLASS.term}>Group</span>
                                <span class={INFO_CLASS.value} data-known="true"
                                >{presentation.group}</span>
                            </div>
                        {/if}
                        {#if presentation.hidden}
                            <div class={INFO_CLASS.field}>
                                <span class={INFO_CLASS.term}>Hidden</span>
                                <span class={INFO_CLASS.value} data-known="true"
                                >yes - hidden from the default list</span>
                            </div>
                        {/if}
                    {/if}
                </section>
            {/if}
        </div>
    </div>
</div>
