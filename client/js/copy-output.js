/**
 * Copy-output sheet - get text OUT of the terminal on a phone.
 * ----------------------------------------------------------------------
 * On a touch device there is no way to select terminal text: xterm.js has
 * no touch selection, and the long-press flow in touch-select.js is
 * fiddly across a wrapped url. When `/login` prints a sign-in url and a
 * code, a phone user simply cannot get them off the screen.
 *
 * This is the general answer: a button on the terminal screen opens a
 * sheet showing the recent output with
 *   - one-tap copy chips for every url and code-shaped token found
 *     (output-scan.js - it knows nothing about the login flow, so any
 *     url or token in any output gets the same treatment),
 *   - "copy all" for the whole visible block,
 *   - the raw text in a selectable textarea as the last resort, so even
 *     when both programmatic clipboard tiers fail the user can long-press
 *     and use the OS copy menu.
 *
 * All copying goes through CopyCompat, which is what makes this work at
 * all over plain http where `navigator.clipboard` does not exist.
 */
(function () {
    'use strict';

    /** How many buffer lines the sheet shows and "copy all" copies. */
    var LINE_COUNT = 400;

    /** The open sheet, or null. Only ever one. */
    var sheetEl = null;

    /** Escape handler bound while the sheet is open. */
    var onDocKey = null;

    /**
     * Read the tail of the xterm buffer as plain text.
     *
     * Uses translateToString(true) to trim each line's trailing blanks,
     * then drops leading/trailing empty lines so the sheet does not open
     * on a screenful of padding.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @param {number} [lines=LINE_COUNT] - how many buffer rows to read.
     * @returns {string} the joined text, '' when the buffer is unreadable.
     */
    function readRecentOutput(term, lines) {
        var want = typeof lines === 'number' ? lines : LINE_COUNT;
        if (!term) return '';
        try {
            var buf = term.buffer.active;
            var end = buf.length;
            var start = Math.max(0, end - want);
            var rows = [];
            for (var i = start; i < end; i++) {
                var line = buf.getLine(i);
                rows.push(line ? line.translateToString(true) : '');
            }
            while (rows.length && rows[0].trim() === '') rows.shift();
            while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
            return rows.join('\n');
        } catch (err) {
            console.warn('CopyOutput: buffer read failed', err);
            return '';
        }
    }

    /**
     * Copy handler shared by every control in the sheet. Runs inside the
     * click gesture so CopyCompat's execCommand tier stays usable.
     *
     * @param {object} termWrapper - the Terminal wrapper (status pill).
     * @param {string} text - what to copy.
     * @param {string} label - what to name it in the confirmation.
     * @returns {void}
     */
    function copyAndReport(termWrapper, text, label) {
        window.CopyCompat.copyText(text).then(function (result) {
            if (result.ok) {
                termWrapper._showStatusPill('copied ' + label, 'success');
                close();
            } else {
                // Both tiers refused. The textarea below is already on
                // screen and selectable, so point at it rather than
                // leaving a dead end.
                termWrapper._showStatusPill(
                    'copy blocked - long press the text below and use copy',
                    'error'
                );
            }
        });
    }

    /**
     * Build one tap-to-copy chip.
     *
     * @param {object} termWrapper
     * @param {{kind: string, value: string}} item
     * @returns {HTMLButtonElement}
     */
    function buildChip(termWrapper, item) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cloude-copy-chip cloude-copy-chip--' + item.kind;
        chip.title = item.value;

        var kind = document.createElement('span');
        kind.className = 'cloude-copy-chip__kind';
        kind.textContent = item.kind;

        var value = document.createElement('span');
        value.className = 'cloude-copy-chip__value';
        value.textContent = item.value;

        chip.appendChild(kind);
        chip.appendChild(value);
        chip.addEventListener('click', function () {
            copyAndReport(termWrapper, item.value, item.kind);
        });
        return chip;
    }

    /**
     * Open the sheet for the current terminal contents.
     *
     * @param {object} termWrapper - the Terminal wrapper instance.
     * @returns {void}
     */
    function open(termWrapper) {
        close();
        if (!termWrapper || !termWrapper.term) return;

        var text = readRecentOutput(termWrapper.term);
        var items = window.OutputScan ? window.OutputScan.scan(text) : [];

        sheetEl = document.createElement('div');
        sheetEl.className = 'cloude-copy-sheet';
        sheetEl.setAttribute('role', 'dialog');
        sheetEl.setAttribute('aria-label', 'copy output');

        var panel = document.createElement('div');
        panel.className = 'cloude-copy-sheet__panel';

        var head = document.createElement('div');
        head.className = 'cloude-copy-sheet__head';

        var title = document.createElement('span');
        title.className = 'cloude-copy-sheet__title';
        title.textContent = 'copy output';

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'cloude-copy-sheet__close';
        closeBtn.setAttribute('aria-label', 'close');
        closeBtn.textContent = 'x';
        closeBtn.addEventListener('click', close);

        head.appendChild(title);
        head.appendChild(closeBtn);
        panel.appendChild(head);

        if (items.length) {
            var chips = document.createElement('div');
            chips.className = 'cloude-copy-sheet__chips';
            items.forEach(function (item) {
                chips.appendChild(buildChip(termWrapper, item));
            });
            panel.appendChild(chips);
        } else {
            var none = document.createElement('p');
            none.className = 'cloude-copy-sheet__empty';
            none.textContent = 'no links or codes found in recent output';
            panel.appendChild(none);
        }

        var area = document.createElement('textarea');
        area.className = 'cloude-copy-sheet__text';
        area.setAttribute('readonly', '');
        area.setAttribute('aria-label', 'recent terminal output');
        area.value = text;
        panel.appendChild(area);

        var foot = document.createElement('div');
        foot.className = 'cloude-copy-sheet__foot';

        var copyAll = document.createElement('button');
        copyAll.type = 'button';
        copyAll.className = 'cloude-copy-sheet__action';
        copyAll.textContent = 'copy all';
        copyAll.addEventListener('click', function () {
            copyAndReport(termWrapper, text, 'output');
        });

        var hint = document.createElement('span');
        hint.className = 'cloude-copy-sheet__hint';
        hint.textContent = window.CopyCompat.hasAsyncClipboard()
            ? 'or select the text above'
            : 'insecure connection - long press the text above if a copy fails';

        foot.appendChild(copyAll);
        foot.appendChild(hint);
        panel.appendChild(foot);

        sheetEl.appendChild(panel);
        document.body.appendChild(sheetEl);

        // Backdrop tap closes; taps inside the panel must not.
        sheetEl.addEventListener('click', function (e) {
            if (e.target === sheetEl) close();
        });
        onDocKey = function (e) {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onDocKey, true);
    }

    /**
     * Close the sheet if open. Safe to call when it is not.
     *
     * @returns {void}
     */
    function close() {
        if (onDocKey) {
            document.removeEventListener('keydown', onDocKey, true);
            onDocKey = null;
        }
        if (sheetEl) {
            sheetEl.remove();
            sheetEl = null;
        }
    }

    /**
     * Wire the terminal-screen copy button.
     *
     * @param {object} termWrapper - the Terminal wrapper instance.
     * @param {HTMLElement} btn - the button element.
     * @returns {void}
     */
    function wireButton(termWrapper, btn) {
        if (!btn || btn._copyOutputWired) return;
        btn._copyOutputWired = true;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (sheetEl) {
                close();
            } else {
                open(termWrapper);
            }
        });
    }

    window.CopyOutput = {
        open: open,
        close: close,
        wireButton: wireButton,
        readRecentOutput: readRecentOutput
    };
})();
