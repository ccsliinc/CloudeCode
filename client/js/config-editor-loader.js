/**
 * The lazy-load glue between App's config-editor button and the
 * config-editor script family (issue #48: CodeMirror plus every
 * config-editor-*.js file). Split out of client/js/app.js, which is
 * already over this repo's line-count guideline and must not grow - see
 * CLAUDE.md.
 *
 * NO NAVIGATION-GENERATION GUARD, DELIBERATELY. Unlike App.showArchive(),
 * this opens a floating modal panel rather than taking over a screen -
 * the same shape as window.SettingsPanel.open(this.settingsBtn), which
 * sits right beside this button's wiring in app.js and carries no such
 * guard either. A modal opening a beat after the user navigated to a
 * different screen is a minor surprise, not a wrong write into that
 * screen's own state, so this follows the existing sibling pattern rather
 * than inventing a stricter rule for only this one modal.
 *
 * A FAMILY THAT FAILS TO LOAD FAILS LOUDLY, through the same
 * `#deep-link-error` banner (window.Router.showError) plus a
 * console.error naming which resource did not arrive - never a silent
 * no-op click, which is what `if (window.ConfigEditorPanel) ...` would
 * degrade into once this family stopped loading eagerly.
 */

(function () {
    'use strict';

    /**
     * Description: load the config-editor family if needed, then open the
     *   panel anchored to the trigger button. Idempotent through
     *   ModuleLoader.loadFamily(): a second click while loading returns
     *   the same in-flight promise rather than injecting the scripts
     *   twice or opening the panel twice from one load.
     * Inputs: triggerBtn (Element) - passed through to
     *   ConfigEditorPanel.open() for anchoring.
     * Output: void.
     * Example: window.ConfigEditorLoader.openWhenReady(this.configEditorBtn);
     */
    function openWhenReady(triggerBtn) {
        if (!window.ModuleLoader || typeof window.ModuleLoader.loadFamily !== 'function') {
            _fail('App: ModuleLoader is not loaded - the config editor ' +
                'family cannot be fetched.',
                'the file editor could not be loaded. reload the page and try again.');
            return;
        }

        var urls = (window.ModuleFamilies && window.ModuleFamilies.CONFIG_EDITOR) || [];
        window.ModuleLoader.loadFamily('config-editor', urls).then(function () {
            if (window.ConfigEditorPanel && typeof window.ConfigEditorPanel.open === 'function') {
                window.ConfigEditorPanel.open(triggerBtn);
            } else {
                _fail('App: ConfigEditorPanel is not loaded even after the ' +
                    'config editor family loaded - check module-families.js.',
                    'the file editor could not be opened. reload the page and try again.');
            }
        }).catch(function (err) {
            _fail('App: the config editor script family failed to load: ' +
                (err && err.message ? err.message : err),
                'the file editor could not be loaded: ' +
                (err && err.message ? err.message : 'network error') +
                '. reload the page and try again.');
        });
    }

    /**
     * Description: log the failure and surface it through the existing
     *   deep-link error banner, so a lazy-load failure is never only a
     *   console line.
     * Inputs: logMessage (string), bannerMessage (string).
     * Output: void.
     */
    function _fail(logMessage, bannerMessage) {
        console.error(logMessage);
        if (window.Router && typeof window.Router.showError === 'function') {
            window.Router.showError(bannerMessage);
        }
    }

    window.ConfigEditorLoader = {
        openWhenReady: openWhenReady
    };
})();
