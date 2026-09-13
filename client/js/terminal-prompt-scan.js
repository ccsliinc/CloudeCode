/**
 * TerminalPromptScan - find the prompts the USER typed, by reading the
 * xterm buffer's cells rather than anything the server knows.
 *
 * WHY THE CELLS AND NOT THE TRANSCRIPT. The obvious source for "every
 * prompt in this conversation" is the jsonl transcript, and it is the
 * wrong one: the transcript records what claude received, while the rail
 * has to point at a ROW IN THIS BUFFER. Those two do not line up one to
 * one. A resumed conversation replays turns the buffer never held, a
 * `/rename` is intercepted before it becomes a prompt and still leaves a
 * record, a repaint redraws a prompt that is already on screen, and the
 * buffer is trimmed at 50000 lines while the transcript is not. A tick
 * derived from a record with no row behind it can only jump somewhere
 * wrong, so the buffer is the ONLY source of truth here.
 *
 * WHAT A SUBMITTED PROMPT LOOKS LIKE, MEASURED. claude draws a submitted
 * prompt with its caret U+276F in column 0 over palette background 237
 * with palette foreground 239, and continues a prompt too long for one
 * row on further rows carrying that same background and no caret. That
 * cell signature is the whole detector. Reading the TEXT instead would
 * be wrong in both directions: claude prints U+276F in other chrome, and
 * a user's own markdown `>` quote or an assistant `⏺` bullet is not a
 * prompt however much a text rule wants it to be.
 *
 * ONE CELL OBJECT FOR THE WHOLE SCAN. `line.getCell(0, cell)` fills the
 * cell the caller passes and returns it, so a 50000-row buffer costs one
 * allocation rather than 50000. Do not "simplify" this to
 * `line.getCell(0)`; that is the version that allocates per row, and the
 * scan runs on a throttle behind every write.
 *
 * Pure: it takes a duck-typed buffer and returns plain objects. It knows
 * nothing about the DOM, the rail or the search panel, which is what
 * makes every rule below testable against a hand-built fake buffer.
 *
 * THE RAIL'S GEOMETRY IS HERE TOO, at the foot of the file -
 * `layoutTicks` and `currentOrdinalFor`. Placing a tick and naming the
 * one the viewport sits on are functions of a scan and a height and
 * nothing else, so they belong with the other pure rules rather than
 * inside the DOM module, and putting them here means they can be driven
 * with no element tree at all.
 * web/src/lib/terminal-search/rail-model.svelte.ts reads them through
 * its injected host and is the DOM half.
 *
 * Loaded as a plain script, no build step. Exposes
 * `window.TerminalPromptScan`.
 */
(function (global) {
    'use strict';

    /** claude's prompt caret, U+276F. */
    var CARET = '❯';

    /** Palette index of the background claude paints a prompt row with. */
    var PROMPT_BG = 237;

    /** Palette index of the foreground on that row. */
    var PROMPT_FG = 239;

    /** How many characters of a prompt the tooltip shows. */
    var PREVIEW_CHARS = 80;

    /**
     * Longest prompt text kept. A pasted file is a legitimate prompt and
     * can be megabytes; the rail needs it only to match a query and to
     * show 80 characters, so holding all of it for every tick would be a
     * per-prompt copy of the buffer for no gain the user can see.
     */
    var MAX_TEXT = 2000;

    /**
     * How many rows either side of a candidate are searched for one of
     * claude's frame rules when deciding whether the candidate is the
     * LIVE input box rather than a submitted prompt.
     */
    var LIVE_BOX_RADIUS = 2;

    /**
     * Description: is this the first cell of a SUBMITTED prompt row?
     * Inputs: cell (object|null) - an xterm IBufferCell, or any falsy
     *   value for a row that could not be read.
     * Output: boolean - true only when the caret, the palette flag, the
     *   background index and the foreground index ALL agree. A caret on
     *   a truecolor or default background is claude's chrome somewhere
     *   else, not a prompt.
     * Example: isPromptCell({getChars: () => '❯', isBgPalette: () => true,
     *   getBgColor: () => 237, getFgColor: () => 239}) // true
     */
    function isPromptCell(cell) {
        if (!cell) return false;
        try {
            return cell.getChars() === CARET
                && cell.isBgPalette() === true
                && cell.getBgColor() === PROMPT_BG
                && cell.getFgColor() === PROMPT_FG;
        } catch (err) {
            return false;
        }
    }

    /**
     * Description: is this the first cell of a row CONTINUING the prompt
     *   above it? claude wraps a long prompt onto further rows painted
     *   with the same background and no caret.
     * Inputs: cell (object|null) - an xterm IBufferCell, or falsy.
     * Output: boolean.
     * Example: isContinuation({getChars: () => 'h', isBgPalette: () => true,
     *   getBgColor: () => 237, getFgColor: () => 250}) // true
     */
    function isContinuation(cell) {
        if (!cell) return false;
        try {
            return cell.isBgPalette() === true
                && cell.getBgColor() === PROMPT_BG
                && cell.getChars() !== CARET;
        } catch (err) {
            return false;
        }
    }

    /**
     * Description: read one buffer row as a string, untrimmed, without
     *   throwing on a row the buffer will not hand over.
     * Inputs: buf (object) - the duck-typed buffer. i (number) - absolute
     *   line index.
     * Output: string - '' when the row is missing or unreadable. An
     *   unreadable row reads as blank rather than as an exception,
     *   because one bad row must not lose every prompt in the session.
     */
    function rowText(buf, i) {
        try {
            var line = buf.getLine(i);
            if (!line || typeof line.translateToString !== 'function') return '';
            return line.translateToString(false) || '';
        } catch (err) {
            return '';
        }
    }

    /**
     * Description: strip claude's caret and the U+00A0 it prints after it
     *   from the head of a prompt's first row.
     * Inputs: raw (string) - the row as translated.
     * Output: string - the row with the caret prefix removed. A row that
     *   does not start with the caret (leading padding aside) comes back
     *   unchanged rather than having a character eaten off its front.
     * Example: stripCaret('❯ run the tests') // 'run the tests'
     *   (the character after the caret there is a real U+00A0)
     */
    function stripCaret(raw) {
        var text = String(raw || '');
        var at = text.indexOf(CARET);
        if (at === -1) return text;
        return text.slice(at + 1).replace(/^\s+/, '');
    }

    /**
     * Description: join a prompt's rows back into the one line the user
     *   typed.
     *
     *   THE JOIN CHARACTER IS THE WHOLE QUESTION, and it is answered the
     *   way copy-output.js already answers it for urls: a row whose LAST
     *   CELL is occupied was cut by the width and its successor continues
     *   mid-token, so those two join with NOTHING. A row that stopped
     *   short ended a word, so the next row joins with a space. Joining
     *   everything with nothing glues words together, and joining
     *   everything with a space breaks a long path or url in half, which
     *   is the measured defect copy-output.js exists to record.
     *
     * Inputs: rows (string[]) - the prompt's rows, first one already
     *   stripped of its caret. cols (number) - pane width, 0 when unknown
     *   (then every row is treated as having stopped short).
     * Output: string - right-trimmed, capped at MAX_TEXT characters.
     * Example: foldRows(['run the', 'tests'], 80) // 'run the tests'
     */
    function foldRows(rows, cols) {
        var out = '';
        var prevFilled = false;
        for (var i = 0; i < rows.length; i++) {
            var raw = rows[i];
            var filled = cols > 0 && raw.length >= cols
                && raw.charAt(cols - 1) !== ' ';
            var piece = raw.replace(/\s+$/, '');
            if (i === 0) {
                out = piece;
            } else if (prevFilled) {
                out += piece;
            } else {
                out += piece === '' ? '' : ' ' + piece.replace(/^\s+/, '');
            }
            prevFilled = filled;
            if (out.length >= MAX_TEXT) break;
        }
        out = out.replace(/\s+$/, '');
        return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out;
    }

    /**
     * Description: is this candidate the LIVE input box rather than a
     *   prompt already sent?
     *
     *   claude's live box is drawn as a rule row, the caret row, another
     *   rule row. A submitted prompt scrolled into history has no frame
     *   around it. So a candidate sitting in the live region with one of
     *   claude's long U+2500 runs within two rows is the box the user is
     *   typing into, and a tick pointing at it would be a tick pointing
     *   at "here", which the viewport already shows.
     *
     *   Only the LIVE region is tested. A rule row can legitimately sit
     *   beside a submitted prompt further up (claude prints them around
     *   other chrome), and excluding on that would silently drop real
     *   prompts from the middle of the conversation.
     *
     * Inputs: buf (object) - the buffer. line (number) - candidate row.
     *   baseY (number) - first row of the live region. rows (number) -
     *   viewport height, so the live region is [baseY, baseY + rows).
     *   isRule (function|null) - AltScreenScroll.isRule, injected. When
     *   absent NOTHING is excluded: not being able to look is not
     *   evidence the box is there, and dropping every candidate would
     *   empty the rail.
     * Output: boolean - true to exclude.
     */
    function inLiveBox(buf, line, baseY, rows, isRule) {
        if (typeof isRule !== 'function') return false;
        if (line < baseY) return false;
        if (rows > 0 && line >= baseY + rows) return false;
        var from = Math.max(0, line - LIVE_BOX_RADIUS);
        var to = line + LIVE_BOX_RADIUS;
        for (var j = from; j <= to; j++) {
            if (j === line) continue;
            if (isRule(rowText(buf, j))) return true;
        }
        return false;
    }

    /**
     * Description: every prompt in the buffer, in buffer order.
     *
     * Inputs:
     *   buf (object) - duck-typed xterm buffer: `length`, `getLine(i)`,
     *     and ideally `getNullCell()`.
     *   opts (object, optional):
     *     cols (number) - pane width, for the fold rule. Default 0.
     *     baseY (number) - first row of the live region. Defaults to
     *       `buf.baseY`, then 0.
     *     rows (number) - viewport height, bounding the live region.
     *       Default 0, which means "the live region runs to the end".
     *     isRule (function) - AltScreenScroll.isRule. Omitted means no
     *       live-box exclusion at all.
     * Output: Array<{ordinal, line, text, preview}> - ordinal is 1-based
     *   in buffer order, line is the ABSOLUTE buffer row of the caret,
     *   text is the folded prompt capped at 2000 characters, preview is
     *   its first 80. Empty array on any unreadable buffer.
     *
     * Three candidates are dropped, each for a measured reason:
     *   - an empty prompt (a caret row with nothing after it) - a tick
     *     with no preview tells the user nothing;
     *   - a prompt starting with `!` - that is claude's bash passthrough,
     *     not a turn in the conversation;
     *   - a prompt whose text repeats the one before it - a repaint draws
     *     the same prompt twice and two ticks for one turn is a miscount.
     *     The known cost of that last rule is real: genuinely typing
     *     `continue` twice in a row shows one tick, not two. It is kept
     *     because a duplicated repaint is common and a deliberate
     *     immediate repeat is rare, and because the count in the tooltip
     *     has to mean something.
     *
     * Example: scan(buf, {cols: 80, baseY: 400, rows: 40, isRule: isRule})
     *   // [{ordinal: 1, line: 12, text: 'run the tests', preview: 'run the tests'}]
     */
    function scan(buf, opts) {
        var out = [];
        if (!buf || typeof buf.getLine !== 'function') return out;
        var o = opts || {};
        var cols = typeof o.cols === 'number' && o.cols > 0 ? o.cols : 0;
        var baseY = typeof o.baseY === 'number'
            ? o.baseY
            : (typeof buf.baseY === 'number' ? buf.baseY : 0);
        var rows = typeof o.rows === 'number' && o.rows > 0 ? o.rows : 0;
        var isRule = typeof o.isRule === 'function' ? o.isRule : null;

        var length = typeof buf.length === 'number' ? buf.length : 0;
        if (length <= 0) return out;

        // The one cell for the whole scan. See the module header.
        var shared = null;
        try {
            if (typeof buf.getNullCell === 'function') shared = buf.getNullCell();
        } catch (err) {
            shared = null;
        }

        var lastText = null;
        var i = 0;
        while (i < length) {
            var cell = cellAt(buf, i, shared);
            if (!isPromptCell(cell)) {
                i++;
                continue;
            }

            var start = i;
            var rowsOfPrompt = [stripCaret(rowText(buf, i))];
            var j = i + 1;
            while (j < length) {
                var next = cellAt(buf, j, shared);
                if (!isContinuation(next)) break;
                rowsOfPrompt.push(rowText(buf, j));
                j++;
            }
            i = j;

            var text = foldRows(rowsOfPrompt, cols);
            if (text === '') continue;
            if (text.charAt(0) === '!') continue;
            if (text === lastText) continue;
            if (inLiveBox(buf, start, baseY, rows, isRule)) continue;

            lastText = text;
            out.push({
                ordinal: out.length + 1,
                line: start,
                text: text,
                preview: text.length > PREVIEW_CHARS
                    ? text.slice(0, PREVIEW_CHARS)
                    : text
            });
        }
        return out;
    }

    /**
     * Description: read column 0 of one row into the SHARED cell.
     * Inputs: buf (object), i (number), shared (object|null) - the one
     *   cell allocated for this scan, or null when the buffer has no
     *   `getNullCell` (a fake in a test, or a future xterm).
     * Output: object|null - the filled cell, or null when the row is
     *   missing or the read threw.
     */
    function cellAt(buf, i, shared) {
        try {
            var line = buf.getLine(i);
            if (!line || typeof line.getCell !== 'function') return null;
            return (shared ? line.getCell(0, shared) : line.getCell(0)) || null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Smallest gap between two ticks in px, and therefore also the pitch
     * at which the rail runs out of room and starts merging adjacent
     * prompts into a cluster. One number, not two: the merge threshold IS
     * the spacing rule.
     */
    var TICK_MIN_GAP = 4;

    /**
     * Description: tick positions, PROPORTIONAL TO THE BUFFER rather than
     *   to the prompt index (spacing by index says nothing about where
     *   the work is), merged into clusters when the rail is too short to
     *   separate them, then nudged apart so none overlap.
     * Inputs: prompts (Array) - {ordinal, line}, buffer order.
     *   bufferLength (number) - `buf.length`, the denominator.
     *   railHeight (number) - measured px, or 0 when the rail has no box
     *     yet, in which case every tick lands at 0 and the next refresh
     *     places them. A fabricated default would put ticks where nothing
     *     was measured, which is worse than a stack visibly wrong.
     * Output: Array<{ordinals: number[], y: number}>, ascending y.
     * Example: layoutTicks([{ordinal: 1, line: 0}, {ordinal: 2, line: 100}],
     *   100, 200) // [{ordinals: [1], y: 0}, {ordinals: [2], y: 200}]
     */
    function layoutTicks(prompts, bufferLength, railHeight) {
        var out = [];
        if (!prompts || prompts.length === 0) return out;
        var height = railHeight > 0 ? railHeight : 0;
        var denom = bufferLength > 0 ? bufferLength : 1;
        var maxTicks = height > 0
            ? Math.max(1, Math.floor(height / TICK_MIN_GAP))
            : prompts.length;
        var perTick = Math.max(1, Math.ceil(prompts.length / maxTicks));

        for (var i = 0; i < prompts.length; i += perTick) {
            var group = prompts.slice(i, i + perTick);
            var sum = 0;
            var ordinals = [];
            for (var k = 0; k < group.length; k++) {
                sum += (group[k].line / denom) * height;
                ordinals.push(group[k].ordinal);
            }
            out.push({ ordinals: ordinals, y: sum / group.length });
        }

        // Minimum spacing, ascending, clamped so the last tick stays on
        // the rail rather than being pushed off the bottom of it.
        var prev = -Infinity;
        for (var j = 0; j < out.length; j++) {
            if (out[j].y < prev + TICK_MIN_GAP) out[j].y = prev + TICK_MIN_GAP;
            if (height > 0 && out[j].y > height) out[j].y = height;
            out[j].y = Math.round(out[j].y);
            prev = out[j].y;
        }
        return out;
    }

    /**
     * Description: which prompt the viewport sits on - the LAST at or
     *   above it, or the FIRST when the viewport is above them all,
     *   because "before the first turn" is better said by highlighting
     *   that turn than by highlighting nothing.
     * Inputs: prompts (Array), viewportY (number) - absolute top row.
     * Output: number - the ordinal, 0 when there are no prompts.
     * Example: currentOrdinalFor([{ordinal: 1, line: 5},
     *   {ordinal: 2, line: 50}], 60) // 2
     */
    function currentOrdinalFor(prompts, viewportY) {
        if (!prompts || prompts.length === 0) return 0;
        var found = 0;
        for (var i = 0; i < prompts.length; i++) {
            if (prompts[i].line <= viewportY) found = prompts[i].ordinal;
            else break;
        }
        return found || prompts[0].ordinal;
    }

    global.TerminalPromptScan = {
        scan: scan,
        isPromptCell: isPromptCell,
        isContinuation: isContinuation,
        PROMPT_BG: PROMPT_BG,
        PROMPT_FG: PROMPT_FG,
        CARET: CARET,
        PREVIEW_CHARS: PREVIEW_CHARS,
        MAX_TEXT: MAX_TEXT,
        layoutTicks: layoutTicks,
        currentOrdinalFor: currentOrdinalFor,
        TICK_MIN_GAP: TICK_MIN_GAP
    };
}(typeof window !== 'undefined' ? window : globalThis));
