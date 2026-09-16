/**
 * THE DRILL-DOWN'S STATE RULES.
 *
 * There is no vanilla counterpart to compare against here and that is
 * the point of the file. `archive-nav-drill.js` and `archive-nav-tree.js`
 * mixed the RULES with `document.createElement` and `querySelectorAll`,
 * so the rules were only reachable through a DOM. They are data now, and
 * this asserts them directly. The two rules that came across intact are
 * called out by name below.
 */
import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from './nav-vocab';
import {
    HOSTS_KEY, LEVEL_FIELDS, applyLevel, childKind, emptyLevel, levelKey,
    loadedCorpora, unattributedRowFor, type DrillState,
} from './nav-drill';
import { applyMerged, emptyMerged } from './nav-merged-load';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

const outcome: OutcomeClassifier = {
    classify(envelope: unknown) {
        const e = envelope as { result_status?: string; meta?: unknown } | null;
        return {
            token: e?.result_status || 'transport_failed',
            reasons: [],
            meta: (e?.meta as Record<string, unknown>) || null,
        };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore: () => null,
};

function result(body: unknown, transportError: string | null = null): EnvelopeResult {
    return {
        envelope: body, httpStatus: transportError ? 0 : 200, headers: null,
        transportError, refusedByGrant: false,
    } as EnvelopeResult;
}

describe('the level keys are the vanilla keys, because the honest filter '
    + 'note keys its server total on them too', () => {
    it('maps a host to corpora and a corpus to projects', () => {
        expect(levelKey(NODE_KINDS.HOST, 2)).toBe('corpora:2');
        expect(levelKey(NODE_KINDS.CORPUS, 7)).toBe('projects:7');
        expect(HOSTS_KEY).toBe('hosts');
    });

    it('childKind says what a level LISTS', () => {
        expect(childKind(NODE_KINDS.HOST)).toBe(NODE_KINDS.CORPUS);
        expect(childKind(NODE_KINDS.CORPUS)).toBe(NODE_KINDS.PROJECT);
    });

    it('the filter fields are a TABLE, so a level added later cannot '
        + 'silently inherit the wrong list', () => {
        expect(LEVEL_FIELDS[NODE_KINDS.HOST]).toEqual(['display_name', 'hostname']);
        expect(LEVEL_FIELDS[NODE_KINDS.CORPUS]).toEqual(['corpus_key', 'root_path']);
        expect(LEVEL_FIELDS[NODE_KINDS.PROJECT]).toEqual(['slug', 'observed_cwd']);
    });
});

describe('applyLevel', () => {
    it('keeps the rows and the count on a renderable answer', () => {
        const out = applyLevel(result({
            result: [{ host_id: 1 }, { host_id: 2 }], result_status: 'ok', meta: {},
        }), outcome);
        expect(out.rows).toHaveLength(2);
        expect(out.total).toBe(2);
        expect(out.token).toBe('ok');
        expect(out.outcomeEnvelope).toBeNull();
    });

    it('A PARTIAL KEEPS ITS ROWS AND ITS BANNER. Dropping the rows hides '
        + 'what did come back; dropping the banner claims the list is '
        + 'complete', () => {
        const out = applyLevel(result({
            result: [{ host_id: 1 }], result_status: 'partial', meta: {},
        }), outcome);
        expect(out.rows).toHaveLength(1);
        expect(out.partialEnvelope).not.toBeNull();
    });

    it('A REFUSAL IS RENDERED, NEVER SWALLOWED: no rows, and the envelope '
        + 'is carried so the reason lands where the person clicked', () => {
        const out = applyLevel(result({ result_status: 'cannot_determine', meta: {} }), outcome);
        expect(out.rows).toHaveLength(0);
        expect(out.total).toBeNull();
        expect(out.outcomeEnvelope).not.toBeNull();
        expect(out.transportError).toBeNull();
    });

    it('a TRANSPORT failure carries the reason and NOT the envelope, which '
        + 'is how the interpreter produces transport-error', () => {
        const out = applyLevel(result(null, 'connection refused'), outcome);
        expect(out.transportError).toBe('connection refused');
        expect(out.outcomeEnvelope).toBeNull();
        expect(out.rows).toHaveLength(0);
    });

    it('a body with no `result` array yields no rows rather than throwing', () => {
        expect(applyLevel(result({ result_status: 'ok', meta: {} }), outcome).rows)
            .toHaveLength(0);
        expect(applyLevel(result({ result: 'nope', result_status: 'ok' }), outcome).rows)
            .toHaveLength(0);
    });
});

describe('the unattributed node finds its own count', () => {
    const state: DrillState = {
        hosts: { ...emptyLevel(), rows: [{ host_id: 1 }] },
        'corpora:1': { ...emptyLevel(), rows: [
            { corpus_id: 7, unattributed_transcript_count: 5 },
            { corpus_id: 8, unattributed_transcript_count: 0 },
        ] },
        'projects:7': { ...emptyLevel(), rows: [{ project_id: 3 }] },
    };

    it('flattens only the corpora levels', () => {
        expect(loadedCorpora(state)).toHaveLength(2);
        expect(loadedCorpora({}).length).toBe(0);
    });

    it('uses the row the server reported the count on', () => {
        expect(unattributedRowFor(loadedCorpora(state), 7))
            .toMatchObject({ unattributed_transcript_count: 5 });
        expect(unattributedRowFor(loadedCorpora(state), '7'))
            .toMatchObject({ unattributed_transcript_count: 5 });
    });

    it('A CORPUS THIS RAIL HAS NOT LISTED YIELDS A NODE WITH NO COUNT, '
        + 'which renders NOT KNOWN rather than 0', () => {
        const row = unattributedRowFor(loadedCorpora(state), 99);
        expect(row).toEqual({ corpus_id: 99 });
        expect(row.unattributed_transcript_count).toBeUndefined();
    });
});

describe('NEGATIVE CONTROL: an unfetched level holds nothing', () => {
    it('emptyLevel has no rows, no total and no verdict', () => {
        const out = emptyLevel();
        expect(out.rows).toHaveLength(0);
        // `total` is NULL and not 0: "not fetched" and "fetched and empty"
        // are different findings, and the filter note quotes this number.
        expect(out.total).toBeNull();
        expect(out.token).toBe('idle');
        expect(out.outcomeEnvelope).toBeNull();
        expect(out.transportError).toBeNull();
    });
});

describe('applyMerged: the same shape, for the listing that is not paged', () => {
    it('A REFUSAL KEEPS NOTHING, which is the one way it differs from '
        + 'applyPage: that one is PAGED and keeps its rows because a '
        + 'refusal answered one page; this listing is not, so a refusal '
        + 'answered the whole question', () => {
        const ok = applyMerged(result({
            result: [{ project_id: 1 }], result_status: 'ok',
            meta: { unattributed: { by_corpus: [{ corpus_id: 2 }] }, hosts: [{ host_id: 1 }] },
        }), outcome);
        expect(ok.nodes).toHaveLength(1);
        expect(ok.unattributed).toHaveLength(1);
        expect(ok.hosts).toHaveLength(1);
        expect(ok.total).toBe(1);

        const refused = applyMerged(result({ result_status: 'cannot_determine', meta: {} }), outcome);
        expect(refused.nodes).toHaveLength(0);
        expect(refused.total).toBeNull();
        expect(refused.outcomeEnvelope).not.toBeNull();
    });

    it('a partial keeps its rows AND its banner', () => {
        const out = applyMerged(result({
            result: [{ project_id: 1 }], result_status: 'partial', meta: {},
        }), outcome);
        expect(out.nodes).toHaveLength(1);
        expect(out.partialEnvelope).not.toBeNull();
    });

    it('a transport failure carries the reason and not the envelope', () => {
        const out = applyMerged(result(null, 'connection refused'), outcome);
        expect(out.transportError).toBe('connection refused');
        expect(out.outcomeEnvelope).toBeNull();
    });

    it('emptyMerged reports `total` NULL, so "not fetched" cannot read as '
        + '"fetched and empty"', () => {
        expect(emptyMerged().total).toBeNull();
        expect(emptyMerged().nodes).toHaveLength(0);
        expect(emptyMerged().token).toBe('idle');
    });
});
