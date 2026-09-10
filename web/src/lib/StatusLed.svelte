<!--
  StatusLed - the session status light, as a Svelte 5 component.

  WHAT IT IS FOR. This is the first real screen element ported out of
  client/js and it is deliberately the smallest one that is still load
  bearing: every surface in the app (sidebar row, launchpad card, project
  tree, terminal header) paints its light through the same ladder, so the
  port had to agree with the legacy renderer exactly or the migration
  would have started by making the status lights disagree with each other.

  NOTHING CALLS IT YET. The legacy parents still build their rows as HTML
  strings and set them with innerHTML, so there is no place to mount a
  component into without rewriting a parent. That rewrite is a later
  round. For now this component is compiled, bundled and exercised - see
  window.CloudeWeb.renderProbe() in src/main.ts - and the string form in
  src/lib/status-dot.ts is what a legacy caller would use.

  THE COLOURS ARE NOT HERE. The LED is painted entirely by
  client/css/status-led.css, keyed off `data-inner` and `data-outer`, and
  that stylesheet is already loaded globally by client/index.html. Two
  copies of a colour ladder is two colour ladders. The Tailwind classes on
  the wrapper do layout only.
-->
<script lang="ts">
    import { ledStateFor } from './led';
    import { labelWithSource, normalizeStatus, STATUS_DOT_CLASS } from './status-dot';

    /**
     * Props. Every one is optional and every one degrades to
     * not-measured rather than to a confident answer.
     */
    interface Props {
        /** Raw `activity_status` from a `/sessions/list` row. */
        status?: string | null;
        /** Selects the green `done` dot over the grey `idle` one at rest. */
        unread?: boolean;
        /** `awaiting_startup_prompt` means the pane needs a keypress. */
        startupGate?: string | null;
        /** Where the status came from; renders in the tooltip only. */
        statusSource?: string | null;
        /**
         * Whether THIS browser holds a live socket for this session.
         *
         * NOT a server fact and never mixed with one: no `/sessions/list`
         * response can report it. A `disconnected` transport OUTRANKS
         * every other signal in `ledStateFor`, because nothing on screen
         * is trustworthy while the socket is down. Slice 4 added the prop:
         * the legacy tree and running rows both passed it to
         * `SessionStatusUI.dotHtml` and this component silently dropped
         * it, so a disconnected session painted a confident dot.
         */
        transport?: string | null;
        /** CSS length for the whole LED, e.g. '9px'. */
        size?: string | null;
        /** When true, the label is shown beside the light as text. */
        showLabel?: boolean;
    }

    let {
        status = null,
        unread = false,
        startupGate = null,
        statusSource = null,
        transport = null,
        size = null,
        showLabel = false,
    }: Props = $props();

    const key = $derived(normalizeStatus(status));
    const led = $derived(
        ledStateFor({
            activity_status: key,
            unread,
            startup_gate: startupGate,
            transport,
        }),
    );
    const label = $derived(labelWithSource(key, statusSource));
    const dotClass = $derived(STATUS_DOT_CLASS[key] ?? 'unknown');
    // Only a plain CSS length is accepted, the same allowlist ledHtml
    // applies. Anything else is dropped rather than sanitised: the value
    // lands in a style attribute.
    const sizeVar = $derived(
        typeof size === 'string' && /^[0-9]+(\.[0-9]+)?(px|rem|em)$/.test(size)
            ? `--led-size: ${size}`
            : null,
    );
</script>

<span class="tw:inline-flex tw:items-center tw:gap-1.5 tw:align-middle">
    <span
        class="status-dot status-dot--{dotClass} status-led"
        data-inner={led.inner}
        data-outer={led.outer}
        role="img"
        title={label}
        aria-label={label}
        style={sizeVar}
    ></span>
    {#if showLabel}
        <span class="tw:text-xs tw:leading-none tw:opacity-70">{label}</span>
    {/if}
</span>
