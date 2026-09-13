# Carnivore.ai roadmap: the feature brainstorm, 2026-09-13

This is the ideas backlog and the tiered roadmap produced on 2026-09-13 from
Adam's brief and three research sweeps: a read-only recon of this repository, a
competitor sweep and a culture and governance sweep. It is a PLAN, not a record
of what shipped; where it and the code disagree, the code wins and this file is
the thing to fix.

## 1. Context

Adam wants a roadmap of new features for the app (Cloude Code today, possibly
Carnivore.ai). He supplied 17 ideas and asked for 50 more novel ones, produced
under the "golden unicorn" rule: first ideate with zero limits, THEN pick the
top 50 and pair each with a "what's probably possible" version. Every feature
must also be tagged: shipped default, or plugin.

Three research sweeps fed this: a read-only recon of this repo (what each idea
would build on or collide with), a competitor sweep (Conductor, Crystal, Vibe
Kanban, Sculptor, Happy, Omnara, Wave, Warp Oz, Zellij, Agent Deck, CCManager,
Devin, Emdash, Claude Code Router, ACP, A2A, ccusage, herdr.dev), and a
culture/governance sweep (90s BBS mechanics, VS Code / Obsidian / Raycast /
Steam Workshop / Homebrew governance, the Claude and Codex skill formats,
screen pets, gamification, cheap-LLM log summarization). Full cited research
findings were kept in the session scratchpad and are not committed.

## 2. Hard facts that shape everything (from the sweeps)

Repo facts:
- Multi-viewer streaming already exists server-side: one session can have N
  WebSocket viewers, each with a bounded queue, and resize is smallest-wins
  across viewers (`src/api/websocket.py`, `src/core/terminal_size.py`). The
  blocker for multi-pane is the CLIENT: `client/js/terminal.js` is a 2763-line
  singleton holding one xterm, one socket, one write queue, one reconnect
  budget.
- The sub-agent toast gate exists (`src/core/hook_toast_gate.py`), driven by
  `subagent_depth` from hook events, which arrive unordered and duplicated.
  Nothing reads the pane text "Waiting for N background agents". The permission
  verify path already proves the pattern of checking the PANE after 20s.
- Plugins are build-time TypeScript modules compiled into `client/dist/app.js`
  because the CSP is `script-src 'self'` with no eval. The ONE runtime-script
  precedent is theme `effects.js`: same-origin file, sha256 digest, explicit
  consent per digest, deny wins. Any runtime plugin story copies that shape.
- 23 bundled themes, manifest = `theme.json` with cssVars/xterm/effects/audio.
  No screenshot field. User themes dir not yet wired into Settings.
- Skills are already discovered as slash commands from `~/.claude/skills` and
  `<project>/.claude/skills` (`src/core/slash_command_discovery.py`). The
  config-file editor can create a `SKILL.md`.
- Zero git awareness per session. Zero cost / quota / rate-window code. Zero
  SSH / remote host runtime (the archive has a host DIMENSION only).
- Transcript usage fields (input, output, cache create, cache read) are already
  parsed for the archive (`src/core/archive_turn_info.py`). `model` is a column
  on the sessions table.
- Inter-session plumbing: `POST /sessions/command` types into a pane via
  send-keys; `/ws/events` broadcasts to browsers. No addressing, no inbox.
- Electron menubar app ships the Python server for macOS. `IOS_APP_PLAN.md`
  (1976 lines) already recommends a native SwiftTerm app. PWA works over http.
- Three push channels: ntfy, Slack webhook, Pushover.
- "Carnivore" appears nowhere in the tree. Untracked `AGENTS.md`,
  `.agents/skills/` and `.codex/config.toml` are the start of Codex-harness
  support.
- Rulings that bind: no CSP relaxation ever; new UI is Svelte 5 in `web/`; KISS;
  one repo (Adoom666/CloudeCodeDev); CI is off so local runs are the evidence.

Ecosystem facts:
- agentskills.io is REAL (Anthropic, 2025-12-18). Portable frontmatter subset:
  `name, description, license, compatibility, metadata, allowed-tools`. Claude
  Code and Codex both listed as clients.
- Codex discovers skills at `.agents/skills/` (repo, walked to root),
  `~/.agents/skills/`, `/etc/codex/skills/`. NOT `.codex/skills/`.
- One skill folder serves both harnesses if it sticks to the common subset,
  but it needs two directory entries (`.claude/skills/` and `.agents/skills/`),
  copy or symlink. There is no shared discovery path.
- Claude `plugin.json` / `marketplace.json` (hooks, MCP, scopes) is Claude-only.
  A cross-harness catalog item can be a SKILL, never a Claude PLUGIN.
- Nobody in the skills ecosystem does cryptographic publisher signing. Everyone
  SHA-pins and scans. That is an open lane.
- Nobody's quota tracker is session-aware; all report account-level only.
- Only bolt-on MCP servers let Claude Code and Codex message each other today.
- Zellij's multiplayer cursors have never been applied to an agent session.
- Happy is E2EE but not a real terminal; Omnara is a real terminal but not E2EE.

## 3. The unicorn ladder: everything, no limits

Numbered so the top-50 cut in section 4 can cite them. A = Adam's originals.

Aesthetic / BBS
- U1 The whole app boots as a BBS: ANSI splash, modem handshake, "last callers",
  one-liner wall, NEWSCAN of everything since your last login.
- U2 Monthly signed ANSI artpack drops: themes shipped like ACiD packs.
- U3 Access tiers earned by evidence (GUEST, CALLER, CONTRIBUTOR, OPERATOR,
  SYSOP) that unlock hidden menus and catalog powers.
- U4 Door games where the AGENTS are the players: a LORD-style arena where
  sessions duel by solving real tasks; the winner's diff gets merged.
- U5 War-dialer: scan the tailnet for boxes running tmux + claude and "dial in".
- U6 NFO file per swarm run: a provenance sheet, human and machine readable.
- U7 Handles, callsigns and signature blocks for humans AND agents.
- U8 Sysop page: one hotkey anywhere pages a human with run context attached.

Multi-pane / views
- U9 (A) Grid / columns / rows of live sessions.
- U10 Warroom wall: 40 live tiles at low fps, hover to zoom, click to take over.
- U11 Follow-the-action: focus jumps to whichever agent just changed state.
- U12 Linked input: type once, land in N panes (a broadcast keyboard).
- U13 Matrix-rain ambient screensaver rendered from real swarm activity, for a
  wall display.
- U14 Multiplayer cursors: two humans driving one session from two devices.

Notifications
- U15 (A) Kill the crying wolf on sub-agent waits.
- U16 Intent scoring: a local model reads the pane tail and rates "needs me now
  / needs me later / never".
- U17 Digest mode: nothing but hard blocks interrupts; everything else lands in
  a NEWSCAN every N minutes.
- U18 Agents self-report: a hook makes the agent emit `needs_human {why,
  urgency}` and that sentence IS the toast body.
- U19 Approval inbox: every permission prompt across every session in one list,
  answerable from the phone.

Skills / themes / plugins catalogs
- U20 (A) Shared Skills catalog: browse, rank, review, propose updates, install
  to global / project / one-shot, auto-update, cross-harness.
- U21 (A) Shared Themes catalog with screenshots.
- U22 (A) Plugins catalog for the app itself, third-party authors.
- U23 Signed publishers: sigstore-style signatures on every catalog item, the
  thing nobody does.
- U24 Skill-doctor score: lint + eval on upload, a grade on the card.
- U25 Usage telemetry, opt-in: "invoked 4,231 times this week, 92% completion".
- U26 Fork-a-skill: propose a change to someone else's item as a PR, Raycast
  and Homebrew style.
- U27 Skill A/B: same prompt, two skill versions, diff the outcomes.
- U28 Skill mining: "you've done this five times, want it as a skill?"
- U29 Loadouts: named bundles of skills + wrappers + theme, one-click swap.
- U30 Theme from any image: upload a screenshot, get a palette and a theme.json.
- U31 Reactive themes: hues shift with swarm load and token burn.
- U32 Per-family tints: Claude sessions and Codex sessions look different at a
  glance.
- U33 Server-side "door" plugins: Python processes with a manifest, adding
  routes, hooks and pollers without touching the browser CSP.
- U34 Contribution economy: kudos and leech-points inverted, rewarding reusable
  fixes, evals and docs. Leaderboards on the BBS front page.

Git
- U35 (A) Modified-files rail since last commit.
- U36 (A) Repo + branch badge in the terminal header.
- U37 Diff drawer with "explain this diff" on a cheap model.
- U38 Worktree per session, automatic, Conductor / CCManager style.
- U39 Collision radar: two sessions on one repo touching the same file.
- U40 Rewind: a git snapshot per turn, scrub back to any turn.
- U41 Shadow writes: an agent's file edits land in a shadow tree and show as a
  PR before touching disk.

Observability
- U42 (A) Live models in use, token usage over time, running agents, context.
- U43 (A) Provider account ledger: 3 Claude Max plans + Codex, usage, resets.
- U44 Session-aware quota: which session will trip the limit first.
- U45 Account rotation: new sessions launch under the account with the most
  headroom.
- U46 Context-pressure gauge per session.
- U47 Burn-rate alarm: tokens per minute spike detection.
- U48 Cost per branch / PR: tokens attributed to git work.
- U49 Budget guardrails: hard cap per session or day, agent paused at the cap.
- U50 Secrets radar: the agent printed something credential-shaped.

Messaging / swarm
- U51 (A) Cross-provider bus: `@Name do this` between Claude and Codex sessions.
- U52 Shared blackboard: a KV every agent on the box mounts via MCP.
- U53 Handoff: "give this task to a Codex session" carries a transcript summary.
- U54 Prompt queue: prompts that fire when the session's next Stop lands.
- U55 Swarm blueprints: a YAML that launches "3 claude + 1 codex on this repo
  with these skills", one click.
- U56 Bake-off: same task to N harnesses, diff the outputs, vote.
- U57 Panic button: pause every agent on the box, one gesture, gated.
- U58 Session cloning with context (CCManager's trick).

Console / mobile / desktop / remote
- U59 (A) Full TUI with hotkeys, BBS aesthetic.
- U60 TUI as a tmux window on the cloude socket itself, zero new stack.
- U61 (A) iOS / Android native app.
- U62 (A) Mac / Windows / Linux desktop app.
- U63 E2EE relay so the phone works without a VPN (Happy's model, but with a
  real terminal).
- U64 Push-to-talk voice into a pane from the phone.
- U65 Watch complication: swarm status on the wrist.
- U66 (A) Remote tmux hosts over LAN / VLAN / tailnet.
- U67 Federation: every install can publish to another; a fleet of Carnivores.
- U68 mDNS / tailnet discovery of other hosts.
- U91 Move a running agent session between machines, Herdr's stated 1.0 idea.

Integrations
- U69 (A) herdr.dev parity or better.
- U70 Ticket-as-task: Linear / Jira / GitHub issue becomes a session (Emdash).
- U71 Hardware out: Stream Deck keys and LED strips showing swarm state.
- U72 OBS overlay for streamers.
- U73 n8n / Home Assistant webhooks in and out.

Pets / fun
- U74 (A) Pixel helpers that wander the screen and hold a small agent.
- U75 Pets evolve with session productivity; a dead session's pet mourns.
- U76 The pet is your cross-session search daemon.

Understanding what happened
- U77 (A) Event-stream timeline of a session built by a cheap or local LLM.
- U78 While-you-were-away report across the whole swarm.
- U79 Time-travel scrub: terminal scrollback and transcript aligned on one bar.
- U80 Replay as a movie: render a session to MP4 for sharing.
- U81 Auto-retro: on session end a model drafts a LESSONS entry candidate.
- U82 Explain-this-pane button: summarize the last N lines.
- U83 Semantic search across every transcript with local embeddings.
- U84 Agent CV: per-family success stats over time, a trust score.
- U85 Spectator links: read-only, time-limited share of a live session.
- U86 (A) OpenClaw / Hermes first-class harness support.
- U87 Scheduled swarms: cron-launch sessions with a prompt.
- U88 Session-to-skill: crystallize a finished session into a reusable skill.
- U89 Prompt macros with variables, per project.
- U90 Keyboard-only navigation mode (vim keys everywhere).

## 4. The top 50 NEW ideas, each with its "probably possible" twin

Format: Unicorn = the no-limits version. Possible = what ships against this
codebase and the rulings. Verdict = DEFAULT or PLUGIN. Size = S / M / L / XL.
Adam's 17 originals are fleshed out separately in section 5; the 50 below are
the new ones.

### Aesthetic and identity

1. BBS front door (U1)
   Unicorn: the app is a BBS. ANSI splash, handshake sound, last callers,
   newscan, one-liner wall, sysop pages, all live.
   Possible: a new home-screen mode (Svelte) with an ANSI banner rendered from
   a `.ans` file, a "last actors" strip fed by `/ws/events`, a newscan panel
   that lists unread sessions since your last visit, and the theme audio stack
   playing a handshake on connect. Verdict: DEFAULT (the brand), audio PLUGIN.
   Size: M.

2. Signed artpack drops (U2)
   Unicorn: monthly theme packs from the scene, signed, with NFO and members
   list.
   Possible: the Themes catalog supports "packs" (a manifest listing N themes),
   each release signed (see idea 9), with an NFO viewer. Verdict: PLUGIN on top
   of the catalog. Size: S once the catalog exists.

3. Evidence-based access tiers (U3)
   Unicorn: earn SYSOP by contributions; hidden menus unlock.
   Possible: catalog roles derived from measured facts (published items, merged
   fork-PRs, review count), shown as a tier badge on the handle. Nothing gated
   by points; the tier only unlocks moderation powers. Verdict: DEFAULT inside
   the catalog service. Size: M.

4. Agent arena door game (U4)
   Unicorn: agents duel on real tasks, crowd bets, winner merges.
   Possible: bake-off mode (idea 30) with a scoreboard skin. Verdict: PLUGIN.
   Size: S after bake-off.

5. Callsigns and signature blocks (U7)
   Unicorn: every human and agent has a handle, sigil, signature, trust tier.
   Possible: a per-install handle in ui_preferences, an ANSI sigil picker, the
   handle stamped on catalog uploads and on bus messages (idea 26). Verdict:
   DEFAULT. Size: S.

6. Sysop page (U8)
   Unicorn: one key from anywhere pages the human with everything attached.
   Possible: a global hotkey that raises a push notification (existing ntfy /
   Pushover / Slack channels) carrying the session deep link, the last 40 pane
   lines, and the status. Verdict: DEFAULT. Size: S.

7. NFO run manifest (U6)
   Unicorn: every swarm run ships an NFO with provenance, signed.
   Possible: on session end, write a JSON + NFO-styled text file into the
   project (`.carnivore/runs/`) with model, wrapper, skills present, token
   totals, commit range, duration. Verdict: PLUGIN. Size: S.

8. Matrix-rain wall display (U13)
   Unicorn: a wall screen rendering the whole swarm as living rain.
   Possible: a `/wall` route: full-screen canvas, one column per session, glyph
   density driven by output bytes per second, colour by LED state. Reuses
   `/ws/events` plus one summary poll. Verdict: PLUGIN. Size: M.

### Catalog mechanics (shared by skills, themes, plugins)

9. Signed publishers (U23)
   Unicorn: every item cryptographically signed, transparency log, revocation.
   Possible: publisher keypair generated in the app, items signed (minisign or
   sigstore keyless), the client refuses to install an unsigned or mismatched
   item, and a revocation list is pulled with the catalog index. Reuses the
   digest-consent shape from theme effects. Verdict: DEFAULT for the catalog.
   Size: M. This is the thing nobody in the ecosystem does.

10. Skill-doctor grade on upload (U24)
    Unicorn: a full eval run on every upload with a live score.
    Possible: run the agentskills.io reference validator plus Claude's
    `/skill-doctor` style checks at upload; render a letter grade and the
    findings. Verdict: DEFAULT for the catalog. Size: S.

11. Opt-in usage telemetry per item (U25)
    Unicorn: live invocation counts, completion rate, average tokens.
    Possible: the slash-command modal already knows when a skill is invoked;
    count locally, upload daily aggregates if the user opted in, render on the
    card. Verdict: DEFAULT, opt-in. Size: S.

12. Fork-a-skill PR model (U26)
    Unicorn: edit anyone's skill inline, they merge with one key.
    Possible: catalog backed by a git repo per namespace; "suggest update"
    opens a PR with the diff; author merges from the app. Verdict: DEFAULT for
    the catalog. Size: M.

13. Skill A/B (U27)
    Unicorn: shadow-run two versions on every prompt, auto-pick the winner.
    Possible: launch two sessions with different skill versions on the same
    prompt, side by side in the grid (Adam's multi-pane), with a diff of the
    resulting file changes. Verdict: PLUGIN. Size: M after grid.

14. Skill mining (U28)
    Unicorn: the app notices repeated workflows and writes the skill for you.
    Possible: a cheap-model pass over the archive finds repeated prompt shapes
    (the prompt-scan module already extracts prompts), proposes a SKILL.md
    draft into the config-file editor. Verdict: PLUGIN. Size: M.

15. Loadouts (U29)
    Unicorn: swap your entire agent personality in one key.
    Possible: a named set of {skills, wrappers, theme, terminal commands}
    stored in config.json, applied to a project with one action; the catalog
    can publish loadouts too. Verdict: DEFAULT. Size: M.

16. Theme from an image (U30)
    Unicorn: point the camera at a wall, get a theme.
    Possible: upload an image, k-means the palette in the browser (canvas, no
    library), map to the cssVars and xterm keys, save into the user themes dir.
    Verdict: PLUGIN. Size: S.

17. Reactive themes (U31)
    Unicorn: the whole UI breathes with the swarm.
    Possible: a theme may declare `reactive` vars; the app writes token burn
    rate and running-count into CSS custom properties every tick. Verdict:
    PLUGIN. Size: S.

18. Per-family tints (U32)
    Unicorn: every harness has its own visual language.
    Possible: a tint per agent family (claude, codex, shell, openclaw) applied
    to the sidebar row and terminal header; the WrapperPill already knows the
    family. Verdict: DEFAULT. Size: S.

19. Server-side door plugins (U33)
    Unicorn: install a plugin that adds any backend behaviour, sandboxed.
    Possible: a `doors/` directory of Python packages with a manifest (name,
    version, digest, routes it adds, hooks it consumes), loaded at boot only
    after the same digest-consent gate as theme scripts, run in-process with a
    fixed API surface (event hub subscribe, publish notice, read listing). This
    is how integrations (idea 45) and pets' agents become installable without
    ever touching the CSP. Verdict: DEFAULT infrastructure. Size: L.

20. Contribution economy and leaderboards (U34)
    Unicorn: kudos as currency, leech ratios inverted, scene fame.
    Possible: kudos button on catalog items, leaderboard on the BBS front door,
    tiers from idea 3 read kudos as one input. Verdict: DEFAULT for the
    catalog. Size: S.

### Git

21. Diff drawer with explain (U37)
    Unicorn: every hunk narrated as it lands.
    Possible: beside Adam's modified-files rail, click a file to see `git diff`
    in the existing CodeMirror drawer, with an "explain" button that sends the
    hunk to the cheap model (idea 41's summarizer). Verdict: DEFAULT, explain
    is PLUGIN. Size: M.

22. Worktree per session (U38)
    Unicorn: every session is isolated and merges itself.
    Possible: "new session in a worktree" on the launchpad creates
    `git worktree add`, records it on the row, and the archive's project lookup
    already handles worktree paths. Close offers to remove the worktree.
    Verdict: DEFAULT. Size: M.

23. Collision radar (U39)
    Unicorn: agents negotiate file ownership among themselves.
    Possible: the modified-files rail runs per session; the server diffs the
    sets across sessions on one repo and paints a warning on both rows when
    they overlap. Verdict: DEFAULT once the rail exists. Size: S.

24. Rewind per turn (U40)
    Unicorn: scrub the repo back to any second.
    Possible: on every `Stop` hook, snapshot the working tree with
    `git stash create` (no ref moves) and record the sha on the turn; the
    timeline (Adam's event stream) gets a "restore" per turn. Verdict: PLUGIN.
    Size: M.

25. Shadow writes (U41)
    Unicorn: nothing touches disk until you approve the PR.
    Possible: run the session in a worktree (idea 22) and present its diff as
    a review before `git merge`. Same outcome, no filesystem magic. Verdict:
    PLUGIN. Size: S after worktrees.

### Observability

26. Session-aware quota (U44)
    Unicorn: the app knows which session will hit the wall and when.
    Possible: per-session token rate from transcript usage records (already
    parsed) combined with the account ledger's remaining window; a projection
    on each row: "at this rate, limit in 41 min". Verdict: DEFAULT. Size: M.

27. Account rotation (U45)
    Unicorn: sessions hop accounts mid-turn.
    Possible: a launch-time chooser: the wrapper for a new session is picked
    by remaining headroom across configured accounts (Claude Code Router does
    credential pooling; here it is only at launch, via the wrapper's env).
    Verdict: PLUGIN. Size: M.

28. Context-pressure gauge (U46)
    Unicorn: a fuel gauge on every row.
    Possible: last turn's input tokens against the model's window, rendered as
    a thin bar on the sidebar row and the header. Verdict: DEFAULT. Size: S.

29. Burn-rate alarm (U47)
    Unicorn: predicts a runaway loop before it costs you.
    Possible: tokens per minute per session with a threshold in settings; over
    it raises a toast through the normal channel. Verdict: DEFAULT. Size: S.

30. Bake-off (U56)
    Unicorn: every task runs on every harness and the best wins.
    Possible: launch N sessions (claude, codex, ...) with one prompt into N
    worktrees, show them in the grid, diff the resulting trees, pick one to
    merge. Verdict: PLUGIN. Size: L.

31. Cost per branch (U48)
    Unicorn: a dollar figure on every PR.
    Possible: sessions carry branch (Adam's badge); sum token usage by branch
    and show it in the modified-files rail header. Verdict: PLUGIN. Size: S.

32. Budget guardrails (U49)
    Unicorn: a hard financial fuse.
    Possible: a per-session or per-day token cap; crossing it sends the pane
    an Escape and raises a blocking toast; resume is one click. Verdict:
    DEFAULT. Size: S.

33. Secrets radar (U50)
    Unicorn: nothing credential-shaped ever reaches a screen.
    Possible: the secret detectors in `src/core/message_model_secrets.py`
    already exist; run them on the tail loop's chunks and raise a toast on a
    hit. Masking on screen is the archive's existing mask rule. Verdict:
    DEFAULT. Size: S.

### Swarm control

34. Shared blackboard (U52)
    Unicorn: a hive mind every agent reads.
    Possible: a small MCP server the app ships (`carnivore-mcp`) exposing
    `board.get / board.set / board.list` over a SQLite table, mounted into
    both harnesses via their MCP config. This is also the transport for
    Adam's cross-provider bus. Verdict: DEFAULT. Size: M.

35. Handoff with summary (U53)
    Unicorn: an agent hands its whole mind to another harness.
    Possible: "hand off to..." on a row: the cheap model summarizes the
    transcript tail, a new session of the chosen family launches with that
    summary as its first prompt and the same worktree. Verdict: DEFAULT.
    Size: M.

36. Prompt queue (U54)
    Unicorn: you dictate a day of work and walk away.
    Possible: a per-session queue in the sidecars; on the next `Stop` hook the
    head of the queue is typed through the existing command route. The
    approval inbox (idea 37) shows queued items. Verdict: DEFAULT. Size: S.

37. Approval inbox (U19)
    Unicorn: every yes/no in the fleet on one screen, from anywhere.
    Possible: a panel listing every session with `permission_open`, each with
    the pane's dialog text (the permission-verify capture already reads it)
    and buttons that type `1` or `Esc` into that pane. Verdict: DEFAULT.
    Size: M.

38. Swarm blueprints (U55)
    Unicorn: `carnivore up` and a whole team appears.
    Possible: a YAML in the project (`.carnivore/swarm.yml`) listing sessions
    (family, wrapper, worktree, skills, first prompt); one launchpad action
    creates them all through the existing create route. Verdict: DEFAULT.
    Size: M.

39. Panic button (U57)
    Unicorn: freeze the world.
    Possible: sends Escape to every live pane on the socket, arms a confirm
    first, logs it. Verdict: DEFAULT. Size: S.

40. Session clone with context (U58)
    Unicorn: fork your agent mid-thought into N branches.
    Possible: `--fork-session` already exists in claude; add a worktree and a
    row lineage column so the tree renders under the parent. Verdict: DEFAULT.
    Size: S.

### Understanding and replay

41. Cheap-model summarizer service (U77 foundation)
    Unicorn: a resident mind that has read everything.
    Possible: one internal seam `summarize(text, purpose)` with three backends:
    LM Studio local (Adam runs it, Anthropic-native API), Haiku via API, or
    off. Every "explain" feature in this list calls it. Verdict: DEFAULT
    infrastructure. Size: M.

42. While-you-were-away newscan (U78)
    Unicorn: a briefing waiting when you sit down.
    Possible: on home-screen entry, list every session with activity since
    your last visit and a one-line summary from idea 41. Verdict: DEFAULT.
    Size: S after 41.

43. Time-travel scrub (U79)
    Unicorn: drag a slider, the terminal shows that moment.
    Possible: the transcript archive has per-turn timestamps; the scrollback
    is captured; a slider that jumps the xterm viewport to the scrollback line
    nearest the chosen turn. Verdict: PLUGIN. Size: M.

44. Replay as movie (U80)
    Unicorn: a cinematic of the session with narration.
    Possible: asciicast recording of a session (the tail loop already has the
    bytes) rendered to MP4 for the catalog's theme previews and for sharing.
    Verdict: PLUGIN. Size: M.

45. Integration doors (U69, U70, U73)
    Unicorn: every SaaS on earth in and out.
    Possible: the door-plugin system (idea 19) ships the first doors: GitHub
    issues in, Linear in, Discord and Telegram out, generic webhook out, n8n
    trigger. Each door is a small Python package. Verdict: each PLUGIN, the
    door runtime DEFAULT. Size: S each.

46. Semantic transcript search (U83)
    Unicorn: ask the archive anything.
    Possible: embeddings from a local model into a SQLite table beside the
    message model; the existing archive search gets a "semantic" toggle.
    Verdict: PLUGIN. Size: M.

47. Spectator links (U85)
    Unicorn: anyone can watch, nobody can touch, forever.
    Possible: a read-only viewer token (the viewer fan-out already exists) with
    an expiry, minted per session; the terminal input path refuses it.
    Verdict: DEFAULT. Size: M.

48. Multiplayer cursors (U14)
    Unicorn: pair-driving one agent from two phones.
    Possible: two viewers already stream one session; add a presence frame on
    `/ws/events` (who is attached, who typed last) rendered as a coloured tag
    on the header. Real independent cursors need tmux control mode, which is
    the XL version. Verdict: PLUGIN. Size: S for presence, XL for cursors.

49. Pixel pets, wired (U74, U76)
    Unicorn: a familiar that lives on your screen and does your bidding.
    Possible: a Svelte sprite per session whose animation is the LED state,
    dragged anywhere, summoned by hotkey; the summon opens a search box that
    fans a query across archive search and the running sessions' scrollback.
    Later the search runs through idea 41. Verdict: PLUGIN. Size: M.

50. Hardware and streamer out (U71, U72)
    Unicorn: your room lights show the swarm's mood.
    Possible: a door that publishes the summary LED state to Stream Deck (via
    its websocket plugin API) and to a Home Assistant webhook; an OBS browser
    source overlay is just the wall route at small size. Verdict: PLUGIN.
    Size: S each.

## 5. Adam's 17, fleshed out at the high level

A1 Multi-pane grid.
   Server needs nothing new: N viewers per session already stream. The work is
   turning the terminal singleton into an instance: one `TerminalPane` class
   owning xterm + socket + write queue + reconnect budget + input ownership,
   and a `TerminalGrid` (Svelte, new UI rule) that lays out 1 to 6 panes with
   presets (1, 2 columns, 2x2, 3 columns, 1+2). One pane is "focused" and
   receives keyboard; the others are live. Each pane resizes its own tmux pane
   through the negotiator (smallest-wins already handles a phone and a desktop
   on one session). Phone gets a 1x1 with swipe. Size XL, DEFAULT. This is the
   prerequisite for ideas 13 and 30.

A2 Notifications crying wolf.
   Root cause hypothesis (must be verified, not assumed): the gate reads
   `subagent_depth`, which is fed by unordered hooks, so a `SubagentStop` that
   lands before its `SubagentStart` floors the depth at 0 and the `Stop` toast
   fires. Fix shape: a second evidence source, the pane text "Waiting for N
   background agents", read through the same capture-and-verify path the
   permission flag uses, and "digest mode" (idea 17 style) so non-blocking
   events never interrupt. Carve this out as an immediate bug ticket, separate
   from the roadmap. Size M, DEFAULT.

A3 Skills catalog.
   Format: agentskills.io SKILL.md, portable subset only, so one folder installs
   into `.claude/skills/` AND `.agents/skills/` (Codex) with a symlink or copy.
   Catalog backend: a git repository per namespace plus an index JSON (the
   Homebrew tap / Claude marketplace.json shape), served by a small hosted
   service Adam runs (needed for ratings, reviews, telemetry, signing keys).
   Client: a Svelte catalog screen with card (title, brief, description, icon,
   hero, rating, reviews, version, publisher tier, doctor grade, install
   count). Install scopes: global, project, one-shot (inject into the pane as a
   prompt with the skill body). Updates: the index carries versions; installed
   items are pinned by digest; "updates available" badge; auto-update opt-in
   per item. Anyone can publish under their handle; suggest-update is a PR.
   Plug-n-play with Claude Code and Codex; OpenClaw / Hermes adapters later.
   Size XL, DEFAULT (the catalog client) plus hosted service.

A4 Modified files since last commit.
   A per-session `git status --porcelain` read in the listing gather thread
   (off the event loop, like the other readers), throttled to 10s and only for
   sessions whose working dir is a repo. Rendered as a rail beside the terminal
   (Svelte), click opens the diff in the existing drawer. Size M, DEFAULT.

A5 Live models, tokens, agents, context, provider accounts.
   Two halves. Per session: model and last-turn usage from the transcript tail
   (the tail reader exists), context pressure, tokens per minute. Per account:
   a ledger of provider accounts (Claude Max x3, Codex) with usage windows and
   reset times; the sources are the same the CLI usage tools scrape (the
   OAuth usage endpoint for Claude, ChatGPT's for Codex), credentials stored in
   config.json behind the existing atomic writer. A dashboard screen with a
   swarm total line. Size L, DEFAULT.

A6 Cross-provider bus.
   Transport: the app ships an MCP server both harnesses mount, exposing
   `send(@handle, text)`, `inbox()`, `board.*`. Addressing by session handle
   (idea 5). Delivery: the message lands in a SQLite inbox AND, if the target
   is idle, is typed into its pane through the command route as
   `@from: text`; if it is working, it waits for the next Stop (prompt queue).
   Humans use the same bus from the UI. Size L, DEFAULT.

A7 Full TUI.
   Python Textual in this repo (same language, same API client, same tests),
   or Go Bubble Tea as a separate binary. Screens: session list with LEDs,
   attach (delegates to `tmux attach` on the cloude socket), catalog browser,
   account ledger, approval inbox. Single-key command deck from the BBS
   research. Size L, DEFAULT.

A8 iOS / Android.
   iOS: the SwiftTerm plan in `IOS_APP_PLAN.md`; Android later via the same
   API. VPN: a built-in WireGuard or Tailscale-auth profile is the "dedicated
   tunnel"; the E2EE relay (idea 63 territory) is the no-VPN path. Size XL,
   DEFAULT.

A9 Desktop apps.
   macOS exists (Electron menubar). Windows and Linux: same Electron project
   with a server-manager per platform, or Tauri if size matters. Size L,
   DEFAULT.

A10 Remote tmux hosts.
   A `hosts` table (name, ssh target, socket) and a `RemoteTmuxBackend` that
   runs every tmux command through `ssh host tmux -L cloude ...` with a
   persistent ControlMaster; the pipe-pane tail streams over the same ssh.
   Sessions carry a host dimension (the archive already has one). Discovery
   over the tailnet by mDNS is the war-dialer. Size XL, DEFAULT.

A11 herdr.dev-level integrations.
   Delivered as doors (idea 19 / 45). First set: GitHub, GitLab, Linear, Jira,
   Discord, Telegram, Slack (exists), ntfy (exists), Pushover (exists), generic
   webhook, n8n, Home Assistant, email. Each a small Python package with a
   manifest; listed in the plugins catalog.

A12 Themes catalog.
   Same catalog mechanics as skills. Screenshots: captured automatically at
   publish by the headless-Chromium harness the repo already uses for LED
   geometry, three surfaces (home, terminal, sidebar), plus an optional
   asciicast preview. Manifest gains `screenshots` and `preview`. Size L on top
   of the catalog core.

A13 Pixel pets.
   Idea 49. Cosmetic first (sprite + LED state + hotkey), agent second.

A14 OpenClaw / Hermes.
   Treat each as an agent family with a wrapper, a fingerprint, a hook adapter
   (their event model mapped onto the eight hook events), and a skill-install
   target in the catalog. Size M each, PLUGIN.

A15 Repo and branch in the header.
   Read `git rev-parse --abbrev-ref HEAD` and the remote name in the same
   gather thread as A4; render as a chip beside the session name. Size S,
   DEFAULT.

A16 Event-stream timeline.
   Source: the transcript JSONL already ingested into the archive, per turn:
   timestamp, duration, tokens, tool calls, files touched. Summaries from the
   cheap-model seam (idea 41), colour-coded by activity kind, rendered as a
   vertical timeline beside the terminal (Svelte), with jump-to-turn. Size L,
   DEFAULT with the summarizer optional.

A17 Plugins catalog.
   Two kinds and the doc must say so: browser plugins are build-time (CSP), so
   third-party browser plugins ship only by being merged into the repo and
   released; server doors (idea 19) are the installable kind. The catalog
   lists both; "install" for a browser plugin means "enable" (already built),
   for a door means download + digest + consent + boot.

## 6. Defaults versus plugins: the rule

Proposed rule of thumb, to be confirmed by Adam:
- DEFAULT: anything needed to drive, see, or protect a session (grid, LEDs,
  notifications, approvals, quota, secrets, panic, bus, worktrees, catalog
  client, summarizer seam, door runtime).
- PLUGIN: anything opinionated, aesthetic, or that talks to a third party
  (integrations, pets, wall, reactive themes, replay, arena, hardware).
- The brand layer (BBS front door, tiers, handles) is DEFAULT because it is
  the product's identity, but every sound and animation in it is switchable.

## 7. Decisions locked (Adam, 2026-09-12 and 2026-09-13)

- Brand: the product is Carnivore.ai. Every INTERNAL name stays `cloude`
  (socket, prefix, db, bundle id, env vars) per CLAUDE.md; the catalog,
  the MCP server, the project directory (`.carnivore/`) and all new
  user-facing copy use Carnivore.
- Catalog: items live in git repositories per namespace (fork-PR model),
  plus a hosted API for ratings, reviews, telemetry, signing keys and the
  index. Hosting is AWS Amplify (Amplify Hosting for the web front, Lambda
  functions behind it, DynamoDB for the small tables), on the carnivore.ai
  domain Adam owns. Cheap and easy is the brief. Lambda deploy scripts live
  in each lambda's folder per Adam's global rules.
- Trust: signed publishers from day one. Keypair per publisher, every item
  signed, the client refuses unsigned or mismatched items, revocation list
  pulled with the index.
- Cheap-model seam: the USER picks the provider in settings: local
  (LM Studio, which speaks the Anthropic API natively), Anthropic API,
  OpenAI API, or off. Every explain / summarize / timeline feature calls
  the one seam and never a provider directly.
- TUI: Python Textual, in this repo, sharing the API client and tests.
- Mobile: native iOS first via the SwiftTerm plan in `IOS_APP_PLAN.md`.
  Android after, on the same API.
- Provider accounts: each account's OAuth token stored in config.json
  behind the atomic writer, refused by the settings import by name, masked
  everywhere, polled against the same usage endpoints the CLI usage tools
  use.
- Remote hosts, three stages in order: SSH per host (a RemoteTmuxBackend
  over a persistent ssh ControlMaster, nothing installed on the far box);
  then federation, every box runs Carnivore and the home server aggregates
  them; then an E2EE relay so a phone works with no VPN. Herdr 0.9's shape
  (client renders the shell, servers own sessions) confirms the split; its
  "move a session between machines" idea joins the unicorn list as U91.
- Defaults versus plugins: the section 6 rule is CONFIRMED and applied as
  written to all 67 items.
- The sub-agent crying-wolf notification problem stays in the roadmap as
  A2; it is not carved out as a separate immediate fix.
- Deliverable: `docs/ROADMAP.md` committed to the repo with a row in the
  CLAUDE.md docs table.

## 8. Roadmap

Tier 1, Adam's picks, three independent tracks that can run in parallel:
- Track A, client: A1 multi-pane grid. Terminal singleton becomes an
  instance; Svelte grid; presets. XL. Unlocks 13 and 30.
- Track B, backend: A5 usage and accounts dashboard. Per-session model,
  tokens, context pressure; account ledger with windows and resets; the
  session-aware quota projection (26) and the context gauge (28) ship with
  it. L.
- Track C, catalog: A3 skills catalog. Amplify API, signed publishers (9),
  skill-doctor grade (10), fork-PR updates (12), tiers (3), kudos (20),
  cross-harness install into `.claude/skills/` and `.agents/skills/`. XL.
  The themes catalog (A12) and the plugins catalog (A17) reuse this core.

Tier 2, Adam's picks, sequenced by dependency:
- Cheap-model seam (41) first, because the timeline, newscan, handoff and
  explain features all call it. Then A16 event timeline and 42 newscan. L.
- Git awareness: A15 branch chip and A4 modified-files rail together (one
  gather-thread read), then 21 diff drawer, 22 worktree per session, 23
  collision radar. M.
- Cross-provider bus: 34 blackboard MCP server first (it is the transport),
  then A6 addressing and delivery, 36 prompt queue, 35 handoff. L.
- BBS front door (1), handles (5), tiers (3). The tiers need the catalog
  service from Track C for their evidence. M.

Tier 3, everything else, in dependency order:
- Door runtime (19), then the integration doors (45, A11) and hardware out
  (50).
- Approval inbox (37) and A2 notifications, together, because both read
  the pane's dialog text.
- Themes catalog (A12) with auto screenshots, on the catalog core.
- Bake-off (30) and skill A/B (13), after the grid and worktrees.
- Budget guardrails (32), burn-rate alarm (29), secrets radar (33),
  panic button (39): small, ship whenever a backend agent has a slot.
- TUI (A7), then remote hosts stage one (A10 SSH), then iOS (A8), then
  desktop for Windows and Linux (A9).
- Remote stages two and three (federation, E2EE relay).
- Pets (49), wall (8), reactive themes (17), theme-from-image (16),
  replay (44), scrub (43), semantic search (46), spectator links (47),
  presence (48), OpenClaw and Hermes families (A14).

Unicorn ideas not in the top 50 stay in section 3 as the backlog.
