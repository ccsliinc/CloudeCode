// Where the home screen's SOURCE lives, after slice 7.
//
// WHY THIS EXISTS. Sixteen node suites read `client/js/launchpad.js` to
// assert something about the home screen's markup or its wiring, and
// slice 7 of the Svelte migration deleted that file. The markup is
// `web/src/lib/launchpad/HomeScreen.svelte` and its help panel, the
// wiring is the modules beside them, and the COPY is the catalog. Every
// one of those suites now reads this module instead of naming a path, so
// the next slice that moves a file edits one line rather than sixteen.
//
// IT IS A SOURCE READ, NOT A SANDBOX. The `vm` harness that used to
// evaluate the launchpad class is gone with the class: what those suites
// actually asserted was the shape of a string, and the BEHAVIOUR they
// stood in for is measured properly now by
// `web/src/lib/launchpad/HomeScreen.behaviour.test.ts`, which mounts the
// real component in jsdom. Do not rebuild a sandbox here.
//
// Not a test file: the suites are `tests/*.node.mjs`, this is `.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The repo root. */
export const ROOT = path.join(__dirname, '..');

/** Read one file under the repo root. */
function read(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

/** The shell's own markup: everything on the screen but the four lists. */
export const HOME_SCREEN_SRC = read('web', 'src', 'lib', 'launchpad', 'HomeScreen.svelte');

/** The help disclosure's markup. Its COPY is in the catalog, not here. */
export const HOME_HELP_SRC = read('web', 'src', 'lib', 'launchpad', 'HelpDisclosure.svelte');

/** The imperative wires: version chip, server controls, help, disclosures. */
export const HOME_CHROME_SRC = read('web', 'src', 'lib', 'launchpad', 'home-chrome.ts');

/** The speed dial's placement, open/close and teardown. */
export const HOME_FAB_SRC = read('web', 'src', 'lib', 'launchpad', 'new-fab.ts');

/** Every slice 7 source, concatenated, for a "nowhere in the shell" scan. */
export const HOME_ALL_SRC = [
    HOME_SCREEN_SRC,
    HOME_HELP_SRC,
    HOME_CHROME_SRC,
    HOME_FAB_SRC,
    read('web', 'src', 'lib', 'launchpad', 'home-screen-host.ts'),
    read('web', 'src', 'lib', 'launchpad', 'home-sections.ts'),
    read('web', 'src', 'lib', 'launchpad', 'panels.ts'),
    read('web', 'src', 'lib', 'launchpad', 'navigation.ts'),
    read('web', 'src', 'lib', 'launchpad', 'status-report.ts'),
].join('\n');

/**
 * The en catalog, as a plain object.
 *
 * Description: the home screen's user-visible copy moved out of the
 *   markup entirely in slice 7, so a suite asserting what a sentence
 *   SAYS reads this, and a suite asserting where it APPEARS reads the
 *   component. Loaded with a dynamic import because `catalog.en.js` is
 *   an ES module and these suites are too.
 * Inputs: none. Output: Promise<Object<string, string|object>>.
 * Example: const cat = await catalog(); cat['home.section.recent'];
 */
export async function catalog() {
    const mod = await import(
        path.join(ROOT, 'client', 'js', 'i18n', 'catalog.en.js')
    );
    return mod.default;
}

/**
 * Every help-panel message, in the order the panel renders them.
 *
 * Description: WHAT `test_launchpad_help_content` USED TO EXTRACT with a
 *   regex over a template literal. The prose carries the marker set
 *   `[[code]]`, `((em))` and `<<link>>`, which is stripped here so a
 *   copy assertion reads the sentence a human sees rather than its
 *   markup.
 * Inputs: none. Output: Promise<string[]>.
 * Example: (await helpMessages()).join('\n')
 */
export async function helpMessages() {
    const cat = await catalog();
    return Object.keys(cat)
        .filter((key) => key.startsWith('home.help.'))
        .map((key) => String(cat[key]));
}

/** The labels module: the help commands and the README url live here. */
export const HOME_LABELS_SRC = read('client', 'js', 'labels', 'home-screen.js');

/** One help message with its `[[ ]]`, `(( ))` and `<< >>` markers removed. */
export function plain(message) {
    return String(message)
        .replace(/\[\[([\s\S]*?)\]\]/g, '$1')
        .replace(/\(\(([\s\S]*?)\)\)/g, '$1')
        .replace(/<<([\s\S]*?)>>/g, '$1');
}
