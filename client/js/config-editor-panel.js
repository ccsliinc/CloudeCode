/**
 * Claude-config file tree panel.
 *
 * Peer to the session sidebar (client/js/session-sidebar.js) - same
 * body-level backdrop + slide-over panel pattern, opened from
 * #configEditorBtn in the header. Browses Claude's OWN config ONLY:
 * `~/.claude` ("user" root) plus the active project's `.claude/`
 * ("project" root, when a session is attached) - never a general
 * filesystem browser. All list/read/write logic and the allowed-roots /
 * hide-list live server-side in src/core/config_files.py; this module
 * only renders the tree. Opening a file hands off to
 * window.ConfigEditorModal (client/js/config-editor-modal.js), which
 * owns the editor - split into two files purely for the project's
 * 500-line file-size rule; the two together are one feature.
 *
 * The panel is tree-only now: full height, no inline editor sliver (the
 * editor lives in a real modal - see config-editor-modal.js).
 *
 * Tree rendering is lazy: a directory's children are not built into the
 * DOM until it is first expanded, and every directory starts collapsed
 * (READONLY_COLLAPSED_DIRS roots like plugins/ additionally IGNORE any
 * persisted "expanded" state - see _startsCollapsed). This is what keeps
 * a repo with thousands of files under plugins/ or skills/ from building
 * thousands of DOM nodes on open - previously ALL of it rendered eagerly
 * (~965 DOM nodes observed against this user's ~/.claude), burying
 * CLAUDE.md in the wall.
 *
 * Must load AFTER api.js (window.API), session-status-ui.js
 * (window.SessionStatusUI, shared icons), config-editor-modal.js
 * (window.ConfigEditorModal) and BEFORE app.js (App.init() wires
 * #configEditorBtn's click handler to ConfigEditorPanel.open()).
 */

console.log('[ConfigEditorPanel Module] Loading...');

// Directories that are read-only in the tree (see config_files.py's
// READONLY_COLLAPSED_DIRS) always start collapsed, and stay collapsed
// across reloads regardless of what a user previously expanded - a
// stray persisted "expanded" flag for a 1000+ file directory would
// reintroduce the exact wall-of-nodes bug this rebuild fixes.
const CONFIG_EDITOR_FORCE_COLLAPSED_DIRS = new Set(['plugins']);

class ConfigEditorPanelController {
    constructor() {
        this.panel = null;
        this.backdrop = null;
        this.closeBtn = null;
        this.treeEl = null;

        this.isOpen = false;
        this._wired = false;

        // localStorage-backed map of "root:relPath" -> collapsed (bool),
        // following the cloude.* convention (cloude.theme,
        // cloude.launchpad.collapsed, ...). Lazily loaded on first use.
        this._collapsedState = null;
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
     * Close the panel. Refuses to close over an unsaved editor without
     * asking first - the modal may be layered on top of this panel, and
     * an Escape/backdrop-click here must not silently drop an edit any
     * more than the modal's own dismissal handlers would.
     * Inputs: none. Output: Promise<void>.
     */
    async close() {
        if (!this.panel) return;
        if (window.ConfigEditorModal && window.ConfigEditorModal.isDirty()) {
            if (!(await window.ConfigEditorModal.confirmDiscardIfDirty())) return;
        }
        if (window.ConfigEditorModal) window.ConfigEditorModal.close();
        this.isOpen = false;
        this.panel.classList.remove('config-editor-panel--open');
        this.panel.setAttribute('aria-hidden', 'true');
        this.backdrop.hidden = true;
        if (this._triggerEl) {
            this._triggerEl.setAttribute('aria-expanded', 'false');
            this._triggerEl.focus();
        }
    }

    // ---- collapsed-state persistence (cloude.* localStorage convention) --

    /**
     * Read the persisted collapsed-state map, lazily.
     * Inputs: none. Output: Object<string, boolean> - "root:relPath" ->
     *   collapsed.
     */
    _loadCollapsedState() {
        if (this._collapsedState) return this._collapsedState;
        try {
            const raw = localStorage.getItem('cloude.configEditor.collapsed');
            this._collapsedState = raw ? JSON.parse(raw) : {};
        } catch (err) {
            console.warn('ConfigEditorPanel: failed to read collapsed-state:', err);
            this._collapsedState = {};
        }
        return this._collapsedState;
    }

    /**
     * Persist one node's collapsed flag.
     * Inputs: key (string) - "root:relPath"; collapsed (bool).
     * Output: void.
     */
    _setNodeCollapsed(key, collapsed) {
        const state = this._loadCollapsedState();
        state[key] = collapsed;
        try {
            localStorage.setItem('cloude.configEditor.collapsed', JSON.stringify(state));
        } catch (err) {
            console.warn('ConfigEditorPanel: failed to persist collapsed-state:', err);
        }
    }

    /**
     * Resolve whether one directory node should start collapsed: forced
     * collapsed dirs (plugins/) always win; otherwise a persisted user
     * choice wins; otherwise every directory defaults to collapsed (the
     * "collapsed by default" requirement) regardless of the server's
     * per-node `collapsed` hint, which today only flags read-only roots.
     * Inputs: rootId (string); node (object) - server TreeNode.
     * Output: bool.
     */
    _startsCollapsed(rootId, node) {
        if (CONFIG_EDITOR_FORCE_COLLAPSED_DIRS.has(node.name)) return true;
        const key = `${rootId}:${node.rel_path}`;
        const state = this._loadCollapsedState();
        if (Object.prototype.hasOwnProperty.call(state, key)) return state[key];
        return true;
    }

    // ---- tree loading / rendering -----------------------------------

    /**
     * Load and render both roots' trees ("user" always, "project" only
     * when a session is attached AND that project has a `.claude/`
     * directory).
     * Inputs: none. Output: Promise<void>.
     */
    async _loadTree() {
        this.treeEl.innerHTML = '<div class="config-editor-loading">loading...</div>';
        const projectPath = this._currentProjectPath();
        this.treeEl.innerHTML = '';

        try {
            const userTree = await window.API.getConfigFileTree('user');
            this.treeEl.appendChild(this._renderRootSection('user', '~/.claude', userTree.tree));
        } catch (err) {
            this.treeEl.appendChild(this._errorEl(`failed to load ~/.claude: ${err.message || err}`));
        }

        if (projectPath) {
            try {
                const projectTree = await window.API.getConfigFileTree('project', projectPath);
                if (projectTree.tree && projectTree.tree.length) {
                    this.treeEl.appendChild(this._renderRootSection('project', 'project .claude', projectTree.tree));
                }
            } catch (err) {
                // A project working directory with no .claude/ subdirectory
                // is the ordinary case, not a failure: config_files.py's
                // resolve_roots() only registers the "project" root when
                // the directory exists, so list_tree() raises "unknown or
                // unavailable root: project" (HTTP 400) for every project
                // that simply hasn't got project-scoped config yet. That
                // 400 is the server's designed signal for "not available
                // here", not "something broke" - render it as a calm empty
                // state. Any OTHER status (401/403/5xx, or no status at all
                // for a network failure) is a real failure and still
                // surfaces as an error.
                if (err.status === 400) {
                    this.treeEl.appendChild(this._emptyStateEl('this project has no .claude config'));
                } else {
                    this.treeEl.appendChild(this._errorEl(`failed to load project .claude: ${err.message || err}`));
                }
            }
        }
    }

    /**
     * Build one root's section header + top-level list.
     * Inputs: rootId (string); label (string); nodes (object[]) - server
     *   TreeNode dicts.
     * Output: Element.
     */
    _renderRootSection(rootId, label, nodes) {
        const heading = document.createElement('div');
        heading.className = 'config-editor-root-label';
        heading.textContent = label;

        const list = document.createElement('ul');
        list.className = 'config-editor-list';
        nodes.forEach((node) => list.appendChild(this._buildNodeEl(rootId, node, 0)));

        const container = document.createElement('div');
        container.appendChild(heading);
        container.appendChild(list);
        return container;
    }

    /**
     * Build one <li> for a tree node. Directories get a toggle button
     * (chevron + folder icon, aria-expanded) and an EMPTY children <ul>
     * that is only populated the first time it is expanded - the lazy-
     * render mechanism that keeps a 1000+ entry directory from costing
     * 1000+ DOM nodes until the user actually asks to see them. Files
     * get a single tappable <button> row that opens the editor modal;
     * the whole row is the hit target, not a small glyph, and its icon
     * (a document, distinct from the folder glyph) makes the file/
     * directory distinction visible at a glance.
     * Inputs: rootId (string); node (object) - server TreeNode; depth
     *   (number) - for indentation.
     * Output: Element - <li>.
     */
    _buildNodeEl(rootId, node, depth) {
        const li = document.createElement('li');
        li.className = `config-editor-node config-editor-node--${node.is_dir ? 'dir' : 'file'}`;

        if (node.is_dir) {
            const collapsed = this._startsCollapsed(rootId, node);
            const key = `${rootId}:${node.rel_path}`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'config-editor-toggle';
            toggle.style.paddingLeft = `${depth * 14 + 6}px`;
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.innerHTML = (
                window.SessionStatusUI.chevronIconSvg() +
                window.SessionStatusUI.folderIconSvg() +
                `<span class="config-editor-node-name">${this._esc(node.name)}</span>` +
                (node.read_only ? ' <span class="config-editor-badge">read-only</span>' : '')
            );

            const childList = document.createElement('ul');
            childList.className = 'config-editor-list';
            childList.hidden = collapsed;
            let built = false;

            toggle.addEventListener('click', () => {
                const nowExpanded = toggle.getAttribute('aria-expanded') !== 'true';
                if (nowExpanded && !built) {
                    node.children.forEach((child) => childList.appendChild(this._buildNodeEl(rootId, child, depth + 1)));
                    built = true;
                }
                toggle.setAttribute('aria-expanded', String(nowExpanded));
                childList.hidden = !nowExpanded;
                if (!CONFIG_EDITOR_FORCE_COLLAPSED_DIRS.has(node.name)) {
                    this._setNodeCollapsed(key, !nowExpanded);
                }
            });

            li.appendChild(toggle);
            li.appendChild(childList);
            return li;
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-editor-file';
        btn.style.paddingLeft = `${depth * 14 + 6}px`;
        btn.dataset.root = rootId;
        btn.dataset.path = node.rel_path;
        btn.dataset.readonly = node.read_only ? '1' : '0';
        btn.innerHTML = (
            window.SessionStatusUI.fileIconSvg() +
            `<span class="config-editor-node-name">${this._esc(node.name)}</span>` +
            (node.is_executable ? ' <span class="config-editor-badge config-editor-badge--exec">runs automatically</span>' : '')
        );
        btn.addEventListener('click', () => {
            const projectPath = rootId === 'project' ? this._currentProjectPath() : null;
            window.ConfigEditorModal.open(rootId, node.rel_path, node.read_only, projectPath);
        });
        li.appendChild(btn);
        return li;
    }

    /**
     * Build an error message block for the tree.
     * Inputs: message (string). Output: Element.
     */
    _errorEl(message) {
        const el = document.createElement('div');
        el.className = 'config-editor-error';
        el.textContent = message;
        return el;
    }

    /**
     * Build a calm (non-error) empty-state block for the tree, used when
     * a project legitimately has no .claude/ config rather than when a
     * request failed.
     * Inputs: message (string). Output: Element.
     */
    _emptyStateEl(message) {
        const el = document.createElement('div');
        el.className = 'config-editor-empty';
        el.textContent = message;
        return el;
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
