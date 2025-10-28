/**
 * Launchpad Module - Project selection UI with terminal aesthetic
 */

class Launchpad {
    constructor() {
        this.launchpadScreen = null;
        this.projects = [];
    }

    /**
     * Initialize launchpad screen
     */
    init() {
        this.launchpadScreen = document.getElementById('launchpad-screen');
        this.renderLaunchpadUI();
    }

    /**
     * Load and display projects
     */
    async loadProjects() {
        try {
            this.projects = await window.API.getProjects();
            this.renderProjectList();
        } catch (error) {
            console.error('Launchpad: Failed to load projects:', error);
            this.showError('failed to load projects: ' + error.message);
        }
    }

    /**
     * Render launchpad UI structure
     */
    renderLaunchpadUI() {
        this.launchpadScreen.innerHTML = `
            <div class="launchpad-container">
                <div class="launchpad-header">☁️ claude code launcher</div>
                <div class="launchpad-prompt">select a project or create a new session</div>

                <div class="launchpad-section">
                    <div class="launchpad-section-title">► new session</div>
                    <button class="new-session-btn" id="new-session-btn">
                        <span>⚡</span>
                        <span>create new session with auto-generated workspace</span>
                    </button>
                </div>

                <div class="launchpad-section" id="projects-section">
                    <div class="launchpad-section-title">► existing projects</div>
                    <div id="project-list" class="project-list">
                        <div class="launchpad-empty">loading projects...</div>
                    </div>
                </div>
            </div>
        `;

        // Event listeners
        document.getElementById('new-session-btn').addEventListener('click', () => {
            this.createNewSession();
        });

        // Load projects
        this.loadProjects();
    }

    /**
     * Render project list
     */
    renderProjectList() {
        const projectListEl = document.getElementById('project-list');

        if (this.projects.length === 0) {
            projectListEl.innerHTML = `
                <div class="launchpad-empty">
                    no projects configured yet<br>
                    <small style="color: #666;">edit ~/.claude-tunnel/config.json to add projects</small>
                </div>
            `;
            return;
        }

        // Render projects
        projectListEl.innerHTML = this.projects.map((project, index) => {
            const description = project.description || 'no description';
            return `
                <div class="project-item" data-index="${index}">
                    <div class="project-name">» ${project.name}</div>
                    <div class="project-path">${project.path}</div>
                    <div class="project-description">${description}</div>
                </div>
            `;
        }).join('');

        // Add click handlers
        const projectItems = projectListEl.querySelectorAll('.project-item');
        projectItems.forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.selectProject(this.projects[index]);
            });
        });
    }

    /**
     * Create new session with auto-generated workspace
     */
    async createNewSession() {
        console.log('Launchpad: Creating new session');

        try {
            // Show loading state
            this.updateStatus('creating new session...');

            // Create session with auto-generated path and template copying
            const session = await window.API.createSession({
                auto_start_claude: true,
                copy_templates: true
            });

            console.log('Launchpad: New session created:', session);

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to create session:', error);
            this.showError('failed to create session: ' + error.message);
        }
    }

    /**
     * Select and open existing project
     */
    async selectProject(project) {
        console.log('Launchpad: Selecting project:', project.name);

        try {
            // Show loading state
            this.updateStatus(`opening ${project.name}...`);

            // Create session with project path (no template copying for existing projects)
            const session = await window.API.createSession({
                working_dir: project.path,
                auto_start_claude: true,
                copy_templates: false
            });

            console.log('Launchpad: Project session created:', session);

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session, project }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to open project:', error);
            this.showError(`failed to open ${project.name}: ${error.message}`);
        }
    }

    /**
     * Update status message
     */
    updateStatus(message) {
        const statusEl = document.getElementById('statusText');
        if (statusEl) {
            statusEl.setAttribute('data-status', message);
        }
        console.log('Launchpad:', message);
    }

    /**
     * Show error message
     */
    showError(message) {
        // For now, just log and use browser alert
        // Could be improved with a proper error UI element
        console.error('Launchpad Error:', message);
        alert(`Error: ${message}`);
    }
}

// Export singleton instance
window.Launchpad = new Launchpad();
