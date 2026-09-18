/**
 * THE WHOLE RAIL, OFFLINE, SO THE CHROME ABOVE THE CARDS CAN BE
 * MEASURED. SCAFFOLDING, like everything else in `web/dev-harness/`.
 *
 * WHY IT EXISTS. `nav-parity.ts` mounts `NavProjectCard` into a
 * hand-built `<ul>`, which is the right instrument for a CARD and the
 * wrong one for the question "what produces the gap above the first
 * card". That gap is made by the rail's own chrome - the filter input,
 * the order control, the filter note and `.archive-nav`'s padding - and
 * NONE of those exist in a hand-built column. Measuring a replica of
 * them would be measuring this file.
 *
 * So this mounts the REAL `NavRail`, with the real chrome, against the
 * same captured fixture rows the other two columns get.
 *
 * IT MAKES NO REQUEST AND NEEDS NO LOGIN. The client below answers from
 * the fixture. That is the whole point: the harness at `index.html`
 * shows the real rail and demands a TOTP code, so the numbers that
 * decide a density change could only ever be taken by somebody already
 * logged in. A measurement with a login in front of it is a measurement
 * nobody re-runs.
 *
 * IT IS NOT A FAKE OF THE SERVER. It answers exactly the four listing
 * calls the rail makes, with the envelope shape the granted client
 * returns, and refuses nothing - there is no failure mode modelled here
 * because no failure mode is being measured. If you need to measure a
 * refusal, add it to the harness at `index.html`, which talks to the
 * real server.
 */
import { mount } from 'svelte';
import { NavRail } from '../src/lib/plugins/history/index';
import type { NavRowData } from '../src/lib/plugins/history/index';
import type { OutcomeClassifier } from '../src/lib/plugins/history/index';

/** As much of the mounted rail as this file drives. */
interface RailApi {
    loadMergedProjects(): Promise<string>;
}

/**
 * One envelope result, shaped as the granted client returns it.
 *
 * Description: the four fields `client.ts` promises. `headers` is null
 *   rather than an empty object because nothing on this path reads one,
 *   and an empty object would look like a response that carried none.
 * Inputs: body - the parsed envelope.
 * Output: the result the rail's loaders unwrap.
 */
function envelope(body: unknown): unknown {
    return {
        envelope: body, httpStatus: 200, headers: null,
        transportError: null, refusedByGrant: false,
    };
}

/**
 * A client that answers the rail's four listing calls from a fixture.
 *
 * Description: only the merged list carries rows. The by-machine tree is
 *   not reachable in the UI (the rail's header says the view bar was
 *   removed at the owner's instruction), so answering its three calls
 *   with empty lists is accurate rather than lazy: there is nothing to
 *   measure behind a control nobody can click.
 * Inputs: rows - the captured project rows.
 * Output: an object with the four methods `NavRail` calls.
 * Example: mountOfflineRail(host, rows as readonly NavRowData[]);
 */
function offlineClient(rows: readonly NavRowData[]): unknown {
    const empty = envelope({ result: [], result_status: 'ok', meta: {} });
    return {
        listArchiveMergedProjects: () => Promise.resolve(envelope({
            result: rows,
            result_status: 'ok',
            meta: { unattributed: { by_corpus: [] }, hosts: [] },
        })),
        listArchiveHosts: () => Promise.resolve(empty),
        listArchiveCorpora: () => Promise.resolve(empty),
        listArchiveProjects: () => Promise.resolve(empty),
    };
}

/**
 * The classifier, standing in for the still-vanilla `archive-outcome.js`.
 *
 * It reads the envelope's own `result_status` rather than asserting one,
 * so a fixture that ever carries a refusal is classified as the refusal
 * it is instead of being forced green.
 */
const outcome: OutcomeClassifier = {
    classify(env: unknown) {
        const e = env as { result_status?: string } | null;
        return { token: e?.result_status || 'transport_failed', reasons: [], meta: null };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore: () => null,
};

/**
 * Mount the real rail into a host element and load the fixture into it.
 *
 * Description: the load is awaited by the caller, because the chrome
 *   above the cards is laid out against a level that HAS cards in it -
 *   an empty rail puts the filter-empty message where the first card
 *   goes and the gap measured would be a different gap.
 * Inputs: host - the element to mount into. rows - the fixture rows.
 * Output: a promise resolving once the rows are painted.
 * Example: await mountOfflineRail(box, rows);
 */
export async function mountOfflineRail(
    host: HTMLElement, rows: readonly NavRowData[],
): Promise<void> {
    const api = mount(NavRail, {
        target: host,
        props: {
            client: offlineClient(rows), outcome, onSelect: () => {},
            store: null, modalStack: null, modalHost: null,
        } as never,
    }) as unknown as RailApi;
    await api.loadMergedProjects();
}
