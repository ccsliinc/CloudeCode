"""Which tmux sessions this app created, and the file that remembers it.

Slice S3 of ``.claude/notes/backend-decomposition-plan.md``. This module
holds ``OwnedTmuxLedger``, the single owner of ``owned_tmux_sessions`` -
the set of full tmux session names Cloude Code itself created - together
with ``session_metadata.json``, which is that set's only durable home,
and the two ownership queries answered from ``cloude.db``.

**OWNERSHIP IS THE BADGE, AND A WRONG ANSWER IS SPOOFABLE.** The set
exists so the UI can tell OUR sessions apart from the user's own tmux
sessions on the same ``-L cloude`` socket, without falling back to a
prefix match on the name, which anybody can imitate by naming a session
``cloude_anything``. Everything here is therefore keyed on a name this
app RECORDED, or on an instance triple the datastore RECORDED, and never
on the shape of a string.

**THE SET IS ALSO THE FILE, AND THE FILE ALSO HOLDS A SESSION POINTER.**
``session_metadata.json`` carries two unrelated things: the owned set,
which is about EVERY session this app created, and one session's row,
which is about the single most-recently-active one. Unlinking the file to
discard a dead pointer threw away N sessions' ownership record to clean
up one, and the trigger was the ORDINARY case rather than an error path.
``drop_session_pointer`` is what keeps them apart: the pointer dies, the
set is re-written.

**THE WRITE IS ATOMIC AND IT MATTERS.** ``write_atomic`` is the tmp plus
``fsync`` plus ``os.replace`` protocol, and it is the reason a crash
mid-write cannot leave a zero-byte file where the ownership record was.
``tests/test_owned_tmux_ledger.py`` mutates that protocol away and
measures the result rather than trusting the reading.

**NOTHING HERE IMPORTS ``settings`` OR ``session_manager``**, per the
package rules in ``tests/test_sessions_package_rules.py``. The metadata
path arrives as a zero-argument callable resolved at CALL time, which is
the same shape ``ThemeStore`` takes its pin path in and for the same
measured reason: the suite redirects state away from the owner's real
``~/.cloude-sessions`` by patching the ``settings`` NAME inside the
``session_manager`` module, and a module that imported ``src.config``
itself would be invisible to every one of those patches and would read
and write the owner's live files during a plain pytest run.

**THE SOCKET ARRIVES THE SAME WAY, AND THAT IS NOT SYMMETRY FOR ITS OWN
SAKE.** ``SessionManager._tmux_socket_name`` resolves the configured
value and then lets the PROBED socket win over it, because a row is
written keyed on the socket the adopt path saw and read back keyed on
whatever the badge asks for; if those two ever differ, the badge is
answered from a socket nothing was written to and every adopted session
reads as external. That preference is the manager's to express, so this
class asks for the answer rather than deriving one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable, Optional

import structlog

from src.core.sessions.ports import SessionRecordStore

logger = structlog.get_logger()


class MetadataLoad:
    """What one read of ``session_metadata.json`` found, as a value.

    Description: the ledger applies the owned-set half to itself and hands
      the SESSION half back, because rehydrating a session means
      registering it with backends and subscribers, which is the
      manager's job and not this class's. Returning a value rather than
      invoking a callback keeps the parse testable with no manager in
      the room.
    Inputs: session (dict | None) - the persisted session's raw fields,
      ready for ``Session(**session)``; None when there was no file, no
      pointer, or the read failed. owned_count (int) - how many names the
      ledger now holds, for the caller's log line.
    Output: none, it is a record.
    Example: ``load = ledger.load(); if load.session: ...``

    ``session is None`` deliberately covers three different situations -
    no file, an owned-set-only payload, and a read that raised - because
    every caller does the same thing with all three: register nothing.
    The distinction that MATTERS is recorded in the log, and in whether
    the owned set moved.
    """

    __slots__ = ("session", "owned_count")

    def __init__(self, *, session: Optional[dict[str, Any]], owned_count: int) -> None:
        """Bind the two halves of one metadata read.

        Inputs: session (dict | None), owned_count (int).
        Output: None.
        Example: MetadataLoad(session=None, owned_count=3)
        """
        self.session = session
        self.owned_count = owned_count


class OwnedTmuxLedger:
    """Owns the owned-tmux-name set, its file, and the ownership queries.

    Description: ``SessionManager`` holds one of these and keeps NO copy
      of the set. Every reader and every writer inside the manager
      reaches ``ledger.names`` itself, so the two can never disagree. Two
      objects holding one logical set and kept in sync by hand is the
      shape of the bug that produced 22 ``/sessions/list`` rows for 21
      live panes.
    Inputs: metadata_path (Callable[[], Path]) - where
      ``session_metadata.json`` lives, resolved at each call so a test
      that moves the state directory is followed. records
      (SessionRecordStore) - how ``cloude.db`` is reached. socket_name
      (Callable[[], str]) - the tmux socket stored instance triples are
      keyed on, resolved at each call for the same reason.
    Output: none.
    Example: OwnedTmuxLedger(metadata_path=reader.session_metadata_path,
      records=store, socket_name=manager.tmux_socket_name)

    THE THREE PIECES OF STATE ARE HERE FOR THREE DIFFERENT REASONS and
    are not interchangeable. ``names`` is the durable record.
    ``needs_legacy_backfill`` is a one-shot upgrade sentinel for a pre-v3
    file that has no owned set in it at all. ``boot_listing`` is neither
    durable nor a sentinel: it is the tmux listing the boot reconcile
    measured, held so the re-adopt pass that runs after it can be GATED
    on a probe having actually answered. It sits here because the only
    thing it is ever used for is deciding what may be claimed as ours.
    """

    def __init__(
        self,
        *,
        metadata_path: Callable[[], Path],
        records: SessionRecordStore,
        socket_name: Callable[[], str],
    ) -> None:
        """Bind the ledger to its file, its datastore and its socket.

        Inputs: metadata_path (Callable[[], Path]), records
          (SessionRecordStore), socket_name (Callable[[], str]). All
          keyword-only and all required: a default on any of them would
          be a second way to find the same thing.
        Output: None.
        Example: OwnedTmuxLedger(metadata_path=lambda: tmp / "m.json",
          records=store, socket_name=lambda: "cloude")
        """
        self._metadata_path = metadata_path
        self._records = records
        self._socket_name = socket_name

        #: Full tmux session names this app created, e.g.
        #: ``cloude_myproject``. Populated by ``create_session`` before it
        #: returns, pruned by ``destroy_session``, reconciled at boot.
        self.names: set[str] = set()

        #: True only while a pre-v3 metadata file has been read whose
        #: payload carried no ``owned_tmux_sessions`` at all. The active
        #: slug is then treated as owned for ONE rehydrate and the new
        #: schema is written on the first successful save, so an upgrade
        #: cannot strand an in-flight session.
        self.needs_legacy_backfill: bool = False

        #: The boot tmux listing, set ONLY past the ``listing.ok`` gate.
        #: None means the probe never answered and nothing may be claimed.
        self.boot_listing: Any = None

    # ---- the file -------------------------------------------------------

    def path(self) -> Path:
        """Where ``session_metadata.json`` is right now.

        Description: resolved on every call rather than cached, because
          the state directory moves under a test and relocates itself out
          of the legacy log directory on the next write.
        Inputs: none.
        Output: Path.
        Example: ledger.path().exists()
        """
        return self._metadata_path()

    def write_atomic(self, data: dict) -> None:
        """Durable, crash-consistent metadata write.

        Description: write to a sibling ``.tmp`` file, ``flush``,
          ``os.fsync`` the descriptor, then ``os.replace``.
          ``os.replace`` is the only rename primitive guaranteed atomic
          across POSIX and Windows, and the ``fsync`` before it is what
          stops a kernel panic stranding a zero-byte file at the final
          path - a real scenario on ext4 ``data=ordered``.

          The DIRECTORY's own fsync, for rename durability, is skipped
          deliberately: this is metadata, not money. Losing the very last
          write to a sudden power cut is acceptable. Losing SESSION
          OWNERSHIP is not, and that is what the atomic rename prevents.
        Inputs: data (dict) - JSON-serialisable; non-JSON values are
          stringified by ``default=str``.
        Output: None.
        Example: ledger.write_atomic({"owned_tmux_sessions": ["a"]})
        """
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")

        with tmp.open("w") as f:
            json.dump(data, f, indent=2, default=str)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError as exc:
                # tmpfs and some network filesystems do not support fsync;
                # log and continue - the rename is still atomic per POSIX.
                logger.debug("metadata_fsync_unsupported", error=str(exc))

        os.replace(str(tmp), str(path))

    def load(self) -> MetadataLoad:
        """Read the metadata file and apply its owned-set half.

        Description: parses only. The session half comes back as raw
          fields for the caller to build and register, because
          registering a session is a manager concern and doing it here
          would put the registry on the far side of a package rule.

          Schema v3 added ``owned_tmux_sessions``. A payload with no
          ``id`` is the OWNED-SET-ONLY shape written by
          ``drop_session_pointer``: there is nothing to rehydrate and
          that is the point, since handing it to ``Session(**raw)`` would
          raise and take the owned set down with it, which is the exact
          loss that payload exists to prevent. A payload with an ``id``
          and no owned set is pre-v3, and arms the backfill sentinel.
        Inputs: none.
        Output: MetadataLoad.
        Example: load = ledger.load(); Session(**load.session)

        A read that raises leaves the ledger EXACTLY as it was and
        reports no session. Not having been able to read the file is not
        evidence that this app owns nothing.
        """
        metadata_path = self.path()

        if not metadata_path.exists():
            logger.info("no_existing_session_metadata")
            return MetadataLoad(session=None, owned_count=len(self.names))

        try:
            with open(metadata_path, "r") as f:
                raw = json.load(f)

            # Extract the v3 field BEFORE anything else looks at the
            # payload, so the rest is the Session's own shape.
            owned = raw.pop("owned_tmux_sessions", None)

            if not raw.get("id"):
                self.names = set(owned or [])
                self.needs_legacy_backfill = False
                logger.info(
                    "session_metadata_owned_set_only_loaded",
                    owned_count=len(self.names),
                    note="no persisted session to rehydrate",
                )
                return MetadataLoad(session=None, owned_count=len(self.names))

            if owned is None:
                # Pre-v3 metadata: no owned set was ever persisted. Mark
                # for backfill; the boot reconcile populates the set once
                # the slug is confirmed live on the tmux socket.
                self.names = set()
                self.needs_legacy_backfill = True
                logger.info(
                    "session_metadata_legacy_detected",
                    session_id=raw.get("id"),
                    note="owned_tmux_sessions will be backfilled on rehydrate",
                )
            else:
                self.names = set(owned)
                self.needs_legacy_backfill = False

            return MetadataLoad(session=raw, owned_count=len(self.names))
        except (OSError, ValueError, TypeError) as exc:
            logger.error("failed_to_load_session_metadata", error=str(exc))
            return MetadataLoad(session=None, owned_count=len(self.names))

    def save(self, payload: dict) -> bool:
        """Persist one session's fields plus the owned set, atomically.

        Description: the owned set is stamped onto the payload here
          rather than by the caller, so a save can never write a session
          pointer without the ownership record beside it. A successful
          write IS the pre-v3 migration, so the backfill sentinel clears
          on the way out.
        Inputs: payload (dict) - the session's own fields, from
          ``Session.model_dump()``. Mutated in place with the owned set.
        Output: bool - True when the file was written, False when the
          write failed. False is REPORTED rather than raised, because the
          callers are session lifecycle paths where a metadata miss must
          not take a live session down with it.
        Example: ledger.save(session.model_dump())
        """
        try:
            payload["owned_tmux_sessions"] = sorted(self.names)
            self.write_atomic(payload)
            self.needs_legacy_backfill = False
            logger.debug(
                "session_metadata_saved",
                session_id=payload.get("id"),
                owned_count=len(self.names),
            )
            return True
        except (OSError, ValueError, TypeError) as exc:
            logger.error("failed_to_save_session_metadata", error=str(exc))
            return False

    def drop_session_pointer(self) -> None:
        """Delete the session pointer, KEEP the owned set.

        Description: the file is the only durable home of ``names``, and
          that set is about EVERY session this app created, not about the
          one session whose slug is being discarded. Unlinking the file
          outright, which is what this used to do, threw away N sessions'
          ownership record to clean up one - and the trigger is the
          ORDINARY case rather than an error path:
          ``session_metadata_slug_not_in_backend`` fires whenever the
          last-active tmux session is simply gone by the next start.
          Measured on the live install as four load/delete pairs about
          40 ms apart, after which the file never returned and every
          launcher-created session resolved EXTERNAL, because ownership
          fell past an empty legacy tier.

          ORDERING IS DELIBERATE: unlink FIRST, then re-write. The unlink
          of the RESOLVED path is what relocates the file out of the
          legacy log directory on the next write, which
          ``tests/test_session_meta_continuity.py`` measures, and
          ``write_atomic`` re-resolves after the unlink.
        Inputs: none.
        Output: None.
        Example: ledger.drop_session_pointer()
        """
        metadata_path = self.path()
        try:
            if metadata_path.exists():
                metadata_path.unlink()
                logger.info("stale_session_metadata_deleted")
            if self.names:
                self.write_atomic({"owned_tmux_sessions": sorted(self.names)})
                logger.info(
                    "stale_session_metadata_owned_set_kept",
                    owned_count=len(self.names),
                )
        except (OSError, ValueError, TypeError) as exc:
            logger.error("failed_to_delete_stale_metadata", error=str(exc))

    # ---- the ownership queries -----------------------------------------

    def instances_from_db(self) -> Optional[set]:
        """The owned ``(tmux_name, epoch)`` pairs recorded in ``cloude.db``.

        Description: the single datastore read behind every ownership
          decision. Keyed on the INSTANCE, never on the name alone, so a
          reused tmux name cannot inherit a dead session's badge.
        Inputs: none.
        Output: set[tuple[str, int]] | None - None when the datastore
          could not answer at all (absent, unreadable, pre-v2). An EMPTY
          SET is a real answer, "the datastore knows of no owned
          instance", and every caller treats the two differently.
        Example: owned = ledger.instances_from_db()
        """
        conn = self._records.read_connection()
        if conn is None:
            return None
        try:
            from src.core.session_store import owned_instances, sessions_table_ready

            if not sessions_table_ready(conn):
                return None
            return owned_instances(conn, socket=self._socket_name())
        except Exception as exc:  # noqa: BLE001 - never break the render path
            logger.debug("ownership_db_read_failed", error=str(exc))
            return None
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - a close failure is not a verdict
                pass

    def instances(self) -> Optional[set]:
        """Owned ``(tmux_name, epoch)`` pairs, and only those.

        Description: the value handed to the attachable listing, which is
          the one path that HAS the epoch for every row and can therefore
          make the identity-correct decision.

          THE LEGACY NAME SET IS DELIBERATELY NOT FOLDED IN HERE. It used
          to be, as ``(name, None)``, and the backend read a None epoch as
          a NAME-ONLY WILDCARD. That disabled the epoch tier for every
          session this app had created since the last restart - precisely
          the population the epoch exists to protect - so a dead
          ``cloude_work`` replaced by the user's own unrelated
          ``cloude_work`` badged as ours, exactly as it did before the
          epoch existed. The legacy names still reach the backend, but as
          the SEPARATE ``owned_names`` argument, resolved at their own,
          lower, explicitly name-only tier where they can never override a
          stored epoch. See
          :func:`src.core.tmux_listing_parse.resolve_ownership`.
        Inputs: none.
        Output: set[tuple[str, int]] | None - None when the datastore
          could not answer at all.
        Example: ledger.instances()
        """
        from_db = self.instances_from_db()
        if from_db is None:
            return None
        return set(from_db)

    def is_owned_name(self, name: Optional[str]) -> bool:
        """Report whether a tmux NAME belongs to a session we own.

        Description: the name-only fallback, for call sites that carry no
          creation epoch - ``SessionInfo`` is one. Lossy in exactly one
          way, stated so nobody has to rediscover it: a name owned as one
          instance and now reused by a different, unowned instance reads
          as owned here until the epoch reaches that call site. The
          attachable listing, which does have the epoch, is not lossy.
        Inputs: name (str | None) - a tmux session name.
        Output: bool - False for None or an empty name.
        Example: ledger.is_owned_name('cloude_a')
        """
        if not name:
            return False
        if name in self.names:
            return True
        from_db = self.instances_from_db()
        if from_db is None:
            return False
        return any(owned_name == name for owned_name, _epoch in from_db)
