/**
 * Every sentence the create, clone, edit and archive flows can print.
 *
 * SLICE 6's HALF OF THE STRING LAYER. Same pattern as
 * `project-tree.js` and `recent-session.js`: a pure ES module taking
 * `(data, t)`, imported directly by the Svelte tree and reachable from
 * the legacy tree through `globalThis.CloudeLabels`.
 *
 * THE REFUSAL SENTENCES ARE THE POINT OF THIS FILE. A project name is
 * REFUSED and never rewritten, which means the refusal is the only thing
 * standing between a user and a folder they did not ask for - so it has
 * to be a sentence they can act on, and it has to be translatable like
 * every other sentence. `web/src/lib/launchpad/project-folder.ts` decides
 * WHICH rule refused and hands back a code; this turns the code into the
 * sentence. The en values are byte-identical to the ones
 * `src/core/project_directory.py` returns, so the client's answer and the
 * server's answer read the same.
 *
 * A THROWN SENTENCE STILL REACHES THE SCREEN. `saveProjectWithUniqueName`
 * used to `throw new Error('could not find a unique name for this
 * project')` and the catch printed `error.message`, so a hardcoded
 * English string was on screen with nothing marking it as copy. It now
 * throws an error carrying a KEY, and `uniqueNameFailure` is what renders
 * it. If you add a throw on these paths, give it a key.
 *
 * NO STRING IN HERE IS A LITERAL. Everything is a `t()` call or a value
 * that came in as data.
 */

/** Every key these flows ask the catalog for. */
export const PROJECT_CREATE_KEYS = {
    // The name step, and the seven ways a name is refused.
    nameRequired: 'project.name.refused.required',
    nameIllegalChar: 'project.name.refused.illegal_char',
    nameIllegalNull: 'project.name.refused.illegal_null',
    nameControlChars: 'project.name.refused.control_chars',
    nameReserved: 'project.name.refused.reserved',
    nameLeadingDot: 'project.name.refused.leading_dot',
    nameTooLong: 'project.name.refused.too_long',
    // The name modal itself.
    nameTitle: 'project.name.modal.title',
    nameTitleForAgent: 'project.name.modal.title_for_agent',
    nameAddTitle: 'project.name.modal.title_add',
    nameLabel: 'project.name.modal.name_label',
    namePlaceholder: 'project.name.modal.name_placeholder',
    nameHint: 'project.name.modal.name_hint',
    descriptionLabel: 'project.name.modal.description_label',
    descriptionPlaceholder: 'project.name.modal.description_placeholder',
    descriptionHint: 'project.name.modal.description_hint',
    folderLabel: 'project.name.modal.folder_label',
    confirmCreate: 'project.name.modal.confirm_create',
    confirmOpen: 'project.name.modal.confirm_open',
    cancel: 'project.modal.cancel',
    // The folder step.
    folderTitle: 'project.folder.modal.title',
    folderParentLabel: 'project.folder.modal.parent_label',
    folderParentHint: 'project.folder.modal.parent_hint',
    folderParentLoading: 'project.folder.modal.parent_loading',
    folderParentUnavailable: 'project.folder.modal.parent_unavailable',
    folderFullPath: 'project.folder.modal.full_path',
    folderNoPath: 'project.folder.modal.no_path',
    folderChoosePrompt: 'project.folder.modal.choose_prompt',
    folderPickerUnavailable: 'project.folder.modal.picker_unavailable',
    folderBrowse: 'project.folder.modal.browse',
    // The choice modal.
    choiceDefaultTitle: 'project.choice.default_title',
    choiceHint: 'project.choice.hint',
    choiceEmptyHint: 'project.choice.empty_hint',
    choiceEmptyFallback: 'project.choice.empty_fallback',
    choiceOk: 'project.choice.ok',
    // The "new claude project" menu.
    newProjectTitle: 'project.new.title',
    newProjectEmpty: 'project.new.empty',
    newProjectEmptySub: 'project.new.empty.sub',
    newProjectClone: 'project.new.clone',
    newProjectCloneSub: 'project.new.clone.sub',
    newProjectFolder: 'project.new.folder',
    newProjectFolderSub: 'project.new.folder.sub',
    // The "new session in an existing project" menu.
    newSessionTitle: 'project.session.title',
    newSessionPickTitle: 'project.session.pick_title',
    newSessionCannotDetermine: 'project.session.cannot_determine',
    newSessionNone: 'project.session.none',
    // Edit.
    editTitle: 'project.edit.modal.title',
    editFolderHint: 'project.edit.modal.folder_hint',
    editSave: 'project.edit.modal.save',
    editStatusUpdating: 'project.edit.status.updating',
    editStatusDone: 'project.edit.status.done',
    editFailed: 'project.edit.failed',
    // Archive and restore.
    archiveTitle: 'project.archive.confirm.title',
    archiveMessage: 'project.archive.confirm.message',
    archiveDetails: 'project.archive.confirm.details',
    archiveConfirm: 'project.archive.confirm.primary',
    archiveFailed: 'project.archive.failed',
    restoreFailed: 'project.restore.failed',
    // Clone.
    cloneTitle: 'project.clone.modal.title',
    cloneUrlLabel: 'project.clone.modal.url_label',
    cloneUrlPlaceholder: 'project.clone.modal.url_placeholder',
    cloneUrlHint: 'project.clone.modal.url_hint',
    cloneParentLabel: 'project.clone.modal.parent_label',
    cloneParentHint: 'project.clone.modal.parent_hint',
    cloneDescriptionPlaceholder: 'project.clone.modal.description_placeholder',
    cloneConfirm: 'project.clone.modal.confirm',
    cloneBusy: 'project.clone.status.busy',
    cloneNeedsUrl: 'project.clone.status.needs_url',
    cloneAuth: 'project.clone.error.auth',
    cloneNotFound: 'project.clone.error.not_found',
    cloneExists: 'project.clone.error.exists',
    cloneNoGh: 'project.clone.error.no_gh',
    cloneTimeout: 'project.clone.error.timeout',
    cloneFailed: 'project.clone.error.failed',
    // Create.
    createStatus: 'project.create.status',
    createStatusForAgent: 'project.create.status_for_agent',
    createConsoleStatus: 'project.create.console.status',
    createConsoleDescription: 'project.create.console.description',
    createFailed: 'project.create.failed',
    createFolderFailed: 'project.create.folder_failed',
    uniqueNameFailed: 'project.create.unique_name_failed',
};

/** Which catalog key each name-refusal code renders through. */
const REFUSAL_KEY_BY_CODE = {
    required: PROJECT_CREATE_KEYS.nameRequired,
    illegal_char: PROJECT_CREATE_KEYS.nameIllegalChar,
    illegal_null: PROJECT_CREATE_KEYS.nameIllegalNull,
    control_chars: PROJECT_CREATE_KEYS.nameControlChars,
    reserved: PROJECT_CREATE_KEYS.nameReserved,
    leading_dot: PROJECT_CREATE_KEYS.nameLeadingDot,
    too_long: PROJECT_CREATE_KEYS.nameTooLong,
};

/**
 * The sentence a refused project name gets, or null when it was accepted.
 *
 * Description: one message per RULE, never one message with the rule
 *   glued into it, because which character is illegal and why it is
 *   illegal are different facts and a translator needs the whole
 *   sentence to move them. An unrecognised code renders the generic
 *   "required" refusal rather than nothing: a modal that refuses with no
 *   reason is worse than one that refuses vaguely.
 * Inputs: verdict ({ok, code, params}) from `validateName`. t (function).
 * Output: string|null - the lowercase sentence, or null when ok.
 * Example: nameRefusal({ok: false, code: 'illegal_char', params: {char: '/'}}, t)
 *   // "a project name cannot contain '/'"
 */
export function nameRefusal(verdict, t) {
    if (!verdict || verdict.ok) return null;
    const key = REFUSAL_KEY_BY_CODE[verdict.code] || PROJECT_CREATE_KEYS.nameRequired;
    return t(key, verdict.params || {});
}

/**
 * Why a project could not be given a unique name, as a sentence.
 *
 * Description: the replacement for a thrown English string. The thrown
 *   error carries `cloudeKey`; anything else is an error from the API and
 *   keeps its own message, because that sentence came from the server and
 *   this client has never seen its text.
 * Inputs: error (Error|null). t (function).
 * Output: string.
 * Example: uniqueNameFailure({cloudeKey: 'project.create.unique_name_failed'}, t)
 */
export function uniqueNameFailure(error, t) {
    const key = error && error.cloudeKey;
    if (key) return t(key);
    const message = error && error.message;
    return message || t(PROJECT_CREATE_KEYS.uniqueNameFailed);
}

/**
 * Map a clone failure onto one of the six sentences this flow can say.
 *
 * Description: PORTED VERBATIM from `showCloneFromGithubModal`'s
 *   `mapErrorToMessage`, matching on the signature substrings the
 *   backend embeds in its detail text. The substrings it matches on are
 *   the SERVER's English and are not translated - they are a wire
 *   protocol in all but name - while every sentence it returns is a
 *   catalog message. The fallback keeps the server's own detail verbatim
 *   for the same reason `attentionReason` does: this client has never
 *   seen that text and cannot have a key for it.
 * Inputs: error (any). t (function).
 * Output: string - a lowercase sentence.
 * Example: cloneFailure(new Error('HTTP 409: already exists'), t)
 */
export function cloneFailure(error, t) {
    // NOT `(error && error.message) || error`, which is what the
    // hand-written mapper did: an Error whose message is empty is falsy,
    // so that expression fell through to the Error OBJECT and
    // `String(new Error(''))` is the word "Error" - which is what the
    // user then read on the form. An empty message is no message, and no
    // message takes the named fallback at the bottom.
    const msg = error instanceof Error ? error.message : String(error ?? '');
    const lower = msg.toLowerCase();
    if (lower.includes('not authenticated') || lower.includes('auth/network')
        || lower.includes('gh auth login')) {
        return t(PROJECT_CREATE_KEYS.cloneAuth);
    }
    if (lower.includes('repository not found') || lower.includes('repo not found')
        || lower.startsWith('not found')) {
        return t(PROJECT_CREATE_KEYS.cloneNotFound);
    }
    if (lower.includes('already exists')) {
        return t(PROJECT_CREATE_KEYS.cloneExists);
    }
    if (lower.includes('gh cli not') || lower.includes('install with `brew install gh`')) {
        return t(PROJECT_CREATE_KEYS.cloneNoGh);
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
        return t(PROJECT_CREATE_KEYS.cloneTimeout);
    }
    const cleaned = msg.replace(/^HTTP\s+\d{3}:?\s*/i, '').trim();
    return cleaned || t(PROJECT_CREATE_KEYS.cloneFailed);
}
