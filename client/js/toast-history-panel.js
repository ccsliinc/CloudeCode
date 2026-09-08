/**
 * ToastHistoryPanel - punchlist item 8, the notification history.
 *
 * The owner, verbatim: "we should keep a history log that i can look at
 * in case i miss something, maybe a history page." Item 7 made toasts
 * visible from every session, which means MORE of them land while he is
 * looking elsewhere, so a scrollback of what was raised is the other
 * half of that change rather than a separate feature.
 *
 * WHERE IT LIVES, and why it is not a new screen. The settings panel
 * already has a `notifications` TAB (the ntfy / slack / pushover
 * channels), and settings-panel.js already has a declarative SLOT
 * mechanism that the wrappers and terminal-commands panels use: a tab
 * declares `slots: ['x']`, the body renders `<div id="settings-x-slot">`,
 * and `mountSlots()` hands that node to the owning module. This mounts
 * into that. Inventing a fourth navigation pattern for a read-only list
 * would put notification history somewhere the user has no reason to
 * look for it, when the screen literally titled "notifications" already
 * exists.
 *
 * READ ONLY. Nothing here acks, dismisses or deletes. A history that
 * could destroy its own records is not a history, and the dismissal
 * semantics this change was careful to keep per session must not gain a
 * second, wider entry point through the back door.
 *
 * A ROW IS A JUMP LINK. Clicking one enters the session it names,
 * through `ToastNavigate.go` - the same resolver the toast cards use, so
 * both surfaces enter a session by the one path that carries the pinned
 * theme. The panel closes itself on the way (ToastNavigate does it), or
 * the user would land on a terminal behind a modal.
 *
 * EVERY WORD IT PRINTS COMES FROM toast-history-render.js. This file
 * places nodes and calls the network; it decides nothing about what a
 * record means.
 */
(function () {
    'use strict';

    /** Rows per page. Matches the server's own default. */
    var PAGE_SIZE = 100;

    var state = {
        slot: null,
        offset: 0,
        loading: false,
    };

    /**
     * Description: the markup the settings panel inserts for this slot.
     *   A container and nothing else - the list is built as DOM nodes in
     *   `render` rather than as an HTML string, so a session label
     *   containing markup can never become markup.
     * Inputs: none. Output: string.
     */
    function slotHtml() {
        return '<div id="settings-toast-history-slot"></div>';
    }

    /**
     * Description: mount the panel into its slot and load the first page.
     *   Idempotent - re-mounting (the settings panel remounts after every
     *   save) reuses the node and re-fetches rather than stacking a
     *   second list into it.
     * Inputs: slot (HTMLElement). Output: void.
     * Example: ToastHistoryPanel.mount(document.querySelector('#settings-toast-history-slot'))
     */
    function mount(slot) {
        if (!slot) return;
        state.slot = slot;
        state.offset = 0;
        slot.textContent = '';
        var section = document.createElement('div');
        section.className = 'toast-history';

        var heading = document.createElement('h3');
        heading.className = 'toast-history__heading';
        heading.textContent = 'notification history';
        section.appendChild(heading);

        var note = document.createElement('p');
        note.className = 'toast-history__note';
        note.textContent = 'everything raised in this server run, newest first. '
            + 'click a row to jump to the session that raised it.';
        section.appendChild(note);

        var list = document.createElement('div');
        list.className = 'toast-history__list';
        list.setAttribute('role', 'list');
        section.appendChild(list);

        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'toast-history__more';
        more.textContent = 'load older';
        more.hidden = true;
        more.addEventListener('click', function () { load(true); });
        section.appendChild(more);

        slot.appendChild(section);
        state.list = list;
        state.more = more;
        load(false);
    }

    /**
     * Description: fetch one page and paint it.
     *   FAILURE IS SAID OUT LOUD rather than rendered as an empty list. A
     *   history that cannot be read and an empty history are different
     *   facts, and collapsing them is exactly how a user concludes
     *   nothing ever happened.
     * Inputs: append (boolean) - true to add the next page, false to
     *   replace with the first.
     * Output: Promise<void>.
     */
    function load(append) {
        if (state.loading || !state.list) return Promise.resolve();
        if (!window.API || typeof window.API.getToastHistory !== 'function') {
            setMessage('notification history is unavailable in this build.');
            return Promise.resolve();
        }
        state.loading = true;
        if (!append) state.offset = 0;
        return window.API.getToastHistory({ limit: PAGE_SIZE, offset: state.offset })
            .then(function (payload) {
                render(payload, append);
            })
            .catch(function (err) {
                console.warn('[ToastHistoryPanel] load failed', err && err.message);
                setMessage('could not read notification history: '
                    + ((err && err.message) || 'unknown error'));
            })
            .then(function () {
                state.loading = false;
            });
    }

    /**
     * Description: paint one response page into the list.
     * Inputs: payload (object) - the /toasts/history body. append (bool).
     * Output: void.
     */
    function render(payload, append) {
        var records = (payload && payload.toasts) || [];
        var R = window.ToastHistoryRender;
        if (!append) state.list.textContent = '';
        if (!records.length && !append) {
            setMessage(R ? R.emptyText(payload && payload.storage)
                : 'no notifications recorded yet.');
            state.more.hidden = true;
            return;
        }
        var now = Date.now();
        records.forEach(function (record) {
            state.list.appendChild(rowNode(R ? R.row(record, now) : null, record));
        });
        // `next_offset` is null on the last page, so paging advances by
        // reading a field rather than re-deriving the boundary sum.
        var next = payload && payload.next_offset;
        if (next === null || next === undefined) {
            state.more.hidden = true;
        } else {
            state.offset = next;
            state.more.hidden = false;
        }
    }

    /**
     * Description: build one row's DOM from an already-decided view model.
     * Inputs: view (object from ToastHistoryRender.row, or null),
     *   record (the raw server toast, for the jump).
     * Output: HTMLElement.
     */
    function rowNode(view, record) {
        var el = document.createElement('div');
        el.className = 'toast-history__row';
        el.setAttribute('role', 'listitem');
        if (!view) {
            el.textContent = '(unreadable record)';
            return el;
        }
        el.dataset.outcome = view.outcome;
        el.dataset.kind = view.rawKind;

        var head = document.createElement('div');
        head.className = 'toast-history__head';

        var kind = document.createElement('span');
        kind.className = 'toast-history__kind';
        kind.textContent = view.kind;
        head.appendChild(kind);

        var session = document.createElement('span');
        session.className = 'toast-history__session';
        session.textContent = view.session;
        head.appendChild(session);

        var outcome = document.createElement('span');
        outcome.className = 'toast-history__outcome';
        outcome.textContent = view.outcome;
        head.appendChild(outcome);

        el.appendChild(head);

        var title = document.createElement('div');
        title.className = 'toast-history__title';
        title.textContent = view.title;
        el.appendChild(title);

        if (view.body) {
            var body = document.createElement('div');
            body.className = 'toast-history__body';
            body.textContent = view.body;
            el.appendChild(body);
        }

        var time = document.createElement('div');
        time.className = 'toast-history__time';
        time.textContent = view.relative;
        if (view.absolute) time.setAttribute('title', view.absolute);
        el.appendChild(time);

        if (view.jumpable && window.ToastNavigate) {
            el.classList.add('toast-history__row--jump');
            el.setAttribute('tabindex', '0');
            el.addEventListener('click', function () {
                window.ToastNavigate.go(record);
            });
            el.addEventListener('keydown', function (evt) {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    window.ToastNavigate.go(record);
                }
            });
        }
        return el;
    }

    /**
     * Description: replace the list with one explanatory sentence.
     * Inputs: text (string). Output: void.
     */
    function setMessage(text) {
        if (!state.list) return;
        state.list.textContent = '';
        var p = document.createElement('p');
        p.className = 'toast-history__empty';
        p.textContent = text;
        state.list.appendChild(p);
    }

    window.ToastHistoryPanel = {
        mount: mount,
        slotHtml: slotHtml,
        PAGE_SIZE: PAGE_SIZE,
    };
}());
