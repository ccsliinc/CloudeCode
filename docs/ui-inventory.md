# Cloude Code: complete UI inventory

Cloude Code runs Claude Code sessions on a Mac and lets you drive them from a
phone, a tablet or a laptop browser. The sessions are real terminal sessions
living on the Mac, so they keep running whether or not anybody is watching, and
you can close the browser, walk away, and pick the same conversation back up on
a different device. The layout is phone first: the small screen is the design
target and the desktop is the roomier version of it, not the other way round.
There is also a macOS menu bar app that starts and stops the server and hands
you the link and the sign in code. Everything in this document is the browser
app unless a section says otherwise.

## How to read this document

This is a descriptive inventory, not a specification. It says what exists in
the shipped code today, screen by screen, region by region, control by control.
It was derived by reading the source, so if something is here it is real, and if
something is missing from here it is either genuinely absent or listed in the
appendix as unverified.

Each entry says what a control is FOR from the user's point of view, what states
it can be in, and whether it appears on desktop, on a phone, or on both. The
element id or class is given at the end of an entry as `id:` so you can match an
entry against a screenshot or against the running app. Lines beginning
`Screenshot:` are placeholders: each names a slug and describes the exact state
to capture, so images can be dropped in consistently.

Anything the code could not settle is written as `Uncertain:` with the reason.
Anything that exists only as a design document and is NOT in the live product is
called out in the appendix so nothing here gets mocked up twice.

The spelling "Cloude" is the product name. It is deliberate and is never a typo.

## The design language you are inheriting

**Status lights are the app's most important visual vocabulary.** Every place a
session appears (a sidebar row, a home screen card, a group header, the session
screen's own title bar) it carries a small two part light. The inner dot says
what the conversation is doing. The outer ring says whether something is running
and whether there is anything waiting for you. Nine internal states collapse onto
five colours:

| Colour | Means | Underlying states |
|---|---|---|
| Green, solid | the agent is working right now | working, working with sub agents |
| Yellow, solid | fully stopped, waiting on you | a permission prompt, or a session parked on an unanswered startup prompt |
| Light blue, solid | still working, but wants your attention | a notification that does not block |
| Grey, solid | alive, at rest, already read | idle |
| Grey, hollow centre | not measured, nothing has reported in | unknown |
| Red, no ring | dead or disconnected | the process exited, or this browser lost its connection |

The ring has five states of its own: breathing (something is genuinely running,
and this is the ONLY thing in the app that animates), steady (lit but still), a
crisp still green ring with a cleared centre (a finished turn nobody has read),
no ring at all (dead or disconnected), and a faint grey ring (not measured).

Three rules matter to a redesign. Colour is never the only signal: every light
carries words in its tooltip and its accessible label, and the two red states are
told apart only by those words ("dead, the process exited" against "disconnected,
no live connection to this session"). Every state paints the same lit diameter,
so one busy session in a column of quiet ones must not look bigger than its
neighbours. And "not measured" is a real answer that is never dressed up as
"idle".

**Themes.** 23 bundled colour themes ship with the app, plus any theme the user
writes themselves. A theme can be set globally, or pinned to one session so that
session is recognisable at a glance, and a session's pinned colour shows as a
small swatch on its rows and cards everywhere else. Every one of the 23 bundled
themes also ships an optional animation script. Three of them zero out every
rounded corner in the interface, so no design may rely on border radius to carry
meaning.

**Copy.** UI text is lowercase and plain throughout. No em dashes, no en dashes,
no emoji in the web client.

**Motion.** The only thing that animates by design is the breathing ring on a
running session. When the operating system asks for reduced motion, that
animation stops and the light holds at full brightness, the startup prompt badge
stops pulsing, and menu and button transitions are removed.

**Breakpoints.** Three numbers matter and they answer different questions.

- **769px** is the "is this a phone" line. Above it, three floating controls do
  not exist at all: the terminal tools button, the slash command button and its
  panel, and the on screen direction pad.
- **700px** is the "is there room to dock a panel" line. Below it the
  conversation sidebar and the file drawer cannot be pinned open and always
  behave as full screen overlays with a dimmed backdrop; their pin controls are
  removed from view entirely.
- **900px** is the archive browser's own line, where its three column layout
  collapses to one column at a time.

Smaller adjustments happen at 768px (header padding and control size shrink, the
copy output panel becomes a bottom sheet), 640px (the notification stack goes
full width and shows fewer cards), 600px (the new item menu shrinks, slash
command chips drop to two per row), 520px (the away bar's buttons stack), and
480px (header and title sizes shrink again, the paste panel becomes a bottom
sheet, settings rows stack). A separate rule fires on any touch device
regardless of width, raising the home screen's bottom bar to a 44px tap target.
When the app is added to an iPhone home screen it pads the top for the notch and
the bottom for the home indicator.

## The map: four screens and two panels

Four full screens, only one of which is ever visible at a time:

1. **Sign in.** Enter a six digit code. The only screen you see logged out.
2. **Home.** Running sessions, recent sessions, projects, and the place you start
   something new. The default landing screen.
3. **Session.** One live terminal, plus the controls that act on it.
4. **Archive.** A read only browser over every past conversation. Reached from a
   header button, and only when the server has the feature switched on.

Two large panels slide over Home and Session rather than replacing them:

- **Conversation sidebar**, from the hamburger at top left. Your list of sessions.
- **File drawer**, from the folder icon in the header. Browse and edit config and
  project files.

Both can be docked open above 700px so the content narrows beside them instead of
being covered.

Settings is a modal panel over whatever screen you are on. Everything else
(notifications, confirm dialogs, the restart picker, pickers and prompts) floats
over all of it.

Movement between them: signing in lands on Home. Clicking a session anywhere
opens Session. Clicking the app title in the header returns to Home from
anywhere. Deep links work: `/session/<name>` opens a session directly, `/archive`
and its sub paths open the archive at a specific place. A deep link that names
something that no longer exists drops you on Home with a notice strip explaining
why, never a silent bounce.

---

# Screen 1: Sign in

Proves you are allowed in, by asking for the current six digit code from your
authenticator app.

**Getting here and leaving.** You land here on a cold start with no saved
credentials, when saved credentials fail, when any request comes back
unauthorised and cannot be refreshed, and when you log out. The only way off it
is a correct code. There is no back, no cancel, and no other destination.

**On a phone.** The heading shrinks below 480px and the container padding narrows
below 768px. Nothing else changes; there is no separate phone layout.

**Note on the rest of the app's chrome.** Every header control is force hidden on
this screen, and the connection light has no home here, so the screen is the form
and nothing else.

## Region: the login form

Screenshot: `auth-blank-paired` - the sign in screen on a device that is already
paired, with an empty code field and no banners.

**Heading.** Names the screen, reading "Cloude Code Authentication".
id: `.auth-prompt`

**Instruction line.** Tells you what to do: enter your six digit code from your
authenticator app. id: `.auth-description`

**Code field.** Where you type or paste the code. It focuses itself shortly after
the screen paints, strips any character that is not a digit as you type, and
submits by itself the moment it holds six digits, so most people never touch the
button. Pressing Enter also submits. Phones get a numeric keypad. After a failed
attempt the field clears itself and refocuses. Maximum six characters, wide
letter spacing so the code reads as a code. id: `#totp-input`

Screenshot: `auth-input-partial` - three or four digits typed, no banners
showing.

**Field label.** Sits above the field and reads "totp code". id: `.auth-input-label`

**Login button.** Submits the code manually. It is the same action the sixth
keystroke already triggers, so it is a fallback rather than the main path. While
a submission is in flight the label changes to "verifying..." and the button is
disabled and dimmed. id: `#login-btn`

Screenshot: `auth-verifying` - the button mid submission reading "verifying..."
and dimmed. This state is brief and may need the network throttled to capture.

## Region: error state

Screenshot: `auth-error-invalid-code` - the red error banner after a wrong code,
with the field cleared.

**Error banner.** Hidden until something is rejected, then shown above the form
with a cross mark prefix. It carries either one of two client side messages
("totp code must be 6 digits", "totp code must contain only numbers") or
whatever the server said. It clears itself the moment you start a new attempt.

Rate limiting is not a separate screen or a distinct visual treatment: too many
wrong attempts produce the same banner carrying the server's message plus a "try
again in N seconds" suffix. There is no countdown, no locked out state, and no
disabled form. id: `#auth-error`

Screenshot: `auth-error-rate-limited` - the same banner carrying the try again
suffix. Requires deliberately exhausting the server's limit.

## Region: first run banner

**Setup banner.** Shown only on an install that has never been paired with an
authenticator app. It reads "initial setup required" and instructs the user to
run a setup script from a terminal, showing the command in a code style box. It
disappears as soon as a login is attempted. id: `#auth-info`

Screenshot: `auth-setup-required` - the blue first run banner. Only reachable on a
genuinely unpaired install.

**There is no enrolment screen in the browser app.** No QR code, no secret, no
pairing flow is drawn by the web client anywhere. Setting up the authenticator is
done from a terminal or from the menu bar app's "Show QR for TOTP" window. Do not
design a pairing screen for the browser; it does not exist and nothing calls for
one.

---

# Screen 2: Home

The landing screen: everything that is running, everything that recently ran,
every project you have, and the button that starts something new.

**Getting here and leaving.** It is the default route. You arrive after signing
in, by clicking the app title from anywhere, by closing a session, and by
following a deep link that could not be resolved. You leave by clicking any
session or project, or by finishing one of the "new" flows, all of which open
the Session screen.

**On a phone.** The body is a single column scroller at every width, so only the
chrome changes: header padding and icon size step down at 768px and again at
480px, the new item menu shrinks below 600px, and the bottom bar's controls grow
to a 44px tap target on any touch device.

Screenshot: `home-populated-default` - the home screen with several running
sessions, a couple of recent ones, and three or more projects, nothing collapsed.

Screenshot: `home-first-run-empty` - a fresh install with no sessions and no
projects.

## Region: header

The header is shared by every screen. On Home it is repainted with home specific
text and grows a second row.

**App title and brand mark.** On Home it reads "Cloude Code Launcher" beside the
app icon. On every other screen it names that screen (a session's name, for
instance) and doubles as the way back to Home. Long titles elide from the middle,
keeping the distinguishing end of the name rather than chopping it off.
id: `#appTitle`, `#header-icon`, `#header-title-text`

**Subheading row.** A second full width header row under the title reading
"select a project or create a new project". Home only; it is removed on every
other screen. id: `#home-subheader`

**Help button.** A question mark beside the title. Opens the app's one help
panel. Home only. id: `#launchpad-help-btn`

**Conversation sidebar toggle.** The hamburger at top left, opening the session
list panel. Available on Home as well as on a session. id: `#session-sidebar-toggle`

**Archive button.** Opens the transcript browser. It is hidden until the server
confirms the archive feature is switched on, and stays hidden if the check fails
or cannot answer, so it is simply absent on most installs rather than present and
broken. id: `#archiveBtn`

**File editor button.** Opens the file drawer. Always available once signed in.
id: `#configEditorBtn`

**Overflow menu.** A three dot button holding exactly two entries, logout and
settings. It is not responsive: those two live in the menu at every width, on the
argument that something rarely used on a phone is rarely used on a desktop too.
The archive and file editor buttons never fold into it. id: `#header-menu-toggle`

Screenshot: `header-overflow-open` - the three dot menu open showing settings and
logout.

**Session editor button.** Present in the header markup but hidden everywhere
except the Session screen. See that screen. id: `#sessionEditorBtn`

## Region: session attribution card

Screenshot: `home-attribution-prompt` - the attribution card in its default
state, with an unclaimed external session listed.

Shown above everything else when the app has found terminal sessions on its own
socket that it cannot confidently say it created. It asks you to decide, because
guessing would either claim something that is not yours or orphan something that
is.

**The card.** Lists each undecided session with a ticked checkbox, its display
name, how long ago it started, a plain English reason ("we found no record either
way", "we could not complete the check for this one"), and any extra hints the
server supplied as prose. There is deliberately no confidence score. When the
check itself could not run it collapses to one line saying attribution cannot be
determined. id: `#attribution-prompt`

**Default actions.** Three buttons: adopt all, choose individually, leave as
external.

**Per item actions.** Choosing individually reveals a second action row: adopt the
ticked ones, leave the ticked ones external.

Screenshot: `home-attribution-picking` - after clicking "choose individually",
showing the per row checkboxes and the second action row.

**Close.** Dismisses for now. A footnote states plainly that closing brings the
card back next time, while "leave as external" is remembered.

## Region: help panel

Screenshot: `home-help-open` - the help panel expanded, all three sections
visible.

**Help disclosure.** A fold out panel at the top of the page, opened either by its
own summary line or by the header's question mark. It is the app's only
explanatory prose. Three sections: how to adopt a terminal session you started
yourself, a note that "wrappers" and "launch wrappers" are the same thing (they
are named two ways on the settings screen), and how slash commands work. It
contains inline command examples and one link out to the project's README.
id: `.adopt-disclosure`

## Region: running sessions

Everything currently alive, whether or not this browser is attached to it.

**Section heading and count.** Collapsible, with a live count reading "N running".
When the underlying check failed the count is replaced by the words "count could
not be determined" rather than a number. The whole section is hidden when there
genuinely are no sessions; it stays visible when the check failed, so "none" and
"could not tell" never look the same. id: `#running-sessions-toggle`,
`#running-sessions-count`

**Needs attention banner.** Replaces the list when the check could not complete.
States that the count and contents may be incomplete and that nothing below is
shown as stopped, so an absence here is not proof of absence.
id: `.running-sessions-attention`

Screenshot: `home-running-listing-failed` - the needs attention banner in place of
the session list.

### The running session card

Screenshot: `home-card-owned` - one card for a session the app created, showing
its badges and every action.

Screenshot: `home-card-external` - one card for an adopted external session, which
has no fork button and a disabled rename.

Click the card to enter the session. Cards tint toward the session's pinned theme
colour when it has one. id: `.running-session-row`

Top line, left to right:

- **Status light.** The two ring light described in the design language section
  above. id: `.status-dot`
- **Session name.** The label if one has been set, otherwise the terminal session
  name with the internal prefix stripped for display.
  id: `.running-session-name`
- **"needs a keypress" badge.** An amber pill flagging a session that is alive but
  parked on an unanswered startup prompt, such as a folder trust dialog. This is
  the state where everything else on the row looks healthy, which is why it has
  its own badge. It appears only when that state is positively measured; both
  "started fine" and "could not tell" show nothing. It pulses slowly unless
  reduced motion is on. id: `.session-startup-gate`
- **Theme swatch.** A small colour chip showing the session's pinned theme, if it
  has one. Nothing is drawn when there is no theme.
- **Rename pencil.** Turns the name into a text field in place. It is dimmed with
  an explanatory tooltip when the session is not yet open or adopted, because
  there is nothing to rename yet. id: `.running-session-rename`
- **Fork.** Copies this conversation into a brand new session and opens it,
  leaving the original alone. Only on sessions the app created; an adopted
  external session has no record to fork from and the button is not drawn.
  id: `.running-session-fork`
- **Mark unread.** An envelope toggle for flagging a session to come back to,
  separate from the automatic finished turn ring. Filled when flagged. This
  control can be switched off server side, in which case it is absent everywhere.
  id: `.mark-unread-toggle`
- **Row action.** A session positively known to be live gets a close button and a
  restart button. A dead one gets restart then remove. A session whose state could
  not be confirmed gets close only, never a restart offered on a guess. Close and
  remove each open a confirmation naming the session; restart opens the restart
  picker instead. id: `[data-session-action]`

Badge row underneath:

- **Ownership badge.** Reads "TMUX" for a session this app launched or "EXTERNAL"
  for one it adopted. id: `.badge-tmux`, `.badge-external`
- **Agent family pill.** What kind of agent is running. Three visual treatments
  that must stay distinct: a solid border for a recorded fact, a dashed border
  with a tilde prefix for a guess worked out from the screen or the process list,
  and a dotted italic pill reading "unknown family" when nothing is known. The
  difference between a fact and a guess is load bearing here.
  id: `.family-pill`
- **Launch wrapper pill.** Names which configured launcher started this session,
  when one can be named, which is how two sessions of the same family are told
  apart. It renders nothing at all when no wrapper can be named, because that is a
  legitimate answer and the family pill beside it already says whether anything is
  unknown. id: `.wrapper-pill`
- **Age.** Relative creation time. Omitted when unknown.
  id: `.running-session-age`
- **Row number.** The durable record id, bottom right. Absent for a session with no
  record, never a placeholder. id: `.running-session-id`

Screenshot: `home-family-pill-states` - three cards side by side showing the solid
fact pill, the dashed guess pill and the dotted unknown pill.

Screenshot: `home-startup-gate-badge` - a card for a session sitting on its folder
trust prompt, showing the yellow light and the "needs a keypress" badge.

Screenshot: `home-rename-inline` - the rename field open in place of the name.

## Region: recent sessions

Sessions that have stopped. Read from records, not from a live check.

**Section heading and count.** Collapsible, reading "N recent", or "cannot
determine" when the read failed. Hidden entirely when empty unless the archived
toggle is on, in which case it stays visible showing "no recent or archived
sessions" so the toggle remains reachable. id: `#recent-sessions-toggle`

**Show archived toggle.** Reveals sessions the user has archived out of their own
lists. Always present, not conditional on anything being archived. Archiving never
destroys a record, which makes this the only route back to one.
id: `#recent-show-deleted-toggle`

**Recent row.** Shows a status dot only for a session positively known to have
ended, the session's name, an "ENDED" badge, a restart button (offered only for a
confirmed ended session, never on an uncertain one) and an archive button. An
already archived row is dimmed, carries an "ARCHIVED" badge in red outline, and
loses its archive button. id: `.recent-session-row`

Screenshot: `home-recent-populated` - a recent row with restart and archive.

Screenshot: `home-recent-archived` - the archived toggle on, showing a dimmed row
with its ARCHIVED badge.

## Region: projects

**Section heading.** Collapsible, no count of its own; counts live on each project.
id: `#projects-section-toggle`

**Show archived toggle.** Reveals archived projects. Always present.
id: `#projects-show-archived-toggle`

**Provenance banner.** Appears only when the source of the project list is in
doubt, saying either that the check did not answer or that the store could not be
read and writes are refused. Nothing is drawn in the healthy case.
id: `.project-authority-banner`

**Archived count notice.** With the archived toggle on, states the measured count
of archived projects including zero, or says it cannot be determined if that read
failed. id: `.project-archived-notice`

**Project row.** One folder. Clicking it starts a session there. It carries a fold
chevron with a count chip when it has sessions or a description, the project name,
its path, an optional description, an edit pencil and an archive or restore
button. id: `.project-node`, `.project-item`

Two independent badges, which say different things and can both apply:

- **Presence badge.** "MISSING, folder not found", or "CANNOT DETERMINE" with a
  reason. Either one disables opening and editing the project.
- **Archived badge.** "ARCHIVED". Archive and restore are deliberately still
  enabled on a missing project, since a vanished folder is exactly the one you
  want to archive.

A project that has not been checked yet shows no badge and keeps every action
enabled, because "not looked at" is not a problem.

There is no delete control on a project. The owner's rule is that sessions and
projects are archived, not deleted.

Screenshot: `home-project-expanded` - a project expanded showing its child
sessions.

Screenshot: `home-project-missing` - a project whose folder was deleted, showing
the MISSING badge and its disabled actions.

**Child session rows.** Sessions nested under their project. A live one shows the
status light, name, ownership badge and family pill. An ended one shows an "ENDED"
badge, is deliberately not clickable at all (so you cannot try to enter a dead
pane) and instead offers restart and archive.
id: `.project-session-row`

**"no project" group.** A normal collapsible group holding running sessions whose
folder was read successfully but sits inside no known project. This is a real,
measured answer, so it is styled as an ordinary group and never as a warning. It
is omitted entirely when empty. id: `[data-project-node="no-project"]`

**"needs attention" group.** Lists running sessions that could not be attributed to
any project, each with a plain English reason. Never collapsible, offers no
actions. Visible rather than silently dropped or guessed into a project.
id: `[data-project-node="needs-attention"]`

**Empty state.** "no projects yet", with the hint "use + new to add one".
id: `.launchpad-empty`

## Region: the new item button

Screenshot: `home-new-menu-open` - the plus button expanded showing all six
actions over its backdrop.

**Plus button.** A round trigger sitting in its own always visible row, deliberately
not tucked inside the running sessions heading, because a brand new user with no
sessions could not find it there. id: `#new-fab-trigger`

**Backdrop.** A full screen click outside layer while the menu is open.
id: `#new-fab-backdrop`

Six actions:

1. **new claude project.** Opens the three way choice described below.
2. **new session.** Adds a session to a project that already exists. It never
   creates a project; with no projects it opens a picker that says so.
3. **connect to openclaw.** A shortcut that launches straight into that agent
   family, skipping the family choice.
4. **connect to hermes.** The same for that family.
5. **new console.** A plain shell session in the home directory with no agent,
   automatically named and with no naming step.

There is deliberately no separate "open a folder" entry; that is the third choice
inside "new claude project".

## Region: starting a new project

Screenshot: `home-new-project-choice` - the three way choice modal.

**Choice modal.** Asks how the project should start: "start empty" (a fresh working
folder), "clone from github" (start from an existing repository), or "open an
existing folder" (a folder already on this machine). Arrow keys, Enter and Escape
all work.

Screenshot: `home-provider-wrapper-step` - the launcher picker on its wrapper step,
grouped by family with the default labelled.

**Launcher picker.** Shown before every real launch, on every path. It lists each
configured launcher grouped by agent family, with the default one labelled. If
none are configured it offers a single legacy entry instead. Choosing a launcher
that takes a model opens a second step listing a "no model" option, the model
catalogue and an "add" row for typing in a new model name; a local model server
gets its own step which explains when nothing is reachable rather than showing an
empty clickable list. Arrow keys move, Enter launches, typing jumps, Escape
cancels the entire launch. id: `#provider-list`

Screenshot: `home-provider-model-step` - the picker's model step.

**Name this project.** Collects a display name and an optional description.

Screenshot: `home-project-name-modal` - the naming step with both fields.

**Name rules.** A name is refused with an inline message and never silently
rewritten. Spaces are legal and stay exactly as typed, because real project names
have them. Refused: an empty name, a forward or back slash, a null byte, any
control character, exactly "." or "..", a name starting with a dot, and anything
over 255 bytes once encoded. The typed text is preserved in the field when a name
is refused.

Screenshot: `home-project-name-refused` - a name containing a slash, showing the
inline refusal with the typed text still in the field.

**Where should it live.** The step that asks for the parent folder the new project
directory is created inside, showing the full composed path live as you type. It
pre fills from the server's configured projects root, offers a browse button, and
keeps the create button disabled until both the name validates and a parent is
chosen. Cancelling here cancels the whole launch: no folder, no session.
id: `#project-parent-input`, `#project-path-preview`

Screenshot: `home-folder-step` - the folder step with a chosen parent and the live
full path preview.

**Folder browser.** Browses the Mac's filesystem to pick an absolute directory.
Type a path and press Enter (a path that does not exist is created), or click
through the list. Arrow keys and Enter work, plus "up" and "home" buttons. The
confirm button reads "open here". Used both by "open an existing folder" and by
the browse button on the folder step. It shows "loading...", "no subfolders here",
or an error line, never a blank list.
id: `.folder-picker-modal`, `#folder-picker-path`, `#folder-picker-list`

Screenshot: `home-folder-picker` - the folder browser mid navigation.

**Clone from github.** Takes a repository URL, a parent directory (pre filled) and
an optional description, and clones into it. The launcher is chosen before this
opens, so nothing is cloned until you have committed to a launch. All three fields
disable while the clone runs and the status reads "cloning... (may take a
minute)". Errors are shown inline, never in a browser alert, and each common
failure has its own sentence: not authenticated, repo not found or no access, name
already exists, the github tool not installed, and timed out after five minutes.
id: `#modal-clone-url`, `#modal-clone-parent`, `#modal-clone-status`

Screenshot: `home-clone-idle` - the clone form in its default state.

Screenshot: `home-clone-busy` - the clone form disabled with the "cloning..."
status.

Screenshot: `home-clone-error` - the clone form showing one of the mapped error
sentences.

## Region: bottom bar

A thin strip pinned to the bottom of the home screen. The body above it scrolls
independently so the bar is never pushed off screen.

Screenshot: `home-bottom-bar` - a close crop of the bar showing every item.

**Server controls button.** A cog at the left, opening a small menu whose single
row is "server status". id: `#server-controls-btn`

**Server status panel.** A read only snapshot of the server process, the host and
every live session, plus one destructive control: killing a session, which routes
through the same confirmation the session rows use. It also reports release and
self check information, saying "could not check" rather than claiming things are
up to date when the check did not answer. There is no "restart server" row; it was
withdrawn along with the endpoint behind it. id: `.server-status-content`

Screenshot: `home-server-status` - the server status panel open.

**Connection light and label.** A dot plus an always visible text label, since a
hover only tooltip does not exist on a phone. This is the same single light
element the app moves between screens, not a copy of it.
id: `#home-bar-status`, `#home-bar-status-text`

**Music toggle.** A speaker glyph controlling the app's background music. It has
seven states carried by both colour and wording, because a theme with no track, a
track that failed to load and a track actually playing are three different things:
"audio is off, tap to turn on", "audio state could not be read", "audio is on",
"audio is on, starting", "audio is on, nothing to play here", "audio is on, this
theme has no music", and "audio is on, but the track failed to load". The speaker
draws sound waves only when audio is genuinely reaching it and a slash only when
the user has switched it off. This is the same single element re parented across
the sign in, home, session and archive screens. id: `#globalAudioBtn`

**Version chip.** The build number in small grey text. When the version cannot be
resolved it reads "version unknown" rather than disappearing, because a missing
chip reads as a broken control. The same component draws the version at the foot
of the conversation sidebar, so the two can never disagree.
id: `#home-bar-version`

Screenshot: `home-version-unknown` - the chip reading "version unknown".

**External link.** A bird mark linking out to nyedis.ai in a new tab.
id: `.home-bar__link`

## Empty and first run states, collected

- No sessions and the check succeeded: the running section is hidden entirely,
  with no placeholder.
- No sessions and the check failed: the section stays, showing only the needs
  attention banner.
- No recent sessions, archived toggle off: the section is hidden.
- No recent sessions, archived toggle on: the section stays, reading "no recent or
  archived sessions".
- No projects: "no projects yet", "use + new to add one".
- A genuinely fresh install: only the plus button, the help panel and the empty
  projects message appear between the header and the bottom bar.

---

# Screen 3: Session

One live terminal, streaming a real session on the Mac, wrapped in a thin layer of
controls. This is where the work happens; everything else is scaffolding around it.

**Getting here and leaving.** From a card on Home, from a row in the conversation
sidebar (which switches session without leaving this screen), from a notification
card, from a `/session/<name>` link, and from the reopen step after a restart. You
leave by clicking the app title to go Home, by choosing "detach session" (which
leaves the session running on the Mac), or by navigating to another screen.

**On a phone.** Three floating controls exist only below 769px: the terminal tools
button, the slash command button and its panel, and the direction pad. Below 700px
neither the conversation sidebar nor the file drawer can be docked, so both cover
the terminal instead of narrowing it. The copy panel becomes a bottom sheet below
768px, the paste panel below 480px, and the away bar's buttons stack below 520px.

Screenshot: `session-idle-desktop` - a session open on a wide screen, nothing else
showing.

Screenshot: `session-idle-phone` - the same session at phone width, with the
floating buttons visible.

## Region: header

Everything from the Home header applies, with two differences.

**Session name and rename pencil.** The title shows the session's name instead of
the app name, eliding from the middle when it is too long. A pencil beside it
swaps the title for an editable field; Enter or clicking away saves, Escape
cancels, and a validation failure shows an inline message under the field.
id: `#header-rename-pencil`, `#header-rename-input`

Screenshot: `session-header-rename` - the title replaced by the rename field.

**Session editor button.** A sliders glyph that only appears on this screen. It
opens a two row menu of things that configure the session itself, as opposed to
moving content through it. id: `#sessionEditorBtn`

Screenshot: `session-editor-menu-open` - the session editor dropdown open showing
both rows.

- **session theme.** Opens the per session colour picker.
  id: `#sessionThemeRow`
- **detach session.** Ends this browser's attachment without killing the session,
  which keeps running on the Mac and can be picked back up later. Styled as a
  danger row and separated from the row above it. id: `#sessionDetachRow`

## Region: navigation notice strip

Screenshot: `session-deep-link-notice` - the notice strip after visiting a session
URL that names nothing.

A thin banner above the header, deliberately using calm informational colours
rather than alarm red, because it explains rather than warns. It auto dismisses
after eight seconds and can be closed sooner. It never sits inside the terminal
area, because an in flow panel there would reflow the terminal grid under the
user's hands.

Four messages it can carry, in the app's own words: `session not found: "<name>",
returned to home.`, `<name> is no longer running` (a notification pointing at a
session that has since ended), `archive link could not be resolved: <reason>`, and
`Invalid project name in URL, returned to home.`
id: `#deep-link-error`, `#deep-link-error-text`, `#deep-link-error-dismiss`

## Region: the terminal

**The terminal surface.** A real terminal, streaming the live session. It renders
either the ordinary scrolling screen, which has real history up to 50,000 lines,
or the full screen mode some agents draw, which has no history at all by design.
On attaching, the cursor position is restored explicitly rather than guessed, so
your cursor lands where the session's cursor actually is. id: `#terminal`

Behaviours with no visible control, which a designer should know are there:

- **Follow the bottom.** New output snaps the view to the bottom only if you were
  already at the bottom. Scrolling up to read is never yanked back down. On a
  phone the direction pad's bottom row arrow is the "jump to latest" control;
  there is no such button on desktop.
- **Long press to select on touch.** A terminal has no native touch selection, so
  a long press enters a select mode (announced by a status pill reading "select
  mode, drag to highlight"), dragging highlights, and lifting your finger puts a
  small floating "copy" button where you lifted. Tapping elsewhere exits.
- **Scrolling inside the agent's own full screen view.** When the agent is drawing
  its full screen interface there is no real history to scroll, so a scroll gesture
  is translated into the agent's own transcript view. This only fires when the
  agent's own on screen furniture is positively recognised, so the gesture can
  never be sent into an unrelated program.
- **Background bleed through.** When the active theme has a confirmed animated
  background, the terminal renders slightly transparent so a hint of it shows
  through. This is automatic; there is no slider or toggle, and it falls back to
  fully opaque whenever the background cannot be confirmed.

## Region: bottom bar

**Session readout.** Which session and process is attached, in plain monospace. It
reads "No active session" before anything is attached. It shrinks first when the
bar runs out of room. id: `#sessionInfo`

**Connection light and label.** The same shared light element as on Home, moved
here. Its label carries the connection story in words: "Connecting to
terminal...", "Connected", "Reconnecting...", "WebSocket error", "Disconnected",
"Connection failed", "Session ended", "No answer from server, retrying...", "No
network connection, waiting...", "Server reachable, restoring session...", "Cannot
reach server", "Refreshing auth...", "Destroying session...", "Detaching
session...", and a generic "Error: <message>".
id: `#terminal-bar-status`, `#terminal-bar-status-text`

Screenshot: `session-reconnecting` - the connection light and label mid reconnect.

**Music toggle.** The same shared speaker control described on Home.
id: `#globalAudioBtn`

## Region: away bar

Screenshot: `session-away-bar` - the away bar over the terminal after returning
from more than a minute away.

An overlay across the terminal, shown when you come back after being away for at
least a minute with a session attached. It asks what to do about output that
arrived while you were gone. It measures the absence with a heartbeat rather than
relying on a visibility event, so a phone that fully sleeps while locked is still
detected. It appears once per absence. It is an overlay rather than a bar in the
layout, because taking rows away from the terminal would resize the session and,
in the agent's full screen mode, erase the visible conversation.
id: `#awayBar`

Three choices plus a close:

- **show full history.** Replaces what is on screen with a fresh capture of the
  session's real current state. A caveat line above the buttons says what this
  will do before you press it.
- **show summary.** Prints a short account of what happened while you were away,
  inside the bar, without touching the terminal.
- **just continue.** Dismisses and does nothing else. Whichever you chose last on
  this device is marked on the button next time.
- **close.** Dismisses without choosing.

## Region: floating controls, phone only

Screenshot: `session-floating-controls-phone` - all three floating buttons at rest
at phone width.

None of these exist above 769px. Where desktop has no replacement, that is noted.

**Terminal tools button.** Bottom right, innermost. Opens a three row menu for
moving content across the terminal's boundary. id: `#terminalToolsBtn`

Screenshot: `session-tools-menu-open` - the tools menu open with its three rows.

- **copy output.** Opens the copy panel below. There is no desktop equivalent at
  all; desktop has only mouse selection plus the copy shortcut.
- **paste from clipboard.** Reads this device's clipboard and puts its contents
  into the terminal, falling back to the paste panel when the browser will not
  allow a direct read. Desktop is fully covered by its own paste shortcut.
- **attach file.** Opens the device's file picker and uploads the chosen file into
  the session. There is no desktop equivalent and no drag and drop anywhere.

**Direction pad.** Bottom right, beside the tools button. A four square glyph at
rest, a cross while open. It opens a cluster of keys for driving a terminal
program without a physical keyboard: the four arrows, Enter in the middle, Escape
as a labelled button, Shift+Tab (used by the agent for cycling modes), and one
button that is not a keystroke at all, a "scroll to bottom" that also re enables
follow the bottom. id: `#dpad-float-btn`

Screenshot: `session-dpad-open` - the direction pad expanded showing every key.

**Slash command button.** Alone in the bottom left corner, a slash glyph at rest
and a cross while open. id: `#slash-commands-btn`

## Region: slash command panel, phone only

Screenshot: `session-slash-panel` - the slash command panel open showing the
starred row and the grouped list.

A searchable browser of every slash command available in the current project, so
you can insert one with a tap instead of typing it. Both the button and the panel
are hidden above 769px, so a hidden trigger never leaves a reachable panel behind.

Desktop loses something real here: typing a slash into the terminal still reaches
the agent's own command handling, but that gives you none of the grouping,
descriptions, favourites or filtering this panel provides. Hiding it was a
deliberate instruction, and the gap is recorded rather than papered over.

- **Starred chips.** A row of one tap chips for the commands you have starred, each
  showing the name and a short description. With nothing ever starred it shows the
  built in defaults and says they are defaults; if you star and then unstar
  everything, you get an explicit empty state rather than the defaults quietly
  coming back. Two chips per row below 600px. id: `#common-commands-grid`
- **Filter field.** Filters the list live as you type, matching both name and
  description. Arrows move a highlight, Enter picks, Escape closes the panel.
  id: `#slash-command-filter`
- **Full list.** Every command under category headings, each row showing a
  shortened description with a "more" toggle to expand in place and a star toggle
  to add or remove it from the chip row above. id: `#all-commands-list`

Screenshot: `session-slash-panel-filtered` - the same panel with a few characters
typed into the filter.

## Region: copy panel

Screenshot: `session-copy-panel` - the copy panel open showing detected link and
code chips.

Opened from the tools menu. It exists because a terminal has no touch selection at
all, so on a phone there was previously no way to get a link or a login code off
the screen. It shows the last few hundred lines of output as plain re joined text,
so a URL split across display lines reads as one thing again. A centred dialog on
a wide screen, a bottom sheet below 768px.
id: `.cloude-copy-sheet`

- **Link and code chips.** One tap copy buttons generated automatically for every
  link and code shaped token found in the recent output. An empty state reads "no
  links or codes found in recent output". id: `.cloude-copy-chip`
- **Open link.** Sits beside each detected web link and opens it in a new tab,
  since following a sign in link on the device you are holding beats copying it
  and switching apps. id: `.cloude-copy-open`
- **Copy all.** Copies the whole visible block in one tap.
  id: `.cloude-copy-sheet__action`
- **Raw text area.** A selectable text box as the last resort, so you can long
  press and use the operating system's own copy menu.
  id: `.cloude-copy-sheet__text`

## Region: paste panel

Screenshot: `session-paste-panel` - the paste panel open over a plain http
connection.

Opens automatically in place of a direct clipboard read whenever the browser will
not let the page read the clipboard at all, which is the case on any plain http
address such as a local network one. It gives you a text box to paste INTO, since
the paste gesture itself is the permission, and explains the situation in plain
language: the connection is not secure, so paste into the box with the usual
shortcut or a long press, then press insert. Images work here too. It becomes a
bottom sheet with full width buttons below 480px.
id: `#pasteFallback`, `.paste-fallback__input`, `#pasteFallbackCancel`,
`#pasteFallbackInsert`

## Region: session theme picker

Screenshot: `session-theme-picker` - the per session theme picker open, with the
active theme marked.

Opened from the session editor menu. It recolours only the session on screen, so
you can tell your sessions apart at a glance. The header reads "theme for
<session name>". Each theme is a row, and the active one is marked and
highlighted. It is anchored to the button that opened it, preferring to sit above
and falling below when there is no room.
id: `.cloude-session-theme`

A session's pinned colour then appears as a small swatch on its sidebar row and
its home screen card. It is deliberately a swatch rather than a background wash,
so it cannot be confused with the "currently selected" highlight.

## Keyboard actions with no visible control

- **Shift and Enter** puts a newline into the prompt without sending it. Plain
  Enter still sends.
- **The system copy shortcut**, with text selected, copies and leaves the
  selection in place, matching a native terminal. The interrupt shortcut is never
  intercepted and always reaches the running program.
- **Escape** closes whichever overlay is on top.
- **Long press and drag** on the terminal, on touch, enters selection mode.

---

# Screen 4: Archive

A read only browser over a complete archive of every past conversation on the
machine, organised machine, then collection, then project, then conversation, with
both a byte exact view and a readable chat view of each one.

**This screen is real and it ships.** Two documents in the repository still
describe it as unimplemented; they are out of date, and so is the routing table
that cites them. The screen is fully built and is gated behind a server feature
flag, so it is present in the code and switched off by default. The header button
that opens it stays hidden until the server positively confirms the flag is on; a
failed or unanswered check leaves it hidden.

**Getting here and leaving.** The archive button in the header, or a link to
`/archive` and its sub paths. You leave by clicking the app title, which returns
to Home. A "Back" button steps one pane back within the archive. Escape
deliberately never leaves the screen, because an accidental Escape discarding a
deep paging position was judged hostile.

**On a phone.** Below 900px the three column layout becomes one column at a time
and the drag handles between panes are removed from the layout and from the tab
order; the Back button becomes the main way to move between panes. Below 700px
padding is removed from the crumb and toolbar, the search field goes full width,
and several panes tighten. The project info dialog has its own layout below 480px
and the chat view below 768px.

Screenshot: `archive-root-desktop` - the archive at its root on a wide screen,
three panes visible.

Screenshot: `archive-root-phone` - the same at phone width, single pane, no
resizers.

## Region: shell

**Back button.** Steps one pane back: a conversation returns to its project, a
project returns to the root. Hidden at the root. id: `.archive-screen__back`

**Breadcrumb.** Names where you are in words, never with a raw database number.
Each level shows one of three things: a real name; a reference standing in for a
name when no name exists, labelled as such; or "NOT NAMED YET" when the name
simply has not arrived yet, which is a normal state when following a link
directly. id: `.archive-screen__crumb`

**Status bar.** Along the bottom, carrying the app's connection light and the
music toggle, re parented here from elsewhere.

**Pane dividers.** Two drag handles, one between each pair of panes. Widths persist
per device and are re clamped against the current window on every load, so a width
saved on a large screen is never trusted on a small one. Double clicking a handle
resets that pane. They are keyboard operable, and removed entirely below 900px.
id: `.archive-screen__resizer`

Screenshot: `archive-pane-resize` - mid drag on the divider between the first two
panes.

## Region: navigation rail

The only way into the archive's contents. There is no global search that
substitutes for it.

**Project filter.** Fuzzy filters the already loaded rows by name or path,
highlighting the matched characters. When nothing matches it says so and adds an
honest note that this filters loaded rows only, not the whole archive.
id: `.archive-nav__filter`

**Sort order.** Four orders: recent first (the default), oldest first, name, and
most sessions. A project that lacks the key for the chosen order is pulled out of
the ordered block entirely and parked at the end with a visible reason chip, for
instance "not in this order: date not established". An undated project is never
quietly placed at either end of a date order, because that would imply a date.
id: `#archive-nav-order`

**Project card.** Selects a project, loading its conversations in the middle pane.
Its counts read as a sentence, "27 sessions of 718 total", where the first is the
conversations you started and the second includes the files sub agents wrote. That
first figure has three possible answers: a number, "NOT KNOWN, not reported", or
"NOT KNOWN, could not be determined", each with its own wording. A date chip shows
last activity, or says there is no date. Labels elide rather than wrap.
id: `.archive-nav__card`

**Info button.** A small "i" opening a dialog with everything the card has no room
for: the full path, the machines it was collected from with per machine counts and
links that narrow the rail, any renaming or grouping you have applied, and the
counts restated with definitions. When a row carries no machine information at all
it says so rather than showing an empty list.
id: `.archive-nav__info-btn`

Screenshot: `archive-project-info` - the project info dialog open.

**Machine badges.** Show which machines a project was collected from, marked when
it exists on more than one. id: `.archive-nav__host-badge`

**Unattributed bucket.** A first class entry for conversations whose source path
carried no project layer. It is always shown except when the server reports a
measured count of exactly zero; a missing or uncountable figure keeps it visible,
because hiding on an unmeasured count risks hiding real conversations.
id: `.archive-nav__node--unattributed`

## Region: conversation list

**Scope filter.** Narrows the whole server side scope, not just the loaded page, to
one of three: everything, my sessions (the default, roughly seven percent of the
archive), or agent sidechains (the other ninety three percent). Changing it
reloads from the first page. A note underneath restates in the server's own words
what the filter matched and how many rows exist under it.
id: `#archive-tlist-scheme`

**Column filters.** Three fuzzy fields filtering the rows already loaded by name,
reference or date. A note underneath says how many of the loaded rows matched and
warns explicitly that rows on pages not yet loaded were not searched.
id: `.archive-tlist__fuzzy-input`

**Conversation row.** Opens a conversation in the reader. It leads with a title
where one exists and falls back to the raw reference, labelled as a reference
rather than disguised as a name. A coloured badge names where the title came from:
NAMED (a person chose it), AI-NAMED, FROM SUMMARY, LAST PROMPT NOT A NAME
(explicitly marked as weak), NAME LOOKUP FAILED, NOT NAMED, or NAME SOURCE NOT
KNOWN. Two further independent badges can appear and are never merged, because
they are separate findings: NO PROJECT and HOST NOT ESTABLISHED.
id: `.archive-tlist__row`

**Load more.** Fetches the next fifty. It is drawn only when the server positively
says there are more. When there are not, the footer reads "End of the list. All N
rows in this scope have been loaded." When the server did not answer, it reads
"Whether there is more beyond these N rows: NOT KNOWN".
id: `.archive-tlist__more`

Screenshot: `archive-conversation-list` - a project open with its conversation
list and the scope filter visible.

## Region: reader toolbar

**View toggle.** Switches the reader between the readable conversation view (the
default) and the raw line view. The button names the destination, not the current
state, and neither view is destroyed when you switch, so scroll positions and
selections survive. id: `.archive-screen__view-btn`

**Search field.** Runs a search scoped to the open conversation, or to the current
project when none is open. id: `.archive-screen__search-input`

**Export button.** Opens the export dialog for the open conversation. With nothing
open it refuses silently rather than opening empty.
id: `.archive-screen__export-btn`

## Region: conversation view

Screenshot: `archive-chat-view` - a conversation open in the readable view.

The default reader. Turns render as chat bubbles; the technical envelope, tool
detail and thinking blocks are folded behind per turn disclosures rather than
removed.

**Turn.** One turn, with a header naming who spoke, the time, the model if known,
and a chip counting any flagged secrets. A role the server only inferred is marked
"(inferred)" rather than presented as fact. id: `.archive-chat-turn`

**Envelope info toggle.** An "i" revealing every raw fact about the turn. Every
field is always rendered even when absent, showing "NOT KNOWN", because a missing
row and an empty row mean different things and this panel exists precisely for
when something is confusing.

Screenshot: `archive-chat-turn-info` - a turn's envelope panel expanded showing
its NOT KNOWN entries.

**Sub agent expander.** Reveals the sub agents a turn spawned, in run order, each
drillable into its own conversation, recursively. The ordering is labelled with
where it came from: the server's declared order, this view's own derived sort
(explicitly labelled derived), or not known at all. A sub agent run whose
transcript could not be resolved is still listed and counted, with a disabled
control naming why, never silently dropped.

Screenshot: `archive-chat-subagent` - a sub agent expander open, with one row
drilled into.

**Drill breadcrumb.** Every level of sub agent nesting you have entered, each
individually clickable to jump back up, rather than a single back that remembers
one step. id: `.archive-chat-chain`

**Content block.** One block of a turn. Three outcomes: text the server included
renders as text, text the server withheld renders as withheld and names its
length, and a block whose state cannot be determined says so.
id: `.archive-chat-block`

**Pager.** Loads the next page of turns. It appears only at the end of the loaded
content, never floating mid page, and carries two distinct messages: that the
server says there is more, or that whether there is more is not known.

## Region: raw view

Screenshot: `archive-raw-view` - the same conversation in the raw line view.

A line by line render exactly as ingested, for questions only the bytes can
answer.

**Line row.** One line, routed by record type into turn, tool, progress, note, or a
catch all. An unrecognised type never breaks the reader; it renders as a plain
honest row. The speaker is shown as text, never colour alone, because three themes
zero every rounded corner and colour alone would be the only cue. A missing
timestamp reads "NOT KNOWN". Badges mark a line that came from a sub agent's own
file, the agent's id, and a point where context was compacted.
id: `.archive-row`

**Progress run chip.** Collapses a consecutive run of progress records, which are
over a third of a typical file, into one chip stating the count and line range,
expandable in place. It is never hidden by default and cannot be filtered away,
because silently dropping a third of a byte exact archive would be a lie about the
file. Linking to a line inside a collapsed run expands it automatically.

Screenshot: `archive-progress-chip` - a collapsed progress run chip.

**Line body.** Eight named, mutually exclusive states, which is the most
design-relevant list on this screen: not requested (a sized placeholder saying how
big it is, never a spinner, because nothing was asked for); loading; included (the
text, plus a note counting any secrets masked in this view); body withheld by this
view (the body declares secrets whose exact position could not be located, so it
cannot be safely masked and is not shown at all, with a retry); large body (over
256 KiB, with "render anyway" and "download this body"); too large to render (over
2 MiB, download only, no render option at any depth); withheld by the server
(download only); and no body row at all, which is a real measured shape.
id: `.archive-row__body`

Screenshot: `archive-large-body-gate` - the "large body" state with its two
buttons.

**Load more lines.** Fetches the next 500 line window. It shows a busy label while
loading and never stays permanently disabled after a failure.
id: `.archive-reader__more`

**Row cursor.** Keyboard navigation with j and k, opening with Enter. "Nothing
selected" is a real third state, not an error: a fresh list has nothing selected
until you act.

## Region: search results

Replaces the conversation list in the middle pane.

**Coverage sentence.** States in words how much of the scope was actually read,
never leaving it implied by the hit count. Four outcomes: the whole scope was
read, the server stopped partway (explicitly not the same as finding nothing), the
page filled and more matches exist, or no scan ran at all. This is rendered even
on an ordinary successful search, because success does not by itself mean the
whole scope was read. id: `.archive-search__coverage`

**Hit row.** Opens the matched conversation at the matched line. A hit whose
preview was withheld because the body carries flagged secrets is still shown as a
real hit, with its location and match position, labelled "PREVIEW WITHHELD",
rather than hidden or turned into an error. id: `.archive-search__hit`

**Resume.** Two genuinely different continuations that are never conflated: ask for
the next page of matches, or ask the scan to keep reading files it never opened. A
resume that is blocked is shown disabled with the reason attached rather than
omitted. id: `.archive-search__resume-btn`

Screenshot: `archive-search-results` - a search run, showing the coverage sentence
and a resume control.

## Region: export

Screenshot: `archive-export-blocked` - the export dialog showing the download
blocked panel alongside a real integrity finding.

**Export dialog.** Preflight checks a conversation file and, when possible, starts
a download.

**Downloading is currently blocked on every platform**, and the dialog says so
plainly: the export endpoints accept only a credential no browser navigation can
send, so every state that would offer a download instead shows a panel reading
"DOWNLOAD BLOCKED: NO CREDENTIAL A BROWSER CAN SEND" with an explanation. This is
a known, named limitation rather than a bug, and the dialog still does real work,
because the integrity check below it functions.

Six integrity outcomes, all visually distinct: preflight (checking), integrity
verified before sending (the only one styled as success), integrity could not be
evaluated (for a file too large to hash in flight, offering a copyable command so
you can check it yourself), the server is busy (nothing failed and nothing
downloaded, with a retry), not found, and cannot determine. A filename collision
warning appears when the download name is known to collide with others.
id: `.archive-export__content`

## Region: keyboard shortcuts

Screenshot: `archive-keys-help` - the shortcut overlay open.

Every binding is inert while a text field has focus and while a dialog is open.
The help overlay reads the real binding table live, so it cannot drift out of date.
id: `[data-modal="archive-help"]`

| Key | Action |
|---|---|
| j or down arrow | next row |
| k or up arrow | previous row |
| Enter | open the selected row |
| slash | focus the project filter |
| s | focus the search field |
| m | load the next page |
| e | open the export dialog |
| t | cycle the scope filter |
| v | switch between the readable and raw views |
| question mark | open this shortcut list |
| Escape | close a dialog, else clear the filter, else dismiss search results, else on a narrow screen go back one pane. It never leaves the archive |

## Region: masking

There is no masking panel and no toggle. Masking is applied to every rendered body
in both views, always. Wherever text was masked, a note says "N secret(s) masked in
this view. The archived bytes are unchanged.", so it is clear the archive itself is
untouched and this is a viewing lens.

The masking fails closed: if it cannot account for the exact position of every
declared secret it refuses to render any of that body's text rather than producing
a half masked, plausible looking result. That refusal is what the "body withheld by
this view" state above shows.

## Region: outcome blocks

Every pane routes any non trivial server response through one shared renderer with
six outcomes: ok, empty, partial, cannot determine, not found, and transport error.
A partial result always renders its real rows AND its banner together, never one or
the other. Four independent channels distinguish an outcome and colour is only one
of them: the wording, the styling, a data attribute, and which action buttons
structurally exist in the block. id: `.archive-outcome--<token>`

---

# Panel: conversation sidebar

Screenshot: `sidebar-open-desktop` - the sidebar open over the session screen.

Screenshot: `sidebar-open-phone` - the same at phone width with its backdrop.

Your list of sessions, and the way you switch between them. It slides over Home or
Session from the left, or docks beside them.

**Opening and closing.** The hamburger at top left. It closes on its own close
button, a click on the dimmed backdrop, Escape, or after switching session, unless
it is pinned. Pinning docks it: the backdrop disappears, the content narrows beside
it, and it survives switching sessions. The pin control is removed entirely below
700px, since a docked panel there would leave nothing for the terminal, and the
preference quietly re engages if the window is widened.

Screenshot: `sidebar-docked` - the sidebar pinned open on a wide screen, with the
terminal narrowed beside it.

## Region: header cluster

Two deliberately separate clusters. The left one holds controls that act on the
LIST; the right one holds controls that act on the PANEL.

**Title.** Reads "conversations". id: `.session-sidebar-title`

**Row detail control.** Opens a three item menu choosing how much each row shows.
Its icon is three filled bars of decreasing height, drawn to be unmistakable
against the hamburger that opened the panel. id: `#session-sidebar-density`

Screenshot: `sidebar-density-menu` - the row detail menu open showing all three
options.

The three modes:

| Mode | What a row shows | Row height |
|---|---|---|
| compact | grip, light, name, pin, menu. No badge | 24px |
| cozy (default) | the above plus the tmux or external badge inline | 46px |
| detailed | the above with the badge moved to a second line beside the session's age | 66px |

Row heights are fixed per mode rather than emerging from the content, so adding or
removing a glyph elsewhere cannot silently resize a mode.

Screenshot: `sidebar-density-compact`, `sidebar-density-cozy`,
`sidebar-density-detailed` - the same list at each of the three modes.

**New group button.** A plus that asks for a name and creates a group. This is the
discoverable way to make one; the other is the "new group..." entry inside the row
picker, and both do the same thing. id: `#session-sidebar-group-add`

**Pin panel open.** Docks the panel. Desktop only, hidden below 700px.
id: `#session-sidebar-pin`

**Close panel.** id: `#session-sidebar-close`

## Region: the list

The list is one tab stop with arrow keys moving inside it, which is what makes
keyboard reordering reachable. Beneath the rows sits a polite announcement area
that speaks every move, pin, group change and rename, because a reorder whose only
feedback is visual is not operable without a mouse.
id: `#session-sidebar-list`, `#session-sidebar-live`

Three states the list shows instead of rows:

- **Genuinely empty.** "no other conversations".
- **The check failed.** An attention block reading "CANNOT DETERMINE", never a false
  "no conversations".
- **Your saved order could not be read.** A notice saying so and that the default
  order is showing until you pin or move something.

### Bands and groups

Sections run top to bottom: a pinned band, then each group you created in your own
order, then everything else.

- Pinning is a flag, not a group. A pinned session shows in the pinned band
  whatever group it is also filed in, and unpinning drops it back there.
- An empty pinned band draws nothing at all, appearing only while a drag is in
  flight so there is something to drop onto.
- With nothing pinned and no groups, the list is flat with no headers, exactly as
  it was before groups existed.
- A group you made yourself always renders even when empty, the opposite rule,
  because you made it deliberately and a group that vanished when emptied could
  never be refilled.

**Group header.** Left to right: a fixed width count column holding the count as
plain accent coloured tabular text (deliberately not an oval pill), a fold button
with a chevron and the band's name, a roll up status light, and a three dot menu.
The fixed count column is what keeps every band name starting at the same x
whether the count is one or a hundred. A folded band's rows are absent from the
page, not hidden, so nothing counts invisible rows.
id: `.session-sidebar-group__headerrow`

**The roll up light.** The header's dot is the single state among its members that
most wants you, ranked permission, then waiting on input, then working, then
unread, then done, then dead, then unknown. Its RING is folded separately across
the whole group. That is why a header can show a quiet grey dot inside a breathing
ring: the loudest single member is parked, but something else in there is working.
Both facts at once is the whole reason there are two rings. There is no numeric
badge beside it.

Screenshot: `sidebar-group-rollup` - a group header whose dot is quiet but whose
ring is breathing.

**Group menu.** On a real group: rename, move up, move down (each omitted at the
edge), and remove, which names how many conversations will move to the ungrouped
band and removes none of them. On the reserved pinned and other bands: a single
expand or collapse entry, offered a second way so the menu column is never empty.
id: `.session-sidebar-group-menu`

Screenshot: `sidebar-group-menu` - a group's menu open showing all four entries.

### A list row

Left to right on the main line: a six dot drag grip (its own control, since a plain
click on the row already means "switch to this"), the status light, the session
name, a theme swatch if one is pinned, the "needs a keypress" badge if it applies,
the tmux or external badge, a pin toggle, and either the three dot menu (on a live
row) or inline restart and remove buttons (on a dead one).

There is no agent family pill in the sidebar at any density; it was deliberately
removed. The home screen card still has one.

**Session name.** Double clicking it, or F2 with the row focused, opens an inline
rename in place. Whether that is possible has three states, not two: renameable,
unavailable (it will definitely fail, and the reason is announced), and unknown
(we cannot tell whether it would work, which is a different fact). Only the first
opens the editor. id: `[data-row-name]`

Screenshot: `sidebar-rename-inline` - a row's name replaced by the rename field.

**"needs a keypress" badge.** As on the home card, at every density including
compact, because it is the only signal that a session has not started.

**Pin toggle.** Moves the row into or out of the pinned band without touching its
group. id: `.session-sidebar-row-pin`

**Unread.** There is no envelope icon on a row any more. The green ring on the light
is the only signal that a turn finished and nobody has looked. A manual "mark
unread" action still exists, inside the row menu, and can be switched off server
side.

Screenshot: `sidebar-unread-ring` - a row whose light shows the crisp green ring
with a cleared centre.

### The row menu

Screenshot: `sidebar-row-menu-open` - a live row's three dot menu open, showing all
eight entries.

Opened three ways, all landing in the same place: tapping the three dot button (the
only way available on a phone), right clicking anywhere on the row (desktop), or
long pressing the row for half a second (the touch equivalent of a right click,
cancelled by scrolling or moving). The drag grip and the pin are exempt from the
long press.

Eight entries, with a separator before the last two:

| Entry | What it does | When it is off |
|---|---|---|
| rename | opens the same inline editor a double click opens | disabled with a reason when the session cannot be renamed |
| mark unread / clear unread | flags the session to come back to | absent entirely when switched off server side |
| move to group | opens the group picker | sidebar only; the home screen's copy of this row never gets it |
| fork session | branches the conversation into a new session and opens it | disabled with a reason unless the app created the session |
| new session | starts a new session in the same folder, through the normal launcher picker | always available; a lookup failure at click time refuses and names why rather than falling back to a default folder |
| mute / unmute | stops this one session interrupting you, changing nothing about its status | always available |
| restart the agent | opens the restart picker | offered only on a row positively known to be live |
| kill session | kills the running process, through a confirmation | always available, below the separator |

Every entry has a single letter shortcut active while the menu is open. A disabled
entry is still drawn, still reachable by keyboard, and shows its reason as visible
text, never silently hidden, because a keyboard user needs to reach the
explanation and a menu that changes shape row to row is confusing.

Screenshot: `sidebar-row-menu-disabled` - the menu on a row that cannot be forked,
showing the greyed entry with its reason.

Screenshot: `sidebar-row-dead-inline` - a dead row showing inline restart and remove
instead of the three dot menu.

### Reordering

Two independent ways to do the same thing. The rule is that dragging must never be
the only way to do anything, because a drag needs a steady pointer and a big enough
screen, and it is unreachable by keyboard.

- **Drag** from the grip only. It activates after a few pixels of travel so a tap is
  not a zero distance reorder. The band under the pointer is read from the group
  container rather than the nearest row, which is what makes an empty band a valid
  drop target. Crossing a band edge pins, unpins or files the row, and is announced.
- **Keyboard.** Arrow keys move focus. Alt with an arrow moves the focused row within
  its band, and crossing a band edge does the same pin or file the drag does. Home
  and End jump to the ends. The letter p toggles the pin. The letter g opens the
  group picker. F2 renames. Enter or Space switches to the session.

Screenshot: `sidebar-drag-in-progress` - a row mid drag with the empty pinned band
showing as a drop target.

**Group picker.** The non drag way to file a conversation. A menu listing every
group, then "other (no group)", then "new group...". The current group is marked.
Choosing "new group..." asks for a name and files the row in one gesture.
id: `.session-sidebar-group-menu`

Screenshot: `sidebar-group-picker` - the group picker open with the current group
marked.

## Region: footer

Both blocks render on every state of the list, including the empty and error
states, because neither is a property of how many rows there are.

**"what the lights mean".** A fold out legend, collapsed by default, whose open
state is remembered. Every swatch in it is a real rendered light rather than a
drawing of one, so it can never show a colour the app does not paint. Seven rows,
one per distinct light rather than one per internal state, because two yellow
states and two red states look identical and sending a reader hunting for a
difference the light cannot show is worse than collapsing them.
id: `.session-status-key`

| Light | Words |
|---|---|
| yellow, breathing | stopped, waiting on you |
| light blue, breathing | still working, but needs your attention |
| green, solid, breathing | working |
| green ring, cleared centre, still | done, unread |
| grey, solid, still ring | idle |
| red, no ring | dead / disconnected session |
| grey, hollow, faint ring | not measured, nothing reported in, so this is not idle |

Plus a closing sentence: "a group header shows one dot for everything inside it:
the state in that group that most wants you."

Screenshot: `sidebar-status-key-open` - the legend expanded showing all seven rows.

**Version.** The build number in small grey text, the same component the home screen
bottom bar uses. id: `.version-footer`

---

# Panel: file drawer

Screenshot: `drawer-open` - the file drawer open on the right with its roots.

Browse and edit three real locations without leaving the app: the user's own Claude
configuration folder, the current project's configuration folder, and the current
session's working directory. It is scoped to those three; it is not a general
filesystem browser.

**Opening and closing.** The folder icon in the header, available once signed in
whether or not a session is attached. It slides in from the right. It closes on its
own close button, a click on the backdrop (unless docked), or Escape. Clicking a
file opens a second, full screen editor stacked on top, which has its own close, a
"back to files" link, backdrop and Escape. Escape always dismisses only the topmost
of the two. Every dismissal is gated behind an unsaved changes confirmation.

**On a phone.** Below 700px the drawer cannot be docked, the pin control is removed
from view, and the drawer itself narrows. The editor is full screen at every width.

## Region: drawer chrome

**Title.** "file editor". id: `#config-editor-title`

**New file.** Opens the new file prompt. It sits beside the title rather than on each
directory row, because a tree row is already a button and cannot nest another one.
id: `#config-editor-new`

**Pin drawer.** Docks the drawer into the layout so the content narrows beside it
instead of being covered. It uses the same pushpin as the sidebar's pin, because it
is the same gesture. Desktop only. id: `#config-drawer-pin`

Screenshot: `drawer-docked` - the drawer docked on a wide screen, terminal narrowed
beside it.

**Close.** id: `#config-editor-close`

## Region: the tree

**Root nodes.** Three expandable roots. The user's configuration folder and the
project's configuration folder start expanded; the project's own files start
collapsed. A directory named "plugins" always starts collapsed however it was left.
id: `.config-editor-toggle--root`

**Directory nodes.** Expand to fetch their contents on first opening. Three visible
outcomes, deliberately kept apart:

1. **Loaded with content.** Children render as rows.
2. **Loaded and genuinely empty.** Nothing is appended. A directory that is really
   empty renders as nothing, not as an error and not as a leftover "loading".
3. **Could not be read.** A notice row saying either "could not list contents:
   <reason>" (the parent listing already reported it could not enumerate this one)
   or "could not load contents: <detail>" (the live request did not answer). These
   are never folded into an empty list.

While fetching, a "loading..." notice sits in the child list.
id: `.config-editor-toggle`, `.config-editor-notice`

Screenshot: `drawer-lazy-loading` - a directory mid expansion showing the
"loading..." row.

**File rows.** Open the file. They can carry three badges: "read-only" for a file
under a read only root, "runs automatically" for a file the agent executes on its
own, and a lock for a file the server flagged as holding credentials.
id: `.config-editor-file`

**Missing root notice.** Three way rule. A measured absence (no session attached, or
a project with no configuration folder) draws nothing at all. An absence that could
not be evaluated draws a named notice. A root that resolves always renders even
with zero entries. id: `.config-editor-node--notice`

**Indentation guides.** Decorative vertical lines connecting nested rows, instead of
raw left padding. id: `.config-editor-guide`

## Region: the file editor

Screenshot: `drawer-editor-open` - the full screen editor open on a real file.

A full screen editor, at every width. Syntax highlighting exists for Markdown,
JSON, Python, JavaScript and shell scripts; everything else opens as plain text
with no highlighting.

**Back to files.** Dismisses the editor and reveals the drawer beneath, worded for a
stacked context. Drawn only when the editor is genuinely stacked over the drawer.
id: `#config-editor-modal-back`

**Edit and preview tabs.** Markdown files only. Switches between the raw editor and
a rendered preview. id: `#config-editor-mode-edit`, `#config-editor-mode-preview`

**Sensitive file mask.** A file the server flagged as holding credentials opens
behind a padlock and an explanation until you explicitly reveal it through a
confirmation. This is a guard against showing a secret on a shared screen or in a
screenshot, not access control: the content is already loaded. Saving such a file
needs its own separate confirmation.
id: `#config-editor-sensitive-mask`, `#config-editor-reveal`

Screenshot: `drawer-editor-masked` - a credentials file open behind its mask with
the reveal button.

**Executable warning.** A banner on a file the agent runs automatically, stating
that saving needs a confirmation and that a backup is always taken first.
id: `.config-editor-exec-warning`

**Read only warning.** A banner stating the file is under a read only root and
cannot be saved. The save button is disabled too.
id: `.config-editor-ro-warning`

**Unsaved changes indicator.** A footer line reading "unsaved changes" in the warning
colour whenever the content differs from what was loaded. This is the ONLY unsaved
state anywhere: there is no dot on the tree row and no marker in the title.
id: `#config-editor-dirty-flag`

Screenshot: `drawer-editor-dirty` - the editor after typing, showing the unsaved
changes line.

**Save.** Disabled for a read only file and for a masked one. A JSON file is parsed
first and fails fast with an inline error rather than saving. Executable and
sensitive files each require their own confirmation, and a file that is both fires
both. Success shows an inline "saved" or "saved (previous version backed up)";
failure shows an inline reason. id: `#config-editor-save`

**Cancel.** Dismisses through the same unsaved changes gate.
id: `#config-editor-cancel`

## Region: new file prompt

Screenshot: `drawer-new-file` - the new file dialog with its root selector and path
field.

**Where.** Chooses which of the three roots the file goes under, offering only the
roots the drawer is actually showing.  id: `#config-editor-new-root`

**Path.** A path relative to that root, for example `notes.md`. Creating directories
is deliberately not offered: the parent must already exist and the server says so if
it does not. Enter submits. id: `#config-editor-new-path`

**Error line.** Shows the server's own rejection reason word for word, rather than
duplicating its rules on the client. id: `#config-editor-new-error`

**Create and cancel.** The create button disables itself while the request is in
flight.

## Docked behaviour

While docked, the content beside the drawer narrows rather than being covered, the
backdrop becomes fully transparent and unclickable (a docked drawer covers nothing,
so a click to dismiss would be an invisible dead zone), the drawer loses its shadow
and its slide in animation because it is part of the layout now, and the floating
buttons shift left so they are not drawn on top of it. Docking and undocking
explicitly tells the terminal to re measure itself. Escape does nothing to a docked
drawer; only its close button closes it, and closing it does not unpin it.

---

# Overlay: settings

Screenshot: `settings-tab-workspace` - the settings panel open on its first tab.

One modal where every server owned setting lives. Opened by the gear in the header
overflow menu, closed by its cross, its cancel button, a click on the backdrop, or
Escape, each of which discards nothing that was already saved separately.

A single save button batches every changed field across the simpler tabs into one
write. Launchers, terminal commands, the volume slider and the settings import each
write immediately on their own and are not part of that batch, which is worth
knowing because pressing cancel does not undo them.

**Layout.** One column at every width, at most 560px wide, at most 88 percent of the
screen height. The tab strip scrolls horizontally at every width rather than wrapping
to two rows, with a soft fade on whichever edge has more tabs beyond it. Below 480px
the tab strip tightens, and the launcher and command rows stack into a column with
full width buttons. There is no wider desktop arrangement.

## Tab: workspace

First, because it answers the question a settings screen is usually opened to answer:
what will my next terminal be.

- **development root.** The base folder new projects are created under.
  id: `#settings-ws-root`
- **default shell.** What a new terminal runs. id: `#settings-ws-shell`
- **default editor.** The command run when the app hands you a file to open.
  id: `#settings-ws-editor`
- **environment variables.** A list of name and value pairs injected into every new
  terminal. Rows can be added and removed, and there is always at least one blank row
  so there is somewhere to type. A warnings box appears under it only after a save the
  server flagged, for instance a reserved name; it stays hidden otherwise rather than
  drawing an empty box.
- **bind address.** The address the server should listen on across restarts. Below it
  sits a four state note that never overrides what you typed: could not be determined,
  no saved preference, your saved value is what the server is actually on, or your
  saved value differs from what is running (shown as a warning, since it only takes
  effect on the next restart). id: `#settings-ws-bind`
- **prefer TLS.** A checkbox that records a preference and is explicitly not a live
  switch. A permanent hint reads "recorded, not in force".
  id: `#settings-ws-tls`

## Tab: wrappers

Screenshot: `settings-tab-wrappers` - the launchers tab with at least one family
expanded.

One group per agent family (claude, codex, hermes, openclaw, shell, plus any
unrecognised family found in stored data), each drawn even when it holds nothing.

Note for copy: the tab is labelled "wrappers" and the section heading inside it reads
"launch wrappers". They are the same thing named two ways on one screen, which the
help panel has to explain. There is no second concept.

- **Family group.** A heading with a live count. When empty it says "no <family>
  wrappers. the legacy command below is what runs."
- **Launcher row.** One configured launcher, showing its label, its id, a "default"
  badge, a "takes model" badge, and an optional description. Actions: edit, set
  default (hidden on the one that already is), and remove.
  id: `.settings-wrapper-row`
- **Add and import example.** Per family. "Import example" fetches that family's
  example library and offers it through a plain browser prompt with a numbered list,
  or a plain browser alert if that family has no examples. Both buttons disappear
  entirely while any editor is open, since only one editor is allowed at a time.
- **Launcher editor.** Family, id, label, the script itself in a large text area, an
  optional entry command, an optional description, a default checkbox and a "takes
  model" checkbox. When editing, family and id are locked, because they are fixed once
  created. Required fields are checked before the write, the save button shows
  "saving..." and re enables on failure with the reason inline. It writes immediately;
  it is not part of the panel's batched save.
  id: `.settings-wrapper-editor`
- **Legacy command.** A collapsed advanced row per family holding the static fallback
  command that runs when no launcher exists. Editable for four families, read only for
  the shell family, which has no endpoint behind it and says so rather than offering a
  control that would fail. Hint text says whether that value is what is actually in use
  or has been superseded, and an "effective command" preview appears only when it is
  genuinely what runs.

## Tab: terminal

Screenshot: `settings-tab-terminal` - the terminal commands tab with a few saved
commands.

A reorderable list of your own one click shell commands.

- **Command row.** The label and the literal command text, with run, edit, move up,
  move down and delete. The move buttons disable themselves at the ends of the list.
  "Run" closes settings, opens a new console session and types the command into it.
  id: `.settings-command-row`
- **Command editor.** A label and the command text, both required. A new entry's id is
  derived from the label automatically, so there is no id field. The whole list is
  saved as one replacement on every change; there is no batching.
- **Add command.** Hidden while any editor is open, the same one at a time rule as the
  launchers tab. id: `#command-add-btn`

## Tab: notifications

Screenshot: `settings-tab-notifications` - the notifications tab with its channel
fields and the history list below.

- **notifications enabled.** The master switch for the channels below. A note above the
  section says these need a server restart to take effect.
  id: `#settings-field-enabled`
- **ntfy server url.** A plain text field. id: `#settings-field-ntfy_base_url`
- **ntfy topic, slack webhook url, pushover token, pushover user key.** Four secret
  fields, all with the same contract: the real value is never sent back to the browser,
  so the field always starts empty, its placeholder reads "configured, leave blank to
  keep" or "not set", and a hint underneath says "a value is set, typing here replaces
  it" or "not configured, this channel is disabled". Submitting an empty field means
  leave it alone, never clear it. There is no control anywhere in this panel to
  explicitly clear a configured secret.
- **notification history.** The read only list described under global overlays below,
  mounted here beneath the channel fields. id: `#settings-toast-history-slot`

## Tab: general

Screenshot: `settings-tab-general` - the general tab showing the theme picker, the
volume slider, the server field and the import section.

Four independent sections, none of which uses the panel's batched save.

- **Theme.** A dropdown listing all 23 bundled themes. It applies immediately with no
  save step; the description beside it says so. id: `#theme-selector`
- **Music volume.** An attenuator applied on top of each theme's own volume, shared
  across every session. It is explicitly not a mute: its minimum is 35 percent, so it
  can never reach silence, and starting or stopping music is done from the speaker
  control in the bottom bar instead. It applies live as you drag, and the readout shows
  what the audio engine actually accepted rather than what you asked for. The row is a
  44px tap target with a large thumb, sized for a phone but fine with a mouse.
  id: `#settings-master-volume`
- **Server host.** Read only, always disabled. A warning block appears if the server is
  bound to every network interface, explaining the exposure; otherwise a calmer line
  says it is bound to one interface.
- **Import settings from this browser.** Below.

## Settings import

Screenshot: `settings-import-preview` - the import section showing a preview table
with several outcomes and at least one override checkbox.

A one time, explicitly pressed migration of one browser's locally stored settings onto
the server, so every device you use converges on the same values. It never runs on its
own: nothing is uploaded without a press, on any path, including loading the panel and
reconnecting. The reason is concrete: an automatic migration means the last browser to
connect wins, so a machine nobody has opened for three months would upload its stale
copy and silently undo every change since.

**Three ways the control renders before any preview.** Already completed (below);
nothing to import, shown as a disabled button reading "nothing to import" with the hint
that this is normal for a browser you have not used the app in before; or unavailable,
where each of the ways the check can fail renders its own specific disabled button with
its own reason. The control is never hidden, always visible with a reason.

**The preview table.** Every field gets exactly one of six outcomes, and the wording is
the user's only guide to what will happen:

| Outcome | Shown as | Means |
|---|---|---|
| imported | "will be imported" | the server holds nothing for this; it will be written |
| identical | "already matches" | your value is what the server already has |
| conflict kept | "the server value is kept" | the server holds something different and you have not ticked the box, so nothing is overwritten |
| conflict overridden | "will replace the server value" | same conflict, but you ticked the box |
| rejected invalid | "not a value this server accepts" | your value fails the server's own validation and will never be written |
| refused | "never imported" | the server refuses this field by policy, whatever you hold |

**Override checkboxes.** Only conflicting rows get a checkbox. Every one of them is
unticked on first view, so **the server's value wins by default** and you have to
deliberately tick a field to overwrite it. There is no "select all" and no "import
everything". Ticking a box re fetches the plan from the server rather than recomputing
it in the browser, so what you are shown and what would be committed can never differ.

**After a commit.** The panel reports how many fields actually moved, or that everything
already matched, and refreshes against the server's own new state. If another device
imported first, nothing is written and the status says so plainly, telling you your own
settings in this browser are unchanged. **Local values are never cleared**, before or
after, because browser storage stays the fallback every shared control reads when the
server cannot be reached.

**Once it is done** the section collapses to one sentence and a permanently disabled
button reading "already imported". The sentence names when it happened, how many
settings it carried, and why it runs once: a browser you have not opened in months could
otherwise upload its old copy and quietly undo everything changed since.

Screenshot: `settings-import-done` - the import section after an import, showing the
disabled button and no preview rows.

---

# Global overlays

These float over every screen and are not tied to any one of them.

## The notification stack

Screenshot: `toast-stack` - two or more notification cards stacked top right, with the
dismiss all row above them and an overflow row below.

**These are records, not snackbars.** There is no timer anywhere in the notification
code. A card disappears only when it is dealt with, never on a clock, because the whole
point is to tell you something happened in a session you are not looking at.

They reach a browser two ways at once: a live push to a browser attached to that
session, and a poll every ten seconds covering every session. That is why a card can
appear while you are on Home or in the archive, neither of which is attached to anything.

**Position.** Top right, a fixed 360px column starting below the header, with 10px
between cards. Below 640px it becomes full width with small side margins. Three cards
are visible at once on desktop, two on a phone, but the cap is raised automatically to
fit every blocking card, so a permission prompt can never be the thing hidden behind
"more".

**One card per session.** A session never produces more than one card. Which of its
pending events the card shows is decided by the same ranking the status lights use, so
the card can never disagree with the light beside it: a permission prompt outranks
something waiting on input, which outranks work in progress, which outranks an unread
finished turn. A more urgent event upgrades the card in place; a less urgent one can
never downgrade it.

### Card anatomy

- **Severity mark.** A small leading character on the title, coloured by kind: a green
  square for a finished turn, an amber warning for a permission prompt, a blue circle
  for a notification, a blue page for an attachment receipt. Uncertain: the startup
  prompt kind has no mark of its own and inherits plain title styling.
- **Title.** The four kinds a user can see, in their exact words: **"Your turn"** (the
  agent finished), **"needs your permission"** (blocked until you answer),
  **"wants your attention"** (a notification that does not block), and
  **"needs a keypress"** with the body "this session is waiting at a startup prompt and
  has not started yet. open it and answer the prompt." A fifth, **"attached"**, is raised
  by the app itself and described below.
- **Session line.** A quieter second line naming which session the card is about,
  because raising is global and the app does not assume you are looking at it. Clicking
  it goes there and dismisses the card. A card from before the app recorded session
  identity shows "unknown session" in italic, and is not clickable.
- **Body.** An optional short excerpt, for instance the tail of the conversation or the
  tool being asked about.
- **Count badge.** A times-N badge, drawn only when more than one record of the WINNING
  kind is folded in. It deliberately counts only that kind: a session holding one
  permission prompt and six finished turns must never read "permission needed times 7".
  How many records dismissing would actually clear is a different number and is stated
  separately on the dismiss button's accessible label.
- **Dismiss.** The cross in the corner. It clears every record this card is holding, not
  just the visible one. id: `.toast__dismiss`
- **Dismiss all.** A full width button above the cards, drawn only when two or more
  cards are on screen, reading "Dismiss all (N)". When any of them is blocking, its
  border turns to the danger colour and its accessible label names how many of the N are
  waiting on your permission, so the scope is disclosed before the click.
  id: `.toast-dismiss-all`
- **Overflow row.** Appears when more cards exist than fit, reading "+N more" where N is
  the total records hidden, followed in brackets by how many of the worst kind are in
  there, for instance "(3 waiting on you)". Clicking expands, and it reads "Show fewer"
  while expanded. Nothing behind it is dropped or auto cleared.
  id: `.toast-overflow`
- **The whole card is the jump target** when it names a session, entering it the same way
  a sidebar row would, so the session's pinned theme is respected. Reading a notification
  never clears it: a plain click navigates without dismissing. If the session is gone,
  the click surfaces "<name> is no longer running" in the navigation notice strip rather
  than doing nothing.

**Dismissing.** The cross, dismiss all, clicking the session name, typing into the
session the card is about (the keystroke is treated as you having shown up), or the
server closing it because a hook proved you answered elsewhere.

**The attachment receipt** is the one card the app itself raises. It confirms which file
you just attached to the prompt, with a real downscaled image preview where it can decode
one and a typed extension chip otherwise. Unlike every other kind, typing does NOT
dismiss it, because it is a receipt for something staged in the prompt; it is retired
only when the prompt carrying it is actually sent.
id: `.toast[data-kind="Attachment"]`

Screenshot: `toast-attachment-receipt` - the attachment card with a thumbnail.

## Notification history

Screenshot: `toast-history` - the history list with a mix of open and cleared rows.

Mounted inside the settings panel's notifications tab, not a screen of its own.

A single reverse chronological feed, a hundred rows at a time behind a "load older"
button. There are no filters. A row shows the kind as a lowercase word, the session name,
an outcome, the title, an optional body clamped to three lines, and both a relative time
and an exact clock time in its tooltip. Clicking a row jumps to that session and closes
settings.

**Three outcome words, not two.** "open" means still waiting on you and those rows carry
an accent coloured left edge so they stand out, which is the whole reason the list
exists. "dismissed" means a person cleared it, and is also what an unknown reason falls
back to, because not knowing which act cleared something is not evidence it cleared
itself. "answered" means the server cleared it because you typed into that session and
answered it implicitly. Dismissed and answered rows are dimmed.

**Empty state.** "no notifications recorded yet." When the records live only in the
server's memory it says so at more length, so an empty list after a restart never reads
as "nothing ever happened".

## The status pill

Screenshot: `status-pill` - the pill showing a short result message under the header.

One shared, short lived notice reporting the result of an action, centred horizontally
just below the header, up to 80 percent of the screen wide, with the text eliding. It
paints above every other layer in the app, which is the point: it replaced a floating
element the header and any open panel used to paint straight over, so a menu row could
report an error nobody could see.

It stays 5 seconds for an error and 3 seconds otherwise, fading in and out. A new notice
replaces whatever is showing; there is only ever one.
id: `#fabMenuNotice`

It carries connection messages ("reconnecting, attempt N of 5", "reconnection failed
after N attempts", "connection restored, looking up session by name", "session no longer
exists, start a new one from the launchpad", "no network connection on this device,
waiting for it to come back", "no answer from the server, it may be restarting or
unreachable, waiting", "still cannot reach the server, reload once it is back", "network
blip, retrying in 4s"), clipboard and upload results ("uploading...", "upload failed:
...", "pasted from clipboard", "clipboard is empty", "terminal not connected", "copy
blocked by browser, use the system copy shortcut", "paste unavailable on this connection,
use the paste shortcut in the terminal"), copy results ("copied <label>"), touch selection
messages ("select mode, drag to highlight", "nothing selected", "copied", "copy blocked,
use the copy button for a selectable view"), input protection messages ("input dropped,
the session was not ready yet. type it again.", "<what> dropped, you changed sessions"),
and server panel results ("closed <name>", "could not close <name>: <reason>", "server
status unavailable right now").

## The navigation notice strip

Described in full under the Session screen. It is global: it sits above the header on
every screen. id: `#deep-link-error`

## Theme script consent

Screenshot: `theme-consent-modal` - the consent dialog naming a theme, showing all three
buttons.

Every theme can ship an animation script. Before one of those scripts is ever allowed to
run, this dialog asks. It is not opened from any menu; it appears the moment a theme
carrying a script is applied and no settled answer for that exact script is on record.

**Title:** "theme effects script".

**Body, first time:** "theme <name> ships a javascript module (effects.js) that will run
in this page."

**Body, when the script has changed since you allowed it:** "the script in theme <name>
has changed since you allowed it. this is a different effects.js to the one you approved."

**Description, always:** "allow it to run? always allow covers this exact script and
applies on every device. never applies everywhere too, and allow once lasts until you
reload."

**Three buttons:** "never", "allow once", "always allow". The last is styled as the
emphasised action, but keyboard focus deliberately lands on "allow once", the option that
persists nothing.

Three rules a designer should respect. **A refusal always wins**, over a newer approval,
over the bundled theme exemption, over everything. **An approval is bound to the exact
script**, not to the theme's name, so editing the file makes the approval stop matching
and you are asked again about the script that now exists. And **"allow once" is never
stored and never sent anywhere.**

A refusal made on another device closes this dialog while it is open and applies the
refusal.

**When a refusal could not be saved**, the script is still blocked and the user is told
through the status pill: "this theme's script is blocked for now, but the choice could
not be saved. you will be asked again next time." A control that silently forgets a
refusal teaches the user it does not work, which on a consent control is its own defect.

**Note for capture:** all 23 bundled themes carry a script, and bundled themes skip this
prompt unless they have been explicitly refused before. So to see this dialog you need
either a theme the user wrote themselves, or a bundled theme whose recorded decision has
been cleared first. Matrix is a good candidate: it ships a script.

## Confirm dialogs

Screenshot: `confirm-dialog` - a destructive confirmation open over the app.

There is exactly one confirmation dialog implementation in the app, and every destructive
action routes through it, so there is one thing to design. The title renders with a small
leading marker, there is an optional details paragraph, and two buttons whose labels the
caller supplies. Escape, the backdrop and cancel all mean no; only the primary button
means yes. id: `#modal-confirm`, `#modal-cancel`

Every place it is used, with its copy:

| Where | Title | Message |
|---|---|---|
| Logging out | logout | are you sure you want to logout? Details: any active session will be destroyed. |
| File editor, closing a dirty file | discard unsaved changes? | "<file>" has unsaved edits. Buttons: discard / keep editing |
| File editor, revealing a credentials file | show credentials on screen? | "<file>" contains credentials, a secret, or a private key. Buttons: reveal / keep hidden |
| File editor, saving an auto run file | save executable file? | "<file>" is code claude code runs automatically. |
| File editor, saving a credentials file | save credentials file? | "<file>" contains credentials, a secret, or a private key. |
| Archiving a project | archive project | archive "<name>"? Details clarify sessions are not archived and keep working, and the folder on disk is untouched. |
| Removing a model | remove model | remove "<model>" from the provider list? |
| Restarting a live session | replace what is running | restart "<name>" while it is running? Primary: kill and restart |
| Closing a session | close session | Details: this cannot be undone. the running process is terminated, and files uploaded to this session are removed from the project's uploads folder. the transcript is kept. |
| Removing a dead session | remove session | Details: this cannot be undone. this session already exited, so no running process is stopped, but files uploaded to it are removed. the leftover shell is cleared and cloudecode forgets the entry. the transcript is kept. |

**Two exceptions worth knowing.** Naming a new group, renaming a group and confirming a
group deletion all use the browser's own native prompt and confirm, not this component,
so they look like the operating system rather than like the app. So does importing an
example launcher on the settings screen.

## The restart picker

Screenshot: `restart-picker-live` - the restart picker for a running session, showing the
unticked arm checkbox and the disabled options above it.

Lets you relaunch what a session is running, optionally under a different launcher,
without hand editing anything. It is simultaneously the picker and the confirmation: for
a session that is not running there is no second "are you sure", because the panel already
spells out what each choice would do before any click is possible.

Opening it fetches a read only preview that starts nothing, and paints the panel around
the server's honest prediction for every option, including leaving it alone. If that
preview fails, no panel opens at all and the user is told the app could not find out what
a restart would do, rather than being shown a guess.

**Option list.** Always "leave it as it is" first, then one row per configured launcher.
Each row carries a badge naming what it would come back as: would start the agent, would
replay the recorded command, would return a plain shell, still running, its conversation
is gone, cannot be determined, or would build a new session on this record. **A prediction
is never a permission**: a row is only selectable when the server says it is actionable
right now, and the badge never grants the click. An unavailable row is dimmed rather than
hidden, because "you never configured that launcher" and "you configured it but it cannot
run right now" are different facts. id: `.restart-picker__options`

**One shared sentence.** When every row's outcome sentence is identical, it is hoisted once
above the whole list instead of repeated on every row. The most common one: "its
conversation is gone, so nothing below can resume it. a restart starts a new one." The
exact diagnostic behind it folds away behind a disclosure labelled "what was looked for",
because a hover tooltip cannot be opened by a thumb.

**Arm checkbox.** On a session that is currently RUNNING, the options stay locked until you
tick this. Restarting a running session means killing what is in it first. It is drawn
unticked on every render, always, and styled as a warning rather than an ordinary setting.
id: `#restart-picker-live`

**Conversation continuity.** Exactly three sentences, and anything unrecognised reads as the
third, never the reassuring first:

- "it comes back on the same conversation, resumed where it is now."
- "no conversation is recorded for this session, so it comes back without its history.
  what is on screen now is not carried over."
- "whether it comes back on the same conversation could not be determined, so treat its
  history as at risk."

**Live restart confirmation.** Only reachable after arming and picking. Title "replace what
is running", message `restart "<name>" while it is running?`, and a details paragraph that
always opens "this cannot be undone. the process running in this pane is killed and a new
one is started in the same pane. the session keeps its tmux name, its row and its place in
the list, and the transcript is kept." It then adds, where they apply, a warning that the
session has no recorded start command so it will come back as a plain shell, the continuity
sentence above, a caveat if the session currently reads busy, and finally what will be
started. Primary button: "kill and restart".

Screenshot: `restart-picker-confirm` - the live restart confirmation with its full warning.

Screenshot: `restart-picker-dead` - the picker on a session that is not running, with every
option enabled and the prediction badges visible.

**Recreate.** A session whose whole terminal server is gone (after a reboot, say) cannot be
restarted in place. The same panel handles it, driven by a different check that independently
measures whether the session really is absent and refuses when it cannot tell. The user gets
their project, title, theme, unread state and group filing back rather than having to build a
new session by hand. A session whose identity cannot be resolved is never offered this at all.

## Group picker and rename

Both are described under the conversation sidebar. The group picker is a menu, not a dialog.
Rename is always inline in place, never a dialog.

---

# The desktop shell

Cloude Code also ships as a macOS menu bar app. It starts and stops the server, hands you the
address and the sign in code, and is where an install is set up and torn down. Its dialogs are
native macOS alerts, so they are not themed and cannot be styled by the app.

Screenshot: `tray-menu` - the menu bar icon clicked, with the full menu open and the Server
submenu expanded.

The tray icon adapts to a light or dark menu bar automatically. Its tooltip normally reads
"Cloude Code" and briefly reads "OTP copied to clipboard" after copying the code.

The menu, top to bottom:

1. **Run Setup Script** (prefixed with a warning symbol), shown only when setup is definitely
   incomplete, never when that is merely undetermined.
2. Five informational rows, not clickable: the server's state, the current session, how many
   local servers are running, a sessions signal, and an update signal.
3. **Open Terminal Logs**, available only while the server is up.
4. **Settings...**, opening the web settings screen in the default browser.
5. **Open in Browser**, opening the published address.
6. **Bind IP**, a submenu of radio options: localhost only, one per network interface (a
   Tailscale address is labelled as such), and all interfaces.
7. A non clickable row naming the connection's security. Every binding is plain HTTP today, so
   it always reads as not secure.
8. **Copy URL: <address>**, or, when the address could not be measured, a disabled row saying
   so. The app never hands out an address assembled purely from configuration.
9. **Server** submenu, holding: any automatic restart status plus a **Why?** row that opens a
   dialog explaining it; **Restart Server**; **Start Server** or **Stop Server**; **Launch at
   Login** as a checkbox; **Copy OTP: <code>**, which appends "(rolls in N seconds)" when the
   code is about to change; **Check for Updates...**, which is a notifier rather than an
   installer and has three distinct dialogs for available, up to date, and the check did not
   complete (explicitly saying a failed check is not the same as being up to date);
   **Show QR for TOTP**, which opens a small local window for pairing an authenticator app;
   **Edit Config**; a setup or upgrade row; and an **Uninstall** submenu whose one entry,
   **Nuke it from Orbit!** (prefixed with a radiation symbol), requires typing the word NUKE
   into a dialog before it will run, because a button click is not enough for something
   irreversible.
10. **About Cloude Code**, a small native window.
11. **Quit Cloude Code**.

**Take ownership dialog.** Shown when restart or stop is refused because the running server was
not started by this app. It names the process when it can, warns that anything connected through
the browser will be disconnected but that the sessions themselves survive, and offers "Leave it
alone" (the default) against "Restart it anyway" or "Stop it anyway". The destructive choice is
never the default button.

**The first launch pairing window.** The "Show QR for TOTP" entry opens a small local window with
a scannable code for pairing an authenticator app. This is the only pairing surface that exists;
the browser app has none.

---

# Known gaps and rough edges

Facts, from the code and the project's own notes. No opinions on how to fix them.

**Desktop lost three controls when the floating buttons went phone only.** Copying the whole
recent output and attaching a file have no desktop entry point at all, and there is no drag and
drop anywhere. Pasting is covered by the browser's own shortcut.

**The slash command panel is hidden on desktop.** Typing a slash into the terminal reaches the
agent, but without the grouping, descriptions, favourites and filtering the panel gives.

**Four shared settings are only half shared.** The theme, the sidebar row detail, the music
toggle and the last model chosen sync across devices. The sidebar's arrangement, the two panel
pin states and the two fold maps are collected and importable but their controls still read only
from the local browser, so they do not follow you to another device.

**A project's default theme has no control.** A theme can be set globally or pinned to one
session. The per project default exists in the system but nothing in the interface can set it.

**Exporting from the archive cannot download anything.** The dialog runs its integrity check and
then says the download is blocked, on every platform, because the export endpoint accepts only a
credential a browser cannot send.

**A dead session leaves the running list before it appears under recent.** There is a window
where it is in neither.

**Recovering from a "you fell behind" disconnect is correct but not invisible.** When a browser
falls too far behind the output stream the server closes its connection and the browser
reconnects and repaints, but it shows the ordinary reconnect notice and waits a backoff step
while doing it.

**The away bar's full history option is destructive to what is on screen.** It replaces the
visible terminal with a fresh capture, which is warned about but is still the kind of thing a
user presses once and regrets.

**The archive's "by machine" navigation is unreachable.** The drill down through machine and
collection is fully built and still works, but the buttons that used to switch to it were removed
and nothing in the interface reaches it now.

**One module is loaded and never used.** A session detail block that would render a session's
origin, when it was claimed, its project and its working directory is shipped and loaded on every
page, and nothing anywhere calls it. It draws nothing today.

**Group naming, group renaming and group deletion use the browser's own dialogs**, so those three
moments look like the operating system rather than like the app. So does importing an example
launcher.

**The settings tab strip scrolls horizontally even on a wide desktop screen.** Measured at phone
width with the current five tabs it still scrolls by a few dozen pixels, so the last tab is
partly off screen until you swipe.

**The launchers tab names one thing two ways.** The tab is "wrappers" and its section heading is
"launch wrappers", which the help panel has to explain away.

**The startup prompt notification has no icon** where the other three kinds each have one.

**There is no filter or search in the notification history**, and its records live only in the
server's memory, so a restart clears them.

**A secret already configured cannot be cleared from the settings screen.** An empty field means
"leave it alone", and there is no explicit clear action.

---

# Appendix

## Marked uncertain

These are worth checking against real screenshots.

- **No pin control on a home screen session card.** The home card shows a swatch for a theme
  already pinned elsewhere, but nothing on that card pins or unpins anything. Pinning a theme is
  done from the session editor on the Session screen, and pinning a session in the list is done
  from the sidebar.
- **The startup prompt notification's icon.** Every other notification kind has a coloured
  leading mark; no rule for this one was found. It may be deliberate, since its title already
  says "needs a keypress".
- **Whether pinning a session's theme also writes a project level default file.** A comment in
  the client still says it writes both stores; the project's own notes say that changed. Only the
  server can settle it, and it does not change anything a designer draws.
- **Whether the archive still has an entry point from the home screen.** A comment describes one;
  no code was found that would draw it. The header button is the only route found.
- **Whether all six settings import outcomes can appear in one real preview** without seeding
  deliberately invalid values first. Four of the six are easy to produce together.
- **The exact terminal transparency effect** when a theme has an animated background. The rule was
  read but not seen rendered.
- **The row detail control's icon at each of its three modes** was read from the stylesheet but
  not visually confirmed.

## Exists only as a design document

Do not mock these up. They are written down but not built.

- **The alerting state model.** A design for alerting, none of which exists. It deliberately
  disagrees with the shipped status model in two places.
- **Session attribution import.** A design for improving how sessions the launcher itself created
  are reported. Not built.
- **The message browser API and UI documents.** These two are the opposite case and are worth
  stating plainly: they say they are unimplemented and they are wrong. The archive browser
  described in this inventory is fully built and ships; those documents were written before it and
  never updated, and the project's own routing table still repeats their claim. Treat the archive
  screen as real, and treat those two documents as design rationale only.
