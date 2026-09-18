/**
 * RAIL PARITY: the Svelte rail and the vanilla rail, same rows, same
 * stylesheets, measured. SCAFFOLDING, NOT SLICE 3.
 *
 * WHY IT EXISTS. The owner reported that the left bar "needs to be more
 * compact" and has "a few spacing issues". Those are two different
 * findings wearing the same words. If our port renders differently from
 * `client/js/archive-nav-*.js` under the same twelve stylesheets, that
 * is a PORT DEFECT and fixing it restores parity, which is inside the
 * commitments on issue #173. If it renders identically and he simply
 * wants it tighter, that is a RESTYLE, which those commitments forbid
 * without a decision. Only a measurement can tell them apart, and
 * eyeballing two dark rails at 320px cannot.
 *
 * BOTH COLUMNS ARE FED THE SAME CAPTURED ROWS. `nav-real-nodes.fixture.json`
 * is real data taken off the live server, so neither renderer is being
 * shown a shape it would not meet. No request is made and no token is
 * needed: a measurement that required a login is a measurement that gets
 * run once.
 *
 * THE TWO COLUMNS ARE GIVEN IDENTICAL BOXES ON PURPOSE. Same width, same
 * ancestor classes, same document, same theme attribute. The rail
 * declares no width of its own - that is its contract - so a parity page
 * that let the two columns size themselves would be measuring its own
 * layout rather than theirs.
 */
import { mount } from 'svelte';

// The twelve archive stylesheets, byte for byte as they sit on disk.
// The same list `harness-main.ts` imports, and for the same reason: a
// component measured in Chrome's user-agent defaults is not the
// component that ships.
// THE ORDER IS client/index.html's, NOT ALPHABETICAL, AND THAT IS THE
// WHOLE POINT. Four of these twelve override another by LOAD ORDER
// alone, at equal specificity, and index.html says so in as many words
// beside each link: archive-nav-card.css overrides the rail's generic
// project row and so must follow archive-nav.css (and archive-outcomes
// .css), archive-nav-info.css follows the card it belongs to,
// archive-align.css follows archive-reader.css, and archive-panes.css
// follows archive-tlist.css.
//
// Imported alphabetically - which is how this list was first written -
// archive-nav-card.css lands BEFORE archive-nav.css and loses every
// tie. Measured: `.archive-nav__count--sessions { color: accent;
// font-weight: 600 }` was outranked by `.archive-nav__count { color:
// var(--color-fg-muted) }`, so the sessions figure rendered MUTED and
// at weight 400 - it looked like a deliberately quiet number, and the
// four signals the card's header says tell the two counts apart were
// silently down to three. Nothing errored, and both columns of the
// parity page were wrong in exactly the same way, so the comparison
// between them still read as perfect agreement.
//
// A HARNESS THAT LOADS THE RIGHT FILES IN THE WRONG ORDER IS NOT
// SHOWING THE APP. Keep this list in index.html's order, and when a
// stylesheet is added there, add it HERE in the same position.
import '../../client/css/archive-outcomes.css';
import '../../client/css/archive-screen.css';
import '../../client/css/archive-nav.css';
import '../../client/css/archive-nav-card.css';
import '../../client/css/archive-nav-info.css';
import '../../client/css/archive-reader.css';
import '../../client/css/archive-chat.css';
import '../../client/css/archive-search.css';
import '../../client/css/archive-export.css';
import '../../client/css/archive-tlist.css';
import '../../client/css/archive-align.css';
import '../../client/css/archive-panes.css';
// The app's own tokens. Without them every `var(--color-*)` falls back
// to nothing and both columns would be measured in a palette the app
// never uses. Layout does not depend on colour, but `--radius-*` and the
// font stack do.
import '../../client/css/styles.css';

// THE VANILLA RENDERERS, IN DEPENDENCY ORDER. Each is an IIFE that hangs
// its exports off `window`; importing the file runs it, exactly as the
// `<script>` tag in the real app does. `archive-nav-card.js` reads
// `window.ArchiveNavRow` at load and `window.ArchiveNavOrder` at call, so
// order matters and is not alphabetical by accident.
import '../../client/js/archive-outcome.js';
import '../../client/js/archive-outcome-view.js';
import '../../client/js/archive-nav-order.js';
import '../../client/js/archive-nav-row.js';
import '../../client/js/archive-nav-card.js';

import { NavProjectCard } from '../src/lib/plugins/history/index';
import type { NavRowData } from '../src/lib/plugins/history/index';
import real from '../src/lib/plugins/history/nav-real-nodes.fixture.json' with { type: 'json' };
import { measureLevel, reportInto } from './nav-parity-measure';
import { measureChrome, reportChrome } from './nav-parity-chrome';
import { mountOfflineRail } from './nav-parity-rail';
import { measureDensity, reportDensity } from './nav-parity-density';

/** The mount point in `nav-parity.html`. It carries no class, on purpose. */
const ROOT_ID = 'nav-parity-root';

/**
 * The rail width both columns are given.
 *
 * `DevPreviewHarness.svelte` hands the rail `flex: 0 0 320px`, and the
 * vanilla app's own pane is resizable from 272px. 320 is what the owner
 * is actually looking at, so it is what is measured.
 */
const RAIL_WIDTH_PX = 320;

/**
 * The second width the density pass measures at.
 *
 * A LAYOUT MEASURED ONLY WHERE IT IS COMFORTABLE HAS NOT BEEN MEASURED.
 * The counts and the date now share a line, so the interesting number is
 * what gives way when there is not room for both; 320 is where that
 * happens and 480 is the control that shows the same rail with slack.
 * If the two disagree about anything except how many counts runs
 * ellipsised, something other than width is moving.
 */
const WIDE_RAIL_WIDTH_PX = 480;

/** As much of `window` as this page reads back after the imports above. */
interface VanillaWindow {
    ArchiveNavRow?: {
        renderRow: (
            doc: Document, kind: string, row: NavRowData, opts?: unknown,
        ) => HTMLElement;
        NODE_KINDS: Record<string, string>;
    };
    ArchiveNavCard?: unknown;
}

/**
 * Build the two wrapper elements a rail level needs, so both columns sit
 * under identical ancestors.
 *
 * Description: the classes are the vanilla rail's own, copied from
 *   `NavRail.svelte`'s root and level. A column built under a different
 *   ancestor would be measured against different rules and the
 *   comparison would be of this page rather than of the two rails.
 * Inputs: doc - the document to build in.
 * Output: the `nav` to attach and the `ul` to fill.
 * Example: const { nav, level } = buildColumn(document);
 */
function buildColumn(doc: Document): { nav: HTMLElement; level: HTMLElement } {
    const nav = doc.createElement('nav');
    nav.className = 'archive-nav';
    nav.style.width = `${RAIL_WIDTH_PX}px`;
    nav.style.flex = `0 0 ${RAIL_WIDTH_PX}px`;
    const level = doc.createElement('ul');
    level.className = 'archive-nav__level archive-nav__level--merged';
    nav.appendChild(level);
    return { nav, level };
}

/**
 * Fill a level with the VANILLA rail's own cards.
 *
 * Description: it calls `renderRow`, which delegates a project to
 *   `ArchiveNavCard.renderCard` at call time - the same delegation the
 *   shipping app relies on. A missing module is a NAMED refusal rather
 *   than a page that renders one column and silently compares it with
 *   nothing.
 * Inputs: level - the `ul`. rows - the project rows.
 * Output: void.
 */
function fillVanilla(level: HTMLElement, rows: readonly NavRowData[]): void {
    const win = window as unknown as VanillaWindow;
    const api = win.ArchiveNavRow;
    if (!api) {
        throw new Error('client/js/archive-nav-row.js did not publish '
            + 'window.ArchiveNavRow, so the vanilla column cannot be built.');
    }
    if (!win.ArchiveNavCard) {
        throw new Error('client/js/archive-nav-card.js did not publish '
            + 'window.ArchiveNavCard, so the vanilla column would render '
            + 'projects as plain rows and the comparison would be of two '
            + 'different things.');
    }
    // The vanilla module's own literal, read rather than retyped, so the
    // two columns cannot be asked for two different kinds. A module that
    // published no PROJECT kind is a refusal, not a guessed 'project'.
    const kind = api.NODE_KINDS.PROJECT;
    if (typeof kind !== 'string') {
        throw new Error('window.ArchiveNavRow.NODE_KINDS has no PROJECT, so '
            + 'the vanilla column cannot be asked for the kind the svelte '
            + 'column is rendering.');
    }
    for (const row of rows) {
        level.appendChild(api.renderRow(document, kind, row, {}));
    }
}

/**
 * Fill a level with the SVELTE rail's own cards.
 *
 * Description: one `mount` per row, into the same `ul`, because that is
 *   how `NavRail.svelte`'s `{#each}` puts them there - one `li` per
 *   project, siblings in one level. `onActivate` and `onInfo` are left
 *   off: this page measures boxes and a click here would mean nothing.
 * Inputs: level - the `ul`. rows - the project rows.
 * Output: void.
 */
function fillSvelte(level: HTMLElement, rows: readonly NavRowData[]): void {
    for (const row of rows) {
        mount(NavProjectCard, { target: level, props: { row } });
    }
}

/**
 * Wait for one painted frame, but never longer than a timer.
 *
 * Description: A BARE `requestAnimationFrame` NEVER RESOLVES IN A
 *   BACKGROUNDED TAB - a browser does not paint one, so it never runs
 *   that tab's frame callbacks. This page was written with a bare one
 *   and, opened in a tab that was not in front, sat on "measuring..."
 *   forever with every column correctly rendered behind it. That is
 *   gotcha 9 in the project's own CLAUDE.md, and the answer there is the
 *   answer here: a frame wait may DELAY the work, never CANCEL it. The
 *   timer is a backstop and not the normal path - in a visible tab the
 *   frame wins every time.
 * Inputs: none.
 * Output: a promise that settles once laid out, or after the backstop.
 * Example: await paintedFrame();
 */
function paintedFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        requestAnimationFrame(() => finish());
        setTimeout(finish, FRAME_BACKSTOP_MS);
    });
}

/** How long to wait for a frame before measuring anyway. */
const FRAME_BACKSTOP_MS = 300;

/** A heading over one column, so a screenshot says which is which. */
function heading(doc: Document, text: string): HTMLElement {
    const h = doc.createElement('p');
    h.textContent = text;
    h.style.margin = '0 0 6px 0';
    h.style.font = '11px system-ui, sans-serif';
    h.style.color = '#9a9a9a';
    return h;
}

/**
 * Build both columns, measure them, and print the verdict.
 *
 * Description: a MISSING ROOT IS A NAMED REFUSAL, the same contract
 *   `harness-main.ts` keeps, so editing the html and breaking the id
 *   reads as a sentence rather than as a null dereference. The columns
 *   are attached to the document BEFORE anything is measured, because a
 *   detached element measures zero on every box and two zeros compare
 *   equal.
 * Inputs: none. Output: void.
 */
function start(): void {
    const target = document.getElementById(ROOT_ID);
    if (!target) {
        console.error(`[nav-parity] there is no #${ROOT_ID} in the page, so `
            + 'nothing was measured.');
        return;
    }
    const rows = real as unknown as readonly NavRowData[];

    const report = document.createElement('pre');
    report.style.margin = '0';
    report.style.padding = '10px 12px';
    report.style.font = '12px ui-monospace, monospace';
    report.style.whiteSpace = 'pre-wrap';
    report.style.color = '#d4d4d4';
    report.style.background = '#111';
    report.textContent = 'measuring...';

    const columns = document.createElement('div');
    columns.style.display = 'flex';
    columns.style.gap = '24px';
    columns.style.alignItems = 'flex-start';
    columns.style.padding = '10px 12px';

    const left = buildColumn(document);
    const right = buildColumn(document);
    const leftBox = document.createElement('div');
    const rightBox = document.createElement('div');
    leftBox.appendChild(heading(document, 'svelte (our port)'));
    leftBox.appendChild(left.nav);
    rightBox.appendChild(heading(document, 'vanilla (client/js)'));
    rightBox.appendChild(right.nav);

    // THE THIRD COLUMN IS THE WHOLE RAIL, not a third set of cards. It
    // is the only one of the three that has the chrome above the cards,
    // which is the thing the top-spacing complaint is about. It is
    // given the same 320px box so its cards stay comparable with the
    // other two rather than becoming a fourth measurement.
    const railBox = document.createElement('div');
    railBox.appendChild(heading(document, 'svelte, the whole rail (chrome + cards)'));
    const railHost = document.createElement('div');
    railHost.style.width = `${RAIL_WIDTH_PX}px`;
    railHost.style.height = '560px';
    railBox.appendChild(railHost);

    columns.appendChild(leftBox);
    columns.appendChild(rightBox);
    columns.appendChild(railBox);

    document.body.style.margin = '0';
    document.body.style.background = '#1a1a1a';
    target.appendChild(report);
    target.appendChild(columns);

    try {
        fillSvelte(left.level, rows);
        fillVanilla(right.level, rows);
    } catch (err: unknown) {
        report.textContent = `REFUSED: ${err instanceof Error ? err.message : String(err)}`;
        return;
    }

    // The whole rail is mounted and its rows loaded before anything is
    // measured. An awaited load that is not awaited leaves the chrome
    // laid out against an EMPTY level, where the filter-empty message
    // sits where the first card goes - so the gap measured would be a
    // gap above a different thing.
    mountOfflineRail(railHost, rows).then(async () => {
        // One painted frame, so the browser has laid every column out
        // before any box is read. Reading in the same task returns the
        // pre-layout geometry for whichever column the engine had not
        // reached yet, which is a difference this page would then report
        // as a real one.
        await paintedFrame();
        reportInto(
            report,
            measureLevel('svelte', left.level),
            measureLevel('vanilla', right.level),
        );
        // THE DENSITY PASS. The vanilla column is the BEFORE: it is the
        // same rows under the same twelve stylesheets with the counts
        // and the date still stacked, so it is a control this page
        // already had rather than a number quoted from a previous run.
        // Widths are set here and the svelte column is left back at
        // RAIL_WIDTH_PX, which is what every other measurement on this
        // page assumes.
        const density: string[] = [
            ...reportDensity(measureDensity(
                'vanilla, two lines (the before)', right.nav, right.level, RAIL_WIDTH_PX,
            )),
            ...reportDensity(measureDensity(
                'svelte, one line (the after)', left.nav, left.level, WIDE_RAIL_WIDTH_PX,
            )),
            ...reportDensity(measureDensity(
                'svelte, one line (the after)', left.nav, left.level, RAIL_WIDTH_PX,
            )),
        ];
        report.textContent = `${report.textContent}\n\ncounts and date on `
            + `one line:\n${density.join('\n')}`;

        const nav = railHost.querySelector<HTMLElement>('.archive-nav');
        const lines = nav
            ? reportChrome(measureChrome('svelte rail', nav))
            : ['the whole-rail column did not mount, so the chrome above '
                + 'the cards was NOT measured.'];
        report.textContent = `${report.textContent}\n\nthe chrome above the `
            + `first card:\n${lines.join('\n')}`;
    }).catch((err: unknown) => {
        report.textContent = `${report.textContent}\n\nthe whole-rail column `
            + `REFUSED: ${err instanceof Error ? err.message : String(err)}`;
    });
}

start();
