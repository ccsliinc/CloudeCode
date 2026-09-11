/**
 * Every sentence the home screen's SHELL can print.
 *
 * SLICE 7's HALF OF THE STRING LAYER, and the last one this screen
 * needs. Same pattern as `project-tree.js`, `running-session.js` and
 * `project-create.js`: a pure ES module taking `(data, t)`, imported
 * directly by the Svelte tree and reachable from the legacy tree through
 * `globalThis.CloudeLabels`.
 *
 * WHAT IS IN HERE AND WHAT IS NOT. The shell owns the section headings,
 * the "+" menu, the help disclosure, the home bar, and the sentences the
 * navigation glue prints when something refuses. It does NOT own a row,
 * a pill or a count - those went with their lists in slices 2, 4 and 5,
 * and asking for them here would be a second copy.
 *
 * THE SHELL CARRIES ONE KIND OF STRING THE OTHER FILES DO NOT: a whole
 * PARAGRAPH of help prose with inline code spans in it. Those messages
 * carry markers (`[[code]]`, `((emphasis))`, `<<link>>`) expanded by
 * `web/src/lib/launchpad/rich-text.ts`. The alternative was splitting a
 * paragraph into four fragments around its <code> elements, which fixes
 * the word order in english and makes the paragraph untranslatable. A
 * marker set is not a mini-language: no expressions, no nesting, one
 * pass, and nothing is compiled.
 *
 * NO STRING IN HERE IS A LITERAL. Everything is a `t()` call or a value
 * that came in as data.
 */

/** Every key the home shell asks the catalog for. */
export const HOME_KEYS = {
    // The three section headings. There is deliberately no "loading
    // projects" key: that placeholder lived in a panel CONTAINER, which
    // the panel owns and which `mountPanel` appends into rather than
    // clearing, so it survived on screen forever. `ProjectTree.svelte`
    // renders its own empty state.
    sectionRunning: 'home.section.running',
    sectionRecent: 'home.section.recent',
    sectionProjects: 'home.section.projects',
    // The "+" speed dial: its trigger, its menu, and its five actions.
    newTrigger: 'home.new.trigger',
    newMenu: 'home.new.menu',
    newClaudeProject: 'home.new.claude_project',
    newSession: 'home.new.session',
    newOpenclaw: 'home.new.openclaw',
    newHermes: 'home.new.hermes',
    newConsole: 'home.new.console',
    // The bottom bar.
    barLabel: 'home.bar.label',
    barServerControls: 'home.bar.server_controls',
    barServerControlsUnavailable: 'home.bar.server_controls_unavailable',
    barSiteLink: 'home.bar.site_link',
    barSiteMark: 'home.bar.site_mark',
    // The inline error card's dismiss control.
    errorDismiss: 'home.error.dismiss',
    showArchived: 'home.toggle.show_archived',
    // The help disclosure.
    helpControl: 'home.help.control',
    helpLabel: 'home.help.label',
    helpAdoptHeading: 'home.help.adopt.heading',
    helpAdoptIntro: 'home.help.adopt.intro',
    helpAdoptExternal: 'home.help.adopt.external',
    helpAdoptOneline: 'home.help.adopt.oneline',
    helpAdoptExecShell: 'home.help.adopt.exec_shell',
    helpAdoptLauncher: 'home.help.adopt.launcher',
    helpAdoptReadme: 'home.help.adopt.readme',
    helpWrappersHeading: 'home.help.wrappers.heading',
    helpWrappersSame: 'home.help.wrappers.same',
    helpWrappersConfigure: 'home.help.wrappers.configure',
    helpSlashHeading: 'home.help.slash.heading',
    helpSlashBody: 'home.help.slash.body',
    // Navigation: what the status line says, and how each step refuses.
    statusConnecting: 'home.status.connecting',
    statusDetaching: 'home.status.detaching',
    statusOpening: 'home.status.opening',
    connectFailed: 'home.nav.connect_failed',
    detachFailed: 'home.nav.detach_failed',
    openFailed: 'home.nav.open_failed',
    attachFailed: 'home.nav.attach_failed',
    returnFailed: 'home.nav.return_failed',
    sessionNotFound: 'home.nav.session_not_found',
    deepLinkRefusesCreate: 'home.nav.deeplink_refuses_create',
    // Why a project row refused to open.
    refusedFallbackName: 'home.project.refused.fallback_name',
    refusedFallbackPath: 'home.project.refused.fallback_path',
    refusedMissing: 'home.project.refused.missing',
    refusedUnreachable: 'home.project.refused.unreachable',
    refusedUnreachableDetail: 'home.project.refused.unreachable_detail',
    refusedUnknown: 'home.project.refused.unknown',
};

/**
 * The three shell commands the help panel shows, verbatim.
 *
 * Description: A COMMAND IS NOT COPY. These are typed into a shell and
 *   have to work byte for byte, so they are DATA beside the catalog
 *   rather than messages in it - a translated `tmux -L cloude` is a
 *   broken instruction, and a translator offered one would reasonably
 *   change it. Kept here, next to the prose that introduces them, so the
 *   two cannot drift into describing different commands.
 * @type {{adopt: string, oneLine: string, launcher: string}}
 */
export const HELP_COMMANDS = {
    adopt: 'tmux -L cloude new -s mywork; claude',
    oneLine: 'tmux -L cloude new -s mywork "claude --dangerously-skip-permissions; exec $SHELL"',
    launcher: "tmux -L cloude new -s mywork \"$SHELL -ic 'cld; exec $SHELL'\"",
};

/** Where `<<README>>` in the help prose points. */
export const HELP_README_URL =
    'https://github.com/Adoom666/CloudeCode#before-you-start-three-things-that-will-bite-you';

/**
 * The sentence for one refused project row, and which rung said it.
 *
 * Description: THREE OUTCOMES, AND THE THIRD IS THE POINT. `missing` is
 *   a MEASURED fact: the folder is not there. `unreachable` is the
 *   probe failing to answer, which is NOT evidence the project is gone,
 *   and telling the user it is missing would invent a verdict nobody
 *   measured. Anything else reaching here means the row was disabled for
 *   a reason this function does not know, and it says exactly that.
 *
 *   The rung is returned beside the text so a test can assert WHICH
 *   branch answered without matching on english.
 * Inputs:
 *   data - {name, path, presence, detail}; every field may be absent.
 *   t - the translate function.
 * Output: {rung: 'missing'|'unreachable'|'unknown', text: string}
 * Example: refusedProjectNotice({presence: 'missing', path: '/a'}, t)
 */
export function refusedProjectNotice(data, t) {
    const d = data || {};
    const name = d.name || t(HOME_KEYS.refusedFallbackName);
    const path = d.path || t(HOME_KEYS.refusedFallbackPath);
    const presence = d.presence || 'unchecked';
    if (presence === 'missing') {
        return { rung: 'missing', text: t(HOME_KEYS.refusedMissing, { name, path }) };
    }
    if (presence === 'unreachable') {
        const detail = d.detail || t(HOME_KEYS.refusedUnreachableDetail);
        return {
            rung: 'unreachable',
            text: t(HOME_KEYS.refusedUnreachable, { name, path, detail }),
        };
    }
    return {
        rung: 'unknown',
        text: t(HOME_KEYS.refusedUnknown, { name, path, state: presence }),
    };
}

/**
 * The `{reason}` slot's value for a caught error.
 *
 * Description: an error with no message is NOT an empty reason - it is
 *   an unreachable server, and saying so is a different sentence from
 *   saying nothing. Same rule the create flows use, reused rather than
 *   copied.
 * Inputs: error (unknown); t.
 * Output: string.
 * Example: failureReason(new Error('boom'), t)   // 'boom'
 */
export function failureReason(error, t) {
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
        return error.message;
    }
    const text = error == null ? '' : String(error);
    return text || t('error.server_unreachable');
}
