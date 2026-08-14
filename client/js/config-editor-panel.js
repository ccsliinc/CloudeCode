/**
 * Claude-config file tree + editor panel.
 *
 * Peer to the session sidebar (client/js/session-sidebar.js) - same
 * body-level backdrop + slide-over panel pattern, opened from
 * #configEditorBtn in the header. Browses and edits Claude's OWN config
 * ONLY: `~/.claude` ("user" root) plus the active project's `.claude/`
 * ("project" root, when a session is attached) - never a general
 * filesystem browser. All list/read/write logic and the allowed-roots /
 * hide-list live server-side in src/core/config_files.py; this module
 * only renders the tree, drives the editor, and enforces the same
 * confirm-before-executable-write UX every other destructive action in
 * this app uses.
 *
 * Must load AFTER api.js (window.API) and BEFORE app.js (App.init()
 * wires #configEditorBtn's click handler to ConfigEditorPanel.open()).
 */

console.log('[ConfigEditorPanel Module] Loading...');

class ConfigEditorPanelController {
    constructor() {
        this.panel = null;
        this.backdrop = null;
        this.closeBtn = null;
        this.treeEl = null;
        this.editorEl = null;

        this.isOpen = false;
        this._wired = false;

        // { root: "user"|"project", path: string, isExecutable: bool,
        //   readOnly: bool, originalContent: string }
        this._activeFile = null;
    }

    /**
     * Best-effort resolution of the active project's working directory,
     * for the "project" root. Reads TerminalController's current session
     * rather than tracking its own copy - single source of truth for
     * "what session is attached right now".
     * Inputs: none.
     * Output: string|null - absolute working directory, or null when no
     *   session is attached (terminal not open, or on the launchpad).
     */
    _currentProjectPath() {
        const tc = window.TerminalController;
        if (!tc || !tc._currentSession) return null;
        const s = tc._currentSession;
        const unwrapped = (s.session && typeof s.session === 'object') ? s.session : s;
        return (unwrapped && unwrapped.working_dir) || null;
    }

    /**
     * Wire DOM elements + event listeners once. Idempotent.
     * Inputs: none. Output: void.
     */
    _wire() {
        if (this._wired) return;
        this.panel = document.getElementById('config-editor-panel');
        this.backdrop = document.getElementById('config-editor-backdrop');
        this.closeBtn = document.getElementById('config-editor-close');
        this.treeEl = document.getElementById('config-editor-tree');
        this.editorEl = document.getElementById('config-editor-editor');
        if (!this.panel || !this.backdrop) return;

        this.closeBtn.addEventListener('click', () => this.close());
        this.backdrop.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
        this._wired = true;
    }

    /**
     * Open the panel and (re)load both roots' trees.
     * Inputs: triggerEl (Element|null) - the button that opened this,
     *   for focus-return on close (matches the settings panel's pattern).
     * Output: Promise<void>.
     */
    async open(triggerEl = null) {
        this._wire();
        if (!this.panel) return;
        this._triggerEl = triggerEl || null;
        this.isOpen = true;
        this.panel.classList.add('config-editor-panel--open');
        this.panel.setAttribute('aria-hidden', 'false');
        this.backdrop.hidden = false;
        if (this._triggerEl) this._triggerEl.setAttribute('aria-expanded', 'true');
        await this._loadTree();
    }

    /**
     * Close the panel, discarding any unsaved editor state.
     * Inputs: none. Output: void.
     */
    close() {
        if (!this.panel) return;
        this.isOpen = false;
        this.panel.classList.remove('config-editor-panel--open');
        this.panel.setAttribute('aria-hidden', 'true');
        this.backdrop.hidden = true;
        this._activeFile = null;
        this.editorEl.hidden = true;
        this.editorEl.innerHTML = '';
        if (this._triggerEl) {
            this._triggerEl.setAttribute('aria-expanded', 'false');
            this._triggerEl.focus();
        }
    }

    /**
     * Load and render both roots' trees ("user" always, "project" only
     * when a session is attached).
     * Inputs: none. Output: Promise<void>.
     */
    async _loadTree() {
        this.treeEl.innerHTML = '<div class="config-editor-loading">loading...</div>';
        const projectPath = this._currentProjectPath();
        const sections = [];

        try {
            const userTree = await window.API.getConfigFileTree('user');
            sections.push(this._renderRootSection('user', '~/.claude', userTree.tree));
        } catch (err) {
            sections.push(`<div class="config-editor-error">failed to load ~/.claude: ${this._esc(err.message || err)}</div>`);
        }

        if (projectPath) {
            try {
                const projectTree = await window.API.getConfigFileTree('project', projectPath);
                if (projectTree.tree && projectTree.tree.length) {
                    sections.push(this._renderRootSection('project', 'project .claude', projectTree.tree));
                }
            } catch (err) {
                // A project without a .claude/ dir is normal, not an error
                // worth surfacing - config_files.list_tree() already
                // returns [] for that case rather than raising, so a
                // thrown error here is a real failure.
                sections.push(`<div class="config-editor-error">failed to load project .claude: ${this._esc(err.message || err)}</div>`);
            }
        }

        this.treeEl.innerHTML = sections.join('');
        this._bindTreeClicks();
    }

    /**
     * Render one root's section header + nested <ul> tree.
     * Inputs: rootId (string); label (string); nodes (object[]).
     * Output: string - HTML.
     */
    _renderRootSection(rootId, label, nodes) {
        return (
            `<div class="config-editor-root-label">${this._esc(label)}</div>` +
            `<ul class="config-editor-list">${nodes.map(n => this._renderNode(rootId, n, 0)).join('')}</ul>`
        );
    }

    /**
     * Render one tree node (file or directory) and its children.
     * Inputs: rootId (string); node (object) - server TreeNode dict;
     *   depth (number).
     * Output: string - HTML for one <li>.
     */
    _renderNode(rootId, node, depth) {
        const indent = `style="padding-left: ${depth * 14}px"`;
        if (node.is_dir) {
            const openAttr = node.collapsed ? '' : ' open';
            const roLabel = node.read_only ? ' <span class="config-editor-badge">read-only</span>' : '';
            return (
                `<li class="config-editor-node config-editor-node--dir">` +
                `<details${openAttr}><summary ${indent}>${this._esc(node.name)}${roLabel}</summary>` +
                `<ul class="config-editor-list">${node.children.map(c => this._renderNode(rootId, c, depth + 1)).join('')}</ul>` +
                `</details></li>`
            );
        }
        const execLabel = node.is_executable ? ' <span class="config-editor-badge config-editor-badge--exec">runs automatically</span>' : '';
        return (
            `<li class="config-editor-node config-editor-node--file" ${indent} ` +
            `data-root="${this._esc(rootId)}" data-path="${this._esc(node.rel_path)}" ` +
            `data-executable="${node.is_executable ? '1' : '0'}" data-readonly="${node.read_only ? '1' : '0'}" ` +
            `role="button" tabindex="0">${this._esc(node.name)}${execLabel}</li>`
        );
    }

    /**
     * Bind click/keyboard activation for file rows (event delegation,
     * bound once per tree render).
     * Inputs: none. Output: void.
     */
    _bindTreeClicks() {
        const handler = async (e) => {
            const el = e.target.closest('.config-editor-node--file');
            if (!el || !this.treeEl.contains(el)) return;
            await this._openFile(el.dataset.root, el.dataset.path, el.dataset.readonly === '1');
        };
        this.treeEl.addEventListener('click', handler);
        this.treeEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const el = e.target.closest('.config-editor-node--file');
            if (!el) return;
            e.preventDefault();
            handler(e);
        });
    }

    /**
     * Load one file into the editor pane.
     * Inputs: rootId (string); relPath (string); readOnly (bool) - from
     *   the tree node's data attribute (plugins/ etc.); the editor
     *   renders view-only when true, no server round trip needed to
     *   find that out.
     * Output: Promise<void>.
     */
    async _openFile(rootId, relPath, readOnly) {
        const projectPath = rootId === 'project' ? this._currentProjectPath() : null;
        this.editorEl.hidden = false;
        this.editorEl.innerHTML = '<div class="config-editor-loading">loading...</div>';
        try {
            const result = await window.API.readConfigFile(rootId, relPath, projectPath);
            this._activeFile = {
                root: rootId,
                path: relPath,
                projectPath,
                isExecutable: result.is_executable,
                readOnly: readOnly || result.read_only,
                originalContent: result.content,
            };
            this._renderEditor();
        } catch (err) {
            this.editorEl.innerHTML = `<div class="config-editor-error">failed to open: ${this._esc(err.message || err)}</div>`;
        }
    }

    /**
     * Render the editor pane for `this._activeFile`.
     * Inputs: none. Output: void.
     */
    _renderEditor() {
        const f = this._activeFile;
        const execNote = f.isExecutable
            ? '<div class="config-editor-exec-warning">this file is code claude code runs automatically. saving requires confirmation and is always backed up first.</div>'
            : '';
        const roNote = f.readOnly ? '<div class="config-editor-ro-warning">read-only - this file is under a read-only root.</div>' : '';
        this.editorEl.innerHTML = (
            `<div class="config-editor-editor-header">
                <span class="config-editor-editor-path">${this._esc(f.root)}/${this._esc(f.path)}</span>
                <div class="config-editor-editor-actions">
                    <button type="button" id="config-editor-save" ${f.readOnly ? 'disabled' : ''}>save</button>
                    <button type="button" id="config-editor-cancel">cancel</button>
                </div>
            </div>
            ${execNote}${roNote}
            <div id="config-editor-save-error" class="config-editor-error" hidden></div>
            <textarea id="config-editor-textarea" class="config-editor-textarea" spellcheck="false" ${f.readOnly ? 'readonly' : ''}>${this._esc(f.originalContent)}</textarea>`
        );

        document.getElementById('config-editor-cancel').addEventListener('click', () => {
            this.editorEl.hidden = true;
            this.editorEl.innerHTML = '';
            this._activeFile = null;
        });

        if (!f.readOnly) {
            document.getElementById('config-editor-save').addEventListener('click', () => this._save());
        }
    }

    /**
     * Save the editor's current content, enforcing the same confirm-
     * before-executable-write flow as every other destructive action in
     * the app (App.showConfirmModal). Client-side JSON pre-validation is
     * a fast-fail UX nicety only - the server re-validates and is the
     * real enforcement point (config_files.write_file).
     * Inputs: none. Output: Promise<void>.
     */
    async _save() {
        const f = this._activeFile;
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
            errorEl.hidden = false;
            errorEl.classList.add('config-editor-success');
            errorEl.textContent = result.backed_up ? 'saved (previous version backed up to .bak)' : 'saved';
        } catch (err) {
            errorEl.hidden = false;
            errorEl.classList.remove('config-editor-success');
            errorEl.textContent = `save failed: ${err.message || err}`;
        }
    }

    /**
     * HTML-escape a string for safe interpolation into innerHTML.
     * Inputs: value (any). Output: string.
     */
    _esc(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }
}

window.ConfigEditorPanel = new ConfigEditorPanelController();
console.log('[ConfigEditorPanel Module] Exported as window.ConfigEditorPanel');
