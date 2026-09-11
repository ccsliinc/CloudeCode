/**
 * Mount the real RunningSessions list against the real store, for a test.
 *
 * ONE HARNESS, SHARED BY EVERY TEST IN THIS SLICE, for the reason
 * ./tree-harness.ts gives: if the counting test built its own list, a
 * difference between the two setups would silently become part of the
 * number and nobody could tell a real improvement from a cheaper fixture.
 *
 * IT DRIVES THE STORE, NOT THE COMPONENT'S PROPS. Every field the list
 * paints is written onto `sessionStore` the way a poll tick writes it, and
 * the component is given none of it. That is the subscription under test;
 * a props-driven fixture would prove that Svelte updates props.
 *
 * THE HOST IS A RECORDER, and it is a bigger one than the tree's because
 * this surface acts. Close, remove, restart, rename, fork, mark unread and
 * open all leave through `RunningHost`, so a test asserts what the list
 * ASKED FOR rather than what happened next - the only half this slice
 * owns.
 *
 * THE FLEET AND THE MUTATION COUNTER ARE REUSED FROM ./tree-harness.ts
 * rather than rebuilt. Two fleets would be two screens, and the whole
 * point of the tick measurement is that both surfaces are driven by one
 * `loadRunningSessions` over one set of rows.
 */
import { mount, unmount } from 'svelte';

import RunningSessions from './RunningSessions.svelte';
import { sessionStore } from '../sessions/store.svelte';
import { uiPrefs } from '../ui/prefs.svelte';
import type { RunningChrome } from './running-chrome';
import type {
    CardAction,
    LabelVerdict,
    ReopenResult,
    RespawnResult,
    RestartChoice,
    RowActionDescriptor,
    RunningHost,
} from './running-host';
import type { ThemeColors } from './running-row';
import type { ListingState, RunningSessionRow } from '../sessions/types';

/** One recorded call out of the list. */
export interface HostCall {
    method: string;
    args: unknown[];
}

/** What a recording host may be told to answer with. */
export interface HostAnswers {
    /** Which controls a status earns. Defaults to the real three-way rule. */
    actionsFor?: (status: string | null | undefined) => RowActionDescriptor[];
    /** The plugin contributions. Defaults to a mark-unread stand-in. */
    cardActions?: CardAction[];
    /** The theme lookup. Defaults to answering nothing, i.e. unthemed. */
    themeColors?: (id: string) => ThemeColors | null;
    /** This browser's socket state. Defaults to undefined. */
    transport?: string | undefined;
    /** What the confirm dialog answers. Defaults to yes. */
    confirm?: boolean;
    /** What the label rule answers. Defaults to accepting the input. */
    validateLabel?: (value: string) => LabelVerdict;
    /** What the restart picker answers. Defaults to null, i.e. declined. */
    restartChoice?: RestartChoice | null;
    /** Why the picker could not predict. Defaults to null. */
    restartError?: string | null;
    /** Whether the picker module exists at all. Defaults to true. */
    hasRestartPicker?: boolean;
    /** What the respawn answers, or a thrown value. */
    respawn?: RespawnResult | (() => never);
    /** What the reopen answers. Defaults to not_reopened with no detail. */
    reopen?: ReopenResult;
    /** What rename does. Defaults to resolving. */
    renameSession?: (id: string, label: string) => Promise<unknown>;
    /** What resolving a live id answers. Defaults to null. */
    resolveSessionId?: string | null;
}

/** A host that records rather than acts. */
export interface RecordingHost extends RunningHost {
    calls: HostCall[];
    /** Every message the list asked to be shown. */
    errors: string[];
}

/**
 * The three-way action rule, reproduced from `session-row-actions.js`.
 *
 * Description: THE DEFAULT ONLY. A test that cares about this rule
 *   asserts against the REAL module in a `vm` sandbox
 *   (./row-actions.parity.test.ts); this exists so every other test has a
 *   row that paints the controls it would really paint.
 * Inputs: status. Output: RowActionDescriptor[].
 */
export function defaultActionsFor(
    status: string | null | undefined,
): RowActionDescriptor[] {
    const key = (status || 'unknown').toLowerCase();
    const make = (id: string): RowActionDescriptor => ({
        id,
        glyph: id === 'remove' ? 'trash' : (id === 'restart' ? 'restart' : 'close'),
        labelKey: `session.action.${id}`,
        extraClass: id === 'restart' ? 'session-row-action-restart' : '',
    });
    if (key === 'dead') return [make('restart'), make('remove')];
    const live = ['working', 'working_subagent', 'question', 'notice',
        'finished_unread', 'idle', 'running'];
    if (live.indexOf(key) !== -1) return [make('close'), make('restart')];
    return [make('close')];
}

/**
 * Build a host that records every call and performs none of them.
 *
 * Inputs: answers - what it should answer with, all optional.
 * Output: RecordingHost.
 * Example: const host = recordingHost({confirm: false});
 */
export function recordingHost(answers: HostAnswers = {}): RecordingHost {
    const calls: HostCall[] = [];
    const errors: string[] = [];
    const note = (method: string, ...args: unknown[]) => {
        calls.push({ method, args });
    };
    return {
        calls,
        errors,
        actionsFor: answers.actionsFor || defaultActionsFor,
        cardActions(name: string, unread: boolean): CardAction[] {
            note('cardActions', name, unread);
            return answers.cardActions === undefined
                ? [{ id: 'mark-unread', order: 200,
                    label: unread ? 'clear unread' : 'mark unread' }]
                : answers.cardActions;
        },
        async runCardAction(id: string, name: string, unread: boolean) {
            note('runCardAction', id, name, unread);
            return true;
        },
        themeColors(themeId: string): ThemeColors | null {
            return answers.themeColors ? answers.themeColors(themeId) : null;
        },
        transportFor(): string | undefined {
            return answers.transport;
        },
        labelMaxChars(): number {
            return 200;
        },
        validateLabel(value: string): LabelVerdict {
            note('validateLabel', value);
            if (answers.validateLabel) return answers.validateLabel(value);
            return { ok: true, value };
        },
        async confirmAction(action: string, displayName: string) {
            note('confirmAction', action, displayName);
            return answers.confirm !== false;
        },
        requiresConfirm(action: string): boolean {
            return action !== 'restart';
        },
        actionLabel(action: string): string {
            return `${action} session`;
        },
        async renameSession(sessionId: string, label: string) {
            note('renameSession', sessionId, label);
            if (answers.renameSession) return answers.renameSession(sessionId, label);
            return undefined;
        },
        async destroySession(sessionId: string) {
            note('destroySession', sessionId);
            return undefined;
        },
        async destroyExternalSession(name: string) {
            note('destroyExternalSession', name);
            return undefined;
        },
        async resolveSessionId(tmuxName: string) {
            note('resolveSessionId', tmuxName);
            return answers.resolveSessionId ?? null;
        },
        async openRestartPicker(name: string, display: string, status: string | null) {
            note('openRestartPicker', name, display, status);
            return answers.restartChoice ?? null;
        },
        restartPickerError(): string | null {
            return answers.restartError ?? null;
        },
        hasRestartPicker(): boolean {
            return answers.hasRestartPicker !== false;
        },
        async respawnSession(name: string, agentType: string | null, live: boolean) {
            note('respawnSession', name, agentType, live);
            const answer = answers.respawn;
            if (typeof answer === 'function') return answer();
            return answer ?? { ok: true };
        },
        async reopenAfterRestart(result: RespawnResult): Promise<ReopenResult> {
            note('reopenAfterRestart', result);
            return answers.reopen ?? { status: 'not_reopened', detail: null };
        },
        async forkSession(name: string) {
            note('forkSession', name);
        },
        async returnToActive(sessionId: string | null) {
            note('returnToActive', sessionId);
        },
        async attachSession(name: string) {
            note('attachSession', name);
        },
        async refresh() {
            note('refresh');
        },
        showError(message: string): void {
            errors.push(message);
        },
    };
}

/** A chrome that records the two writes instead of touching the heading. */
export interface RecordingChrome extends RunningChrome {
    counts: Array<{ text: string; listingOk: boolean }>;
    visibility: boolean[];
}

/**
 * Build a chrome that records rather than writing.
 *
 * Inputs: none. Output: RecordingChrome.
 * Example: const chrome = recordingChrome();
 */
export function recordingChrome(): RecordingChrome {
    const counts: Array<{ text: string; listingOk: boolean }> = [];
    const visibility: boolean[] = [];
    return {
        counts,
        visibility,
        setCount(text: string, listingOk: boolean) { counts.push({ text, listingOk }); },
        setSectionVisible(visible: boolean) { visibility.push(visible); },
    };
}

/** What a test may put on the store before the list paints. */
export interface RunningFixture {
    rows?: RunningSessionRow[];
    listing?: ListingState;
}

/**
 * Write one fixture onto the store, the way a poll tick would.
 *
 * Description: BOTH FIELDS ARE ASSIGNED, including the one a fixture left
 *   out, so a test cannot inherit the previous one's data.
 * Inputs: fixture. Output: void.
 * Example: applyRunningFixture({rows: [row('cloude_api')]})
 */
export function applyRunningFixture(fixture: RunningFixture): void {
    sessionStore.runningSessions = fixture.rows ?? [];
    sessionStore.runningSessionsListing = fixture.listing
        ?? { ok: true, reason: null, detail: null, sources: [] };
}

/**
 * The translator every test in this slice mounts with.
 *
 * Description: THE KEY PLUS ITS PARAMETERS, never the real sentence. An
 *   assertion then names the catalog KEY rather than the copy, so editing
 *   a message does not rewrite the spec and this file never becomes a
 *   second place the copy is written down - while the parameters are
 *   still visible, so "did the server's own detail actually reach the
 *   block" stays an answerable question. The real catalog is proven
 *   separately, by ../i18n/coverage.test.ts.
 * Inputs: key, params. Output: string.
 * Example: testTranslate('session.running.count', {count: 2})
 *   // 'session.running.count 2'
 */
export function testTranslate(
    key: string,
    params?: Record<string, unknown> | null,
): string {
    const values = params ? Object.values(params) : [];
    return values.length ? `${key} ${values.join(' ')}` : key;
}

/** A mounted list, and everything a test needs to drive it. */
export interface MountedList {
    container: HTMLElement;
    host: RecordingHost;
    chrome: RecordingChrome;
    destroy(): void;
}

/**
 * Build one running-session row, with every field a card reads.
 *
 * Description: the DEFAULTS ARE THE HEALTHY CASE, so a test names only
 *   what it is about. Nothing here is `||`-defaulted at read time: a
 *   field a test sets to null stays null, because a null is an answer.
 * Inputs: name - the tmux name. patch - fields to override.
 * Output: RunningSessionRow.
 * Example: row('cloude_api', {status: 'dead'})
 */
export function row(
    name: string,
    patch: Partial<RunningSessionRow> = {},
): RunningSessionRow {
    return {
        name,
        label: null,
        created_by_cloude: true,
        created_at_epoch: 1_700_000_000,
        window_count: 1,
        agent_type: 'claude',
        agent_family: 'claude',
        agent_family_source: 'wrapper',
        agent_wrapper_label: null,
        pinned_theme: null,
        session_row_id: 7,
        parent_session_id: null,
        status: 'idle',
        unread: false,
        listing_ok: true,
        listing_reason: null,
        is_active: false,
        session_id: null,
        startup_gate: 'ready',
        status_source: 'hook',
        ...patch,
    };
}

/**
 * Mount the list into a fresh container, IN the document.
 *
 * Description: IN THE DOCUMENT, and that is not cosmetic. `isConnected`
 *   answers false for every node in a detached tree, so a test asserting
 *   that an open editor SURVIVED a tick would fail for a reason that has
 *   nothing to do with the tick, and `document.activeElement` needs it
 *   too. `destroy()` removes the container so one test's nodes can never
 *   be found by the next one's `querySelector`.
 * Inputs: fixture - the store state to paint from. answers - what the
 *   host should answer.
 * Output: MountedList.
 * Example: const list = mountList({rows: [row('cloude_api')]});
 */
export function mountList(
    fixture: RunningFixture = {},
    answers: HostAnswers = {},
): MountedList {
    uiPrefs.resetForTests();
    applyRunningFixture(fixture);
    const container = document.createElement('div');
    container.id = 'running-sessions-list';
    document.body.appendChild(container);
    const host = recordingHost(answers);
    const chrome = recordingChrome();
    const instance = mount(RunningSessions, {
        target: container,
        props: { host, chrome, t: testTranslate },
    });
    return {
        container,
        host,
        chrome,
        destroy() {
            unmount(instance, { outro: false });
            container.remove();
            sessionStore.reset();
            uiPrefs.resetForTests();
        },
    };
}
