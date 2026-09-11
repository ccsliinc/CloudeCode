/**
 * The two writes this section makes OUTSIDE its own mount.
 *
 * THE HEADING IS STILL LEGACY MARKUP, AND THAT IS DELIBERATE.
 * `ensurePanel` puts the component inside `#running-sessions-list`, while
 * `#running-sessions-count` and the visibility of
 * `#running-sessions-section` are SIBLINGS of it that the legacy shell
 * still owns until slice 7. `initSectionDisclosures()` binds the collapse
 * chevron to that heading once at boot, so re-rendering the heading would
 * drop the listener on the floor - and the failure would be a chevron
 * that silently stops working rather than an error anybody sees.
 *
 * SO THEY ARE WRITTEN, NOT RENDERED, and they live here rather than
 * inside the component: injected as part of its host, which keeps them
 * assertable with no document and keeps the component itself unable to
 * touch anything outside its container. `./running-chrome.test.ts`
 * records every element this asks for.
 *
 * EVERY WRITE IS A NO-OP WHEN ITS ELEMENT IS ABSENT. A section that has
 * not been rendered yet is a normal early-boot state, not a fault; the
 * legacy renderer this replaces opened with the same guard.
 */
import { hostDocument } from '../sessions/env';

/** The heading's count badge, a sibling of the mount. */
const COUNT_ID = 'running-sessions-count';
/** The whole section, hidden when there is nothing measured to show. */
const SECTION_ID = 'running-sessions-section';

/** The writes the running-sessions section makes outside its container. */
export interface RunningChrome {
    /**
     * Paint the count badge, and stamp whether it is a measured number.
     *
     * `data-listing-ok` is the machine-readable half of the same fact the
     * text carries: `0` means the probe did not answer and the number is
     * absent, not zero.
     */
    setCount(text: string, listingOk: boolean): void;
    /**
     * Show or hide the whole section.
     *
     * ZERO ROWS IS TWO DIFFERENT SITUATIONS. With a listing that ran it
     * means the user has no sessions and the section hides. With a
     * listing that did NOT run it means we do not know, and hiding the
     * section would render "cannot determine" as "nothing to see" - the
     * exact false green the attention block exists to remove.
     */
    setSectionVisible(visible: boolean): void;
}

/**
 * The real chrome: writes into the legacy heading by element id.
 *
 * Description: resolves its document on every call, never at import, so
 *   the module may be loaded in a realm that has none. `display` is set
 *   to the empty string rather than a value, which restores whatever the
 *   stylesheet says instead of pinning the section to `block`.
 * Inputs: none.
 * Output: a RunningChrome bound to this document.
 * Example: const chrome = browserRunningChrome(); chrome.setCount('2 running', true);
 */
export function browserRunningChrome(): RunningChrome {
    return {
        setCount(text: string, listingOk: boolean): void {
            const doc = hostDocument();
            const el = doc && doc.getElementById(COUNT_ID);
            if (!el) return;
            el.textContent = text;
            el.setAttribute('data-listing-ok', listingOk ? '1' : '0');
        },
        setSectionVisible(visible: boolean): void {
            const doc = hostDocument();
            const el = doc && doc.getElementById(SECTION_ID);
            if (!el) return;
            (el as HTMLElement).style.display = visible ? '' : 'none';
        },
    };
}
