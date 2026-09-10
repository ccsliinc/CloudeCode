/**
 * Session row ACTION MENU - what each of the five items actually does.
 * ----------------------------------------------------------------------
 * The definition and markup are next door in client/js/session-row-menu.js;
 * opening, focus and the keyboard are in
 * client/js/session-row-menu-open.js. This file is the seam between the
 * menu and the modules that already own each operation.
 *
 * THE MENU ADDS NO BEHAVIOUR OF ITS OWN, WITH ONE EXCEPTION. Rename,
 * fork, new-session-in-folder and close all hand straight over to the
 * flow that already performs them, so the menu is a second way to reach
 * an existing path rather than a second implementation of it. Mute is
 * the exception: nothing else in the client speaks to
 * ``PATCH /sessions/records/{session_uuid}/notifications``, so the
 * request lives here.
 *
 * EVERY ACTION RUNS AGAINST A CAPTURED CONTEXT, never against the DOM as
 * it stands when the promise resolves. The row that opened this menu may
 * have been repainted, reordered or replaced by the time an await comes
 * back - the sidebar rewrites its whole list every five seconds - so the
 * name, id and label are the ones frozen at open time.
 *
 * A NAVIGATION TOKEN GUARDS THE TWO ITEMS THAT OPEN SOMETHING. Fork and
 * new-session-in-folder both create a session and then put the user in
 * it, and creation is slow enough that a user can go somewhere else
 * first. ``navToken()`` is bumped by every navigation this app announces
 * (``session-created``, ``popstate``, ``hashchange``), captured before
 * the create, and compared after: a mismatch means the user has moved
 * on, so the CHILD IS STILL CREATED - it exists on the server and
 * throwing it away would be worse - and simply not opened. The user is
 * told where it went rather than yanked out of whatever they are now in.
 *
 * THE STORED RECORD IS READ ONLY WHEN AN ITEM NEEDS IT. Two facts are
 * not on any live payload: the session's durable ``session_uuid`` (mute
 * is keyed on it) and its recorded ``working_dir``. Both are read from
 * ``GET /sessions/records`` at ACTIVATION time, so opening the menu
 * still costs no request at all.
 *
 * Load AFTER session-row-menu.js and api.js, BEFORE
 * session-row-menu-open.js.
 */

console.log('[SessionRowMenuActions Module] Loading...');

(function () {
    'use strict';

    /**
     * Bumped by every navigation the app announces. Captured before a
     * create and compared after it, so a fork that finishes late cannot
     * pull a user out of the session they moved to.
     * @type {number}
     */
    var navSeq = 0;

    ['session-created', 'popstate', 'hashchange'].forEach(function (evt) {
        window.addEventListener(evt, function () { navSeq += 1; });
    });

    /**
     * Description: the current navigation token.
     * Inputs: none. Output: number.
     */
    function navToken() { return navSeq; }

    /**
     * Description: say something to the user that is not a dialog. Routes
     *   to the surface's own error channel so a launchpad message lands
     *   where launchpad messages land, and falls back to the console
     *   rather than to an alert that would steal focus from an open menu.
     * Inputs: ctx (object) - the captured context. text (string).
     * Output: void.
     */
    function say(ctx, text) {
        var lp = window.Launchpad;
        if (lp && typeof lp.showError === 'function') { lp.showError(text); return; }
        console.warn('[SessionRowMenu]', text);
    }

    /**
     * Description: the live DOM row for a captured name, on whichever
     *   surface the menu was opened from. Used ONLY by items that must
     *   hand an element to a flow that takes one (the two inline rename
     *   editors seed themselves off the row's own name node). Identity
     *   still comes from the captured context: this resolves by that
     *   captured name and never re-derives it.
     * Inputs: ctx (object). Output: Element|null.
     */
    function rowElementFor(ctx) {
        if (!ctx || !ctx.name || typeof document.querySelector !== 'function') return null;
        var sel = ctx.surface === 'launchpad'
            ? '.running-session-row[data-name="' + CSS.escape(ctx.name) + '"]'
            : '.session-sidebar-row[data-name="' + CSS.escape(ctx.name) + '"]';
        return document.querySelector(sel);
    }

    /**
     * Description: the stored session record for a tmux name, or null.
     *
     *   NEWEST WINS AND ARCHIVED ROWS ARE SKIPPED. A tmux name is
     *   reusable, so several rows can carry it and only the most recent
     *   describes the session on screen; ``tmux_created_epoch`` is what
     *   orders them, and a row with no epoch loses to one that has an
     *   epoch rather than being treated as new.
     * Inputs: tmuxName (string).
     * Output: Promise<object|null> - a SessionRecord, or null when the
     *   listing could not be read or held no live row for that name.
     */
    async function recordFor(tmuxName) {
        if (!tmuxName || !window.API
            || typeof window.API.listSessionRecords !== 'function') return null;
        var rows;
        try {
            rows = await window.API.listSessionRecords();
        } catch (err) {
            console.error('[SessionRowMenu] could not read session records:', err);
            return null;
        }
        if (!Array.isArray(rows)) return null;
        var best = null;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r || r.tmux_name !== tmuxName) continue;
            if (r.archived_at) continue;
            if (!best) { best = r; continue; }
            var a = typeof r.tmux_created_epoch === 'number' ? r.tmux_created_epoch : -1;
            var b = typeof best.tmux_created_epoch === 'number'
                ? best.tmux_created_epoch : -1;
            if (a > b) best = r;
        }
        return best;
    }

    /**
     * Description: open the inline rename editor for this row, on the
     *   surface it lives on. Both editors seed themselves off the row's
     *   own name node, which is why each is handed the element rather
     *   than a string - handing them a name is what once made a plain
     *   Enter overwrite the user's label with the tmux handle.
     * Inputs: ctx (object). Output: Promise<void>.
     */
    async function runRename(ctx) {
        var rowEl = rowElementFor(ctx);
        if (!rowEl) {
            say(ctx, 'cannot rename "' + (ctx.label || ctx.name)
                + '": its row is no longer on screen');
            return;
        }
        if (ctx.surface === 'launchpad') {
            var lp = window.Launchpad;
            if (!lp || typeof lp._handleRenameRunningSession !== 'function') return;
            lp._handleRenameRunningSession(rowEl, ctx.sessionId);
            return;
        }
        if (window.SessionSidebarRename
            && typeof window.SessionSidebarRename.beginEdit === 'function') {
            window.SessionSidebarRename.beginEdit(rowEl);
        }
    }

    /**
     * Description: fork this conversation into a NEW session and open it.
     *
     *   The parent is not touched. A 409 means the session has no
     *   recorded Claude conversation to branch, which is a REFUSAL and is
     *   reported as one - forking anyway would start a fresh conversation
     *   wearing a fork label and the user would believe they had branched
     *   their work.
     *
     *   The child is opened only while the navigation that asked for it
     *   is still current. Otherwise it stays created and unopened, and
     *   the user is told so by name.
     * Inputs: ctx (object). Output: Promise<void>.
     */
    async function runFork(ctx) {
        if (!ctx.name) { say(ctx, 'cannot fork: this row carries no session name'); return; }
        var token = navToken();
        var result;
        try {
            result = await window.API.forkSession(ctx.name);
        } catch (error) {
            var status = error && error.status;
            if (status === 409) {
                say(ctx, 'cannot fork: this session has no claude conversation yet, '
                    + 'so there is nothing to branch from');
            } else {
                console.error('[SessionRowMenu] fork failed:', error);
                say(ctx, 'failed to fork session: '
                    + ((error && error.message) || 'the server could not be reached'));
            }
            return;
        }
        if (result && result.lineage_recorded === false) {
            say(ctx, result.detail
                || 'forked, but the link back to the parent was not recorded');
        }
        var child = result && result.session;
        if (!child) {
            say(ctx, 'the fork was accepted but the server named no new session, '
                + 'so nothing was opened');
            return;
        }
        openChild(ctx, child, token, 'the fork of "' + (ctx.label || ctx.name) + '"');
    }

    /**
     * Description: start a new session in the folder this row records,
     *   through the SAME provider/wrapper picker the home screen opens
     *   for a project. The folder comes from the stored record, so a
     *   session started this way lands where the original one lives
     *   rather than in a directory derived from its name.
     *
     *   A record that cannot be read, or one carrying no ``working_dir``,
     *   REFUSES and says which. Falling back to a default directory would
     *   silently create the session somewhere the user did not choose,
     *   which is the defect ``project_directory.py`` exists to prevent.
     * Inputs: ctx (object). Output: Promise<void>.
     */
    async function runNewInFolder(ctx) {
        var lp = window.Launchpad;
        if (!lp || typeof lp.selectProject !== 'function') {
            say(ctx, 'cannot start a session here: the launcher did not load');
            return;
        }
        var record = await recordFor(ctx.name);
        if (!record) {
            say(ctx, 'CANNOT DETERMINE the folder for "' + (ctx.label || ctx.name)
                + '": no stored record for it could be read, so nothing was started');
            return;
        }
        if (!record.working_dir) {
            say(ctx, '"' + (ctx.label || ctx.name) + '" records no folder, so there is '
                + 'nowhere to start a session. nothing was started');
            return;
        }
        await lp.selectProject({
            name: record.title || ctx.label || ctx.name,
            path: record.working_dir,
        });
    }

    /**
     * Description: turn notification suppression on or off for this
     *   session, and keep the label honest while the request is in
     *   flight.
     *
     *   OPTIMISTIC, WITH A ROLLBACK. The label flips before the request
     *   is sent, because the menu's whole promise is that it answers
     *   immediately; if the write fails the override is put back exactly
     *   as it was and the user is told, so the screen never keeps a claim
     *   the server refused.
     * Inputs: ctx (object). Output: Promise<void>.
     */
    async function runToggleMute(ctx) {
        var menu = window.SessionRowMenu;
        var was = !!ctx.muted;
        var want = !was;
        if (menu) menu.setMuteOverride(ctx.name, want);
        var record = await recordFor(ctx.name);
        if (!record || !record.session_uuid) {
            if (menu) menu.setMuteOverride(ctx.name, was);
            say(ctx, 'CANNOT DETERMINE which stored record "' + (ctx.label || ctx.name)
                + '" belongs to, so its notifications were NOT changed');
            return;
        }
        try {
            var res = await window.API.call(
                '/sessions/records/' + encodeURIComponent(record.session_uuid)
                + '/notifications',
                { method: 'PATCH', body: { muted: want } }
            );
            // THE SERVER'S ANSWER WINS over what was asked for. It
            // returns the state it now holds, and a write that landed
            // differently than requested must show what is true rather
            // than what was intended.
            if (menu && res && typeof res.muted === 'boolean') {
                menu.setMuteOverride(ctx.name, res.muted);
            }
        } catch (error) {
            if (menu) menu.setMuteOverride(ctx.name, was);
            console.error('[SessionRowMenu] mute write failed:', error);
            say(ctx, 'could not ' + (want ? 'mute' : 'unmute') + ' "'
                + (ctx.label || ctx.name) + '": '
                + ((error && error.message) || 'the server could not be reached')
                + '. nothing was changed');
        }
        repaintSurface(ctx);
    }

    /**
     * Description: close this session, through the confirmation and
     *   teardown each surface already runs. Nothing new is confirmed
     *   here and no third destruction path is invented.
     * Inputs: ctx (object). Output: Promise<void>.
     */
    async function runClose(ctx) {
        var actions = window.SessionRowActions;
        if (!actions) {
            console.error('[SessionRowMenu] SessionRowActions missing, refusing to act');
            return;
        }
        if (ctx.surface === 'launchpad') {
            var lp = window.Launchpad;
            if (!lp || typeof lp._handleSessionRowAction !== 'function') return;
            await lp._handleSessionRowAction(ctx.name, ctx.sessionId, actions.ACTION_CLOSE);
            return;
        }
        var clicks = window.SessionSidebarClicks;
        if (!clicks) return;
        // A DETACHED BUTTON CARRYING THE CAPTURED IDENTITY, not the one
        // on the row. ``onRowActionClick`` reads the name and the action
        // back off the element it is given, and resolves the row by that
        // name when ``closest`` finds nothing - which is exactly the
        // shape this is. Handing it the row's own control instead would
        // re-read whatever the last repaint left there.
        var btn = document.createElement('button');
        btn.setAttribute(actions.ATTR_ACTION, actions.ACTION_CLOSE);
        btn.setAttribute(actions.ATTR_NAME, ctx.name);
        await clicks.onRowActionClick(window.SessionSidebar, btn);
    }

    /**
     * Description: put the user into a freshly created session, but only
     *   while the navigation that asked for it is still current.
     * Inputs: ctx (object), child (object) - the new Session.
     *   token (number) - navToken() as read before the create.
     *   what (string) - how to name the child if it is not opened.
     * Output: void.
     */
    function openChild(ctx, child, token, what) {
        if (navToken() !== token) {
            say(ctx, what + ' was created and left where it is: you moved to another '
                + 'session while it was being made, so nothing was switched');
            return;
        }
        window.dispatchEvent(new CustomEvent('session-created', {
            detail: { session: child },
        }));
    }

    /**
     * Description: ask the surface the menu was opened on to repaint, so
     *   a label this menu changed appears on the row too. Both surfaces
     *   skip a repaint whose signature is unchanged, so the cached
     *   signature is cleared first.
     * Inputs: ctx (object). Output: void.
     */
    function repaintSurface(ctx) {
        if (ctx.surface === 'launchpad') {
            var lp = window.Launchpad;
            if (lp && typeof lp.renderRunningSessions === 'function') {
                lp._lastRunningSig = null;
                lp.renderRunningSessions();
            }
            return;
        }
        var bar = window.SessionSidebar;
        if (bar && typeof bar.repaint === 'function') {
            bar._lastSig = null;
            bar.repaint();
        }
    }

    /**
     * Description: run one item against one captured context. THE single
     *   entry point the open module calls, so there is one table mapping
     *   an item id to what it does.
     * Inputs: itemId (string), ctx (object).
     * Output: Promise<void>.
     */
    async function run(itemId, ctx) {
        if (!ctx) return;
        if (itemId === 'rename') return runRename(ctx);
        if (itemId === 'fork') return runFork(ctx);
        if (itemId === 'new-in-folder') return runNewInFolder(ctx);
        if (itemId === 'mute') return runToggleMute(ctx);
        if (itemId === 'close') return runClose(ctx);
    }

    window.SessionRowMenuActions = {
        run: run,
        navToken: navToken,
        recordFor: recordFor,
        rowElementFor: rowElementFor,
        runRename: runRename,
        runFork: runFork,
        runNewInFolder: runNewInFolder,
        runToggleMute: runToggleMute,
        runClose: runClose,
        repaintSurface: repaintSurface,
    };
})();

console.log('[SessionRowMenuActions Module] Exported as window.SessionRowMenuActions');
