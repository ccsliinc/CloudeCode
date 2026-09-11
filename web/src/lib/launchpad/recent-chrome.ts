/**
 * The three elements the RECENT component owns that sit OUTSIDE its mount.
 *
 * WHY THIS IS A MODULE AND NOT MARKUP IN THE COMPONENT. `mountPanel` puts
 * the component inside `#recent-sessions-list`. The section's heading is a
 * SIBLING of that container, and it holds three things this section is
 * responsible for: `#recent-sessions-count`, the `#recent-show-deleted-toggle`
 * button and, one level up, `#recent-sessions-section`'s own visibility.
 *
 * RE-RENDERING THAT HEADING WOULD SILENTLY UNBIND THE COLLAPSE.
 * `Launchpad.initSectionDisclosures()` registers a click listener on
 * `#recent-sessions-toggle` ONCE, at boot, and persists the collapsed
 * state under `cloude.launchpad.collapsed`. That method belongs to a
 * later slice. Replacing the heading's nodes now would drop the listener
 * on the floor, and the failure would be a chevron that stops working
 * rather than an error anybody sees. So the heading stays legacy markup
 * and this writes into it, which is exactly what `renderRecentSessions()`
 * did - moved, not rewritten.
 *
 * IT IS THE ONLY THING IN THIS SLICE THAT TOUCHES THE DOM DIRECTLY, and
 * it is injected into the component as part of its host, so the component
 * itself stays assertable with no document at all. Slice 6 or 7 takes the
 * heading over properly and this module goes with it.
 *
 * NO COPY LIVES HERE. Every string it writes is passed in already
 * translated.
 */

/** The count badge beside the section's title. */
const COUNT_ID = 'recent-sessions-count';
/** The archive filter, whose id still says `deleted` on disk and in tests. */
const TOGGLE_ID = 'recent-show-deleted-toggle';
/** The whole section, hidden when there is nothing to say. */
const SECTION_ID = 'recent-sessions-section';

/**
 * The handler the one real archive-filter listener delegates to.
 *
 * MODULE SCOPE, NOT PER-CHROME, and that is the whole mechanism. The
 * dataset flag that stops a second listener being added lives on the
 * ELEMENT, so it outlives any one `browserChrome()` object; a slot living
 * inside one of those would be unreachable from the second mount onwards
 * and the control would silently stop responding. One page, one element,
 * one slot.
 */
let archiveClick: (() => void) | null = null;

/** The three writes, as an interface so a test can record them. */
export interface RecentChrome {
    /** Paint the count badge and stamp the state it is reporting. */
    setCount(text: string, state: string): void;
    /** Show or hide the whole section. */
    setSectionVisible(visible: boolean): void;
    /** Paint the archive filter to match the preference. */
    setArchiveToggle(on: boolean, title: string): void;
    /** Register the archive filter's click handler, at most once. */
    bindArchiveToggle(onClick: () => void): void;
}

/**
 * The real chrome: writes into the legacy heading by element id.
 *
 * Description: every write is a no-op when its element is absent, which
 *   is a normal early-boot state and not a fault - the legacy renderers
 *   this replaces all opened with the same guard.
 *
 *   ONE LISTENER, LATEST HANDLER. The component is remounted on every
 *   launchpad render, so a listener added per mount would fire the
 *   re-fetch N times for one click - the defect the legacy code's
 *   `dataset.recentClickBound` flag existed to prevent. But a bare
 *   register-once ALSO has a failure, and it is the quieter one: the
 *   first mount's closure stays installed and every later mount's is
 *   discarded, so the control keeps calling into a component that is
 *   gone. So the real listener is registered once and DELEGATES to a
 *   mutable slot that each mount overwrites. Neither stacking nor
 *   staleness is possible.
 * Inputs: none.
 * Output: a RecentChrome bound to this document.
 * Example: const chrome = browserChrome(); chrome.setCount('2 recent', 'ok');
 */
export function browserChrome(): RecentChrome {
    return {
        setCount(text: string, state: string): void {
            const el = document.getElementById(COUNT_ID);
            if (!el) return;
            el.textContent = text;
            el.setAttribute('data-state', state);
        },

        setSectionVisible(visible: boolean): void {
            const el = document.getElementById(SECTION_ID);
            if (!el) return;
            // `style.display = ''` rather than a class or the `hidden`
            // attribute: that is the exact value the legacy renderer set,
            // and the section's stylesheet rule would otherwise win the
            // cascade over a UA `[hidden]` rule and no-op the hide.
            el.style.display = visible ? '' : 'none';
        },

        setArchiveToggle(on: boolean, title: string): void {
            const el = document.getElementById(TOGGLE_ID);
            if (!el) return;
            el.setAttribute('aria-pressed', String(!!on));
            el.classList.toggle('is-on', !!on);
            el.setAttribute('title', title);
        },

        bindArchiveToggle(onClick: () => void): void {
            const el = document.getElementById(TOGGLE_ID);
            if (!el) return;
            archiveClick = onClick;
            if (el.dataset.recentArchiveBound === '1') return;
            el.dataset.recentArchiveBound = '1';
            el.addEventListener('click', () => {
                if (archiveClick) archiveClick();
            });
        },
    };
}
