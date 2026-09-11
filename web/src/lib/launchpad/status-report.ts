/**
 * The home screen's two ways of telling the user something.
 *
 * TWO SURFACES, TWO JOBS, AND NEITHER MAY BLOCK. `updateStatus` writes a
 * transient line onto `#statusText`'s `data-status`, which the home bar
 * renders through `App._observeStatusText()` - so the string has exactly
 * one author and the bar cannot go stale. `showError` stacks a dismissible
 * card over the page.
 *
 * `showError` USED TO BE A NATIVE `alert()`, AND THAT IS THE WHOLE
 * REASON IT IS A COMPONENT-FREE DOM BUILDER RATHER THAN ANYTHING
 * CLEVERER. A native alert HALTS the page: timers stop, the poller stops,
 * and nothing runs until a human dismisses it. The fork refusal found
 * that the hard way - the server answered 409 correctly, the client
 * picked the right branch, and the whole app then froze on the modal
 * that was supposed to be telling you about it. An error message that
 * stops the program is worse than the error.
 *
 * DELIBERATELY NOT ToastManager. That surface is for server-pushed
 * session toasts with ack semantics, and a dismiss there syncs to the
 * server. A local client-side error has nothing to acknowledge.
 *
 * `textContent`, NEVER `innerHTML`. The message can carry a server
 * detail, a filesystem path or an exception string, none of which is
 * ours to trust as markup. This is also why the card is built node by
 * node rather than rendered as a Svelte component: it is appended to
 * `document.body`, outside every mounted panel, and it has to work while
 * the screen it belongs to is being torn down.
 */
import { hostDocument } from '../sessions/env';
import { HOME_KEYS, refusedProjectNotice } from '../../../../client/js/labels/home-screen.js';
import type { Translate } from './recent';

/** How long an error card stays before it removes itself. */
export const ERROR_CARD_TTL_MS = 12000;

/** The id of the container every error card is stacked into. */
export const ERROR_STACK_ID = 'launchpad-error-stack';

/**
 * Write the transient status line.
 *
 * Description: sets BOTH `data-status` (what the ::after tooltip and the
 *   home bar label read) and `aria-label`, so a screen reader gets the
 *   same state a sighted hover shows. A missing `#statusText` is a
 *   no-op, which is the normal early-boot state.
 * Inputs: message - already translated.
 * Output: void.
 * Example: updateStatus(t(HOME_KEYS.statusConnecting));
 */
export function updateStatus(message: string): void {
    const doc = hostDocument();
    const el = doc?.getElementById('statusText');
    if (!el) return;
    el.setAttribute('data-status', message);
    el.setAttribute('aria-label', message);
}

/**
 * Stack one dismissible error card over the page.
 *
 * Description: creates the stack container on first use. The card auto
 *   dismisses generously - an error you cannot re-read is an error you
 *   cannot act on - and carries an explicit close control.
 * Inputs: message - already translated; t - for the dismiss label.
 * Output: void. Never throws: the reporter must never become the fault.
 * Example: showError('failed to open api: boom', t);
 */
export function showError(message: string, t: Translate): void {
    console.error('CloudeWeb: home screen error:', message);
    const doc = hostDocument();
    if (!doc || !doc.body) return;
    try {
        let host = doc.getElementById(ERROR_STACK_ID);
        if (!host) {
            host = doc.createElement('div');
            host.id = ERROR_STACK_ID;
            doc.body.appendChild(host);
        }
        const card = doc.createElement('div');
        card.className = 'launchpad-error-card';
        card.setAttribute('role', 'alert');
        const text = doc.createElement('span');
        text.className = 'launchpad-error-text';
        text.textContent = message;
        const close = doc.createElement('button');
        close.type = 'button';
        close.className = 'launchpad-error-dismiss';
        close.setAttribute('aria-label', t(HOME_KEYS.errorDismiss));
        close.textContent = '×';
        const remove = () => {
            if (card.parentNode) card.parentNode.removeChild(card);
        };
        close.addEventListener('click', remove);
        card.appendChild(text);
        card.appendChild(close);
        host.appendChild(card);
        setTimeout(remove, ERROR_CARD_TTL_MS);
    } catch (error) {
        // The console line above already ran, so the report is not lost.
        console.error('CloudeWeb: could not render the error card:', error);
    }
}

/** As much of a project row as the refusal needs. */
export interface RefusableProject {
    name?: string | null;
    root?: string | null;
    path?: string | null;
}

/** As much of a presence row as the refusal reads. */
export interface PresenceRow {
    presence?: string | null;
    presence_detail?: string | null;
}

/**
 * Say out loud why a project row refused to open, and name the path.
 *
 * Description: the SENTENCE is built by `refusedProjectNotice` in the
 *   label module; this is the seam that reads the presence row and shows
 *   it. Three outcomes are kept apart there, and the rung is returned
 *   here so a caller can assert which branch answered without matching
 *   on english.
 * Inputs: project; presence - the row for it, or null; t.
 * Output: 'missing' | 'unreachable' | 'unknown'.
 * Example: explainRefusedProject(project, presence, t);   // 'missing'
 */
export function explainRefusedProject(
    project: RefusableProject | null | undefined,
    presence: PresenceRow | null | undefined,
    t: Translate,
): 'missing' | 'unreachable' | 'unknown' {
    const notice = refusedProjectNotice(
        {
            name: project?.name ?? null,
            path: project?.root || project?.path || null,
            presence: presence?.presence ?? 'unchecked',
            detail: presence?.presence_detail ?? null,
        },
        t,
    );
    showError(notice.text, t);
    // The label module is plain JS with a JSDoc type, so its `rung` is
    // `string` to the checker. Narrowed here rather than loosened in the
    // signature: the three words ARE the contract, and a fourth one
    // appearing is exactly what a caller must not silently accept.
    return notice.rung === 'missing' || notice.rung === 'unreachable'
        ? notice.rung
        : 'unknown';
}
