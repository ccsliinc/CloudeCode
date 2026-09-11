<!--
  AttentionGroup - the sessions that could NOT be attributed to a project.

  The session-level counterpart to the project presence badges and to the
  running-sessions probe's own attention block, reusing the same NEEDS
  ATTENTION visual language rather than inventing a second one.

  NEVER COLLAPSIBLE AND IT OFFERS NO ACTION. The row exists so an
  unattributed session is VISIBLE AND NAMED, not silently dropped from
  the tree and not guessed into a project. Folding it would let a user
  hide the one thing on this screen that is asking to be looked at, and
  giving it an action would imply this build knows what the session
  belongs to, which is precisely what it just said it does not.

  SEVEN REASONS, NOT ONE. Each item carries the catalog key for the
  branch that placed it, and `attentionReason` prefers the SERVER's own
  detail when the whole records fetch is what failed - because the server
  knows which read failed and this tree does not. Collapsing any two of
  the seven renders an unproven answer as a measured one.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        attentionReason,
        attentionTitle,
        PROJECT_TREE_KEYS,
    } from '../../../../client/js/labels/project-tree.js';
    import { rowKey, type AttentionItem } from './project-groups';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        items: AttentionItem[];
        host: ProjectTreeHost;
        t?: Translate;
    }

    let { items, host, t = reactiveT }: Props = $props();
</script>

{#if items.length > 0}
    <div
        class={['project-node', 'project-node--attention']}
        data-project-node="needs-attention"
        role="status"
    >
        <div class={['project-node__header', 'project-node__header--attention']}>
            <span class="project-node__attention-head"
                >{t(PROJECT_TREE_KEYS.attentionHead)}</span
            >
            <span class="project-node__title">{attentionTitle(items.length, t)}</span>
        </div>
        <div class="project-node__sessions">
            {#each items as item (rowKey(item.session))}
                <div
                    class={['project-session-row', 'project-session-row--attention']}
                    data-name={item.session.name}
                >
                    <span class="project-session-row__name"
                        >{host.displayLabel(item.session)}</span
                    >
                    <span class="project-session-row__attention-reason"
                        >{attentionReason(item, t)}</span
                    >
                </div>
            {/each}
        </div>
    </div>
{/if}
