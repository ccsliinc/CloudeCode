/**
 * THE PROJECT INFO MODAL'S RULES: what the machines section says, and
 * which machines can be linked.
 *
 * WHY A MODAL AND NOT AN INLINE DISCLOSURE. The owner asked for it in
 * those words: "i think that the info should probably open in a modal
 * and not inline." An inline expansion in a 272px rail pushes 76 cards
 * down the list and takes the card you were reading off screen with it,
 * which is the same unscannability the label truncation exists to
 * prevent.
 *
 * A MACHINE LIST THAT WAS NEVER REPORTED IS NOT AN EMPTY MACHINE LIST.
 * A merged node carries `hosts` and `members`; the per-corpus rows the
 * by-machine tree renders do not. When they are absent the modal renders
 * an outcome block reading COULD NOT EVALUATE - it does not draw an
 * empty section, which would claim the project belongs to no machine,
 * and it does not guess. `machinesHeading().known` is the flag that
 * decides which.
 *
 * Ported from the pure half of client/js/archive-nav-info.js. That
 * file's `open()` and `wire()` built and tore down a DOM overlay and
 * pushed it onto `window.ModalStack`; `NavInfoModal.svelte` renders the
 * overlay and takes the stack as a PROP, because a component in this
 * tree reaches for no global.
 */
import { renderCount, type NavRowData } from './nav-row';

/** The sentence heading the machines section, and whether it is a fact. */
export interface MachinesHeading {
    readonly text: string;
    /** False means render a could-not-evaluate block, not a list. */
    readonly known: boolean;
}

/**
 * The sentence that heads the machines section, written for the count it
 * actually has.
 *
 * Description: the one-machine case is 74 of 77 projects (measured
 *   2026-09-02), so it is written as a complete sentence rather than as
 *   a list of one, which reads like a list with items missing.
 * Inputs: hosts - the node's `hosts`, or anything else.
 * Output: the heading; `known` false means the caller must render a
 *   could-not-evaluate block instead of a list.
 * Example: machinesHeading(['a'])
 *   // -> {text: 'Collected from one machine.', known: true}
 */
export function machinesHeading(hosts: unknown): MachinesHeading {
    if (!Array.isArray(hosts) || hosts.length === 0) {
        return { text: 'Machines could not be determined.', known: false };
    }
    if (hosts.length === 1) {
        return { text: 'Collected from one machine.', known: true };
    }
    return {
        text: `Collected from ${renderCount(hosts.length)} machines. `
            + 'This project exists on each of them.',
        known: true,
    };
}

/** One machine a project was collected from. */
export interface MachineRow {
    readonly name: string;
    readonly host_id: number | string | null;
    readonly transcript_count: number | null;
    /** Whether the rail can be narrowed to this machine from here. */
    readonly linkable: boolean;
}

/**
 * Pair every host name with the member row that carries its id and its
 * own transcript count, so a link can ADDRESS the machine and not just
 * name it.
 *
 * Description: A HOST NAMED WITH NO MEMBER ROW IS STILL LISTED. It is a
 *   real fact the server reported; what it loses is the link, and the
 *   row says so rather than being dropped, because a dropped machine is
 *   the merge hiding exactly what it is only allowed to demote.
 * Inputs: row - a project node.
 * Output: one entry per named host, in the order the server named them.
 * Example: machineRows(node)[0].linkable   // -> true
 */
export function machineRows(row: NavRowData | null | undefined): readonly MachineRow[] {
    const r = row || {};
    const hosts = Array.isArray(r.hosts) ? r.hosts : [];
    const members = Array.isArray(r.members)
        ? r.members as readonly Record<string, unknown>[]
        : [];
    return hosts.map((name) => {
        const hit = members.find(
            (m) => String(m.host_display_name) === String(name),
        ) || null;
        const count = hit && typeof hit.transcript_count === 'number'
            ? hit.transcript_count
            : null;
        const id = hit && hit.host_id !== null && hit.host_id !== undefined
            ? hit.host_id as number | string
            : null;
        return {
            name: String(name),
            host_id: id,
            transcript_count: count,
            linkable: id !== null,
        };
    });
}

/**
 * The envelope the machines section renders when `hosts` was never
 * reported.
 *
 * Description: NOT an empty list. This node came from the per-corpus
 *   listing, which does not carry `hosts` at all - so "no machines" is a
 *   thing nobody measured, and it goes through the client's one status
 *   interpreter like every other could-not-evaluate in this UI. Built
 *   here rather than inline in the template so a test can assert the
 *   exact shape handed to the outcome renderer.
 * Inputs: none.
 * Output: the envelope.
 * Example: machinesUnevaluated().result_status   // -> 'cannot_determine'
 */
export function machinesUnevaluated(): Record<string, unknown> {
    return {
        result_status: 'cannot_determine',
        scope_status: 'resolved',
        unevaluated: [{
            subject: 'project.hosts',
            reason: 'this project row carries no host list, so the machines it '
                + 'was collected from were never reported',
        }],
        meta: {},
    };
}

/**
 * What a modal stack owes this component. REUSED FROM SLICE 4's
 * `keys-help.ts` rather than declared again: the help modal takes the
 * same host object for the same reason, and two names for one contract
 * is how they come to disagree about what `push` takes.
 */
export type { ModalStackLike } from './keys-help';

/** The copy for one labelled field in the modal. */
export interface InfoField {
    readonly term: string;
    readonly value: string;
    readonly known: boolean;
}

/**
 * One labelled field, resolved.
 *
 * Description: a field whose value is absent renders the `absent`
 *   sentence and is marked `known: false`, so a missing path reads as a
 *   statement rather than as a blank the reader has to interpret.
 * Inputs: term, value, absent - what to say when there is no value.
 * Output: the field.
 * Example: infoField('Slug', null, 'NOT KNOWN - none reported').known
 *   // -> false
 */
export function infoField(term: string, value: unknown, absent: string): InfoField {
    const has = typeof value === 'string' && value.length > 0;
    return { term, value: has ? value : absent, known: has };
}
