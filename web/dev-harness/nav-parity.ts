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
import '../../client/css/archive-align.css';
import '../../client/css/archive-chat.css';
import '../../client/css/archive-export.css';
import '../../client/css/archive-nav-card.css';
import '../../client/css/archive-nav-info.css';
import '../../client/css/archive-nav.css';
import '../../client/css/archive-outcomes.css';
import '../../client/css/archive-panes.css';
import '../../client/css/archive-reader.css';
import '../../client/css/archive-screen.css';
import '../../client/css/archive-search.css';
import '../../client/css/archive-tlist.css';
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
    columns.appendChild(leftBox);
    columns.appendChild(rightBox);

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

    // One frame, so the browser has laid both columns out before any box
    // is read. Reading in the same task returns the pre-layout geometry
    // for whichever column the engine had not reached yet, which is a
    // difference this page would then report as a real one.
    requestAnimationFrame(() => {
        reportInto(
            report,
            measureLevel('svelte', left.level),
            measureLevel('vanilla', right.level),
        );
    });
}

start();
