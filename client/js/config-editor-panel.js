/**
 * Config/project file tree panel.
 *
 * A MODAL, opened from #configEditorBtn in the header. It used to be a
 * right-hand slide-over panel like the session sidebar; it is now the
 * FIRST of two stacked modals, with the editor
 * (client/js/config-editor-modal.js) opening over it. Both register with
 * client/js/modal-stack.js, which owns Escape routing (top modal only),
 * background scroll lock, and focus restore. On a phone the stack takes
 * this one off screen while the editor is up, so exactly one surface is
 * visible at a time and the editor's "back" control brings this one
 * back. Browses THREE roots: `~/.claude`
 * ("user"), the active project's `.claude/` ("project"), and (added
 * 2026-08) the active session's WORKING DIRECTORY itself ("workdir") -
 * general project file browsing, read AND write. All list/read/write
 * logic and the allowed-roots / hide-list live server-side in
 * src/core/config_files.py; this module only renders the tree. Opening a
 * file hands off to window.ConfigEditorModal
 * (client/js/config-editor-modal.js), which owns the editor - split into
 * two files purely for the project's 500-line file-size rule; the two
 * together are one feature.
 *
 * The picker is tree-only: full height, no inline editor sliver.
 *
 * Tree presentation: a classic filesystem-tree look - literal +/-
 * disclosure buttons (real <button>, aria-expanded, the glyph is
 * presentational), left-aligned rows with per-depth indentation GUIDE
 * lines rather than raw padding, and the three ROOTS themselves render as
 * collapsible nodes at depth 0 (same +/- affordance as any directory) so
 * the whole thing reads as one consistent tree instead of three separate
 * sections.
 *
 * Tree rendering is lazy: a directory's (or root's) children are not
 * built into the DOM until it is first expanded, and every directory
 * starts collapsed (READONLY_COLLAPSED_DIRS roots like plugins/
 * additionally IGNORE any persisted "expanded" state - see
 * _startsCollapsed). This is what keeps a repo with thousands of files
 * under plugins/ or skills/ from building thousands of DOM nodes on open
 * - previously ALL of it rendered eagerly (~965 DOM nodes observed
 * against this user's ~/.claude), burying CLAUDE.md in the wall.
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

// Single source of truth for the three roots this panel browses: API
// root id, display label, and default expand/collapse state. "user" and
// "project" default OPEN (small, config-focused, the reason this feature
// exists); "workdir" defaults CLOSED (a real project directory can be
// arbitrarily large - same reasoning as plugins/ being force-collapsed,
// just a per-user-choice default rather than a forced one, since a small
// project's workdir is perfectly reasonable to browse open).
const CONFIG_EDITOR_ROOTS = [
    { id: 'user', label: '~/.claude', defaultExpanded: true },
    { id: 'project', label: 'project .claude', defaultExpanded: true },
    { id: 'workdir', label: 'project files', defaultExpanded: false },
];

class ConfigEditorPanelController {
    constructor() {
        this.overlay = null;
        this.panel = null;
        this.closeBtn = null;
        this.treeEl = null;

        this.isOpen = false;
        this._wired = false;

        // localStorage-backed map of "root:relPath" -> collapsed (bool),
        // following the cloude.* convention (cloude.theme,
        // cloude.launchpad.collapsed, ...). Lazily loaded on first use.
        // Root nodes themselves use the key "root:__root__".
        this._collapsedState = null;
    }

    /**
     * Best-effort resolution of the active project's working directory,
     * used for BOTH the "project" root (its `.claude/` subdirectory) and
     * the "workdir" root (the directory itself). Reads
     * TerminalController's current session rather than tracking its own
     * copy - single source of truth for "what session is attached right
     * now".
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
        this.overlay = document.getElementById('config-editor-overlay');
        this.panel = this.overlay ? this.overlay.querySelector('.config-editor-picker-content') : null;
        this.closeBtn = document.getElementById('config-editor-close');
        this.treeEl = document.getElementById('config-editor-tree');
        if (!this.overlay || !this.panel) return;

        this.closeBtn.addEventListener('click', () => this.close());
        // The overlay IS the backdrop now - a click that lands on it
        // rather than on the dialog inside it is a dismissal, same
        // contract as every other .modal-overlay in the app.
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
        // No document-level Escape listener: ModalStack owns Escape for
        // this modal and the editor above it, which is the whole reason
        // one keypress no longer collapses both.
        this._wired = true;
    }

    /**
     * Open the picker modal and (re)load all roots' trees.
     * Inputs: triggerEl (Element|null) - the button that opened this,
     *   for focus-return on close (matches the settings panel's pattern).
     * Output: Promise<void>.
     */
    async open(triggerEl = null) {
        this._wire();
        if (!this.overlay) return;
        this._triggerEl = triggerEl || null;
        this.isOpen = true;
        this.overlay.hidden = false;
        window.ModalStack.push(this.overlay, { onEscape: () => this.close() });
        if (this._triggerEl) this._triggerEl.setAttribute('aria-expanded', 'true');
        if (this.closeBtn) {
            try { this.closeBtn.focus(); } catch (_) { /* no-op */ }
        }
        await this._loadTree();
    }

    /**
     * Close the picker. Refuses to close over an unsaved editor without
     * asking first - the editor modal may be stacked on top of this one,
     * and an Escape/backdrop-click here must not silently drop an edit
     * any more than the editor's own dismissal handlers would.
     * Inputs: none. Output: Promise<void>.
     */
    async close() {
        if (!this.overlay) return;
        if (window.ConfigEditorModal && window.ConfigEditorModal.isDirty()) {
            if (!(await window.ConfigEditorModal.confirmDiscardIfDirty())) return;
        }
        if (window.ConfigEditorModal) window.ConfigEditorModal.close();
        this.isOpen = false;
        window.ModalStack.pop(this.overlay);
        this.overlay.hidden = true;
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
     * Resolve whether one directory (or root) node should start
     * collapsed: forced-collapsed dirs (plugins/) always win; otherwise a
     * persisted user choice wins; otherwise `fallbackExpanded` (a root's
     * own declared default, from CONFIG_EDITOR_ROOTS) applies if given,
     * else every directory defaults to collapsed (the "collapsed by
     * default" requirement) regardless of the server's per-node
     * `collapsed` hint, which today only flags read-only roots.
     * Inputs: rootId (string); node (object) - server TreeNode, or a
     *   synthetic root node ({name, rel_path: '', is_dir: true});
     *   fallbackExpanded (bool|undefined) - default state when nothing
     *   is persisted (used for root nodes; directory nodes omit this and
     *   fall through to "collapsed").
     * Output: bool.
     */
    _startsCollapsed(rootId, node, fallbackExpanded) {
        if (CONFIG_EDITOR_FORCE_COLLAPSED_DIRS.has(node.name)) return true;
        const key = `${rootId}:${node.rel_path || '__root__'}`;
        const state = this._loadCollapsedState();
        if (Object.prototype.hasOwnProperty.call(state, key)) return state[key];
        return fallbackExpanded === undefined ? true : !fallbackExpanded;
    }

    // ---- tree loading / rendering -----------------------------------

    /**
     * Load all roots' trees (each fetched independently so one root's
     * failure/emptiness doesn't block the others) and render them as one
     * flat top-level list, each root a collapsible node.
     * Inputs: none. Output: Promise<void>.
     */
    async _loadTree() {
        this.treeEl.innerHTML = '<div class="config-editor-loading">loading...</div>';
        const projectPath = this._currentProjectPath();
        const list = document.createElement('ul');
        list.className = 'config-editor-list config-editor-list--roots';

        for (const rootDef of CONFIG_EDITOR_ROOTS) {
            if (rootDef.id !== 'user' && !projectPath) continue; // no session attached yet
            const li = await this._buildRootEl(rootDef, projectPath);
            if (li) list.appendChild(li);
        }

        this.treeEl.innerHTML = '';
        this.treeEl.appendChild(list);
    }

    /**
     * Fetch one root's tree and build it as a collapsible depth-0 node,
     * indistinguishable in interaction from a directory node inside it.
     * Inputs: rootDef (object) - one entry of CONFIG_EDITOR_ROOTS;
     *   projectPath (string|null).
     * Output: Promise<Element|null> - <li>, or null when this root has
     *   nothing to show and should be omitted entirely (e.g. "project"
     *   with no .claude/ directory).
     */
    async _buildRootEl(rootDef, projectPath) {
        let nodes;
        try {
            const resp = await window.API.getConfigFileTree(rootDef.id, projectPath);
            nodes = resp.tree || [];
        } catch (err) {
            // A project working directory with no .claude/ subdirectory
            // is the ordinary case, not a failure: config_files.py's
            // resolve_roots() only registers the "project" root when the
            // directory exists, so list_tree() raises "unknown or
            // unavailable root" (HTTP 400) for every project that simply
            // hasn't got project-scoped config yet - omit that root
            // entirely rather than showing an empty/error node for it.
            // Any OTHER status (401/403/5xx, or no status for a network
            // failure) is a real failure and surfaces as an error row.
            if (err.status === 400 && rootDef.id !== 'user') return null;
            const li = document.createElement('li');
            li.appendChild(this._errorEl(`failed to load ${rootDef.label}: ${err.message || err}`));
            return li;
        }
        if (rootDef.id !== 'user' && nodes.length === 0) return null;

        const rootNode = { name: rootDef.label, rel_path: '', is_dir: true, children: nodes };
        return this._buildNodeEl(rootDef.id, rootNode, 0, { isRoot: true, defaultExpanded: rootDef.defaultExpanded });
    }

    /**
     * Build one <li> for a tree node - a directory/root (collapsible,
     * +/- disclosure) or a file (single tappable row that opens the
     * editor modal). Directories/roots get a real <button> toggle with a
     * literal `+`/`-` glyph (presentational; the control's actual state
     * is `aria-expanded`) and a children <ul> that is populated the first
     * time the node is expanded - at render time if it STARTS expanded,
     * otherwise on the click that expands it. That is the lazy-render
     * mechanism that keeps a 1000+ entry collapsed directory from costing
     * 1000+ DOM nodes until the user asks to see them. Every row is
     * left-aligned with per-depth indentation GUIDE lines (vertical
     * rules) rather than raw padding, so the tree reads as a real
     * filesystem tree rather than a flat, centered list.
     * Inputs: rootId (string); node (object) - server TreeNode, or (for
     *   depth 0) a synthetic root node; depth (number) - for indentation;
     *   rootOpts (object|undefined) - {isRoot, defaultExpanded}, only
     *   passed for the depth-0 root node itself.
     * Output: Element - <li>.
     */
    _buildNodeEl(rootId, node, depth, rootOpts) {
        const li = document.createElement('li');
        const isRoot = !!(rootOpts && rootOpts.isRoot);
        li.className = `config-editor-node config-editor-node--${node.is_dir ? 'dir' : 'file'}${isRoot ? ' config-editor-node--root' : ''}`;

        const guides = this._buildGuides(depth);

        if (node.is_dir) {
            const collapsed = this._startsCollapsed(rootId, node, isRoot ? rootOpts.defaultExpanded : undefined);
            const key = `${rootId}:${node.rel_path || '__root__'}`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = `config-editor-toggle${isRoot ? ' config-editor-toggle--root' : ''}`;
            toggle.setAttribute('aria-expanded', String(!collapsed));
            const glyphSpan = `<span class="config-editor-toggle-glyph" aria-hidden="true">${collapsed ? '+' : '-'}</span>`;
            toggle.innerHTML = (
                guides +
                glyphSpan +
                window.SessionStatusUI.folderIconSvg() +
                `<span class="config-editor-node-name${isRoot ? ' config-editor-root-label' : ''}">${this._esc(node.name)}</span>` +
                (node.read_only ? ' <span class="config-editor-badge">read-only</span>' : '')
            );

            const childList = document.createElement('ul');
            childList.className = 'config-editor-list';
            childList.hidden = collapsed;
            let built = false;

            // Populate `childList` exactly once. Lazy-render is about
            // deferring the cost until a node is EXPANDED, not until it is
            // CLICKED - a node that starts expanded (the `~/.claude` and
            // project `.claude` roots do) has to be built here at render
            // time, or it shows an open disclosure over an empty list and
            // needs two clicks to reveal anything.
            const buildChildren = () => {
                if (built) return;
                built = true;
                (node.children || []).forEach(
                    (child) => childList.appendChild(this._buildNodeEl(rootId, child, depth + 1)),
                );
            };
            if (!collapsed) buildChildren();

            toggle.addEventListener('click', () => {
                const nowExpanded = toggle.getAttribute('aria-expanded') !== 'true';
                if (nowExpanded) buildChildren();
                toggle.setAttribute('aria-expanded', String(nowExpanded));
                toggle.querySelector('.config-editor-toggle-glyph').textContent = nowExpanded ? '-' : '+';
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
        btn.dataset.root = rootId;
        btn.dataset.path = node.rel_path;
        btn.dataset.readonly = node.read_only ? '1' : '0';
        btn.dataset.sensitive = node.is_sensitive ? '1' : '0';
        btn.innerHTML = (
            guides +
            '<span class="config-editor-toggle-spacer" aria-hidden="true"></span>' +
            window.SessionStatusUI.fileIconSvg() +
            `<span class="config-editor-node-name">${this._esc(node.name)}</span>` +
            (node.is_executable ? ' <span class="config-editor-badge config-editor-badge--exec">runs automatically</span>' : '') +
            (node.is_sensitive ? ` <span class="config-editor-badge config-editor-badge--sensitive">${window.SessionStatusUI.lockIconSvg()}sensitive</span>` : '')
        );
        btn.addEventListener('click', () => {
            const projectPath = rootId === 'user' ? null : this._currentProjectPath();
            window.ConfigEditorModal.open(rootId, node.rel_path, node.read_only, projectPath);
        });
        li.appendChild(btn);
        return li;
    }

    /**
     * Build the per-depth indentation guide markup for one row: one
     * fixed-width vertical-rule span per ancestor level, so a row's
     * indentation reads as connected tree lines rather than blank
     * left-padding. Purely decorative (aria-hidden).
     * Inputs: depth (number) - 0 for a root node.
     * Output: string - HTML for `depth` guide spans.
     */
    _buildGuides(depth) {
        let html = '';
        for (let i = 0; i < depth; i++) {
            html += '<span class="config-editor-guide" aria-hidden="true"></span>';
        }
        return html;
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
