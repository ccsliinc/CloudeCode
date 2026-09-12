/**
 * The one control the project tree owns that sits OUTSIDE its mount.
 *
 * `mountPanel` puts the tree inside `#project-list`. The projects
 * section's heading is a SIBLING of that container and holds
 * `#projects-show-archived-toggle`, which is this section's filter and
 * nobody else's.
 *
 * RE-RENDERING THAT HEADING WOULD SILENTLY UNBIND THE SECTION COLLAPSE.
 * `Launchpad.initSectionDisclosures()` registers a listener on the
 * heading's own toggle ONCE, at boot, and that method belongs to slice 7.
 * Replacing the heading's nodes now would drop the listener on the floor,
 * and the failure would be a chevron that stops working rather than an
 * error anybody sees. So the heading stays legacy markup and this writes
 * into it, which is exactly what `initArchivedVisibleToggle` and
 * `_applyArchivedVisibleToggleState` did - moved, not rewritten. Same
 * shape and same reasoning as ./recent-chrome.ts.
 *
 * THE LISTENER SLOT IS MODULE SCOPE, NOT PER-CONTROL, and that is the
 * whole mechanism. The dataset flag that stops a second listener being
 * added lives on the ELEMENT, so it outlives any one `browserControl()`
 * object; a slot inside one of those would be unreachable from the second
 * mount onwards and the filter would silently stop responding. One page,
 * one element, one slot.
 *
 * FLIPPING IT RE-FETCHES rather than filtering what is already held. The
 * archived rows are ASKED FOR, so there is ONE rule about what is on
 * screen - whatever the last request returned - instead of two that can
 * drift apart, and the toggle cannot show stale archived rows from an
 * earlier fetch. Nothing here runs on the 5s tick: that re-renders the
 * tree and does not re-request it.
 *
 * NO COPY LIVES HERE. The title is passed in already translated.
 */

/** The show-archived filter in the projects section heading. */
const TOGGLE_ID = 'projects-show-archived-toggle';

/** The handler the one real listener delegates to. See the header. */
let archiveClick: (() => void) | null = null;

/** The two writes, as an interface so a test can record them. */
export interface ProjectChromeControl {
    /** Paint the filter to match the preference. */
    setArchivedToggle(on: boolean, title: string): void;
    /** Register the filter's click handler, at most once per element. */
    bindArchivedToggle(onClick: () => void): void;
}

/**
 * Build the control that writes into the real heading.
 *
 * Description: every member looks its element up when CALLED, never at
 *   import, because the heading is written by `renderLaunchpadUI()` at
 *   runtime and may not exist yet. A MISSING ELEMENT IS A NO-OP, matching
 *   the legacy `if (!btn) return;` exactly - during boot that is a normal
 *   state, not a fault.
 * Inputs: none.
 * Output: ProjectChromeControl.
 * Example: const control = browserControl();
 */
export function browserControl(): ProjectChromeControl {
    return {
        setArchivedToggle(on: boolean, title: string): void {
            const btn = document.getElementById(TOGGLE_ID);
            if (!btn) return;
            btn.setAttribute('aria-pressed', String(!!on));
            btn.classList.toggle('is-on', !!on);
            btn.setAttribute('title', title);
        },
        bindArchivedToggle(onClick: () => void): void {
            const btn = document.getElementById(TOGGLE_ID);
            if (!btn) return;
            archiveClick = onClick;
            if ((btn as HTMLElement).dataset.cloudeArchivedBound === '1') return;
            (btn as HTMLElement).dataset.cloudeArchivedBound = '1';
            btn.addEventListener('click', () => {
                if (archiveClick) archiveClick();
            });
        },
    };
}
