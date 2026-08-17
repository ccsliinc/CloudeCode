cloude code - read me first
===========================

what this is
------------
cloude code lets you drive claude code sessions from a phone or any browser.
this disk image installs it on a mac and sets it up to start automatically.


before you start - the two things that must already be installed
----------------------------------------------------------------
neither of these can be bundled inside the disk image. the installer checks
for both and refuses to continue if either is missing, telling you the exact
command to run.

  tmux          brew install tmux
                without it, your sessions die every time the server restarts.

  claude cli    brew install --cask claude-code
                or download it from https://claude.com/download

the installer looks in every place these actually live, not just your shell
PATH, because a launchagent starts with almost no PATH at all. for the claude
cli it checks the homebrew cask at /opt/homebrew/Caskroom/claude-code/, then
~/.local/bin/claude, then ~/.claude/local/claude. the two macs this was built
against differ, and both shapes work.

you also need git and a working network connection. see "how upgrades work"
below for why.


how to install
--------------
1. double-click "Install Cloude Code.command".
   macos will open a terminal window. that is expected - you should be able
   to watch every step. nothing happens silently.

2. gatekeeper will very likely stop you the first time. see the section
   further down. it is a real thing you will hit, not a maybe.

3. answer three questions. each has a safe default you can accept by
   pressing return:
     host    which address the server listens on. 127.0.0.1 means this mac
             only, which is the right answer unless you know otherwise. a lan
             address such as 10.0.1.150 makes it reachable from your phone on
             the same network. 0.0.0.0 is every interface - only do that
             behind a tunnel.
     port    8000 by default.
     remote  which repository releases come from. see below.

4. wait. the installer clones the code, builds a python environment, installs
   dependencies, generates your secrets, installs the background service and
   then proves the server actually answers before it tells you it worked.

5. when it finishes it prints the url to open and the command to pair your
   authenticator app.

if anything fails, it stops and tells you what to fix. it does not leave a
half-finished install behind.


where things end up
-------------------
  ~/.cloude-code/app        the code, a git checkout parked on a release tag
  ~/.cloude-code/bin        install, upgrade and rollback scripts
  ~/.cloude-code/backups    one dated snapshot per upgrade
  ~/.cloude-code/state      logs and, in future, the datastore
  ~/Library/LaunchAgents/com.imc.cloude-code.plist

backups deliberately live OUTSIDE the code checkout. an earlier version of
this project shipped a config backup that had been committed by accident and
published the author's real directory paths across five public releases.


why it is a user launchagent, and not a system daemon
------------------------------------------------------
this is the single hardest constraint in the whole project, so it is worth
stating plainly.

the claude cli stores its credentials in the macos login keychain. the login
keychain is unreadable from outside a logged-in gui session. a launchdaemon
runs as root with no login keychain, so claude simply cannot authenticate
there - not with a workaround, not with a flag.

so the service is a USER launchagent, bootstrapped into gui/<your uid>. the
practical consequences:

  - you must be logged in to the desktop for cloude code to run. it does not
    run at the login window, and it does not run while logged out.
  - if the mac reboots, it comes back when you log in, not before.
  - if the mac has filevault on, that means after you unlock the console.

the plist deliberately does NOT set SessionCreate. that key reads like it
grants a session; it actually creates a brand new security session with no
access to the login keychain, which is exactly the failure this constraint
exists to avoid.


secrets
-------
your totp secret and jwt secret are generated on your machine at install
time. nothing secret ships inside this disk image, and nothing secret is ever
uploaded anywhere.

they are written to ~/.cloude-code/app/.env with mode 600. do not commit that
file, do not copy it between machines, and if you think it leaked, delete it
and re-run the installer to get fresh ones.


how upgrades work, and the one thing to understand about them
--------------------------------------------------------------
a release is a GIT TAG. an install is always parked on a specific tag, so the
version you are running is exact and reproducible, and going back is simply
checking out the previous tag.

  THE DISK IMAGE DOES NOT CONTAIN THE CODE.

it contains the installer, the artwork and this file. install.sh CLONES the
repository at the chosen release tag. that means:

  - you need git and network access at INSTALL time, not just at upgrade
    time. there is no offline install.
  - once installed, you already have a clone, so the upgrade path has
    everything it needs. there is no "installed from the disk image but no
    repository" state to get stuck in.

to upgrade:

  ~/.cloude-code/bin/upgrade.sh              go to the newest release
  ~/.cloude-code/bin/upgrade.sh --tag v0.9.0 go to a specific one

it checks everything first, then backs up your config, your .env and your
state BEFORE anything moves, then swaps the code, restarts the service and
proves it is healthy at the address it actually binds. if it does not come
back healthy it puts the previous version AND its matching state snapshot
back, together, restarts, and tells you it rolled back and why. running it
when you are already current is a no-op that says so.

to go back on purpose:

  ~/.cloude-code/bin/rollback.sh --list      see what you can go back to
  ~/.cloude-code/bin/rollback.sh             go back one release
  ~/.cloude-code/bin/rollback.sh --tag v0.8.1

rollback restores the code and its matching state together and refuses a
mismatched pair unless you pass --force. once a datastore exists, its schema
will move with the code, so restoring one without the other would corrupt it.


which repository do releases come from
---------------------------------------
two are legitimate:

  https://github.com/ccsliinc/CloudeCode.git    the fork this build tracks
  https://github.com/Adoom666/CloudeCode.git    the public upstream

the installer defaults to the fork and lets you change it at install time.
whatever you choose is what the app's own update check consults later, so the
check and the upgrade always agree about where code comes from. to change it
afterwards, add this to ~/.cloude-code/app/config.json:

  "updates": { "remote": "https://github.com/Adoom666/CloudeCode.git" }


the app tells you when a new release exists
--------------------------------------------
the running app checks the release tag list in the background, never on a
page load, and shows one of three things:

  up to date (v0.8.1)
  update available: v0.9.0 - run: ~/.cloude-code/bin/upgrade.sh
  could not check for updates - <the reason>

that third one is its own state on purpose. "i could not look" is not the
same as "nothing is wrong", and it will never be shown as if it were. each
line also says when it was last checked, so a stale answer looks stale.

it will never upgrade itself. pulling code out from under a running agent
session unattended is not acceptable. it offers the command; you run it.


gatekeeper - what you will actually see
----------------------------------------
this disk image is NOT code signed and NOT notarized. saying otherwise would
be a lie, so: it is not.

what that means in practice, the first time:

  - the disk image itself will mount without complaint.
  - double-clicking "Install Cloude Code.command" will produce a dialog
    saying macos cannot verify the developer.
  - to get past it: right-click (or control-click) the file, choose Open,
    then confirm Open in the dialog that follows. the plain double-click has
    no override button; the right-click Open path does.
  - on newer macos versions you may instead need to open
    System Settings > Privacy & Security, scroll to the bottom, and click
    "Open Anyway" next to the blocked item.

you only have to do this once per download.

fixing it properly requires an apple developer id certificate (a paid
account), signing the scripts and the image with codesign, and submitting the
image to apple's notary service. none of that is done here, and it is worth
knowing that the shell scripts on this image are plain text - you can read
every line of them before running any of it, which is a better guarantee than
a signature.


if something goes wrong
-----------------------
  logs                ~/.cloude-code/state/logs/launchd.err
  is it running       launchctl print gui/$(id -u)/com.imc.cloude-code
  restart it          launchctl kickstart -k gui/$(id -u)/com.imc.cloude-code
  what is installed   cat ~/.cloude-code/install.json

if the web page does not load, check the HOST value in
~/.cloude-code/app/.env first. the server binds only that address, so if it
is set to a lan address then http://localhost:8000 will not answer even
though everything is completely healthy. that specific false alarm has cost
real time before.


open questions, stated rather than hidden
------------------------------------------
  - the datastore does not exist yet. the backup and restore paths already
    treat code and state as a pair and snapshot ~/.cloude-code/state, so
    adding one should not need the scripts rewritten, but that is untested
    until it exists.
  - the installer does not manage the totp pairing for you. it prints the
    command; you run it and scan the qr code.
  - there is no uninstaller yet. removing ~/.cloude-code and the plist from
    ~/Library/LaunchAgents, after a launchctl bootout, is the whole job.
