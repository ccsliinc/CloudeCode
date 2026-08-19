/**
 * Provider Selector Modal (client/js/providers.js)
 *
 * Shown before every real launch (new project, open-folder, clone-github,
 * existing-project row click). Lets the user pick "claude" (pinned, always
 * first), an OpenRouter model (add/remove inline), or a model currently
 * loaded on the local LM Studio box (live-fetched, read-only) — no
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
    // '' (or absent) = claude, else the model id.
    const LAST_MODEL_KEY = 'cloude_provider_last_model';
    // Which backend that remembered id belongs to: '' = claude,
    // 'openrouter' or 'local'. Stored SEPARATELY so an install that
    // predates local support (model key set, provider key absent) still
    // reads back as an OpenRouter pick — which is exactly what it was.
    // Without this, a remembered local model would relaunch as OpenRouter.
    const LAST_PROVIDER_KEY = 'cloude_provider_last_provider';

    // Same guard as the server (src/models.py MODEL_ID_PATTERN /
    // is_valid_model_id) — enforced here too so bad input never leaves
    // the browser, but the server remains authoritative (shell-injection
    // guard). The (?!-) lookahead blocks a leading '-', which would
    // otherwise slip past cldor's own "$1" != -* guard and get forwarded
    // as an injected flag to claude --dangerously-skip-permissions.
    const MODEL_ID_RE = /^(?!-)[A-Za-z0-9._~/-]{1,120}$/;

    /**
     * @returns {{model: string, provider: string}} model '' = claude.
     *   provider is normalised to 'openrouter' for any pre-existing
     *   remembered model that has no provider key yet.
     */
    function readLastChoice() {
        try {
            const model = localStorage.getItem(LAST_MODEL_KEY) || '';
            if (!model) return { model: '', provider: '' };
            const provider = localStorage.getItem(LAST_PROVIDER_KEY) || '';
            return { model, provider: provider === 'local' ? 'local' : 'openrouter' };
        } catch (_) {
            return { model: '', provider: '' };
        }
    }

    function rememberChoice(model, provider) {
        try {
            localStorage.setItem(LAST_MODEL_KEY, model || '');
            localStorage.setItem(LAST_PROVIDER_KEY, model ? (provider || '') : '');
        } catch (_) {
            // localStorage unavailable (private mode, quota) — non-fatal,
            // just means next launch won't pre-select this choice.
        }
    }

    /**
     * Show the provider selector modal.
     * @returns {Promise<{model: string|null, provider: string|null}|null>}
     *   null = cancelled (abort the launch).
     *   {model: null, provider: null} = claude.
     *   {model: "...", provider: "openrouter"} = OpenRouter model id.
     *   {model: "...", provider: "local"} = LM Studio model id.
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
            let localModels = [];  // model ids currently loaded on the LM Studio box
            let localHost = '';    // "host:port" the server probed, for the unreachable note
            let localError = '';   // short reason, only when localState === 'unreachable'
            let localState = 'loading'; // 'loading' | 'ready' | 'unreachable'
            let items = [];        // flat nav list: claude row, model rows, add row, local rows
            let activeIndex = -1;
            const lastChoice = readLastChoice();
            let currentModel = lastChoice.model;       // '' = claude, else a model id
            let currentProvider = lastChoice.provider; // '' | 'openrouter' | 'local'
            // The remembered choice, held until it can actually be matched.
            // A cached LOCAL model is unmatchable until the LM Studio probe
            // lands (it resolves after the first render), so the restore has
            // to survive that first render and be retried on the second.
            let pendingRestore = lastChoice;
            let typeBuffer = '';
            let typeTimer = null;
            let confirmPending = false; // suspends our keys while showConfirmModal owns them
            let addInputOpen = false;

            // Any deliberate navigation wins over the remembered choice, so
            // a late-arriving local list can't yank the selection out from
            // under the user.
            const clearPending = () => { pendingRestore = null; };

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
                    .concat(models.map((m) => ({ type: 'model', model: m })))
                    .concat([{ type: 'add' }])
                    .concat(localModels.map((m) => ({ type: 'local', model: m })));
            };

            const providerOf = (item) =>
                item.type === 'local' ? 'local' : (item.type === 'model' ? 'openrouter' : '');

            const findIndexForSelection = (sel) => {
                if (!sel || !sel.model) return 0; // claude is always index 0
                const wantType = sel.provider === 'local' ? 'local' : 'model';
                const idx = items.findIndex((it) => it.type === wantType && it.model === sel.model);
                // Fall back to claude when the remembered choice is gone —
                // an OpenRouter model just removed, or one LM Studio no
                // longer serves. Never silently launch a different one.
                return idx >= 0 ? idx : 0;
            };

            const resolveSelection = () => {
                if (pendingRestore) {
                    const idx = findIndexForSelection(pendingRestore);
                    // Matched, or every list has landed and it never will.
                    if (idx > 0 || localState !== 'loading') pendingRestore = null;
                    return idx;
                }
                return findIndexForSelection({ model: currentModel, provider: currentProvider });
            };

            const setActive = (idx, { scroll = true } = {}) => {
                const els = listEl.querySelectorAll('.folder-picker-item');
                if (!els.length) { activeIndex = -1; return; }
                idx = Math.max(0, Math.min(idx, els.length - 1));
                els.forEach((el, i) => el.classList.toggle('folder-picker-item-active', i === idx));
                activeIndex = idx;
                const item = items[idx];
                if (item && item.type !== 'add') {
                    currentModel = item.type === 'claude' ? '' : item.model;
                    currentProvider = providerOf(item);
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
                const model = item.type === 'claude' ? null : item.model;
                const provider = providerOf(item) || null;
                rememberChoice(model || '', provider || '');
                close({ model, provider });
            };

            /**
             * The local section's heading plus, when there is nothing to
             * list, one quiet inline note explaining why. Deliberately NOT
             * a .folder-picker-item — neither the heading nor the note is
             * ever selectable, which keeps the DOM order of
             * .folder-picker-item elements 1:1 with items[] for setActive().
             * There are no add/remove affordances here: the list is
             * whatever LM Studio currently reports, nothing to curate.
             */
            const localSectionHtml = () => {
                let note = '';
                if (localState === 'loading') {
                    note = '<div class="provider-section-note">checking for local models…</div>';
                } else if (localState === 'unreachable') {
                    // Name the box, so the user knows WHICH machine is down.
                    const where = localHost ? escapeHtml(localHost) : 'local host';
                    const why = localError ? ` — ${escapeHtml(localError)}` : '';
                    note = `<div class="provider-section-note provider-section-note--warn">${where} unreachable${why}</div>`;
                } else if (!localModels.length) {
                    const where = localHost ? escapeHtml(localHost) : 'local host';
                    note = `<div class="provider-section-note">no models loaded on ${where}</div>`;
                }
                return `<div class="provider-section-header">► local · lm studio</div>${note}`;
            };

            const render = () => {
                buildItems();
                const chunks = [];
                items.forEach((item, i) => {
                    if (item.type === 'claude') {
                        chunks.push(`<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">◆</span>
                            <span class="folder-picker-name provider-item-name">claude</span>
                        </div>`);
                        return;
                    }
                    if (item.type === 'model') {
                        const safe = escapeHtml(item.model);
                        chunks.push(`<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">◇</span>
                            <span class="folder-picker-name provider-item-name">${safe}</span>
                            <button type="button" class="provider-item-remove" data-remove="${safe}" title="remove ${safe}" aria-label="remove ${safe}">×</button>
                        </div>`);
                        return;
                    }
                    if (item.type === 'local') {
                        chunks.push(`<div class="folder-picker-item" data-index="${i}">
                            <span class="folder-picker-icon">▪</span>
                            <span class="folder-picker-name provider-item-name">${escapeHtml(item.model)}</span>
                        </div>`);
                        return;
                    }
                    // 'add' — last row of the OpenRouter block, so the local
                    // heading is emitted directly after it.
                    chunks.push(`<div class="folder-picker-item provider-add-row" data-index="${i}">
                        <span class="folder-picker-icon">+</span>
                        <span class="folder-picker-name provider-item-name">add model</span>
                    </div>`);
                    chunks.push(localSectionHtml());
                });
                listEl.innerHTML = chunks.join('');

                listEl.querySelectorAll('.folder-picker-item').forEach((el) => {
                    const idx = parseInt(el.dataset.index, 10);
                    el.addEventListener('mousemove', () => {
                        if (idx !== activeIndex) { clearPending(); setActive(idx, { scroll: false }); }
                    });
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.provider-item-remove')) return;
                        clearPending();
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

                setActive(resolveSelection(), { scroll: false });
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
                    clearPending();
                    setActive(activeIndex < 0 ? 0 : activeIndex + 1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    clearPending();
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
                        const label = it.type === 'claude' ? 'claude' : (it.type === 'add' ? '' : it.model);
                        return label && label.toLowerCase().startsWith(typeBuffer);
                    });
                    if (matchIdx >= 0) { clearPending(); setActive(matchIdx); }
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
                // Probe LM Studio in PARALLEL and never await it before the
                // first paint — an unreachable box costs the proxy a full
                // timeout, and the rest of the modal must stay usable
                // (and launchable) the whole time it hangs.
                const localProbe = window.API.getLocalProviderModels().then(
                    (data) => {
                        localHost = typeof data.host === 'string' ? data.host : '';
                        if (data.reachable) {
                            localState = 'ready';
                            // Same id guard as the add path — a malformed id
                            // from LM Studio must never reach the launcher.
                            localModels = Array.isArray(data.models)
                                ? data.models.filter((m) => typeof m === 'string' && MODEL_ID_RE.test(m))
                                : [];
                        } else {
                            localState = 'unreachable';
                            localError = data.error ? String(data.error) : '';
                        }
                    },
                    (error) => {
                        // Route absent, server down, network dead — all the
                        // same quiet inline state. Never a thrown error, a
                        // blank section, or a blocking alert.
                        console.warn('Launchpad: local model probe failed:', error);
                        localState = 'unreachable';
                        localError = (error && error.message) ? error.message : String(error);
                    }
                );

                try {
                    const data = await window.API.getProviders();
                    models = Array.isArray(data.models) ? data.models : [];
                } catch (error) {
                    console.error('Launchpad: Failed to load providers:', error);
                    models = [];
                    showStatus('could not load saved models — showing claude only', 'error');
                }
                render();
                setTimeout(() => listEl.focus(), 100);

                await localProbe;
                if (!overlay.isConnected) return; // user already launched/cancelled
                render();
            })();
        });
    }

    window.Launchpad.showProviderModal = showProviderModal;
})();
