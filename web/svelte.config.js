/**
 * Svelte compiler options for the web/ build.
 *
 * Description: Svelte 5 with runes forced ON. Runes are otherwise decided
 *   per file by whether the file happens to use one, which makes the
 *   dialect a property of the code rather than of the project - exactly
 *   the kind of thing that drifts across a long migration. There is no
 *   SvelteKit here and there must not be: this project has a Python
 *   server and adding a node one is a second thing to deploy, supervise
 *   and keep alive on the mini.
 * Inputs: none (read by @sveltejs/vite-plugin-svelte at build time).
 * Output: object - the Svelte config.
 */
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
    preprocess: vitePreprocess(),
    compilerOptions: {
        runes: true,
    },
};
