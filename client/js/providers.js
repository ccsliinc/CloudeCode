/**
 * Provider Selector Modal (client/js/providers.js)
 *
 * Shown before every real launch (new project, open-folder, clone-github,
 * existing-project row click). Lets the user pick "claude" (pinned, always
 * first) or an OpenRouter model, and manage the model list inline — no
 * separate settings screen.
 *
 * Split out of launchpad.js to keep that file under its line budget.
 * Attaches showProviderModal() onto the existing window.Launchpad instance
 * so the two gated call sites (`this.showProviderModal()` in
 * _createNewSessionInner / selectProject) work unchanged. Must load AFTER
 * launchpad.js (see client/index.html script order) so window.Launchpad
 * and its _escapeHtml / showConfirmModal helpers already exist.
 *
 * Reuses the folder-picker's list markup/CSS (.folder-picker-list,
 * .folder-picker-item, .folder-picker-item-active, .folder-picker-status)
 * and its keyboard-nav + capture-phase Escape pattern
 * (client/js/launchpad.js showFolderPickerModal) rather than inventing a
 * new visual language or a new nav implementation.
 */
(function () {
    // Single localStorage key: '' (or absent) = claude, else the model id.
    const LAST_MODEL_KEY = 'cloude_provider_last_model';

    // Same guard as the server (src/models.py MODEL_ID_PATTERN /
    // is_valid_model_id) — enforced here too so bad input never leaves
    // the browser, but the server remains authoritative (shell-injection
    // guard). The (?!-) lookahead blocks a leading '-', which would
    // otherwise slip past cldor's own "$1" != -* guard and get forwarded
    // as an injected flag to claude --dangerously-skip-permissions.
    const MODEL_ID_RE = /^(?!-)[A-Za-z0-9._~/-]{1,120}$/;

    function readLastChoice() {
        try {
            return localStorage.getItem(LAST_MODEL_KEY) || '';
        } catch (_) {
            return '';
        }
    }

    function rememberChoice(model) {
        try {
            localStorage.setItem(LAST_MODEL_KEY, model || '');
        } catch (_) {
            // localStorage unavailable (private mode, quota) — non-fatal,
            // just means next launch won't pre-select this choice.
        }
    }

    /**
     * Show the provider selector modal.
     * @returns {Promise<{model: string|null, wrapperId?: string}|null>}
     *   null = cancelled (abort the launch). {model: null} = claude via
     *   the default launch wrapper (or the legacy cld/claude_command
     *   fallback if no wrappers are configured — see
     *   Settings.get_agent_command). {model: "..."} = OpenRouter model
     *   id. {model: null, wrapperId: "..."} = a specific non-default
     *   launch wrapper (feat/launch-wrappers) — its id is forwarded as
     *   agent_type by the launchpad caller.
     */
    function showProviderModal() {
        return new Promise((resolve) => {
            const escapeHtml = (s) => window.Launchpad._escapeHtml(s);

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» select provider</div>
                    <div class="modal-body">
                        <div class="folder-picker-list" id="provider-list" tabindex="-1">
                            <div class="folder-picker-empty">loading...</div>
                        </div>
                        <div class="folder-picker-status" id="provider-status" role="status" aria-live="polite"></div>
                        <div class="modal-description">
                            ↑/↓ to move · Enter to launch · type to jump · Esc to cancel
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const listEl = overlay.querySelector('#provider-list');
            const statusEl = overlay.querySelector('#provider-status');

            let models = [];       // OpenRouter model ids (claude is NOT in this array)
            let wrappers = [];     // feat/launch-wrappers — non-default wrappers only (id 'claude' excluded; the plain claude row already resolves through the default wrapper)
            let items = [];        // flat nav list: claude row, wrapper rows, model rows, add row
            let activeIndex = -1;
            let currentModel = readLastChoice(); // '' = claude, else a model id
            let typeBuffer = '';
            let typeTimer = null;
            let confirmPending = false; // suspends our keys while showConfirmModal owns them
            let addInputOpen = false;

            const close = (value) => {
                document.removeEventListener('keydown', onKeyDown, true);
                if (typeTimer) clearTimeout(typeTimer);
                document.body.removeChild(overlay);
                resolve(value);
            };

            const clearStatus = () => {
                statusEl.textContent = '';
                statusEl.className = 'folder-picker-status';
            };
            const showStatus = (msg, kind) => {
                statusEl.textContent = msg;
                statusEl.className = `folder-picker-status folder-picker-status--${kind || 'info'}`;
            };

            const buildItems = () => {
                items = [{ type: 'claude' }]
                    .concat(wrappers.map((w) => ({ type: 'wrapper', wrapperId: w.id, label: w.label })))
                    .concat(models.map((m) => ({ type: 'model', model: m })))
                    .concat([{ type: 'add' }]);
            };

            const findIndexForModel = (model) => {
                if (!model) return 0; // claude is always index 0
                const idx = items.findIndex((it) => it.type === 'model' && it.model === model);
                return idx >= 0 ? idx : 0; // fallback to claude if it's gone (e.g. just removed)
            };

            const setActive = (idx, { scroll = true } = {}) => {
                const els = listEl.querySelectorAll('.folder-picker-item');
                if (!els.length) { activeIndex = -1; return; }
                idx = Math.max(0, Math.min(idx, els.length - 1));
                els.forEach((el, i) => el.classList.toggle('folder-picker-item-active', i === idx));
                activeIndex = idx;
                const item = items[idx];
                if (item && (item.type === 'claude' || item.type === 'model')) {
                    currentModel = item.type === 'claude' ? '' : item.model;
                }
                if (scroll) els[idx].scrollIntoView({ block: 'nearest' });
            };

            const activateItem = (idx) => {
                const item = items[idx];
                if (!item) return;
                if (item.type === 'add') {
                    openAddInput();
                    return;
                }
                if (item.type === 'wrapper') {
                    // Not remembered in localStorage (that store is
                    // model-only, feat/launch-wrappers doesn't extend it)
                    // — a wrapper choice is per-launch, not sticky.
                    close({ model: null, wrapperId: item.wrapperId });
                    return;
                }
                const model = item.type === 'claude' ? null : item.model;
                rememberChoice(model || '');
                close({ model });
            };

            const render = () => {
                buildItems();
                listEl.innerHTML = items.map((item, i) => {
                    if (item.type === 'claude') {
                        return `<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">◆</span>
                            <span class="folder-picker-name provider-item-name">claude</span>
                        </div>`;
                    }
                    if (item.type === 'wrapper') {
                        const safeLabel = escapeHtml(item.label);
                        return `<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">»</span>
                            <span class="folder-picker-name provider-item-name">${safeLabel}</span>
                        </div>`;
                    }
                    if (item.type === 'model') {
                        const safe = escapeHtml(item.model);
                        return `<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">◇</span>
                            <span class="folder-picker-name provider-item-name">${safe}</span>
                            <button type="button" class="provider-item-remove" data-remove="${safe}" title="remove ${safe}" aria-label="remove ${safe}">×</button>
                        </div>`;
                    }
                    return `<div class="folder-picker-item provider-add-row" data-index="${i}">
                        <span class="folder-picker-icon">+</span>
                        <span class="folder-picker-name provider-item-name">add model</span>
                    </div>`;
                }).join('');

                listEl.querySelectorAll('.folder-picker-item').forEach((el) => {
                    const idx = parseInt(el.dataset.index, 10);
                    el.addEventListener('mousemove', () => {
                        if (idx !== activeIndex) setActive(idx, { scroll: false });
                    });
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.provider-item-remove')) return;
                        setActive(idx);
                        activateItem(idx);
                    });
                });
                listEl.querySelectorAll('.provider-item-remove').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        removeModel(btn.dataset.remove);
                    });
                });

                setActive(findIndexForModel(currentModel), { scroll: false });
            };

            const removeModel = async (model) => {
                confirmPending = true;
                const ok = await window.Launchpad.showConfirmModal(
                    'remove model',
                    `remove "${model}" from the provider list?`,
                    null,
                    'remove',
                    'cancel'
                );
                confirmPending = false;
                if (!ok) return;
                try {
                    const data = await window.API.removeProviderModel(model);
                    models = Array.isArray(data.models) ? data.models : models.filter((m) => m !== model);
                    clearStatus();
                    render();
                    listEl.focus();
                } catch (error) {
                    showStatus(error.message || String(error), 'error');
                }
            };

            const openAddInput = () => {
                if (addInputOpen) return;
                addInputOpen = true;
                clearStatus();
                const addRowEl = listEl.querySelector('.provider-add-row');
                if (!addRowEl) { addInputOpen = false; return; }
                addRowEl.innerHTML = `
                    <input type="text" class="provider-add-input" id="provider-add-input"
                           spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"
                           aria-label="new model id" placeholder="provider/model-id">
                `;
                const input = addRowEl.querySelector('#provider-add-input');
                input.addEventListener('click', (e) => e.stopPropagation());
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        submitAdd(input.value.trim());
                    }
                    // Escape is handled by the shared capture-phase listener
                    // below (closes just this input, not the whole modal).
                });
                setTimeout(() => input.focus(), 0);
            };

            const closeAddInput = () => {
                if (!addInputOpen) return;
                addInputOpen = false;
                clearStatus();
                render();
                listEl.focus();
            };

            const submitAdd = async (value) => {
                if (!value) return;
                if (!MODEL_ID_RE.test(value)) {
                    showStatus('invalid model id — use letters, numbers, . _ ~ / -', 'error');
                    return;
                }
                try {
                    const data = await window.API.addProviderModel(value);
                    models = Array.isArray(data.models) ? data.models : models.concat([value]);
                    addInputOpen = false;
                    clearStatus();
                    render();
                    listEl.focus();
                } catch (error) {
                    if (error && error.status === 409) {
                        showStatus(`"${value}" is already in the list`, 'error');
                    } else if (error && error.status === 400) {
                        showStatus(error.message || 'invalid model id', 'error');
                    } else {
                        showStatus(error.message || String(error), 'error');
                    }
                }
            };

            // Modal-wide key handling (capture phase so it works no matter
            // which child holds focus, and reliably fires on Escape even
            // when nothing inside the overlay has DOM focus — the bug in
            // showConfirmModal's overlay-scoped listener). Removed on close.
            const onKeyDown = (e) => {
                // A confirm sub-modal (remove) is open on top of us — let
                // IT own every key until it resolves, so its own Escape/
                // Enter don't also get intercepted here.
                if (confirmPending) return;

                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (addInputOpen) { closeAddInput(); return; }
                    close(null);
                    return;
                }

                // While typing a new model id, let the input own its keystrokes.
                if (document.activeElement && document.activeElement.id === 'provider-add-input') return;

                const ae = document.activeElement;
                if (ae && ae.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive(activeIndex < 0 ? 0 : activeIndex + 1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive(activeIndex < 0 ? items.length - 1 : activeIndex - 1);
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (activeIndex >= 0) activateItem(activeIndex);
                    return;
                }

                // Type-ahead: printable single chars only, no modifier combos.
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    typeBuffer += e.key.toLowerCase();
                    if (typeTimer) clearTimeout(typeTimer);
                    typeTimer = setTimeout(() => { typeBuffer = ''; }, 800);
                    const matchIdx = items.findIndex((it) => {
                        const label = it.type === 'claude' ? 'claude'
                            : it.type === 'wrapper' ? it.label
                            : it.type === 'model' ? it.model
                            : '';
                        return label && label.toLowerCase().startsWith(typeBuffer);
                    });
                    if (matchIdx >= 0) setActive(matchIdx);
                }
            };
            document.addEventListener('keydown', onKeyDown, true);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });

            // Load the model list, then render. Default focus goes to the
            // LIST (not any input) so Enter re-launches the pre-selected
            // choice with zero clicks.
            (async () => {
                try {
                    const data = await window.API.getProviders();
                    models = Array.isArray(data.models) ? data.models : [];
                } catch (error) {
                    console.error('Launchpad: Failed to load providers:', error);
                    models = [];
                    showStatus('could not load saved models — showing claude only', 'error');
                }
                // feat/launch-wrappers — best-effort: a failure here just
                // means no wrapper rows show up (claude + models still
                // work), never blocks the launch gate.
                try {
                    const wrapperData = await window.API.listWrappers();
                    const all = Array.isArray(wrapperData.wrappers) ? wrapperData.wrappers : [];
                    wrappers = all.filter((w) => w.id !== 'claude');
                } catch (error) {
                    console.error('Launchpad: Failed to load wrappers:', error);
                    wrappers = [];
                }
                render();
                setTimeout(() => listEl.focus(), 100);
            })();
        });
    }

    window.Launchpad.showProviderModal = showProviderModal;
})();
