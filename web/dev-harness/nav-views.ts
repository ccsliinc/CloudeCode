/**
 * WHAT A PROJECT ROW ACTUALLY SAYS, IN EVERY VIEW OF THE RAIL.
 * SCAFFOLDING.
 *
 * WHY THIS PAGE EXISTS. `nav-parity.html` measures `NavProjectCard` in
 * isolation and mounts the rail against a FAKE CLIENT, so it could not
 * see a defect that lived in `client.ts` and it exercised only the
 * merged view. Four verifications passed against it while the owner
 * looked at slugs. This page answers the question those could not: for
 * each of the rail's two views, what LITERAL TEXT does a project row
 * carry, given the bytes the live server actually returns.
 *
 * THERE ARE EXACTLY TWO VIEWS, `VIEWS.MERGED` and `VIEWS.HOSTS`, and
 * BOTH are drawn here. Note what the rail already does and what the
 * handed-down diagnosis said it did: `NavLevel.svelte` branches
 * `kind === PROJECT` to `NavProjectCard`, so the by-machine view has
 * ALWAYS used the same card and the same resolver as the merged one.
 * `NavNode.svelte` draws hosts, corpora and the unattributed node and
 * has never drawn a project. Neither view was rendering the wrong
 * component; neither view was being sent the field.
 *
 * THREE ARMS, AND THE THIRD IS THE CONTROL. Merged and by-machine are
 * the two views. The third is the merged view with `/archive/projects`
 * made unreachable, which reproduces the pre-fix state exactly - an
 * incomplete join index, nothing carried, the slug on every card. A
 * page whose every arm showed a name would prove only that the page can
 * print a name.
 *
 * IT NEEDS NO LOGIN. The captured envelopes are read off disk, so this
 * runs with no token and no TOTP code. What that costs is stated rather
 * than hidden: this proves the RENDERING against the server's real
 * bytes, and it does not prove the owner's authenticated session
 * delivers those same bytes over HTTP.
 *
 * Delete it with the rest of `web/dev-harness/` when the real shell
 * lands.
 */
// THE TWELVE SHARED STYLESHEETS, IN index.html's ORDER. Copied from
// `nav-parity.ts`, which carries the full argument for why the order is
// load-bearing: `archive-nav-card.css` overrides the rail's generic
// project row and must follow `archive-nav.css`. None of them is
// MODIFIED by this change; they are loaded so the card measured here is
// the card the app draws, at its real 49px.
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
import '../../client/css/styles.css';

import { mount } from 'svelte';
import { NavRail, createArchiveClient } from '../src/lib/plugins/history/index';
import type { OutcomeClassifier } from '../src/lib/plugins/history/state';
import { harnessTransport, type LiveEnvelopes } from './nav-views-transport';
import { reportHtml, readArm, type ArmReading } from './nav-views-report';

/** Where the capture script writes the live envelopes. */
const CAPTURE_URL = './live-envelopes.json';

/** As much of the mounted rail as this page drives. */
interface RailApi {
    loadMergedProjects(): Promise<string>;
    setView(next: string): Promise<string>;
    expand(kind: string, id: number | string): Promise<string>;
}

/**
 * Read the envelope's own `result_status` rather than asserting one, so
 * a capture that carries a refusal is classified as the refusal it is
 * instead of being forced green.
 */
const outcome: OutcomeClassifier = {
    classify(env: unknown) {
        const e = env as { result_status?: string } | null;
        return { token: e?.result_status || 'transport_failed', reasons: [], meta: null };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore: () => null,
};

/** Mount one rail into its own column and hand back its exported API. */
function mountRail(host: HTMLElement, live: LiveEnvelopes, broken: boolean): RailApi {
    const client = createArchiveClient(
        harnessTransport(live, { breakNamedRoute: broken }),
    );
    return mount(NavRail, {
        target: host,
        props: {
            client, outcome, onSelect: () => {},
            store: null, modalStack: null, modalHost: null,
        } as never,
    }) as unknown as RailApi;
}

/** Build one labelled column and return the element the rail mounts into. */
function column(root: HTMLElement, heading: string, note: string): HTMLElement {
    const wrap = document.createElement('section');
    wrap.className = 'nav-views__col';
    const h = document.createElement('h2');
    h.textContent = heading;
    const p = document.createElement('p');
    p.className = 'nav-views__note';
    p.textContent = note;
    const box = document.createElement('div');
    box.className = 'nav-views__rail';
    wrap.append(h, p, box);
    root.appendChild(wrap);
    return box;
}

/** Let the browser lay the rail out before anything is read off it. */
function painted(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/** Load the capture, mount the three arms, and publish the report. */
async function run(): Promise<void> {
    const root = document.getElementById('nav-views-root');
    const out = document.getElementById('nav-views-report');
    if (!root || !out) return;

    let live: LiveEnvelopes;
    try {
        const res = await fetch(CAPTURE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        live = await res.json() as LiveEnvelopes;
    } catch (err) {
        // NAMED, NOT SWALLOWED. A missing capture is the one failure
        // that would otherwise look like "every row is a slug", which is
        // the exact wrong conclusion to hand the next reader.
        out.textContent = 'CAPTURE MISSING: could not read live-envelopes.json '
            + `(${String(err)}). Run web/dev-harness/capture_live_envelopes.py `
            + 'first. Nothing was measured.';
        out.setAttribute('data-state', 'no-capture');
        return;
    }

    const mergedBox = column(root, 'view: merged',
        'the default view, and the only one reachable by clicking');
    const hostsBox = column(root, 'view: hosts',
        'the by-machine drill-down, host > corpus > project');
    const controlBox = column(root, 'CONTROL: merged, /archive/projects unreachable',
        'reproduces the pre-fix state. Every row here MUST be a slug.');
    const hostsControlBox = column(root, 'CONTROL: hosts, /archive/projects unreachable',
        'the same control for the other view. It is ALSO what pins the '
        + 'by-machine card height, which differs from the merged one for a '
        + 'reason that predates this change: the per-corpus rows carry no '
        + 'newest_activity_at, so no date cell is drawn. Both control arms '
        + 'report the same heights as their decorated twins or the naming '
        + 'moved the card.');

    const mergedRail = mountRail(mergedBox, live, false);
    const hostsRail = mountRail(hostsBox, live, false);
    const controlRail = mountRail(controlBox, live, true);
    const hostsControlRail = mountRail(hostsControlBox, live, true);

    await mergedRail.loadMergedProjects();
    await controlRail.loadMergedProjects();

    const hostRows = (live.hosts as { result?: { host_id: number }[] })?.result || [];
    for (const rail of [hostsRail, hostsControlRail]) {
        await rail.setView('hosts');
        for (const h of hostRows) {
            await rail.expand('host', h.host_id);
            const cs = (live.corpora[String(h.host_id)] as
                { result?: { corpus_id: number }[] })?.result || [];
            for (const c of cs) await rail.expand('corpus', c.corpus_id);
        }
    }

    await painted();

    const readings: ArmReading[] = [
        readArm('merged', mergedBox),
        readArm('hosts', hostsBox),
        readArm('control-merged-undecorated', controlBox),
        readArm('control-hosts-undecorated', hostsControlBox),
    ];
    out.innerHTML = reportHtml(readings);
    out.setAttribute('data-state', 'ready');
}

void run();
