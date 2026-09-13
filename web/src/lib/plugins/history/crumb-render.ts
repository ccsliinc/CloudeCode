/**
 * Turning a location into a breadcrumb's nodes.
 *
 * SPLIT OUT OF `route.ts` FOR THE 500-LINE RULE, and the seam is a real
 * one rather than an arbitrary cut: everything left in `route.ts` is
 * pure string work over paths, and everything here touches a document.
 * That is also why this file can be deleted whole when slice 3 gives the
 * crumb a Svelte component - the path half does not move with it.
 *
 * THE HUMAN-READABLE RENDERING OF A LOCATION SITS BESIDE THE
 * MACHINE-READABLE ONE for the same reason `syncUrl` does: a crumb that
 * disagrees with the URL is two answers to "where am I", and the person
 * can see both at once.
 */
import { CRUMB_ROOT_LABEL, CRUMB_SEPARATOR } from './route';

/** The minimum of `document` `renderCrumb` needs. */
export interface CrumbDocument {
    createElement(tag: string): CrumbElement;
    createTextNode(text: string): unknown;
}

/** The minimum of an element `renderCrumb` writes to. */
export interface CrumbElement {
    className: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: unknown): unknown;
}

/**
 * Render a location as a breadcrumb.
 *
 * Description: THE HUMAN-READABLE RENDERING OF A LOCATION SITS BESIDE
 *   THE MACHINE-READABLE ONE for the same reason `syncUrl` does: a crumb
 *   that disagrees with the URL is two answers to "where am I", and the
 *   person can see both at once.
 *
 *   NEVER RENDERS A BLANK CRUMB. An unknown segment is rendered as a
 *   named unknown by the caller; an empty parts list still renders the
 *   ARCHIVE root, because a bar with nothing in it reads as a loading
 *   state rather than as the top level.
 * Inputs: doc - a Document. parts - segments after the root, already
 *   worded by the caller. rootClass - the class prefix the screen owns,
 *   passed in rather than assumed so this module carries no knowledge of
 *   the screen's CSS.
 * Output: the crumb children in order, for the caller to append. This
 *   function owns no container.
 *
 *   AN ARRAY RATHER THAN A DocumentFragment, deliberately. A fragment is
 *   the idiomatic browser answer and it is the wrong one here: the
 *   repo's DOM double implements createElement and createTextNode and
 *   NOT createDocumentFragment, so a fragment would make this function
 *   unreachable from every unit test while working perfectly in a
 *   browser. An array costs nothing and is testable in both.
 * Example: renderCrumb(document, ['project 8'], 'archive-screen')
 *          // -> [span.ARCHIVE, span.sep, span['project 8']]
 */
export function renderCrumb(
    doc: CrumbDocument, parts: readonly string[] | null, rootClass: string,
): CrumbElement[] {
    const out: CrumbElement[] = [];
    const items = [CRUMB_ROOT_LABEL].concat((parts || []) as string[]);
    for (let i = 0; i < items.length; i++) {
        if (i > 0) {
            const sep = doc.createElement('span');
            sep.className = rootClass + '__crumb-sep';
            sep.appendChild(doc.createTextNode(CRUMB_SEPARATOR));
            out.push(sep);
        }
        const item = doc.createElement('span');
        item.className = rootClass + '__crumb-item';
        // The crumb TRUNCATES with an ellipsis rather than wrapping
        // (archive-panes.css), so the full text has to survive somewhere
        // reachable or a long path becomes unreadable with no way back.
        // Written here, in the one function that builds a crumb segment,
        // so a caller cannot forget it.
        item.setAttribute('title', String(items[i]));
        item.appendChild(doc.createTextNode(String(items[i])));
        out.push(item);
    }
    return out;
}
