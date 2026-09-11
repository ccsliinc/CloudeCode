/**
 * Every plugin this bundle ships, registered at import time.
 *
 * THIS IS THE WHOLE "PLUGIN LOADER". It is an import list and a loop.
 * There is no directory scan, no fetch, no manifest and no `import()` of
 * a path assembled at runtime, because `script-src 'self'` forbids the
 * only shapes those could take in a browser tab. A plugin is added to
 * this list, in a pull request, and compiled in.
 *
 * WHY A FILE OF ITS OWN RATHER THAN A LINE IN `main.ts`. The tests import
 * this module for its side effect, which they cannot do with `main.ts`:
 * that file publishes `window.CloudeWeb` and throws if the name is
 * already taken. Keeping registration here also means the list of what
 * ships is one greppable place rather than a statement buried in the
 * entry point.
 */
import { register } from './registry';
import { markUnreadPlugin } from './mark-unread/index';
import type { Plugin } from './types';

/**
 * The ship list, in the order it happens to be written. Order here does
 * NOT decide paint order - `registry.surfacesOf` sorts on each
 * contribution's own `order` and then its id, precisely so this array
 * can be reordered without moving a control on screen.
 */
const BUILTIN: readonly Plugin[] = [markUnreadPlugin];

for (const plugin of BUILTIN) register(plugin);
