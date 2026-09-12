/**
 * THE TOTAL FUNCTION, AND THE SECOND WRITER THAT WOULD BREAK IT.
 *
 * `ThemeNavigation.applyForTarget` is TOTAL: every navigation ends in an
 * `applyTheme` call, including the ones that end in "no pinned theme,
 * apply the default". That totality is the whole fix for a defect this
 * project already paid for - `if (pinned) apply()` with no `else` left
 * the PREVIOUS session's theme on screen, because three copy-pasted
 * restores in `app.js` and two session-entry paths each applied a theme
 * and none of them reset one. A missing else is not a missing feature;
 * it is state left over from the previous thing.
 *
 * A COMPONENT THAT PAINTED A THEME ON MOUNT WOULD BE A SECOND WRITER,
 * and the two would disagree the first time either changed. Worse, it
 * would disagree ASYNCHRONOUSLY: a mount happens whenever a panel is
 * (re)mounted, which is not a navigation, so the theme would move at a
 * moment `applyForTarget` knows nothing about.
 *
 * SO THIS IS A SOURCE SCAN, AND IT HAS TO BE. There is no runtime
 * assertion that can prove a call did NOT happen on a path nobody ran -
 * a component that painted a theme only for a row carrying
 * `pinned_theme` would pass every mount test written against rows that
 * do not carry one. Reading the files is the only check whose coverage
 * is the whole slice.
 *
 * Same technique, and the same reasoning, as the source half of
 * ../i18n/coverage.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Every file slices 4 and 5 added or took over.
 *
 * APPEND TO THIS WHEN A SLICE ADDS A COMPONENT. A file not listed is
 * simply not covered, and the count assertion at the bottom is what
 * stops this list quietly emptying.
 */
const SLICE_FILES = [
    'web/src/lib/launchpad/ProjectTree.svelte',
    'web/src/lib/launchpad/ProjectNode.svelte',
    'web/src/lib/launchpad/ProjectSessionRow.svelte',
    'web/src/lib/launchpad/EndedSessionRow.svelte',
    'web/src/lib/launchpad/TreeSessionRows.svelte',
    'web/src/lib/launchpad/NoProjectGroup.svelte',
    'web/src/lib/launchpad/AttentionGroup.svelte',
    'web/src/lib/launchpad/AgentFamilyPill.svelte',
    'web/src/lib/Glyph.svelte',
    'web/src/lib/launchpad/project-groups.ts',
    'web/src/lib/launchpad/project-node.ts',
    'web/src/lib/launchpad/project-chrome.ts',
    'web/src/lib/launchpad/project-chrome-control.ts',
    'web/src/lib/launchpad/project-tree-host.ts',
    'web/src/lib/launchpad/agent-family-pill.ts',
    'web/src/lib/launchpad/tree-collapse.svelte.ts',
    // Slice 5, the running-sessions list. The card is the surface most
    // likely to reach for a theme, because it is the one that RENDERS a
    // session's pinned theme as a cue - so it is the one that most needs
    // holding to reading the field rather than applying it.
    'web/src/lib/launchpad/RunningSessions.svelte',
    'web/src/lib/launchpad/RunningSessionRow.svelte',
    'web/src/lib/launchpad/RunningSessionName.svelte',
    'web/src/lib/launchpad/StartupGateBadge.svelte',
    'web/src/lib/launchpad/WrapperPill.svelte',
    'web/src/lib/launchpad/running-row.ts',
    'web/src/lib/launchpad/running-actions.ts',
    'web/src/lib/launchpad/running-host.ts',
    'web/src/lib/launchpad/running-chrome.ts',
    // Slice 6, the modals and the create flows. A modal is the surface
    // most able to break the total function by accident, because it is
    // the one that opens OVER a session and closes back onto it - a
    // theme applied on mount would move the theme at a moment
    // `applyForTarget` knows nothing about, and move it back never.
    'web/src/lib/launchpad/ModalShell.svelte',
    'web/src/lib/launchpad/ChoiceModal.svelte',
    'web/src/lib/launchpad/CloneModal.svelte',
    'web/src/lib/launchpad/EditProjectModal.svelte',
    'web/src/lib/launchpad/ProjectFolderModal.svelte',
    'web/src/lib/launchpad/ProjectNameModal.svelte',
    'web/src/lib/launchpad/project-folder.ts',
    'web/src/lib/launchpad/create-flow.ts',
    'web/src/lib/launchpad/create-host.ts',
    'web/src/lib/launchpad/entry-flows.ts',
    'web/src/lib/launchpad/open-folder-flow.ts',
    'web/src/lib/launchpad/project-actions.ts',
    'web/src/lib/launchpad/modals.ts',
    'web/src/lib/launchpad/modal-types.ts',
    // Slice 7, the shell and the navigation glue. THIS IS THE SLICE THE
    // GUARD EXISTS FOR. `ThemeNavigation.applyForTarget` is total
    // because every navigation ends in it, and every navigation on this
    // screen now starts in `navigation.ts` - so a theme applied there,
    // or painted by the shell on mount, is the exact regression gotcha 7
    // in CLAUDE.md records: a missing else is not a missing feature, it
    // is the previous session's theme left on screen.
    'web/src/lib/launchpad/HomeScreen.svelte',
    'web/src/lib/launchpad/HelpDisclosure.svelte',
    'web/src/lib/launchpad/RichText.svelte',
    'web/src/lib/launchpad/home-screen-host.ts',
    'web/src/lib/launchpad/home-chrome.ts',
    'web/src/lib/launchpad/home-sections.ts',
    'web/src/lib/launchpad/home-anchors.ts',
    'web/src/lib/launchpad/new-fab.ts',
    'web/src/lib/launchpad/panels.ts',
    'web/src/lib/launchpad/navigation.ts',
    'web/src/lib/launchpad/nav-host.ts',
    'web/src/lib/launchpad/deep-link.ts',
    'web/src/lib/launchpad/status-report.ts',
    'web/src/lib/launchpad/rich-text.ts',
    'web/src/lib/launchpad/shim.ts',
];

/**
 * The files that legitimately touch an element by id.
 *
 * Description: a section's heading is a SIBLING of its mount and stays
 *   legacy markup until slice 7, so its count badge and its visibility
 *   are WRITTEN rather than rendered - from exactly one module per
 *   section, which is what keeps every other file unable to reach outside
 *   its own container.
 */
const CHROME_FILES = new Set([
    'web/src/lib/launchpad/project-chrome-control.ts',
    'web/src/lib/launchpad/running-chrome.ts',
    // SLICE 7'S SIX, and each one is on this list for a reason that is
    // about the LEGACY tree rather than about convenience. The rule is
    // "no component reaches into ANOTHER COMPONENT's DOM"; every one of
    // these reaches an element that either is not a component's at all
    // or belongs to a classic script that cannot be passed a prop.
    //
    //   home-screen-host.ts  resolves #launchpad-screen, which lives in
    //                        client/index.html and is the MOUNT TARGET.
    //   home-anchors.ts      enumerates the three ids app.js and
    //                        globalAudioToggle.js address, so the guard
    //                        that they still exist can iterate them.
    //   home-chrome.ts       fills #home-bar-version (version-footer.js
    //                        owns the string) and wires
    //                        #server-controls-btn, #launchpad-help-btn
    //                        (which is in the top HEADER and outlives
    //                        this screen) and the three section toggles.
    //   new-fab.ts           measures a position: fixed menu against a
    //                        trigger, and #new-fab-backdrop is in
    //                        client/index.html, outside the shell.
    //   status-report.ts     writes #statusText, the ONE node whose
    //                        data-status app.js observes, and appends
    //                        the error stack to document.body.
    //   nav-host.ts          pre-shows #terminal-screen so xterm can
    //                        measure, which is a different screen.
    'web/src/lib/launchpad/home-screen-host.ts',
    'web/src/lib/launchpad/home-anchors.ts',
    'web/src/lib/launchpad/home-chrome.ts',
    'web/src/lib/launchpad/new-fab.ts',
    'web/src/lib/launchpad/status-report.ts',
    'web/src/lib/launchpad/nav-host.ts',
]);

/** Strip comments, so a file may EXPLAIN the rule it is obeying. */
function code(src: string): string {
    return src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

function read(rel: string): string {
    return code(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
}

describe('no component in this slice paints a theme', () => {
    test.each(SLICE_FILES)('%s does not call applyTheme', (rel) => {
        expect(read(rel)).not.toContain('applyTheme');
    });

    test.each(SLICE_FILES)('%s does not reach the theme layer at all', (rel) => {
        const src = read(rel);
        // Not just the one call: reaching `window.Themes`, importing a
        // theme module, or writing a theme onto the root are all the
        // same defect wearing different clothes.
        expect(src).not.toContain('Themes');
        expect(src).not.toContain('ThemeNavigation');
        expect(src).not.toContain('data-theme');
        expect(src).not.toContain('setTheme');
    });

    test('and none of them writes to documentElement or body', () => {
        // A component that stamped a class or a custom property on the
        // root would be painting a theme without using the word.
        for (const rel of SLICE_FILES) {
            const src = read(rel);
            expect(src, rel).not.toContain('documentElement');
            expect(src, rel).not.toContain('document.body');
        }
    });

    test('NEGATIVE CONTROL: the scanner DOES find the call when it is there', () => {
        // A guard nobody has watched fail is a guard nobody has tested.
        expect(code("Themes.applyTheme('gruvbox');")).toContain('applyTheme');
        // ...and a COMMENT explaining the rule is not a violation of it,
        // which is what lets every file in this slice document itself.
        expect(code('// never call Themes.applyTheme here')).not.toContain('applyTheme');
        expect(code('<!-- no applyTheme on mount -->')).not.toContain('applyTheme');
    });
});

describe('no component inlines its own status dot', () => {
    /** The one component every LED must go through. */
    const LED_COMPONENT = 'StatusLed';

    test('the two files that render a dot render it as the component', () => {
        for (const rel of [
            'web/src/lib/launchpad/ProjectSessionRow.svelte',
            'web/src/lib/launchpad/EndedSessionRow.svelte',
            'web/src/lib/launchpad/RunningSessionRow.svelte',
        ]) {
            expect(read(rel), rel).toContain(`<${LED_COMPONENT}`);
        }
    });

    test('and NOTHING in the slice writes the dot markup by hand', () => {
        // `StatusLed.svelte` is the only place `status-dot--` may be
        // built, because it is the only place that calls `ledStateFor`.
        // A component assembling that class itself would be a second
        // vocabulary the moment the first one gained a state.
        for (const rel of SLICE_FILES) {
            const src = read(rel);
            expect(src, rel).not.toContain('status-dot--');
            expect(src, rel).not.toContain('ledStateFor');
            expect(src, rel).not.toContain('data-inner');
            expect(src, rel).not.toContain('data-outer');
        }
    });
});

describe('no component reaches into another component\'s DOM', () => {
    test('only the chrome control touches an element by id, and that is its job', () => {
        // Props down, callbacks up, store in the middle. The one
        // exception is the show-archived filter, which is a SIBLING of
        // the mount and lives in legacy markup until a later slice - so
        // it is written rather than rendered, from exactly one module.
        for (const rel of SLICE_FILES) {
            if (CHROME_FILES.has(rel)) continue;
            expect(read(rel), rel).not.toContain('getElementById');
            expect(read(rel), rel).not.toContain('querySelector');
        }
        for (const rel of CHROME_FILES) {
            expect(read(rel), rel).toContain('getElementById');
        }
    });
});

describe('the list itself stays honest', () => {
    test('every listed file exists, and the list is not empty', () => {
        // A guard that silently scanned nothing would pass forever.
        expect(SLICE_FILES.length).toBeGreaterThanOrEqual(39);
        for (const rel of SLICE_FILES) {
            expect(fs.existsSync(path.join(repoRoot, rel)), rel).toBe(true);
        }
    });

    test('and every .svelte file in this slice IS on the list', () => {
        // The way this guard rots is a new component nobody added here.
        const dir = path.join(repoRoot, 'web/src/lib/launchpad');
        const components = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.svelte'))
            .map((f) => `web/src/lib/launchpad/${f}`);
        const listed = new Set(SLICE_FILES);
        // RecentSessions and AttributionPrompt belong to slices 2 and 1
        // and carry their own guards; everything else in this directory
        // is slice 4's and must be covered.
        const earlierSlices = new Set([
            'web/src/lib/launchpad/RecentSessions.svelte',
            'web/src/lib/launchpad/AttributionPrompt.svelte',
        ]);
        for (const rel of components) {
            if (earlierSlices.has(rel)) continue;
            expect(listed.has(rel), `${rel} is not covered by the theme guard`).toBe(true);
        }
    });
});
