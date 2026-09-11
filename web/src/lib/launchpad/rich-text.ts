/**
 * Expand the help prose's inline markers into renderable segments.
 *
 * WHY THIS EXISTS AT ALL. The help disclosure is the longest prose this
 * app owns, and almost every paragraph in it carries an inline `<code>`
 * span. The obvious port splits each paragraph into the fragments around
 * those spans and hands each fragment to `t()` - which fixes the english
 * word order into the template and makes the paragraph untranslatable,
 * because word order is exactly what a translation changes. So the whole
 * paragraph stays ONE catalog message and carries markers a translator
 * can move with the words.
 *
 * IT IS A MARKER SET, NOT A MINI-LANGUAGE, and that distinction is the
 * whole of why it is allowed. `[[x]]` is code, `((x))` is emphasis,
 * `<<x>>` is the one link. No expressions, no attributes, no nesting, one
 * left-to-right pass, and nothing is ever compiled - `script-src 'self'`
 * forbids `new Function` and this reaches for neither it nor `eval`. See
 * .claude/notes/i18n-design.md section 3 for why a runtime MessageFormat
 * was refused for the same reason.
 *
 * IT RETURNS DATA, NEVER MARKUP. The caller renders segments with an
 * `{#each}` and Svelte's own `{expr}` escaping, so there is no `{@html}`
 * anywhere on this path and a session name or a server detail that
 * reached a message could not become markup. The plan's section 4 names
 * an `{@html}` as the review trigger for this screen; this is how the
 * one surface that needed rich text avoids being one.
 */

/** What a segment is rendered as. */
export type RichKind = 'text' | 'code' | 'em' | 'link';

/** One run of a paragraph, already decided. */
export interface RichSegment {
    /** How to render `text`. */
    kind: RichKind;
    /** The literal characters. Never markup, always escaped by Svelte. */
    text: string;
}

/**
 * The three markers, longest-open-delimiter first so the scan is
 * unambiguous. Kept as data so adding a fourth is one entry and the
 * splitter below does not grow a branch.
 */
const MARKERS: ReadonlyArray<{ open: string; close: string; kind: RichKind }> = [
    { open: '[[', close: ']]', kind: 'code' },
    { open: '((', close: '))', kind: 'em' },
    { open: '<<', close: '>>', kind: 'link' },
];

/**
 * Split one message into renderable segments.
 *
 * Description: walks the string once. At each position it looks for the
 *   EARLIEST opening marker that also has a closing one after it; an
 *   unclosed marker is left verbatim as text, which is the same refusal
 *   `format.js` makes for a `{hole}` with no value - a malformed message
 *   shows what is wrong on screen rather than silently losing half a
 *   sentence.
 * Inputs: message - a catalog message, already translated and
 *   interpolated.
 * Output: RichSegment[]. Never empty for a non-empty input.
 * Example: richSegments('run [[ls]] now')
 *   // [{kind:'text',text:'run '},{kind:'code',text:'ls'},
 *   //  {kind:'text',text:' now'}]
 */
export function richSegments(message: string): RichSegment[] {
    const src = String(message ?? '');
    const out: RichSegment[] = [];
    let cursor = 0;
    while (cursor < src.length) {
        let bestAt = -1;
        let best: (typeof MARKERS)[number] | null = null;
        let bestEnd = -1;
        for (const marker of MARKERS) {
            const at = src.indexOf(marker.open, cursor);
            if (at === -1) continue;
            const end = src.indexOf(marker.close, at + marker.open.length);
            if (end === -1) continue;
            if (bestAt === -1 || at < bestAt) {
                bestAt = at;
                best = marker;
                bestEnd = end;
            }
        }
        if (!best || bestAt === -1) {
            out.push({ kind: 'text', text: src.slice(cursor) });
            break;
        }
        if (bestAt > cursor) {
            out.push({ kind: 'text', text: src.slice(cursor, bestAt) });
        }
        out.push({
            kind: best.kind,
            text: src.slice(bestAt + best.open.length, bestEnd),
        });
        cursor = bestEnd + best.close.length;
    }
    return out.filter((segment) => segment.text !== '' || segment.kind !== 'text');
}
