/**
 * THE JOIN, AND THE SEVEN WAYS A SESSION CAN FAIL TO BE PLACED.
 *
 * Ported from `tests/test_project_session_tree.node.mjs` and
 * `tests/test_ended_sessions_visibility.node.mjs`, which drove the
 * legacy renderer's HTML output through a DOM parser. These assert the
 * DECISION instead: which bucket a session landed in and, when it landed
 * in NEEDS ATTENTION, WHICH OF THE SEVEN REASONS put it there. That is
 * the assertion that survives a CSS change, and it is the one that
 * actually catches the failure this file exists for.
 *
 * WHY EVERY REASON GETS ITS OWN NAMED TEST. A lost branch in
 * `buildProjectSessionGroups` does not throw, does not log and does not
 * render an error - it renders a green tree with a session filed under a
 * project nobody proved it belongs to. Five reasons collapse into four
 * without a single visible symptom. So each is asserted BY KEY, and the
 * negative half of each ("and it is NOWHERE else in the tree") is
 * asserted too, because a session appearing in two buckets is the other
 * way this goes wrong.
 */
import { describe, expect, test } from 'vitest';

import { instanceKey } from '../sessions/attribution';
import type { SessionRecord } from '../sessions/types';
import {
    ATTENTION_REASON,
    buildProjectSessionGroups,
    endedSessionsForTree,
    rowKey,
    type JoinInput,
    type TreeSessionRow,
} from './project-groups';

/** A live running-session row, with only what the join reads. */
function live(name: string, epoch = 100): TreeSessionRow {
    return { name, created_at_epoch: epoch, status: 'idle' };
}

/** A stored record, with only what the join reads. */
function record(patch: Partial<SessionRecord>): SessionRecord {
    return {
        id: 1,
        tmux_name: 'cloude_a',
        tmux_created_epoch: 100,
        lifecycle: 'running',
        project_id: 7,
        project_attribution: 'project',
        archived_at: null,
        parent_session_id: null,
        ...patch,
    };
}

/** A join snapshot whose listing SUCCEEDED and whose maps are empty. */
function input(patch: Partial<JoinInput> = {}): JoinInput {
    return {
        runningSessions: [],
        sessionRecords: [],
        sessionAttribution: new Map(),
        sessionAttributionByInstance: new Map(),
        sessionAttributionAmbiguous: new Set(),
        sessionAttributionListingOk: true,
        sessionAttributionListingDetail: null,
        ...patch,
    };
}

/** Index a record by the instance key the join reads it under. */
function byInstance(...records: SessionRecord[]): Map<string, SessionRecord> {
    const map = new Map<string, SessionRecord>();
    for (const rec of records) {
        map.set(instanceKey(rec.tmux_name || '', rec.tmux_created_epoch || 0), rec);
    }
    return map;
}

/** Every session name in every bucket, so "nowhere else" is assertable. */
function everywhere(groups: ReturnType<typeof buildProjectSessionGroups>) {
    const names: string[] = [];
    for (const list of groups.byProjectId.values()) {
        for (const s of list) names.push(s.name);
    }
    for (const s of groups.noProject) names.push(s.name);
    for (const item of groups.needsAttention) names.push(item.session.name);
    return names;
}

describe('a session lands in exactly one bucket', () => {
    test('a resolved project id makes the session that project\'s child', () => {
        const rec = record({ project_id: 7 });
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionByInstance: byInstance(rec),
        }));
        expect(groups.byProjectId.get(7)?.map((s) => s.name)).toEqual(['cloude_a']);
        expect(groups.noProject).toEqual([]);
        expect(groups.needsAttention).toEqual([]);
    });

    test("`none` is a MEASURED answer and lands in no-project, not attention", () => {
        const rec = record({ project_attribution: 'none', project_id: null });
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionByInstance: byInstance(rec),
        }));
        expect(groups.noProject.map((s) => s.name)).toEqual(['cloude_a']);
        expect(groups.needsAttention).toEqual([]);
        expect(groups.byProjectId.size).toBe(0);
    });

    test("`none` and `unknown` never collapse into one group, even side by side", () => {
        // THE TEST THAT NAMES THE BUG. `none` means the directory WAS
        // read and belongs to no project; `unknown` means it could not be
        // read at all. Rendering the second as the first is a measured
        // claim built out of a failure.
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_none', 1), live('cloude_unknown', 2)],
            sessionAttributionByInstance: byInstance(
                record({ tmux_name: 'cloude_none', tmux_created_epoch: 1, project_attribution: 'none', project_id: null }),
                record({ tmux_name: 'cloude_unknown', tmux_created_epoch: 2, project_attribution: 'unknown', project_id: null }),
            ),
        }));
        expect(groups.noProject.map((s) => s.name)).toEqual(['cloude_none']);
        expect(groups.needsAttention.map((i) => i.session.name)).toEqual(['cloude_unknown']);
    });
});

describe('the five live NEEDS ATTENTION reasons, one test each', () => {
    test('REASON 1: a failed attribution fetch puts EVERY session in attention', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a', 1), live('cloude_b', 2)],
            sessionAttributionListingOk: false,
            sessionAttributionListingDetail: 'the server answered HTTP 500',
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey)).toEqual([
            ATTENTION_REASON.listingUnreadable,
            ATTENTION_REASON.listingUnreadable,
        ]);
        expect(groups.byProjectId.size).toBe(0);
        expect(groups.noProject).toEqual([]);
    });

    test("REASON 1 carries the SERVER's own detail, which outranks our sentence", () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionListingOk: false,
            sessionAttributionListingDetail: 'the server answered HTTP 500',
        }));
        expect(groups.needsAttention[0]?.detail).toBe('the server answered HTTP 500');
    });

    test('REASON 1 with NO server detail still refuses, carrying null', () => {
        // The catalog message is the fallback; what must never happen is
        // the row quietly becoming somebody's child.
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionListingOk: false,
            sessionAttributionListingDetail: null,
        }));
        expect(groups.needsAttention[0]?.reasonKey)
            .toBe(ATTENTION_REASON.listingUnreadable);
        expect(groups.needsAttention[0]?.detail).toBeNull();
    });

    test('REASON 2: an ambiguous name is REFUSED, never picked between', () => {
        const groups = buildProjectSessionGroups(input({
            // No epoch, so the instance-exact rung cannot fire and the
            // ambiguity rung is reachable. That ordering is the point.
            runningSessions: [{ name: 'cloude_a', created_at_epoch: 0 }],
            sessionAttributionAmbiguous: new Set(['cloude_a']),
            sessionAttribution: new Map([['cloude_a', record({ project_id: 7 })]]),
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.ambiguousName]);
        // AND IT DID NOT ALSO LAND UNDER PROJECT 7, even though a record
        // for that name exists: the refusal comes FIRST.
        expect(groups.byProjectId.size).toBe(0);
    });

    test('REASON 3: a session with no stored record is flagged, not guessed', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.noRecord]);
        expect(groups.noProject).toEqual([]);
    });

    test('REASON 4: an unreadable working directory is attention, never no-project', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionByInstance: byInstance(
                record({ project_attribution: 'unknown', project_id: null }),
            ),
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.dirUnreadable]);
        expect(everywhere(groups)).toEqual(['cloude_a']);
    });

    test('REASON 5: an attribution with no id is flagged, never guessed at', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionByInstance: byInstance(
                record({ project_attribution: 'project', project_id: null }),
            ),
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.noProjectId]);
    });

    test('the five reasons are five DISTINCT keys, and none is reused', () => {
        // THE GUARD AGAINST THE MUTATION. Dropping a reason usually means
        // pointing two branches at one key, and every assertion above
        // still passes if the two keys happen to be equal.
        const liveReasons = [
            ATTENTION_REASON.listingUnreadable,
            ATTENTION_REASON.ambiguousName,
            ATTENTION_REASON.noRecord,
            ATTENTION_REASON.dirUnreadable,
            ATTENTION_REASON.noProjectId,
        ];
        expect(new Set(liveReasons).size).toBe(5);
        const all = Object.values(ATTENTION_REASON);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length).toBe(7);
    });
});

describe('the two ENDED attention reasons', () => {
    test('an ended row with an unreadable directory gets the ENDED reason', () => {
        const groups = buildProjectSessionGroups(input({
            sessionRecords: [record({
                lifecycle: 'stopped',
                project_attribution: 'unknown',
                project_id: null,
            })],
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.endedDirUnreadable]);
    });

    test('an ended row with no id gets the ENDED reason, not the live one', () => {
        const groups = buildProjectSessionGroups(input({
            sessionRecords: [record({
                lifecycle: 'stopped',
                project_attribution: 'project',
                project_id: null,
            })],
        }));
        expect(groups.needsAttention.map((i) => i.reasonKey))
            .toEqual([ATTENTION_REASON.endedNoProjectId]);
    });
});

describe('DELETED WINS OVER LIVE', () => {
    test('an archived record hides its session even while tmux still lists it', () => {
        // The rule, said out loud: deleting is a decision about the
        // user's list and not about the process. Without this it would
        // read "deleted, unless it happens to still be running", which is
        // an exception nobody can predict from the button's label.
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a')],
            sessionAttributionByInstance: byInstance(
                record({ archived_at: '2026-09-01T00:00:00Z', project_id: 7 }),
            ),
        }));
        expect(everywhere(groups)).toEqual([]);
        expect(groups.byProjectId.size).toBe(0);
        expect(groups.needsAttention).toEqual([]);
        expect(groups.noProject).toEqual([]);
    });

    test('and the live row does NOT win by falling through to attention', () => {
        // THE MUTATION THIS CATCHES. Turning `continue` into anything
        // that keeps the row - a push to attention, a push to noProject -
        // renders a session the user deleted. `everywhere` is empty above
        // precisely so a wrong bucket cannot pass.
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a'), live('cloude_b', 200)],
            sessionAttributionByInstance: byInstance(
                record({ archived_at: '2026-09-01T00:00:00Z' }),
                record({ tmux_name: 'cloude_b', tmux_created_epoch: 200, project_id: 9 }),
            ),
        }));
        expect(everywhere(groups)).toEqual(['cloude_b']);
    });

    test('the NAME-ONLY rung never yields an archived row, so this is the OWN record', () => {
        // The name-only map is built by attribution.ts and excludes
        // archived rows by construction. An archived row reachable only
        // by name therefore cannot suppress anything, which is right:
        // the rule is "the live session's OWN record was archived", not
        // "some unrelated older instance of this name was".
        const groups = buildProjectSessionGroups(input({
            runningSessions: [{ name: 'cloude_a', created_at_epoch: 0 }],
            sessionAttribution: new Map([['cloude_a', record({ project_id: 7 })]]),
        }));
        expect(groups.byProjectId.get(7)?.map((s) => s.name)).toEqual(['cloude_a']);
    });
});

describe('the instance-exact rung outranks the name-only one', () => {
    test('an OLDER archived instance of the same name cannot claim a live session', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_a', 200)],
            sessionAttributionByInstance: byInstance(
                record({ tmux_created_epoch: 200, project_id: 7 }),
                record({ id: 2, tmux_created_epoch: 100, archived_at: 'yes', project_id: 9 }),
            ),
        }));
        expect(groups.byProjectId.get(7)?.map((s) => s.name)).toEqual(['cloude_a']);
        expect(groups.byProjectId.has(9)).toBe(false);
    });

    test('a row with no epoch falls back to the name-only rung', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [{ name: 'cloude_a', created_at_epoch: 0 }],
            sessionAttribution: new Map([['cloude_a', record({ project_id: 3 })]]),
        }));
        expect(groups.byProjectId.get(3)?.map((s) => s.name)).toEqual(['cloude_a']);
    });
});

describe('endedSessionsForTree, and its four filters', () => {
    test('a stopped record with no live twin becomes an ended row', () => {
        const rows = endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'stopped', title: 'work' })],
        }));
        expect(rows.map((r) => [r.name, r.ended, r.status]))
            .toEqual([['cloude_a', true, 'stopped']]);
    });

    test('ARCHIVED hides a row WHATEVER its lifecycle, running included', () => {
        expect(endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'stopped', archived_at: 'yes' })],
        }))).toEqual([]);
        expect(endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'running', archived_at: 'yes' })],
        }))).toEqual([]);
    });

    test('`unknown` is NOT quietly promoted to ended: it is a cannot-determine', () => {
        expect(endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'unknown' })],
        }))).toEqual([]);
    });

    test('a name the live probe DID list wins: never render both', () => {
        expect(endedSessionsForTree(input({
            runningSessions: [live('cloude_a')],
            sessionRecords: [record({ lifecycle: 'stopped' })],
        }))).toEqual([]);
    });

    test('a row a RUNNING successor names as its parent is already on screen', () => {
        // The live-name check cannot catch this: the two rows carry
        // DIFFERENT tmux names by design.
        const rows = endedSessionsForTree(input({
            sessionRecords: [
                record({ id: 5, tmux_name: 'Media', lifecycle: 'stopped' }),
                record({ id: 6, tmux_name: 'cloude_Media', lifecycle: 'running', parent_session_id: '5' }),
            ],
        }));
        expect(rows).toEqual([]);
    });

    test('it KEEPS an ended row whose successor is NOT running', () => {
        // `parent_session_id` is a stored FACT, not a classifier. The row
        // is folded away only while the successor is actually on screen;
        // a stopped successor hides nothing, or a restart that also
        // stopped would take both rows off the tree.
        const rows = endedSessionsForTree(input({
            sessionRecords: [
                record({ id: 5, tmux_name: 'Media', lifecycle: 'stopped' }),
                record({ id: 6, tmux_name: 'cloude_Media', lifecycle: 'stopped', parent_session_id: '5' }),
            ],
        }));
        expect(rows.map((r) => r.name).sort()).toEqual(['Media', 'cloude_Media']);
    });

    test('it keeps an ordinary ended session that has no successor at all', () => {
        const rows = endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'dead' })],
        }));
        expect(rows.map((r) => r.name)).toEqual(['cloude_a']);
    });

    test('an UNREADABLE records fetch adds NO ended rows at all', () => {
        // Inventing ended rows out of a failed read is the exact false
        // green this screen keeps removing. The live pass already routes
        // every row to attention in that case, which is the honest report.
        expect(endedSessionsForTree(input({
            sessionRecords: [record({ lifecycle: 'stopped' })],
            sessionAttributionListingOk: false,
        }))).toEqual([]);
    });

    test('ended rows are APPENDED below live ones inside one project group', () => {
        const groups = buildProjectSessionGroups(input({
            runningSessions: [live('cloude_live')],
            sessionAttributionByInstance: byInstance(
                record({ tmux_name: 'cloude_live', project_id: 7 }),
            ),
            sessionRecords: [
                record({ tmux_name: 'cloude_live', project_id: 7 }),
                record({ id: 2, tmux_name: 'cloude_dead', lifecycle: 'stopped', project_id: 7 }),
            ],
        }));
        expect(groups.byProjectId.get(7)?.map((s) => [s.name, !!s.ended]))
            .toEqual([['cloude_live', false], ['cloude_dead', true]]);
    });
});

describe('rowKey is stable, and distinguishes what must be distinguished', () => {
    test('the same instance answers the same key twice', () => {
        expect(rowKey(live('cloude_a', 7))).toBe(rowKey(live('cloude_a', 7)));
    });

    test('a live and an ended row of one name are DIFFERENT keys', () => {
        expect(rowKey({ name: 'a', created_at_epoch: 1 }))
            .not.toBe(rowKey({ name: 'a', created_at_epoch: 1, ended: true }));
    });

    test('two instances of a reused tmux name are DIFFERENT keys', () => {
        expect(rowKey(live('a', 1))).not.toBe(rowKey(live('a', 2)));
    });

    test('a missing epoch degrades to 0 rather than to undefined', () => {
        // `undefined` in a key stringifies, so this would still be
        // stable - but two DIFFERENT rows with no epoch would then share
        // one key and Svelte would refuse the each block outright.
        expect(rowKey({ name: 'a' })).toBe('l:a:0');
    });
});
