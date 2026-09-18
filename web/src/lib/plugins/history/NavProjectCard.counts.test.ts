/**
 * THE COUNTS RUN IS ONE SENTENCE, AND THE TEMPLATE MUST NOT PUT EXTRA
 * SPACE INSIDE IT.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE EXISTS. `.archive-nav__counts` renders "4 sessions of
 * 262 total" as a run of inline spans whose separation comes ENTIRELY
 * from the `margin-left` values in `archive-nav-card.css`. Every span in
 * that run sits in one inline formatting context, so a newline in the
 * SVELTE SOURCE between two of them collapses to a rendered space and is
 * added to the margin that was already doing the job. The vanilla
 * renderer builds the same run with `appendChild` and emits no text node
 * at all, so the port and the original were never spacing this sentence
 * the same way.
 *
 * Measured in a real browser on the parity page, over the 98 captured
 * rows, per gap:
 *
 *     4 -> sessions    vanilla 4.34px    ours 12.06px
 *     sessions -> of   vanilla 6.39px    ours 12.96px
 *     of -> 262        vanilla 4.34px    ours 12.06px
 *     262 -> total     vanilla 4.34px    ours 12.06px
 *
 * About 29px of extra space in one line, which is why the run read as
 * four loose tokens rather than as the sentence the stylesheet's own
 * header says it is.
 *
 * IT IS INVISIBLE TO A BOX MEASUREMENT, which is the reason it survived
 * a 98-row parity pass that reported zero disagreements and concluded
 * the two rails were pixel identical. The run is `white-space: nowrap`
 * inside a truncating block of fixed width, so the extra word space
 * changes NO element's box - it is spent out of the ellipsis budget
 * instead. That is the lesson worth keeping: when a run looks wrong and
 * measures right, compare the TEXT, not only the geometry.
 *
 * THE ASSERTION IS ON THE TEXT NODES, NOT ON A PIXEL. jsdom lays nothing
 * out, so a width here would be meaningless. What it CAN see is the
 * thing that causes the width: whether the template emitted whitespace
 * between the spans. That is the defect exactly, and it is what a
 * reformat of the template would reintroduce.
 */
import { describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import NavProjectCard from './NavProjectCard.svelte';
import type { NavRowData } from './nav-row';

/** One project row, shaped as `/archive/projects/merged` returns it. */
const ROW = {
    project_id: 5,
    display_name: 'a project',
    full_path: '-a-project',
    transcript_count: 262,
    session_count: 4,
    session_counted: true,
    activity_status: 'known',
    newest_activity_at: '2026-09-16T00:00:00Z',
} as unknown as NavRowData;

/**
 * Mount one card and hand back its counts element plus a teardown.
 *
 * Inputs: none.
 * Output: the counts element and a function that unmounts the card.
 * Example: const { counts, done } = renderCard(); done();
 */
function renderCard(): { counts: HTMLElement; done: () => void } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = mount(NavProjectCard, { target: host, props: { row: ROW } });
    const counts = host.querySelector<HTMLElement>('.archive-nav__counts');
    if (!counts) {
        throw new Error('the card rendered no .archive-nav__counts, so the '
            + 'run this file is about was not measured.');
    }
    return { counts, done: () => { unmount(app); host.remove(); } };
}

describe('NavProjectCard: the counts run carries no template whitespace', () => {
    it('emits not one whitespace text node inside the run', () => {
        const { counts, done } = renderCard();
        try {
            const walker = document.createTreeWalker(counts, NodeFilter.SHOW_TEXT);
            const blank: string[] = [];
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const text = n.nodeValue || '';
                // A node that is ENTIRELY whitespace is the defect. A
                // node with whitespace INSIDE a word is somebody's
                // project name and is none of this file's business.
                if (text.length > 0 && text.trim() === '') blank.push(JSON.stringify(text));
            }
            // NAMES WHAT IT FOUND, so a failure reads as "the template
            // was reformatted and put a newline back" rather than as a
            // bare count.
            expect(blank).toEqual([]);
        } finally { done(); }
    });

    it('so the whole run reads as one unbroken string', () => {
        const { counts, done } = renderCard();
        try {
            // The spacing is the stylesheet's job and this is what it
            // has to work with. If a space ever appears here, the
            // margins in `archive-nav-card.css` are being doubled.
            expect(counts.textContent).toBe('4sessionsof262total');
        } finally { done(); }
    });

    it('NEGATIVE CONTROL: the check can actually fail', () => {
        // A whitespace test that passes on a tree with whitespace in it
        // is proving nothing. This builds the shape the template used to
        // emit and asserts the same walk finds it.
        const el = document.createElement('span');
        el.innerHTML = '<span>4</span>\n    <span>sessions</span>';
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const blank: string[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.nodeValue || '';
            if (text.length > 0 && text.trim() === '') blank.push(text);
        }
        expect(blank.length).toBe(1);
    });
});
