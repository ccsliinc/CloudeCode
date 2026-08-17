/**
 * File editor - which roots the picker browses, and WHY one is missing.
 *
 * Extracted from config-editor-panel.js so the decision "does this root
 * get listed, and if not what does the user get told instead" is a pure
 * function with no DOM, testable directly
 * (tests/test_config_editor_roots.node.mjs).
 *
 * THE BUG THIS MODULE EXISTS TO KILL. The panel used to skip the two
 * project roots with a bare `continue` whenever the working directory
 * could not be resolved. The result was a tree that rendered ~/.claude
 * alone, looked complete, and said nothing - a short tree is
 * indistinguishable from a correct one, so the user reads it as "my
 * project files are gone". Absence must be NARRATED: three outcomes
 * (listed / genuinely absent / could not evaluate), never two.
 */

/**
 * Single source of truth for the three roots the panel browses: API root
 * id, display label, and default expand/collapse state. "user" and
 * "project" default OPEN (small, config-focused, the reason this feature
 * exists); "workdir" defaults CLOSED (a real project directory can be
 * arbitrarily large - same reasoning as plugins/ being force-collapsed,
 * just a per-user-choice default rather than a forced one, since a small
 * project's workdir is perfectly reasonable to browse open).
 * @type {Array<{id: string, label: string, defaultExpanded: boolean}>}
 */
const CONFIG_EDITOR_ROOTS = [
    { id: 'user', label: '~/.claude', defaultExpanded: true },
    { id: 'project', label: 'project .claude', defaultExpanded: true },
];

/**
 * Resolve the active project's working directory, and - when it cannot be
 * resolved - WHY. Reads TerminalController's current session rather than
 * tracking a copy: single source of truth for "what session is attached
 * right now".
 *
 * The session object is a WRAPPER on some paths (SessionInfo, from
 * `GET /sessions/{id}` via the launchpad rejoin and the deep-link router)
 * and a bare Session on others (the create and adopt responses). The real
 * fields live at `wrapper.session.*` in the first case, which is the same
 * unwrap TerminalController._unwrapSession performs.
 *
 * @param {object|null|undefined} terminalController  window.TerminalController.
 * @returns {{path: string|null, reason: 'ok'|'no-session'|'no-working-dir'}}
 *   `path` is the absolute working directory when reason is 'ok', else null.
 */
function resolveProjectContext(terminalController) {
    const tc = terminalController;
    if (!tc || !tc._currentSession) return { path: null, reason: 'no-session' };
    const s = tc._currentSession;
    const unwrapped = s; // MUTATION B: no unwrap
    const workingDir = unwrapped && unwrapped.working_dir;
    if (!workingDir) return { path: null, reason: 'no-working-dir' };
    return { path: workingDir, reason: 'ok' };
}

/**
 * The user-facing sentence for a project context that did not resolve.
 * Lowercase UI voice, and it names BOTH what is missing and what to do.
 * @param {'ok'|'no-session'|'no-working-dir'} reason  From resolveProjectContext.
 * @returns {string|null}  Null when reason is 'ok' (nothing to explain).
 */
function projectRootsNotice(reason) {
    if (reason === 'no-session') {
        return 'no session attached, so only ~/.claude is listed. '
            + 'open a session to browse project .claude and project files.';
    }
    if (reason === 'no-working-dir') {
        return 'the attached session reports no working directory, so '
            + 'project .claude and project files cannot be listed.';
    }
    return null;
}

/**
 * The user-facing sentence for a root the server had nothing to return
 * for. Distinct from projectRootsNotice: here the working directory IS
 * known, so the row can name it.
 * @param {string} label  The root's display label, e.g. "project .claude".
 * @param {'unavailable'|'empty'} reason  Server said no such root / no entries.
 * @param {string} projectPath  Absolute working directory.
 * @returns {string}  One lowercase sentence.
 */
function missingRootNotice(label, reason, projectPath) {
    const where = projectPath || 'the working directory';
    if (reason === 'empty') return `${label}: nothing to list in ${where}.`;
    return `${label}: not present in ${where}.`;
}

/**
 * Turn a project context into the ordered list of things the tree must
 * render. Every root is either fetched or explained - nothing is dropped
 * silently, which is the whole point of this function existing.
 * @param {{path: string|null, reason: string}} context  From resolveProjectContext.
 * @returns {Array<{kind: 'root', def: object} | {kind: 'notice', message: string}>}
 */
function planRoots(context) {
    const plan = [];
    const resolved = !!(context && context.path);
    for (const def of CONFIG_EDITOR_ROOTS) {
        if (def.id === 'user' || resolved) {
            plan.push({ kind: 'root', def });
        }
    }
    // MUTATION A: silently short plan
    return plan;
}

window.ConfigEditorRoots = {
    ROOTS: CONFIG_EDITOR_ROOTS,
    resolveProjectContext,
    projectRootsNotice,
    missingRootNotice,
    planRoots,
};
console.log('[ConfigEditorRoots Module] Exported as window.ConfigEditorRoots');
