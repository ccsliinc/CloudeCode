# Session attribution and the 1.0 import

Status: DESIGN, not implemented. Written 2026-08-21 against `run/live` `82198e0`.
Measured on the live mac-mini-m4 install (read-only).

The user's report: "we also need to determine why the launcher thinks any are
external. every one of them were opened via launcher. we need a better way to
import. this will be important when releasing 1 for old users."

---

## Part 1 - what is actually wrong

### The root cause

**`origin='created'` has no write site. The launcher's create path never
records a session row at all.**

`SESSION_ORIGIN_CREATED` (`src/core/db_models.py:145`) appears in exactly two
functional places in `src/`: its own definition (plus membership in two
validation tuples), and `session_store.observed_origin_for`
(`src/core/session_store.py:325`), which is called only from the one-time
first-run import. No runtime path writes it.

`SessionManager.create_session` records ownership in exactly two places
(`src/core/session_manager.py:2060-2067`):

1. `self.owned_tmux_sessions.add(owned_name)` - in-memory only.
2. `self._save_session_metadata(new_session)` - `session_metadata.json`.

It writes no row to the `sessions` table.

The `sessions` table is the authority for the badge. `models.py:346-353` says
so explicitly, and `session_store.owned_instances` (`:187`) builds the owned
set with `WHERE origin IN (created, adopted)`. A session with no row, or a row
with `origin='observed'`, is not in that set. `resolve_ownership`
(`src/core/tmux_listing_parse.py:296`) then falls through to tier 3, the
legacy in-memory name set, and returns False - **EXTERNAL** - when that set is
empty.

So a launcher-created session is OURS only for as long as the process that
created it stays alive AND nothing else writes a row for it. Two things
routinely do:

- `session_adopt_persist.persist_adoption` writes
  `origin=SESSION_ORIGIN_OBSERVED` first (`:276`) and only then claims it.
- the first-run import writes `observed_origin_for(name, owned)`, which is
  `observed` whenever the legacy owned set does not hold the name.

### The measurement that proves it

The live DB (`~/Library/Application Support/CloudeCode/cloude.db`, copied and
read read-only):

| origin | count |
|---|---|
| `observed` | 5 |
| `adopted` | 5 |
| `created` | **0** |

Ten sessions. Not one carries `created`. The five `observed` rows are exactly
the ones the launcher badges EXTERNAL.

The sharpest single row is id 10, `cloude_test or`:

```
created_at  2026-08-20T16:51:59.286178Z
adopted_at  2026-08-20T16:51:59.286972Z
origin      adopted
```

That session was made **after** the import latch was stamped, and its first
recorded state was still not `created`. It was written `observed` and flipped
to `adopted` 794 microseconds later, by the adopt path. There is no code that
could have written `created` for it.

### `session_metadata.json` does not exist on this install

A `find` across the whole home directory on the mini returns nothing for
`session_metadata*`. Not in `LOG_DIRECTORY`, not in the state dir, no stale
twin at the old location.

That empties tier 3 of `resolve_ownership` permanently, which is what turns
"the DB has no positive opinion" into "EXTERNAL" rather than into a fallback
that happens to be right.

**It was written, and then unlinked. Four times.** This was the open question
("never written" vs "written then destroyed") and the logs answer it directly.
Event counts in `~/Library/Logs/cloude-code/launchd.log`:

| event | count |
|---|---|
| `session_metadata_loaded` | 4 |
| `stale_session_metadata_deleted` | 4 |
| `session_metadata_slug_not_in_backend` | 4 |
| `no_existing_session_metadata` | 3 |
| `failed_to_save_session_metadata` | 0 |
| `failed_to_load_session_metadata` | 0 |
| `session_metadata_slug_not_owned` | 0 |
| `session_backend_attach_failed` | 0 |
| `session_backend_cannot_rehydrate` | 0 |

The timeline is the same shape all four times, roughly 40ms apart:

```
2026-08-19T17:58:29.677708Z  session_metadata_loaded
2026-08-19T17:58:29.719190Z  stale_session_metadata_deleted
2026-08-20T13:54:59.549413Z  session_metadata_loaded
2026-08-20T13:54:59.589995Z  stale_session_metadata_deleted
2026-08-20T14:26:31.657524Z  session_metadata_loaded
2026-08-20T14:26:31.671888Z  stale_session_metadata_deleted
2026-08-20T16:51:55.886161Z  session_metadata_loaded
2026-08-20T16:51:55.926682Z  stale_session_metadata_deleted
2026-08-20T17:04:38.974069Z  no_existing_session_metadata
2026-08-20T17:08:14.265246Z  no_existing_session_metadata
2026-08-21T19:21:00.958221Z  no_existing_session_metadata
```

Every start that successfully loaded the file deleted it milliseconds later,
and after the fourth it never came back.

Three things this rules out, so the 1.0 story does not have to hedge:

- **Not "never written".** `session_metadata_loaded = 4` - it existed and
  parsed.
- **Not "written somewhere unwritable".** `failed_to_save = 0`,
  `failed_to_load = 0`, no `.tmp` orphan on disk, and the two sibling files
  written through the same `_resolve_state_file` + `_write_metadata_atomic`
  mechanism (`pinned_themes.json`, `unread_state.json`) are both present in
  the state dir. That is a positive control: the resolver resolves and the
  directory is writable.
- **Not "a third path from an older version".** `log_directory` is unset in
  `config.json`, so `_resolve_state_file` returns the state-dir path at
  `src/config.py:631-632` without ever evaluating a fallback branch. There is
  only one path it could have been at.

The trigger is the ordinary case, not an error. All four deletions were
preceded by `session_metadata_slug_not_in_backend` and by none of the four
error branches: the last-active tmux session was simply gone by the next
start. So **on a normal restart, the app deletes the ownership record for
every session in order to discard one dead pointer.**

Two mechanisms in the current code produce that absence, and both are real:

- `_clear_stale_metadata` (`session_manager.py:837-855`) **unlinks the whole
  file** when one session cannot be re-adopted. The file is the only home of
  the owned set for every other session too, so one unre-adoptable session
  discards ownership for all of them.
- `_save_session_metadata` (`:974-985`) opens with
  `sess = session or self.current_session(); if not sess: return`. The owned
  set is persisted only as a rider on a session payload, so with no current
  session the set is never written back.

### Ranking against the four candidates in the brief

| # | Candidate | Verdict |
|---|---|---|
| - | **`origin='created'` never written (fifth cause)** | **TRUE. Sufficient alone.** |
| 1 | `session_metadata.json` relocates / stale twin | **TRUE in its most extreme form, but not by the relocation mechanism.** The file is *absent*, not relocated - no twin exists anywhere on the machine. It was written, loaded 4 times, and unlinked 4 times by `_clear_stale_metadata` on ordinary restarts. Sufficient alone to empty tier 3. **FIXED** - see "the fix that landed" below. |
| 2 | The one-time import latch | TRUE. `meta.sessions_imported_at = 2026-08-18T18:41:13.152941Z`, `sessions_imported: 9`. All nine landed `observed` because the owned set handed in was empty. The latch means that is permanent. Sufficient alone to explain why the five stuck rows never self-heal. |
| 3 | tmux session ids not durable | FALSE, already defended. Identity is `(tmux_socket, tmux_name, tmux_created_epoch)` via `ux_sessions_tmux_instance`. `tmux_session_id` (`$N`) is stored but is not the key. |
| 4 | Failed probe wiping ownership | FALSE, guard is reachable. `lifespan_startup` returns before any prune on `not listing.ok` (`session_manager.py:663-676`). `session_adopt_persist:213` and `session_lifecycle:410` carry the same gate. No DB path downgrades an existing `origin`. |

**Three are simultaneously true (root cause, 1, 2). Each of the three is
independently sufficient to make a launcher-created session read EXTERNAL.**
Fixing only the metadata file, or only the import, leaves the badge wrong,
because the authority still never learns the word `created`.

### What is recoverable for an upgrading user, and what is not

This is the 1.0 question, so it is worth being exact.

**Recoverable, from evidence that already exists on disk today:**

The app already writes a per-session pipe file into `LOG_DIRECTORY` and
**already encodes its own ownership verdict in the filename**
(`tmux_backend._resolve_pipe_path`, `:313-335`):

- `tmux_<session_id>.pipe` is written only when `_is_external` is False - a
  session this app CREATED.
- `tmux_ext_<slugified tmux name>.pipe` is written only for an external or
  adopted backend.

On the mini right now:

```
tmux_ses_3529a738.pipe                  created by us
tmux_ext_cloude_console-msw4z3m5.pipe   external/adopted
tmux_ext_cloude_fs2.pipe                external/adopted
tmux_ext_cloude_fstest.pipe             external/adopted
tmux_ext_cloude_ses_ec5bf2a3.pipe       external/adopted
```

That last filename is the whole bug in one line: `ses_ec5bf2a3` is the app's
own auto-generated session-name form, so that session was created by the
launcher and is now recorded as external.

This is the strongest recoverable evidence available, because the app wrote it
about its own behavior, it is durable across restarts, and it is already
present on every existing user's machine. Its limit is asymmetric and must be
stated: the **`ext_` side maps cleanly** back to a tmux name (the slug *is* the
name). The **created side does not** - its slug is the internal session id, and
recovering the tmux name from it needs `session_metadata.json`, which may be
gone. Where the app auto-named the tmux session (`cloude_ses_<hex>`) the id is
embedded in the name and the mapping is recoverable; where the user typed a
name, it is not.

**Not recoverable:**

- **tmux session environment.** The obvious idea - read a `CLOUDECODE_*`
  marker back with `show-environment` - does not work for existing created
  sessions. `set-environment` is called only on the **adopt** path
  (`session_manager.py:3718-3724`). On the create path the vars go into the
  spawn environment, and `tmux_backend.py:495-507` documents why that is
  discarded: when a tmux server is already running, a new session inherits the
  *server's* global environment and the client's is thrown away. Only `LANG`
  travels via `-e`. So the marker is present on adopted sessions and absent on
  created ones - the exact inverse of what attribution needs.
- **Anything the fix sets at creation time.** By definition it cannot apply to
  a session that already exists. This is the core of the upgrade problem and no
  design makes it go away.
- **`session_created` epoch, working directory, name prefix.** All durable,
  none of them evidence of authorship. Every session on the socket is
  `cloude_*` because that is the socket the launcher uses; the user's own
  `tmux -L cloude` session would look identical.

---

## Part 2 - the import design

### The constraint that shapes everything

A session absent from the owned set because it was never recorded, and a
session absent because it genuinely belongs to someone else, **are the same
shape to a set difference.** No comparison of `live_names` against `owned` can
tell them apart. Guessing "ours" claims a stranger's terminal; guessing
"theirs" disowns the user's work and is what is happening today.

So the design does not try to make the set comparison smarter. It does three
separate things: **stop creating the ambiguity**, **read the evidence that
already exists**, and **ask the user about the residue**.

### Stage A - close the hole (all future sessions)

1. **`create_session` writes its row.** `record_instance(origin='created')`
   with the socket, name and `#{session_created}` epoch, in the same
   transaction shape `persist_adoption` already uses. This is the missing
   write site and it is the whole root cause. Everything else in this document
   is cleanup for sessions that predate it.
2. **The owned set stops being a rider on a session payload.** Move it to its
   own file, alongside `pinned_themes.json` and `unread_state.json`, which
   already solved this exact problem for the same reason (`session_manager.py:
   268-274` says so in as many words). Consequences: no early return when
   there is no current session, and `_clear_stale_metadata` can no longer
   discard N sessions' ownership to clean up one.
3. **Stamp a durable marker at creation.** `tmux set-environment -t <name>
   CLOUDECODE_ORIGIN created` immediately after `new-session`, plus the
   install id. This is belt-and-braces for the case where the DB is lost but
   tmux survives. It helps only future sessions, and that is fine - it is
   cheap and it makes the *next* migration trivial.

### Stage B - evidence-based import (existing sessions)

Replace the current single-tier import with an explicit evidence ladder. Each
live tmux session on our socket resolves to exactly one of **OURS**,
**THEIRS**, or **UNKNOWN**. Never a default.

| Tier | Evidence | Proves | Does not prove | Forgeable? |
|---|---|---|---|---|
| 1 | `owned_tmux_sessions` in `session_metadata.json` (v3 schema) | OURS | anything when the file is missing | no - our file, our dir |
| 2 | `tmux_ext_<name>.pipe` exists in `LOG_DIRECTORY` | **nothing admissible.** Only that the app *already believed* this was external | authorship, in either direction | no, but see below |
| 3 | `tmux_<slug>.pipe` where slug maps to a live tmux name | OURS | anything when the name was user-typed (slug is the internal id) | no |
| 4 | tmux env `CLOUDECODE_ORIGIN` | OURS, on post-Stage-A sessions only | anything on an existing session | trivially, by the user |
| 5 | Name matches `cloude_ses_[0-9a-f]{8}` (our auto-name form) | *suggests* OURS - only the app generates that form | authorship; a user could type it | trivially |
| 6 | cwd is a configured project root | nothing | - | trivially |

Tiers 1 through 3 are admissible as proof. **Tier 4 is admissible only for
sessions created after Stage A ships**, and the import must know that - a
`CLOUDECODE_ORIGIN` on a session whose epoch predates the install's Stage-A
upgrade is evidence of nothing and must be ignored, not trusted. Tiers 5 and 6
are **display hints only**: they order and annotate the UNKNOWN list, they
never decide it. Writing tier 5 into `origin` would be exactly the invented
verdict this codebase keeps re-learning not to write.

**Tier 2 is a trap and this document originally got it wrong.** An `ext_` pipe
records the app's *own verdict at the time* - and that verdict was produced by
the bug under investigation. Treating it as evidence of THEIRS would launder
the defect into the migration that exists to correct it, and it would do so
invisibly, because the file looks like an independent measurement.

The correlation on the live install makes the point better than the argument
does. `~/Library/Logs/cloude-code/` holds five `ext_` pipes dating from Aug 17:

```
tmux_ext_cloude_Test.pipe
tmux_ext_cloude_asd.pipe
tmux_ext_cloude_claude-config-sync-2.pipe
tmux_ext_cloude_scrolltest.pipe
tmux_ext_cloude_test_pause.pipe
```

Those are, exactly and only, the five DB rows still sitting at
`origin='observed'` today - `cloude_Test`, `cloude_asd`,
`cloude_claude-config-sync-2`, `cloude_scrolltest`, `cloude_test pause`. Five
for five. The DB did not exist until Aug 18; the `ext_` verdict predates it by
a day. So the DB did not decide these were external - **it inherited a verdict
the pre-DB code had already made for the same reason, and the import then made
it permanent.**

That is also the honest answer to "every one of them were opened via
launcher": the app has been calling them external since Aug 17, so its own
records cannot corroborate him. They also cannot contradict him, because the
records were generated by the broken path. This is precisely a
could-not-evaluate, and it is why these five belong in the UNKNOWN list rather
than being auto-resolved in either direction.

The one thing tier 2 *is* good for is the both-pipes case. A session with both
a `tmux_<id>.pipe` and a `tmux_ext_<name>.pipe` was created by the app and
later re-adopted - `cloude_ses_ec5bf2a3` on this install has exactly that pair
(`tmux_ses_ec5bf2a3.pipe` from Aug 16 alongside `tmux_ext_cloude_ses_ec5bf2a3.pipe`).
There the *created* pipe carries the proof and the `ext_` pipe merely explains
the history. Record it OURS with reason `re-adopted`, on the strength of
tier 3, never on tier 2 alone.

### Stage C - the third state, surfaced

Everything that reaches the bottom of the ladder is written
`origin='observed'` **and** recorded in a new `meta` key,
`session_import_unattributed`, as a list of `{tmux_name, epoch, hints,
reason}`.

The home screen then shows, once, dismissibly:

> **5 sessions we could not attribute.** These were running on the `cloude`
> socket when Cloude Code upgraded, and we have no record of whether we
> started them. Adopting a session lets Cloude Code manage it; it does not
> change or restart anything inside it.
>
> `cloude_fs2` - started Aug 19, `~/Development/scrolltest` - *name matches our
> auto-generated form*
> `cloude_test pause` - started Aug 19, `~/Development/ses_ec5bf2a3`
> ...
>
> [ Adopt all ] [ Choose individually ] [ Leave as external ]

What is **decided for the user**: anything tiers 1 through 3 prove. Those are
imported as OURS silently, with the tier recorded in `lifecycle_source` so the
decision is auditable afterwards.

What the user is **asked**: everything else, itemised, with the hint spelled
out in words rather than folded into a score. "Leave as external" is a real
answer that is remembered - it writes `observed` plus a
`user_declined_at` stamp so the prompt does not return every boot.

Adopting from this prompt goes through the existing `persist_adoption` path,
so it is `adopted`, not `created`. That distinction is honest: we did not
create it *as far as we can prove*, we claimed it. Design 4.6 already says an
adopted session is ours for good, so the badge is right and no fact is
invented.

### Stage D - make the latch re-runnable, safely

The current latch is one-way and the brief's candidate 2 is the consequence:
an import that ran with no evidence is permanent. It must not simply be
re-run - the user's "leave as external" answers have to survive.

Proposal: version the latch. `sessions_imported_at` gains
`sessions_import_evidence_version`. A build that adds a new admissible tier
bumps that version and re-runs the ladder, but **only over rows still at
`origin='observed'` with no `user_declined_at`**. A row that is already OURS is
never re-examined and never downgraded; a row the user explicitly declined is
never re-asked. So a later, better import can promote but never demote, which
is the only direction that is safe without asking again.

### What this does not fix

Say it plainly to the user at 1.0: **for a session that already exists, was
given a name you typed, and whose `session_metadata.json` is gone, there is no
evidence anywhere on the machine that Cloude Code created it.** The pipe file
that would have proved it is keyed on an internal id we can no longer map to a
name. Those sessions land in the UNKNOWN list and the user answers for them
once. That is the correct outcome, and it is a better one than either silent
default.

### The fix that landed with this document

Only one thing was implemented, because only one thing was small and
unambiguous: **`_clear_stale_metadata` no longer destroys the owned set.**
It still unlinks the resolved path (so the state-dir relocation semantics that
`tests/test_session_meta_continuity.py` measures are untouched), then re-writes
an owned-set-only payload through the same atomic writer.
`_load_session_metadata` reads a payload with no `id` by loading the owned set
and rehydrating no session - so the dead pointer stays dead and still surfaces
in the Adopt list, which the second test asserts.

`tests/test_owned_set_survives_stale_clear.py` went RED first on the ownership
assertion while its control test passed, then green after the change. Full
suite: 2321 passed, 1 skipped, 0 failed.

This closes the destruction, not the root cause. `origin='created'` still has
no write site, so the badge is still wrong for created sessions until Stage A
ships. Do not read the green suite as "session attribution is fixed".

### Test obligations

- A RED-first test that `create_session` writes `origin='created'`, asserting
  against `owned_instances()`, not against the in-memory set.
- The ladder, tier by tier, including the both-pipes re-adopt case.
- A test that a tier-4 `CLOUDECODE_ORIGIN` on a pre-Stage-A epoch is ignored.
- A test that the versioned re-run promotes an `observed` row and refuses to
  touch an `adopted` one or a declined one.
- An upgrade fixture reproducing this machine's exact state: 9 live tmux
  sessions, no `session_metadata.json`, empty owned set. Today that fixture
  produces 9 EXTERNAL. It must produce 0 EXTERNAL and 9 UNKNOWN-prompted, or
  better where pipe evidence exists.

### Three-outcome audit

| Question | pass | fail | could not evaluate |
|---|---|---|---|
| Did we create this session? | tier 1-3 hit | tier 2 `ext_` only, no created pipe | `session_import_unattributed`, surfaced to the user |
| Is the tmux listing readable? | `listing.ok` | - | `IMPORT_PENDING_LISTING_UNAVAILABLE`, latch left unset (already correct today) |
| Is the owned-set file readable? | parsed | - | tier 1 skipped and **recorded as skipped**; today an unreadable file is silently the same as an empty one |

That last row is the one the current code gets wrong and is worth calling out:
`_load_session_metadata` logs `no_existing_session_metadata` and moves on with
an empty set. Empty and unreadable then produce identical behaviour, and the
identical behaviour is "everything you made is external."
