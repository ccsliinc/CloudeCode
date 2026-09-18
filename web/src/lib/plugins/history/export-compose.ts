/**
 * THE CLIENT-COMPOSED EXPORT: a set of search results, carried out of
 * the app, WITH THE EGRESS DOOR IN FRONT OF IT.
 *
 * THIS IS THE FILE THE SECURITY CONTROL IS POINTED AT. An export is the
 * whole thing leaving the app, so it is the one place where a leak is
 * permanent: a snippet on screen is gone when the tab closes, and a file
 * on a desktop is not. It is also the path nobody looks at, because
 * "export" reads like plumbing.
 *
 * IT CANNOT REACH PREVIEW TEXT EXCEPT THROUGH `mask-egress.ts`. The
 * composer takes `HitView` objects, which carry no `snippet` field and
 * no raw hit, and it builds every line through `exportLine`, which calls
 * `snippetEgress`. There is no argument to any function here that could
 * carry preview text in by another route: `hitLocator` is composed from
 * transcript id, session_ref, line and offset, none of which is body
 * content. That is a structural property, not a rule somebody remembered
 * to follow.
 *
 * A REFUSED PREVIEW BECOMES A STATED SUBSTITUTION, NEVER AN OMISSION.
 * Dropping a withheld hit from an export under-reports what the search
 * found, which is the same false green as a zero-hit `budget_exhausted`
 * rendered as `complete`, in a file instead of on a screen. So every hit
 * gets a line, and `withheld` counts are reported in the header.
 *
 * IT IS NOT THE ARCHIVE'S EXPORT AND SAYS SO IN ITS FIRST LINE. See
 * `export-vocab.ts`'s header: the byte-exact transcript export is the
 * server's, is never composed here, and must never be masked. This
 * artefact is lossy, masked and reordered, and it wears neither the
 * `.jsonl` extension nor the archive's name.
 *
 * NO BLOB, NO `URL.createObjectURL`, NO `<a download>`, NO CLIPBOARD
 * CALL. This module returns a STRING and a suggested filename. Whether
 * that string reaches a clipboard or a file is the host's business and
 * arrives as an injected `copyText` prop - see `SearchPanel.svelte` and
 * the fourth shell gap. A pure composer is also the only shape a test
 * can assert about without a browser.
 *
 * Pure. No DOM, no fetch, no framework, no globals.
 */
import { exportLine } from './mask-egress';
import { hitLocator, type HitView } from './search-hit';
import {
    COMPOSED_BANNER, COMPOSED_FORMATS, type ComposedFormat,
} from './export-vocab';

/** A composed export, ready to hand to a host. */
export interface ComposedExport {
    /** The format this was built in. */
    readonly format: ComposedFormat;
    /** The whole artefact. The ONLY text that leaves this module. */
    readonly text: string;
    /** A suggested filename. Never `.jsonl`; see `export-vocab.ts`. */
    readonly filename: string;
    /** How many hits are in it. */
    readonly hits: number;
    /** How many carried a substituted preview rather than real text. */
    readonly substituted: number;
}

/** What the composer needs to know about the search it is exporting. */
export interface ComposeContext {
    /** The query text, echoed so the file says what was asked. */
    readonly query: string;
    /** The coverage sentence, so the file carries its own honesty note. */
    readonly coverage: string;
    /** `meta.scan.status`, so a partial scan cannot look complete on disk. */
    readonly scan: string;
}

/** The base name a composed export takes. Deliberately not a session_ref. */
export const COMPOSED_BASENAME = 'cloude-archive-search';

/**
 * The extension for each composed format.
 *
 * Description: `.txt` and `.json`, NEVER `.jsonl`. A composed file
 *   wearing the archive's own extension would sit in a downloads folder
 *   looking exactly like a byte-exact transcript export.
 */
export const COMPOSED_EXTENSION: Readonly<Record<string, string>> = {
    [COMPOSED_FORMATS.TEXT]: 'txt',
    [COMPOSED_FORMATS.JSON]: 'json',
};

/**
 * Build the header lines every composed export carries.
 *
 * Description: the banner FIRST, then what was asked, then what was
 *   actually read. The coverage sentence travels INTO the file because
 *   an exported result set outlives the screen that explained it, and a
 *   partial scan read off a file six months later with no coverage note
 *   is a claim nobody measured.
 * Inputs: ctx - the search's own account of itself. counts - the hit and
 *   substitution totals.
 * Output: the header lines, in order.
 */
function headerLines(
    ctx: ComposeContext, counts: { hits: number; substituted: number },
): readonly string[] {
    return [
        COMPOSED_BANNER,
        `query: ${ctx.query}`,
        `scan status: ${ctx.scan}`,
        ctx.coverage,
        `hits in this file: ${counts.hits}`,
        `previews withheld or absent: ${counts.substituted} of ${counts.hits}`,
    ];
}

/**
 * Compose a set of search results into a client-composed export.
 *
 * Description: every hit yields exactly one line, built through
 *   `exportLine`, which is the egress door. A hit whose preview the door
 *   refuses yields a line saying so; it is never dropped and its text is
 *   never partially included.
 *
 *   THE JSON FORM CARRIES THE SAME STRINGS, not a richer object. It
 *   would be easy to emit `{locator, snippet, snippet_state}` and let a
 *   consumer decide - and that would put the raw preview back in the
 *   file for every hit the door refused, through a field nobody thought
 *   of as an egress. So both formats serialise the SAME already-gated
 *   line text, and the JSON form adds only the counts a script would
 *   otherwise have to parse back out.
 * Inputs: views - the hits to export. Each already carries the egress
 *   VERDICT the screen is painting from, so this module never sees a raw
 *   hit and the file and the screen cannot disagree about one. ctx - the
 *   search's account of itself. format - which artefact to build.
 * Output: a ComposedExport.
 * Example: composeExport(views, ctx, 'text').filename
 *   // -> 'cloude-archive-search.txt'
 */
export function composeExport(
    views: readonly HitView[],
    ctx: ComposeContext,
    format: ComposedFormat,
): ComposedExport {
    const lines: string[] = [];
    let substituted = 0;

    for (const view of views) {
        if (!view) continue;
        // THE VERDICT IS THE ONLY THING READ. `view.preview` came out of
        // `snippetEgress` when the hit was built, and it is the same
        // object `SearchHit.svelte` paints from. There is no raw hit in
        // this module's scope at all.
        const line = exportLine(hitLocator(view), view.preview);
        if (line.substituted) substituted += 1;
        lines.push(line.text);
    }

    const counts = { hits: views.length, substituted };
    const head = headerLines(ctx, counts);
    const ext = COMPOSED_EXTENSION[format] ?? 'txt';

    const text = format === COMPOSED_FORMATS.JSON
        ? JSON.stringify({
            note: COMPOSED_BANNER,
            query: ctx.query,
            scan_status: ctx.scan,
            coverage: ctx.coverage,
            hits: counts.hits,
            previews_substituted: counts.substituted,
            lines,
        }, null, 2)
        : [...head.map((l) => `# ${l}`), '', ...lines].join('\n');

    return {
        format,
        text,
        filename: `${COMPOSED_BASENAME}.${ext}`,
        hits: counts.hits,
        substituted,
    };
}
