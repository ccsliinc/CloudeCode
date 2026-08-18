/**
 * History viewer - record classification. Turns raw archive rows into the
 * ordered list of things the thread actually draws.
 * ----------------------------------------------------------------------
 * WHAT THIS FILE DECIDES: what a row from
 * `GET /api/v1/history/sessions/{id}/messages` IS. Nothing here draws
 * anything; `history-render.js` does that and asks this file what it is
 * drawing. Split from `history-model.js`, which keeps the paging
 * arithmetic and the formatting helpers - the seam is "what is this row"
 * versus "which rows do I ask for and how do I print a duration".
 *
 * WHY THE CLASSIFIER LOOKS AT SHAPE, NOT AT A LIST OF NAMES. The server
 * hides a NAMED set of bookkeeping record types (`MACHINERY_RECORD_TYPES`)
 * behind the machinery toggle. That set is a list of things somebody
 * thought of, and the live archive already contains record types outside
 * it - `custom-title` and `file-history-snapshot` were both measured in
 * session 9725 on 2026-08-18. A classifier that said "not machinery,
 * therefore a chat bubble" would render a file-snapshot record as
 * something a person said. So the rule here is inverted: a row becomes a
 * BUBBLE only when it is positively identified as conversation, and
 * everything else falls through to a low-key note that says what its
 * record type was. An unknown record type renders as an unknown record
 * type, which is the third outcome applied to rendering.
 *
 * THE THREE ROWS THAT ARE NOT WHAT THEIR ROLE SAYS:
 *
 * 1. A `record_type: 'user'` row with `has_tool_result: true` is NOT a
 *    person talking. It is a tool's output being fed back into the
 *    conversation. Rendering it as a right-hand user bubble - which is
 *    what its role field literally says - would put thousands of tool
 *    outputs in the user's own voice. It folds into the tool chip whose
 *    id it carries in `tool_result_id`.
 *
 * 2. A row with `is_compact_boundary: true` is a divider, never a bubble.
 *    These arrive in PAIRS in the live archive (measured: seq 589 is
 *    `system`/`compact_boundary`, seq 590 is `user`/`isCompactSummary`).
 *    The first is the divider; the second is the summary text that
 *    replaced what was compacted, and it folds INTO the first rather than
 *    drawing a second divider one row later.
 *
 * 3. An `assistant` row with no text and no tool call is not an empty
 *    row to skip. It is a turn whose content - extended thinking, most
 *    often - lives in the raw record the thread query does not fetch.
 *    1,178 of session 9725's 4,035 assistant records are this shape.
 *    Drawing nothing for them would drop 29% of one side of the
 *    conversation while the thread still looked complete.
 */

console.log('[HistoryNodes Module] Loading...');

(function () {
    'use strict';

    var Model = window.HistoryModel;

    /** Record types that carry conversation, keyed for readability. */
    var RECORD_USER = 'user';
    var RECORD_ASSISTANT = 'assistant';

    /** `compact_subtype` of the row holding the post-compaction summary. */
    var SUBTYPE_COMPACT_SUMMARY = 'isCompactSummary';

    /** Node kinds produced by buildNodes(). */
    var NODE_USER = 'user';
    var NODE_ASSISTANT = 'assistant';
    var NODE_CHIP = 'chip';
    var NODE_DIVIDER = 'divider';
    var NODE_NOTE = 'note';

    /**
     * Index a session outline's compaction events by their message id.
     *
     * `compaction_events` rows carry `message_id`, not `seq_in_file`, so
     * the divider is placed by matching the id of a message already in the
     * window rather than by looking up a position.
     *
     * Inputs: events (Array) - `outline.compaction_events`, possibly null.
     * Output: object - message_id (as a string key) to the event.
     */
    function indexCompactions(events) {
        var byId = {};
        (events || []).forEach(function (event) {
            if (event && event.message_id != null) byId[String(event.message_id)] = event;
        });
        return byId;
    }

    /**
     * Turn a window of message rows into an ordered list of render nodes.
     *
     * Ordering is the server's, which is `seq_in_file` ascending, and this
     * function never reorders or renumbers. That matters most across a
     * compaction boundary: what was compacted stays exactly where it was
     * in the scroll, with a divider drawn through it.
     *
     * Inputs:
     *   messages (Array) - `items` from the messages endpoint, in order.
     *   compactionsById (object) - from indexCompactions(), may be empty.
     * Output: Array of node objects, each `{kind, seq, ...}`:
     *   - `{kind:'user'|'assistant', seq, text, truncated, when, message}`
     *   - `{kind:'chip', seq, toolUseId, when, progress, result, message}`
     *   - `{kind:'divider', seq, event, summary, message}`
     *   - `{kind:'note', seq, recordType, text, when, message}`
     */
    function buildNodes(messages, compactionsById) {
        var nodes = [];
        var chipsByToolUseId = {};
        var lastDivider = null;
        var compactions = compactionsById || {};

        (messages || []).forEach(function (message) {
            if (message.is_compact_boundary) {
                lastDivider = appendCompaction(nodes, message, compactions, lastDivider);
                return;
            }
            if (message.record_type === RECORD_USER) {
                appendUserRow(nodes, message, chipsByToolUseId);
                return;
            }
            if (message.record_type === RECORD_ASSISTANT) {
                appendAssistantRow(nodes, message, chipsByToolUseId);
                return;
            }
            nodes.push(noteNode(message));
        });
        return nodes;
    }

    /**
     * Handle a row flagged `is_compact_boundary`.
     *
     * Inputs:
     *   nodes (Array) - accumulator, mutated.
     *   message (object) - the boundary row.
     *   compactions (object) - message_id-keyed events.
     *   lastDivider (object|null) - the previous divider node, if any.
     * Output: object|null - the divider node a following summary row
     *   should fold into. A summary row returns the divider it just
     *   attached to unchanged, so two summaries cannot both claim it.
     */
    function appendCompaction(nodes, message, compactions, lastDivider) {
        if (message.compact_subtype === SUBTYPE_COMPACT_SUMMARY) {
            if (lastDivider) {
                lastDivider.summary = message.text_content || '';
                lastDivider.summaryTruncated = !!message.text_truncated;
                return lastDivider;
            }
            // The divider this summarises is above the loaded window. Show
            // it as its own divider rather than dropping it: a summary
            // with no visible boundary still means a compaction happened
            // here, and silently discarding it would hide that.
            var orphan = dividerNode(message, compactions);
            orphan.summary = message.text_content || '';
            orphan.boundaryAbove = true;
            nodes.push(orphan);
            return orphan;
        }
        var divider = dividerNode(message, compactions);
        nodes.push(divider);
        return divider;
    }

    /**
     * Build a compaction divider node.
     *
     * Inputs: message (object), compactions (object) keyed by message id.
     * Output: object - a `divider` node. `event` is null when the row is
     *   flagged as a boundary but has no `compaction_events` row, in which
     *   case the count of what it replaced is genuinely unknown and the
     *   renderer says so instead of printing a zero.
     */
    function dividerNode(message, compactions) {
        return {
            kind: NODE_DIVIDER,
            seq: message.seq_in_file,
            event: compactions[String(message.id)] || null,
            subtype: message.compact_subtype || null,
            when: message.timestamp || null,
            summary: '',
            summaryTruncated: false,
            boundaryAbove: false,
            message: message
        };
    }

    /**
     * Route a `record_type: 'user'` row to a bubble or to a tool chip.
     *
     * Inputs:
     *   nodes (Array) - accumulator, mutated.
     *   message (object) - the row.
     *   chipsByToolUseId (object) - chips seen so far in this window.
     * Output: void.
     */
    function appendUserRow(nodes, message, chipsByToolUseId) {
        if (!message.has_tool_result) {
            nodes.push({
                kind: NODE_USER,
                seq: message.seq_in_file,
                text: message.text_content || '',
                truncated: !!message.text_truncated,
                when: message.timestamp || null,
                message: message
            });
            return;
        }
        var chip = chipsByToolUseId[message.tool_result_id];
        if (chip) {
            chip.result = message;
            chip.durationMs = Model.durationBetween(chip.when, message.timestamp);
            return;
        }
        // The tool call that produced this result is above the loaded
        // window (or the pairing column is absent on this row). It is
        // reported as an orphan result rather than shown as something the
        // user typed, and rather than dropped.
        nodes.push({
            kind: NODE_CHIP,
            seq: message.seq_in_file,
            toolUseId: message.tool_result_id || null,
            when: message.timestamp || null,
            progress: 0,
            durationMs: null,
            result: message,
            orphanResult: true,
            message: message
        });
    }

    /**
     * Route a `record_type: 'assistant'` row to a bubble, chips, or both.
     *
     * A single assistant record can carry prose, tool calls, or both, so
     * this is not an either/or: the text becomes a bubble and each
     * `tool_use_id` becomes its own chip, in that order.
     *
     * Inputs:
     *   nodes (Array) - accumulator, mutated.
     *   message (object) - the row.
     *   chipsByToolUseId (object) - mutated with each chip created, so a
     *     later tool_result row can find its chip.
     * Output: void.
     */
    function appendAssistantRow(nodes, message, chipsByToolUseId) {
        var text = (message.text_content || '').trim();
        if (text) {
            nodes.push({
                kind: NODE_ASSISTANT,
                seq: message.seq_in_file,
                text: message.text_content,
                truncated: !!message.text_truncated,
                when: message.timestamp || null,
                message: message
            });
        }
        if (!message.has_tool_use) {
            // An assistant record with no text and no tool call is not
            // nothing. 1,178 of session 9725's 4,035 assistant records are
            // this shape (measured 2026-08-18): extended-thinking blocks,
            // whose content is in the raw record and NOT in
            // `text_content`, which the thread query does not return.
            // Rendering nothing for them would silently drop 29% of one
            // side of the conversation and the thread would look complete
            // while a third of it was missing. It gets a thin marker that
            // says what is absent and why.
            if (!text) nodes.push(emptyTurnNode(message));
            return;
        }
        var ids = (message.tool_use_ids && message.tool_use_ids.length)
            ? message.tool_use_ids
            : [null];
        ids.forEach(function (toolUseId) {
            var chip = {
                kind: NODE_CHIP,
                seq: message.seq_in_file,
                toolUseId: toolUseId,
                when: message.timestamp || null,
                progress: ids.length === 1 ? (message.folded_progress_count || 0) : 0,
                durationMs: null,
                result: null,
                orphanResult: false,
                message: message
            };
            if (toolUseId) chipsByToolUseId[toolUseId] = chip;
            nodes.push(chip);
        });
    }

    /**
     * Build the marker for an assistant turn with nothing readable in it.
     *
     * Inputs: message (object).
     * Output: object - a `note` node flagged `empty`, so the renderer can
     *   draw it as a thin line rather than as a record dump.
     */
    function emptyTurnNode(message) {
        return {
            kind: NODE_NOTE,
            seq: message.seq_in_file,
            recordType: RECORD_ASSISTANT,
            text: '',
            empty: true,
            emptyReason: 'no text stored for this turn (thinking or non-text content, '
                + 'held only in the raw record)',
            truncated: false,
            when: message.timestamp || null,
            message: message
        };
    }

    /**
     * Build the fallback node for a row that is not conversation.
     *
     * Inputs: message (object).
     * Output: object - a `note` node carrying its record type, so an
     *   unrecognised type renders as itself rather than as a bubble.
     */
    function noteNode(message) {
        return {
            kind: NODE_NOTE,
            seq: message.seq_in_file,
            recordType: message.record_type || 'unknown',
            text: message.text_content || '',
            truncated: !!message.text_truncated,
            when: message.timestamp || null,
            message: message
        };
    }

    window.HistoryNodes = {
        NODE_USER: NODE_USER,
        NODE_ASSISTANT: NODE_ASSISTANT,
        NODE_CHIP: NODE_CHIP,
        NODE_DIVIDER: NODE_DIVIDER,
        NODE_NOTE: NODE_NOTE,
        RECORD_USER: RECORD_USER,
        RECORD_ASSISTANT: RECORD_ASSISTANT,
        indexCompactions: indexCompactions,
        buildNodes: buildNodes
    };
})();
