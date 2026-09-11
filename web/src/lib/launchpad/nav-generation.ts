/**
 * The compiled tree's access to `client/js/navigation-generation.js`.
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly because the alternative
 * looked fine and was not. `client/js/launchpad.js` declared a navigation
 * generation before every await that ends in a session on screen, and
 * carried the token into the `session-created` event as `detail.nav`.
 * That file is deleted; this tree is what replaced it. The tokens did not
 * come across with the behaviour, and the way they failed to is the whole
 * reason this module is written down rather than inlined.
 *
 * THE FAILURE IS SILENT BY CONSTRUCTION. `client/js/app.js`'s
 * `session-created` listener reads:
 *
 *     if (window.NavigationGeneration && e.detail.nav != null
 *         && !window.NavigationGeneration.keep(e.detail.nav, 'session create')) return;
 *
 * `detail.nav != null` is a TOLERANCE for a dispatcher that has no token,
 * and it is correct on its own terms - a dispatcher that never had one
 * must not be refused. But it means a dispatcher that SHOULD have one and
 * does not is waived rather than caught. Nothing throws, nothing logs,
 * every test passes, and the stale-navigation guard is simply absent for
 * that path. Click a project, click a running row before the create
 * settles, and the create's completion paints over the row you are
 * looking at. That is gotcha 7's shape, one layer up.
 *
 * ABSENT MEANS PROCEED, AND THAT IS NOT THE SAME TOLERANCE. The legacy
 * call sites all read `window.NavigationGeneration ? ... : null` and
 * `if (window.NavigationGeneration && !keep(...)) return`, so a MISSING
 * MODULE lets every completion through. That rule is kept here verbatim:
 * this module is a classic script loaded before the bundle, so in a
 * browser it is always there, and it is absent only in a test realm or a
 * load-order regression. Refusing every navigation because a script did
 * not load would turn a load-order bug into a dead home screen. The
 * distinction worth holding: absent MODULE means proceed, absent TOKEN on
 * a path that should carry one is the defect this file prevents.
 *
 * READ PER CALL, NEVER CAPTURED - the same rule as `nav-host.ts`, for the
 * same reason. The bundle is a deferred module and these are classic
 * scripts; capturing at import time captures whatever had evaluated by
 * then.
 */
import { hostWindow } from '../sessions/env';

/**
 * A generation token. Opaque on purpose.
 *
 * The legacy module's `begin()` returns a number and this tree has no
 * business knowing that: the only legal operations are to carry it and to
 * hand it back to `keepNav`. Typing it as a number here would invite a
 * comparison, and a token compared by value rather than by `keep` is how
 * two navigations to the SAME session get conflated, which the legacy
 * module's own docblock refuses by design.
 */
export type NavToken = unknown;

/** The shape `client/js/navigation-generation.js` publishes. */
interface NavigationGenerationApi {
    begin(target: string): NavToken;
    current(): NavToken;
    keep(token: NavToken, what: string): boolean;
}

/**
 * The live module, or null when this realm has none.
 *
 * Description: resolved per call. Null in vitest (the `node` environment,
 *   no `window`) and in any realm where the classic script did not load.
 * Inputs: none. Output: NavigationGenerationApi | null.
 * Example: const nav = navigationGeneration();
 */
function navigationGeneration(): NavigationGenerationApi | null {
    const win = hostWindow() as unknown as
        | { NavigationGeneration?: NavigationGenerationApi }
        | undefined;
    const api = win?.NavigationGeneration;
    return api && typeof api.begin === 'function' ? api : null;
}

/**
 * Declare a navigation, BEFORE the first await of the path that serves it.
 *
 * Description: the token must be taken before any await, not after. Taken
 *   after, it is a generation the user's later click has already
 *   superseded, and `keepNav` would then approve a completion that should
 *   have been discarded - a guard that reads correctly and guards
 *   nothing.
 * Inputs: target - a short label for the debug log, e.g. `project:api`.
 * Output: NavToken. Null when no module is present, which `keepNav`
 *   treats as proceed.
 * Example: const nav = beginNav('project:' + project.name);
 */
export function beginNav(target: string): NavToken {
    return navigationGeneration()?.begin(target) ?? null;
}

/**
 * Read the navigation already in flight, without starting one.
 *
 * Description: for a path that SERVES a navigation someone else declared
 *   - the deep-link resolver is the worked example, since the router
 *   declared the generation when it handled the URL. Beginning one there
 *   would supersede the router's own token and make the router's later
 *   check pass when it should fail.
 * Inputs: none. Output: NavToken.
 * Example: const nav = currentNav();
 */
export function currentNav(): NavToken {
    return navigationGeneration()?.current() ?? null;
}

/**
 * Whether the navigation this token names is still the one on screen.
 *
 * Description: FALSE MEANS DISCARD, SILENTLY. It never means retry and it
 *   never means show an error - the user got what they asked for, which
 *   was the newer screen. In particular a stale generation is not a
 *   rejected deep-link target and must never reach `rejectTarget`'s
 *   banner. That is the legacy module's stated contract and this wrapper
 *   does not get to soften it.
 * Inputs: token - from `beginNav` or `currentNav`; what - a label for the
 *   debug log. Output: boolean. True when no module is present.
 * Example: if (!keepNav(nav, 'launcher rejoin')) return;
 */
export function keepNav(token: NavToken, what: string): boolean {
    const api = navigationGeneration();
    if (!api) return true;
    return api.keep(token, what);
}

/**
 * Fold a token into a `session-created` detail.
 *
 * Description: ONE PLACE THAT SPELLS THE KEY, because the key is the
 *   entire contract with `app.js`'s listener and it is spelled `nav`
 *   there. A dispatcher that wrote `navigation` or `navToken` would be
 *   waived by that listener's `detail.nav != null` tolerance and would
 *   look exactly like a working guard. `tests/test_session_created_nav.node.mjs`
 *   asserts the key against the real listener source for that reason.
 *
 *   A NULL TOKEN IS OMITTED RATHER THAN SENT AS NULL. The listener tests
 *   `!= null`, so the two are equivalent to it today; omitting keeps them
 *   equivalent if that test ever tightens to `'nav' in detail`.
 * Inputs: detail - the event payload being built; nav - the token.
 * Output: the same shape, with `nav` added when there is one.
 * Example: host.announceSessionCreated(withNav({ session }, nav));
 */
export function withNav(
    detail: Record<string, unknown>,
    nav: NavToken,
): Record<string, unknown> {
    return nav == null ? detail : { ...detail, nav };
}
