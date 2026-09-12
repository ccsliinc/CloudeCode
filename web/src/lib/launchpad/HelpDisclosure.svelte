<!--
  The app's one help surface: adopting a session, what a wrapper is, and
  where slash commands live.

  IT IS A NATIVE `<details>`, NEVER A BUTTON, and the reason is a
  stylesheet rather than taste: the bare `button {width:36px;height:36px}`
  reset in styles.css would force a 36px box on it (40px under the 480px
  media query), and a class only overrides the properties it actually
  declares.

  THE CONTROL IS NOT IN HERE. It is the "?" in the top header, bound by
  `home-chrome.ts::bindHeaderHelpToggle`, which resolves this `<details>`
  at click time. The in-pane `<summary>` stays because it is what makes
  the element a disclosure at all, and is visually hidden by CSS so there
  is exactly one control.

  IT LIVES AT THE TOP OF THE PANE, under the launcher title, NOT in the
  running-sessions heading where the adopt-only version of it used to
  sit. That section is `display:none` until a session exists, so the one
  explanation of how to adopt a session you started yourself was hidden
  from exactly the user who had not started one yet.

  THE MARKER IS AN INLINE SVG in the same family as the `.new-fab__icon`
  set: viewBox "0 0 24 24" with stroke-width 1.8 as a PRESENTATION
  ATTRIBUTE on the svg, inherited by the paths. Do not move stroke-width
  into a CSS svg rule - a presentation attribute on a child path beats
  it, which has silently defeated stroke restyles here twice.

  EVERY SENTENCE IS A CATALOG MESSAGE; every COMMAND is not. A shell
  command is typed into a terminal and has to work byte for byte, so the
  three of them are data in client/js/labels/home-screen.js rather than
  messages a translator would reasonably rewrite.
-->
<script lang="ts">
    import { t } from '../i18n/index.svelte';
    import RichText from './RichText.svelte';
    import {
        HELP_COMMANDS,
        HELP_README_URL,
        HOME_KEYS,
    } from '../../../../client/js/labels/home-screen.js';
</script>

<details class="adopt-disclosure">
    <summary aria-label={t(HOME_KEYS.helpLabel)} title={t(HOME_KEYS.helpControl)}>
        <!-- ONE LINE, and that is not a formatting accident: the marker's
             geometry is asserted by tests/test_home_screen_polish.node.mjs
             with a single-line tag match, because the trap it guards -
             a CSS `svg { stroke-width }` rule losing to a presentation
             attribute on a child path - has eaten two restyles here. -->
        <svg class="adopt-disclosure__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
            <line x1="12" y1="17.5" x2="12" y2="17.5" />
        </svg>
    </summary>
    <div class="adopt-disclosure-body">
        <p><strong>{t(HOME_KEYS.helpAdoptHeading)}</strong></p>
        <p><RichText message={t(HOME_KEYS.helpAdoptIntro)} /></p>
        <pre class="adopt-disclosure-code"><code>{HELP_COMMANDS.adopt}</code></pre>
        <p><RichText message={t(HOME_KEYS.helpAdoptExternal)} /></p>
        <p><RichText message={t(HOME_KEYS.helpAdoptOneline)} /></p>
        <pre class="adopt-disclosure-code"><code>{HELP_COMMANDS.oneLine}</code></pre>
        <p><RichText message={t(HOME_KEYS.helpAdoptExecShell)} /></p>
        <p><RichText message={t(HOME_KEYS.helpAdoptLauncher)} /></p>
        <pre class="adopt-disclosure-code"><code>{HELP_COMMANDS.launcher}</code></pre>
        <p><RichText message={t(HOME_KEYS.helpAdoptReadme)} href={HELP_README_URL} /></p>

        <p><strong>{t(HOME_KEYS.helpWrappersHeading)}</strong></p>
        <p><RichText message={t(HOME_KEYS.helpWrappersSame)} /></p>
        <p><RichText message={t(HOME_KEYS.helpWrappersConfigure)} /></p>

        <p><strong>{t(HOME_KEYS.helpSlashHeading)}</strong></p>
        <p><RichText message={t(HOME_KEYS.helpSlashBody)} /></p>
    </div>
</details>
