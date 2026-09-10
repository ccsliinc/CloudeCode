/**
 * Entry point for the Svelte half of the app.
 *
 * WHAT LOADING THIS DOES TO THE RUNNING APP: nothing visible. It
 * publishes one namespace, `window.CloudeWeb`, and returns. It mounts no
 * component into the document, registers no listener, touches no existing
 * element and overwrites no existing global. That is the contract for
 * this round of the migration - the bundle ships and proves itself, and
 * the screens change later, one at a time.
 *
 * WHY A NAMESPACE AT ALL. The legacy tree is a set of IIFEs that publish
 * onto `window`, and it has to be able to call into the compiled tree
 * during the migration without either side importing the other. One
 * namespace, named after the tree it belongs to, is the seam. Add exports
 * to it as screens move over; do not scatter new globals beside it.
 *
 * NO INLINE SCRIPT, EVER. This file and everything it imports are bundled
 * into client/dist/app.js and loaded with a plain `<script type="module"
 * src>` from this app's own origin. `script-src 'self'` forbids inline
 * script and `eval`, so nothing here may reach for either, and no build
 * setting may be changed to make Vite emit them.
 */
import './app.css';
import { mount, unmount } from 'svelte';
import StatusLed from './lib/StatusLed.svelte';
import * as led from './lib/led';
import { ledHtmlForStatus, labelFor, labelWithSource, normalizeStatus } from './lib/status-dot';
import type { StatusSignals } from './lib/status-dot';
import { mountPanel, unmountPanel } from './lib/mount';
import AttributionPrompt from './lib/launchpad/AttributionPrompt.svelte';
// Imported for its side effect: this is what registers the shipped
// plugins on the surface registry. Nothing reads a binding from it.
import './lib/plugins/builtin';
import { sessionCardMenuItems, runSessionCardAction } from './lib/plugins/session-card-actions';
import { t, setLocale, currentLocale, i18n } from './lib/i18n/index.svelte';
import { summaryLabel } from './lib/session-summary-label';

/** The id of the container `renderLaunchpadUI()` writes for the card. */
const ATTRIBUTION_PROMPT_CONTAINER = 'attribution-prompt';

/**
 * Mount the Stage C attribution prompt into the launchpad's own slot.
 *
 * Description: THE ONE LINE `client/js/launchpad.js` CALLS. It sits at
 *   the exact point `loadProjects()` used to call the five legacy
 *   attribution methods, which were deleted in the same commit. Kept as
 *   a named function rather than a bare `mountPanel` call at the call
 *   site so the container id lives in this tree, where the component
 *   does, and so the legacy line stays greppable and one line long.
 *
 *   The card fetches its own question set as it mounts, exactly as
 *   `loadAttributionPrompt()` did. Nothing is awaited here: a failure
 *   inside it must not stop the projects rendering.
 * Inputs: none.
 * Output: void.
 * Example: window.CloudeWeb.launchpad.mountAttributionPrompt();
 */
function mountAttributionPrompt(): void {
    mountPanel(ATTRIBUTION_PROMPT_CONTAINER, AttributionPrompt, {});
}

/**
 * Render the StatusLed component once, off-document, and hand back its
 * markup.
 *
 * Description: THE END-TO-END PROOF, and the reason it renders into a
 *   detached element. Everything else this bundle exports is a pure
 *   string function, which would compile and pass its tests even if the
 *   Svelte runtime were broken or absent in the browser. This actually
 *   mounts a compiled Svelte 5 component with runes and reads what the
 *   real DOM made of it - and it does so in a container that was never
 *   inserted into the document, so it cannot paint a pixel, shift a
 *   layout or be found by any selector the legacy code runs.
 *
 *   Called on demand, never at load: a bundle that mounted something on
 *   every page load would be doing work for a diagnostic.
 * Inputs:
 *   status - raw `activity_status` value.
 *   signals - the wrapper-level fields, as ledHtmlForStatus takes them.
 * Output: string - the component's rendered outerHTML.
 * Example:
 *   window.CloudeWeb.renderProbe('working', {unread: false})
 *   // '<span class="inline-flex items-center gap-1.5 align-middle">...'
 */
function renderProbe(status?: string | null, signals?: StatusSignals | null): string {
    const s: StatusSignals = signals || {};
    const host = document.createElement('div');
    const component = mount(StatusLed, {
        target: host,
        props: {
            status: status ?? null,
            unread: !!s.unread,
            startupGate: s.startup_gate ?? null,
            statusSource: s.status_source ?? null,
            size: s.size ?? null,
        },
    });
    const html = host.innerHTML;
    // Unmounted immediately. The probe owns nothing after it answers, so
    // repeated calls cannot accumulate live component instances.
    unmount(component, { outro: false });
    return html;
}

/** The namespace the legacy tree may call into. */
const CloudeWeb = {
    /**
     * The status LED as an HTML string, byte-identical to the legacy
     * SessionStatusUI.dotHtml for every input. This is what a legacy
     * caller that builds a row with innerHTML would use.
     */
    ledHtml: ledHtmlForStatus,
    /** The low-level two-dimension LED module, for callers that need it. */
    led,
    labelFor,
    labelWithSource,
    normalizeStatus,
    /** The Svelte component itself, for a parent that can mount one. */
    StatusLed,
    renderProbe,
    /**
     * THE ONLY MOUNT PATH. Every panel a migration slice moves out of
     * client/js is mounted through this, by container id, so there is
     * exactly one place that owns a live component handle. Nothing else
     * may call Svelte's `mount()` on an element that is in the document.
     */
    mountPanel,
    unmountPanel,
    /** Panels that belong to the launchpad screen, by name. */
    launchpad: {
        mountAttributionPrompt,
    },
    /**
     * THE `session-card-action` SURFACE, as the legacy row menu sees it.
     * `sessionCardMenuItems` hands back the enabled contributions for one
     * row as ITEM DESCRIPTORS - id, shortcut, label, order - to be merged
     * into that menu's own declarative table and rendered by it;
     * `runSessionCardAction` is the return trip, taking the item id off
     * the activated `data-row-menu-item`. TWO ENTRY POINTS BECAUSE THERE
     * ARE TWO MOMENTS, paint and run, and each has exactly one call site:
     * `session-row-menu.js::pluginMenuItems` and
     * `session-row-menu-actions.js::runPluginItem`. See
     * web/src/lib/plugins/types.ts for why plugins are build-time only.
     */
    sessionCardMenuItems,
    runSessionCardAction,
    /**
     * THE STRING LAYER, AS THIS TREE SEES IT. Note what is NOT here: a
     * catalog. The messages live in client/js/i18n/, `boot.js` publishes
     * the one instance as `window.CloudeI18n` before this bundle
     * evaluates, and this adopts that object rather than building a
     * second one - two instances would be two current locales.
     *
     * `t` here is the REACTIVE one: it reads a `$state` counter before
     * delegating, so any component template that calls it repaints when
     * `setLocale` moves. A legacy caller wants `window.CloudeI18n.t`
     * instead, which is the same function without the rune, because a
     * classic script has nothing to repaint.
     */
    i18n: { t, setLocale, currentLocale, instance: i18n },
    /**
     * The group summary sentence, from the SHARED assembler in
     * client/js/labels/session-summary.js. The legacy tree reaches the
     * same module through `window.CloudeLabels`, so the sidebar header
     * and any Svelte surface cannot render two different sentences for
     * one state - web/src/lib/session-summary-label.parity.test.ts holds
     * them to it across the whole matrix.
     */
    sessionSummaryLabel: summaryLabel,
} as const;

declare global {
    interface Window {
        CloudeWeb: typeof CloudeWeb;
    }
}

// Published rather than assigned over: if something already claimed this
// name, that is a collision worth failing loudly on rather than winning
// silently.
if (window.CloudeWeb) {
    throw new Error('window.CloudeWeb is already defined - two bundles are loaded');
}
window.CloudeWeb = CloudeWeb;
