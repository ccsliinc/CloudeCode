/**
 * THE KEYBOARD HELP MODAL, rendered from `keys.ts`'s binding table.
 * PORTED from `client/js/archive-keys-help.js`, deleted in the same
 * commit.
 *
 * WHY IT IS NOT IN `keys.ts`. That file's own header describes it as the
 * pure decision layer - "no DOM" - and it had a hundred lines of modal
 * construction in it. When the conversation view added a `v` binding the
 * file crossed this repo's 500-line cap, and the honest cut was the half
 * that contradicted the header rather than the half that matched it.
 *
 * ONE TABLE, STILL. The panel is built from `bindings()` and holds no
 * key list of its own, because a help panel that lies is worse than no
 * help panel and two tables always drift. It reads that table at OPEN
 * time rather than at module load, so it cannot capture a stale copy.
 *
 * THE MODAL STACK IS INJECTED, NOT REACHED FOR, WHICH IS THE ONE SHAPE
 * CHANGE IN THIS PORT. The vanilla module read `window.ModalStack`
 * directly. `ModalStack` is a HOST global, not an archive one, and
 * `import-direction.test.ts` exists to keep this directory free of
 * exactly that: a feature that reaches sideways into the app is not
 * extractable, and section 10 of the scope wants this directory
 * liftable. So `openHelp` takes the stack as an option and the seam that
 * publishes `window.ArchiveKeysHelp` supplies the real one - the same
 * arrangement `history-host.ts` has for `window.App`.
 *
 * AN ABSENT STACK IS STILL SUPPORTED AND STILL MEANS THE SAME THING.
 * The vanilla code tolerated `window.ModalStack` being missing, and so
 * does this: the modal opens, its close button works, and Escape is
 * simply not routed to it. That path is what a mini-DOM test harness
 * exercises, and it is why the option is optional rather than required.
 */
import { bindings } from './keys';

/**
 * Attribute the help overlay is tagged with, so the idempotency check
 * and any test share one named string rather than four literals.
 */
export const HELP_MODAL_ATTR = 'data-modal';

/** Value of HELP_MODAL_ATTR on the help overlay. */
export const HELP_MODAL_NAME = 'archive-help';

/** Selector for an already-open help overlay. */
const HELP_MODAL_SELECTOR = '[' + HELP_MODAL_ATTR + '="' + HELP_MODAL_NAME + '"]';

/** Class prefix for this modal's elements, mirroring archive-export.js. */
export const HELP_ROOT_CLASS = 'archive-help';

/** data-action on the close button. */
export const HELP_CLOSE_ACTION = 'close-help';

/** Column headings for the rendered binding table. */
const HELP_COLUMNS = ['Keys', 'What it does'];

/** As much of the host's modal stack as this module uses. */
export interface ModalStackLike {
    push(node: Element, handlers: { onEscape: () => void }): void;
    pop(node: Element): void;
}

/** What `openHelp` takes. */
export interface OpenHelpOptions {
    /** REQUIRED. Absent throws, by name; see `openHelp`. */
    readonly document?: Document;
    /** Called once when the modal closes. */
    readonly onClose?: () => void;
    /**
     * The host's modal stack, injected. Absent means Escape is not
     * routed to this overlay; the close button still works.
     */
    readonly modalStack?: ModalStackLike | null;
}

/** The handle `openHelp` returns. */
export interface HelpHandle {
    readonly overlay: Element;
    /** Safe to call twice. */
    close(): void;
}

/**
 * Build one element with a class and optional text.
 *
 * Description: text goes in via `textContent`, never as markup - a
 *   binding note is data.
 * Inputs: doc, tag, className, text. Output: HTMLElement.
 */
function helpEl(
    doc: Document, tag: string, className: string | null, text: string | null,
): HTMLElement {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
}

/**
 * Render `bindings()` as a table.
 *
 * Description: iterates the LIVE table rather than restating it, so a
 *   binding added in `keys.ts` appears here with no second edit. Each
 *   row carries `data-action` so a test - and the real-screen check this
 *   slice is verified by - can assert coverage against the resolver.
 * Inputs: doc. Output: a <table> element.
 * Example: const t = buildHelpTable(document);
 *          t.querySelectorAll('tbody tr[data-action]').length
 */
export function buildHelpTable(doc: Document): HTMLElement {
    const table = helpEl(doc, 'table', HELP_ROOT_CLASS + '__table', null);
    const thead = helpEl(doc, 'thead', null, null);
    const headRow = thead.appendChild(helpEl(doc, 'tr', null, null));
    for (const label of HELP_COLUMNS) {
        const th = helpEl(doc, 'th', null, label);
        th.setAttribute('scope', 'col');
        headRow.appendChild(th);
    }
    table.appendChild(thead);
    const tbody = helpEl(doc, 'tbody', null, null);
    for (const binding of bindings()) {
        const row = tbody.appendChild(helpEl(doc, 'tr', null, null));
        row.setAttribute('data-action', binding.action);
        row.appendChild(helpEl(doc, 'td', HELP_ROOT_CLASS + '__keys', binding.keys));
        row.appendChild(helpEl(doc, 'td', HELP_ROOT_CLASS + '__note', binding.note));
    }
    table.appendChild(tbody);
    return table;
}

/**
 * Open the keyboard help as a modal, rendered from `bindings()`.
 *
 * Description: registering with the modal stack is what makes Escape
 *   close THIS and not the screen behind it. `resolveEscape` already
 *   returns null while a modal is open, so the ordering is settled and
 *   this adds no Escape listener of its own.
 * Inputs: options - `document` is REQUIRED and absent throws a TypeError
 *   naming it, because returning quietly would leave a `?` key that does
 *   nothing and reports nothing. `onClose` and `modalStack` optional.
 * Output: {overlay, close}. `close` is safe to call twice. If a help
 *   modal is already in the document, the EXISTING one's handle comes
 *   back rather than a second being stacked.
 * Example: openHelp({document, modalStack}).close();
 */
export function openHelp(options?: OpenHelpOptions): HelpHandle {
    const opts = options || {};
    const doc = opts.document;
    if (!doc) throw new TypeError('openHelp requires a "document" argument');
    const stack = opts.modalStack || null;

    /**
     * The close path for one overlay, shared by the fresh and
     * already-open branches so they cannot drift.
     */
    function closerFor(node: Element): () => void {
        let closed = false;
        return function close(): void {
            if (closed) return;
            closed = true;
            if (stack) stack.pop(node);
            if (node.parentNode) node.parentNode.removeChild(node);
            if (typeof opts.onClose === 'function') opts.onClose();
        };
    }

    // Already open? Two identical dialogs stacked on one `?` press is
    // worse than a no-op, so hand back the live one.
    const existing = typeof doc.querySelector === 'function'
        ? doc.querySelector(HELP_MODAL_SELECTOR) : null;
    if (existing) return { overlay: existing, close: closerFor(existing) };

    const overlay = helpEl(doc, 'div', 'modal-overlay ' + HELP_ROOT_CLASS + '-overlay', null);
    overlay.setAttribute(HELP_MODAL_ATTR, HELP_MODAL_NAME);

    const content = helpEl(doc, 'div', 'modal-content ' + HELP_ROOT_CLASS + '__content', null);
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    const header = helpEl(doc, 'div', 'modal-header ' + HELP_ROOT_CLASS + '__header',
                          'Keyboard shortcuts');
    const body = helpEl(doc, 'div', 'modal-body ' + HELP_ROOT_CLASS + '__body', null);
    body.appendChild(buildHelpTable(doc));
    const closeBtn = helpEl(doc, 'button', HELP_ROOT_CLASS + '__close', 'Close');
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('data-action', HELP_CLOSE_ACTION);
    body.appendChild(closeBtn);
    content.appendChild(header);
    content.appendChild(body);
    overlay.appendChild(content);

    const close = closerFor(overlay);
    if (typeof closeBtn.addEventListener === 'function') {
        closeBtn.addEventListener('click', close);
    }

    if (doc.body) doc.body.appendChild(overlay);
    if (stack) stack.push(overlay, { onEscape: close });

    // Guarded: a mini-DOM test harness may build elements with no focus
    // method, and a help panel is not worth throwing over.
    if (typeof closeBtn.focus === 'function') closeBtn.focus();

    return { overlay, close };
}
