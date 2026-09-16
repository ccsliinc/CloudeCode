# dev preview harness

SCAFFOLDING. Not the archive screen, not slice 3, not a contract.

## what it is

`NavRail` (slice 5) and `TranscriptList` (slice 6) were both built
shell-independent, because Adam is replacing the whole application shell
(issue #175). That was the right call and it left two finished components
nobody could click. This directory mounts BOTH against the REAL archive
API and wires the one interaction neither can show alone: picking a
project in the rail drives the listing in the list.

## how to run it

From `web/`, with CloudeCode already running on `127.0.0.1:8000`:

    npm install        # first time only
    npm run dev:harness

Open <http://localhost:5174/>, type the six digit code from your
authenticator, and browse. Point it at another install with
`CLOUDE_HARNESS_API=http://host:port npm run dev:harness`.

## what you can do on it

- the merged project list, real, ordered, with the fuzzy project filter
- a project's details modal off the `i` button, Escape closes it
- click a project: its transcripts load in the right pane
- the scheme dropdown (`My sessions`), which re-queries the SERVER
- the three name / ref / date filter boxes, which filter in the BROWSER
  over loaded rows only, with match highlighting
- `Load 50 more`, paging by the server's opaque cursor
- row virtualisation against the right pane, which is the scrollport

Clicking a transcript logs a line and opens nothing: the reader is slice
7 and is not built.

## what it deliberately does not do

No auth is disabled and no bypass exists. The login posts a real TOTP
code to the real `POST /api/v1/auth/verify` and keeps the access token in
`sessionStorage`, per tab, never logged and never committed. The refresh
token is dropped on purpose, so an expired session shows the login panel
again rather than refreshing against a credential a scaffold kept.

## when the real shell lands

    mv web/dev-harness ~/.Trash/

then drop `web/vite.dev-harness.config.ts`, the `dev:harness` script, the
two `dev-harness` entries in `tsconfig.json` and
`web/src/dev-harness-isolation.test.ts`. Nothing under `web/src/` imports
any of it, which that test is what proves.
