<!--
  Glyph - one 16x16 icon, drawn as real SVG elements.

  THE POINT OF THIS COMPONENT IS THE ABSENCE OF `{@html}`. The legacy
  tree hands its icons around as SVG strings, which is right for an
  `innerHTML` renderer and unusable here: Svelte escapes text, so a
  string can only reach the DOM through a raw block, and the migration
  plan names a raw block as its review trigger. This reads the SAME
  coordinates out of client/js/icons/glyphs.js and emits `<path>` and
  `<rect>` elements, so there is nothing to escape and nothing to trust.

  ONE SET OF COORDINATES, TWO RENDERERS. `SessionStatusUI.pencilIconSvg`
  builds its string from that same module. A copy of the geometry in each
  tree is the DRY violation with the most visible failure mode there is.

  NO COLOUR IS SET ANYWHERE. Every stroke is `currentColor`, so the
  button's own CSS `color` drives it and all 26 themes work with no theme
  work.
-->
<script lang="ts">
    import {
        GLYPHS,
        GLYPH_SIZE,
        GLYPH_VIEWBOX,
    } from '../../../client/js/icons/glyphs.js';

    interface Props {
        /** A key of GLYPHS, e.g. 'pencil' or 'archive'. */
        name: string;
    }

    let { name }: Props = $props();

    /**
     * One SVG element's attributes, as the glyph data carries them.
     *
     * Every value is a string because that is what an SVG attribute is.
     * The enum-narrowed DOM typings for `stroke-linecap` and
     * `stroke-linejoin` are cast at the binding rather than modelled
     * here: the allowed set lives in client/js/icons/glyphs.js, which is
     * plain JS read by four consumers, and encoding an SVG enum in a
     * type only this one of them can see would be a second source of
     * truth about the same values.
     */
    type GlyphElement = Record<string, string | undefined>;

    /**
     * The elements for this glyph.
     *
     * An UNKNOWN NAME RENDERS NOTHING AND SAYS SO. A silent empty icon
     * looks exactly like a CSS problem, and this is a developer mistake
     * that should name itself.
     */
    const elements = $derived.by(() => {
        const found = (GLYPHS as Record<string, GlyphElement[]>)[name];
        if (!found) {
            console.error('CloudeWeb: no glyph named', name);
            return [];
        }
        return found;
    });
</script>

<svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox={GLYPH_VIEWBOX} fill="none">
    {#each elements as element (element.d ?? element.x)}
        {#if element.tag === 'rect'}
            <rect
                x={element.x}
                y={element.y}
                width={element.width}
                height={element.height}
                rx={element.rx}
                stroke={element.stroke}
                stroke-width={element['stroke-width']}
            />
        {:else}
            <path
                d={element.d}
                stroke={element.stroke}
                stroke-width={element['stroke-width']}
                stroke-linecap={element['stroke-linecap'] as 'round' | undefined}
                stroke-linejoin={element['stroke-linejoin'] as 'round' | undefined}
                fill={element.fill}
            />
        {/if}
    {/each}
</svg>
