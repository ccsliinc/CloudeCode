/**
 * Creating a project, in the one order it is allowed to happen in.
 *
 * PORTED FROM `Launchpad._createNewSessionInner`, `createNewSession`,
 * `createNewSessionWithAgent` and `createConsoleSession`, deleted in the
 * same commit. This is the most dangerous code on the home screen,
 * because it is the only code that writes a row and a directory that
 * outlive every process involved: `sessions.working_dir` is permanent,
 * the launcher lists it, and the archive derives a transcript directory
 * from it.
 *
 * THE ORDER IS THE FEATURE. provider, then name, then FOLDER, then
 * create. Each step can cancel, and a cancel at any step creates
 * NOTHING - no session, no folder, no project row. That is why this is a
 * function over an injected host and an injected set of modals rather
 * than a method that reaches for `window`: the order is what a test can
 * hold, and a browser is the worst place to hold it.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP, all four of them things that have
 * already gone wrong here once:
 *
 *  1. THE FOLDER STEP CANNOT BE SKIPPED. Until it shipped, "start empty"
 *     never asked where the project should live, so
 *     `SessionManager.create_session` fell through to
 *     `work_path = settings.get_working_dir() / session_id` and a project
 *     the user named `Punchlist Test` was created at `.../ses_5a756046`.
 *     That fallback still exists for an old client and logs at warning
 *     level; it must stay, and this flow must never reach it.
 *  2. THE FIELD IS `project_parent_dir`, NEVER `working_dir`. Three
 *     shipped flows post `working_dir` with a folder from anywhere on
 *     disk - open-an-existing-folder, the new-console FAB (it posts `~`)
 *     and clone - so the root restriction lives on a field nothing used
 *     to send. It is the PARENT that is posted, not the composed path,
 *     because the server joins the name itself after `os.path.realpath`
 *     and a client-composed path would record the short spelling of a
 *     symlinked parent.
 *  3. A NAME IS REFUSED, NEVER REWRITTEN. An illegal name comes back as
 *     a sentence and the modal is re-opened WITH WHAT WAS TYPED still in
 *     the field. A sanitiser that turned `a/b` into `a-b` would make a
 *     folder the user did not ask for and cannot find.
 *  4. A SHELL CONSOLE SENDS NO `label`. `--name` is a claude-family flag;
 *     the two claude-launching paths send the project name as the label
 *     so the row title and the name claude calls itself are one string
 *     from the first frame.
 *
 * THE OUTCOME IS NAMED, NOT A BOOLEAN. `cancelled_folder` and `failed`
 * are different things and a caller that could not tell them apart would
 * report a user's own escape key as an error.
 */
import {
    PROJECT_CREATE_KEYS,
    nameRefusal,
} from '../../../../client/js/labels/project-create.js';
import type { Translate } from '../sessions/types';
import type { CreateHost, CreatePayload, CreatedSession, ProviderChoice } from './create-host';
import type { ModalOpeners } from './modals';
import { validateName } from './project-folder';
import { beginNav } from './nav-generation';

/** Every way a create attempt can end, named. */
export type CreateOutcome =
    | 'created'
    | 'cancelled_provider'
    | 'cancelled_name'
    | 'cancelled_folder'
    | 'detached_and_retried'
    | 'failed';

/** What a create attempt reports back. */
export interface CreateResult {
    outcome: CreateOutcome;
    /** The created session, when one was created. */
    session: CreatedSession | null;
    /** The payload actually posted, for tests and for the browser proof. */
    payload: CreatePayload | null;
}

/** The message an API error carried, or the named unreachable fallback. */
function reasonOf(error: unknown, t: Translate): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message || t('error.server_unreachable');
}

/** Whether a create failed because a session is already running. */
function isAlreadyRunning(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('already running');
}

/**
 * Ask for a project name until it is one, or until the user gives up.
 *
 * Description: THE LOOP IS THE RULE. `validateName` refuses and names
 *   which rule refused; the sentence is shown on the launchpad's own
 *   error line, exactly where the hand-written version showed it; and
 *   the modal re-opens carrying the refused text so the user edits what
 *   they typed rather than retyping it. Nothing is ever rewritten.
 * Inputs: modals, host, t; title and confirmLabel already translated.
 * Output: Promise<{name, description} | null> - null when cancelled.
 * Example: const details = await askForName(modals, host, t, title, label);
 */
export async function askForName(
    modals: ModalOpeners,
    host: CreateHost,
    t: Translate,
    title: string,
    confirmLabel: string,
): Promise<{ name: string; description: string } | null> {
    let prefill = '';
    for (;;) {
        const details = await modals.name({ title, confirmLabel, defaultName: prefill });
        if (!details) return null;
        const verdict = validateName(details.name);
        if (verdict.ok) return details;
        const sentence = nameRefusal(verdict, t);
        if (sentence) host.showError(sentence);
        prefill = details.name;
    }
}

/**
 * Which `agent_type` a create posts, and which one wins.
 *
 * Description: an explicit agentType from the caller (the openclaw,
 *   hermes and codex quick-connect buttons) beats everything, matching
 *   the pre-wrappers precedence. Then a wrapper id from the picker, then
 *   a pinned family row. The two picker values are mutually exclusive by
 *   construction - it returns one or the other, never both - so the
 *   ranking between them only ever settles a malformed choice.
 * Inputs: agentType (string|null); choice (ProviderChoice).
 * Output: string | null - the value to post, or null to omit the key so
 *   the server's own fallback chain still runs.
 * Example: agentTypeFor(null, {wrapperId: 'claude-chrome'})  // 'claude-chrome'
 */
export function agentTypeFor(
    agentType: string | null,
    choice: ProviderChoice | null,
): string | null {
    if (agentType) return agentType;
    if (choice?.wrapperId) return String(choice.wrapperId);
    if (choice?.agentType) return String(choice.agentType);
    return null;
}

/**
 * Build the `POST /sessions` body for a new claude project.
 *
 * Description: EXTRACTED SO THE PAYLOAD CAN BE ASSERTED WITHOUT RUNNING
 *   THE FLOW. `project_parent_dir` is the chosen PARENT and `working_dir`
 *   is absent, which is the whole of rule 2; `label` carries the project
 *   name, which is what turns into `--name` on the launch command.
 * Inputs: name, description; parent (the chosen parent directory);
 *   agentType; choice; dims (the xterm cell grid).
 * Output: CreatePayload.
 * Example: buildCreatePayload('My App', '', '/Users/me/code', null, null, {})
 */
export function buildCreatePayload(
    name: string,
    parent: string,
    agentType: string | null,
    choice: ProviderChoice | null,
    dims: Record<string, unknown>,
): CreatePayload {
    const payload: CreatePayload = {
        auto_start_claude: true,
        copy_templates: true,
        project_name: name,
        // THE CHOSEN PARENT, NOT THE COMPOSED PATH. The server joins the
        // name to it and canonicalises with `os.path.realpath`, so the
        // directory it creates and the row's `working_dir` carry the long
        // spelling of a symlinked parent rather than whatever the client
        // happened to display. See src/core/project_directory.py.
        project_parent_dir: parent,
        // ONE NAME, SET AT BIRTH. The server turns a non-empty label into
        // `--name <label>`, so the row title and the name claude calls
        // itself are the same string from the first frame.
        label: name,
        ...dims,
    };
    const resolved = agentTypeFor(agentType, choice);
    if (resolved) payload.agent_type = resolved;
    if (choice?.model) payload.model = choice.model;
    return payload;
}

/**
 * Create a new claude project, in the one order it may happen in.
 *
 * Description: provider, name, FOLDER, create. Each step can cancel and a
 *   cancel creates nothing. After the session lands, the project row is
 *   written (an "already exists" collision is not a failure) and the
 *   project list is refreshed under its own guard, because a failed
 *   repaint must not read as a failed create.
 * Inputs: host; modals; t; agentType (string|null) - a forced family, or
 *   null to let the provider picker and then the server decide.
 * Output: Promise<CreateResult>.
 * Example: await createProjectFlow(host, modals, t, null);
 */
export async function createProjectFlow(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
    agentType: string | null = null,
): Promise<CreateResult> {
    const refused: CreateResult = { outcome: 'failed', session: null, payload: null };
    // THE INTENT, DECLARED BEFORE THE FIRST AWAIT, which on this flow is
    // the provider picker - a modal the user can sit in indefinitely, and
    // therefore the widest window on this screen for a second navigation
    // to land in. See `nav-generation.ts`.
    const nav = beginNav('create');
    try {
        // Gate: claude or an OpenRouter model, BEFORE anything is asked
        // for and long before anything is written. Null cancels the whole
        // launch.
        const choice = await host.chooseProvider();
        if (!choice) return { ...refused, outcome: 'cancelled_provider' };

        const title = agentType
            ? t(PROJECT_CREATE_KEYS.nameTitleForAgent, { agent: agentType })
            : t(PROJECT_CREATE_KEYS.nameTitle);
        const details = await askForName(
            modals,
            host,
            t,
            title,
            t(PROJECT_CREATE_KEYS.confirmCreate),
        );
        if (!details) return { ...refused, outcome: 'cancelled_name' };

        // RULE 1. Cancelling here cancels the launch: no session, no
        // folder, no project row. There is no branch past this point that
        // creates anything without a parent directory in hand.
        const folder = await modals.folder({
            name: details.name,
            defaultParent: () => host.defaultParentDir(),
            openPicker: host.folderPicker(),
        });
        if (!folder) return { ...refused, outcome: 'cancelled_folder' };

        host.updateStatus(
            agentType
                ? t(PROJECT_CREATE_KEYS.createStatusForAgent, { agent: agentType })
                : t(PROJECT_CREATE_KEYS.createStatus),
        );

        const payload = buildCreatePayload(
            details.name,
            folder.parent,
            agentType,
            choice,
            host.terminalDims(),
        );
        const session = await host.createSession(payload);

        await persistProjectRow(host, {
            name: details.name,
            path: String(session.working_dir ?? ''),
            description: details.description || null,
        });
        // ENTER THE SESSION FIRST, DECORATE AFTER. The session is what the
        // user asked for; the project-tree repaint is bookkeeping they did
        // not ask for, and nothing in its result is needed to render the
        // terminal. Announced before the repaint, the user lands in their
        // new session immediately instead of watching a list redraw first.
        //
        // STILL AWAITED, and still guarded on its own, so a caller that
        // runs after this function does not race the refresh and a failed
        // repaint does not read as a failed create.
        host.announceSessionCreated(session, nav);
        await refreshProjects(host);
        return { outcome: 'created', session, payload };
    } catch (error) {
        console.error('CloudeWeb: failed to create session:', error);
        if (isAlreadyRunning(error)) {
            // The user's stated intent was "create a new project", so
            // carry it out: the prior tmux session is detached, never
            // killed, and stays in the running list for rejoin.
            host.detachAndCreateNew(agentType);
            return { ...refused, outcome: 'detached_and_retried' };
        }
        host.showError(t(PROJECT_CREATE_KEYS.createFailed, { reason: reasonOf(error, t) }));
        return refused;
    }
}

/**
 * Create a bare shell console: no claude, no name step, no folder step.
 *
 * Description: a console is not a project in the conventional sense, so
 *   it auto-generates its name and posts `working_dir: '~'`, which the
 *   server expands. That is NOT a violation of rule 2: `working_dir` is
 *   the unrestricted field precisely because flows like this one have
 *   always posted a folder of their own choosing. It sends no `label`,
 *   because `--name` is a claude-family flag.
 * Inputs: host; t; terminalCommandId (string|null) - a configured
 *   command the server types into the pane once the shell is up. Only the
 *   id travels; the text is read from config.json server-side.
 * Output: Promise<CreateResult>.
 * Example: await createConsoleFlow(host, t, null);
 */
export async function createConsoleFlow(
    host: CreateHost,
    t: Translate,
    terminalCommandId: string | null = null,
): Promise<CreateResult> {
    const sessionName = `console-${Date.now().toString(36)}`;
    // THE INTENT, DECLARED BEFORE THE POST. See `nav-generation.ts`: a
    // dispatcher with no token is waived by app.js's listener rather than
    // refused, so the guard's absence is invisible from the outside.
    const nav = beginNav('console');
    try {
        host.updateStatus(t(PROJECT_CREATE_KEYS.createConsoleStatus));
        const payload: CreatePayload = {
            auto_start_claude: true,
            copy_templates: false,
            project_name: sessionName,
            working_dir: '~',
            agent_type: 'shell',
            ...(terminalCommandId ? { terminal_command_id: terminalCommandId } : {}),
            ...host.terminalDims(),
        };
        const session = await host.createSession(payload);
        // NO DESCRIPTION, AND SLICE 7 REMOVED THE ONE THAT WAS HERE.
        // It was `t('project.create.console.description')`, a catalog
        // sentence that got STORED in config.json - so a locale change
        // could never retranslate it, which is the server-strings gap
        // .claude/notes/i18n-design.md section 7 names, reached from the
        // client. A description is USER data; inventing one in whatever
        // language happened to be on screen and then freezing it was the
        // defect, and the console row is identified by its NAME anyway.
        // An adopted session's project row has carried '' since it
        // shipped, so this is the existing convention, not a new one.
        await persistProjectRow(host, {
            name: sessionName,
            path: String(session.working_dir ?? ''),
        });
        await refreshProjects(host);
        host.announceSessionCreated(session, nav);
        return { outcome: 'created', session, payload };
    } catch (error) {
        console.error('CloudeWeb: failed to create console session:', error);
        if (isAlreadyRunning(error)) {
            host.detachAndCreateNew('shell');
            return { outcome: 'detached_and_retried', session: null, payload: null };
        }
        host.showError(t(PROJECT_CREATE_KEYS.createFailed, { reason: reasonOf(error, t) }));
        return { outcome: 'failed', session: null, payload: null };
    }
}

/**
 * Write the project row, treating an existing one as success.
 *
 * Description: the session is already created by the time this runs, so
 *   a collision on the project NAME is not a reason to report a failed
 *   create - the row it collided with describes the same folder. Any
 *   other error is logged and swallowed for the same reason and no
 *   other: the durable thing already exists.
 * Inputs: host; row ({name, path, description}).
 * Output: Promise<void>.
 * Example: await persistProjectRow(host, {name: 'a', path: '/a'});
 */
async function persistProjectRow(
    host: CreateHost,
    row: { name: string; path: string; description?: string | null },
): Promise<void> {
    try {
        await host.createProject(row);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (!message.includes('already exists')) {
            console.error('CloudeWeb: failed to save project:', error);
        }
    }
}

/**
 * Repaint the project tree from the list that just changed.
 *
 * Description: guarded on its own because the session was created and a
 *   failed repaint must not read as a failed create. Without it the new
 *   project stays invisible until something else reloads, since the 5s
 *   poller repaints from the cached list without refilling it.
 * Inputs: host. Output: Promise<void>.
 * Example: await refreshProjects(host);
 */
async function refreshProjects(host: CreateHost): Promise<void> {
    try {
        await host.reloadProjects();
    } catch (error) {
        console.error('CloudeWeb: failed to refresh projects after session create:', error);
    }
}
