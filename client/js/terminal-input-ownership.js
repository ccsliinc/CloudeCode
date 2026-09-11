/**
 * TerminalInputOwnership - the ONE predicate every input path asks before
 * it writes bytes into a session.
 *
 * WHY THIS EXISTS. Terminal input arrives through several independent
 * paths and they did not agree on which session they were typing into.
 * The unambiguous case was the file paste: `terminal.js` intercepts the
 * paste, uploads the blob, and inserts the returned path. Nothing between
 * the upload starting and the insert happening checked that the user was
 * still in the session that was open when they pasted, so an upload that
 * finished after a session switch inserted a file path into a DIFFERENT
 * agent's prompt.
 *
 * Output in the wrong pane is confusing. INPUT in the wrong pane runs a
 * command. `bd9a2b2` fixed the output direction; this is the input one.
 *
 * CAPTURE AT THE GESTURE, CHECK AT THE WRITE. That is the whole
 * mechanism and it is the half that is easy to get backwards. A ticket
 * taken at COMPLETION time reads exactly like a check and is a no-op,
 * because by then the session HAS changed and the value you compare
 * against is itself. This codebase has shipped that shape before: the
 * `ensure_pipe_pane` guard whose only exercised caller set the flag it
 * checked, which 4874 green tests had never seen raise.
 *
 * A STALE TICKET DROPS. It never queues and never replays. The user
 * pasted an image intending it for the session they were in, and
 * delivering it later, out of context, into a conversation they have
 * since moved on from is not better than dropping it. So the drop is
 * REPORTED, through `Terminal#_showStatusPill` - which routes to
 * `FabMenu.notify`, the app's single status-pill path. A seventh toast
 * shape would be the bug, not the fix.
 *
 * WHICH PATHS TAKE A TICKET, AND WHICH DELIBERATELY DO NOT. A ticket is
 * for a path with an AWAIT, a network round trip, or an open panel
 * between the gesture and the write:
 *
 *   - the desktop file-paste interceptor (upload, then insert)
 *   - the attach-file picker's change handler (upload, then insert)
 *   - `pasteFromClipboard` (an async clipboard read, then insert)
 *   - the paste fallback sheet (open, the user types, then insert)
 *   - the slash commands modal (open, the user picks, then insert)
 *
 * The keyboard (`term.onData`), the Shift+Enter chord, the D-pad and
 * `_writeSynthetic` take NONE, because there is no await between the key
 * and `ws.send` - the socket is swapped synchronously by the session
 * entry paths, so the socket held at the write IS the session's. A check
 * there would cost a comparison, buy nothing, and tell the next reader
 * there was a race where there was none.
 *
 * The copy sheet (`copy-output.js`) takes none either, and that was
 * MEASURED rather than assumed: it reads the xterm buffer and writes to
 * the system clipboard, and never writes into the terminal at all.
 */

console.log('[TerminalInputOwnership Module] Loading...');

(function () {
    'use strict';

    /**
     * Description: capture ownership at the moment of the user gesture.
     *   Call synchronously inside the handler, BEFORE the first await.
     * Inputs: what (string) - the user-facing noun for whatever is being
     *   delivered ('paste', 'upload', 'command'), used in the drop
     *   message if this ticket goes stale.
     * Output: {nav: number|null, what: string} - opaque to the caller.
     * Example:
     *   const ticket = TerminalInputOwnership.claim('paste');
     *   const path = await upload(blob);
     *   if (!TerminalInputOwnership.deliver(term, ticket)) return;
     */
    function claim(what) {
        return {
            nav: window.NavigationGeneration
                ? window.NavigationGeneration.current()
                : null,
            what: what || 'input'
        };
    }

    /**
     * Description: may this ticket's bytes still be written?
     * Inputs: ticket (object|null) - from claim().
     * Output: boolean. TRUE when there is no ticket or no generation
     *   module: a path that took no ticket has declared it needs none,
     *   and a load-order accident must not stop the terminal accepting
     *   input. This guard exists to stop a WRONG write, never to become a
     *   new way for input to disappear.
     */
    function permits(ticket) {
        if (!ticket || ticket.nav == null) return true;
        if (!window.NavigationGeneration) return true;
        return window.NavigationGeneration.isCurrent(ticket.nav);
    }

    /**
     * Description: the guard as callers use it. Answers whether to write,
     *   and on a refusal TELLS THE USER through the terminal's own status
     *   pill rather than dropping their paste in silence.
     * Inputs: term (object) - the Terminal wrapper (for _showStatusPill).
     *   ticket (object|null) - from claim().
     * Output: boolean - true to proceed with the write.
     * Example: if (!TerminalInputOwnership.deliver(term, ticket)) return;
     */
    function deliver(term, ticket) {
        if (permits(ticket)) return true;
        var what = (ticket && ticket.what) || 'input';
        console.debug('[input] dropped ' + what + ' for a session the user left',
            { nav: ticket && ticket.nav });
        if (term && typeof term._showStatusPill === 'function') {
            term._showStatusPill(what + ' dropped, you changed sessions', 'info');
        }
        return false;
    }

    window.TerminalInputOwnership = {
        claim: claim,
        permits: permits,
        deliver: deliver
    };
})();

console.log('[TerminalInputOwnership Module] Exported as window.TerminalInputOwnership');
