/**
 * ThemeSelector - native <select> theme picker mounted into the header.
 *
 * Spec section "Architecture B" / "Pluggability Surface":
 *   - Native <select> for free keyboard nav + accessibility.
 *   - aria-label="Theme", text labels only.
 *   - max-height: 60dvh enforced via CSS so 50 user themes don't blow past viewport.
 *   - Theme-aware via the same CSS vars the rest of the chrome uses.
 *   - Pre-selects the active global theme; on change → Themes.applyGlobal(value).
 */
(function () {
    'use strict';

    function buildOptions(selectEl, themes, activeId) {
        // Clear any prior options (re-mount safe).
        while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
        themes.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            if (m.id === activeId) opt.selected = true;
            selectEl.appendChild(opt);
        });
    }

    /**
     * Mount the selector into parentEl. Idempotent: if a selector already exists
     * inside parentEl, it's repopulated rather than duplicated.
     */
    function mount(parentEl) {
        if (!parentEl) {
            console.warn('ThemeSelector.mount: no parent element - skipping');
            return null;
        }
        if (!window.Themes) {
            console.warn('ThemeSelector.mount: window.Themes not available - skipping');
            return null;
        }

        var existing = parentEl.querySelector('#theme-selector');
        var selectEl = existing;
        if (!selectEl) {
            selectEl = document.createElement('select');
            selectEl.id = 'theme-selector';
            selectEl.className = 'theme-selector';
            selectEl.setAttribute('aria-label', 'Theme');
            // APPENDED, full stop. This used to insert before
            // `#destroySessionBtn` to sit "at the right end of the header,
            // near destroy + logout" - a header that no longer exists.
            // Destroy moved to the sidebar row's kebab releases ago and
            // the element has not been in client/index.html since, so the
            // branch was dead and the append was always the path taken.
            // Removed rather than left guarded: a positioning rule that
            // names a vanished anchor reads like a layout that still
            // exists. Pinned by tests/test_settings_panels_mount.node.mjs.
            parentEl.appendChild(selectEl);
            selectEl.addEventListener('change', function (e) {
                var id = e.target.value;
                window.Themes.applyGlobal(id);
            });
        }

        var themes = window.Themes.listAll();
        var active = (window.Themes.getActiveGlobal() || {}).id || window.Themes.DEFAULT_THEME_ID;
        buildOptions(selectEl, themes, active);
        return selectEl;
    }

    /**
     * Refresh option list (e.g. after Themes.init() re-runs post-auth).
     */
    function refresh() {
        var existing = document.getElementById('theme-selector');
        if (!existing || !window.Themes) return;
        var themes = window.Themes.listAll();
        var active = (window.Themes.getActiveGlobal() || {}).id || window.Themes.DEFAULT_THEME_ID;
        buildOptions(existing, themes, active);
    }

    window.ThemeSelector = {
        mount: mount,
        refresh: refresh
    };
})();
