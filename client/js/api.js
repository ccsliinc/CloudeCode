/**
 * API Module - Handles all API calls with JWT token injection
 */

console.log('[API Module] Loading...');

class API {
    constructor() {
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;

        this.baseURL = `${protocol}//${host}/api/v1`;
        this.wsBaseURL = `${wsProtocol}//${host}`;

        // Item 5: single-flight mutex for refresh-token rotation.
        //
        // When N requests race and all see 401 at roughly the same time,
        // they must NOT each fire their own /auth/refresh. The server
        // enforces reuse detection on the refresh token - so if two
        // refresh calls land on the same refresh_token, the second is
        // treated as a theft event and BOTH get revoked (chain burn).
        //
        // The fix is a classic Promise-based mutex: the first 401-victim
        // creates a refresh Promise and stores it here; subsequent
        // 401-victims await the SAME promise instead of starting their
        // own. When it settles, everyone sees the same outcome and
        // either all retry with the fresh access token or all fall
        // through to the re-auth path.
        //
        // A boolean flag would race (flag-then-set is two operations);
        // the Promise IS the primitive - storing it atomically captures
        // both the "in flight" and "eventual result" states.
        this._refreshPromise = null;
    }

    /**
     * Get auth token from localStorage
     */
    getToken() {
        return localStorage.getItem('claude_tunnel_token');
    }

    /**
     * Make authenticated API call.
     *
     * On a 401 from a protected endpoint we transparently run the
     * refresh-token rotation dance and replay the original request with
     * the new access token. If refresh fails (no refresh token stored,
     * server says 401, network error, ...) we fall through to the
     * handleUnauthorized() path so the UI can reauth via TOTP.
     *
     * @param {string} endpoint - API endpoint (e.g., '/sessions')
     * @param {object} options - fetch options
     * @param {object} [_meta] - internal; callers pass {_retrying: true}
     *                           to break the refresh-then-retry loop.
     * @returns {Promise<any>} - Response data
     */
    async call(endpoint, options = {}, _meta = {}) {
        const token = this.getToken();

        // Prepare headers
        const headers = { ...(options.headers || {}) };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        if (!headers['Content-Type'] && options.body && typeof options.body === 'object') {
            headers['Content-Type'] = 'application/json';
        }

        // Make request
        const url = `${this.baseURL}${endpoint}`;
        const fetchOptions = {
            ...options,
            headers
        };

        // Convert body to JSON if it's an object
        if (fetchOptions.body && typeof fetchOptions.body === 'object') {
            fetchOptions.body = JSON.stringify(fetchOptions.body);
        }

        try {
            const response = await fetch(url, fetchOptions);

            // Handle 401 Unauthorized.
            //
            // First 401: try to rotate the refresh token (single-flight -
            // see constructor comment). If refresh wins, replay the
            // original request once with the new access token.
            //
            // Refresh returns:
            //   true            -> rotated; retry original request once.
            //   'network-error' -> refresh request itself failed at the
            //                      network layer (post-wake Wi-Fi blip,
            //                      offline, etc.). Refresh token MIGHT
            //                      still be valid - preserve it, drop
            //                      only the access token, surface a
            //                      recoverable NetworkUnavailable error
            //                      to the caller. The NEXT user action
            //                      will retry refresh.
            //   false           -> server explicitly rejected the refresh
            //                      (or no refresh stored / bad response).
            //                      Clear both tokens and re-prompt TOTP.
            //
            // Second 401 (after a successful refresh) skips the refresh
            // attempt entirely and falls through to the hard re-auth path.
            if (response.status === 401) {
                if (!_meta._retrying && window.Auth && window.Auth.getRefreshToken()) {
                    const refreshed = await this._singleFlightRefresh();
                    if (refreshed === true) {
                        console.log('API: 401 recovered via refresh, retrying original request');
                        return this.call(endpoint, options, { _retrying: true });
                    }
                    if (refreshed === 'network-error') {
                        console.warn('API: 401 + refresh hit network error - preserving refresh token');
                        if (window.Auth) {
                            window.Auth.clearToken({ accessOnly: true });
                        }
                        const err = new Error('Network unavailable; please retry');
                        err.code = 'NetworkUnavailable';
                        err.status = 0;
                        throw err;
                    }
                }
                console.log('API: 401 Unauthorized - triggering re-auth');
                this.handleUnauthorized();
                throw new Error('Authentication required. Please log in again.');
            }

            // Handle other errors. Surface the HTTP status on the thrown
            // Error so callers can branch on it (e.g. the folder picker
            // treats a 404 from /filesystem/browse as "create this path").
            // Mirrors the err.status pattern already used by verifyTOTP().
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const err = new Error(errorData.detail || errorData.message || `HTTP ${response.status}`);
                err.status = response.status;
                throw err;
            }

            // Return JSON response
            return await response.json();
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    }

    /**
     * Single-flight refresh wrapper. See constructor comment on
     * _refreshPromise for the "why".
     *
     * @returns {Promise<boolean>}
     */
    async _singleFlightRefresh() {
        if (this._refreshPromise) {
            // Another in-flight request already kicked off refresh.
            // Await the SAME promise so we don't burn the chain.
            return this._refreshPromise;
        }
        // Store the promise atomically BEFORE awaiting, so any sibling
        // 401 handler that checks `this._refreshPromise` on its next
        // event-loop tick sees the same value and joins in.
        this._refreshPromise = (async () => {
            try {
                return await window.Auth.refresh();
            } finally {
                // Clear the slot regardless of outcome so a subsequent
                // 401 (say, the just-rotated access token itself expired
                // a moment later) can trigger a fresh refresh.
                this._refreshPromise = null;
            }
        })();
        return this._refreshPromise;
    }

    /**
     * Handle unauthorized response. Clears BOTH access + refresh tokens
     * since we're bailing out to the TOTP prompt.
     */
    handleUnauthorized() {
        if (window.Auth) {
            window.Auth.clearToken();
        } else {
            // Fallback if Auth hasn't initialized yet.
            localStorage.removeItem('claude_tunnel_token');
            localStorage.removeItem('claude_refresh_token');
        }

        // Trigger auth required event
        window.dispatchEvent(new CustomEvent('auth-required'));
    }

    /**
     * Auth: Verify TOTP code
     * @param {string} totpCode - 6-digit TOTP code
     * @returns {Promise<{token: string}>}
     */
    async verifyTOTP(totpCode) {
        const response = await fetch(`${this.baseURL}/auth/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: totpCode })
        });

        if (!response.ok) {
            // Normalize error shape across sources:
            //   - FastAPI HTTPException → { detail: "..." }
            //   - slowapi rate-limit (429) → { error: "Rate limit exceeded: ..." }
            //   - malformed / empty       → {}
            // Prefer `error` (slowapi), fall back to `detail` (FastAPI),
            // then a generic message. NEVER fall through to a hardcoded
            // client-side message - that would silently overwrite the
            // server's actual signal (e.g. hide a 429 behind "Invalid TOTP
            // code").
            const errorData = await response.json().catch(() => ({}));
            let message = errorData.error || errorData.detail || errorData.message || 'Unknown error';

            // RFC 7231: Retry-After is either integer seconds or an HTTP-date.
            // For rate-limit 429s slowapi emits integer seconds. Parse
            // defensively - if unparseable, skip the suffix rather than
            // showing "NaN".
            if (response.status === 429) {
                const retryAfterRaw = response.headers.get('Retry-After');
                const retrySec = parseInt(retryAfterRaw, 10);
                // slowapi's server body already includes "Try again in Ns."
                // so only append our own suffix if the server didn't.
                // Otherwise we end up with "... Try again in 58s. Try again in 58s."
                if (Number.isFinite(retrySec) && retrySec > 0 && !/try again/i.test(message)) {
                    message = `${message.replace(/\.$/, '')}. Try again in ${retrySec}s.`;
                }
            }

            const err = new Error(message);
            err.status = response.status;
            throw err;
        }

        return await response.json();
    }

    /**
     * Auth: Check authentication status
     * @returns {Promise<{authenticated: boolean}>}
     */
    async checkAuthStatus() {
        return await this.call('/auth/status');
    }

    /**
     * Auth: Get QR code for setup (no auth required)
     * @returns {Promise<{qr_code: string, secret: string}>}
     */
    async getQRCode() {
        const response = await fetch(`${this.baseURL}/auth/qr`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            // Attach HTTP status so callers can discriminate semantic
            // outcomes - e.g. 403 here means "qr endpoint locked because
            // pairing is already complete", which is success state for the
            // login screen, NOT a setup-required failure. Mirrors the
            // err.status pattern used in verifyTOTP() above.
            const err = new Error(errorData.detail || 'Failed to get QR code');
            err.status = response.status;
            throw err;
        }
        return await response.json();
    }

    /**
     * Config: Get common slash commands
     * @returns {Promise<object>} - {commands: Array<string>}
     */
    async getCommonCommands() {
        return await this.call('/config/common-commands');
    }

    /**
     * Config: star or unstar one slash command, replacing the old
     * hand-picked `common_slash_commands` notion with a user-chosen one.
     *
     * The desired state is EXPLICIT rather than a flip: two renders can
     * disagree about what is currently starred, and a flip would then
     * produce whichever request arrived last. Explicit is idempotent.
     *
     * @param {string} command - e.g. "/clear"; a leading slash is added
     *   server-side when missing.
     * @param {boolean} favorite - true to star, false to unstar.
     * @returns {Promise<{commands: string[], command_details: Array<object>, defaulted: boolean}>}
     *   the post-write chip row, same shape as getCommonCommands().
     */
    async toggleFavoriteCommand(command, favorite) {
        return await this.call('/config/common-commands/favorite', {
            method: 'POST',
            body: { command: command, favorite: !!favorite }
        });
    }

    /**
     * Config: Get the full slash-command palette - built-in/skill/workflow
     * commands (scraped at release time) merged with commands and skills
     * discovered on the server at request time (user scope, installed
     * plugins, and project scope when `projectPath` is given). See
     * GET /config/slash-commands (src/api/auth.py) for the full contract.
     *
     * @param {string|null} [projectPath] - absolute path to the active
     *   project's working directory, for project-scope discovery. Omit to
     *   skip project-scope entirely.
     * @returns {Promise<{groups: Array<{id: string, label: string,
     *   commands: Array<{command: string, args: string, description: string,
     *   type: string, alias_of: string|null}>}>}>}
     */
    async getSlashCommands(projectPath = null) {
        const q = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : '';
        return await this.call(`/config/slash-commands${q}`);
    }

    /**
     * Projects: Get project list
     * @returns {Promise<Array>}
     */
    async getProjects() {
        return await this.call('/projects');
    }

    /**
     * Projects: live-probe every DB-tracked project's filesystem presence.
     *
     * feat/projects-table (S3). See GET /projects/presence
     * (src/api/routes.py) - re-stats every project's root on every call,
     * never a cached/stale value.
     *
     * @returns {Promise<{status: "ok"|"unreachable", projects: Array<{
     *   raw_path: string, presence: "present"|"missing"|"unreachable"|
     *   "unchecked", presence_detail: string|null}>, detail: string|null}>}
     */
    async getProjectsPresence() {
        return await this.call('/projects/presence');
    }

    /**
     * Projects: Create new project
     * @param {object} params - {name: string, path: string, description?: string}
     * @returns {Promise<object>} - Project data
     */
    async createProject(params) {
        return await this.call('/projects', {
            method: 'POST',
            body: params
        });
    }

    /**
     * Projects: Delete project
     * @param {string} projectName - Name of the project to delete
     * @returns {Promise<object>}
     */
    async deleteProject(projectName) {
        return await this.call(`/projects/${encodeURIComponent(projectName)}`, {
            method: 'DELETE'
        });
    }

    /**
     * Projects: Rename / update description (display name only - never
     * touches the folder on disk). Pass only the fields you want to change.
     *
     * @param {string} currentName - Current display name (URL identifier).
     * @param {object} fields - {newName?: string, description?: string}.
     *   ``description: ""`` is honored as an intentional clear.
     * @returns {Promise<object>} - Updated project (canonical form).
     */
    async updateProject(currentName, { newName, description } = {}) {
        const body = {};
        if (newName !== undefined) body.new_name = newName;
        if (description !== undefined) body.description = description;
        return await this.call(`/projects/${encodeURIComponent(currentName)}`, {
            method: 'PATCH',
            body
        });
    }

    /**
     * Projects: Clone a GitHub repo (server runs `gh repo clone`) and
     * register the result as a project.
     *
     * @param {object} params
     * @param {string} params.repoUrl - GitHub URL or owner/repo shorthand.
     * @param {string} [params.parentDir] - Directory in which the cloned
     *   folder is created (server default: ~/projects).
     * @param {string} [params.projectName] - Override auto-detected name.
     * @param {string} [params.description] - Optional project description.
     * @returns {Promise<{name: string, path: string, description: ?string}>}
     */
    async cloneProjectFromGithub({ repoUrl, parentDir, projectName, description } = {}) {
        const body = { repo_url: repoUrl };
        if (parentDir !== undefined && parentDir !== '') body.parent_dir = parentDir;
        if (projectName !== undefined && projectName !== '') body.project_name = projectName;
        if (description !== undefined) body.description = description;
        return await this.call('/projects/clone', {
            method: 'POST',
            body
        });
    }

    /**
     * Filesystem: Browse a directory on the server
     * @param {string|null} path - Directory path to list, or null to start at the default location
     * @returns {Promise<{path: string, parent: string|null, entries: Array<{name: string, path: string}>}>}
     */
    async browseDirectory(path = null) {
        const query = path ? `?path=${encodeURIComponent(path)}` : '';
        return await this.call(`/filesystem/browse${query}`);
    }

    /**
     * Filesystem: Create a directory on the server (mkdir -p) and return the
     * SAME shape as browseDirectory for the newly-created directory, so the
     * caller can navigate straight into it in a single round-trip.
     * @param {string} path - Absolute or ~-relative directory path to create.
     * @returns {Promise<{path: string, parent: string|null, entries: Array<{name: string, path: string}>}>}
     */
    async makeDirectory(path) {
        return await this.call('/filesystem/mkdir', {
            method: 'POST',
            body: { path }
        });
    }

    /**
     * Providers: list configured OpenRouter models (Claude is implicit and
     * never included here - the provider selector modal pins it as the
     * first, non-removable option client-side).
     * @returns {Promise<{models: Array<string>}>}
     */
    async getProviders() {
        return await this.call('/providers');
    }

    /**
     * Providers: add a model id to the OpenRouter model list.
     * @param {string} model - e.g. "openai/gpt-5.6-sol". Server validates
     *   against ^[A-Za-z0-9._~/-]{1,120}$ - throws (err.status 400) on a
     *   malformed id, (err.status 409) on a duplicate.
     * @returns {Promise<{models: Array<string>}>}
     */
    async addProviderModel(model) {
        return await this.call('/providers/models', {
            method: 'POST',
            body: { model }
        });
    }

    /**
     * Providers: remove a model id from the OpenRouter model list.
     * Model ids contain "/" so the path segment is URL-encoded.
     * @param {string} model
     * @returns {Promise<{models: Array<string>}>} - throws (err.status 404) if absent
     */
    async removeProviderModel(model) {
        return await this.call(`/providers/models/${encodeURIComponent(model)}`, {
            method: 'DELETE'
        });
    }

    /**
     * Settings screen: fetch the effective agents/notifications/server
     * config. Notification secrets come back masked as
     * {configured: boolean} - never in plain text.
     * @returns {Promise<{agents: object, notifications: object, server: object}>}
     */
    async getSettings() {
        return await this.call('/config/settings');
    }

    /**
     * Settings screen: apply a partial update. Only include a top-level
     * section (agents / notifications) if it has fields to change; only
     * include a field within it if the user actually edited it - an
     * omitted field means "leave unchanged" server-side. Never send a
     * masked "configured" placeholder back as a value.
     * @param {{agents?: object, notifications?: object}} patch
     * @returns {Promise<object>} - the post-write settings summary (same shape as getSettings())
     */
    async updateSettings(patch) {
        return await this.call('/config/settings', {
            method: 'PATCH',
            body: patch
        });
    }

    /**
     * Launch wrappers (feat/launch-wrappers): list every configured
     * wrapper, script included.
     * @returns {Promise<{wrappers: Array<object>}>}
     */
    async listWrappers() {
        return await this.call('/agents/wrappers');
    }

    /**
     * Launch wrappers: offered example wrappers (the author's real
     * cld/cldor functions) - never auto-installed, only shown for a user
     * to explicitly import.
     * @returns {Promise<{wrappers: Array<object>}>}
     */
    async listWrapperExamples() {
        return await this.call('/agents/wrappers/examples');
    }

    /**
     * Launch wrappers: create a new wrapper.
     * @param {{id: string, label: string, script: string, entry?: string, description?: string, default?: boolean}} wrapper
     * @returns {Promise<{wrappers: Array<object>}>} - throws (err.status 409) on duplicate/reserved id
     */
    async addWrapper(wrapper) {
        return await this.call('/agents/wrappers', { method: 'POST', body: wrapper });
    }

    /**
     * Launch wrappers: replace an existing wrapper's fields. wrapper.id
     * must equal id (renaming is delete + add).
     * @param {string} id
     * @param {object} wrapper
     * @returns {Promise<{wrappers: Array<object>}>}
     */
    async updateWrapper(id, wrapper) {
        return await this.call(`/agents/wrappers/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: wrapper
        });
    }

    /**
     * Launch wrappers: delete a wrapper.
     * @param {string} id
     * @returns {Promise<{wrappers: Array<object>}>}
     */
    async deleteWrapper(id) {
        return await this.call(`/agents/wrappers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    /**
     * Launch wrappers: mark a wrapper as the default.
     * @param {string} id
     * @returns {Promise<{wrappers: Array<object>}>}
     */
    async setDefaultWrapper(id) {
        return await this.call(`/agents/wrappers/${encodeURIComponent(id)}/default`, { method: 'POST' });
    }

    /**
     * Terminal commands: list the configured entries, in display order.
     * @returns {Promise<{commands: Array<{id: string, label: string, command: string}>}>}
     */
    async getTerminalCommands() {
        return await this.call('/terminal/commands');
    }

    /**
     * Terminal commands: replace the whole list. Add, edit, delete and
     * reorder are all this one call - the list IS the order, so there is
     * no separate reorder endpoint to disagree with it.
     * @param {Array<{id: string, label: string, command: string}>} commands
     * @returns {Promise<{commands: Array<object>}>} - throws (err.status 400)
     *   on a malformed entry, a bad id, or a duplicate id
     */
    async replaceTerminalCommands(commands) {
        return await this.call('/terminal/commands', {
            method: 'PUT',
            body: { commands }
        });
    }

    /**
     * Sessions: Create new session
     * @param {object} params - {working_dir?: string, auto_start_claude?: boolean, copy_templates?: boolean, cols?: number, rows?: number, project_name?: string|null}
     * @returns {Promise<object>} - Session data
     */
    async createSession(params = {}) {
        return await this.call('/sessions', {
            method: 'POST',
            body: params
        });
    }

    /**
     * Sessions: Get session info.
     * @param {string|null} sessionId - specific session id, or null for the
     *   current (most-recently-created) one (back-compat).
     * @param {object} [opts]
     * @param {boolean} [opts.includeScrollback=false] - when true, asks the
     *   server to populate ``initial_scrollback_b64`` on the response. Used
     *   by the launchpad rejoin path so the client can paint pre-existing
     *   history into xterm BEFORE the WS opens (mirrors the adopt path).
     *   Default false keeps every existing caller wire-identical.
     * @param {number|null} [opts.cols=null] - client's current xterm cols;
     *   forwarded ONLY when includeScrollback is true so the server can
     *   pre-resize the pane to this width before capture-pane snapshots
     *   it. Without this, a width-mismatched rejoin (e.g. mobile rejoining
     *   a desktop-width session) gets scrollback bytes emitted at the
     *   pane's last-attached width and xterm renders them at the mobile
     *   width - older history reflows into garbled rows.
     * @param {number|null} [opts.rows=null] - client's current xterm rows;
     *   paired with ``cols`` for the pre-capture resize. Both must be
     *   positive ints for the server to act.
     * @returns {Promise<object>} - SessionInfo
     */
    async getSession(sessionId = null, { includeScrollback = false, cols = null, rows = null } = {}) {
        const params = [];
        if (sessionId) {
            params.push(`session_id=${encodeURIComponent(sessionId)}`);
        }
        if (includeScrollback) {
            params.push('include_scrollback=1');
        }
        if (cols && cols > 0) {
            params.push(`cols=${encodeURIComponent(String(cols))}`);
        }
        if (rows && rows > 0) {
            params.push(`rows=${encodeURIComponent(String(rows))}`);
        }
        const q = params.length ? `?${params.join('&')}` : '';
        return await this.call(`/sessions${q}`);
    }

    /**
     * Sessions: List ALL live sessions (multi-session).
     * @returns {Promise<Array<object>>} - array of SessionInfo
     */
    async listSessions() {
        return await this.call('/sessions/list');
    }

    /**
     * Sessions: Fetch current session or null when none is active.
     *
     * Thin wrapper over ``getSession`` that translates the 404-on-no-session
     * into a ``null`` return so callers (e.g. the launchpad active-session
     * banner) can render without try/catch boilerplate. Any non-404 error
     * rethrows so the caller can surface or log it.
     *
     * @returns {Promise<object|null>} - SessionInfo or null on 404
     */
    async getCurrentSession() {
        try {
            return await this.getSession();
        } catch (error) {
            // Our ``call`` wrapper throws Error with a message that starts
            // with the backend's detail string. "No active session" is what
            // ``GET /sessions`` returns when none exists - treat it as null.
            const msg = (error && error.message) || '';
            if (/No active session|HTTP 404|404/i.test(msg)) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Sessions: Destroy a session (kill its backend/tmux).
     * @param {string|null} sessionId - specific session id, or null for the
     *   current one (back-compat). Other live sessions are untouched.
     * @returns {Promise<object>}
     */
    async destroySession(sessionId = null) {
        const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        return await this.call(`/sessions${q}`, {
            method: 'DELETE'
        });
    }

    /**
     * Sessions: Upload any file blob to the active session.
     *
     * Why this lives outside ``call()``: ``call()`` unconditionally
     * ``JSON.stringify``s any ``typeof body === 'object'`` payload (line
     * 79-81 above). ``FormData`` IS a typeof-object, so routing through
     * ``call()`` would mangle the multipart body to "[object FormData]".
     * Beyond that, the browser MUST set the multipart Content-Type with
     * its own boundary token - explicitly setting Content-Type would
     * destroy the boundary and the server would 422 the request.
     *
     * Auth + 401 retry mirrors ``call()`` exactly (single-flight refresh,
     * one replay, then handleUnauthorized) - no behavior drift.
     *
     * @param {Blob} blob - Bytes from the clipboard / file picker. A File
     *   carries its own name; a raw clipboard Blob does not.
     * @param {string} [filename] - the name to declare to the server, which
     *   SANITISES it and preserves the extension. Empty for a nameless
     *   clipboard blob, in which case ``paste.<ext>`` is derived from the
     *   blob's own mime type so an image paste still lands as ``.png``.
     * @param {string|null} [sessionId] - which session's working dir to
     *   write into. The pasting tab passes its own id so the file lands
     *   in the right project; omitted -> current session (back-compat).
     * @param {object} [_meta] - internal; callers pass ``{_retrying: true}``
     *   to break the refresh-then-retry loop.
     * @returns {Promise<{path: string, filename: string, size: number}>}
     */
    async uploadFile(blob, filename = '', sessionId = null, _meta = {}) {
        let declared = String(filename || '').trim();
        if (!declared) {
            const type = (blob && blob.type) || '';
            const ext = (type.split('/')[1] || 'bin').split(';')[0];
            declared = `paste.${ext}`;
        }
        const form = new FormData();
        form.append('file', blob, declared);

        const token = this.getToken();
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        const url = `${this.baseURL}/sessions/upload-file${q}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: form,
            });

            if (response.status === 401) {
                if (!_meta._retrying && window.Auth && window.Auth.getRefreshToken()) {
                    const refreshed = await this._singleFlightRefresh();
                    if (refreshed === true) {
                        console.log('API: 401 recovered via refresh, retrying uploadFile');
                        return this.uploadFile(blob, declared, sessionId, { _retrying: true });
                    }
                    if (refreshed === 'network-error') {
                        console.warn('API: 401 + refresh hit network error on uploadFile - preserving refresh token');
                        if (window.Auth) {
                            window.Auth.clearToken({ accessOnly: true });
                        }
                        const err = new Error('Network unavailable; please retry');
                        err.code = 'NetworkUnavailable';
                        err.status = 0;
                        throw err;
                    }
                }
                console.log('API: 401 Unauthorized on uploadFile - triggering re-auth');
                this.handleUnauthorized();
                throw new Error('Authentication required. Please log in again.');
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || errorData.message || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('API Error [uploadFile]:', error);
            throw error;
        }
    }

    /**
     * Sessions: Destroy an external (non-active) tmux session by name.
     *
     * Direct kill via the server's `DELETE /sessions/external/{name}`
     * endpoint. Used by the launchpad "X" button when the target row
     * is NOT the currently-active backend - bypasses the old
     * adopt-then-destroy flow which 500'd on dead panes (foreground
     * process exited, e.g. user Ctrl-D'd `claude`).
     *
     * Idempotent: if the session is already gone server-side, the
     * server returns 200 with an "already gone" message.
     *
     * @param {string} sessionName - tmux session name (as seen in launchpad)
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async destroyExternalSession(sessionName) {
        return await this.call(
            `/sessions/external/${encodeURIComponent(sessionName)}`,
            { method: 'DELETE' }
        );
    }

    /**
     * Sessions: Rename a live session's tmux backend in place.
     *
     * PATCH /api/v1/sessions/{id}/name. Server validates the name against
     * ``^[A-Za-z0-9_-]{1,64}$`` and uniqueness against every live + owned
     * tmux name. On success the server broadcasts ``session.renamed`` over
     * every WS bound to this session id - the caller does NOT need to
     * manually mutate displayed state, just await success and rely on the
     * WS handler in terminal.js to update header text + document.title.
     *
     * @param {string} sessionId - Session id (NOT tmux name).
     * @param {string} newName - Proposed new tmux name. Caller may
     *   pre-validate but server is authoritative.
     * @returns {Promise<object>} Updated SessionInfo payload.
     * @throws on 400 (invalid name), 404 (unknown id), 409 (name collision),
     *   500 (tmux command failed).
     */
    async renameSession(sessionId, newName) {
        return await this.call(
            `/sessions/${encodeURIComponent(sessionId)}/name`,
            {
                method: 'PATCH',
                body: { new_name: newName },
            }
        );
    }

    /**
     * Sessions: Manually mark (or clear) a session unread for followup.
     *
     * feat/hook-driven-status - PATCH /api/v1/sessions/{name}/unread.
     * ``tmuxName`` (NOT session_id - same convention as the deprecated
     * pinned-theme route) so this works whether the session is currently
     * attached to or only attachable. Persisted server-side, so the flag
     * follows the user across browsers/devices (never localStorage).
     *
     * @param {string} tmuxName - literal tmux session name.
     * @param {boolean} unread - true to mark, false to clear.
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async setSessionUnread(tmuxName, unread) {
        return await this.call(
            `/sessions/${encodeURIComponent(tmuxName)}/unread`,
            {
                method: 'PATCH',
                body: { unread: !!unread },
            }
        );
    }

    /**
     * Sessions: Detach from the current session WITHOUT killing tmux.
     *
     * Soft counterpart to ``destroySession`` - the server tears down its
     * Python-side handles (reader task, idle watcher, pipe-pane) but
     * leaves the tmux session alive so it can be re-adopted later from
     * the Adopt list. Used by the "switch to a different project" flow
     * so the user doesn't lose their running Claude / shell state when
     * they swap projects from the launchpad.
     *
     * @returns {Promise<object>}
     */
    async detachSession(sessionId = null) {
        const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        return await this.call(`/sessions/detach${q}`, {
            method: 'POST'
        });
    }

    /**
     * Sessions: List externally-started tmux sessions that can be adopted.
     *
     * Returns sessions on the `cloude` tmux socket that were NOT created by
     * this server (e.g. the user ran `tmux -L cloude new -s foo` themselves).
     * The server filters out the currently-active backend's name defensively
     * so we never present a self-adopt footgun; the client also filters in
     * the render pass as belt-and-suspenders.
     *
     * @returns {Promise<Array<{name: string, created_by_cloude: boolean,
     *   created_at_epoch: number, window_count: number}>>}
     */
    async listAttachableSessions() {
        return await this.call('/sessions/attachable');
    }

    /**
     * Sessions: Adopt an externally-started tmux session.
     *
     * Server-side this sets up `pipe-pane` on the target, captures the
     * visible scrollback, records the fifo byte offset for the WS tailer,
     * and returns the scrollback (base64) alongside the session metadata.
     * Client paints the scrollback into xterm BEFORE opening the WS so
     * the tailer's seek-to-offset doesn't cause a tear.
     *
     * If the user has an active session and `confirmDetach` is false,
     * the server returns 409 - caller should show a confirmation modal
     * and retry with `confirmDetach=true`. The prior session is detached
     * (tmux keeps running), never killed. Destruction is only via the
     * explicit destroy button.
     *
     * @param {string} sessionName - tmux session name (as seen in launchpad)
     * @param {boolean} confirmDetach - user consented to detaching from
     *   the current session so the adopted one can take the active slot.
     *   Required when any session is already active.
     * @returns {Promise<{session: object, initial_scrollback_b64: string,
     *   fifo_start_offset: number}>}
     *
     * DIMENSIONS: an externally-created tmux session is born 80x24 and
     * this app never attaches a tmux CLIENT, so nothing else will ever
     * reshape it - measured 2026-08-17, an adopted session sat at 80x24
     * next to an app-created 163x46 one on the same socket. The grid is
     * read here rather than asked of the caller so no adopt path can
     * forget it, and it is sent BEFORE the server captures scrollback so
     * the captured bytes are emitted at the width they will render at.
     * An unmeasurable grid sends nothing at all; the server keeps its own
     * defaults and the WS handshake still reshapes after connect.
     */
    async adoptSession(sessionName, confirmDetach = false) {
        const grid = (window.TerminalMetrics
            && typeof window.TerminalMetrics.currentGrid === 'function')
            ? window.TerminalMetrics.currentGrid()
            : {};
        return await this.call('/sessions/adopt', {
            method: 'POST',
            body: {
                session_name: sessionName,
                confirm_detach: confirmDetach,
                ...(grid.cols && grid.rows
                    ? { cols: grid.cols, rows: grid.rows }
                    : {}),
            },
        });
    }

    /**
     * Local servers: list dev servers detected on the host for a given
     * tmux session. Pure read - never triggers detection.
     *
     * @param {string} sessionName - tmux session name (the value the
     *   server tracks entries under).
     * @returns {Promise<Array<{port: number, url: string,
     *   first_seen: string, last_seen: string}>>}
     */
    async getLocalServers(sessionName) {
        return await this.call(
            `/sessions/${encodeURIComponent(sessionName)}/local-servers`
        );
    }

    /**
     * Get plain WebSocket base URL for the terminal endpoint.
     * Does NOT append a token - JWT auth is carried in the
     * Sec-WebSocket-Protocol header via openWebSocket() below.
     *
     * @param {string|null} sessionId - the session this WS is for. When
     *   given, appended as ``?session_id=<id>`` so the server scopes the
     *   stream to that session - two browser tabs can each be on a
     *   different session. Omitted → server falls back to the current one.
     * @param {string} path - WebSocket path (default '/ws/terminal')
     * @returns {string} - WebSocket URL (no token; session_id in query)
     */
    getWebSocketURL(sessionId = null, path = '/ws/terminal') {
        const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        return `${this.wsBaseURL}${path}${q}`;
    }

    /**
     * Open an authenticated WebSocket to the backend.
     *
     * Uses the Sec-WebSocket-Protocol subprotocol header to carry the JWT
     * instead of a query string. The browser's WebSocket constructor accepts
     * an array of subprotocol tokens as its second argument and serializes
     * them into a comma-separated `Sec-WebSocket-Protocol` request header.
     * The server validates the JWT, then echoes back the `cloude.jwt.v1`
     * marker via the handshake response - required by RFC 6455 or the
     * browser drops the connection.
     *
     * Why this instead of `?token=<jwt>`:
     *   - JWTs in URLs leak into proxy/access logs, browser history, and
     *     Referer headers.
     *   - Subprotocol is a request header, not logged by default.
     *
     * Pattern modeled on the Kubernetes API server's WebSocket streams,
     * which use a similar two-element subprotocol array for bearer tokens.
     *
     * @param {string|null} sessionId - the session this WS is for (query
     *   param ``session_id``). Omitted → server uses the current session.
     * @param {string} path - WebSocket path (default '/ws/terminal')
     * @returns {WebSocket} - Open (pending) WebSocket
     */
    openWebSocket(sessionId = null, path = '/ws/terminal') {
        const token = this.getToken();
        const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        const url = `${this.wsBaseURL}${path}${q}`;
        // Two-element subprotocol array: marker + token. The server parses
        // these out of the Sec-WebSocket-Protocol header and verifies the
        // JWT before accepting. Do NOT collapse into a single string -
        // the two-element form is what the server expects.
        return new WebSocket(url, ['cloude.jwt.v1', token]);
    }

    /**
     * Toasts (v0.7.0 Part 2): list unacked toasts for a session.
     * Used by the client to backfill toasts that fired while the
     * browser was disconnected. Newest-first.
     *
     * @param {string} sessionId
     * @param {object} [opts]
     * @param {boolean} [opts.unackedOnly=true] - filter to unacked only.
     * @returns {Promise<Array<object>>}
     */
    async getSessionToasts(sessionId, { unackedOnly = true } = {}) {
        const q = unackedOnly ? '?unacked=true' : '';
        return await this.call(
            `/sessions/${encodeURIComponent(sessionId)}/toasts${q}`
        );
    }

    /**
     * Toasts: mark a toast acknowledged. The server broadcasts the ack
     * to every other browser bound to the same session so they dismiss
     * in lockstep.
     *
     * @param {string} toastId
     * @param {string} sessionId
     * @returns {Promise<object>}
     */
    async ackToast(toastId, sessionId) {
        const q = `?session_id=${encodeURIComponent(sessionId)}`;
        return await this.call(`/toasts/${encodeURIComponent(toastId)}/ack${q}`, {
            method: 'POST',
        });
    }

    /**
     * Toasts: synthetic creation - record a toast on the server and
     * fan it out to every browser bound to the session. INTENTIONALLY
     * temporary for v0.7.0 Part 2; Part 3 will add a hook-driven
     * endpoint. Kept as an explicit method so devs can curl-trigger
     * a test toast from the browser console.
     *
     * @param {string} sessionId
     * @param {object} body - { kind, title, body? }
     * @returns {Promise<object>}
     */
    async postSessionToast(sessionId, { kind, title, body } = {}) {
        return await this.call(
            `/sessions/${encodeURIComponent(sessionId)}/toasts`,
            {
                method: 'POST',
                body: { kind, title, body: body || null },
            }
        );
    }

    /**
     * Server: Reset server
     * @returns {Promise<object>}
     */
    async resetServer() {
        return await this.call('/server/reset', {
            method: 'POST'
        });
    }

    /**
     * Server: read-only snapshot of the host, this process and tmux.
     *
     * Backs the home bar's "server status" panel. Behind the same
     * `require_auth` as every other /api/v1 route - it hands out memory
     * figures, disk paths, project working directories and session
     * names, and this app is reachable from every device on the LAN.
     *
     * Every section of the reply carries `available` and `error`, so a
     * probe that could not run is distinguishable from a healthy zero.
     * See src/api/status_routes.py.
     *
     * @returns {Promise<object>} `{collected_at, server, tmux,
     *   claude_cli, host, memory, disk, load}`.
     */
    async getServerStatus() {
        return await this.call('/server/status');
    }

    /**
     * Server: which release this install is, and whether it is current.
     *
     * Backed by `GET /api/v1/version` (src/api/version_routes.py), which is
     * the single documented feed for both the header version chip and the
     * server-status panel. The shape:
     *
     *   `{version, update: {status, current_version, latest_version,
     *     remote, checked_at, reason, upgrade_command}}`
     *
     * where `status` is one of `current`, `update_available` or `unknown`.
     * `unknown` is a real, visible outcome and carries a `reason`; it must
     * never render as "up to date". `checked_at` is unix seconds for when
     * the comparison last actually ran, so a stale answer is visibly
     * stale. Any failure of this call surfaces in the panel as "could not
     * check", never as "up to date".
     *
     * An earlier draft of the panel assumed `/server/release` with a
     * tri-valued `update_available` boolean. That path never existed; this
     * is the reconciled one.
     *
     * @returns {Promise<object>} the version payload.
     */
    async getReleaseStatus() {
        return await this.call('/version');
    }

    /**
     * File editor: list the file tree for one root.
     * @param {string} root - "user" or "project".
     * @param {string|null} [projectPath] - required for root === "project".
     * @returns {Promise<{root: string, tree: object[]}>}
     */
    async getConfigFileTree(root, projectPath = null) {
        const params = new URLSearchParams({ root });
        if (projectPath) params.set('project_path', projectPath);
        return await this.call(`/config-files/tree?${params.toString()}`);
    }

    /**
     * File editor: read one file's contents.
     * @param {string} root - "user" or "project".
     * @param {string} path - rel_path from a tree listing.
     * @param {string|null} [projectPath] - required for root === "project".
     * @returns {Promise<{content: string, is_executable: boolean, read_only: boolean, size: number}>}
     */
    async readConfigFile(root, path, projectPath = null) {
        const params = new URLSearchParams({ root, path });
        if (projectPath) params.set('project_path', projectPath);
        return await this.call(`/config-files/read?${params.toString()}`);
    }

    /**
     * File editor: write one file's contents.
     * @param {object} body - { root, path, content, project_path, acknowledge_executable }.
     * @returns {Promise<{ok: boolean, backed_up: boolean, is_executable: boolean}>}
     */
    async writeConfigFile(body) {
        return await this.call('/config-files/write', {
            method: 'POST',
            body,
        });
    }

    /**
     * File editor: create one NEW file. The server refuses to overwrite an
     * existing path and never creates directories - both surface as a 400
     * with a message meant to be shown to the user verbatim.
     * @param {object} body - { root, path, content, project_path,
     *   acknowledge_executable, acknowledge_sensitive }.
     * @returns {Promise<{ok: boolean, created: boolean, rel_path: string,
     *   is_executable: boolean, is_sensitive: boolean}>}
     */
    async createConfigFile(body) {
        return await this.call('/config-files/create', {
            method: 'POST',
            body,
        });
    }
}

// Export singleton instance
window.API = new API();
console.log('[API Module] Exported as window.API:', window.API);
