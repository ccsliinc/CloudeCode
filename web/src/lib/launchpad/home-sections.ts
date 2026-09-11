/**
 * The three collapsible headings on the home screen, and where their
 * collapsed state is kept.
 *
 * THE STORAGE KEY IS BYTE-FOR-BYTE THE LEGACY ONE, which is the whole
 * discipline of this migration: an existing user's screen looks unchanged
 * on first load after the slice ships, because nothing was renamed.
 * `cloude.launchpad.collapsed` holds one object, section id to collapsed
 * boolean, the same convention `cloude.theme` and `cloude.audio.volume`
 * follow.
 *
 * THE "recent" ENTRY IS IN THE LIST AND THAT IS NOT DECORATION.
 * `#recent-sessions-toggle` rendered as a real `<button>` with
 * `aria-expanded` for months before anything attached a listener to it,
 * so clicking it did literally nothing - which reads on screen as a
 * chevron stuck open. It was never a repaint clobbering a collapse; there
 * was no collapse behaviour to clobber. Do not drop an entry from this
 * table to "simplify" it.
 *
 * THERE USED TO BE A FOURTH, "server management". Its one control lives
 * in the home bar's server-controls menu now.
 */

/** Where the collapsed map is persisted. The LEGACY key, unchanged. */
export const COLLAPSED_KEY = 'cloude.launchpad.collapsed';

/** One collapsible section: its state id, its toggle, and its region. */
export interface SectionBinding {
    /** The id this section is persisted under. NOT the element's id. */
    id: string;
    /** The `<button>` heading control. */
    toggleId: string;
    /** The region it shows and hides. */
    contentId: string;
}

/**
 * The three sections, in the order they appear on screen.
 *
 * Note `recent-projects` keyed against `projects-section-toggle`: the
 * PERSISTED id and the ELEMENT id disagree, and they have since the
 * feature shipped. Renaming either one silently expands every user's
 * collapsed projects section, so both stay exactly as they are.
 */
export const SECTIONS: readonly SectionBinding[] = [
    { id: 'running-sessions', toggleId: 'running-sessions-toggle', contentId: 'running-sessions-list' },
    { id: 'recent-sessions', toggleId: 'recent-sessions-toggle', contentId: 'recent-sessions-list' },
    { id: 'recent-projects', toggleId: 'projects-section-toggle', contentId: 'project-list' },
];

/** What `localStorage` looks like to this module. */
export interface CollapsedStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** The real one, or null where there is none (a node harness). */
function defaultStorage(): CollapsedStorage | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (error) {
        // Safari in a blocked-storage mode THROWS on the property access
        // itself, not on the call. Treated as "no preference recorded".
        console.warn('CloudeWeb: collapsed-section storage unavailable:', error);
        return null;
    }
}

/**
 * Read the persisted collapsed map.
 *
 * Description: an unreadable or malformed value is an EMPTY map, i.e.
 *   everything expanded, which is the safe default - a user who cannot
 *   see a section cannot expand it, while a user who sees one they had
 *   collapsed can collapse it again in one click.
 * Inputs: storage - defaults to `localStorage`.
 * Output: section id to collapsed boolean.
 * Example: collapsedState()   // {'recent-sessions': true}
 */
export function collapsedState(
    storage: CollapsedStorage | null = defaultStorage(),
): Record<string, boolean> {
    if (!storage) return {};
    try {
        const raw = storage.getItem(COLLAPSED_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as Record<string, boolean>;
    } catch (error) {
        console.warn('CloudeWeb: failed to read the collapsed-section state:', error);
        return {};
    }
}

/**
 * Persist one section's collapsed flag into the shared map.
 *
 * Inputs: sectionId; collapsed; storage.
 * Output: boolean - whether the write landed.
 * Example: setSectionCollapsed('recent-sessions', true);
 */
export function setSectionCollapsed(
    sectionId: string,
    collapsed: boolean,
    storage: CollapsedStorage | null = defaultStorage(),
): boolean {
    if (!storage) return false;
    const state = collapsedState(storage);
    state[sectionId] = collapsed;
    try {
        storage.setItem(COLLAPSED_KEY, JSON.stringify(state));
        return true;
    } catch (error) {
        console.warn('CloudeWeb: failed to persist the collapsed-section state:', error);
        return false;
    }
}

/**
 * Apply expanded or collapsed state to one toggle and its region.
 *
 * Description: uses `style.display`, NOT the `hidden` attribute.
 *   `.project-list` sets `display: flex` in the stylesheet, and an author
 *   rule wins the cascade over the UA's `[hidden] {display: none}` - so
 *   `hidden` silently no-ops the collapse for exactly one of the three
 *   sections, which is the worst possible subset.
 * Inputs: toggle; content; expanded.
 * Output: void.
 * Example: applySectionExpanded(button, list, false);
 */
export function applySectionExpanded(
    toggle: Element | null,
    content: HTMLElement | null,
    expanded: boolean,
): void {
    if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
    if (content) content.style.display = expanded ? '' : 'none';
}
