/**
 * Slash Commands Module
 *
 * Handles the slash command quick-access modal. The command LIST is no
 * longer hand-written here (see git history for the retired
 * `ALL_SLASH_COMMANDS` array) — it comes from the server's
 * `GET /config/slash-commands`, which merges the release-time scraped
 * official command list with runtime discovery of this user's own
 * commands/skills, installed plugins, and (when a project is open) that
 * project's own commands/skills. See `src/core/slash_command_discovery.py`
 * and `scripts/scrape-slash-commands.py` for where the data comes from.
 *
 * Open/close behavior (button, lazy modal creation, overlay-click-to-close,
 * Escape-to-close) is UNCHANGED from before this module was rewritten.
 * What's new: groups render from server data, and once the modal is open,
 * typing in the filter input live-filters the list (command name +
 * description), with arrow-key/Enter navigation over the visible results.
 */

console.log('[SlashCommands Module] Loading...');

class SlashCommandsModal {
    constructor() {
        this.commonCommands = [];
        // Parallel to commonCommands: [{command, description}] with the
        // SHORT chip description. See _loadCommonCommands().
        this.commonCommandDetails = [];
        this.groups = [];
        // Flat command -> record lookup built from `this.groups`, used
        // for the common-commands button tooltips and for resolving a
        // bare command string back to its full record.
        this.commandIndex = new Map();
        this.modal = null;
        this.button = null;
        this.isOpen = false;
        this.onCommandSelect = null;
        this.projectPath = null;

        // Live-filter + keyboard-nav state (Task 4) — see
        // client/js/slash-command-filter.js. Owns the DOM indexing,
        // filtering, and arrow-key bookkeeping over the rendered list.
        this.filter = new window.SlashCommandFilter();
    }

    /**
     * Initialize the slash commands modal
     *
     * Description: fetches the common-commands "favorites" row and the
     *   full grouped command palette from the server, then creates the
     *   floating button. Does NOT create the modal itself — that still
     *   happens lazily on first open() (unchanged from before).
     * Inputs:
     *   onCommandSelect (function(string): void) - called with the bare
     *     command string (e.g. "/clear") when the user picks one.
     *   projectPath (string|null) - absolute path of the active project's
     *     working directory, forwarded to the server for project-scope
     *     command/skill discovery. Optional; omit when no project is open.
     * Output: Promise<void>.
     */
    async init(onCommandSelect, projectPath = null) {
        console.log('[SlashCommands] Initializing (NOT creating modal yet)');
        this.onCommandSelect = onCommandSelect;
        this.projectPath = projectPath || null;

        await Promise.all([
            this._loadCommonCommands(),
            this._loadGroups(),
        ]);

        console.log('[SlashCommands] Initialization complete (modal will be created on demand)');
        this.createButton();
    }

    /**
     * Fetch the common-commands "favorites" row. Falls back to a fixed
     * default set on any failure so the row is never empty.
     * Inputs: none. Output: Promise<void> (sets this.commonCommands).
     */
    async _loadCommonCommands() {
        try {
            const response = await window.API.getCommonCommands();
            this.commonCommands = response.commands || [];
            // `command_details` is the newer parallel array carrying the
            // short description for each chip. Servers predating it send
            // only `commands`, so fall back to bare entries rather than
            // rendering nothing.
            this.commonCommandDetails = Array.isArray(response.command_details)
                ? response.command_details
                : this.commonCommands.map(c => ({ command: c, description: '' }));
            console.log('[SlashCommands] Fetched', this.commonCommands.length, 'common commands');
        } catch (error) {
            console.error('[SlashCommands] Failed to fetch common commands:', error);
            this.commonCommands = [
                '/agents', '/clear', '/compact', '/context',
                '/hooks', '/mcp', '/resume', '/rewind', '/usage'
            ];
            this.commonCommandDetails = this.commonCommands.map(
                c => ({ command: c, description: '' })
            );
        }
    }

    /**
     * Fetch the full grouped command palette and rebuild the flat lookup
     * index used for tooltips and filtering. Falls back to an empty group
     * list on failure — the modal still opens, just with an explanatory
     * empty state (see renderAllCommands).
     * Inputs: none. Output: Promise<void> (sets this.groups, this.commandIndex).
     */
    async _loadGroups() {
        try {
            const response = await window.API.getSlashCommands(this.projectPath);
            this.groups = Array.isArray(response.groups) ? response.groups : [];
            console.log('[SlashCommands] Fetched', this.groups.length, 'command groups');
        } catch (error) {
            console.error('[SlashCommands] Failed to fetch slash command groups:', error);
            this.groups = [];
        }
        this.commandIndex = new Map();
        for (const group of this.groups) {
            for (const cmd of (group.commands || [])) {
                this.commandIndex.set(cmd.command, cmd);
            }
        }
    }

    /**
     * Create the floating slash command button
     */
    createButton() {
        if (this.button) {
            console.log('[SlashCommands] Button already exists');
            return;
        }

        this.button = document.createElement('button');
        this.button.id = 'slash-commands-btn';
        this.button.className = 'slash-commands-btn';
        this.button.setAttribute('aria-label', 'Open Slash Commands');
        this.button.setAttribute('title', 'Open Slash Commands');
        this.button.style.display = 'none'; // Hidden by default

        // Set initial icon (slash)
        this.updateButtonIcon();

        this.button.addEventListener('click', () => {
            if (this.isOpen) {
                this.close();
            } else {
                this.open();
            }
        });

        document.body.appendChild(this.button);
        console.log('[SlashCommands] Button created and added to DOM');
    }

    /**
     * Update button icon based on open/closed state
     */
    updateButtonIcon() {
        if (!this.button) return;

        if (this.isOpen) {
            // X icon (close)
            this.button.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M6 6L18 18M18 6L6 18" stroke="#d77757" stroke-width="2" stroke-linecap="round"/>
                </svg>
            `;
        } else {
            // Slash icon (open)
            this.button.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M14 4L10 20" stroke="#d77757" stroke-width="2.5" stroke-linecap="round"/>
                </svg>
            `;
        }
    }

    /**
     * Show the button
     */
    show() {
        if (this.button) {
            this.button.style.display = 'flex';
        }
    }

    /**
     * Hide the button
     */
    hide() {
        if (this.button) {
            this.button.style.display = 'none';
        }
    }

    /**
     * Create the modal HTML structure
     * Note: Content is nested INSIDE overlay (like D-pad pattern)
     */
    createModal() {
        console.log('[SlashCommands] createModal() called');

        const modalHTML = `
            <div id="slash-commands-modal" class="modal" style="display: none;">
                <div class="modal-overlay">
                    <div class="modal-content slash-commands-modal-content">
                        <div class="modal-header">
                            <h2>/ Slash Commands</h2>
                            <button class="modal-close" aria-label="Close modal" title="Close modal">&times;</button>
                        </div>
                        <div class="modal-body">
                            <div class="common-commands-section">
                                <div class="common-commands-grid" id="common-commands-grid">
                                    ${this.renderCommonCommands()}
                                </div>
                            </div>
                            <div class="all-commands-section">
                                <h3>all commands</h3>
                                <input
                                    type="text"
                                    id="slash-command-filter"
                                    class="command-filter-input"
                                    placeholder="type to filter..."
                                    autocomplete="off"
                                    aria-label="Filter commands"
                                />
                                <div class="all-commands-list" id="all-commands-list">
                                    ${this.renderAllCommands()}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Remove existing modal if any
        const existingModal = document.getElementById('slash-commands-modal');
        if (existingModal) {
            console.log('[SlashCommands] Removing existing modal');
            existingModal.remove();
        }

        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.modal = document.getElementById('slash-commands-modal');
        console.log('[SlashCommands] Modal added to DOM:', this.modal ? 'success' : 'FAILED');
        this.filter.index(this.modal);
    }

    /**
     * Description: render the common-commands "favorites" row as chips.
     *   Each chip shows the command name plus a SHORT description on a
     *   second line. The description is the whole point of the change:
     *   the row used to carry the full scraped description in a `title`
     *   attribute only, which is invisible on a phone (no hover) and far
     *   too long to render inline. The short text comes from the server's
     *   `command_details` (see src/core/slash_command_labels.py), which
     *   caps length so the chip stays one line and the row stays above
     *   the fold. The long description is still available on hover via
     *   `title` for desktop users.
     * Inputs: none (reads this.commonCommandDetails).
     * Output: string - HTML for the chip grid.
     */
    renderCommonCommands() {
        const details = this.commonCommandDetails || [];
        console.log('[SlashCommands] renderCommonCommands() called with', details.length, 'commands');

        if (details.length === 0) {
            console.warn('[SlashCommands] No common commands to render!');
            return '<div class="common-commands-empty">no common commands configured</div>';
        }

        return details.map(entry => {
            const cmd = entry.command;
            const short = entry.description || '';
            // Full description (scraped docs / user command frontmatter)
            // stays as the hover tooltip; short text is what renders.
            const cmdInfo = this.commandIndex.get(cmd);
            const longDescription = (cmdInfo && cmdInfo.description) || short;
            const shortHtml = short
                ? `<span class="command-button-desc">${this._escapeHtml(short)}</span>`
                : '';
            return `
                <button class="command-button" data-command="${this._escapeHtml(cmd)}" title="${this._escapeHtml(longDescription)}">
                    <span class="command-button-name">${this._escapeHtml(cmd)}</span>
                    ${shortHtml}
                </button>
            `;
        }).join('');
    }

    /**
     * Render all commands grouped by the server-derived groups (Task 3).
     * Each group becomes a `.command-category`; unchanged markup/classes
     * from the previous hand-curated-category rendering so existing CSS
     * applies without modification.
     */
    renderAllCommands() {
        if (!this.groups || this.groups.length === 0) {
            return '<div style="color: #858585; padding: 12px; text-align: center;">no commands available</div>';
        }

        return this.groups.map(group => {
            const commands = group.commands || [];
            if (commands.length === 0) return '';
            return `
                <div class="command-category" data-group-id="${this._escapeHtml(group.id)}">
                    <h4 class="category-title">${this._escapeHtml(group.label)}</h4>
                    ${commands.map(cmd => {
                        const display = cmd.args ? `${cmd.command} ${cmd.args}` : cmd.command;
                        return `
                        <div class="command-item" data-command="${this._escapeHtml(cmd.command)}">
                            <span class="command-name">${this._escapeHtml(display)}</span>
                            <span class="command-description">${this._escapeHtml(cmd.description)}</span>
                        </div>
                    `;
                    }).join('')}
                </div>
            `;
        }).join('');
    }

    /**
     * HTML-escape helper — command descriptions/labels come from scraped
     * docs and user-authored files, both effectively untrusted input for
     * innerHTML purposes.
     */
    _escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        if (!this.modal) return;

        // Close button
        const closeBtn = this.modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        // Overlay click to close.
        //
        // Routed through DismissGuard.onOverlayDismiss instead of a bare
        // `click -> close()`. The bare form fired for ANY click that
        // bubbled up, including clicks on the filter input three levels
        // down, so clicking the search box closed the whole menu and it
        // could never be typed into. See client/js/dismiss-guard.js.
        const overlay = this.modal.querySelector('.modal-overlay');
        if (overlay) {
            window.DismissGuard.onOverlayDismiss(overlay, () => this.close());
        }

        // Common command buttons
        const commandButtons = this.modal.querySelectorAll('.command-button');
        commandButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const command = btn.dataset.command;
                this.selectCommand(command);
            });
        });

        // All commands items — click-to-select path, unchanged.
        const commandItems = this.modal.querySelectorAll('.command-item');
        commandItems.forEach(item => {
            item.addEventListener('click', () => {
                const command = item.dataset.command;
                this.selectCommand(command);
            });
        });

        // Live filter (Task 4) — typing filters the list; arrow keys and
        // Enter navigate/select the visible results. Escape is NOT
        // handled here — it bubbles to the document-level listener below,
        // which already closes the modal regardless of focus.
        const filterInput = this.modal.querySelector('#slash-command-filter');
        if (filterInput) {
            filterInput.addEventListener('input', () => {
                this.filter.apply(filterInput.value);
            });
            filterInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.filter.moveActive(1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.filter.moveActive(-1);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const target = this.filter.getEnterTarget();
                    if (target) this.selectCommand(target.command);
                }
            });
        }

        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }

    /**
     * Open the modal (creates it on first call)
     */
    open() {
        console.log('[SlashCommands] open() called');

        // Lazy initialization - create modal on first open
        if (!this.modal) {
            console.log('[SlashCommands] Modal does not exist yet, creating now...');
            this.createModal();
            this.attachEventListeners();
            console.log('[SlashCommands] Modal created and event listeners attached');
        }

        if (!this.modal) {
            console.error('[SlashCommands] Failed to create modal!');
            return;
        }

        // Reset any filter left over from a previous open, so reopening
        // always starts showing the full list.
        const filterInput = this.modal.querySelector('#slash-command-filter');
        if (filterInput) filterInput.value = '';
        this.filter.apply('');

        console.log('[SlashCommands] Adding .active class to show modal');
        this.modal.classList.add('active');
        this.isOpen = true;

        // Update button icon to X
        this.updateButtonIcon();
    }

    /**
     * Close the modal
     */
    close() {
        console.log('[SlashCommands] close() called');
        if (!this.modal) {
            console.log('[SlashCommands] No modal to close');
            return;
        }
        console.log('[SlashCommands] Removing .active class to hide modal');
        this.modal.classList.remove('active');
        this.isOpen = false;

        // Update button icon back to slash
        this.updateButtonIcon();
    }

    /**
     * Handle command selection
     */
    selectCommand(command) {
        if (this.onCommandSelect) {
            this.onCommandSelect(command);
        }
        this.close();

        // Focus terminal to open keyboard on mobile
        setTimeout(() => {
            const terminal = document.querySelector('.xterm-helper-textarea');
            if (terminal) {
                terminal.focus();
            }
        }, 100);
    }
}

// Export singleton instance
window.SlashCommandsModal = new SlashCommandsModal();
console.log('[SlashCommands Module] Exported as window.SlashCommandsModal');
