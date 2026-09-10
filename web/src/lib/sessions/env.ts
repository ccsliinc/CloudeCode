/**
 * The host `window` and `document`, if this realm has them.
 *
 * TWO THINGS FORCED THIS FILE, AND BOTH WERE MEASURED.
 *
 * FIRST, `window` IS NOT `globalThis` EVERYWHERE. The methods this slice
 * ported read `window.Auth`, `window.UIFlags` and
 * `window.ProjectListRenderGuard`, and in a browser that is the same
 * object `globalThis` names. In a node `vm` sandbox it is not: the
 * harness builds a plain object, hangs it on the context as `window`, and
 * `globalThis` there is the context. A port that reached for `globalThis`
 * found nothing, the poller's auth gate answered false, and the tick
 * silently never ran - measured in
 * `tests/test_project_list_render_guard.node.mjs`, where it looked exactly
 * like a repaint bug.
 *
 * SECOND, A BARE `window` REFERENCE THROWS WHERE A PROPERTY READ WOULD
 * NOT. Vitest runs this tree in the `node` environment on purpose, since
 * everything here is strings and data; there, `window` is not a variable
 * that is undefined, it is a name that does not exist, so touching it is
 * a `ReferenceError` rather than an `undefined`. `typeof` is the only
 * read that is safe in all three realms, and putting it in one place is
 * what stops the next module getting it right in two of them.
 *
 * NOT A COMPATIBILITY SHIM. Nothing here invents a window, fakes a
 * document or provides a default. Absent means absent, and every caller
 * has to say what absent means for it.
 */

/** A window-shaped object, as this layer reads it. */
export type MaybeWindow = (Window & typeof globalThis) | undefined;

/**
 * The host window, or undefined.
 *
 * Description: `typeof` guarded, so it is safe in a realm that has no
 *   such name at all. Reads the BARE `window`, not `globalThis.window`,
 *   because that is what resolves to a vm sandbox's own window object.
 * Inputs: none. Output: MaybeWindow.
 * Example: const auth = hostWindow()?.Auth;
 */
export function hostWindow(): MaybeWindow {
    return typeof window !== 'undefined' ? window : undefined;
}

/**
 * The host document, or undefined.
 *
 * Description: the same `typeof` guard, for the same reason. It is passed
 *   to `ProjectListRenderGuard.shouldPoll`, which reads
 *   `#launchpad-screen` off it.
 * Inputs: none. Output: Document | undefined.
 * Example: guard.shouldPoll(hostDocument());
 */
export function hostDocument(): Document | undefined {
    return typeof document !== 'undefined' ? document : undefined;
}
