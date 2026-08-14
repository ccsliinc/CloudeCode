/**
 * AgentWrappersPanel — wrapper list/editor mounted inside the settings
 * panel's "agent" section (client/js/settings-panel.js), replacing the
 * old fixed claude_command text field with full CRUD over
 * ``agents.wrappers`` (feat/launch-wrappers).
 *
 * Unlike the rest of settings-panel.js's generic fields (which batch into
 * one Save button), every wrapper action here writes immediately via its
 * own API call and re-renders — same "applies immediately" contract the
 * appearance/theme section already uses, because add/edit/delete/set-
 * default are each already a complete, independent server-side mutation
 * (see Settings.add_wrapper et al in src/config.py) with no partial state
 * a batched Save could usefully defer.
 *
 * Split into its own file (not folded into settings-panel.js) to keep
 * that file under the repo's 500-line budget. Must load AFTER api.js
 * (window.API) and BEFORE settings-panel.js calls
 * ``window.AgentWrappersPanel.mount()``.
 */
(function () {
    'use strict';

    var wrappers = [];
    var examples = null; // lazy-loaded, null = not fetched yet
    var rootEl = null;
    var editingId = null; // wrapper id currently open in the inline editor, or '__new__'

    /**
     * Escape a string for safe interpolation into innerHTML-built markup.
     * Inputs: str (any). Output: string.
     */
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    /**
     * Render the whole wrappers section (list + inline editor when open).
     * Output: string - HTML for the `.settings-section`.
     */
    function renderSection() {
        var rows = wrappers.map(renderRow).join('');
        var editorHtml = editingId ? renderEditor() : '';
        var addBtn = editingId
            ? ''
            : (
                '<div class="settings-wrapper-actions-row">' +
                '  <button type="button" class="modal-btn modal-btn-secondary" id="wrapper-add-btn">+ add wrapper</button>' +
                '  <button type="button" class="modal-btn modal-btn-secondary" id="wrapper-import-btn">import example</button>' +
                '</div>'
            );
        return (
            '<section class="settings-section" data-settings-section="wrappers">' +
            '  <h3 class="settings-section-title">launch wrappers</h3>' +
            '  <div class="settings-section-description">' +
            '    named shell commands used to launch claude — pick one at launch time, ' +
            '    or set a default. replaces a single hardcoded command with as many as you want.' +
            '  </div>' +
            '  <div class="settings-warning settings-wrapper-security-note">' +
            '    a wrapper is a shell command. never paste a token or password into it — read secrets ' +
            '    from the macOS Keychain at run time instead (the example \'cld\' wrapper below shows the pattern).' +
            '  </div>' +
            '  <div class="settings-wrapper-list" id="wrapper-list">' + (rows || '<div class="settings-field-hint">no wrappers configured — using the claude_command / cld fallback below.</div>') + '</div>' +
            editorHtml +
            addBtn +
            '</section>'
        );
    }

    /**
     * Render one wrapper's summary row.
     * Inputs: w (object) - AgentWrapper-shaped dict.
     * Output: string.
     */
    function renderRow(w) {
        var badge = w.default ? '<span class="settings-wrapper-badge">default</span>' : '';
        var entryNote = w.entry ? (' &middot; entry: <code>' + escapeHtml(w.entry) + '</code>') : '';
        return (
            '<div class="settings-wrapper-row" data-wrapper-id="' + escapeHtml(w.id) + '">' +
            '  <div class="settings-wrapper-row-main">' +
            '    <strong>' + escapeHtml(w.label) + '</strong> <code>' + escapeHtml(w.id) + '</code> ' + badge +
            '    <div class="settings-field-hint">' + escapeHtml(w.description || '') + entryNote + '</div>' +
            '  </div>' +
            '  <div class="settings-wrapper-row-actions">' +
            '    <button type="button" class="modal-btn modal-btn-secondary" data-wrapper-action="edit" data-wrapper-id="' + escapeHtml(w.id) + '">edit</button>' +
            (w.default ? '' : '    <button type="button" class="modal-btn modal-btn-secondary" data-wrapper-action="default" data-wrapper-id="' + escapeHtml(w.id) + '">set default</button>') +
            '    <button type="button" class="modal-btn modal-btn-danger" data-wrapper-action="delete" data-wrapper-id="' + escapeHtml(w.id) + '">delete</button>' +
            '  </div>' +
            '</div>'
        );
    }

    /**
     * Render the inline add/edit editor form. ``editingId`` selects which
     * wrapper is being edited, or the sentinel '__new__' for a blank form.
     * Output: string.
     */
    function renderEditor() {
        var isNew = editingId === '__new__';
        var w = isNew
            ? { id: '', label: '', script: '', entry: '', description: '', default: wrappers.length === 0 }
            : (wrappers.find(function (x) { return x.id === editingId; }) || {});
        return (
            '<div class="settings-wrapper-editor">' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="wrapper-field-id">id</label>' +
            '    <input type="text" id="wrapper-field-id" class="modal-input" placeholder="e.g. cld" value="' + escapeHtml(w.id) + '" ' + (isNew ? '' : 'readonly disabled') + '>' +
            '    <div class="settings-field-hint">lowercase letters/digits/-/_ only. also usable directly as the launch agent type.</div>' +
            '  </div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="wrapper-field-label">label</label>' +
            '    <input type="text" id="wrapper-field-label" class="modal-input" placeholder="e.g. cld (subscription)" value="' + escapeHtml(w.label) + '">' +
            '  </div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="wrapper-field-script">script</label>' +
            '    <textarea id="wrapper-field-script" class="modal-input settings-wrapper-script-input" rows="20" spellcheck="false" placeholder="claude --dangerously-skip-permissions">' + escapeHtml(w.script) + '</textarea>' +
            '    <div class="settings-field-hint">a single command, or a full function definition (paste it exactly as it appears in your shell rc file).</div>' +
            '  </div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="wrapper-field-entry">entry (optional)</label>' +
            '    <input type="text" id="wrapper-field-entry" class="modal-input" placeholder="e.g. cld" value="' + escapeHtml(w.entry || '') + '">' +
            '    <div class="settings-field-hint">only needed if script DEFINES a function — the function name to call after sourcing. leave blank if script is already a directly-runnable command.</div>' +
            '  </div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="wrapper-field-description">description (optional)</label>' +
            '    <input type="text" id="wrapper-field-description" class="modal-input" value="' + escapeHtml(w.description || '') + '">' +
            '  </div>' +
            '  <div class="settings-field settings-field-checkbox">' +
            '    <label class="settings-field-label" for="wrapper-field-default">' +
            '      <input type="checkbox" id="wrapper-field-default" ' + (w.default ? 'checked' : '') + '> make this the default' +
            '    </label>' +
            '  </div>' +
            '  <div class="settings-wrapper-editor-actions">' +
            '    <span id="wrapper-editor-status" class="settings-save-status"></span>' +
            '    <button type="button" class="modal-btn modal-btn-secondary" id="wrapper-editor-cancel">cancel</button>' +
            '    <button type="button" class="modal-btn modal-btn-primary" id="wrapper-editor-save">' + (isNew ? 'add' : 'save') + '</button>' +
            '  </div>' +
            '</div>'
        );
    }

    /**
     * Re-render the section in place and re-wire its event handlers.
     * Output: void.
     */
    function rerender() {
        if (!rootEl) return;
        rootEl.outerHTML = renderSection();
        rootEl = document.querySelector('[data-settings-section="wrappers"]');
        wire();
    }

    /**
     * Read the editor form's current values into an AgentWrapper-shaped
     * request body.
     * Output: object.
     */
    function readEditorForm() {
        var q = function (id) { return document.getElementById(id); };
        var entry = q('wrapper-field-entry').value.trim();
        var description = q('wrapper-field-description').value.trim();
        return {
            id: q('wrapper-field-id').value.trim(),
            label: q('wrapper-field-label').value.trim(),
            script: q('wrapper-field-script').value,
            entry: entry || null,
            description: description || null,
            default: q('wrapper-field-default').checked,
        };
    }

    /**
     * Save the open editor (add or update depending on ``editingId``),
     * then reload the wrapper list from the server and close the editor.
     * Output: Promise<void>.
     */
    async function saveEditor() {
        var body = readEditorForm();
        var statusEl = document.getElementById('wrapper-editor-status');
        var saveBtn = document.getElementById('wrapper-editor-save');
        if (!body.id || !body.label || !body.script.trim()) {
            if (statusEl) statusEl.textContent = 'id, label, and script are required';
            return;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'saving...';
        try {
            var result = (editingId === '__new__')
                ? await window.API.addWrapper(body)
                : await window.API.updateWrapper(editingId, body);
            wrappers = result.wrappers || [];
            editingId = null;
            rerender();
        } catch (err) {
            console.error('AgentWrappersPanel: save failed', err);
            if (statusEl) statusEl.textContent = 'save failed: ' + (err && err.message ? err.message : 'unknown error');
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    /**
     * Delete a wrapper after a native confirm, then reload the list.
     * Inputs: id (string).
     * Output: Promise<void>.
     */
    async function deleteWrapper(id) {
        if (!window.confirm('delete wrapper "' + id + '"? this cannot be undone.')) return;
        try {
            var result = await window.API.deleteWrapper(id);
            wrappers = result.wrappers || [];
            rerender();
        } catch (err) {
            console.error('AgentWrappersPanel: delete failed', err);
            window.alert('delete failed: ' + (err && err.message ? err.message : 'unknown error'));
        }
    }

    /**
     * Mark a wrapper as default, then reload the list.
     * Inputs: id (string).
     * Output: Promise<void>.
     */
    async function makeDefault(id) {
        try {
            var result = await window.API.setDefaultWrapper(id);
            wrappers = result.wrappers || [];
            rerender();
        } catch (err) {
            console.error('AgentWrappersPanel: set-default failed', err);
            window.alert('set-default failed: ' + (err && err.message ? err.message : 'unknown error'));
        }
    }

    /**
     * Fetch + apply an example wrapper into the editor as a new (unsaved)
     * wrapper the user can review/edit before saving. Never writes to the
     * server on its own — the user still has to click "add".
     * Output: Promise<void>.
     */
    async function importExample() {
        if (!examples) {
            try {
                var resp = await window.API.listWrapperExamples();
                examples = resp.wrappers || [];
            } catch (err) {
                console.error('AgentWrappersPanel: failed to load examples', err);
                window.alert('failed to load examples');
                return;
            }
        }
        if (examples.length === 0) return;
        var labels = examples.map(function (e, i) { return (i + 1) + '. ' + e.label; }).join('\n');
        var choice = window.prompt('import which example?\n' + labels + '\n\nenter a number:', '1');
        var idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= examples.length) return;
        var chosen = examples[idx];
        editingId = '__new__';
        rerender();
        // Seed the just-opened editor with the chosen example's fields.
        document.getElementById('wrapper-field-id').value = chosen.id;
        document.getElementById('wrapper-field-label').value = chosen.label;
        document.getElementById('wrapper-field-script').value = chosen.script;
        document.getElementById('wrapper-field-entry').value = chosen.entry || '';
        document.getElementById('wrapper-field-description').value = chosen.description || '';
    }

    /**
     * Wire click handlers for the currently-rendered section. Called once
     * per render (mount + every rerender).
     * Output: void.
     */
    function wire() {
        if (!rootEl) return;

        var addBtn = rootEl.querySelector('#wrapper-add-btn');
        if (addBtn) addBtn.addEventListener('click', function () { editingId = '__new__'; rerender(); });

        var importBtn = rootEl.querySelector('#wrapper-import-btn');
        if (importBtn) importBtn.addEventListener('click', importExample);

        var cancelBtn = rootEl.querySelector('#wrapper-editor-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', function () { editingId = null; rerender(); });

        var saveBtn = rootEl.querySelector('#wrapper-editor-save');
        if (saveBtn) saveBtn.addEventListener('click', saveEditor);

        rootEl.querySelectorAll('[data-wrapper-action]').forEach(function (btn) {
            var action = btn.getAttribute('data-wrapper-action');
            var id = btn.getAttribute('data-wrapper-id');
            if (action === 'edit') {
                btn.addEventListener('click', function () { editingId = id; rerender(); });
            } else if (action === 'delete') {
                btn.addEventListener('click', function () { deleteWrapper(id); });
            } else if (action === 'default') {
                btn.addEventListener('click', function () { makeDefault(id); });
            }
        });
    }

    /**
     * Mount the wrappers section into a parent element (inserted as the
     * LAST child — settings-panel.js places this right after the generic
     * "agent" section in the panel body).
     * Inputs: parentEl (Element) - container to append into.
     * Output: Promise<void>.
     */
    async function mount(parentEl) {
        editingId = null;
        try {
            var resp = await window.API.listWrappers();
            wrappers = resp.wrappers || [];
        } catch (err) {
            console.error('AgentWrappersPanel: failed to load wrappers', err);
            wrappers = [];
        }
        var wrapperDiv = document.createElement('div');
        wrapperDiv.innerHTML = renderSection();
        rootEl = wrapperDiv.firstElementChild;
        parentEl.appendChild(rootEl);
        wire();
    }

    window.AgentWrappersPanel = { mount: mount };
})();
