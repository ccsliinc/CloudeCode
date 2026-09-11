// Node tests for the RECENT section's heading markup.
//
// SLICE 7 TOOK THE WIRING HALF OF THIS FILE. The four tests above this
// line drove `initSectionDisclosures()` by loading `client/js/launchpad.js`
// into a vm sandbox with a listener-recording element stub - the collapse
// click, the re-expand, the write into `cloude.launchpad.collapsed` and
// the re-apply on load. That file no longer exists, and all four moved to
// `web/src/lib/launchpad/HomeScreen.behaviour.test.ts` under "the section
// disclosures", where they mount the REAL component in jsdom against the
// real localStorage rather than a stub of each. The claims are unchanged
// and one is stronger: the port also asserts the collapse uses
// `style.display` and never the `hidden` attribute, which is the trap
// `.project-list { display: flex }` sets for exactly one of the three
// sections.
//
// WHAT STAYS HERE IS THE PART THAT IS NOT ABOUT BEHAVIOUR: the heading's
// markup and the stylesheet that lays it out. A component test cannot
// answer "does the recent header use the same class as the projects
// header", because both would be whatever the component renders.
//
// THE REPAINT CASE MOVED EARLIER, in slice 2, to
// `web/src/lib/launchpad/recent-chrome.test.ts`, restated STRONGER: the
// section's chrome never touches `#recent-sessions-list` at all, asserted
// by recording every element it asks for.
//
// Run with: node tests/test_recent_section_collapse.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { HOME_SCREEN_SRC } from './lib-home-source.mjs';

/** The one stylesheet both headings are laid out by. */
const STYLES = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'css', 'styles.css'),
    'utf8',
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name  Test description.
 * @param {() => (void|Promise<void>)} fn  Body; throwing marks it failed.
 * @returns {Promise<void>}
 */
async function test(name, fn) {
    try {
        await fn();
        passes += 1;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures += 1;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

// ---------------------------------------------------------------------
// 4. Layout: the recent section's "show archived" control sits in the
//    same header row, with the same class, as the projects section's.
// ---------------------------------------------------------------------

/**
 * Extract the substring for one launchpad section's markup, delimited by
 * its own `id="..."` opening div and the next top-level section comment or
 * div that follows it in the template literal.
 * @param {string} src  HomeScreen.svelte source.
 * @param {string} startMarker  a substring unique to the section's opening tag.
 * @param {string} endMarker  a substring marking where the section's markup ends.
 * @returns {string} the slice between them.
 */
function sliceSection(src, startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, `expected to find ${startMarker} in HomeScreen.svelte`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end !== -1, `expected to find ${endMarker} after ${startMarker}`);
    return src.slice(start, end);
}

await test('the recent "show archived" toggle lives inside the same header row as its toggle button, like projects', () => {
    const recentSection = sliceSection(
        HOME_SCREEN_SRC,
        'id="recent-sessions-section"',
        '<div id="recent-sessions-list">'
    );
    const projectsSection = sliceSection(
        HOME_SCREEN_SRC,
        'id="projects-section"',
        '<div id="project-list"'
    );

    // Both sections wrap their disclosure toggle AND their archived
    // control in one shared header container, as siblings - not the
    // archived control sitting after the container closes (which is what
    // rendering it on its own line looks like in the markup).
    for (const [name, section, toggleId, archivedId] of [
        ['recent', recentSection, 'recent-sessions-toggle', 'recent-show-deleted-toggle'],
        ['projects', projectsSection, 'projects-section-toggle', 'projects-show-archived-toggle'],
    ]) {
        const headerOpen = section.indexOf('class="launchpad-section-title');
        assert.ok(headerOpen !== -1, `${name}: expected a launchpad-section-title header container`);
        const toggleIdx = section.indexOf(`id="${toggleId}"`);
        const archivedIdx = section.indexOf(`id="${archivedId}"`);
        assert.ok(toggleIdx !== -1, `${name}: expected the disclosure toggle button`);
        assert.ok(archivedIdx !== -1, `${name}: expected the archived-toggle button`);
        // No other section's opening div (a second `<div id="` at the top
        // level of THIS section) may sit between the header and either
        // button - both live in the one heading container, not one in the
        // header and one dropped below it in a separate block.
        const headerCloseSearch = section.slice(headerOpen);
        const nextTopLevelDiv = headerCloseSearch.indexOf('<div id="', headerCloseSearch.indexOf('>'));
        const archivedRelative = archivedIdx - headerOpen;
        assert.ok(
            nextTopLevelDiv === -1 || archivedRelative < nextTopLevelDiv,
            `${name}: the archived toggle must be inside the header row, not after it`
        );
    }

    // Same class name on both archived-toggle buttons - the recent one is
    // not a differently-styled one-off.
    const recentBtn = recentSection.slice(recentSection.indexOf('id="recent-show-deleted-toggle"') - 200,
        recentSection.indexOf('id="recent-show-deleted-toggle"') + 20);
    const projectsBtn = projectsSection.slice(projectsSection.indexOf('id="projects-show-archived-toggle"') - 200,
        projectsSection.indexOf('id="projects-show-archived-toggle"') + 20);
    assert.ok(recentBtn.includes('class="launchpad-archived-toggle"'),
        'expected the recent archived toggle to carry launchpad-archived-toggle');
    assert.ok(projectsBtn.includes('class="launchpad-archived-toggle"'),
        'expected the projects archived toggle to carry launchpad-archived-toggle');
});

await test('the stylesheet lays out the recent header the same way it lays out the projects header', () => {
    // Both selectors must be declared TOGETHER as one rule (comma-joined)
    // so they can never drift apart into two different layouts again.
    const re = /#projects-section \.launchpad-section-title,\s*#recent-sessions-section \.launchpad-section-title\s*\{([^}]*)\}/;
    const match = STYLES.match(re);
    assert.ok(match, 'expected one shared flex-row rule for both section headers');
    assert.ok(/display:\s*flex/.test(match[1]), 'expected display: flex in the shared rule');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
