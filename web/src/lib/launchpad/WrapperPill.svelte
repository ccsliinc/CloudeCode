<!--
  WrapperPill - names the launch WRAPPER a session started from.

  WHY A SECOND PILL. The family pill beside it answers "what kind of agent
  is in this pane" and has five possible answers. It cannot answer the
  question the owner actually asked on the home screen, which is WHICH
  claude: a session started through `claude (chrome)` and one started
  through `claude` render the identical family pill, because they are the
  identical family. The wrapper is the user's own launch choice, and it is
  the only thing on the row that distinguishes them.

  RENDERING NOTHING IS NOT THE UNKNOWN CASE, and this is the opposite of
  the family pill's rule rather than an inconsistency with it. The server
  sends `agent_wrapper_label: null` whenever no configured wrapper can be
  named - the agent_type was fingerprinted from scrollback, or it is a
  bare family name like `shell`, or it names a wrapper the user has since
  deleted. A session genuinely launched as a bare shell was launched
  through NO wrapper at all, so "unknown wrapper" would report a gap where
  there is none. The family pill standing beside it is what tells "we
  could not tell" from "there is nothing to tell".

  NEVER THE RAW `agent_type`. The id (`claude-chrome`) is an internal key
  the user never chose the spelling of; the label (`claude (chrome)`) is
  what they typed into settings. The server already falls the label back
  to the id when a wrapper's label is blank, so by the time a value
  reaches here it is the best name that exists.

  SLICE 5 REPLACES `client/js/launchpad-wrapper-pill.js`, which had
  exactly one caller and is deleted in the same commit.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
    import { wrapperPillView } from './running-row';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** `agent_wrapper_label`, off the WRAPPER level of the row. */
        label?: string | null;
        t?: Translate;
    }

    let { label = null, t = reactiveT }: Props = $props();

    const view = $derived(wrapperPillView(label));
    const title = $derived(
        view ? t(RUNNING_SESSION_KEYS.wrapperTitle, { label: view.label }) : '',
    );
</script>

{#if view}
    <span class="wrapper-pill" {title} aria-label={title}>{view.label}</span>
{/if}
