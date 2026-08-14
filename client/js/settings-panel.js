/**
 * SettingsPanel — gear-icon modal folding in the theme chooser plus the
 * agent/notifications/server config sections.
 *
 * Data-driven by design (the user's "so we can extrapolate" requirement):
 * SECTIONS below is the single place a future setting gets added — a new
 * field object in an existing section's `fields` array, or a whole new
 * section object, is all that's needed for it to render, collect, and
 * PATCH correctly. No per-field wiring lives outside `renderField()` /
 * `collectSectionPatch()`.
 *
 * Modal conventions follow `AppController.showConfirmModal()` (app.js):
 * a `.modal-overlay` appended to `document.body` on open and removed on
 * close (never left hidden in the DOM), Escape / backdrop-click / close
 * button all dismiss, focus is moved into the panel on open and the
 * triggering button is refocused on close.
 *
 * The appearance section does not appear in SECTIONS — it is special-
 * cased in `renderAppearanceSection()` because it delegates entirely to
 * `window.ThemeSelector.mount()` / `window.Themes`, which already own
 * persistence (localStorage global default, or a server-side PATCH for
 * an active session's pinned/project theme — see registry.js). Appearance
 * changes apply immediately through that existing pipeline and are never
 * part of this panel's own Save/PATCH flow.
 */
(function () {
    'use strict';

    // ---- schema -------------------------------------------------------
    //
    // type: 'text' | 'secret' | 'checkbox'.
    // group: which top-level PATCH /config/settings key this field lives
    //   under ('agents' | 'notifications') — must match the server's
    //   ConfigSettingsUpdateRequest sub-model field names exactly.
    // secret fields never receive their real value from the server (see
    // Settings._mask_secret / get_settings_summary on the Python side) —
    // the input starts empty with a placeholder describing current state,
    // and an empty submit means "leave unchanged" (see collectSectionPatch).

    var AGENT_FIELDS = [
        {
            key: 'claude_command', type: 'text', label: 'claude command (legacy fallback)',
            placeholder: 'e.g. claude --dangerously-skip-permissions',
            hint: 'only used when no launch wrappers are configured below. empty falls through to your ~/.zshrc cld / cldor function — see "what runs now" below',
            showEffective: true,
        },
        { key: 'codex_command', type: 'text', label: 'codex command', placeholder: 'codex' },
        { key: 'hermes_command', type: 'text', label: 'hermes command', placeholder: 'hermes' },
        { key: 'openclaw_command', type: 'text', label: 'openclaw command', placeholder: 'openclaw tui' },
    ];

    var NOTIFICATION_FIELDS = [
        { key: 'enabled', type: 'checkbox', label: 'notifications enabled' },
        { key: 'ntfy_base_url', type: 'text', label: 'ntfy server url', placeholder: 'https://ntfy.sh' },
        { key: 'ntfy_topic', type: 'secret', label: 'ntfy topic' },
        { key: 'slack_webhook_url', type: 'secret', label: 'slack webhook url' },
        { key: 'pushover_token', type: 'secret', label: 'pushover token' },
        { key: 'pushover_user_key', type: 'secret', label: 'pushover user key' },
    ];

    // Sections rendered by the generic field-driven path. 'appearance' and
    // 'server' are rendered by their own functions (bespoke behavior: the
    // theme picker delegates to ThemeSelector, the server section is
    // read-only with an inline safety warning) and are stitched into the
    // same panel below.
    var SECTIONS = [
        {
            id: 'agent', title: 'agent', group: 'agents',
            restartRequired: false,
            description: 'the shell command used to launch each agent CLI in a new session.',
            fields: AGENT_FIELDS,
        },
        {
            id: 'notifications', title: 'notifications', group: 'notifications',
            restartRequired: true,
            description: 'push notification channels — ntfy, slack, pushover.',
            fields: NOTIFICATION_FIELDS,
        },
    ];

    // Module state — the last GET /config/settings payload, so re-renders
    // (e.g. after a save) don't need a network round trip for fields the
    // user didn't just change.
    var lastSummary = null;
    var overlayEl = null;
    var triggerEl = null;

    /**
     * Escape a string for safe interpolation into innerHTML-built markup.
     * Description: mirrors AppController._escapeHtml — duplicated locally
     *   (single small pure function) rather than reaching into `App`,
     *   since this module must also work before app.js has finished
     *   constructing `window.App`.
     * Inputs: str (any) - value to escape; stringified first.
     * Output: string - HTML-escaped text.
     */
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    /**
     * Render one field's markup for a generic (agent/notifications) section.
     * Inputs:
     *   field (object) - one entry from AGENT_FIELDS/NOTIFICATION_FIELDS.
     *   currentValue (any) - the value from `lastSummary` for this field
     *     (raw string/bool for plain fields, `{configured: bool}` for
     *     secret fields).
     *   effectiveText (string|null) - only used when field.showEffective —
     *     the "what runs now" preview line.
     * Output: string - HTML for one `.settings-field` block.
     */
    function renderField(field, currentValue, effectiveText) {
        var inputId = 'settings-field-' + field.key;
        var labelHtml = '<label class="settings-field-label" for="' + inputId + '">' + escapeHtml(field.label) + '</label>';

        if (field.type === 'checkbox') {
            var checked = currentValue ? 'checked' : '';
            return (
                '<div class="settings-field settings-field-checkbox">' +
                '  <label class="settings-field-label" for="' + inputId + '">' +
                '    <input type="checkbox" id="' + inputId + '" data-settings-key="' + field.key + '" data-settings-type="checkbox" ' + checked + '>' +
                '    ' + escapeHtml(field.label) +
                '  </label>' +
                '</div>'
            );
        }

        if (field.type === 'secret') {
            var configured = !!(currentValue && currentValue.configured);
            var placeholder = configured ? 'configured — leave blank to keep' : 'not set';
            return (
                '<div class="settings-field">' +
                labelHtml +
                '  <input type="password" autocomplete="new-password" id="' + inputId + '" ' +
                '    data-settings-key="' + field.key + '" data-settings-type="secret" ' +
                '    class="modal-input" placeholder="' + escapeHtml(placeholder) + '">' +
                '  <div class="settings-field-hint">' + (configured ? 'a value is set — typing here replaces it' : 'not configured — this channel is disabled') + '</div>' +
                '</div>'
            );
        }

        // text
        var val = currentValue == null ? '' : String(currentValue);
        var effectiveHtml = '';
        if (field.showEffective && effectiveText) {
            effectiveHtml = '<div class="settings-field-effective">what runs now: <code>' + escapeHtml(effectiveText) + '</code></div>';
        }
        return (
            '<div class="settings-field">' +
            labelHtml +
            '  <input type="text" id="' + inputId + '" data-settings-key="' + field.key + '" data-settings-type="text" ' +
            '    class="modal-input" placeholder="' + escapeHtml(field.placeholder || '') + '" value="' + escapeHtml(val) + '">' +
            (field.hint ? '  <div class="settings-field-hint">' + escapeHtml(field.hint) + '</div>' : '') +
            effectiveHtml +
            '</div>'
        );
    }

    /**
     * Render a full generic section (heading + description + restart
     * notice + its fields), reading current values out of `lastSummary`.
     * Inputs: section (object) - one entry from SECTIONS.
     * Output: string - HTML for one `.settings-section`.
     */
    function renderGenericSection(section) {
        var groupData = (lastSummary && lastSummary[section.group]) || {};
        var restartHtml = section.restartRequired
            ? '<div class="settings-restart-note">changes here need a server restart to take effect</div>'
            : '';
        var fieldsHtml = section.fields.map(function (field) {
            var effectiveText = field.showEffective ? groupData.effective_claude_command : null;
            return renderField(field, groupData[field.key], effectiveText);
        }).join('');
        return (
            '<section class="settings-section" data-settings-section="' + section.id + '" data-settings-group="' + section.group + '">' +
            '  <h3 class="settings-section-title">' + escapeHtml(section.title) + '</h3>' +
            '  <div class="settings-section-description">' + escapeHtml(section.description) + '</div>' +
            restartHtml +
            fieldsHtml +
            '</section>'
        );
    }

    /**
     * Render the appearance section shell. The actual `<select>` is
     * mounted into `#settings-theme-slot` by `window.ThemeSelector.mount`
     * right after this HTML is inserted (see `renderPanel`) — it can't be
     * built as a string because ThemeSelector owns its own DOM node and
     * change-listener wiring.
     * Output: string - HTML for the appearance `.settings-section`.
     */
    function renderAppearanceSection() {
        return (
            '<section class="settings-section" data-settings-section="appearance">' +
            '  <h3 class="settings-section-title">appearance</h3>' +
            '  <div class="settings-section-description">theme applies immediately — no save needed.</div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label" for="theme-selector">theme</label>' +
            '    <div id="settings-theme-slot"></div>' +
            '  </div>' +
            '</section>'
        );
    }

    /**
     * Render the server section: read-only HOST bind address plus an
     * inline safety warning. Deliberately not editable — see the
     * settings-screen spec's HOST handling: it lives in `.env`, not
     * config.json, has no atomic-write convention in this codebase, and
     * the launchd wrapper on the deploy host REFUSES TO BOOT on a
     * wildcard/empty bind, so a bad edit here would strand the server
     * with no way to fix it from the now-unreachable UI. Read-only +
     * loud warning is the safer contract than a "confirm to bypass" edit
     * path would be.
     * Output: string - HTML for the server `.settings-section`.
     */
    function renderServerSection() {
        var server = (lastSummary && lastSummary.server) || {};
        var wildcard = !!server.wildcard_bind;
        var warningHtml = wildcard
            ? (
                '<div class="settings-warning">' +
                '  <strong>this bind address exposes a remote shell on every network interface.</strong> ' +
                '  the server\'s startup guard refuses to boot when HOST is 0.0.0.0, empty, or missing — ' +
                '  if this got here from a hand-edited .env, the app will not come back up after a restart. ' +
                '  fix .env directly on the host, then restart.' +
                '</div>'
            )
            : (
                '<div class="settings-field-hint">bound to a specific interface — not exposed on every network.</div>'
            );
        return (
            '<section class="settings-section" data-settings-section="server">' +
            '  <h3 class="settings-section-title">server</h3>' +
            '  <div class="settings-section-description">bind address — read only. lives in .env, not config.json; edit it on the host directly.</div>' +
            '  <div class="settings-field">' +
            '    <label class="settings-field-label">host</label>' +
            '    <input type="text" class="modal-input" value="' + escapeHtml(server.host || '') + '" readonly disabled>' +
            '  </div>' +
            warningHtml +
            '</section>'
        );
    }

    /**
     * Build the full panel body HTML from `lastSummary` — appearance,
     * then every generic SECTIONS entry, then server, in that fixed
     * order (matches the spec's APPEARANCE / AGENT / NOTIFICATIONS /
     * SERVER ordering).
     * Output: string.
     */
    function renderBody() {
        var parts = [renderAppearanceSection()];
        SECTIONS.forEach(function (section) {
            parts.push(renderGenericSection(section));
            // feat/launch-wrappers — the wrapper list/editor is bespoke
            // (immediate-write CRUD, not part of this panel's batched
            // Save flow — see agent-wrappers-panel.js's module doc) and
            // is mounted into this slot right after the generic "agent"
            // section, by mountWrappersSlot() (called alongside
            // mountThemeSlot in open()/save()).
            if (section.id === 'agent') {
                parts.push('<div id="settings-wrappers-slot"></div>');
            }
        });
        parts.push(renderServerSection());
        return parts.join('');
    }

    /**
     * Read every field's current input value out of the DOM and build
     * the PATCH payload for one section's group, including ONLY fields
     * the user actually touched:
     *   - text fields: included if the value differs from the value
     *     `renderField` seeded it with (so an untouched field, even one
     *     the user clicked into and clicked back out of unchanged, isn't
     *     sent — matches the "omit = leave unchanged" server contract).
     *   - secret fields: included ONLY if non-empty (an empty secret
     *     input always means "didn't type a new one", never "clear it" —
     *     clearing a channel is done by unmasking to "not set" server-
     *     side, which this UI doesn't expose as a distinct action to
     *     avoid an accidental blank submit wiping a working webhook).
     *   - checkboxes: included if changed from the seeded checked state.
     * Inputs: section (object) - one SECTIONS entry.
     * Output: object - patch fragment for `section.group`, possibly {}.
     */
    function collectSectionPatch(section) {
        var groupData = (lastSummary && lastSummary[section.group]) || {};
        var patch = {};
        section.fields.forEach(function (field) {
            var el = overlayEl.querySelector('[data-settings-key="' + field.key + '"]');
            if (!el) return;

            if (field.type === 'checkbox') {
                var seededChecked = !!groupData[field.key];
                if (el.checked !== seededChecked) patch[field.key] = el.checked;
                return;
            }

            if (field.type === 'secret') {
                var typed = el.value;
                if (typed !== '') patch[field.key] = typed;
                return;
            }

            // text
            var seededVal = groupData[field.key] == null ? '' : String(groupData[field.key]);
            if (el.value !== seededVal) patch[field.key] = el.value;
        });
        return patch;
    }

    /**
     * Gather the full PATCH body across every generic section that has
     * at least one changed field.
     * Output: object - `{agents?: {...}, notifications?: {...}}`, only
     *   including a top-level key when its section has changes.
     */
    function collectPatch() {
        var body = {};
        SECTIONS.forEach(function (section) {
            var fragment = collectSectionPatch(section);
            if (Object.keys(fragment).length > 0) {
                body[section.group] = fragment;
            }
        });
        return body;
    }

    /**
     * Persist any changed fields via PATCH /config/settings, then
     * re-render the panel body from the fresh server response so secret
     * "configured" badges and the claude effective-command preview
     * reflect what was just saved.
     * Inputs: none (reads the panel's own DOM).
     * Output: Promise<void>.
     */
    async function save() {
        var patch = collectPatch();
        if (Object.keys(patch).length === 0) {
            close();
            return;
        }
        var saveBtn = overlayEl.querySelector('#settings-save-btn');
        var statusEl = overlayEl.querySelector('#settings-save-status');
        if (saveBtn) saveBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'saving...';
        try {
            lastSummary = await window.API.updateSettings(patch);
            if (statusEl) statusEl.textContent = 'saved';
            var bodyEl = overlayEl.querySelector('#settings-panel-body');
            if (bodyEl) {
                bodyEl.innerHTML = renderBody();
                mountThemeSlot();
                mountWrappersSlot();
            }
        } catch (err) {
            console.error('SettingsPanel: save failed', err);
            if (statusEl) statusEl.textContent = 'save failed: ' + (err && err.message ? err.message : 'unknown error');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    /**
     * Mount the theme `<select>` into this panel's slot. Idempotent —
     * ThemeSelector.mount() repopulates an existing `#theme-selector`
     * rather than duplicating it, so calling this on every render (open,
     * post-save) is safe.
     * Output: void.
     */
    function mountThemeSlot() {
        if (!window.ThemeSelector) return;
        var slot = overlayEl.querySelector('#settings-theme-slot');
        if (slot) window.ThemeSelector.mount(slot);
    }

    /**
     * Mount the launch-wrappers list/editor into this panel's slot (see
     * renderBody's `#settings-wrappers-slot` placement, right after the
     * generic "agent" section). Called on open and after every save, same
     * as mountThemeSlot.
     * Output: void.
     */
    function mountWrappersSlot() {
        if (!window.AgentWrappersPanel) return;
        var slot = overlayEl.querySelector('#settings-wrappers-slot');
        if (slot) window.AgentWrappersPanel.mount(slot);
    }

    /**
     * Close the panel: remove the overlay from the DOM and return focus
     * to whatever triggered the open (the gear button, normally) — same
     * dismissal contract as `AppController.showConfirmModal`.
     * Output: void.
     */
    function close() {
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        if (triggerEl && typeof triggerEl.focus === 'function') {
            try { triggerEl.focus(); } catch (_) { /* no-op */ }
        }
        triggerEl = null;
    }

    /**
     * Open the settings panel: fetch the current summary, build the
     * overlay, wire Escape/backdrop/close/save, and move focus in.
     * Safe to call while already open — just re-focuses.
     * Inputs: opener (Element|null) - element to refocus on close.
     * Output: Promise<void>.
     */
    async function open(opener) {
        if (overlayEl) return; // already open
        triggerEl = opener || document.activeElement;

        try {
            lastSummary = await window.API.getSettings();
        } catch (err) {
            console.error('SettingsPanel: failed to load settings', err);
            lastSummary = { agents: {}, notifications: {}, server: {} };
        }

        overlayEl = document.createElement('div');
        overlayEl.className = 'modal-overlay';
        overlayEl.setAttribute('data-modal', 'settings-panel');

        overlayEl.innerHTML = (
            '<div class="settings-modal-content" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title">' +
            '  <div class="modal-header settings-panel-header">' +
            '    <h2 id="settings-panel-title">settings</h2>' +
            '    <button type="button" class="modal-close" id="settings-close-btn" aria-label="Close settings" title="close">&times;</button>' +
            '  </div>' +
            '  <div class="modal-body settings-panel-body" id="settings-panel-body">' + renderBody() + '</div>' +
            '  <div class="modal-footer settings-panel-footer">' +
            '    <span id="settings-save-status" class="settings-save-status"></span>' +
            '    <button type="button" class="modal-btn modal-btn-secondary" id="settings-cancel-btn">cancel</button>' +
            '    <button type="button" class="modal-btn modal-btn-primary" id="settings-save-btn">save</button>' +
            '  </div>' +
            '</div>'
        );

        document.body.appendChild(overlayEl);
        mountThemeSlot();
        mountWrappersSlot();

        overlayEl.querySelector('#settings-close-btn').addEventListener('click', close);
        overlayEl.querySelector('#settings-cancel-btn').addEventListener('click', close);
        overlayEl.querySelector('#settings-save-btn').addEventListener('click', function () {
            save();
        });
        overlayEl.addEventListener('click', function (e) {
            if (e.target === overlayEl) close();
        });
        overlayEl.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        });

        var closeBtn = overlayEl.querySelector('#settings-close-btn');
        setTimeout(function () {
            try { closeBtn.focus(); } catch (_) { /* no-op */ }
        }, 50);
    }

    window.SettingsPanel = { open: open, close: close };
})();
