/**
 * THE ROW'S PURE DECISIONS, AND THE DISTINCTIONS THEY REFUSE TO COLLAPSE.
 *
 * Three pairs run through this file and every one of them is a pair the
 * vanilla renderer went out of its way to keep apart. Collapsing any of
 * them produces a UI that is confidently wrong rather than visibly
 * broken, which is why they get tests rather than comments:
 *   "no name" versus "the name lookup FAILED"
 *   "a person named this" versus "a machine guessed this"
 *   "no project" versus "no established HOST"
 *
 * A MATCHER THAT ALWAYS FINDS SOMETHING IS WORSE THAN USELESS, so
 * `titleSource` gets a totality control: it is exercised with a value it
 * has never heard of and must answer NOT KNOWN rather than falling into
 * whichever branch an if-chain happened to end on.
 *
 * Node environment: every assertion is about a returned value.
 */
import { describe, it, expect } from 'vitest';
import {
    activeSchemeLabel,
    describeFilter,
    displayTitle,
    fuzzyNote,
    isUnestablished,
    nextScheme,
    rowValue,
    titleSource,
    wireScheme,
} from './tlist-row';
import { SCHEME_DEFS, SCHEME_FILTERS, DEFAULT_SCHEME } from './tlist-vocab';

describe('wireScheme', () => {
    it('sends null for "all", because the server has no such scheme', () => {
        // `session_ref_scheme=all` is an UNKNOWN scheme and answers 400,
        // so "no filter" has to be an OMITTED parameter.
        expect(wireScheme('all')).toBeNull();
        expect(wireScheme('')).toBeNull();
        expect(wireScheme(null)).toBeNull();
    });

    it('passes a real scheme through unchanged', () => {
        expect(wireScheme('uuid')).toBe('uuid');
        expect(wireScheme('agent')).toBe('agent');
    });
});

describe('titleSource: a guess never renders as a name', () => {
    it('calls a typed name NAMED, and nothing outranks it', () => {
        const d = titleSource({ title: 'my session', title_source: 'custom-title' });
        expect(d.kind).toBe('human');
        expect(d.label).toBe('NAMED');
    });

    it('calls a last-prompt excerpt what it is, not a title', () => {
        const d = titleSource({ title: 'yes', title_source: 'last-prompt' });
        expect(d.kind).toBe('weak');
        expect(d.label).toContain('NOT A NAME');
        // A human name and this must not share a modifier, or the
        // stylesheet cannot draw them differently.
        expect(d.mod).not.toBe(
            titleSource({ title: 'x', title_source: 'custom-title' }).mod,
        );
    });

    it('keeps "no name" and "the lookup FAILED" apart, and checks the '
        + 'failure FIRST', () => {
        // Both carry a null title. Testing the empty title first would
        // collapse them into NOT NAMED, which reports a measurement the
        // server explicitly declined to make.
        const failed = titleSource({ title: null, title_source: 'cannot_determine' });
        const absent = titleSource({ title: null, title_source: null });
        expect(failed.label).toBe('NAME LOOKUP FAILED');
        expect(absent.label).toBe('NOT NAMED');
        expect(failed.kind).not.toBe(absent.kind);
    });

    it('NEGATIVE CONTROL: a title_source it has never heard of answers '
        + 'NOT KNOWN, never a name', () => {
        const d = titleSource({ title: 'looks real', title_source: 'invented-later' });
        expect(d.label).toBe('NAME SOURCE NOT KNOWN');
        expect(d.kind).toBe('cannot-determine');
        // The control that matters: it must NOT have landed on 'human'.
        expect(d.kind).not.toBe('human');
    });

    it('is total: no input throws and every input has a label', () => {
        for (const row of [
            null, undefined, {}, { title: '' }, { title_source: 'summary' },
            { title: 'x', title_source: undefined },
        ]) {
            const d = titleSource(row as never);
            expect(typeof d.label).toBe('string');
            expect(d.label.length).toBeGreaterThan(0);
            expect(d.mod).toContain('archive-tlist__source--');
        }
    });
});

describe('displayTitle: the fallback must not imply a name exists', () => {
    it('leads with the title when there is one', () => {
        expect(displayTitle({ title: 'a name', session_ref: 'r' }))
            .toEqual({ text: 'a name', isTitle: true });
    });

    it('leads with the ref but says it is NOT a title', () => {
        expect(displayTitle({ session_ref: 'journal' }))
            .toEqual({ text: 'journal', isTitle: false });
    });

    it('states the absence rather than rendering an empty cell', () => {
        const d = displayTitle({});
        expect(d.isTitle).toBe(false);
        expect(d.text).toContain('no name and no session_ref');
    });
});

describe('isUnestablished', () => {
    it('treats cannot_determine and unknown as not established', () => {
        expect(isUnestablished('cannot_determine')).toBe(true);
        expect(isUnestablished('unknown')).toBe(true);
    });

    it('NEGATIVE CONTROL: a real host value is ESTABLISHED, so a matcher '
        + 'that flagged everything fails here', () => {
        expect(isUnestablished('mac-mini-m4')).toBe(false);
        expect(isUnestablished('host-1')).toBe(false);
    });
});

describe('rowValue: filters see what is on screen', () => {
    it('reads the date as the FORMATTED string, not the raw epoch', () => {
        const v = rowValue({ ingested_at: '2026-08-31T12:00:00Z' }, 'date');
        // Filtering a value the person cannot see makes a filter that
        // fails for reasons nobody can inspect. The exact format is
        // format.ts's business; that it is NOT the raw ISO string is this
        // function's.
        expect(v).not.toBe('2026-08-31T12:00:00Z');
        expect(v.length).toBeGreaterThan(0);
    });

    it('returns an empty string for a column it does not know', () => {
        expect(rowValue({ title: 'x' }, 'invented')).toBe('');
    });
});

describe('describeFilter: the server-side honesty line', () => {
    it('says nothing at all when no filter is applied', () => {
        expect(describeFilter(50, null)).toBe('');
        expect(describeFilter(50, { applied: false })).toBe('');
    });

    it('states the SCOPE count, not the loaded count, and quotes the '
        + 'server caveat verbatim', () => {
        const line = describeFilter(50, {
            applied: true,
            session_ref_scheme: 'uuid',
            matched_in_scope: 77,
            scope_total_before_filter: 3416,
            session_ref_scheme_means: 'matches the column and nothing else',
        });
        expect(line).toContain('WHOLE scope');
        expect(line).toContain('77');
        expect(line).toContain('3,416');
        expect(line).toContain('matches the column and nothing else');
    });

    it('says NOT KNOWN when the server did not report the scope count', () => {
        const line = describeFilter(50, { applied: true, session_ref_scheme: 'uuid' });
        expect(line).toContain('NOT KNOWN');
    });
});

describe('fuzzyNote: the client-side line, with its own scope', () => {
    it('draws nothing when no column is filtered', () => {
        expect(fuzzyNote(0, 50, true, false)).toBe('');
    });

    it('always says it cannot see unloaded pages', () => {
        const line = fuzzyNote(3, 50, false, true);
        expect(line).toContain('LOADED SO FAR');
        expect(line).toContain('does not ask the server');
    });

    it('NEGATIVE CONTROL: has_more null says NOT KNOWN, not "that is all"', () => {
        const unknown = fuzzyNote(3, 50, null, true);
        const ended = fuzzyNote(3, 50, false, true);
        expect(unknown).toContain('NOT KNOWN');
        expect(ended).not.toContain('NOT KNOWN');
        expect(unknown).not.toBe(ended);
    });
});

describe('nextScheme and activeSchemeLabel', () => {
    it('cycles in the table order, which is also the draw order', () => {
        expect(nextScheme(SCHEME_FILTERS.ALL, SCHEME_DEFS))
            .toBe(SCHEME_FILTERS.CONVERSATIONS);
        expect(nextScheme(SCHEME_FILTERS.CONVERSATIONS, SCHEME_DEFS))
            .toBe(SCHEME_FILTERS.SIDECHAINS);
        expect(nextScheme(SCHEME_FILTERS.SIDECHAINS, SCHEME_DEFS))
            .toBe(SCHEME_FILTERS.ALL);
    });

    it('RESTARTS at the first entry from an unrecognised value rather '
        + 'than sticking or throwing', () => {
        expect(nextScheme('nonsense', SCHEME_DEFS)).toBe(SCHEME_FILTERS.ALL);
    });

    it('NAMES an unknown scheme rather than showing the first option', () => {
        // A control that displays a choice nobody made is how a filter
        // becomes untrustworthy.
        expect(activeSchemeLabel('nonsense', SCHEME_DEFS))
            .toBe('UNKNOWN FILTER (nonsense)');
        expect(activeSchemeLabel(DEFAULT_SCHEME, SCHEME_DEFS))
            .toBe('My sessions');
    });
});
