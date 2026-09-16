/**
 * THE DEVELOPMENT PREVIEW HARNESS'S VITE CONFIG. SCAFFOLDING. NOT SLICE 3.
 *
 * WHAT THIS IS. `web/dev-harness/` mounts the real `NavRail` (slice 5)
 * and the real `TranscriptList` (slice 6) against the real archive API
 * so a person can click through them TODAY. Both components were built
 * shell-independent on purpose, because Adam is replacing the whole
 * application shell (issue #175), so the screen that would normally host
 * them does not exist and will not exist for a while. The result was two
 * finished components nobody could look at. This closes that and nothing
 * else.
 *
 * WHAT THIS IS NOT. It is NOT the archive screen, it is NOT slice 3, and
 * nothing here is a contract. When the real shell arrives, DELETE
 * `web/dev-harness/`, this file and the `dev:harness` script; nothing
 * under `web/src/` imports any of it, which is checked by
 * `src/dev-harness-isolation.test.ts`.
 *
 * WHY A SECOND CONFIG RATHER THAN A `server` BLOCK IN `vite.config.ts`.
 * `vite.config.ts` describes a PRODUCTION BUILD that writes fixed-name
 * assets into `client/dist/`, and its own header says in as many words
 * that there is no dev server. Adding one to it would put a development
 * convenience inside the file that decides what ships. This config emits
 * nothing: there is no `build` block and no build script pointed at it,
 * so it cannot contribute a byte to `client/dist/`.
 *
 * THE PROXY IS WHY AUTH WORKS AT ALL, AND IT WEAKENS NOTHING. The page
 * is served from the Vite origin and the API lives on the FastAPI one,
 * so `/api/v1` is proxied rather than called cross-origin. Every request
 * still carries the same `Authorization: Bearer` header the real app
 * sends, still hits the same authenticated routes, and is still refused
 * without a token: the harness logs in with a real TOTP code through the
 * real `/api/v1/auth/verify`. No auth is disabled, no CORS is relaxed,
 * no CSP is touched, and no credential is stored in this tree.
 */
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

/** The harness's own web root. `index.html` lives here. */
const harnessRoot = fileURLToPath(new URL('./dev-harness', import.meta.url));

/**
 * The repository root, so the harness may READ `client/css/archive*.css`
 * and the three vanilla modules the components depend on. Read only:
 * nothing in `web/dev-harness/` writes to either tree.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * `web/svelte.config.js`, NAMED EXPLICITLY AND NOT OPTIONAL. The plugin
 * looks for a Svelte config beside its ROOT, which here is
 * `web/dev-harness/`, so it would find none and fall back to its
 * defaults - and `runes: true` would then be off for this compile. The
 * real components are compiled BY THIS CONFIG when the harness runs, so
 * a preview that dropped the project's forced dialect would be showing
 * them built differently from the way they ship. That is the one thing a
 * preview may not do.
 */
const svelteConfig = fileURLToPath(new URL('./svelte.config.js', import.meta.url));

/** Where the live CloudeCode server is. Overridable for a second install. */
const apiTarget = process.env.CLOUDE_HARNESS_API || 'http://127.0.0.1:8000';

/** Not 5000: that is AirPlay on macOS. Not 5173 either, to sit clear of
 *  any other Vite a person already has open. */
const HARNESS_PORT = 5174;

export default defineConfig({
    root: harnessRoot,
    plugins: [svelte({ configFile: svelteConfig })],
    server: {
        port: HARNESS_PORT,
        strictPort: true,
        open: false,
        // The archive stylesheets and the three vanilla modules live in
        // `client/`, which is outside `root`. Vite refuses to serve
        // outside its root unless told, and the allowance is the REPO,
        // not the filesystem.
        fs: { allow: [repoRoot] },
        proxy: {
            '/api/v1': {
                target: apiTarget,
                changeOrigin: false,
                ws: false,
            },
        },
    },
});
