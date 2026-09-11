/**
 * SlashCommandsBoot - fetch the slash command palette WITHOUT the
 * WebSocket waiting for it.
 *
 * WHAT WAS WRONG. Both session entry paths in app.js did this:
 *
 *     await window.SlashCommandsModal.init(callback, workingDir);
 *
 * directly above the line that connects the terminal. `init` makes TWO
 * server round trips - the starred-favourites row and the full grouped
 * palette - and the socket waited for both. The list is a property of
 * the SESSION'S AGENT, not of the socket: nothing in it is needed to
 * render a terminal, and nothing in the terminal is needed to render it.
 * Coupling them put two fetches on the critical path between a click and
 * a connected pane, in a phase whose warm-switch target is 200 ms for the
 * whole interaction.
 *
 * SO IT IS STARTED, NEVER AWAITED. The caller fires this and carries on
 * to the connect; the palette appears whenever it appears, which is
 * exactly the guarantee a command list needs.
 *
 * AND IT CARRIES THE NAVIGATION TOKEN, because "arrives whenever it
 * arrives" and "arrives into whatever screen is on by then" are different
 * things. A palette fetched for session A that lands after the user has
 * moved to session B would populate B's menu with A's agent's commands,
 * and a slash command run in the wrong pane RUNS A COMMAND. A stale
 * result is DISCARDED, silently, which is what navigation-generation.js's
 * whole vocabulary means.
 *
 * ONE FETCH PER DIRECTORY, NOT ONE PER ENTRY. The palette is scoped to
 * the project's working directory, so re-entering the same session, or a
 * second session in the same project, must not re-fetch it. A DIFFERENT
 * directory must, because the command set genuinely differs - project
 * commands and skills are discovered under it. `_loadedFor` is what tells
 * those two apart, and it is set only on SUCCESS: a failed fetch must
 * leave the next entry free to try again rather than caching the failure
 * as an answer.
 *
 * A SECOND CALL WHILE ONE IS IN FLIGHT JOINS IT rather than starting a
 * parallel fetch. Two inits racing would have two callbacks writing one
 * `projectPath`, and the loser would decide which commands the panel
 * shows.
 *
 * Loaded as a plain script, no build step. Exposes
 * `window.SlashCommandsBoot`.
 */

console.log('[SlashCommandsBoot Module] Loading...');

(function (global) {
    'use strict';

    /** @type {string|null} The directory the loaded palette belongs to. */
    var loadedFor = null;

    /** @type {string|null} The directory an in-flight fetch is for. */
    var loadingFor = null;

    /** @type {Promise|null} The in-flight fetch, so a second call can join. */
    var inFlight = null;

    /**
     * Description: what a picked command does. Declared here rather than
     *   passed in by each caller, because both entry paths had a copy of
     *   it and two copies of "which pane does this run in" is exactly the
     *   question terminal-input-ownership.js exists to answer once.
     * Inputs: command (string) - the bare command, e.g. '/clear'.
     *   ticket (object) - ownership claimed when the PANEL OPENED. The
     *   panel survives a session switch, so a pick made after one would
     *   otherwise run in the pane the user left.
     * Output: void.
     */
    function insert(command, ticket) {
        if (global.TerminalController) {
            global.TerminalController.insertText(command, ticket);
        }
    }

    /**
     * Description: make sure the palette exists for this session, and
     *   show its control, WITHOUT blocking the caller. Safe to call on
     *   every session entry.
     * Inputs:
     *   workingDir (string|null) - the project directory the commands are
     *     scoped to. Null is a legitimate value (no project open) and is
     *     its own cache key, distinct from any directory.
     *   nav (number|null) - the caller's navigation token, captured at the
     *     gesture. A result landing after this is superseded is dropped.
     * Output: void. Deliberately NOT a promise: returning one invites a
     *   caller to await it, which is the defect this module removes.
     * Example:
     *   SlashCommandsBoot.start(session && session.working_dir, nav);
     */
    function start(workingDir, nav) {
        var modal = global.SlashCommandsModal;
        if (!modal) return;
        var dir = workingDir || null;

        // Already loaded for this directory: nothing to fetch, just show.
        if (modal.button && loadedFor === dir) {
            showIfCurrent(nav);
            return;
        }

        // A fetch for this same directory is already running. Join it
        // rather than racing a second one against it.
        if (inFlight && loadingFor === dir) {
            inFlight.then(function () { showIfCurrent(nav); });
            return;
        }

        // Called SYNCHRONOUSLY, not from a .then(). The whole point is
        // that the fetch is off the connect's critical path, not that it
        // starts a microtask later than it could.
        loadingFor = dir;
        var started;
        try {
            started = Promise.resolve(modal.init(insert, dir));
        } catch (err) {
            // A synchronous throw out of init is a broken palette, never
            // a broken session.
            loadingFor = null;
            console.warn('[slash-commands] palette could not be started', err);
            return;
        }
        inFlight = started
            .then(function () {
                loadedFor = dir;
            })
            .catch(function (err) {
                // NOT cached as an answer. The palette is a convenience;
                // a failed fetch must leave the next entry free to retry,
                // and must never stop a session opening.
                loadedFor = null;
                console.warn('[slash-commands] palette unavailable for now', err);
            })
            .then(function () {
                inFlight = null;
                loadingFor = null;
                showIfCurrent(nav);
            });
    }

    /**
     * Description: show the control, but only if the navigation that
     *   asked for it is still the one on screen.
     * Inputs: nav (number|null) - the caller's token. Null means the
     *   caller declared no navigation, which is treated as current: not
     *   having looked is not evidence of staleness, the same asymmetry
     *   Terminal#_navCurrent uses.
     * Output: void.
     */
    function showIfCurrent(nav) {
        var modal = global.SlashCommandsModal;
        if (!modal || typeof modal.show !== 'function') return;
        var gen = global.NavigationGeneration;
        if (gen && nav != null && !gen.isCurrent(nav)) {
            console.debug('[slash-commands] palette arrived after the user left');
            return;
        }
        modal.show();
    }

    /**
     * Description: what the module currently holds. Diagnostics and tests
     *   only.
     * Inputs: none.
     * Output: {loadedFor: string|null, loading: boolean}.
     */
    function state() {
        return { loadedFor: loadedFor, loading: inFlight !== null };
    }

    global.SlashCommandsBoot = {
        start: start,
        state: state
    };
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[SlashCommandsBoot Module] Exported as window.SlashCommandsBoot');
