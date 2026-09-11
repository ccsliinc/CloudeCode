/**
 * The lazy-load glue between App.showArchive() and the archive script
 * family (issue #48). Split out of client/js/app.js, which is already over
 * this repo's line-count guideline and must not grow - see CLAUDE.md.
 *
 * A VISIBLE PLACEHOLDER, NOT A BLANK SCREEN, WHILE LOADING. The archive
 * screen div is empty until archive-screen-shell.js (part of the lazy
 * family) executes and appends the shell into it - before this feature
 * existed that gap did not exist, because everything was already loaded by
 * the time anyone could click. Skipped entirely once the family is already
 * loaded, so a second visit never flashes a placeholder over an
 * already-built shell.
 *
 * A FAMILY THAT FAILS TO LOAD FAILS LOUDLY. Both the existing
 * `#deep-link-error` banner (via window.Router.showError) and a message
 * inside the otherwise-empty screen report the failure - the same
 * "silently degraded asset" shape CLAUDE.md documents costing real users a
 * working terminal when xterm's CSS silently failed to arrive from a CDN.
 * This is the same failure class over the app's own /static origin, so it
 * gets the same loud treatment rather than a blank div and a console line
 * nobody but a developer will ever read.
 *
 * A COMPLETION MAY ONLY WRITE TO SHARED UI STATE WHILE ITS NAVIGATION IS
 * CURRENT (see client/js/navigation-generation.js). Loading the archive
 * family is the first async gap App.showArchive() has ever had - before
 * this feature, ArchiveScreen was already loaded and the whole function
 * ran synchronously. So showWhenReady() takes the token App.showArchive()
 * captured BEFORE this load began, and checks it right before the write
 * that cannot be taken back: painting ArchiveScreen.show() or a failure
 * banner over whatever screen the user has since navigated to.
 */

(function () {
    'use strict';

    var SCREEN_ID = 'archive-screen';
    var PLACEHOLDER_CLASS = 'archive-loading-placeholder';

    /**
     * Description: load the archive family if needed, then hand params to
     *   ArchiveScreen.show(). Called from App.showArchive() AFTER that
     *   function's synchronous DOM setup (activating the screen, clearing
     *   session identity, placing the status light) has already run.
     * Inputs: params (object) - forwarded to ArchiveScreen.show().
     *   nav (number|null) - the navigation-generation token
     *   App.showArchive() captured before this call, or null when
     *   NavigationGeneration is unavailable. Checked before every write to
     *   shared UI state below.
     * Output: void.
     * Example: window.ArchiveLoader.showWhenReady({}, nav);
     */
    function showWhenReady(params, nav) {
        var root = document.getElementById(SCREEN_ID);
        var alreadyLoaded = window.ModuleLoader &&
            window.ModuleLoader.status('archive') === window.ModuleLoader.STATUS_LOADED;
        var placeholder = null;
        if (root && !alreadyLoaded) {
            placeholder = document.createElement('div');
            placeholder.className = PLACEHOLDER_CLASS;
            placeholder.textContent = 'loading the message archive...';
            root.appendChild(placeholder);
        }

        if (!window.ModuleLoader || typeof window.ModuleLoader.loadFamily !== 'function') {
            if (placeholder) placeholder.remove();
            if (_stillCurrent(nav, 'archive family load')) {
                _fail('App: ModuleLoader is not loaded - the archive family ' +
                    'cannot be fetched.',
                    'the message archive could not be loaded. reload the page and try again.');
            }
            return;
        }

        var urls = (window.ModuleFamilies && window.ModuleFamilies.ARCHIVE) || [];
        window.ModuleLoader.loadFamily('archive', urls).then(function () {
            if (placeholder) placeholder.remove();
            // The write that cannot be taken back. A stale navigation
            // discards silently here - the user asked for something else
            // while this family was still downloading, and painting the
            // archive over it now would be gotcha 7's shape one layer up.
            if (!_stillCurrent(nav, 'archive family load')) return;
            if (window.ArchiveScreen && typeof window.ArchiveScreen.show === 'function') {
                window.ArchiveScreen.show(params || {});
            } else {
                // A NAMED refusal. The scripts reported success but the
                // global they must define is missing - a mismatch between
                // module-families.js and the real files, not a network
                // failure.
                _fail('App: ArchiveScreen is not loaded even after the ' +
                    'archive family loaded - check module-families.js.',
                    'the message archive could not be shown. reload the page and try again.');
            }
        }).catch(function (err) {
            if (placeholder) {
                placeholder.textContent = 'the message archive could not be ' +
                    'loaded. check your connection and reload the page.';
            }
            if (!_stillCurrent(nav, 'archive family load failure')) return;
            _fail('App: the archive script family failed to load: ' +
                (err && err.message ? err.message : err),
                'the message archive could not be loaded: ' +
                (err && err.message ? err.message : 'network error') +
                '. reload the page and try again.');
        });
    }

    /**
     * Description: is the navigation this load began under still the one
     *   on screen? Missing NavigationGeneration answers true - a
     *   correctness guard is never a hard dependency, the same rule
     *   terminal.js's own _navCurrent() follows.
     * Inputs: nav (number|null), what (string) - for the debug log.
     * Output: boolean.
     */
    function _stillCurrent(nav, what) {
        if (!window.NavigationGeneration) return true;
        return window.NavigationGeneration.keep(nav, what);
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

    window.ArchiveLoader = {
        showWhenReady: showWhenReady
    };
})();
