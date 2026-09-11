/**
 * The icon glyphs, as DATA, so both trees can draw them.
 *
 * WHY THIS FILE EXISTS. `client/js/session-status-ui.js` builds each icon
 * by concatenating an SVG string, which is exactly right for a tree that
 * renders through `innerHTML` and exactly wrong for one that does not.
 * Svelte escapes TEXT, so an SVG string can only reach the DOM through
 * `{@html}` - and the migration plan names a raw block as its review
 * trigger, because the day one of those values stops being a hardcoded
 * literal is the day it becomes an injection and nobody notices.
 *
 * SO THE PATH DATA IS THE SHARED THING, NOT THE MARKUP. The legacy
 * builder concatenates these into a string; a Svelte component renders
 * the same records as real `<path>` and `<rect>` elements. ONE set of
 * coordinates, two renderers. The alternative - a copy of the geometry
 * in each tree - is the DRY violation with the most visible failure
 * mode there is: the same button drawn two different shapes on two
 * screens.
 *
 * THIS FILE IS DATA, NOT CODE, for the same reason the message catalog
 * is: it is read by an ES module, a classic script through
 * `globalThis.CloudeGlyphs`, vitest and the node suite, and a value that
 * can run is a value that can reach for something one of them lacks.
 *
 * EVERY GLYPH IS 16x16 AND USES `currentColor`. No colour is set on any
 * element here, so the caller's CSS `color` drives it - which is what
 * keeps all 26 themes working with no theme work.
 */

/** The viewBox every glyph in this file is drawn in. */
export const GLYPH_VIEWBOX = '0 0 16 16';
/** The rendered size, in CSS pixels. */
export const GLYPH_SIZE = 16;

/**
 * One drawable element of a glyph.
 *
 * Description: `tag` is `path`, `rect` or `circle`; every other key is an SVG
 *   attribute, in the SVG's own kebab-case spelling so both renderers
 *   emit it verbatim.
 * @typedef {Object<string, string|number>} GlyphElement
 */

/**
 * The glyphs, keyed by name.
 *
 * @type {Object<string, GlyphElement[]>}
 */
export const GLYPHS = {
    /** Edit. A pencil over its stroke line. */
    pencil: [
        {
            tag: 'path',
            d: 'M10.5 2.5L13.5 5.5L5.5 13.5H2.5V10.5L10.5 2.5Z',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
        {
            tag: 'path',
            d: 'M9 4L12 7',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
    ],
    /** Archive. A lidded box with a handle slot. NOT a trash can: this
     *  operation keeps everything, and an icon that says otherwise is a
     *  lie the user acts on before reading the tooltip. */
    archive: [
        {
            tag: 'rect',
            x: '2',
            y: '2.75',
            width: '12',
            height: '3',
            rx: '0.75',
            stroke: 'currentColor',
            'stroke-width': '1.5',
        },
        {
            tag: 'path',
            d: 'M3.25 5.75V12.5C3.25 12.9142 3.58579 13.25 4 13.25H12C12.4142 13.25 12.75 12.9142 12.75 12.5V5.75',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linejoin': 'round',
        },
        {
            tag: 'path',
            d: 'M6.5 8.5H9.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
    ],
    /** Close. Two crossed strokes. In this app an X means "stop the
     *  running process, keep the record"; the trash can means "forget the
     *  record, stop nothing". The two are bound to different operations in
     *  client/js/session-row-actions.js and must never be confusable. */
    close: [
        {
            tag: 'path',
            d: 'M4 4L12 12',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
        {
            tag: 'path',
            d: 'M12 4L4 12',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
    ],
    /** Remove from the list. A trash can. See `close` for the semantics
     *  the two glyphs are bound to; drawing either one for the other is a
     *  lie the user acts on before reading the tooltip. */
    trash: [
        {
            tag: 'path',
            d: 'M3 4.5H13',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
        {
            tag: 'path',
            d: 'M5.5 4.5V3.25C5.5 2.83579 5.83579 2.5 6.25 2.5H9.75C10.1642 2.5 10.5 2.83579 10.5 3.25V4.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
        {
            tag: 'path',
            d: 'M4.5 4.5L5 12.75C5 13.1642 5.33579 13.5 5.75 13.5H10.25C10.6642 13.5 11 13.1642 11 12.75L11.5 4.5',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
        {
            tag: 'path',
            d: 'M6.5 6.75V11',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
        {
            tag: 'path',
            d: 'M9.5 6.75V11',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
    ],
    /** Restart the agent. A CIRCULAR ARROW, deliberately, not a play
     *  triangle: play reads as "begin something new", and this puts a
     *  process back into a pane that already exists and keeps its
     *  scrollback, its name and its place in the list. It sits beside a
     *  destructive neighbour, so the shape has to say "again". */
    restart: [
        {
            tag: 'path',
            d: 'M13 8A5 5 0 1 1 11.4 4.3',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
        },
        {
            tag: 'path',
            d: 'M12.9 1.9V5.1H9.7L12.9 1.9Z',
            fill: 'currentColor',
        },
    ],
    /** Mark unread, "not flagged" state. A plain envelope outline. */
    'envelope-outline': [
        {
            tag: 'rect',
            x: '2',
            y: '3.5',
            width: '12',
            height: '9',
            rx: '1.25',
            stroke: 'currentColor',
            'stroke-width': '1.5',
        },
        {
            tag: 'path',
            d: 'M2.5 4.25L8 8.5L13.5 4.25',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
    ],
    /** Mark unread, "flagged" state. The same envelope plus a solid dot,
     *  so the two states differ by SHAPE and not by colour alone. */
    'envelope-filled': [
        {
            tag: 'rect',
            x: '2',
            y: '3.5',
            width: '12',
            height: '9',
            rx: '1.25',
            stroke: 'currentColor',
            'stroke-width': '1.5',
        },
        {
            tag: 'path',
            d: 'M2.5 4.25L8 8.5L13.5 4.25',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
        {
            tag: 'circle',
            cx: '12.5',
            cy: '3.5',
            r: '2.5',
            fill: 'currentColor',
            stroke: 'var(--color-bg, #000)',
            'stroke-width': '0.75',
        },
    ],
};

/**
 * Build one glyph as a self-contained SVG string.
 *
 * Description: FOR THE LEGACY TREE ONLY. Anything that renders through
 *   `innerHTML` calls this; a Svelte component reads `GLYPHS` and emits
 *   real elements instead. Attribute values here are the file's own
 *   constants, never caller input, which is why concatenation is safe -
 *   and why the argument is a NAME rather than a set of attributes.
 * Inputs: name (string) - a key of GLYPHS.
 * Output: string - an `<svg>` element, or '' for an unknown name.
 * Example: glyphSvg('pencil')  // '<svg width="16" ...>...</svg>'
 */
export function glyphSvg(name) {
    const elements = GLYPHS[name];
    if (!elements) return '';
    let out = '<svg width="' + GLYPH_SIZE + '" height="' + GLYPH_SIZE
        + '" viewBox="' + GLYPH_VIEWBOX + '" fill="none">';
    for (const element of elements) {
        out += '<' + element.tag;
        for (const key of Object.keys(element)) {
            if (key === 'tag') continue;
            out += ' ' + key + '="' + element[key] + '"';
        }
        out += '/>';
    }
    return out + '</svg>';
}
