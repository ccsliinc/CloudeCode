# The viewer fan-out, /ws/events, preferences sync and settings import: the record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

**`ui_preferences` IS THE TYPED, VERSIONED HOME FOR PREFERENCES WITH NO SERVER
OWNER.** `src/core/ui_preferences.py` is the pure rules (the pydantic model, the
validation, the merge), `src/core/ui_preferences_store.py` the seam that puts
them on the lock and caches the read, and `src/api/preferences_routes.py` is
`GET`/`PATCH /api/v1/preferences`. The field set comes from
`docs/ui-preferences-inventory.md`, which classified all 24 durable
browser-stored keys; the ten in its PER-VIEWER column are NOT here and
`tests/test_ui_preferences.py` names every one of them, because a sync set that
quietly grew would pass every positive test and push one device's layout onto
every other device the user owns.

Four things about it are load-bearing. **A READ TOUCHES NO DISK**: the
projection is loaded once and refreshed by the `on_commit` listener, so a
wrapper edit or a boot migration keeps it in step - a cache invalidated only by
its own writer is wrong the moment anybody else writes. **AN UNRECOGNISED FIELD
IS PRESERVED**, so a newer client's preference survives an older server and a
downgrade destroys nothing; it is bounded rather than trusted, and a name that
reads like a credential is refused outright, which is what stops the passthrough
becoming a place to park a token. **ABSENT IS NOT A DEFAULT**: every field
defaults to `None` and the server never fabricates a value, so hydrating from an
empty or unreadable block cannot overwrite a real local setting - the client
keeps its own default and, until a read SUCCEEDS, refuses to write at all.
**THE REVISION MOVES ONLY ON A REAL CHANGE**, so a no-op `PATCH` does not make
every other client refresh for something that did not happen.

**A STALE WRITE IS A 409 THAT SAYS WHAT IS CURRENT, NEVER A SILENT
OVERWRITE AND NEVER A BARE REFUSAL.** The check is evaluated INSIDE the lock
against the document the write is about to merge into; checking it outside
compares against a read another writer can invalidate first, which is the lost
update wearing a check. The refusal carries the current revision AND the current
values, because a client cannot reconcile against a number it was not told, and
a bare 409 is how a retry loop against an unchanged conflict gets written. Same
shape as `if_version` on the respawn path. `tests/test_ui_preferences_api.py`
carries the NEGATIVE CONTROL: the identical request with the check declined,
asserted to overwrite, so the 409 test cannot quietly stop proving anything.

**`preferences.changed` IS AN OPTIMISATION AND THE REVISION IS THE ONLY
ORDERING IT NEEDS.** `client/js/preferences.js` applies a frame ONLY when its
revision is strictly HIGHER than the one it holds. That single rule survives
everything hook events already taught this project: the same frame twice is an
equal revision and ignored, a reordered pair has the older one lower and
ignored, a dropped frame is closed by the next higher one or by the next
refresh. It is a fold over a number, not an increment, so the socket promises
nothing. **APPLYING A RECEIVED CHANGE MUST NEVER GENERATE A SAVE** or two
browsers ping-pong forever, so `set()` refuses for the duration of the
fan-out - the guard is at this layer rather than in every control. **A
RECONNECT PERFORMS AN AUTHORITATIVE REFRESH, NOT AN EVENT REPLAY**
(`terminal.js`'s `ws.onopen`), and it never uploads this browser's snapshot.
That limit is CLOSED as of 2026-09-10 and the sentence that used to sit here
is history: the terminal WebSocket is still SESSION-SCOPED and still exists
only while a terminal is open, but `/ws/events` now carries the frame to a
browser sitting on the launchpad as well. The preferences route publishes to
BOTH, deliberately, and a browser holding both sockets receives the frame
twice - which is safe by construction rather than by luck, because
`applyRemote` applies a frame only when its revision is strictly HIGHER than
the one held. Dropping the terminal half would break every already-loaded
client that has no event socket yet, for no gain. The hydration on entering a
screen is untouched and is still what covers a client with neither.

## The application event channel, `/ws/events`

ONE AUTHENTICATED SOCKET PER BROWSER, carrying compact change notices about
every session, so a client on the home screen or looking at session A hears
about session B without waiting for its next poll. It closes the gap the
preferences work recorded above.

| Piece | File |
|---|---|
| The per-consumer bounded queue, and the named overflow | `src/core/bounded_stream.py` |
| The fan-out registry and the one publish path | `src/core/event_hub.py` |
| What a notice may claim, and the hook seam | `src/core/session_change_notice.py` |
| The endpoint | `src/api/events_routes.py` |
| The client | `client/js/app-events.js` |

**IT AUTHENTICATES EXACTLY AS THE TERMINAL SOCKET DOES, AND THERE IS NO
SECOND SCHEME.** The JWT rides `Sec-WebSocket-Protocol` and is checked by the
same `verify_jwt_from_subprotocol`, with the same `cloude.jwt.v1` marker
echoed on accept and the same 4401 / 4400 split. The client opens it through
`API.openWebSocket(null, '/ws/events')`, the function the terminal already
uses. A token in the URL is what that avoids: query strings are routinely
written to proxy and access logs and the header is not, and
`tests/test_ws_events.py` asserts a `?token=` handshake is still refused.

**COMPACT IS THE DESIGN, NOT AN OPTIMISATION.** A status notice carries the
session instance plus the handful of fields a row paints; the structural
notice carries only its own name and means RE-READ. A notice carrying a full
`SessionInfo` would become a second serialization of `/sessions/list` with its
own bugs and would drift from it; a notice that says re-read cannot. The
client honours that: it pokes `SessionSidebar.refreshNow()` and
`Launchpad.loadRunningSessions()` rather than patching a row in place, so an
event can only make the SAME refresh happen sooner.

**ABSENT IS NOT A DEFAULT.** `build_status_notice` OMITS any field the caller
could not measure rather than sending null, because a null says "this is now
false" and a fabricated `idle` or `ready` is exactly the false-green failure
this project keeps paying for.

**THE QUEUE IS BOUNDED AT 256 EVENTS OR 1 MiB PER CLIENT, AND AN OVERFLOW IS A
NAMED OUTCOME.** `BoundedStream.offer` is SYNCHRONOUS - a bounded
`asyncio.Queue` would have been the obvious change and would have been wrong,
because `await queue.put` on a full queue is precisely the backpressure into
the producer that the bound exists to prevent. Crossing the bound LATCHES,
closes that client's stream, drops it from the registry and closes its socket
with **4429**, an application code rather than 1013 so the client can tell
"you fell behind" apart from "the server went away" and skip its reconnect
banner. That client reconnects at once, with no backoff, and performs an
AUTHORITATIVE REFRESH: nothing replays and nothing is buffered for a browser
that is not there. No other client is touched.

**THE MUTE GATES THE TOAST AND NOT THE STATUS, AND THAT IS DELIBERATE.** The
toast notice is published from the one place in `claude_event_hook` a
suppressed toast never reaches - past the notification-policy gate and the
sub-agent gate, beside the existing per-session broadcast - so the policy is
enforced BY CONSTRUCTION and not by a second copy of the rule. The status
notice is published BEFORE those gates, because muting suppresses the
INTERRUPTION and changes nothing about what a row is allowed to say: a muted
session's light updates on the poll today, and a channel that refused to
report it would make that row visibly staler than before the channel existed.

**IT IS AN OPTIMISATION AND MAY NEVER BECOME A DEPENDENCY.** The five second
reconciliation poll is untouched. A tmux session started by hand on the
`cloude` socket produces no event here at all, and adopting an external
session is a first-class case in this app, so the poll is the only thing that
can see it. Every publish site is fail-soft: an app with no hub publishes
nothing, and a client whose socket never connects converges on exactly the
schedule it did before.

**PENDING IS NOT COMMITTED, AND A CONFLICT DROPS NEITHER SIDE.** A deliberate
choice applies locally at once and reports `pending`; a failure keeps the user's
value on screen as `failed` with the committed one still readable beside it, so
a retry knows both; a stale refusal or a remote change landing on an unsaved
edit becomes `conflict`, holding both values for the user to resolve. Silently
dropping either is how somebody loses a setting they watched themselves change.
Hydration runs BEFORE any preference-dependent control initialises, through
`App._initAuthenticatedState()` - ONE function called by both post-auth paths,
because two copies of that sequence is how one of them acquires a step the other
never gets (gotcha 7's shape).

**THE EIGHT EXISTING CONTROLS ARE MIGRATED ONE AT A TIME, THROUGH ONE SEAM,
AND ONLY WITH THE USER'S PRESS.** #43 and #44 built the block and the client
layer and deliberately rewired NOTHING, because moving each control is a
behaviour change with its own question about the value already sitting in that
browser. #46 answers that question in two halves.
`client/js/preference-bridge.js` is the seam: `read` prefers the shared value
and falls through to the control's own local reader, `write` MIRRORS to
localStorage AND the server. So a control becomes shared by changing its read
and its write, not by growing a preference layer inside itself. FOUR of the
eight are on it - the global theme (`themes/registry.js`), the sidebar density,
the global audio toggle and the last model chosen (`providers.js`) - each
having exactly one read function and one write function to move. The other four
(the sidebar arrangement, the two dock pins, the two fold maps) are collected
and importable but their controls still read local only; that is a known gap,
not an oversight, and the bridge is what closes it when somebody picks it up.

**MIRRORED, NEVER MOVED, AND THE LOCAL COPY IS NEVER CLEARED.** Three reasons
and the third is the one that matters: the local value is what answers when the
server is unreachable, it is what the pre-hydration paint reads (which is how
`applyStoredThemeIdSync` still kills the flash of the default), and #46's own
rule is that the local source is RETAINED until the server confirms. There is
no tidy-up step, because the tidying is what loses a user's settings on exactly
the request that failed. **ABSENT IS NOT A DEFAULT** here either: a field the
server does not hold falls THROUGH to local rather than reading as the
control's default, or every control would snap to its default the first time a
browser hydrated against a fresh install and the next change would save that
default over every other device. **AND THE BRIDGE NEVER SAVES ON ITS OWN** - no
read-then-write, no write-back-on-hydrate, no upload of a value the server has
not got.

**THE IMPORT IS EXPLICIT, PREVIEWED, AND ONE-TIME PER INSTALL.**
`src/core/settings_import.py` is the pure rules, `settings_import_store.py` the
one commit, `src/api/settings_routes.py` the three endpoints
(`GET /settings/import/state`, `POST /settings/import/preview`,
`POST /settings/import`), `client/js/settings-import-collect.js` the reader and
`client/js/settings-import.js` the panel, mounted as a slot on the settings
screen's general tab. **NOTHING IS UPLOADED WITHOUT A PRESS, ON ANY PATH** -
there is no import-on-load, no import-on-reconnect and none inside hydration.
The failure that buys: an automatic migration means the LAST browser to connect
wins, so a machine nobody has opened in three months uploads its stale snapshot
and silently reverts every setting changed since.

**THE PREVIEW AND THE IMPORT ARE THE SAME PLAN, BY CONSTRUCTION.**
`build_plan` is called by both endpoints and `changes_from` derives the write
from its output, so the preview cannot describe one thing and the commit
perform another. A preview that lies is worse than no preview: it is a safety
control telling the user they are safe. `tests/test_settings_import.py` proves
it by previewing, committing and comparing what landed, rather than by reading
two code paths and agreeing they look similar. The plan is REBUILT INSIDE THE
WRITE LOCK against the document the write will merge into, and a changed
selection re-fetches the preview from the server rather than being adjusted in
the browser - a second implementation of the plan is the one thing that could
make the two differ. Six per-field outcomes, and **SERVER VALUES WIN BY
DEFAULT**: a conflict is `conflict_kept` unless the user ticked that specific
field, which makes it `conflict_overridden`. There is no import-everything.

**THE MARKER AND THE VALUES LAND IN ONE COMMIT.** `ui_preferences_import` is a
sibling key in config.json, written by `apply_import` in the same
`config_writer.commit` as the preference merge, because both half-failures are
bad and both are silent: settings without the marker leave the install
re-offering the import to the next stale browser, and the marker without the
settings closes the offer having changed nothing. An import that writes NO
values still writes the marker - "everything here already matched" is a
completed import.

**THE ALLOWLIST IS A PROJECTION AND THE COLLECTOR NEVER ITERATES STORAGE.**
`importable_fields()` is `ui_preferences.known_fields()` minus
`REFUSED_FIELDS`, so a field added to the block is importable the day it lands.
The client reads only literal keys from its own table - there is no
`for (i = 0; i < localStorage.length; i++)` and there may never be one - which
is what keeps `claude_tunnel_token` and `claude_refresh_token` out of the
payload BY CONSTRUCTION rather than by a denylist one forgotten entry away from
uploading a credential. `tests/test_settings_import_collect.node.mjs` measures
that two ways: a recording storage proving neither token was ever READ, and the
serialised payload searched for the token VALUE.

**AND `theme_script_consent` IS REFUSED DESPITE BEING A PREFERENCE**, which is
the interesting half. #45 made it a known field, which would otherwise make it
importable. A browser's local record of "I allowed this theme's script" is the
pre-#45 `cloude.themeJsAllowlist` shape: a theme id and no digest, so importing
it would mint exactly the unbounded standing grant #45 exists to make
unexpressible. The issue's rule is "never infer theme-script approval from a
theme selection"; this is that rule one step further - never carry an approval
at all. Refused by NAME on the server and absent from the client's table, so
neither end depends on the other remembering.

**THE LOCAL SERVER DETECTOR IS FULLY WIRED, HAS NO CLIENT, AND IS KEPT ON
PURPOSE.** `LocalServersTracker` (`src/core/local_servers.py`) scrapes a port
number out of pane output, validates it with `is_valid_dev_port`, probes it
with `port_is_listening`, and broadcasts `local_server_detected` /
`local_server_lost` over the WebSocket. It is constructed, attached and started
at boot (`src/main.py:537-539`), stopped on shutdown (`:776-777`), read by
`GET /sessions/{session_name}/local-servers` (`src/api/routes.py:2614`) and
cleared when a session is destroyed (`:963`). **The owner ruled it STAYS.** Do
not remove the tracker, the route, the two WebSocket message models
(`src/models/websocket.py`) or the model fields, and do not disable the
janitor. It is dead code retained deliberately, which is not the same thing as
dead code nobody noticed, and this paragraph exists so a dead-code sweep can
tell the two apart.

Nothing in `client/` has consumed it since `4ee2f44` removed the panel.
Grepping `client/` for `local_server`, `localServer` or `local-servers` finds
only comments citing `#localServersContainer` as the worked example
of why a panel must never sit IN FLOW beside `.terminal-container` (it was
toggled on every fetch, so it reflowed the terminal under the user): one in
`terminal-resize-settle.js`, one in the `.terminal-container` rule in
`client/css/styles.css`, and one in
`web/src/lib/terminal-search/SearchPanel.svelte`, plus one
unrelated CSS accent comment. Two of those comments used to live in
`terminal-away-bar.js` / `.css`, which were deleted with the away bar on
2026-09-13. So the route and both WebSocket messages are live
and unread. **Do not put any panel back in flow beside the terminal container.**

**AND THE `local_servers` FIELD ON THE API IS HARDCODED EMPTY, SO IT DOES NOT
REFLECT WHAT THE TRACKER KNOWS.** `SessionInfo.local_servers` and
`SessionStats.local_servers` (`src/models/sessions.py:136`, and the
resolved list on `SessionInfo`) are assigned an empty
value at all four assignment sites: `session_manager.py:4845` (`0`),
`session_manager.py:5167` (`[]`), `routes.py:1459` (`[]`) and `:1461` (`0`).
Those literals PREDATE the panel removal, so this is not a consequence of it.
A client reading that field today is told, wrongly, that the session has no
local servers while the tracker sitting beside it is detecting them. **Anyone
reviving this feature must wire those four sites, not assume they work** - the
tracker is the part that is correct, and an afternoon spent debugging it would
be an afternoon spent on the wrong file. They are deliberately NOT wired here:
reporting real detections to a client that does not read them is a behaviour
change nobody asked for.

The standing cost, measured rather than assumed, so it can be judged later: the
janitor (`_janitor_loop`) wakes every `JANITOR_INTERVAL_SECONDS` (30.0) and
re-probes only the ports it is ALREADY TRACKING, in a worker thread so a slow
`connect_ex` cannot stall the event loop. State is in-memory and starts empty
on every boot, and a port is tracked only after a pane actually prints one. So
on a box where no session has printed a port the loop costs one wakeup every 30
seconds and ZERO probes, not a sweep per session. That is small, and it is not
nothing; the open question of whether it is worth paying while nothing reads
the result is the owner's to answer, and it is written down here so he can
answer it with the real number in front of him.

**AND THE FAN-OUT UNDER THAT READER IS BOUNDED PER VIEWER, WITH ONE WRITER
EACH.** This sits DOWNSTREAM of the kqueue reader and changes nothing about
it: the backstop, the `_pending_data` latch and the one-Future-plus-one-timer
wait are untouched. What changed is what happens to a chunk once the reader
has it. `_make_output_handler` did `await queue.put(encoded)` into an
`asyncio.Queue()` with NO maxsize, once per subscriber - and a queue with no
maxsize never blocks on put, so the defect never announced itself. It simply
GREW: this process held every byte a stopped browser had not read, for as long
as it did not read them, and the failure landed on the whole server rather
than on the one client that caused it. Measured on this tree, 5000 chunks of
8192 bytes fanned to three stalled viewers: **156.3 MiB held and still
climbing, against 8.0 MiB after**, with the overflow declared at chunk 256.

| Piece | File |
|---|---|
| The bounded queue and the named overflow, shared with `/ws/events` | `src/core/bounded_stream.py` |
| The viewer's bound, its frame kinds and the offer helpers | `src/core/viewer_fanout.py` |
| The one writer, the feeders, and the broadcast seam | `src/api/websocket.py` |

**THE HANDLER IS SYNCHRONOUS NOW, AND THAT IS THE CLAIM.**
`TmuxBackend._emit_output` awaits whatever `on_output` returns, so a coroutine
there puts the tail loop one await away from a browser's queue. `offer` is a
plain call that admits or refuses; a bounded `asyncio.Queue` would have been
the obvious change and would have been exactly wrong, because `await
queue.put` on a full queue IS the backpressure into the source that the bound
exists to prevent. The accounting costs **p50 0.83 us to 1.46 us per chunk for
three viewers**, next to the **9.58 us** the base64 encode of that same chunk
already costs once - so it is real, it is stated, and it is noise at this
scale.

**THE BOUND IS 4 MiB OR 256 CHUNKS, AND THE CHUNK COUNT IS WHAT FIRES.** The
tail loop reads at most 8192 bytes per `os.read`, which base64 inflates to
10,924 characters, so 256 chunks is about 2.8 MiB - inside the byte budget,
which is therefore the BACKSTOP for a future larger read rather than the
operative bound. 4 MiB is the same number `client/js/terminal-write-queue.js`
uses, deliberately: one number in the system beats two separately tuned ones.

**AN OVERFLOW DISCONNECTS; IT NEVER TRUNCATES.** You cannot fix a slow viewer
by dropping bytes. Escape sequences span chunk boundaries, so a terminal handed
half a sequence does not lose one cell - it leaves the VT parser wrong for
everything after it, until something resets. So the only safe response is to
stop that viewer and have it recapture, which the client already knows how to
do: a reconnect re-runs `paint_on_attach`. The close code is **4429**, an
APPLICATION code rather than 1013 so the client can tell "you fell behind"
apart from "the server went away"; it is declared once in `bounded_stream.py`
and the event channel imports the same number. It lands on the reconnect
policy's existing `retry_same_id` branch and spends no retry budget, because
the socket had opened. **STILL OPEN**: that branch shows the reconnect notice
and waits one backoff step, so the recovery is correct but not yet invisible.
Giving 4429 a silent branch means a new branch in `_scheduleRecovery`, and
`client/js/terminal.js` is at 2761 lines against a 2765 guard that must not be
raised for convenience.

**ONE WRITER PER VIEWER IS A CORRECTNESS CLAIM, NOT TIDINESS.** Two coroutines
awaiting `send` on one websocket interleave frames, and the result is a
corrupted stream rather than an exception - nothing in the system reports it.
This endpoint had FOUR concurrent senders (the pty stream, the log stream, the
local-server stream, and the receive loop's own pong and error replies) plus
`ConnectionManager.broadcast_to_session` reaching in from a toast, a rename or
a resize. `_drain_viewer` is now the only thing that touches a live socket;
`_pump_text` takes a stream rather than a websocket so a new message source
cannot add a sender by copying it, the read loop answers a ping THROUGH the
stream, and both broadcast methods `_offer` instead of sending. A socket
registered with no stream is reported UNDELIVERABLE rather than sent to
directly - that fallback is the second writer coming back through the door
this closes. The handshake's own sends (the welcome, the dimension request,
`paint_on_attach`) are sequential in one coroutine ABOVE the `create_task`
block and are pinned there by `tests/test_viewer_fanout.py`.

**AND THE "IS THIS A VIEWER OUTBOX" TEST IS STRUCTURAL, NOT `isinstance`.**
Measured rather than theorised: it shipped as
`isinstance(candidate, BoundedStream)`, which is an identity test against a
class imported BY VALUE, and it answered False inside a full suite run the
moment the process held two class objects for one module name - a stream
built from one binding measured against the other, both reporting
`__module__ == 'src.core.bounded_stream'`. It fails SILENTLY and in the
worst direction: `_close_viewer_stream` stops closing, so every writer task
stays parked in `get()` until its socket dies, and every broadcast reports
its viewer undeliverable. `is_viewer_stream` now asks for the three
attributes the callers actually use, which no `asyncio.Queue` has and which
depend on no module identity.

**TEXT AND BYTES SHARE THE VIEWER'S ONE BUDGET.** A second unbounded lane for
log and toast frames beside the bounded byte lane would leave the bound saying
nothing about the memory actually held, and a viewer that is not reading is
not reading any of it.
