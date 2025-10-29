/**
 * DPad Module - Virtual D-pad for mobile terminal navigation
 * Provides touch-friendly arrow keys, enter, and directional controls
 */

class DPad {
    constructor() {
        this.isOpen = false;
        this.floatingButton = null;
        this.overlay = null;

        // ANSI escape sequences for terminal navigation
        this.keys = {
            UP: '\x1b[A',
            DOWN: '\x1b[B',
            RIGHT: '\x1b[C',
            LEFT: '\x1b[D',
            ENTER: '\r'
        };
    }

    /**
     * Initialize the D-pad (only on mobile)
     */
    init() {
        if (!this.isMobile()) {
            console.log('DPad: Desktop detected, not initializing');
            return;
        }

        console.log('DPad: Mobile detected, initializing');
        this.createFloatingButton();
    }

    /**
     * Check if device is mobile
     */
    isMobile() {
        return window.innerWidth <= 768 ||
               ('ontouchstart' in window) ||
               (navigator.maxTouchPoints > 0);
    }

    /**
     * Create the floating button
     */
    createFloatingButton() {
        this.floatingButton = document.createElement('button');
        this.floatingButton.id = 'dpad-float-btn';
        this.floatingButton.className = 'dpad-float-button';
        this.floatingButton.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M8 4H12V8H16V12H12V16H8V12H4V8H8V4Z" stroke="#d77757" stroke-width="1.5" stroke-linejoin="round"/>
                <circle cx="10" cy="10" r="1" fill="#d77757"/>
            </svg>
        `;

        this.floatingButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.open();
        });

        document.body.appendChild(this.floatingButton);
    }

    /**
     * Open the D-pad overlay
     */
    open() {
        if (this.isOpen) return;

        this.isOpen = true;
        this.createOverlay();

        // Hide floating button while overlay is open
        if (this.floatingButton) {
            this.floatingButton.style.display = 'none';
        }
    }

    /**
     * Close the D-pad overlay
     */
    close() {
        if (!this.isOpen) return;

        this.isOpen = false;

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        // Show floating button again
        if (this.floatingButton) {
            this.floatingButton.style.display = 'flex';
        }
    }

    /**
     * Create the D-pad overlay
     */
    createOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'dpad-overlay';

        this.overlay.innerHTML = `
            <div class="dpad-container">
                <button class="dpad-close" data-action="close">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M6 6L18 18M18 6L6 18" stroke="#d77757" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                </button>

                <div class="dpad-grid">
                    <div class="dpad-row">
                        <div class="dpad-spacer"></div>
                        <button class="dpad-key" data-key="UP">
                            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                                <path d="M16 10L16 22M10 16L16 10L22 16" stroke="#d77757" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="dpad-spacer"></div>
                    </div>

                    <div class="dpad-row">
                        <button class="dpad-key" data-key="LEFT">
                            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                                <path d="M22 16L10 16M16 10L10 16L16 22" stroke="#d77757" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <button class="dpad-key dpad-enter" data-key="ENTER">
                            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                                <path d="M10 16h12M22 16l-4 4M22 16l-4-4" stroke="#d77757" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <button class="dpad-key" data-key="RIGHT">
                            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                                <path d="M10 16L22 16M16 10L22 16L16 22" stroke="#d77757" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>

                    <div class="dpad-row">
                        <div class="dpad-spacer"></div>
                        <button class="dpad-key" data-key="DOWN">
                            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                                <path d="M16 22L16 10M10 16L16 22L22 16" stroke="#d77757" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="dpad-spacer"></div>
                    </div>
                </div>
            </div>
        `;

        // Add event listeners
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        // Key buttons
        this.overlay.querySelectorAll('.dpad-key').forEach(btn => {
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                btn.classList.add('active');

                const key = btn.dataset.key;
                this.sendKey(key);
            });

            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                btn.classList.remove('active');
            });

            // Also support click for testing on desktop
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const key = btn.dataset.key;
                this.sendKey(key);
            });
        });

        // Close button
        const closeBtn = this.overlay.querySelector('.dpad-close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        document.body.appendChild(this.overlay);
    }

    /**
     * Send key to terminal
     */
    sendKey(keyName) {
        const keyCode = this.keys[keyName];

        if (!keyCode) {
            console.error('DPad: Unknown key:', keyName);
            return;
        }

        if (!window.TerminalController) {
            console.error('DPad: TerminalController not found');
            return;
        }

        console.log('DPad: Sending key:', keyName);
        window.TerminalController.sendKeyToTerminal(keyCode);
    }

    /**
     * Show the floating button
     */
    show() {
        if (this.floatingButton) {
            this.floatingButton.style.display = 'flex';
        }
    }

    /**
     * Hide the floating button
     */
    hide() {
        if (this.floatingButton) {
            this.floatingButton.style.display = 'none';
        }
        this.close();
    }

    /**
     * Destroy the D-pad
     */
    destroy() {
        this.close();

        if (this.floatingButton) {
            this.floatingButton.remove();
            this.floatingButton = null;
        }
    }
}

// Export as singleton
window.DPad = new DPad();
