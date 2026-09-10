/**
 * Vitest configuration for the web/ tree.
 *
 * Description: Node environment BY DEFAULT. Most tests here are about
 *   STRINGS - the value a pure function returns and the text of a
 *   stylesheet read off disk - so a DOM implementation would be a
 *   dependency bought for nothing. A test that needs a document opts in
 *   with a `@vitest-environment jsdom` docblock AND a comment saying
 *   why; slice 4 has two, and both are about what a MOUNTED component
 *   does rather than about what a function returned.
 *
 *   `resolve.conditions` CARRIES `browser`, AND WITHOUT IT NOTHING CAN
 *   MOUNT. Vite resolves a package's export conditions for the server by
 *   default, so `import { mount } from 'svelte'` lands on Svelte's SSR
 *   build, whose `mount` exists only to throw
 *   `lifecycle_function_unavailable`. The failure reads like a broken
 *   test environment and is really a resolution setting; naming it here
 *   saves the next person the hour.
 *
 *   The Svelte plugin is loaded so a `.svelte` import compiles inside a
 *   test.
 * Inputs: none. Output: object - the Vitest config.
 */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte({ hot: false })],
    resolve: { conditions: ['browser'] },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        reporters: ['default'],
    },
});
