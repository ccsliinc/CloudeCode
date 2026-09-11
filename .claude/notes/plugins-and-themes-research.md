# Themes and plugins: herdr comparison, our current state, and the seam to leave

Research only. Nothing here is built. Owner asked whether we should make
themes expandable and add a plugin ability "something like herdr."

## Herdr's theme system

**It exists, but it is a small closed palette, not arbitrary CSS.** Config
lives in TOML (`~/.config/herdr/...`, per `src/config/theme.rs` and
`src/config/io.rs`). `theme.name` picks a built-in (e.g. `"catppuccin"`,
`"terminal"`). `theme.auto_switch` plus `theme.light_name` /
`theme.dark_name` swap by system appearance. `[theme.custom]` overrides a
FIXED, named set of keys only: `sidebar_bg`, `active_row_bg`,
`selection_bg`, `panel_bg`, `accent`, `green`, `blue`, `red`, `yellow`.
Values are hex, named colors, `rgb(r,g,b)`, or `"reset"` / `"default"` /
`"none"`. `[theme.custom.light]` / `[theme.custom.dark]` layer mode-specific
overrides on top. There is no per-theme stylesheet, no JS, no layout
control - a theme can only recolor the fixed key list. Source:
`src/terminal_theme.rs`, `src/config/theme.rs` (confirmed to exist via the
GitHub API directory listing; exact struct body not fetched, field names
above are from `herdr.dev/docs/configuration`, cross-checked against the
key list documented there).

## Herdr's plugin system

**It exists and is a subprocess model with no sandbox** - not adaptable to
a browser tab under CSP, but the surface list is worth stealing. A plugin
is a directory with a `herdr-plugin.toml` manifest
(`id`, `name`, `version`, `min_herdr_version`, `platforms`) plus ordinary
argv commands Herdr launches, run with the plugin directory as cwd. Manifest
tables declare the extension points: `[[actions]]` (invokable commands,
scoped to a context like "workspace"), `[[panes]]` (a plugin-drawn terminal
UI, placement: overlay / popup / split / tab / zoomed), `[[events]]` (hooks
on system events, e.g. `worktree.created`), `[[link_handlers]]` (route a
ctrl+click terminal URL to a plugin action), `[[startup]]` (one-shot init
commands). Install: `herdr plugin install owner/repo[/subdir]` (GitHub) or
`herdr plugin link /path` (local). Per-plugin state lives under
`config_dir()/plugins/config/<hashed-id>/` and
`state_dir()/plugins/<hashed-id>/` (`src/plugin_paths.rs`, fetched raw and
read directly - confirmed, not inferred). Docs state plainly: "A plugin is
ordinary code that runs on your machine... Herdr does not review or sandbox
plugin code" - full user-level access, no permission declarations, no
capability grants. The model is trust-the-author, same as a shell script
you chose to run.

**Why this cannot transplant directly.** Herdr is a single Rust binary
spawning subprocesses on the same machine as its UI. CloudeCode's plugin
surface would run inside a browser tab under a CSP that forbids remote
script, inline script, and eval. A subprocess model has no meaning there;
the closest in-browser equivalent to "ordinary code with no sandbox" is a
bundled JS module loaded same-origin - which is exactly the shape our own
theme `effects.js` already uses (see below), consent-gated instead of
unsandboxed.

## What we already have: themes

**Themes are already a real, working plugin-shaped system, not a stub.**
26 bundled themes live at `client/css/themes/<id>/theme.json`
(`client/css/themes/{matrix,dracula,claude,gameboy,...}`), each a JSON
manifest, not a stylesheet: `id`, `name`, `description`, `author`,
`version`, a `cssVars` object of `--color-*` / `--badge-color-*` /
`--shadow-*` custom properties (the `matrix` manifest alone sets ~60 of
them), a separate `xterm` block for the terminal color palette (16 ANSI
colors + background/foreground/cursor), an optional `effects` field naming
a same-origin ES module (`effects.js`, dynamic `import()`), and an optional
`audio` block (`src`, `srcFallback`, `volume`, `fadeMs`).

**A theme is either a var set or a full stylesheet, both supported.**
`ThemeManifest.themeCss` (checked server-side against the file actually
existing on disk, or the whole manifest is skipped) lets a theme ship a
full CSS file instead of, or alongside, `cssVars` - so the model already
covers both ends the task asked about.

**User themes are a real directory, already scanned at runtime.**
`src/api/routes.py` (`_bundled_themes_root`, `_user_themes_root`,
`_scan_themes_root`, `_load_manifest`, `GET /themes` at line ~3082) scans
two roots every request: bundled (`client/css/themes/`) and user
(`~/Library/Application Support/cloude-code-menubar/themes/`, or
`CLOUDE_USER_THEMES_DIR` env override). Each `theme.json` is try-parsed
against a pydantic `ThemeManifest`; a parse or validation failure is
logged and skipped, never a 500. `manifest.id` must equal the directory
name or the theme is rejected (prevents id collisions across folders). A
user theme whose id collides with a bundled one is dropped with a warning
- bundled always wins, so a shipped breaking change to a bundled theme
can't be shadowed by a stale user copy. This is close to exactly the
model Task C was going to propose - it already exists.

**A session pins a theme independently of the global default.**
`client/js/theme-navigation.js` (`applyForTarget`) is the single function
every navigation goes through: it reads `pinned_theme` off the
`/sessions/list` WRAPPER (`sessionInfo.pinned_theme`, not
`.session.pinned_theme` - the two-level gotcha this repo's CLAUDE.md
already documents), falls back to the user's global theme
(`localStorage['cloude.theme']`) when a pin names a theme id the user no
longer has, and calls `window.Themes.applyTheme`. The registry
(`client/js/themes/registry.js`) writes CSS vars onto `:root`, stamps
`<html data-theme>`, and caches the resolved palette in localStorage so
the pre-auth login screen can paint correctly before the `/api/v1/themes`
endpoint (which sits behind `require_auth`) is reachable.

**The one dynamic-code rung already has a consent gate, which is the
CSP-safe pattern to reuse for plugins.** A theme's optional `effects.js` is
loaded via same-origin dynamic `import()` (`effectsUrlFor` rejects any path
with `/` or traversal chars - flat filename only), and before it ever runs,
`registry.js` shows a modal (`data-modal="theme-effects-consent"`) and
persists the answer per theme id in `localStorage['cloude.themeJsAllowlist']`
(three states: allow / deny / unset-means-ask). This is a real precedent for
"user-authored code, same-origin, explicit consent, remembered per-id" -
the shape a plugin loader should copy.

**How much of the app's color is tokenized:** most of it. `client/css/styles.css`
defines 104 custom properties on `:root`, `client/css/status-led.css` another
43 (`--led-color-permission`, `--led-color-idle`, etc.) - both files noted in
CloudeCode's CLAUDE.md as near the 500-line ceiling, so new tokens belong in
a new file, not appended there. Coverage is not 100% - the CLAUDE.md status-led
section itself documents at least one hardcoded halo-alpha bug fixed by
switching to `color-mix()` against a token - but the backbone (background,
foreground, accent, border, status, badge, syntax, shadow families) is
already variable-driven, which is exactly the precondition a theme system
needs and most apps don't have for free.

## What already behaves like a plugin: agent wrappers

`agents.wrappers` in `config.json` (schema in `src/core/agent_wrappers.py`,
mutated via `Settings._mutate_wrappers` / `_write_wrappers` in
`src/config.py`) is a small, user-editable, ID-keyed registry: each
`AgentWrapper` has an id, a label, a `family` (validated against a closed
enum, defaulting to `claude`, refusing unknown values), and a launch
script. `src/core/agent_wrapper_display.py` is display-time-only resolution
of "what is this wrapper called" from a stored id, deliberately kept apart
from family resolution (`agent_family_display.py`) because a fingerprinted
guess must never be able to name a wrapper it can't prove. This is the
in-repo precedent for "a typed, validated, user-extensible registry with a
resolver that never lets a guess outrank a record" - the exact discipline
a plugin registry needs.

## Recommendation

**Themes: what exists already satisfies the ask; extend, don't replace.**
Keep JSON manifest + `cssVars` (+ optional `themeCss` for a full stylesheet)
+ optional consent-gated `effects.js`, in bundled and user directories,
scanned server-side with the collision and validation rules already
written. The only real gap for the Svelte migration is porting
`registry.js`'s apply pipeline (write vars to `:root`, set `data-theme`,
manage the effects consent flow) into a typed Svelte store, and generating
`client/css/styles.css`'s 104 vars (plus status-led's 43) from a single
token source so a new component can't invent an untokenized color.

**Plugins: build a typed, build-time surface registry now; skip runtime
loading until CSP allows it.** Herdr's subprocess-with-no-sandbox model
does not fit a CSP-locked SPA at all, but its extension-point vocabulary
(actions, panes, events, link handlers) is the right shape to borrow
conceptually: define a small `PluginSurface` type union in TypeScript -
`sidebar-item`, `launchpad-panel`, `session-card-action`, `status-source`
- with one typed registry function per surface
(`registerSidebarItem(def)`, etc.), and ship first-party features (agent
wrappers, the status-led sources already in the CLAUDE.md model) as the
first "plugins" registered through it at build time, inside the Svelte
bundle, no dynamic loading at all. This proves the seam is right before
anything untrusted touches it. A later "load a plugin from a local
directory at runtime" rung is only worth building if it can clear CSP the
way theme `effects.js` already does: same-origin dynamic `import()` of a
flat, non-traversable filename, gated behind the same explicit
consent-and-remember pattern `registry.js` already implements - never a
remote URL, never `eval`, never an iframe to a third-party origin.

**What NOT to build yet:** no plugin marketplace, no permissions/capability
system (herdr itself has none - "ordinary code, no sandbox, review it
yourself" is its entire security model and it targets a terminal, not a
browser with a CSP the owner wants kept clean), no subprocess or IPC plugin
host, no plugin settings-page surface until at least one real internal
consumer needs it. Build the registry types and port the two features that
already act like plugins (agent wrappers, theme effects) onto them first;
a third-party author story is a separate, later decision.
