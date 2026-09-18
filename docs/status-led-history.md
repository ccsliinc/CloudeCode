# The status lights: the full model, the owner rulings and the measurements

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## The status lights, and what they are allowed to claim

Full model in `docs/session-status.md`. The eight states are `working`,
`working_subagent`, `question`, `notice`, `finished_unread`, `idle`,
`dead` and `unknown`. `UserPromptSubmit`/`PreToolUse`/`PostToolUse` move to
`working`; `SubagentStart` with no matching `SubagentStop` to
`working_subagent`; `PermissionRequest` to `question` and `Notification`
to `notice`; `Stop` to `finished_unread` while unread, `idle` once seen;
tmux's `#{pane_dead}` to `dead`; everything else is `unknown`, which is a
real answer and never `idle`.

**FIVE COLOURS ON ONE LIGHT, AND THE ENVELOPE IS GONE.** The owner's
rule, 2026-09-08, verbatim: "if the session is fully stopped waiting for
a response, then yellow. if it's still working but needs something from
me, make it light blue", over "red if the connection is disconnected,
grey if the session is idle, green if there is activity", plus "finished
turn waiting on me to look at should be a green outline and grey filled
dot". GREEN is `working` / `working_subagent`. YELLOW is `question` AND
the startup gate's `awaiting_startup_prompt` - both are fully stopped and
the user's answer to both is the same. LIGHT BLUE is `notice` alone, the
only state that is working AND asking for you. GREY is `idle` and
`unknown`, told apart by SHAPE (`unknown` is drawn hollow) rather
than by a louder colour. RED is `dead` and a dropped WebSocket. And
`finished_unread` is a crisp green ring around a CLEARED centre. THE
EIGHT INNER STATE NAMES STAY EIGHT - only the paint collapses onto five
hues, because the accessible label still has to say which state it is and
colour was never allowed to be the only signal.

**THE GREY FILL IN THAT RING WAS WITHDRAWN, and the two hollow lights now
share one recipe.** Shipped, the ring put a mid-grey `done` dot inside the
green band and it read as two lights stacked. The owner's 2026-09-09
correction, verbatim: "it should look like the 'status not measured' dot,
but the outline should be green instead of light grey with the dark grey
center". So `--led-fill: transparent` is declared in ONE rule naming both
`[data-inner='unknown']` and `[data-outer='unread']`, and the dot's
`background` reads that token rather than `--led-ink`. Two copies of
"clear the middle" would drift into one state showing the real background
and the other showing a grey somebody picked, so the count of that
declaration is asserted. Note the trap the token also closes: the legacy
`.status-dot.status-led` compat block outranks `[data-outer='unread']` and
sits later in the file, so a `background: var(--led-ink)` there silently
refills both hollow states on every surface. CLEARING A FILL MOVES PAINT,
NOT GEOMETRY - measured at 8x device scale before and after, all nine
(inner, outer) pairs painted an IDENTICAL extent to the hundredth of a
pixel, so `--led-lit-scale` is untouched.

**THE KEY IS SEVEN ROWS, ONE PER LIGHT, NOT ONE PER STATE.** It carried
nine and the owner asked for "one entry per colour": two rows showed the
same yellow and two the same red, which sends a reader looking up a dot
hunting for a difference the light cannot show them. Yellow is now
"stopped, waiting on you", red is "dead / disconnected session", and green
and grey each appear twice ONLY because a solid dot and an outline are two
different things on screen. THE STATE MACHINE DID NOT CHANGE: the four
collapsed states still exist and the dot's own `title` / `aria-label`
still say which of each pair it is, which makes those labels load-bearing
rather than decorative. `tests/test_status_key.node.mjs` pins the count,
that every hue has a row, that no two rows draw the same light, and that
the collapsed pairs resolve to one colour in the STYLESHEET while their
words still differ.

The unread ENVELOPE ICON went with it, from the sidebar row menu and the
launchpad card. It was also the manual mark-unread control, so its click
and keyboard handlers went too. Unread TRACKING is untouched: `Stop` still
sets it, a WS terminal binding still clears it, `src/core/unread_store.py`
still keys on the instance, and `PATCH /sessions/{name}/unread` still
exists with nothing in the UI calling it. The green ring is the only thing
saying it now, which is why it is drawn as a REAL RING - transparent
centre, 2.5px inset band - and not as the blurred wash every other halo
wears. THE FILL WAS THE TRAP: the halo pseudo-element paints ABOVE the
element background, which IS the dot, so an opaque disc renders
`finished_unread` as a solid green blob with no grey in it. Measured in a
6x render before it shipped.

**ONE LIT DIAMETER FOR EVERY STATE, and the element box was never the
thing that varied.** Measured 2026-09-09, all forty (inner, outer) pairs
reported a 9.0px ELEMENT box - which is exactly why 190 green suites had
never caught what the owner could see. The HALO was sized per state and
drawn partly OUTSIDE its own box by a spread `box-shadow`, so the lit
object came out at three diameters: about 14.7px for `active`, 15.3px for
`unread` (that block set its own scale), and an invisible halo for every
resting state, which therefore reads at the bare 9px dot. One working
session in a column of quiet ones read about 60 percent wider than its
neighbours. `--led-lit-scale` is now declared ONCE on `.status-led` and
overridden by no state, and the glow is a RADIAL GRADIENT rather than a
spread shadow - a gradient fades out AT the box edge, so the halo's
painted extent IS its declared box and can be held to a number; a spread
shadow paints beyond the element by definition and never could.
`scripts/archive/verify/verify_status_led_geometry.py` measures the whole
matrix in a
real Chromium across three themes and two viewports, because the
divergence was in what the box RESOLVES to once a per-state override and
a pseudo-element's own shadow are composed, and no CSS read composes
those.

**THE GROUP HEADER'S ROLL-UP IS THE ROW COMPONENT, and its yellow `(n)`
badge is gone** (2026-09-09, "to be clear remove the yello (1)").
`session-status-summary.js` folds the children to an (inner, outer) pair
and hands it to `StatusLed.ledHtml`, so a header takes the finished-turn
ring exactly as a row does. Nothing replaced the count: the ring already
says there is something in here for you, and two indicators for one fact
is how they come to disagree. The plain count pill saying how many
conversations a folded section hides is a DIFFERENT control and stays.

**THE LIGHTS FINALLY HAVE WORDS**, in `client/js/session-status-key.js` -
a foldable legend at the foot of the sidebar, collapsed by default on
`cloude.statusKey.open`. Every swatch is a real `ledHtml`, never a
drawing of one, so the legend cannot show a colour the app does not
paint. It replaced the "N remembered positions are held for sessions not
currently listed" note, which named bookkeeping no reader could act on;
the remembered slots themselves are untouched and still stamped on the
list element as `data-order-missing`.

**BELOW THE KEY SITS THE APP'S OWN VERSION, ONE COMPONENT FOR BOTH
PLACEMENTS IT APPEARS IN.** `client/js/version-footer.js` renders a
small grey `<span class="version">` and both surfaces call it: the
sidebar footer (right after the status key, its own `.version-footer`
block) and the home screen's bottom bar chip
(`renderHomeBarVersion()` in `web/src/lib/launchpad/home-chrome.ts` since
slice 7, which only owns a mount point). It reads `<meta name="cloude-app-version">`, stamped once at
serve time by `src/main.py` from the SAME resolver `GET /api/v1/version`
calls (`src/core/version.py::resolve_version()`) - not a second fetch of
that endpoint, because the value cannot change while the page is open
and the Electron tray already polls that endpoint every 20 seconds for
its own reason. **AN UNRESOLVED VERSION RENDERS `"version unknown"`, NOT
A BLANK CHIP.** Before this file existed, an empty meta tag made the
home bar's chip vanish (`.home-bar__version:empty { display: none }`,
now removed) - which read as a missing control, not as "the build could
not be determined", and defeated the one thing a version footer is for.

**A DROPPED SOCKET IS THE ONE SIGNAL THE SERVER CANNOT REPORT**, so it
lives in `client/js/session-transport.js`, written from `terminal.js`'s
`ws.onopen` / `ws.onclose` and read by the sidebar rows and the launchpad
cards on their way into `dotHtml`. This browser holds a socket to at most
ONE session, so **every other session answers `unknown`** - a sidebar full
of red because one socket dropped would be the fabricated-measurement
mistake this whole model exists to avoid. A DELIBERATE close CLEARS the
record rather than marking it disconnected. `dead` and `disconnected`
share the red, so the LABEL is the only thing separating them and the two
must never be paraphrases: "dead - the process exited" against
"disconnected - no live connection to this session".

**`question` AND `notice` ARE TWO STATES BECAUSE A PERMISSION PROMPT
STOPS THE AGENT AND A NOTIFICATION DOES NOT.** They were one state named
`question` until 2026-09-08. A `PermissionRequest` halts claude mid-turn
until a human answers a yes/no; a `Notification` is claude asking to be
looked at while nothing is blocked. Collapsed, a chatty session painted
exactly like a parked one, so the state that most needed acting on
stopped standing out - the false-urgency twin of this project's
false-green problem. They are TWO INDEPENDENT BOOLEANS,
`permission_open` and `notice_open`, not one field with three values:
hooks arrive unordered and duplicated, so a `Notification` landing either
side of the `PermissionRequest` it accompanies must not be able to move
the blocking claim. `permission_open` is read first, so a session holding
both answers `question`. Both are cleared by the same three events
(`UserPromptSubmit`, `PreToolUse`, `Stop`) because what resolves either
is the user showing up. On the LED the split is now VISIBLE rather than
only recorded: `question` is inner `waiting-permission` and paints yellow
with the startup gate, `notice` is its own inner state and paints light
blue. Light blue over a third warm hue because the pair has to survive
red-green colourblindness - under protanopia and deuteranopia the green
desaturates toward a pale khaki while a blue at this wavelength stays
plainly blue. Summary priority for the header's INNER dot is
**permission > input > working > unread > done > dead > unknown**, and
`notice` still buckets as `input` - the colour split is a rendering
decision on the ROW, not a re-ranking. The `done` bucket means "finished
and already read" and renders the grey `idle` dot. The header's RING is
NOT looked up on the winning bucket: it is folded separately, from
activity across the whole group, so a group holding one parked session
and one busy one paints the parked dot inside a breathing ring rather
than hiding the work behind the more urgent light.

**A SESSION WAITING ON ITS OWN SUB-AGENTS IS NOT WAITING ON THE USER, AND
NEITHER `Stop` NOR `Notification` MAY SAY IT IS.** claude fires `Stop`
when the MAIN turn ends whether or not the background agents it launched
are still running, and it raises a `Notification` in that same state, so
a pane reading "Waiting for 2 background agents to finish" was raising
both a "Your turn" and a "wants your attention" card. That is the
false-urgency twin of the `question`/`notice` fold above: a summons to a
session that wants nothing. The gate is one condition in
`claude_event_hook` (`src/api/routes.py`) reading
`SessionManager.subagent_depth`, a passthrough to the count
`SessionActivityTracker` already keeps for `working_subagent`; nothing new
is stored and the state machine is untouched, so a suppressed `Stop`
still flips unread and still resolves its status. Only the interruption
is skipped.

**IT REFUSES TO RAISE; `toast_auto_ack.py` ANSWERS WHAT WAS RAISED. THE
TWO CANNOT DOUBLE-CLEAR.** They are on opposite sides of the same
handler and touch different state. The gate is a pure read of
`subagent_depth` taken BEFORE `record_hook_event`, and its only effect is
to skip the `raise_toast` call for `Stop` and `Notification` - it clears
nothing, acks nothing and writes nothing. `auto_ack_toasts` runs after
the event is recorded and only ever moves an ALREADY OPEN toast to
`answered`, keyed by KIND and bounded by the event's own instant. A toast
the gate suppressed was never opened, so there is nothing for the ack to
find; a toast the gate allowed is acked exactly once, by the same
kind-keyed rule that survives a duplicate or a reorder. Order is what
makes that safe and it is deliberate: ack what is open first, then decide
whether to raise.

**`PermissionRequest` IS NEVER SUPPRESSED, AT ANY DEPTH**, because it is
a HARD BLOCK - claude has stopped mid-turn and cannot continue until a
human answers - which is the one case where a busy session genuinely is
waiting on the user. That is the whole exception, and it is the negative
control the tests turn on: a suppression rule that quietly grew to cover
it would pass every positive test and strand claude behind a yes/no
nobody was told about.

**THE DEPTH IS READ BEFORE THE EVENT IS APPLIED, and that ordering is the
whole mechanism.** `Stop` RESETS `subagent_depth` to 0, so a gate reading
the count afterwards answers 0 every time and can never fire. It also
cannot be built on `SubagentStop`, which on a turn with no subagent in it
arrives about 1.5s AFTER the `Stop` (the punchlist 4 measurement above) -
an event that has not landed yet can neither confirm nor deny anything.
And it FAILS TOWARD NOTIFYING: an unknown session, a dropped
`SubagentStart`, or a read that threw all leave the count at 0 and the
toast is raised exactly as before. Silence is bought only with a POSITIVE
count, because a missed "your turn" is a worse failure than a spurious
one.

**THAT SAME FOLD NOW PICKS THE ONE TOAST CARD A SESSION GETS.** The toast
stack coalesced on (kind, session) until 2026-09-09, so one session
produced one card per kind - a "wants your attention" card AND a "Your
turn" card, about the same session; four cards for two sessions, measured.
`client/js/toast.js` keys the group on the SESSION alone, and
`client/js/toast-session-group.js` READS `SUMMARY_PRIORITY` out of
`session-status-summary.js` to pick which pending event that card shows.
It declares only the join from a hook event name to a bucket -
`PermissionRequest` to `permission`, `StartupPrompt` and `Notification`
to `input`, `Stop` to `unread`, anything unrecognised to `input` (the
same refusal-to-assume-harmless as `SEVERITY_DEFAULT`) - with toast.js's
own severity breaking a tie INSIDE a bucket so a blocking startup prompt
is not displaced by chatter. THERE IS NO SECOND RANKING; if the fold is
unavailable the module groups NOTHING rather than inventing one. The
pick is a pure FOLD over what is held, which is what makes the card
upgrade in place, refuse to downgrade, and survive the same hook event
twice. The `xn` badge counts the WINNER'S KIND, never the session's pile
- it sits beside the winner's title and would otherwise put a 7 next to a
sentence that happened once - while the dismiss control, the "Dismiss
all" disclosure and the overflow row all count RECORDS. The attachment
receipt (`client/js/attachment-toast.js`) is deliberately outside this
grouping: no server record, retired by the prompt being SENT, so it keeps
a card of its own. Full model in `docs/session-status.md`.

**A CLOSING HOOK EVENT IS NOT A HEARTBEAT ON ITS OWN, and that was
punchlist 4.** Measured twice by `tests/test_led_real_hooks.py` on claude
2.1.265: on a turn with NO SUBAGENT IN IT, `SubagentStop` arrives about
1.5s AFTER `Stop`. `Stop` had just cleared `last_tool_event_ts` to say the
turn was over, `record_event` stamped it again, and a finished session
painted `working` for the full 120s - `finished_unread` lasted a second
and a half and `idle` was UNREACHABLE. The rule now: an event that CLOSES
something stamps only when something was open for it to close.
**`SubagentStop` NEVER STAMPS the heartbeat: it says work ENDED, so the
only thing it moves is `subagent_depth`, and it moves that with the floor
at 0.** It first shipped gated on `subagent_depth > 0` instead, and THE
GATE IS NOT THE CLAIM IT STANDS FOR - a duplicated `SubagentStart`
delivered after `Stop` raises the depth off the floor by itself, so the
duplicated `SubagentStop` behind it passed the gate and stamped, at its
own arrival time, ratcheting the expiry out on every further pair.
`PostToolUse` cannot take a blanket refusal (it is the only event some
legitimate turns emit late), so it keys on a `turn_open` boolean that
every OPENING event sets and `Stop` clears, and is refused ONLY when a
`Stop` was POSITIVELY seen and nothing has opened since - never having
seen a `Stop` is not evidence the turn ended. Opening events still stamp
unconditionally, so a stray `SubagentStart` after `Stop` still buys ONE
bounded window keyed on itself; what no `SubagentStop` can do is extend
it.

**A DEAD PANE DROPS OFF THE LIVE LIST AND BELONGS IN RECENT.** The
owner's call, verbatim 2026-09-08: "they go into recent, they can
disappear." A session whose process died has stopped, so its row leaves
`GET /sessions/list` rather than lingering there wearing a dead light,
and a restart from Recent is a resume. `dead`/`off` stays in the LED
vocabulary but is GALLERY-ONLY - no live endpoint is meant to carry a
dead row to the client. A round that read the same measurement as a bug
and made a husk KEEP its row, painted dead, was overruled and reverted
(`ba2aa5d`), and `tests/test_led_real_hooks.py` holds the line against a
real killed pane. CLOSED 2026-09-10: `remain-on-exit` keeps the husk's
tmux session in the listing, and `session_lifecycle` reaps on ABSENCE
from that listing, so the row used to leave the live list without ever
arriving in Recent. `src/core/session_pane_death.py` is the second reaper
rung, keyed on a MEASURED `#{pane_dead}` of exactly `"1"` read out of the
COMPLETE `list-panes -a` the launcher pass already pays for, on the
socket the reconcile is about, for a row whose creation epoch matches -
no listing, a partial one, a socket mismatch, an unreadable field or a
re-minted name all answer `unknown` and reap nothing, because refusing is
free and one wrong reap costs a live session. It ADDS NO TMUX CALL: the
pane probe was already being taken a few lines below and is simply taken
before the reaper instead. It writes the SAME FOUR COLUMNS as the absence
rung and differs only in `lifecycle_source`, which is `pane_dead` rather
than `tmux_missing`. STILL OPEN: the tmux HUSK is deliberately NOT
killed, so the dead session keeps its name and the next session for that
project is still uniquified to `<name>-2`; freeing the name means killing
a tmux session, which needs the owner's explicit yes.

**A VIEW CLEARS AN OPEN `permission`, AND AN OPEN ONE IS VERIFIED
AGAINST THE PANE AFTER 20 SECONDS.** Measured 2026-09-09,
`cloude_Media_Compression` painted `question` over a pane holding no
dialog because the flag was set on `ses_949a8585` while the claude in
that pane posts its spawn-time `adopted:cloude_Media_Compression`, so
every clearing hook landed on a different tracker key and nothing
reachable could retire it; the toast path already remaps that split and
the activity tracker does not. So `session_view_clears` now clears
`permission_open` too, and while the flag is open past
`PERMISSION_TAIL_GRACE_SECONDS` the listing pass takes ONE `capture-pane`
and clears it when claude's dialog is not on screen - marker present
keeps, marker absent clears and logs `permission_flag_cleared_no_dialog`,
an UNREADABLE tail keeps, and the markers were read off two real dialogs
(`Do you want to ...?`, `❯ 1. Yes`, `Esc to cancel · Tab to amend`)
rather than guessed. See `src/core/session_permission_verify{,_apply}.py`.

**AND A PANE THAT IS GONE CLEARS IT TOO, BUT ONLY ON A READING THAT
ACTUALLY HAPPENED.** A claim left open at the instant its pane died could
never be retired - no `capture-pane` can run against a corpse - so
`_session_info_for`'s `LIVENESS_GONE` arm clears it with no capture at
all, on the way to dropping the row. The trap is that
`resolve_listing_liveness` answers `gone` by TWO roads and only one is a
measurement: a COMPLETE listing from the backend's OWN socket naming the
session and reporting `#{pane_dead}` dead, or a falsy `exists`, which for
tmux came from `is_alive()` and therefore returns the same False for "no
such session" as for "tmux is missing, timed out, or errored". Only the
first passes `pane_alive=False`; the second passes `None`, which the seam
treats as no reading and which KEEPS the flag. The asymmetry is not
fussiness: the dropped row beside it self-heals on the very next poll,
while a cleared flag is reopened by nothing short of a brand new
`PermissionRequest`, so one timed-out probe would silently retire a
dialog the user never answered. `session_pane_death.pane_death` states
the same discipline for the REAPER and is deliberately not reused here,
because it requires the STORED row's `tmux_created_epoch` and this pass
holds no trustworthy one; `listing_proves_alive`, already computed on the
line above for `exists`, is the rule that IS reused.

**A tmux `running` pane maps to `unknown`, NOT `working`.** It means only
"the foreground command is not a bare shell", which is equally true of an
agent mid-tool-call and one at an empty prompt, and the fallback carries no
timestamp so nothing could expire the claim. Measured 2026-09-08: 15 of 19
live sessions report a claude VERSION STRING as `pane_current_command`, so
that branch is the common case and all 15 were reporting a permanent
`working` on no evidence. Hook-fed `working` still expires after 120s.

**AND THAT LEFT `unknown` AS THE COMMON READING, SO A RESTING CLAUDE IS NOW
SEEDED FROM EVIDENCE THAT OUTLIVES THE PROCESS.** `SessionActivityTracker` is
in-memory and nothing hydrated it, so a restart left every session on the
tmux tier: measured on live 2026-09-08 22:24Z, 19 live panes and 15 painting
`unknown`. Ten had NEVER fired a hook and never will - hand-started without
the hook env, last assistant turns dated 2026-07-16 and 2026-08-24, alive at
an idle prompt for weeks. `src/core/session_status_seed.py` is the ladder
(records in `_records`, cache in `_store`, the two reads and the seam in
`_read`): rung A is `sessions.activity_state` judged by
`activity_persist.restore_state` and read on the FULL INSTANCE TRIPLE, the
same WHERE clause `write_state` writes on, because a name-scoped read answers
for whichever epoch sorts newest; rung B is the last decidable record of the
bound transcript, walked BACKWARDS through the one bounded reader
(`claude_title_sync.read_tail_records`, now extracted so there is exactly
one) so the newest evidence wins. **IT MAY CLAIM REST AND MAY NEVER CLAIM
`working`**: a file carries no heartbeat, so a `working` seeded from one
could never be expired - the identical defect the paragraph above just fixed,
one tier down. A sidechain `end_turn` is UNDECIDABLE (a subagent finishing
inside a live turn), and so is a slash-command envelope, which is what the
measurement forced: claude intercepts `/rename` before it becomes a prompt
but still writes a pseudo-`user` record about it, and reading those as
prompts pinned the only two sessions the ladder refused at in-flight while
both sat at an empty prompt. Wired at the boot re-adopt, after
`POST /sessions/adopt`, and at ONE seam in `_session_info_for` reached only
while the answer is still `unknown` on a pane measured LIVE, so a seed can
add an answer and never overwrite a measured one. A hook retires it
instantly (the seam is gated on `hooks_seen`), which is also what makes it
idempotent - a seed is a cached READING, not an event. Read-only against the
live DB and the real corpus before shipping: **all 15 unknowns would read
`idle`**, every one via rung B, 0.27 ms median each. The negative control is
separate and load-bearing, because a matcher that always finds something is
worse than useless: over 400 sampled transcripts it splits 172 `at_rest` / 70
`in_flight` / 158 `no_marker`. Full model in `docs/session-status.md`.

**AND A HOOKLESS SESSION NOW READS ITS OWN TRANSCRIPT FOR WORK, because an
mtime is a TIMESTAMP and the objection above was about a RECORD** - measured
2026-09-09, only 6 of 19 live sessions had ever fired a hook, and three of
the other thirteen had touched their transcript inside 36 minutes while
painting the same rest as ones last touched in July;
`src/core/session_transcript_status{,_read}.py` is rung 0 of the same ladder
(mtime inside `WORKING_HEARTBEAT_TIMEOUT_SECONDS` -> `working`, carrying an
`expires_at` that `display_state` enforces so the 60s seed cache cannot
stretch it; a turn end NEWER than the one its instance-keyed ledger already
holds -> `finished_unread` plus ONE auto-unread claim, where FIRST SIGHT IS A
BASELINE so a restart never re-lights the fleet), gated on `hooks_seen` and
NOT on the hook token store, which holds 33 entries for 19 live sessions
including every adopted pane. **A VIEW NOW CLEARS AN OPEN `notice` AND NEVER
AN OPEN `permission`** (`src/core/session_view_clears.py`, reached from the
WS bind and from mark-read): a `Notification` is a message to the user and
survived a 46-minute visit on BHPP, while a `PermissionRequest` is a blocking
fact about the agent that looking at does not answer. `status_source`
(`hook` / `transcript` / `seed_row` / `tmux` / `none`,
`src/core/session_status_source.py`) rides the `/sessions/list` wrapper and
renders in the TOOLTIP ONLY, and `client/js/session-header-led.js` finally
puts the same LED beside the session name in the terminal header.

**Unread is keyed on the INSTANCE**, `<tmux_name>@<#{session_created}>`,
because a name is reused and a flag from a killed session reappeared on its
successor. Set on `Stop` and by the user's control, cleared when a WS
terminal binds. An unmeasurable epoch degrades to the legacy name key.
**THE EPOCH HAS ONE SOURCE, `src/core/unread_identity.py`, AND IT IS THE
LIVE TMUX LISTING** - set, clear and read all reach it through
`SessionManager._unread_epoch`, because two derivations for one key are
two keys the moment they disagree and a clear on a key nobody wrote can
never be undone by clicking. It refuses the DB row's recorded epoch and
the session_id-keyed `_instance_epochs` alike; its name-keyed cache is a
memo of the tmux measurement, refreshed by every listing.
**AND THE CLEAR ONLY HAPPENS IF A SOCKET ACTUALLY OPENS.** Measured
2026-09-09: a session entered in a BACKGROUNDED tab opened none, because
`waitForFontsAndLayout` ended on bare `requestAnimationFrame` awaits that
a browser never runs for an unpainted tab, suspending
`connectWebSocket()` before `openWebSocket()`. No socket means no
`onclose`, so no reconnect rung fires either: the terminal sat on
"Connecting to terminal..." for 35 minutes and resumed the instant the
tab was painted. THERE WERE THREE such waits, not one - the sidebar
rejoin and the adopt path each carry their own, ABOVE what was then a
`setTimeout(..., 500)` scheduling the connect (that delay is gone; see
"The connect is measured, not slept" below), so fixing only the first
changed nothing and only a live re-check found that. A FOURTH was found
in `launchpad.js`'s `_returnToActiveRunningSession` and closed the same
way; the session fetch and the terminal entry both sit below it.
`client/js/terminal-layout-wait.js` races every wait against a timer - a
layout wait may DELAY a connect, never CANCEL one - and
`tests/test_terminal_layout_wait.node.mjs` fails the build if a bare rAF
await reappears in `terminal.js`.

**IT IS ONE FLAG, AND EVERY WRITER AND READER MUST MEASURE THE EPOCH.**
The owner's rule, verbatim: "when clicking a tab, the session is marked
read. if i want it unread i click unread." So `auto` and `manual` are two
writers of one state: opening the tab clears BOTH (it used to spare
`manual`), and so does clearing the control, through `UnreadStore.clear`.
Both writers now resolve a measured epoch and `/sessions/list` reads with
the `created_at_epoch` on its own bulk tmux probe rather than the
`_instance_epochs` cache, which is EMPTY for every session predating the
process and composed the legacy bare-name key - so a flag written under
the instance key was on disk and invisible to the endpoint. And the LED
finally receives it: `SessionStatusUI.dotHtml(status, signals)` takes
`unread` and `startup_gate` as a second argument, no live caller passed
it, and an unread `idle` session therefore painted a `steady` halo on
every surface. Full model in `docs/session-status.md`.

**`finished_unread` VERSUS `idle` IS DERIVED FROM THE UNREAD FLAG AT
RESOLVE TIME, BY ONE FUNCTION, ON EVERY PATH** - `derive_read_state`
(`src/core/session_status.py`), called from the hook tracker's resolve,
the tmux fallback, the seed's `display_state`, the transcript ladder's
rung 3 and the assembled answer in `_session_info_for`, so a saved
`finished_unread` becomes `idle` the moment the flag clears and
`activity_persist.write_state` stores only the base state. It shipped as
a one-directional rule - adding unread to an `idle` and never removing it
from a stored `finished_unread` - which is a cache rather than a
derivation, and measured on live 2026-09-09 the owner opened
`cloude_daily-briefing` and got `finished_unread` beside `unread: false`
from `status_source: seed_row`, a green dot over a session he had just
read.

**THE OUTER RING CARRIES ACTIVITY AND THE FINISHED TURN, AND THE OWNER
SETTLED THAT ON 2026-09-09.** `working` breathes; a live-but-stopped turn
(`question` / `notice` / the startup gate) breathes too, because the turn
is still open; a finished turn nobody has read takes `unread`, a crisp
STILL green ring; a read session at rest takes `steady`, lit and still in
its own dot's grey; a dead pane or a lost transport takes `off`, no ring
at all; an unmeasured one takes `dim`. The INNER dot carries the session's
state. MOTION is the load-bearing distinction: `active` is the only state
that animates, so a light that MOVES is a session that is moving.

That ruling settled a same-day reversal, and the reversal is HISTORY, not
a live rule. Both lines of this project were fixing one report - "the ring
around some of the leds are not gray, which means there should be
background tasks. i dont think those few have any background tasks" - and
fixed it opposite ways within hours. One retired the outer `unread` state
and its `--led-color-unread` hue and moved unread onto the inner dot
alone; the other kept the ring and simply stopped it breathing. The owner
picked the ring, so `unread` IS an outer state, `--led-color-unread` DOES
exist, and the `done` bucket stays in the summary priority. Anything in
this file or in `docs/session-status.md` that reads as though unread lives
on the inner dot is describing the branch that lost; fix it rather than
working around it (gotcha 8).

**The LED is two independent rings** (`client/js/status-led.js`): an inner
dot for the chat's status AND an outer ring for activity and attention,
so "a parked session with work still running behind it" is sayable on a
group header. `dotHtml` delegates to it, so every surface renders the
same component - and every surface must PASS IT SIGNALS (`unread`,
`startup_gate`, `status_source`, `transport`), not just the status
string, or the finished-turn ring, the disconnected red and the
provenance tooltip can never render. A WORKING session is solid green and
BREATHING whatever its unread flag says, and `unknown` never takes the
GREEN ring at all (it takes the faint grey `dim` one): that green is a
claim a turn FINISHED here, and neither of those two measured one.

**THE VOCABULARY IS TAUGHT, NOT GUESSED AT.**
`client/js/session-status-key.js` is the legend at the foot of the
sidebar, and it describes the model above - nine inner states resolving
onto five hues, plus the one two-part treatment. A nine-state colour
vocabulary with no legend is a vocabulary nobody learns. If the legend and
the light ever disagree, the light is not the thing to change quietly: one
of them is wrong and a user has already learned the wrong one.

BOTH RINGS ARE ONE ELEMENT: the inner is the span's `background-color`
and the outer is a four-layer `box-shadow` on that same span (an optional
hollow rim inside the dot, a hard `0 0 0 1.5px` ring, a low-alpha feather
at the same spread that softens the ring's own edge, then a blurred
glow), with every alpha mixed into the shadow colour by `color-mix`
rather than an element `opacity` that would fade the fill too. There is
NO pseudo-element, and there may not be one: the halo used to be an
`::after`, and the browser pixel-snaps that box's position and size
independently of the dot's box, so whenever the dot landed on a
fractional x/y - routine in a flex row, or wherever a text baseline puts
an inline box on a half pixel - the two circles came apart by a device
pixel. Symmetric `inset` fixed the halo's own internal symmetry and NOT
this, because the drift was between two boxes. A box-shadow is painted
from the element's own border box, so concentric is the only geometry it
can have.

**ONE LIT DIAMETER FOR EVERY STATE**, and no per-state rule may touch a
geometry token. The halo used to be sized per state, so the LIT object
came out at three different diameters (9.0, about 14.7 and 15.3px) and
only the two loud ones were visible - in a sidebar where one session is
working and the rest are at rest, that paints one dot 60 percent wider
than its neighbours, which is what the owner reported. Under the
one-element composition the five geometry numbers are declared once and
never overridden, so the rule holds by construction rather than by every
state remembering to agree. `unread` is the state that used to break it.

`idle` (read, at rest) has its own grey fill, `--led-color-idle`, and
sits under a still ring in that same grey, so opening a tab reads as
visibly calmer than leaving it unread - a green ring becoming a grey one
AND a recessed centre becoming a solid grey dot, two changes rather than
one. See `docs/session-status.md`.

**THE ROW'S CONTROLS LIVE IN A KEBAB MENU, AND RESTART IS ONE OF THEM.**
They were folded into a per-row three-dot kebab in `cddc823`; one line of
this project unfolded them again on 2026-09-08 back to inline pin and
close, deleting `client/js/session-row-menu.js`, its gesture module and
`session-row-menu.css`, and removing restart from a live row along with
them. **That was not taken, 2026-09-09.** The kebab stays, right-click
and long-press still open it, and `data-row-status` stays ON THE KEBAB,
which is where `session-sidebar-clicks.js` reads it to hand the restart
picker a measured status. THOSE TWO FILES GO THE SAME WAY OR THE MERGE
COMPILES AND LIES: point the read at the row while the kebab is what
carries the attribute and `runRestart` gets `null`, so every restart
reports "unknown" instead of what was measured. Nothing throws; the
picker just stops knowing anything.

Keeping the menu also keeps the two things its removal would have cost,
both of which were named honestly on the branch that removed it: FILING A
SESSION INTO A GROUP keeps a pointer route (the picker still opens on `g`
over a focused row, on Alt+Arrow across a band edge, and by dragging onto
a group header, but on a phone the menu entry is the only one of those a
thumb can reach), and RESTARTING A LIVE SESSION stays reachable, which is
gate 1 under "Replacing what is running".

**THE GROUP HEADER IS OURS TOO**: a fixed `--sidebar-gutter` span holding
the count FIRST so every group name starts at the same x, the count as
accent-coloured tabular-nums text rather than an oval pill, a kebab on
the pinned and other bands as well as on named groups so the menu column
is a straight line, and no numeric unread badge - the roll-up LED carries
the same finished-turn ring the rows do, and two indicators for one fact
is how they end up disagreeing.
