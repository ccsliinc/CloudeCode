<!--
  THE HARNESS'S LOGIN PANEL. SCAFFOLDING, NOT SLICE 3.

  It asks for the same six digit TOTP code the real app asks for and
  posts it to the same route. There is no stored password, no remembered
  code and no development bypass; when the access token expires this
  panel comes back and the person types the next code.

  EVERY STYLE IN THIS FILE IS SVELTE-SCOPED AND THEREFORE CANNOT REACH
  THE REAL COMPONENTS. Svelte compiles each selector below with this
  component's own hash, and a scoped rule matches only elements this
  component rendered. There is no `:global(...)` anywhere in
  web/dev-harness/, which is what makes that a guarantee rather than a
  habit; `src/dev-harness-isolation.test.ts` fails the build if one appears.
-->
<script lang="ts">
    import { loginWithTotp } from './harness-session';

    interface Props {
        /** Called once a token has been stored. */
        onAuthenticated: () => void;
    }

    let { onAuthenticated }: Props = $props();

    /** The typed code. Held only until the fetch resolves. */
    let code = $state('');
    /** Why the last attempt failed, or null. Never carries the code. */
    let failure = $state<string | null>(null);
    /** True while a login is in flight, so the button cannot double fire. */
    let busy = $state(false);

    /**
     * Submit the code.
     * Inputs: event - the form submit. Output: void.
     */
    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (busy) return;
        busy = true;
        failure = null;
        const result = await loginWithTotp(code);
        busy = false;
        if (result.ok) {
            code = '';
            onAuthenticated();
            return;
        }
        failure = result.reason;
    }
</script>

<form onsubmit={submit}>
    <h1>archive component preview</h1>
    <p>
        development harness. It mounts the real NavRail and the real
        TranscriptList against the real archive API. It is not the archive
        screen and it is not slice 3.
    </p>
    <label for="dev-harness-totp">six digit code from your authenticator</label>
    <input
        id="dev-harness-totp"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        bind:value={code}
        disabled={busy}
    />
    <button type="submit" disabled={busy}>{busy ? 'checking' : 'log in'}</button>
    {#if failure}
        <p role="alert">{failure}</p>
    {/if}
</form>

<style>
    form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-width: 380px;
        margin: 12vh auto 0;
        padding: 20px;
        border: 1px solid var(--color-border, #444);
        border-radius: var(--radius-md, 6px);
        background: var(--color-bg-elevated, #252526);
        color: var(--color-fg, #d4d4d4);
        font-family: system-ui, sans-serif;
    }

    h1 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        text-transform: lowercase;
    }

    p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--color-fg-muted, #9a9a9a);
    }

    p[role='alert'] {
        color: var(--color-warning, #d7a13b);
    }

    label {
        font-size: 12px;
        color: var(--color-fg-muted, #9a9a9a);
    }

    input {
        padding: 8px 10px;
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 18px;
        letter-spacing: 6px;
        color: var(--color-fg, #d4d4d4);
        background: var(--color-bg, #1e1e1e);
        border: 1px solid var(--color-border, #444);
        border-radius: var(--radius-sm, 4px);
    }

    button {
        padding: 8px 10px;
        font-size: 13px;
        color: var(--color-fg, #d4d4d4);
        background: var(--color-accent-bg, #0e639c);
        border: 1px solid var(--color-border, #444);
        border-radius: var(--radius-sm, 4px);
        cursor: pointer;
    }

    button:disabled {
        cursor: default;
        opacity: 0.6;
    }
</style>
