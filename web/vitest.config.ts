/**
 * Vitest configuration for the web/ tree.
 *
 * Description: Node environment on purpose. Every test here is about
 *   STRINGS - the markup a pure function returns and the text of a
 *   stylesheet read off disk - so a DOM implementation would be a
 *   dependency bought for nothing. A test that needs a document should
 *   arrive with its own reason and its own environment comment.
 *
 *   The Svelte plugin is loaded so a `.svelte` import compiles inside a
 *   test, which is what lets a future round test a component here rather
 *   than growing a second harness.
 * Inputs: none. Output: object - the Vitest config.
 */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
    plugins: [svelte({ hot: false })],
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        reporters: ['default'],
    },
});
