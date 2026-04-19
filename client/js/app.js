// Main app bootstrap — extracted from index.html for CSP compliance (script-src 'self').
/**
 * App Controller - Manages application state and screen transitions
 */
class AppController {
    constructor() {
        this.currentScreen = null;
        this.logoutBtn = null;
        this.destroyBtn = null;
    }

    /**
     * Initialize application
     */
    async init() {
        console.log('App: Initializing');

        this.logoutBtn = document.getElementById('logoutBtn');
        this.destroyBtn = document.getElementById('destroySessionBtn');

        // Setup event listeners
        this.setupEventListeners();

        // Initialize auth module (always needed first)
        window.Auth.init();

        // Check if user is authenticated
        if (window.Auth.isAuthenticated()) {
            console.log('App: User has token, verifying...');
            const isValid = await window.Auth.verifyToken();
            if (isValid) {
                this.showLaunchpad();
            } else {
                console.log('App: Token invalid, showing auth');
                this.showAuth();
            }
        } else {
            console.log('App: No token, showing auth');
            this.showAuth();
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Auth events
        window.addEventListener('authenticated', () => {
            console.log('App: User authenticated');
            this.showLaunchpad();
        });

        window.addEventListener('auth-required', () => {
            console.log('App: Auth required');
            this.showAuth();
        });

        window.addEventListener('logged-out', () => {
            console.log('App: User logged out');
            this.showAuth();
        });

        // Session events
        window.addEventListener('session-created', (e) => {
            console.log('App: Session created', e.detail);
            this.showTerminal(e.detail.session);
        });

        window.addEventListener('session-destroyed', () => {
            console.log('App: Session destroyed');
            this.showLaunchpad();
        });

        // Title click - navigate back to launchpad (only from terminal)
        const appTitle = document.getElementById('appTitle');
        appTitle.addEventListener('click', () => {
            if (this.currentScreen === 'terminal') {
                console.log('App: Title clicked, navigating to launchpad');
                this.showLaunchpad();
            }
        });
    }

    /**
     * Show auth screen
     */
    showAuth() {
        console.log('App: Showing auth screen');
        this.hideAllScreens();
        document.getElementById('auth-screen').classList.add('active');
        this.logoutBtn.classList.add('hidden');
        this.destroyBtn.classList.add('hidden');
        this.currentScreen = 'auth';
    }

    /**
     * Show launchpad screen
     */
    showLaunchpad() {
        console.log('App: Showing launchpad screen');
        this.hideAllScreens();
        document.getElementById('launchpad-screen').classList.add('active');
        this.logoutBtn.classList.remove('hidden');
        this.destroyBtn.classList.add('hidden');
        this.currentScreen = 'launchpad';

        // Hide D-pad on launchpad
        if (window.DPad) {
            window.DPad.hide();
        }

        // Hide slash command button on launchpad
        if (window.SlashCommandsModal) {
            window.SlashCommandsModal.hide();
        }

        // Initialize launchpad if first time
        if (!window.Launchpad.launchpadScreen) {
            window.Launchpad.init();
        }

        // Reload projects
        window.Launchpad.loadProjects();
    }

    /**
     * Show terminal screen
     */
    async showTerminal(session) {
        console.log('App: Showing terminal screen');
        this.hideAllScreens();
        document.getElementById('terminal-screen').classList.add('active');
        this.logoutBtn.classList.remove('hidden');
        this.destroyBtn.classList.remove('hidden');
        this.currentScreen = 'terminal';

        // Initialize terminal if first time
        if (!window.TerminalController.term) {
            await window.TerminalController.init();
        }

        // Initialize D-pad (mobile only)
        if (window.DPad && !window.DPad.floatingButton) {
            window.DPad.init();
        }

        // Show D-pad on terminal screen
        if (window.DPad) {
            window.DPad.show();
        }

        // Initialize slash commands modal
        if (window.SlashCommandsModal && !window.SlashCommandsModal.button) {
            await window.SlashCommandsModal.init((command) => {
                // Insert command into terminal without Enter
                window.TerminalController.insertText(command);
            });
        }

        // Show slash command button on terminal screen
        if (window.SlashCommandsModal) {
            window.SlashCommandsModal.show();
        }

        // Connect terminal to session
        window.TerminalController.connectToSession(session);
    }

    /**
     * Hide all screens
     */
    hideAllScreens() {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
    }

    /**
     * Logout
     */
    async logout() {
        // Show confirmation modal
        const confirmed = await this.showConfirmModal(
            'logout',
            'are you sure you want to logout?',
            'any active session will be destroyed.'
        );

        if (confirmed) {
            // Destroy active session if exists
            if (window.TerminalController.sessionActive) {
                try {
                    await window.TerminalController.destroySession();
                } catch (error) {
                    console.error('App: Error destroying session during logout:', error);
                }
            }

            // Logout
            window.Auth.logout();
        }
    }

    /**
     * Show confirmation modal
     * @param {string} title - Modal title
     * @param {string} message - Main message
     * @param {string} details - Additional details (optional)
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled
     */
    showConfirmModal(title, message, details = null) {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            // Create modal content
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» ${title}</div>
                    <div class="modal-body">
                        <div class="modal-message">${message}</div>
                        ${details ? `<div class="modal-description">${details}</div>` : ''}
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="modal-cancel">cancel</button>
                        <button class="modal-btn modal-btn-primary" id="modal-confirm">confirm</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const confirmBtn = overlay.querySelector('#modal-confirm');
            const cancelBtn = overlay.querySelector('#modal-cancel');

            // Handle Escape key
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            });

            // Handle confirm button
            confirmBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(true);
            });

            // Handle cancel button
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(false);
            });

            // Handle click outside modal
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            });

            // Focus confirm button
            setTimeout(() => confirmBtn.focus(), 100);
        });
    }
}

// Create app instance
const App = new AppController();

// Initialize on load
window.addEventListener('load', () => {
    App.init();
    // Item 9: kick off deep-link router AFTER App.init() so the
    // auth state is already being resolved. router.js listens
    // for the `authenticated` event to deliver stashed targets.
    if (window.Router && typeof window.Router.init === 'function') {
        window.Router.init();
    }
});
