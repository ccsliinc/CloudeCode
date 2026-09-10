/**
 * Publish the one string layer the whole page shares.
 *
 * WHY THIS IS ITS OWN SCRIPT AND NOT PART OF THE SVELTE BUNDLE. Copy is
 * the last thing that should depend on the newest thing. If the string
 * layer lived in client/dist/app.js then a bundle that failed to load
 * would take every label in the legacy client with it, and the legacy
 * client is still rendering most of the screens. This file imports no
 * Svelte, no Tailwind and no component; it is a locale and a lookup
 * table. It also puts the dependency arrow the right way round, so
 * nothing about the legacy tree's copy changes on the day slice 7
 * deletes launchpad.js.
 *
 * ORDERING IS GUARANTEED BY THE SPEC, NOT BY LUCK. A `<script
 * type="module">` is deferred, and deferred scripts run in document order
 * after parsing and BEFORE `DOMContentLoaded`. This tag sits above the
 * bundle's, so `window.CloudeI18n` exists before app.js evaluates and
 * before any legacy render runs. The classic scripts above both of them
 * execute FIRST and must therefore only reach for `t()` at render time,
 * never at module-definition time - which is what every legacy consumer
 * here already does.
 *
 * ONE INSTANCE, ONE WRITER. The Svelte tree adopts this object rather
 * than building its own; two instances would be two current locales, and
 * changing one would leave the other painting the old language.
 */
import { createI18n } from './runtime.js';
import { sessionSummaryLabel } from '../labels/session-summary.js';

if (!globalThis.CloudeI18n) {
    globalThis.CloudeI18n = createI18n();
}

// THE SHARED LABEL BUILDERS, for the legacy classic scripts. They are
// published beside the accessor rather than in a namespace of their own
// because a classic script that needs one always needs the other, and a
// second global would be a second thing to check for. The Svelte tree
// imports these modules directly and never reads this object.
if (!globalThis.CloudeLabels) {
    globalThis.CloudeLabels = { sessionSummaryLabel };
}
