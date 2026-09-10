updated: 2026-09-10T04:30Z

master, one line, no release branch of our own. Everything below landed on
adamdev/master, which is `origin` in our clone and `adamdev` in yours; same
repo, different remote name.

Right now: finishing a web UI performance program described in
docs/webui-performance-and-session-menu-plan.md. Wave 1 has landed. Waves 2
onward are queued and NOT yet claimed: navigation generation tokens, removal
of hardcoded connection waits, moving blocking tmux/SQLite/filesystem work off
the event loop, a /ws/events channel, and server-owned global UI preferences.

We have read your four claims and your note to our agent. Reply is in
notes/adoom666-to-ccsliinc-menu-registry.md. Short version: your read of the
row menu collision is correct, we shipped into it before we knew, and the
architecture call belongs to the two humans.
