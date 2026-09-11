<!--
  StartupGateBadge - "needs a keypress", punchlist 19.

  IT ANSWERS A DIFFERENT QUESTION FROM THE STATUS LIGHT. `activity_status`
  describes what a RUNNING agent is doing; this says whether it is running
  at all. A freshly launched claude parked on its folder-trust dialog is a
  live pane, running a real process, with a pid tmux reports happily - and
  it has fired NO hook, so every field beside it reads healthy and the row
  painted a green Connected dot over a session waiting for a keypress.

  ONLY A MEASURED BLOCK PAINTS. `ready` and `unknown` both render nothing,
  and `unknown` is a real answer meaning the probe did not run. The
  predicate is a STRICT equality, never `!!row.startup_gate`, which would
  be true for all three values.

  IT SITS ON THE TOP LINE BESIDE THE NAME rather than down in the badge
  row, because it is not a fact about what this session IS (ownership,
  family, wrapper, age) - it is the one thing on the card asking the user
  to go and do something.

  NEVER COLOUR-ALONE. `role="img"` with the full sentence in `title` AND
  `aria-label`, the same accessibility contract the status dot holds
  itself to. The two-word badge is the visible text; the sentence is what
  a screen reader gets.

  `client/js/session-startup-gate.js` STAYS, because the sidebar row draws
  the same badge from it. Its LABEL and REASON constants and these two
  catalog messages are held equal by ./startup-gate.parity.test.ts, so one
  surface cannot start saying something the other does not.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
    import { awaitingStartup } from './running-row';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** Raw `startup_gate`, off the WRAPPER level of the row. */
        gate?: string | null;
        t?: Translate;
    }

    let { gate = null, t = reactiveT }: Props = $props();

    const blocked = $derived(awaitingStartup(gate));
    const reason = $derived(t(RUNNING_SESSION_KEYS.startupGateReason));
</script>

{#if blocked}
    <span
        class="session-startup-gate"
        role="img"
        title={reason}
        aria-label={reason}>{t(RUNNING_SESSION_KEYS.startupGateLabel)}</span
    >
{/if}
