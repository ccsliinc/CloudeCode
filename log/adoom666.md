# adoom666 landed

Newest first. Shas are on adamdev/master.

## 2026-09-10 wave 1 of the web ui plan

- `6f79e90` session terminal theme restoration. A session pinned to a theme
  lost its terminal palette on re-entry: `Themes.applySession(agentType)` ran
  after `ThemeNavigation.applyForSession()` in both `showTerminal()` and
  `returnToExistingTerminal()` and overwrote the xterm palette with the agent
  manifest. Reproduced first, then removed the second writer rather than
  patching around it. Pin and agent now travel together into one resolver.
  Verified against real xterm canvas pixels, 8 checks, plus a negative control
  built from the unfixed tree. Claim id adoom666-theme-restore.
- `8898f07` session row action menu. THIS IS THE ONE THAT COLLIDES WITH YOUR
  ccsliinc-session-row-menu claim. See notes/adoom666-to-ccsliinc-menu-registry.md.
- `46e7aca` durable notification mute. Schema v25 to v26, two nullable columns
  with no default so absence of a decision reads as unmuted and forks start
  unmuted for free. `PATCH /api/v1/sessions/records/{uuid}/notifications`.
  Suppresses web and external alerts; a muted PermissionRequest is NOT acked
  and still paints the session blocked. Policy generations on queue entries
  block escapes in both directions. A failed policy read SUPPRESSES rather
  than alerting, the opposite posture from our sub-agent gate, on purpose.
- `4ae4b71` the plan document itself.

## 2026-09-09 into 2026-09-10, event loop and terminal latency

- `2b1fcb9` kqueue tail wakeup replacing the 20ms poll on the terminal output
  pipe. `EVFILT_VNODE` handed to asyncio's own selector, no thread per session.
  Keystroke to byte p50 26.10ms to 12.31ms, p99 141.32 to 77.59. Idle CPU
  across 11 panes 0.97% vs 0.98%, indistinguishable, which is why it shipped.
  The 20ms poll stays as a backstop.
- `a4eff35` attachable-session index. The per-row cost was SQLite connections,
  not subprocesses: three columns of one row fetched by three functions each
  opening its own connection. 3+3N to 3 per pass.
- `c8ef6a8` /sessions/list ran 2N+1 tmux subprocesses synchronously for N
  sessions, every 5s, from two pollers. 1008ms of event loop starvation at 13
  sessions. This was the cause of typing lag, slow session switching AND the
  3s delay before a sidebar row highlighted; all three were one bug.
  27 subprocesses per poll to 1.
- `bd9a2b2` cross-session output bleed. One page reuses one xterm; a replaced
  websocket stays in CLOSING and keeps dispatching in-flight frames, and
  nothing validated socket or session identity before writing to the terminal.
  Content from one session painted inside another. Fixed with a frame guard,
  9.7ns per call.
- `3366257` the attach repaint sent the screen without the cursor, so typed
  characters landed rows away from the prompt.
- `9f01c6c` live output stopped streaming after any server restart: the
  lifespan reconcile attached without starting pipe-pane and created an empty
  pipe file nothing wrote to. Boot order meant it reliably hit the session the
  user was actually sitting in.

## 2026-09-09 releases

- `v1.0.36` on both Adoom666/CloudeCodeDev and Adoom666/CloudeCode, DMG
  attached to both. README download link corrected: it pointed at the private
  dev repo and 404'd for anyone reading the public page.
