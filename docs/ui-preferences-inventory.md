# Every durable browser-stored preference, and how it is classified

Written for issue #42. This is the PREREQUISITE for #43 (a typed versioned
`ui_preferences` block), #44 (partial preference updates) and #46 (one-time
import of a browser's existing settings). Those three build against this
document, so a key missing here is a setting that will silently fail to sync
later. The classification is the deliverable, not the list: a bare key name
tells the implementing agent nothing about whether moving it to the server is
correct.

## Method, and how completeness was established

This is a read of the code, not a scrape of a running browser (the issue's
"What must NOT change" section forbids the latter, and rightly - a browser only
ever holds what one user's one device has written, never the full set a build
can produce).

1. `grep -rl "localStorage\|sessionStorage" client/js/ | wc -l` -> **30**,
   matching the issue's own measurement. That file list is reproduced under
   "File accounting" below with what each one turned out to hold.
2. For every one of those 30 files, grepped every literal
   `localStorage.getItem|setItem|removeItem` call, THEN separately grepped
   `<anything>.getItem|setItem|removeItem` to catch the files that take a
   `storage` parameter instead of naming `localStorage` directly (dependency
   injection for unit-testability - `archive-nav-order.js`,
   `archive-pane-resize.js`, `themeAudioSettings.js`, `terminal-away-gap.js`).
   A regex over the literal token alone would have missed all four of those
   files' actual read/write call sites, even though the token count already
   matched the file-count check - which is exactly the false confidence the
   issue warns "a script that reports 4 keys when there are 20" about.
3. Cross-checked `sessionStorage` (zero hits anywhere in `client/`),
   `document.cookie` and `indexedDB`/`Dexie`/`idb` (zero hits in `client/`,
   `client/vendor/` and `macOS/`) to confirm localStorage is the only durable
   client store in this codebase. Confirmed against the vendored xterm/
   CodeMirror bundles too - neither carries its own persistence.
4. Extracted every string literal matching `cloude[._][A-Za-z0-9._]*` or
   `claude_[A-Za-z0-9_]*` across `client/js/**/*.js` and read every hit in
   context. This caught one key no call-site grep would have surfaced on its
   own (`cloude.theme.vars`, only ever referenced through a `VARS_CACHE_KEY`
   variable) and ruled out a set of false positives: `cloude_a`, `cloude_fs2`,
   `cloude_myproject`, etc. are tmux session-name examples inside JSDoc
   `@example` lines (the app's `cloude_*` session-name prefix, not a storage
   key), and `cloude.jwt.v1` is a WebSocket subprotocol string
   (`client/js/api.js:1462`), not anything written to storage.
5. Read every remaining call site by hand rather than trusting the grep output
   as a value shape - composed keys (`"root:relPath"` in
   `config-editor-tree-state.js`, `"g:<uuid>"` fold entries inside
   `session-sidebar-store.js`'s single JSON envelope) do not show up as a
   distinct literal at all, only as string concatenation read at runtime.
6. Read `macOS/bootstrap.js`'s one hit - it is a markdown template string
   documenting `cloude.themeJsAllowlist` for theme authors, not a second call
   site - and confirmed the Electron shell has no persistence layer of its
   own (no `electron-store`, no `Store(`); it loads the same `client/` code,
   so the inventory below is complete for the desktop app as well as a plain
   browser.

**Result: 24 distinct keys** across those 30 files (22 real settings plus one
pure render cache and one already-retired key kept only so a migration can
delete it). Two of the 24 are secrets and excluded from anything server-side
by design.

## Classification counts

| Classification | Count | Keys |
|---|---|---|
| Shared preference (candidate for `ui_preferences`) | 8 | `cloude.theme`, `cloude.audio.enabled`, `cloude.audio.master`, `cloude.audio.volume` (legacy source for the same logical value), `cloude_provider_last_model`, `cloude.session.sidebar.density`, `cloude.session.sidebar.arrangement`, `cloude.configEditor.collapsed` |
| Per-viewer convenience (must NOT sync) | 10 | `cloude.launchpad.deletedSessionsVisible`, `cloude.launchpad.archivedVisible`, `cloude.statusKey.open`, `cloude.away.lastChoice`, `cloude.archive.projectOrder`, `cloude.archive.panes.v1`, `cloude.themeJsAllowlist`, `cloude.theme.vars`, `cloude.audio.settingsVersion`, `cloude.audio.muted` (retired) |
| Ambiguous - record both readings (issue's own instruction; the four dock/fold controls that behave differently by viewport) | 4 | `cloude.configEditor.pinned`, `cloude.session.sidebar.pinned`, `cloude.session.sidebar`, `cloude.launchpad.collapsed` |
| SECRET (never in `ui_preferences`, never printed) | 2 | `claude_tunnel_token`, `claude_refresh_token` |

No key resolved to "already server-owned" - if a preference already lived on
the server, it would not be in `localStorage` at all. Three FEATURES that sit
right next to this inventory are already server-owned and are documented at
the end so the next agent does not go looking for a client key that does not
exist: the per-session theme pin, the agent/notification settings panel, and
session-group membership.

---

## Shared preference candidates

### `cloude.theme`
- **Composition**: static key, one value, the theme id string (e.g. `claude`,
  `matrix`).
- **Written**: `client/js/themes/registry.js:613`, inside `applyTheme()`, ONLY
  when called with `opts.persist === true` - that is the caller's way of
  saying "this is the user's new default", as opposed to a per-session paint
  that must not overwrite it.
- **Read**: `client/js/themes/registry.js:133` (`getStoredThemeId()`), which is
  the ONE function every other reader goes through -
  `applyStoredThemeIdSync()` (same file) uses it to paint `<html data-theme>`
  before the themes endpoint answers, and `theme-navigation.js` uses it as the
  fallback when a navigation target carries no session pin of its own. `app.js`
  used to open-code `localStorage.getItem('cloude.theme') || 'claude'` in
  three places (see the comment at `registry.js:1034`); all three now go
  through `getStoredThemeId()`.
- **Value**: string, default `'claude'` (`DEFAULT_THEME_ID`).
- **Server owner**: none yet. Candidate: `ui_preferences.theme.default`.
- **Distinct from**: the PER-SESSION theme pin, which is already server-owned
  (see "Already server-owned" below) and never touches this key.

### `cloude.audio.enabled`
- **Composition**: static key, one value.
- **Written / read**: `client/js/globalAudioToggle.js:125` /
  `:105` (`persist()` / `isOn()`).
- **Value**: `'on'` or `'off'` string. Defaults to off (`isOn()` returns
  `false` on any read failure or absence) - "audio has always shipped
  silent-by-default", per the file's own docblock.
- **Server owner**: none yet. Candidate: `ui_preferences.audio.enabled`.
- This is the ONE remaining audio on/off switch. It replaced a per-session
  opt-in that used to live in `session-theme-menu.js`
  (`isAudioOn`/`setAudioOn`/`toggleAudio`) - that code and its storage key are
  DELETED, not layered under this one. See "A stale doc pointer" below: one
  other file still describes that deleted key as if it were current.

### `cloude.audio.master`
- **Composition**: static key, one JSON object: `{"v": <float 0..1>,
  "setUnder": <int>}`. `v` is the deliberate master gain; `setUnder` is the
  settings-schema version it was written under (currently always 3), kept so
  a FUTURE migration can reason about the budget a value was chosen against
  rather than guessing from the number alone.
- **Written**: `client/js/themeAudioSettings.js:356` (`writeVolume()`), called
  from `client/js/themeAudioVolume.js:75` (`set()`), called from
  `client/js/themeAudio.js:429` (`setVolume()`), which is the only path that
  reaches it: the settings panel's slider, or `ThemeAudio.setVolume()` from a
  console.
- **Read**: `client/js/themeAudioSettings.js:333` (`readVolume()`), which
  prefers this key and falls back to `cloude.audio.volume` (below) only when
  this one is absent, unparseable, or out of range.
- **Value**: clamped to `[MIN_MASTER_VOLUME (0.35), 1]` on both read and
  write; a value at or below 0 heals to the floor on next read rather than
  persisting as silence.
- **Server owner**: none yet. Candidate: `ui_preferences.audio.masterVolume`
  (same logical preference as `cloude.audio.volume`; this is the current key).

### `cloude.audio.volume` (legacy source for the same preference)
- **Composition**: static key, one value, a bare float `0..1` as a string.
- **Written**: nowhere, by design, as of settings schema v2. It is the PRE-v2
  master-volume key (an attenuator that defaulted to 0.3 and multiplied with
  the per-theme manifest volume - see the schema-version history in
  `themeAudioSettings.js:11-24`). A migration (`migrate()`,
  `themeAudioSettings.js:240`) deletes it outright on any store below schema
  version 2, specifically because a value written under the old budget would
  silently re-apply an inaudible gain on top of the new manifest volumes if
  it were kept.
- **Read**: `client/js/themeAudioSettings.js:344` (`readVolume()`), as a
  fallback ONLY for a store the migration has not yet reached (schema version
  1, unstamped) or that was written before the migration ran in this session.
  In steady state, after the migration has run once, this key no longer
  exists.
- **Server owner**: same logical preference as `cloude.audio.master`; a
  migration/import step should read this ONLY as a fallback when the master
  key is absent, exactly as the client does, never on its own.

### `cloude_provider_last_model`
- **Composition**: static key (note the underscore-separated spelling - the
  only key in the tree that does not follow the `cloude.dotted.path`
  convention every other key uses; flagging it rather than "fixing" it, since
  a rename is a migration of its own and out of scope for this issue).
- **Written / read**: `client/js/providers.js:63` / `:55`
  (`rememberChoice()` / `readLastChoice()`).
- **Value**: the last OpenRouter model id chosen in the provider-selector
  modal, or `''` meaning "claude" (no model). Validated against
  `MODEL_ID_RE` (`^(?!-)[A-Za-z0-9._~/-]{1,120}$`) before use, mirroring the
  server's own `MODEL_ID_PATTERN`.
- **Server owner**: none yet. Candidate: `ui_preferences.launch.lastModel`.

### `cloude.session.sidebar.density`
- **Composition**: static key, one value.
- **Written / read**: `client/js/session-sidebar-density.js:165` / `:107`.
- **Value**: one of `'compact' | 'cozy' | 'detailed'` (`MODES`); default
  `'cozy'`.
- **Server owner**: none yet. Candidate:
  `ui_preferences.sidebar.density`.

### `cloude.session.sidebar.arrangement`
- **Composition**: static key, one JSON envelope, owned exclusively by
  `client/js/session-sidebar-store.js` and reached by every other module
  (`session-sidebar-arrangement.js`) through that one module's functions -
  never a second direct reader/writer.
  ```
  { "v": 1, "pinned": [<session name>, ...],
    "order": [<session name>, ...],
    "collapsed": [<"pinned"|"other"|"g:<uuid>">, ...] }
  ```
  `collapsed` mixes two FIXED section keys (`pinned`, `other`) with
  DYNAMIC per-user-group fold keys shaped `g:<uuid>`, one entry per group the
  user has ever folded (`GROUP_FOLD_PREFIX`, `session-sidebar-store.js:103`).
  The `g:<uuid>` shape is validated structurally, not against a live list of
  groups, because the group list itself loads asynchronously from the
  database after this parse runs (`isFoldKey()`,
  `session-sidebar-store.js:129`).
- **Written / read**: `client/js/session-sidebar-store.js:309` (`save()`) /
  `:204` (`load()`).
- **Value shape carries THREE possible verdicts, not two**:
  `'default'` (nothing stored), `'ok'` (parsed cleanly), `'unreadable'`
  (something is stored and could not be understood - the bad bytes are never
  overwritten, so the user's real arrangement is recoverable). A future sync
  implementation needs the same third state: silently treating an unreadable
  local arrangement as "nothing to sync" would be exactly the false-green
  this project has already paid to remove elsewhere (see CLAUDE.md's
  gotchas).
- **Bounds**: `MAX_REMEMBERED = 200` names kept in `pinned`/`order`,
  `MAX_FOLDS = 100` fold entries.
- **Server owner**: none yet. Candidate:
  `ui_preferences.sidebar.arrangement`, carrying the same envelope shape.
  `pinned`/`order` name SESSIONS BY NAME, which is a local, reused, mutable
  identifier (CLAUDE.md: "a session id is not a tmux name") - the
  implementing agent needs to decide whether a synced arrangement is allowed
  to reference names that do not resolve to anything on a different machine,
  or whether it degrades the same way `'unreadable'` does today.

### `cloude.configEditor.collapsed`
- **Composition**: static key, one JSON object, `{"<rootId>:<relPath>":
  <boolean>, ...}` where `rootId` is one of `'user' | 'project' | 'workdir'`
  and `relPath` is a path relative to that root (`'__root__'` for the root
  node itself). Grows one entry per file-tree directory node the user has
  ever expanded or collapsed, across every project ever opened in this
  browser - there is no eviction.
- **Written / read**: `client/js/config-editor-tree-state.js:74`
  (`setNodeCollapsed()`) / `:54` (`load()`).
- **Value**: boolean per composite key. `FORCE_COLLAPSED_DIRS` (currently
  just `plugins`) always overrides whatever is persisted, so a stored `false`
  for a forced directory is inert, not stale.
- **Server owner**: none yet. Candidate:
  `ui_preferences.configEditor.collapsedPaths`. Note for the implementing
  agent: `relPath` is a path INSIDE the project or the user's home, not an
  absolute filesystem path, so it carries no machine-specific information -
  but it is still project-shaped data riding inside a "preference", worth a
  second look before syncing it verbatim.

---

## Per-viewer conveniences (must not sync)

These match the issue's and CLAUDE.md's own examples almost exactly, and most
say so in their own file's docblock - this is not a judgment call being made
for the first time here, it is transcribing what the code already asserts
about itself.

### `cloude.launchpad.deletedSessionsVisible`
- `client/js/launchpad.js:209` (write) / `:188` (read),
  `getDeletedSessionsVisiblePref()` / `setDeletedSessionsVisiblePref()`.
- Value: `'1'`/`'0'`, default off. The method's own docstring: "per-device
  like every other launcher preference".

### `cloude.launchpad.archivedVisible`
- `client/js/launchpad.js:255` (write) / `:241` (read).
- Value: `'1'`/`'0'`, default off (hidden). Docstring: "Same convention as
  `cloude.launchpad.collapsed` and `cloude.theme`" for the STORAGE mechanism,
  but the surrounding paragraph is explicit that this is a per-device show/hide
  toggle, same family as the deleted-sessions one above.

### `cloude.statusKey.open`
- `client/js/session-status-key.js:172` (write) / `:154` (read).
- Value: `'1'`/`'0'`, default collapsed. This is the exact example CLAUDE.md
  gives for a per-device key: "collapsed by default... an unreadable or absent
  value means collapsed rather than an error." Whether the status-light
  legend is expanded has nothing to do with any other device.

### `cloude.away.lastChoice`
- `client/js/terminal-away-gap.js:181` (write) / `:158` (read); the actual
  `Storage` object is supplied by the one caller,
  `client/js/terminal-away-bar.js:198` / `:301`
  (`G.writeRememberedChoice(window.localStorage, ...)` /
  `G.readRememberedChoice(window.localStorage)`).
- Value: one of `'full' | 'summary' | 'continue'`. The file's own docstring:
  "Per DEVICE and not per session on purpose: the preference is about how
  this person likes to come back on THIS PHONE."

### `cloude.archive.projectOrder`
- `client/js/archive-nav-order.js:168` (write) / `:143` (read). Storage is
  injected (`s.getItem`/`s.setItem`), not called as a bare global, for
  testability.
- Value: one of `'recent' | 'oldest' | 'name'` (`MODES`), default `'recent'`.
- The file's own docstring is unambiguous: "PERSISTENCE IS A CONVENIENCE, NOT
  STATE. The choice lives in localStorage: it is per-viewer, harmless to lose,
  and never read back by anything but this file." Flagging a tension for the
  implementing agent: the issue's Approach section lists "archive ordering...
  preferences" among the things phase 5 is meant to cover, which reads as an
  aspiration to share it. The code as written disagrees and gives a reason.
  Recording both: the VALUE is trivial to sync if a future spec wants it
  shared: read as a preference, applied unconditionally on any viewport.

### `cloude.archive.panes.v1`
- `client/js/archive-pane-resize.js:156` (write) / `:86` (read) / `:261`
  (remove, on reset). Storage injected, same pattern as above.
- Value: `{"nav": <px>, "list": <px>}`, the two divider positions. Versioned
  key name (`.v1`) so a future shape change is a cache miss, not a misparse.
- Docstring: "A pane width is per-viewer... read and written inside
  try/catch." Values are re-clamped against the CURRENT grid width on every
  load and resize specifically because a width saved on one viewport is
  wrong on another - the strongest possible argument against syncing the raw
  pixel numbers. If a future spec wants to share ratios instead of pixels,
  that is a different value shape, not this key.

### `cloude.themeJsAllowlist`
- `client/js/themes/registry.js:316` (write) / `:303` (read).
- Value: `{"<themeId>": <boolean>, ...}` - a SECURITY CONSENT decision, not a
  cosmetic preference. A theme's optional `effects.js` runs same-origin with
  page access, so the first time a theme with effects is applied the user is
  prompted (Allow once / Always / Never) and the answer is recorded here per
  theme id. Recommending this stay per-viewer even though it is technically
  a "preference": syncing a consent grant would let a "yes" clicked on one
  device silently authorize script execution on every other device logged
  into the same account, which is a materially different security posture
  than what the user agreed to.

### `cloude.theme.vars`
- `client/js/themes/registry.js:152` (write, `cacheThemeVars()`) / `:168`
  (read, `readCachedThemeVars()`).
- Value: `{"id": <themeId>, "cssVars": {...}}` - a cached copy of the last
  successfully-applied theme's resolved CSS variables, painted before
  `/themes` is reachable (kills FOUC for a repeat visitor). Read is REJECTED
  outright if its `id` does not match the theme `cloude.theme` currently
  names, so a stale cache can never paint the wrong theme.
- This is not a preference at all - it is fully derivable from `cloude.theme`
  plus the server's theme manifest. Classified per-viewer/never-sync because
  there is nothing here for a server-side "preference" to own; it would be
  actively wrong to treat a paint-cache as a setting.

### `cloude.audio.settingsVersion`
- `client/js/themeAudioSettings.js:263` (write, inside `migrate()`) / `:211`
  (read, `readVersion()`).
- Value: integer as a string, currently `3`. Purely local migration
  bookkeeping - "has THIS browser's copy of the audio settings already been
  upgraded past the inaudible-gain bug and the deleted mute switch." A value
  synced in from another device would say nothing true about whether this
  browser's own `cloude.audio.volume`/`cloude.audio.muted` still need
  cleaning up, so it must never travel.

### `cloude.audio.muted` (retired)
- Read once, at `client/js/themeAudioSettings.js:252` inside `migrate()`,
  ONLY to log what was discarded, then deleted via `_remove()` at the same
  site. Nothing in the current tree reads it for its own sake, and nothing
  writes it - the control that used to (an app-wide sound master switch,
  defaulting off) is gone entirely.
- Kept in this inventory anyway because a browser that ran a pre-v3 build may
  still carry it on disk until it next loads the app and the migration runs.
  It is not a preference to import; it is a value a migration exists to
  erase, and a future "import this browser's settings" step (#46) must not
  resurrect it.

---

## Ambiguous: record both readings (per the issue's own instruction)

These four are the "dock/fold" family: each one behaves differently by
viewport width already, inside THIS browser, using `MOBILE_MAX_PX` (700px) or
an equivalent breakpoint to decide whether the persisted choice is even
applied. The issue's Approach section anticipates exactly this shape: "Share
preferred layout values while adapting their rendered geometry to the current
viewport." Rather than force one bucket, both readings are recorded so the
person building #43/#44 has the actual tradeoff in front of them.

### `cloude.configEditor.pinned`
- `client/js/config-drawer-pin.js:121` (write) / `:107` (read). Value:
  `'1'`/`'0'`.
- Applied only when `window.innerWidth > 700` (`isEffectivelyPinned()`,
  `!isMobile()`); the preference is still WRITTEN and READ below that width,
  just not obeyed, so re-opening on a wide screen honors it again.
- **Reading A (per-viewer)**: a docked file drawer is a desktop-only concept;
  a phone user's choice here is meaningless and syncing it could dock a
  drawer on a tablet the user never touched.
- **Reading B (shared, viewport-adapted)**: the user's INTENT ("I like this
  panel docked") is a real cross-device preference; only its rendering
  (`isEffectivelyPinned()`) needs to stay local. Under this reading the VALUE
  syncs, the gate does not.

### `cloude.session.sidebar.pinned`
- `client/js/session-sidebar-pin.js:132` (write) / `:119` (read). Same
  `'1'`/`'0'` shape, same `MOBILE_MAX_PX` gate, same two readings as above.
  The file's own docblock explicitly parallels itself to
  `config-drawer-pin.js` ("same persisted key... same 700px cut-off, same
  isEffectivelyPinned() gate").

### `cloude.session.sidebar`
- `client/js/session-sidebar.js:222` (open, write `'1'`) / `:249` (close,
  write `'0'`, but only when `persist !== false` - leaving a screen does NOT
  count as the user closing the bar) / `:159` (read on `show()`).
- Unlike the two pins above, this one has NO viewport gate in this file -
  open/closed is honored on every width. Recording it here anyway because it
  is the same open/closed CONCEPT as the two pins and a reader comparing the
  three should see them together, not conclude the third was missed.
- **Reading A (per-viewer)**: whether the sidebar happens to be open is
  transient UI state, not a considered preference, and a phone left with it
  open would push that onto a desktop session.
- **Reading B (shared)**: for a user who deliberately keeps it open every
  session (the pin is a stronger version of the same intent), the two could
  reasonably be unified under one synced "sidebar open" preference with the
  pin controlling whether closing is even possible.

### `cloude.launchpad.collapsed`
- `client/js/launchpad.js:3907` (write, `setLaunchpadSectionCollapsed()`) /
  `:3889` (read, `getLaunchpadCollapsedState()`).
- Value: `{"<sectionId>": <boolean>}` for exactly three fixed ids -
  `'running-sessions'`, `'recent-sessions'`, `'recent-projects'` - the home
  screen's three disclosure sections. Not dynamic; the id set is a literal
  array in `initSectionDisclosures()`.
- **Reading A (per-viewer)**: same family as `cloude.statusKey.open` (a
  collapsed legend) - a home-screen layout fold, arguably not worth a
  cross-device promise.
- **Reading B (shared)**: the issue's Approach text names "collapsed groups"
  explicitly among what phase 5 must cover, and unlike the legend this
  reflects how much of the home screen a user wants to see by default, which
  argues for syncing it like `cloude.session.sidebar.density`.

---

## SECRETS - excluded from everything, never printed

### `claude_tunnel_token`
- **Written**: `client/js/auth.js:232` (`setToken()`).
- **Read**: `client/js/auth.js:225` (`getToken()`); ALSO
  `client/js/api.js:61` (`getToken()`), a SECOND independent reader.
- **Removed**: `client/js/auth.js:242` (`clearToken()`); ALSO
  `client/js/api.js:245`, a fallback path used "if `window.Auth` hasn't
  initialized yet" (`handleUnauthorized()`).
- **This key has two writers of removal and two readers** - exactly the "a
  key with two writers is a finding" case the issue asks for. It is benign
  here (both call sites agree on the key name and both treat it as the
  bearer access token) but it is a real duplicate surface: a rename or a
  rotation scheme touching one of these two files and not the other would
  silently desync them.
- Access-token JWT for the tunnel session. Never appears in this document's
  value, never will.

### `claude_refresh_token`
- **Written**: `client/js/auth.js:257` (`setRefreshToken()`), only when a
  token value is truthy.
- **Read**: `client/js/auth.js:252` (`getRefreshToken()`).
- **Removed**: `client/js/auth.js:244` (`clearToken()`, unless
  `{accessOnly: true}` is passed); ALSO `client/js/api.js:246`, same
  fallback path as above.
- Refresh token for the rotation dance in `api.js`. Same two-writer-of-removal
  shape as the access token, same reasoning.

**Neither key's spelling was "corrected" to `cloude_*`.** They predate, or
sit alongside, the app's `cloude.*` localStorage convention and are recorded
exactly as they appear in the source. Per the issue: never print a value,
never copy one into this or any other document, and both are out of scope
for sharing, full stop - there is no server store these could ever "own."

---

## File accounting (all 30)

Every file the issue's verification grep names, and what it turned out to
hold. "No direct call site" means the file matched the grep only through a
comment, a delegated call into another module, or an injected-parameter
pattern with nothing of its own to add - each is still read in full and
confirmed empty rather than assumed empty.

| File | What it holds |
|---|---|
| `api.js` | Reads/removes the two SECRET tokens as a fallback path (see above). |
| `app.js` | No direct call site. Comment-only reference; theme reads now go through `Themes.getStoredThemeId()` (see `cloude.theme`). |
| `archive-nav-order.js` | `cloude.archive.projectOrder`. |
| `archive-nav.js` | No direct call site; comment only, about avoiding a per-paint read of another module's store. |
| `archive-pane-resize.js` | `cloude.archive.panes.v1`. |
| `auth.js` | Primary read/write/remove for both SECRET tokens. |
| `config-drawer-pin.js` | `cloude.configEditor.pinned` (ambiguous). |
| `config-editor-tree-state.js` | `cloude.configEditor.collapsed`. |
| `globalAudioToggle.js` | `cloude.audio.enabled`. |
| `launchpad.js` | `cloude.launchpad.deletedSessionsVisible`, `cloude.launchpad.archivedVisible`, `cloude.launchpad.collapsed` (ambiguous). |
| `providers.js` | `cloude_provider_last_model`. |
| `session-sidebar-arrangement.js` | No direct call site; reads/writes exclusively through `window.SessionSidebarStore` (see `session-sidebar-store.js`). |
| `session-sidebar-density.js` | `cloude.session.sidebar.density`. |
| `session-sidebar-group-store.js` | No direct call site. Its own docblock: "THE DATABASE IS THE ONLY SOURCE. There is no localStorage mirror" - group membership is already server-owned (see below). |
| `session-sidebar-groups.js` | No direct call site; comment only, referencing the fold-key convention `session-sidebar-store.js` owns. |
| `session-sidebar-pin.js` | `cloude.session.sidebar.pinned` (ambiguous). |
| `session-sidebar-reorder.js` | No direct call site; comment only ("the order live in localStorage and commit here"), the actual write is in `session-sidebar-store.js`. |
| `session-sidebar-store.js` | `cloude.session.sidebar.arrangement`, the sole owner. |
| `session-sidebar.js` | `cloude.session.sidebar` (ambiguous). |
| `session-status-key.js` | `cloude.statusKey.open`. |
| `session-theme-menu.js` | No direct call site. Per-session theme goes through a server PATCH (already server-owned, see below), never localStorage. Its docblock still describes a per-session audio opt-in key that used to live here - see "A stale doc pointer" below; that key no longer exists anywhere in the tree. |
| `settings-panel.js` | No direct call site. Appearance delegates entirely to `registry.js`/`ThemeSelector`; agent/notification config is a server PATCH (already server-owned, see below). |
| `terminal-away-bar.js` | Supplies `window.localStorage` into `terminal-away-gap.js`'s injected functions for `cloude.away.lastChoice`; no key of its own. |
| `terminal-away-gap.js` | `cloude.away.lastChoice`. |
| `theme-navigation.js` | No direct call site; reads the default through `registry.js`'s `getStoredThemeId()`, writes either a server-side session pin or `cloude.theme` via `Themes.applyGlobal()` (both already covered under `cloude.theme`). |
| `themeAudio.js` | Supplies `localStorage` into `themeAudioSettings.js`/`themeAudioVolume.js`'s injected functions for `cloude.audio.master`, `cloude.audio.volume`, `cloude.audio.settingsVersion` and `cloude.audio.muted`; no key of its own. |
| `themeAudioSettings.js` | `cloude.audio.master`, `cloude.audio.volume` (legacy), `cloude.audio.settingsVersion`, `cloude.audio.muted` (retired). |
| `themeAudioVolume.js` | No direct call site; wraps `themeAudioSettings.js`'s `readVolume()`/`writeVolume()`. |
| `themes/registry.js` | `cloude.theme`, `cloude.theme.vars`, `cloude.themeJsAllowlist`. |
| `toast.js` | No direct call site. Its own comment: "No localStorage cross-tab sync; the WS broadcast is the source of truth" - confirmed, not merely asserted. |

All 30 accounted for. 24 distinct keys.

## Already server-owned (not client keys; noted so nobody goes looking)

The issue's Approach text asks for "every other durable app preference
discovered during the storage inventory." These three are not localStorage
keys - they are the things three of the "no direct call site" files above
turned out to be doing instead, and they are worth a line each so the next
agent does not mistake their absence from the table above for a gap in the
sweep.

- **Per-session theme pin.** `session-theme-menu.js` and `theme-navigation.js`
  PATCH `/api/v1/sessions/<tmux name>/theme`. The server persists it twice,
  both keyed by the tmux session name: `<working_dir>/.cc.theme` and
  `pinned_themes.json`. Already server-owned; not a candidate for
  `ui_preferences`.
- **Agent wrapper / notification / general server config.**
  `settings-panel.js`'s non-appearance tabs collect a batched PATCH to
  `/config/settings`, landing in `Settings` (`src/config.py`). Already
  server-owned.
- **Session group membership and folds' underlying group list.**
  `session-sidebar-group-store.js` reads/writes through the database via the
  server API; only the FOLD state of a group (open/closed) lives client-side,
  inside `cloude.session.sidebar.arrangement`'s `collapsed` array above - the
  group's existence, name and membership do not.

## A stale doc pointer (found, not fixed - this issue produces no code changes)

`client/js/themeAudioSettings.js:81-83` reads: "The per-session music opt-in
(`cloude.audio.session.<tmux name>`) is NOT owned here; it belongs to
session-theme-menu.js." That key does not exist anywhere in the current tree
(confirmed: zero hits for `cloude.audio.session` or any per-session audio key
across `client/js/`), and `session-theme-menu.js`'s own docblock says the
per-session opt-in it used to own is "gone... audio is now a single global
on/off" (`cloude.audio.enabled`, above). The pointer describes a key that was
retired when `globalAudioToggle.js` replaced it and was never updated. Flagged
per CLAUDE.md gotcha 8 ("a stale doc is worse than no doc") for whoever next
touches `themeAudioSettings.js` - no code or comment changed here, since this
issue is scoped to producing a document, not a fix.

## Reproducing this sweep

```
grep -rl "localStorage\|sessionStorage" client/js/ | wc -l   # 30
grep -rl "document\.cookie\|indexedDB\|Dexie" client/ macOS/  # nothing
grep -rohE "'cloude[._][A-Za-z0-9._]*'|\"cloude[._][A-Za-z0-9._]*\"|'claude_[A-Za-z0-9_]*'|\"claude_[A-Za-z0-9_]*\"" \
    client/js/*.js client/js/themes/*.js | tr -d "'\"" | sort -u
```
The third command is the completeness check for composed/indirect keys: every
literal it surfaces is accounted for above, and every hit that is NOT a real
storage key (the `cloude_<name>` tmux-example family, `cloude.jwt.v1`) is
named explicitly in "Method" so a re-run does not have to re-derive that they
are false positives.

No key was found that could not be classified.
