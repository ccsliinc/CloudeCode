<!--
  THE HARNESS'S OUTERMOST COMPONENT: log in, then preview. SCAFFOLDING.

  It holds exactly one decision - is there an access token - and nothing
  else. Splitting it from `DevPreviewHarness.svelte` is what keeps the
  login panel's markup and the preview's layout from sharing a scope, so
  neither file's styles can reach the other's elements.
-->
<script lang="ts">
    import HarnessLogin from './HarnessLogin.svelte';
    import DevPreviewHarness from './DevPreviewHarness.svelte';
    import { readAccessToken, writeAccessToken } from './harness-session';
    import { createHarnessArchiveClient } from './harness-api';

    /**
     * True once a token is stored. Read ONCE at construction, then moved
     * by the two controls below: the token is not a reactive source and
     * polling `sessionStorage` on every paint would be a storage read per
     * frame for a value only this component changes.
     */
    let authenticated = $state(readAccessToken() !== null);

    /**
     * The granted client. ONE for the whole page, built once: two would
     * be two grants to keep in step, and the grant is the security claim.
     */
    const client = createHarnessArchiveClient();
</script>

{#if authenticated}
    <DevPreviewHarness
        {client}
        onSignOut={() => { writeAccessToken(null); authenticated = false; }}
    />
{:else}
    <HarnessLogin onAuthenticated={() => { authenticated = true; }} />
{/if}
