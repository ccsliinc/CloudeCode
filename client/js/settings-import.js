/**
 * The one-time "import settings from this browser" control, with its preview.
 *
 * NOTHING IS UPLOADED WITHOUT A PRESS, ON ANY PATH. This module has no
 * load hook, no reconnect hook and no hydration hook. `mount` fetches
 * STATE, which tells it whether the install has already been imported;
 * only then does it read this browser at all, and it reads it to build a
 * PREVIEW, which the server plans and writes nothing for. The commit
 * happens on a click and nowhere else. That is the whole design: an
 * automatic migration means the last browser to connect wins, and a
 * machine nobody has opened in three months would silently revert every
 * setting changed since.
 *
 * THE PREVIEW IS THE SAFETY CONTROL, SO IT SHOWS BOTH VALUES. For a
 * field the server already holds differently, the row shows what this
 * browser has, what the server has, and an unchecked box. Unchecked
 * means the SERVER WINS, which is the default and the direction that
 * cannot lose data the user has not looked at. The commit sends the same
 * candidates and the same selections the preview was built from, and the
 * server rebuilds the plan with the same function, so what is shown is
 * what is done.
 *
 * AN UNAVAILABLE CONTROL EXPLAINS ITSELF RATHER THAN DISAPPEARING. Three
 * states have no import to offer - already imported, nothing recognised
 * in this browser, and everything already matching the server - and each
 * renders a disabled button with the reason beside it. Hiding the
 * control would leave a user looking for something they had been told
 * exists. That is this codebase's convention for an unavailable action,
 * the same one the session row menu follows.
 *
 * THE LOCAL VALUES ARE NEVER CLEARED. Not before the commit, not after
 * it. Browser storage is the fallback every bridged control still reads
 * when the server cannot be reached, and #46's rule is explicit: retain
 * the local source until the server confirms. There is no "and then tidy
 * up" step, because the tidying is what loses a user's settings on the
 * one request that failed.
 */

console.log('[SettingsImport Module] Loading...');

(function () {
    const STATE_ENDPOINT = '/settings/import/state';
    const PREVIEW_ENDPOINT = '/settings/import/preview';
    const COMMIT_ENDPOINT = '/settings/import';

    /** Outcomes the server names for each field. Mirrors settings_import.py. */
    const IMPORTED = 'imported';
    const IDENTICAL = 'identical';
    const CONFLICT_KEPT = 'conflict_kept';
    const CONFLICT_OVERRIDDEN = 'conflict_overridden';
    const REJECTED_INVALID = 'rejected_invalid';
    const REFUSED = 'refused';

    /** What each outcome says on the row, in this app's lowercase voice. */
    const OUTCOME_WORDS = {
        [IMPORTED]: 'will be imported',
        [IDENTICAL]: 'already matches',
        [CONFLICT_KEPT]: 'the server value is kept',
        [CONFLICT_OVERRIDDEN]: 'will replace the server value',
        [REJECTED_INVALID]: 'not a value this server accepts',
        [REFUSED]: 'never imported',
    };

    /** Plain names for the fields, so a row is readable without the schema. */
    const FIELD_WORDS = {
        theme: 'theme',
        audio_enabled: 'sound on or off',
        audio_master_volume: 'sound volume',
        launch_last_model: 'last model chosen',
        sidebar_density: 'sidebar density',
        sidebar_arrangement: 'sidebar pins and order',
        sidebar_pinned: 'sidebar docked',
        config_editor_pinned: 'file drawer docked',
        config_editor_collapsed: 'file tree folds',
        launchpad_collapsed: 'home screen folds',
    };

    let held = null;

    function escapeHtml(str) {
        return String(str === null || str === undefined ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * Render a stored value in one short readable line.
     *
     * Description: objects are summarised by size rather than dumped, so
     *   a row stays one line and a sidebar arrangement holding 200 names
     *   does not fill the panel. The user is choosing between two
     *   SOURCES here, not auditing two structures.
     * Inputs: value (*).
     * Output: string - already escaped.
     */
    function describe(value) {
        if (value === null || value === undefined) return '<em>not set</em>';
        if (typeof value === 'boolean') return value ? 'on' : 'off';
        if (typeof value === 'number') return escapeHtml(String(value));
        if (typeof value === 'string') {
            return value === '' ? '<em>none</em>' : escapeHtml(value);
        }
        if (Array.isArray(value)) return escapeHtml(value.length + ' entries');
        const keys = Object.keys(value);
        return escapeHtml(keys.length + ' entries');
    }

    function fieldWord(field) {
        return escapeHtml(FIELD_WORDS[field] || field);
    }

    /**
     * Mount the control into a settings slot.
     *
     * Description: fetches state FIRST, so a browser on an
     *   already-imported install never collects anything. Fire and
     *   forget; every failure renders an explanation in place rather
     *   than rejecting into the settings panel's mount pass.
     * Inputs: slot (Element) - the container to render into.
     * Output: undefined.
     * Example: SettingsImport.mount(document.querySelector('#slot'));
     */
    function mount(slot) {
        if (!slot) return;
        slot.innerHTML = shell('<div class="settings-field-hint">reading...</div>');
        refresh(slot);
    }

    async function refresh(slot) {
        const client = globalThis.api;
        if (!client || typeof client.call !== 'function') {
            render(slot, unavailable('the server is not reachable from this page.'));
            return;
        }
        let state;
        try {
            state = await client.call(STATE_ENDPOINT);
        } catch (err) {
            // Deliberately swallowed into an explanation: settings must
            // still open when one panel cannot read its own state.
            console.warn('[SettingsImport] state read failed', err);
            render(slot, unavailable('could not read whether this install has been imported.'));
            return;
        }

        if (state && state.completed) {
            render(slot, completed(state));
            return;
        }

        const collector = globalThis.SettingsImportCollect;
        if (!collector) {
            render(slot, unavailable('this page did not load the settings reader.'));
            return;
        }
        const candidates = collector.collect(globalThis.localStorage, state.importable);
        if (!Object.keys(candidates).length) {
            render(slot, unavailable(
                'this browser has no saved settings to import. that is normal for '
                + 'a browser you have not used the app in before.'
            ));
            return;
        }

        let preview;
        try {
            preview = await client.call(PREVIEW_ENDPOINT, {
                method: 'POST',
                expectedStatuses: [409],
                body: { candidates: candidates, selections: [] },
            });
        } catch (err) {
            console.warn('[SettingsImport] preview failed', err);
            render(slot, unavailable('could not work out what this import would change.'));
            return;
        }

        held = { candidates: candidates, preview: preview, revision: preview.revision };
        render(slot, previewHtml(preview));
        wire(slot);
    }

    function shell(inner) {
        return (
            '<section class="settings-section" data-settings-section="settings-import">'
            + '  <h3 class="settings-section-title">import settings from this browser</h3>'
            + '  <div class="settings-section-description">'
            + '    settings used to be saved in each browser. this moves the ones this '
            + '    browser holds onto the server once, so every device reads the same '
            + '    values. it runs once for this install and nothing is sent until you '
            + '    press import.'
            + '  </div>'
            + inner
            + '</section>'
        );
    }

    function render(slot, inner) {
        slot.innerHTML = shell(inner);
    }

    function unavailable(reason) {
        // Disabled and explained, never hidden. A control that vanishes
        // leaves the user hunting for something they were told exists.
        return (
            '<div class="settings-field-hint">' + escapeHtml(reason) + '</div>'
            + '<button type="button" class="modal-btn modal-btn-secondary" '
            + 'data-settings-import="commit" disabled '
            + 'aria-describedby="settings-import-reason">nothing to import</button>'
        );
    }

    function completed(state) {
        const when = state.completed_at
            ? escapeHtml(String(state.completed_at))
            : 'earlier';
        const fields = (state.imported_fields || []).length;
        return (
            '<div class="settings-field-hint">'
            + 'already imported on this install, ' + when + ', carrying '
            + escapeHtml(String(fields)) + ' setting' + (fields === 1 ? '' : 's') + '. '
            + 'it runs once on purpose: a browser you have not opened in months could '
            + 'otherwise upload its old copy and quietly undo everything changed since. '
            + 'ordinary changes save to the server from now on with no extra step.'
            + '</div>'
            + '<button type="button" class="modal-btn modal-btn-secondary" '
            + 'data-settings-import="commit" disabled>already imported</button>'
        );
    }

    function previewHtml(preview) {
        const rows = (preview.fields || []).map(rowHtml).join('');
        const summary = preview.summary || {};
        const willWrite = (summary[IMPORTED] || 0) + (summary[CONFLICT_OVERRIDDEN] || 0);
        const conflicts = summary[CONFLICT_KEPT] || 0;
        const lines = [
            willWrite + ' setting' + (willWrite === 1 ? '' : 's') + ' will be imported',
        ];
        if (conflicts) {
            lines.push(conflicts + ' already set on the server and kept unless you tick it');
        }
        return (
            '<div class="settings-field-hint" data-settings-import="summary">'
            + escapeHtml(lines.join('. ')) + '.</div>'
            + '<div class="settings-import-rows">' + rows + '</div>'
            + '<button type="button" class="modal-btn modal-btn-primary" '
            + 'data-settings-import="commit"' + (willWrite ? '' : ' disabled')
            + '>' + (willWrite ? 'import these settings' : 'nothing to import') + '</button>'
            + '<div class="settings-field-hint" data-settings-import="status" role="status"></div>'
        );
    }

    function rowHtml(row) {
        const conflict = row.outcome === CONFLICT_KEPT
            || row.outcome === CONFLICT_OVERRIDDEN;
        const box = conflict
            ? ('<input type="checkbox" data-settings-import-field="'
                + escapeHtml(row.field) + '"'
                + (row.outcome === CONFLICT_OVERRIDDEN ? ' checked' : '')
                + ' aria-label="replace the server value for ' + fieldWord(row.field) + '">')
            : '';
        const values = conflict
            ? ('<span class="settings-import-value">this browser: ' + describe(row.candidate)
                + '</span> <span class="settings-import-value">server: '
                + describe(row.current) + '</span>')
            : ('<span class="settings-import-value">' + describe(row.candidate) + '</span>');
        const detail = row.detail
            ? '<div class="settings-field-hint">' + escapeHtml(row.detail) + '</div>'
            : '';
        return (
            '<div class="settings-import-row" data-settings-import-row="'
            + escapeHtml(row.field) + '">'
            + box
            + '<span class="settings-import-name">' + fieldWord(row.field) + '</span>'
            + values
            + '<span class="settings-import-outcome">'
            + escapeHtml(OUTCOME_WORDS[row.outcome] || row.outcome) + '</span>'
            + detail
            + '</div>'
        );
    }

    /**
     * Attach the slot's two delegated listeners, exactly once.
     *
     * Description: `render` replaces the slot's innerHTML but the slot
     *   ELEMENT survives, so a second `addEventListener` on it would not
     *   replace the first - it would stack. After one re-preview every
     *   tick would fire two requests and the import button would commit
     *   twice, which is the one action here that must happen at most
     *   once. The marker lives on the element rather than in module
     *   state because the module is a singleton and the slot is not.
     * Inputs: slot (Element).
     * Output: undefined.
     */
    function wire(slot) {
        if (slot.dataset && slot.dataset.settingsImportWired === '1') return;
        if (slot.dataset) slot.dataset.settingsImportWired = '1';
        slot.addEventListener('change', function (event) {
            const box = event.target.closest
                ? event.target.closest('[data-settings-import-field]') : null;
            if (!box) return;
            reprice(slot);
        });
        slot.addEventListener('click', function (event) {
            const btn = event.target.closest
                ? event.target.closest('[data-settings-import="commit"]') : null;
            if (!btn || btn.disabled) return;
            commit(slot, btn);
        });
    }

    /**
     * Re-plan through the SERVER when a selection changes.
     *
     * Description: the preview is re-fetched rather than adjusted in the
     *   browser. Recomputing it here would mean a second implementation
     *   of the plan, and the whole guarantee of this feature is that
     *   there is exactly one - the moment the displayed plan and the
     *   performed plan come from different code they can differ.
     * Inputs: slot (Element). Output: undefined.
     */
    async function reprice(slot) {
        if (!held) return;
        const selections = currentSelections(slot);
        const client = globalThis.api;
        if (!client || typeof client.call !== 'function') return;
        let preview;
        try {
            preview = await client.call(PREVIEW_ENDPOINT, {
                method: 'POST',
                expectedStatuses: [409],
                body: { candidates: held.candidates, selections: selections },
            });
        } catch (err) {
            console.warn('[SettingsImport] re-preview failed', err);
            return;
        }
        held.preview = preview;
        held.revision = preview.revision;
        render(slot, previewHtml(preview));
        wire(slot);
    }

    function currentSelections(slot) {
        const boxes = slot.querySelectorAll('[data-settings-import-field]');
        const out = [];
        for (let i = 0; i < boxes.length; i += 1) {
            if (boxes[i].checked) out.push(boxes[i].getAttribute('data-settings-import-field'));
        }
        return out;
    }

    async function commit(slot, btn) {
        if (!held) return;
        const statusEl = slot.querySelector('[data-settings-import="status"]');
        const selections = currentSelections(slot);
        btn.disabled = true;
        if (statusEl) statusEl.textContent = 'importing...';

        const client = globalThis.api;
        let body;
        try {
            body = await client.call(COMMIT_ENDPOINT, {
                method: 'POST',
                expectedStatuses: [409],
                body: {
                    candidates: held.candidates,
                    selections: selections,
                    expected_revision: held.revision,
                },
            });
        } catch (err) {
            // A 409 is another device having committed first, or the
            // install having been imported from elsewhere while this
            // panel was open. Both are answers, not faults: nothing was
            // written, this browser's own settings are untouched, and
            // re-reading is what resolves either.
            console.warn('[SettingsImport] import refused', err);
            if (statusEl) {
                statusEl.textContent = 'nothing was imported; this install changed '
                    + 'while the panel was open. your settings in this browser are '
                    + 'unchanged. reopening settings will show what is there now.';
            }
            btn.disabled = false;
            return;
        }

        const moved = Object.keys((body && body.changed) || {}).length;
        if (statusEl) {
            statusEl.textContent = moved
                ? ('imported ' + moved + ' setting' + (moved === 1 ? '' : 's')
                    + '. this browser keeps its own copy of everything it had.')
                : 'everything here already matched the server, so nothing changed.';
        }
        // Re-read the server's own state so what the panel says next is
        // what the server says, not what this browser assumed happened.
        refreshAfterCommit(slot);
    }

    function refreshAfterCommit(slot) {
        const previous = slot.querySelector('[data-settings-import="status"]');
        const message = previous ? previous.textContent : '';
        Promise.resolve(refresh(slot)).then(function () {
            const statusEl = slot.querySelector('[data-settings-import="status"]');
            if (statusEl && message) statusEl.textContent = message;
        }).catch(function (err) {
            console.warn('[SettingsImport] refresh after import failed', err);
        });
    }

    const api = {
        mount: mount,
        // Exported for tests and for a caller that wants the words
        // without the DOM.
        OUTCOME_WORDS: OUTCOME_WORDS,
        FIELD_WORDS: FIELD_WORDS,
    };

    globalThis.SettingsImport = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[SettingsImport Module] Loaded');
})();
