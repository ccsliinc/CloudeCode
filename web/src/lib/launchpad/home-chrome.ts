/**
 * The three imperative wires the home shell needs after it renders, and
 * the one classic-script mount point it fills.
 *
 * EVERY ONE OF THESE REACHES A CLASSIC SCRIPT, which is the only reason
 * they are imperative rather than markup. `VersionFooter` owns the
 * version string for BOTH the home bar and the sidebar footer, so the two
 * placements can never disagree; `ServerControlsMenu` owns the bar's one
 * menu; the help control is a header button that OUTLIVES this screen and
 * therefore cannot be a child of it.
 *
 * EACH RETURNS A TEARDOWN OR A VERDICT, never nothing. A wire that cannot
 * say whether it landed is a wire whose failure is invisible, and the
 * server-controls button is the case that proves it: a control that does
 * nothing when pressed is a worse failure than a control that is missing,
 * so the absent-module branch DISABLES the button and names why in its
 * tooltip rather than leaving it live and dead.
 */
import { hostDocument, hostWindow } from '../sessions/env';
import { HOME_KEYS } from '../../../../client/js/labels/home-screen.js';
import {
    SECTIONS,
    applySectionExpanded,
    collapsedState,
    setSectionCollapsed,
} from './home-sections';
import type { Translate } from './recent';

/**
 * Stamp the app version into the home bar's chip.
 *
 * Description: `#home-bar-version` is a MOUNT POINT, not the text. The
 *   string (a real version, or "version unknown" when the resolver could
 *   not determine one - the unresolved case is NAMED rather than left
 *   blank) belongs to `client/js/version-footer.js`, and the same call
 *   produces the sidebar footer's line.
 * Inputs: none. Output: boolean - whether a version was written.
 * Example: renderHomeBarVersion();
 */
export function renderHomeBarVersion(): boolean {
    const mount = hostDocument()?.getElementById('home-bar-version');
    if (!mount) return false;
    const footer = (hostWindow() as unknown as Record<string, unknown> | undefined)
        ?.VersionFooter as { versionSpanHtml?: () => string } | undefined;
    if (!footer || typeof footer.versionSpanHtml !== 'function') {
        mount.innerHTML = '';
        return false;
    }
    // innerHTML, and it is SAFE for one reason worth stating: the markup
    // is built by version-footer.js from a version string the server
    // resolved, never from anything a user typed. It is not a licence to
    // pass anything else through here.
    mount.innerHTML = footer.versionSpanHtml();
    return true;
}

/**
 * Wire the home bar's server-controls button.
 *
 * Inputs: t. Output: boolean - true when the menu was wired, false when
 *   the button was disabled because its module is not loaded.
 * Example: wireServerControls(t);
 */
export function wireServerControls(t: Translate): boolean {
    const btn = hostDocument()?.getElementById('server-controls-btn') as
        | HTMLButtonElement
        | null;
    if (!btn) return false;
    const menu = (hostWindow() as unknown as Record<string, unknown> | undefined)
        ?.ServerControlsMenu as { wire?: (b: Element) => void } | undefined;
    if (menu && typeof menu.wire === 'function') {
        menu.wire(btn);
        return true;
    }
    btn.disabled = true;
    btn.setAttribute('title', t(HOME_KEYS.barServerControlsUnavailable));
    console.warn('CloudeWeb: ServerControlsMenu not loaded, server controls disabled');
    return false;
}

/**
 * Wire the header's "?" control to the launchpad help disclosure.
 *
 * Description: the CONTROL is in the top header and the PANEL is the
 *   first child of `.launchpad-container`. The in-pane `<summary>` is
 *   still in the markup - it is what makes the element a disclosure at
 *   all - but is visually hidden by CSS, so there is exactly ONE control
 *   and it is the header one. The `<details>` is resolved at CLICK time,
 *   never captured, because the header button outlives every render of
 *   the screen below it.
 * Inputs: none. Output: a teardown, or null when the header button is
 *   absent (nothing is claimed either way about the panel).
 * Example: const off = bindHeaderHelpToggle();
 */
export function bindHeaderHelpToggle(): (() => void) | null {
    const doc = hostDocument();
    const btn = doc?.getElementById('launchpad-help-btn');
    if (!btn || !doc) {
        console.warn('CloudeWeb: header help button missing, the help control is not wired');
        return null;
    }
    const handler = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const details = doc.querySelector('#launchpad-screen .adopt-disclosure') as
            | HTMLDetailsElement
            | null;
        if (!details) return;
        const next = !details.open;
        details.open = next;
        btn.setAttribute('aria-expanded', String(next));
        // Guarded on the METHOD, not on a browser check: scrolling the
        // panel into view is a courtesy and must never be the reason a
        // click throws. jsdom does not implement it at all, which is how
        // this was found.
        if (next && typeof details.scrollIntoView === 'function') {
            details.scrollIntoView({ block: 'nearest' });
        }
    };
    btn.addEventListener('click', handler);
    return () => btn.removeEventListener('click', handler);
}

/**
 * Wire the three section headings as real collapsible disclosures.
 *
 * Description: applies the persisted state first, then binds the click.
 *   BOTH archive filters are wired by the components that own them -
 *   RECENT by `RecentSessions.svelte` and PROJECTS by `ProjectTree.svelte`
 *   - and are deliberately not touched here.
 * Inputs: none. Output: a teardown removing every listener this added.
 * Example: const off = initSectionDisclosures();
 */
export function initSectionDisclosures(): () => void {
    const doc = hostDocument();
    const state = collapsedState();
    const offs: Array<() => void> = [];
    if (!doc) return () => {};
    for (const section of SECTIONS) {
        const toggle = doc.getElementById(section.toggleId);
        const content = doc.getElementById(section.contentId) as HTMLElement | null;
        if (!toggle || !content) continue;
        applySectionExpanded(toggle, content, !state[section.id]);
        const handler = () => {
            const nowExpanded = toggle.getAttribute('aria-expanded') !== 'true';
            applySectionExpanded(toggle, content, nowExpanded);
            setSectionCollapsed(section.id, !nowExpanded);
        };
        toggle.addEventListener('click', handler);
        offs.push(() => toggle.removeEventListener('click', handler));
    }
    return () => {
        for (const off of offs) off();
        offs.length = 0;
    };
}
