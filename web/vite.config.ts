/**
 * Vite build for the Svelte half of the strangler migration.
 *
 * WHAT THIS BUILD IS AND IS NOT. It is a plain SPA bundle, built once and
 * written to disk. There is no dev server, no HMR, no SSR and no node
 * process at runtime: FastAPI serves the emitted files off disk under
 * /static exactly as it serves client/js and client/css today. Run
 * `npm run build` (or `npm run watch`) and reload the page.
 *
 * THE OUTPUT FILE NAMES ARE FIXED, AND THAT IS THE WHOLE POINT.
 * client/index.html is a hand-maintained file that keeps loading the
 * legacy client/js scripts for the duration of the migration, so it has
 * to reference this bundle by a name that never changes. Content hashes
 * would mean rewriting a 1400-line HTML file on every build, by hand or
 * by a generator nobody asked for. Cache correctness is not lost: the
 * server stamps `Cache-Control: no-cache, must-revalidate` on every .js
 * and .css it serves (see NoCacheStaticFiles in src/main.py), so the
 * browser revalidates each load and gets a 304 or the new bytes.
 *
 * NO HTML IS EMITTED. `build.rollupOptions.input` points straight at a
 * TypeScript entry rather than at an index.html, which is what stops
 * Vite's HTML plugin generating a document and, with it, the inline
 * module preload script that `script-src 'self'` would refuse. We own
 * client/index.html; Vite may not write one.
 *
 * NOTHING MAY BE LOADED OFF-ORIGIN. tests/test_no_remote_assets.py fails
 * the build if a third-party URL appears in client/index.html or in the
 * emitted bundle, so every dependency has to end up inside these files.
 */
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** Absolute path to web/src/main.ts, the single entry point. */
const entry = fileURLToPath(new URL('./src/main.ts', import.meta.url));

/** Absolute path to client/dist, served by FastAPI as /static/dist. */
const outDir = fileURLToPath(new URL('../client/dist', import.meta.url));

export default defineConfig({
    plugins: [svelte(), tailwindcss()],
    build: {
        outDir,
        // client/dist is a committed directory. Wiping it wholesale would
        // delete anything a future round parks beside the bundle; Vite
        // removes only what it wrote.
        emptyOutDir: true,
        // A build artifact that is committed has to produce a bounded,
        // reviewable diff. `oxc` is Vite 8's own minifier and needs no
        // extra dependency; naming it explicitly rather than taking the
        // default is what stops a Vite upgrade changing the committed
        // bytes for a reason nobody chose.
        minify: 'oxc',
        // The bundle is served over LAN HTTP to phones and desktops. This
        // is the same baseline Vite's default targets, stated explicitly
        // so a Vite upgrade cannot move it silently.
        target: 'es2022',
        sourcemap: false,
        cssCodeSplit: false,
        rollupOptions: {
            input: entry,
            output: {
                // FIXED NAMES, NO HASHES. See the header.
                entryFileNames: 'app.js',
                chunkFileNames: 'chunk-[name].js',
                assetFileNames: (info) =>
                    info.names?.some((n) => n.endsWith('.css'))
                        ? 'app.css'
                        : 'asset-[name][extname]',
            },
        },
    },
});
