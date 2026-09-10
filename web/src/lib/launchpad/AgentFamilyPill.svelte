<!--
  AgentFamilyPill - which agent is running in a pane, and how sure we are.

  A COMPONENT RATHER THAN A STRING, AND THAT WAS FORCED. The legacy
  `_renderFamilyPillHtml` hands back HTML, and there is no `{@html}`
  anywhere in this migration: Svelte escapes TEXT, not attribute
  construction inside a raw block, so a raw block is the review trigger
  the plan names. Every value below goes through normal interpolation
  instead, which is what replaced the legacy `_escapeHtml` calls.

  THE RULES ARE NOT IN HERE. ./agent-family-pill.ts decides the kind, the
  class and which sentence to hover; this file is a span. Slice 5 deletes
  the legacy copy when the running-sessions row follows it over.

  NO COLOUR IS DECLARED HERE. `.family-pill--fact`, `--guess` and
  `--unknown` already carry theirs in client/css/styles.css, which is
  what keeps all 26 themes working with no theme work.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { FAMILY_PILL_KEYS, familyPillView } from './agent-family-pill';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** The resolved family name, or null when nothing could name it. */
        family?: string | null;
        /** wrapper / reserved_name / fingerprint / inferred_process / ... */
        source?: string | null;
        /** The translator. Injected only so a test can drive a locale. */
        t?: Translate;
    }

    let { family = null, source = null, t = reactiveT }: Props = $props();

    const view = $derived(familyPillView(family, source));
    // A NULL LABEL RENDERS THE UNKNOWN MESSAGE, never a family name and
    // never an empty span. That is the third outcome the whole pill
    // exists for.
    const text = $derived(view.label ?? t(FAMILY_PILL_KEYS.unknownLabel));
    const title = $derived(t(view.titleKey, view.titleParams));
</script>

<span
    class="family-pill {view.className}"
    data-family-source={view.source}
    title={title}
>{text}</span>
