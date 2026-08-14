/**
 * Claude-config editor modal - the file-editing half of the config
 * editor feature (see client/js/config-editor-panel.js for the tree half
 * that opens it). Split into its own module purely for the project's
 * 500-line file-size rule; the two files together are one feature and
 * load back to back.
 *
 * Follows SettingsPanel's exact dismissal contract (client/js/settings-
 * panel.js): a `.modal-overlay` appended to document.body on open,
 * removed on close, close-button/backdrop-click/Escape all dismiss - with
 * one addition: dismissal is gated behind an unsaved-changes check
 * (confirmDiscardIfDirty) via App.showConfirmModal, so a stray Escape or
 * backdrop click can never silently drop an edit.
 *
 * Markdown files get an edit/preview toggle; preview renders through
 * window.MarkdownLite (client/js/markdown-lite.js), never raw innerHTML
 * from file content.
 *
 * Must load AFTER api.js (window.API), markdown-lite.js
 * (window.MarkdownLite) and BEFORE config-editor-panel.js, which calls
 * into window.ConfigEditorModal.open().
 */

console.log('[ConfigEditorModal Module] Loading...');

(function () {
    // { root, path, projectPath, isExecutable, readOnly, originalContent,
    //   dirty, mode: 'edit'|'preview' } | null
    let activeFile = null;
    let overlayEl = null;

    /**
     * True when a file is markdown, purely by extension - drives whether
     * the edit/preview toggle appears.
     * Inputs: path (string). Output: bool.
     */
    function isMarkdown(path) {
        return /\.md$/i.test(path || '');
    }

    /**
     * HTML-escape a string for safe interpolation into innerHTML.
     * Inputs: value (any). Output: string.
     */
    function esc(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    /**
     * True while a file is open with edits not yet saved. The one
     * question every dismissal path (this module's own close handlers,
     * and ConfigEditorPanel's panel-level close) must ask before
     * discarding state.
     * Inputs: none. Output: bool.
     */
    function isDirty() {
        return !!(activeFile && activeFile.dirty);
    }

    /**
     * Ask the user before discarding unsaved edits. A no-op (resolves
     * true immediately) when there is nothing dirty to lose.
     * Inputs: none. Output: Promise<bool> - true if it is safe to
     *   proceed (either nothing was dirty, or the user confirmed
     *   discarding it).
     */
    async function confirmDiscardIfDirty() {
        if (!isDirty()) return true;
        return window.App.showConfirmModal(
            'discard unsaved changes?',
            `"${activeFile.path}" has unsaved edits.`,
            'closing now will lose them. this cannot be undone.',
            'discard',
            'keep editing'
        );
    }

    /**
     * Close the modal without asking - callers that already know it is
     * safe (a confirmed discard, or a successful save-and-close) use
     * this directly. Every USER-facing dismissal gesture must go through
     * closeGuarded() instead.
     * Inputs: none. Output: void.
     */
    function close() {
        if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
        overlayEl = null;
        activeFile = null;
    }

    /**
     * Dismissal entry point for the modal's close button, backdrop
     * click, and Escape - the one path every "make the modal go away"
     * gesture routes through, so unsaved changes are protected
     * identically no matter which gesture triggered it.
     * Inputs: none. Output: Promise<void>.
     */
    async function closeGuarded() {
        if (!(await confirmDiscardIfDirty())) return;
        close();
    }

    /**
     * Open the editor for one file: builds the modal shell immediately
     * (loading state), then fetches content and renders the real editor.
     * Inputs: rootId (string) - "user"|"project"; relPath (string);
     *   readOnly (bool) - from the tree node's data attribute; combined
     *   with the server's own read_only flag in the response.
     *   projectPath (string|null) - required when rootId === "project".
     * Output: Promise<void>.
     */
    async function open(rootId, relPath, readOnly, projectPath) {
        if (!(await confirmDiscardIfDirty())) return;
        close();
        buildShell(rootId, relPath, projectPath);
        try {
            const result = await window.API.readConfigFile(rootId, relPath, projectPath);
            activeFile = {
                root: rootId,
                path: relPath,
                projectPath,
                isExecutable: result.is_executable,
                readOnly: readOnly || result.read_only,
                originalContent: result.content,
                dirty: false,
                mode: 'edit',
            };
            renderBody();
        } catch (err) {
            const body = document.getElementById('config-editor-modal-body');
            if (body) body.innerHTML = `<div class="config-editor-error">failed to open: ${esc(err.message || err)}</div>`;
        }
    }

    /**
     * Create the modal DOM shell and append it to document.body. Content
     * is filled in afterward by renderBody() so a loading state shows
     * immediately for a slow read.
     * Inputs: rootId (string); relPath (string); projectPath (string|null).
     * Output: void.
     */
    function buildShell(rootId, relPath, projectPath) {
        overlayEl = document.createElement('div');
        overlayEl.className = 'modal-overlay';
        overlayEl.setAttribute('data-modal', 'config-editor');
        overlayEl.innerHTML = (
            '<div class="config-editor-modal-content" role="dialog" aria-modal="true" aria-labelledby="config-editor-modal-title">' +
            '  <div class="modal-header config-editor-modal-header">' +
            `    <div><span id="config-editor-modal-title" class="config-editor-modal-title">${esc(relPath)}</span>` +
            `    <div class="config-editor-modal-subtitle">${esc(rootId)} root${projectPath ? ` · ${esc(projectPath)}` : ''}</div></div>` +
            '    <button type="button" class="modal-close" id="config-editor-modal-close" aria-label="Close editor" title="close">&times;</button>' +
            '  </div>' +
            '  <div class="modal-body config-editor-modal-body" id="config-editor-modal-body"><div class="config-editor-loading">loading...</div></div>' +
            '  <div class="modal-footer config-editor-modal-footer" id="config-editor-modal-footer" hidden></div>' +
            '</div>'
        );
        document.body.appendChild(overlayEl);

        overlayEl.querySelector('#config-editor-modal-close').addEventListener('click', () => closeGuarded());
        overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeGuarded(); });
        overlayEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeGuarded();
            }
        });

        setTimeout(() => {
            const closeBtn = overlayEl.querySelector('#config-editor-modal-close');
            try { closeBtn.focus(); } catch (_) { /* no-op */ }
        }, 50);
    }

    /**
     * Render the modal body + footer for the currently-loaded
     * `activeFile`: textarea, exec/read-only warnings, edit/preview
     * toggle for markdown, and save/cancel actions.
     * Inputs: none. Output: void.
     */
    function renderBody() {
        const f = activeFile;
        const body = document.getElementById('config-editor-modal-body');
        const footer = document.getElementById('config-editor-modal-footer');
        if (!body || !footer) return;

        const execNote = f.isExecutable
            ? '<div class="config-editor-exec-warning">this file is code claude code runs automatically. saving requires confirmation and is always backed up first.</div>'
            : '';
        const roNote = f.readOnly ? '<div class="config-editor-ro-warning">read-only - this file is under a read-only root.</div>' : '';
        const isMd = isMarkdown(f.path);
        const toggleHtml = isMd
            ? `<div class="config-editor-mode-toggle" role="tablist" aria-label="editor mode">
                 <button type="button" role="tab" id="config-editor-mode-edit" aria-selected="${f.mode === 'edit'}">edit</button>
                 <button type="button" role="tab" id="config-editor-mode-preview" aria-selected="${f.mode === 'preview'}">preview</button>
               </div>`
            : '';

        body.innerHTML = (
            `${execNote}${roNote}${toggleHtml}` +
            '<div id="config-editor-save-error" class="config-editor-error" hidden></div>' +
            `<textarea id="config-editor-textarea" class="config-editor-textarea" spellcheck="false" ` +
            `${f.readOnly ? 'readonly' : ''} ${f.mode === 'preview' ? 'hidden' : ''}>${esc(f.originalContent)}</textarea>` +
            `<div id="config-editor-preview" class="config-editor-preview" ${f.mode === 'preview' ? '' : 'hidden'}></div>`
        );

        footer.hidden = false;
        footer.innerHTML = (
            '<span id="config-editor-dirty-flag" class="config-editor-dirty-flag"></span>' +
            '<button type="button" class="modal-btn modal-btn-secondary" id="config-editor-cancel">cancel</button>' +
            `<button type="button" class="modal-btn modal-btn-primary" id="config-editor-save" ${f.readOnly ? 'disabled' : ''}>save</button>`
        );

        wireBody(f, isMd);
    }

    /**
     * Wire the event handlers for the just-rendered body/footer (textarea
     * dirty-tracking + tab handling, cancel, save, mode toggle).
     * Inputs: f (object) - activeFile; isMd (bool).
     * Output: void.
     */
    function wireBody(f, isMd) {
        const textarea = document.getElementById('config-editor-textarea');
        textarea.addEventListener('input', () => {
            f.dirty = textarea.value !== f.originalContent;
            updateDirtyFlag();
        });
        textarea.addEventListener('keydown', (e) => {
            // Preserve indentation on Tab instead of moving focus out of
            // the textarea - table stakes for hand-editing YAML/JSON/py.
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.slice(0, start) + '    ' + textarea.value.slice(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
                f.dirty = textarea.value !== f.originalContent;
                updateDirtyFlag();
            }
        });

        document.getElementById('config-editor-cancel').addEventListener('click', () => closeGuarded());
        if (!f.readOnly) {
            document.getElementById('config-editor-save').addEventListener('click', () => save());
        }
        if (isMd) {
            document.getElementById('config-editor-mode-edit').addEventListener('click', () => setMode('edit'));
            document.getElementById('config-editor-mode-preview').addEventListener('click', () => setMode('preview'));
        }
        updateDirtyFlag();
    }

    /**
     * Switch between edit/preview mode for a markdown file. Preview
     * renders the CURRENT (possibly unsaved) textarea content through
     * MarkdownLite - never innerHTML from the file directly.
     * Inputs: mode ('edit'|'preview'). Output: void.
     */
    function setMode(mode) {
        if (!activeFile) return;
        const textarea = document.getElementById('config-editor-textarea');
        activeFile.mode = mode;
        const editTab = document.getElementById('config-editor-mode-edit');
        const previewTab = document.getElementById('config-editor-mode-preview');
        const preview = document.getElementById('config-editor-preview');
        if (mode === 'preview') {
            preview.innerHTML = window.MarkdownLite.render(textarea.value);
            textarea.hidden = true;
            preview.hidden = false;
        } else {
            textarea.hidden = false;
            preview.hidden = true;
        }
        editTab.setAttribute('aria-selected', String(mode === 'edit'));
        previewTab.setAttribute('aria-selected', String(mode === 'preview'));
    }

    /**
     * Reflect `activeFile.dirty` into the footer's status text.
     * Inputs: none. Output: void.
     */
    function updateDirtyFlag() {
        const el = document.getElementById('config-editor-dirty-flag');
        if (!el || !activeFile) return;
        el.textContent = activeFile.dirty ? 'unsaved changes' : '';
    }

    /**
     * Save the editor's current content, enforcing the same confirm-
     * before-executable-write flow as every other destructive action in
     * the app (App.showConfirmModal). Client-side JSON pre-validation is
     * a fast-fail UX nicety only - the server re-validates and is the
     * real enforcement point (config_files.write_file).
     * Inputs: none. Output: Promise<void>.
     */
    async function save() {
        const f = activeFile;
        if (!f) return;
        const textarea = document.getElementById('config-editor-textarea');
        const errorEl = document.getElementById('config-editor-save-error');
        errorEl.hidden = true;
        const content = textarea.value;

        if (f.path.endsWith('.json')) {
            try {
                JSON.parse(content);
            } catch (err) {
                errorEl.hidden = false;
                errorEl.classList.remove('config-editor-success');
                errorEl.textContent = `invalid json - not saved: ${err.message}`;
                return;
            }
        }

        let acknowledgeExecutable = false;
        if (f.isExecutable) {
            const confirmed = await window.App.showConfirmModal(
                'save executable file?',
                `"${f.path}" is code claude code runs automatically.`,
                'a backup of the current version is made before saving. this cannot be undone.',
                'save',
                'cancel'
            );
            if (!confirmed) return;
            acknowledgeExecutable = true;
        }

        try {
            const result = await window.API.writeConfigFile({
                root: f.root,
                path: f.path,
                content,
                project_path: f.projectPath,
                acknowledge_executable: acknowledgeExecutable,
            });
            f.originalContent = content;
            f.dirty = false;
            updateDirtyFlag();
            errorEl.hidden = false;
            errorEl.classList.add('config-editor-success');
            errorEl.textContent = result.backed_up ? 'saved (previous version backed up to .bak)' : 'saved';
        } catch (err) {
            errorEl.hidden = false;
            errorEl.classList.remove('config-editor-success');
            errorEl.textContent = `save failed: ${err.message || err}`;
        }
    }

    window.ConfigEditorModal = { open, close, isDirty, confirmDiscardIfDirty };
    console.log('[ConfigEditorModal Module] Exported as window.ConfigEditorModal');
})();
