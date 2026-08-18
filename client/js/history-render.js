/**
 * History viewer - DOM builders. Takes model nodes, returns elements.
 * ----------------------------------------------------------------------
 * NO `innerHTML` WITH ARCHIVE CONTENT ANYWHERE IN THIS FILE. Every piece
 * of text that came out of the database is written with `textContent`.
 * Two reasons, and the second is the one that bites: transcripts are full
 * of HTML, angle brackets and half-written markup that a browser would
 * happily interpret, so `innerHTML` would both mangle the reading
 * experience and hand the page an injection surface from eight months of
 * archived tool output. `textContent` plus `white-space: pre-wrap` in the
 * stylesheet renders it as what it is: text.
 *
 * WHAT A CHIP DOES AND DOES NOT CLAIM. A tool chip shows what this
 * phase's payload actually carries: the call's identifier, its duration
 * where both ends of it were measured, and how many `progress` ticks
 * folded into it. It does NOT show a tool NAME and it does NOT show an
 * error dot, because neither is in the window response - the tool name
 * lives only inside `messages.raw_json`, which the window query excludes
 * by design, and there is no `is_error` column at all. So the expanded
 * chip SAYS that, in those words, rather than showing a blank field or a
 * cheerful green dot that would assert a success nobody measured. When
 * the backfill lands, this is the one function that changes.
 */

console.log('[HistoryRender Module] Loading...');

(function () {
    'use strict';

    var Model = window.HistoryModel;
    var Nodes = window.HistoryNodes;

    /** Longest `cwd` shown in a session row before it is head-clipped. */
    var CWD_MAX_CHARS = 44;

    /**
     * Create an element with a class and optional text.
     *
     * Inputs:
     *   tag (string) - element name.
     *   className (string) - space-separated classes, may be "".
     *   text (string|undefined) - assigned via textContent when given.
     * Output: HTMLElement.
     */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /**
     * Clip a long path from the LEFT, keeping the meaningful tail.
     *
     * A cwd's identity is its last two or three segments; clipping from
     * the right would leave every row reading "/Users/jsugamele/Devel...".
     *
     * Inputs: value (string|null), max (number).
     * Output: string - "" when there is no path, so the caller can decide
     *   what an absent cwd looks like rather than getting "null".
     */
    function clipPath(value, max) {
        if (!value) return '';
        var text = String(value);
        if (text.length <= max) return text;
        return '...' + text.slice(text.length - max + 3);
    }

    /**
     * Build a row of small metadata chips, skipping absent values.
     *
     * Inputs: pairs (Array) - `[[label, value], ...]`; a pair whose value
     *   is falsy is omitted entirely rather than rendered empty.
     * Output: HTMLElement - a `.history-meta` container.
     */
    function metaRow(pairs) {
        var row = el('div', 'history-meta');
        pairs.forEach(function (pair) {
            if (!pair[1]) return;
            var chip = el('span', 'history-meta__item');
            chip.appendChild(el('span', 'history-meta__label', pair[0]));
            chip.appendChild(el('span', 'history-meta__value', pair[1]));
            row.appendChild(chip);
        });
        return row;
    }

    /**
     * Build a project list row.
     *
     * Inputs: project (object) - one item from `/history/projects`.
     * Output: HTMLElement - a `<button>` carrying `dataset.projectId`.
     */
    function projectRow(project) {
        var row = el('button', 'history-row');
        row.type = 'button';
        row.dataset.projectId = String(project.id);
        row.appendChild(el('span', 'history-row__title', project.slug || ('project ' + project.id)));
        if (project.guessed_path) {
            row.appendChild(el('span', 'history-row__sub', clipPath(project.guessed_path, CWD_MAX_CHARS)));
        }
        row.appendChild(metaRow([
            ['conversations', String(project.session_count)],
            ['agents', project.subagent_session_count ? String(project.subagent_session_count) : ''],
            ['unclassified', project.unclassified_session_count ? String(project.unclassified_session_count) : ''],
            ['last', Model.formatDate(project.last_session_at)]
        ]));
        return row;
    }

    /**
     * Build a session list row.
     *
     * Inputs: session (object) - one item from `/history/sessions`.
     * Output: HTMLElement - a `<button>` carrying `dataset.sessionId`.
     */
    function sessionRow(session) {
        var row = el('button', 'history-row');
        row.type = 'button';
        row.dataset.sessionId = String(session.id);
        var title = session.custom_title || session.slug || ('session ' + session.id);
        row.appendChild(el('span', 'history-row__title', title));
        row.appendChild(el('span', 'history-row__sub', clipPath(session.cwd, CWD_MAX_CHARS) || 'no cwd recorded'));
        row.appendChild(metaRow([
            ['branch', session.git_branch],
            ['model', session.model],
            ['messages', session.message_count === null || session.message_count === undefined
                ? '' : String(session.message_count)],
            ['agents', session.subagent_count ? String(session.subagent_count) : ''],
            ['started', Model.formatDate(session.started_at)]
        ]));
        return row;
    }

    /**
     * Build one thread node's element.
     *
     * Inputs: node (object) - from `HistoryNodes.buildNodes`.
     * Output: HTMLElement - always carries `dataset.seq` so the thread can
     *   scroll to a `seq_in_file` without a second index.
     */
    function threadNode(node) {
        var element = nodeElement(node);
        element.dataset.seq = String(node.seq);
        return element;
    }

    /**
     * Dispatch a node to its builder.
     *
     * Inputs: node (object). Output: HTMLElement.
     */
    function nodeElement(node) {
        if (node.kind === Nodes.NODE_DIVIDER) return dividerElement(node);
        if (node.kind === Nodes.NODE_CHIP) return chipElement(node);
        if (node.kind === Nodes.NODE_NOTE) return noteElement(node);
        return bubbleElement(node);
    }

    /**
     * Build a message bubble.
     *
     * Inputs: node (object) - a `user` or `assistant` node. `user` sits
     *   right, `assistant` left, which is the whole point of the layout.
     * Output: HTMLElement.
     */
    function bubbleElement(node) {
        var side = node.kind === Nodes.NODE_USER ? 'user' : 'assistant';
        var wrap = el('div', 'history-turn history-turn--' + side);
        var bubble = el('div', 'history-bubble history-bubble--' + side);
        bubble.appendChild(el('div', 'history-bubble__text', node.text || ''));
        if (node.truncated) {
            bubble.appendChild(el('div', 'history-bubble__flag',
                'body truncated by the server; the rest is not in this response'));
        }
        wrap.appendChild(bubble);
        var when = Model.formatWhen(node.when);
        if (when) wrap.appendChild(el('div', 'history-turn__when', when));
        return wrap;
    }

    /**
     * Build a collapsed tool-call chip.
     *
     * A chip is NOT a bubble: it is a full-width, single-line strip
     * between turns, so a thread of a hundred tool calls still reads as a
     * conversation. It expands in place to show what the API returned and
     * to NAME what the API did not return.
     *
     * Inputs: node (object) - a `chip` node.
     * Output: HTMLElement - a `<details>`, so expansion needs no
     *   JavaScript, no inline handler and no CSP exception.
     */
    function chipElement(node) {
        var details = el('details', 'history-chip');
        var summary = el('summary', 'history-chip__summary');
        summary.appendChild(el('span', 'history-chip__icon', node.orphanResult ? '<' : '>'));
        summary.appendChild(el('span', 'history-chip__name',
            node.orphanResult ? 'tool result' : 'tool call'));
        var id = Model.shortId(node.toolUseId);
        if (id) summary.appendChild(el('span', 'history-chip__id', id));
        var duration = Model.formatDuration(node.durationMs);
        if (duration) summary.appendChild(el('span', 'history-chip__duration', duration));
        if (node.progress) {
            summary.appendChild(el('span', 'history-chip__progress', node.progress + ' ticks'));
        }
        details.appendChild(summary);
        details.appendChild(chipBody(node));
        return details;
    }

    /**
     * Build the expanded body of a tool chip.
     *
     * Inputs: node (object) - a `chip` node.
     * Output: HTMLElement.
     */
    function chipBody(node) {
        var body = el('div', 'history-chip__body');
        body.appendChild(metaRow([
            ['id', node.toolUseId || ''],
            ['called', Model.formatWhen(node.when)],
            ['duration', Model.formatDuration(node.durationMs)],
            ['progress ticks', node.progress ? String(node.progress) : '']
        ]));
        if (node.durationMs === null && !node.orphanResult) {
            body.appendChild(el('p', 'history-chip__gap',
                node.result
                    ? 'duration not measured: one of the two timestamps is missing'
                    : 'duration not measured: this call\'s result is not in the loaded window'));
        }
        if (node.orphanResult) {
            body.appendChild(el('p', 'history-chip__gap',
                'the call that produced this result is above the loaded window'));
        }
        body.appendChild(el('p', 'history-chip__gap',
            'tool name and error state are not in this response: the name lives only '
            + 'in the raw record, which the thread query excludes, and there is no '
            + 'error column. The drill-down that reads them is a later phase, so this '
            + 'chip does not guess at either.'));
        return body;
    }

    /**
     * Build a full-width compaction divider.
     *
     * Inputs: node (object) - a `divider` node.
     * Output: HTMLElement - a `<details>` when there is summary text to
     *   expand, a plain `<div>` when there is not. A divider that looked
     *   expandable and expanded to nothing would be a dead affordance.
     */
    function dividerElement(node) {
        var label = dividerLabel(node);
        if (!node.summary) {
            var flat = el('div', 'history-divider');
            flat.appendChild(el('span', 'history-divider__label', label));
            return flat;
        }
        var details = el('details', 'history-divider history-divider--expandable');
        var summary = el('summary', 'history-divider__label', label);
        details.appendChild(summary);
        var body = el('div', 'history-divider__body');
        body.appendChild(el('div', 'history-divider__text', node.summary));
        if (node.summaryTruncated) {
            body.appendChild(el('div', 'history-bubble__flag',
                'summary truncated by the server; the rest is not in this response'));
        }
        details.appendChild(body);
        return details;
    }

    /**
     * Compose a divider's one-line label.
     *
     * Inputs: node (object) - a `divider` node.
     * Output: string - always names the count as UNKNOWN rather than
     *   printing 0 when there is no `compaction_events` row to read it
     *   from, because "zero messages were summarised" is a claim and
     *   "there is no record of how many" is the truth.
     */
    function dividerLabel(node) {
        var event = node.event;
        var count = event && event.preceding_message_count !== null
            && event.preceding_message_count !== undefined
            ? event.preceding_message_count + ' messages summarized'
            : 'message count not recorded';
        var parts = ['COMPACTED HERE', count];
        var subtype = (event && event.subtype) || node.subtype;
        if (subtype) parts.push(subtype);
        var when = Model.formatWhen((event && event.occurred_at) || node.when);
        if (when) parts.push(when);
        if (node.boundaryAbove) parts.push('boundary row above this window');
        return parts.join(' - ');
    }

    /**
     * Build a non-conversation record row.
     *
     * Inputs: node (object) - a `note` node.
     * Output: HTMLElement - names the record type, so a type nobody has
     *   classified yet is visibly an unclassified record rather than
     *   silently costumed as a message.
     */
    function noteElement(node) {
        var wrap = el('div', 'history-note' + (node.empty ? ' history-note--empty' : ''));
        wrap.appendChild(el('span', 'history-note__type', node.recordType));
        if (node.empty) {
            wrap.appendChild(el('span', 'history-note__text', node.emptyReason));
        } else if (node.text) {
            wrap.appendChild(el('span', 'history-note__text', node.text));
        }
        return wrap;
    }

    /**
     * Build the standard "could not be evaluated" block.
     *
     * Inputs:
     *   body (object) - an `unavailable` envelope.
     *   what (string) - what was being read, e.g. "this session's thread".
     * Output: HTMLElement.
     */
    function unavailableBlock(body, what) {
        var box = el('div', 'history-unavailable');
        box.appendChild(el('div', 'history-unavailable__title',
            'could not read ' + what));
        box.appendChild(el('div', 'history-unavailable__reason',
            window.HistoryAPI.reasonText(body)));
        if (body && body.reason) {
            box.appendChild(el('div', 'history-unavailable__code', body.reason));
        }
        return box;
    }

    /**
     * Build the freshness caveat banner, or null when there is nothing to
     * say.
     *
     * Inputs: body (object) - any `ok` envelope.
     * Output: HTMLElement|null - null when `caveats` is empty, which means
     *   the archive was measured and found current. An absent banner is
     *   therefore a positive measurement, not an absence of one.
     */
    function caveatBanner(body) {
        var caveats = (body && body.caveats) || [];
        if (!caveats.length) return null;
        var box = el('div', 'history-caveat');
        caveats.forEach(function (line) {
            box.appendChild(el('div', 'history-caveat__line', line));
        });
        return box;
    }

    /**
     * Build a search result row.
     *
     * Inputs: hit (object) - one item from `/history/search`.
     * Output: HTMLElement - a `<button>` carrying `dataset.seq`.
     */
    function searchHit(hit) {
        var row = el('button', 'history-hit');
        row.type = 'button';
        row.dataset.seq = String(hit.seq_in_file);
        row.appendChild(el('span', 'history-hit__where',
            (hit.record_type || 'record') + ' at #' + hit.seq_in_file));
        // The server's snippet marks matches with square brackets, which
        // is why it is safe to write as text rather than as markup.
        row.appendChild(el('span', 'history-hit__snippet', hit.snippet || ''));
        return row;
    }

    window.HistoryRender = {
        el: el,
        metaRow: metaRow,
        projectRow: projectRow,
        sessionRow: sessionRow,
        threadNode: threadNode,
        unavailableBlock: unavailableBlock,
        caveatBanner: caveatBanner,
        searchHit: searchHit,
        clipPath: clipPath
    };
})();
