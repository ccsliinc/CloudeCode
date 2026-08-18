"""Project and session LIST queries for the conversation archive.

A mixin rather than a module of functions so these share the one classified
``_execute`` (and the one open session) with the thread queries in
``history_queries``. Split out purely for file size; the seam is "queries
that enumerate conversations" versus "queries that read inside one".
"""

from __future__ import annotations

from typing import Any, Optional

from src.core.history_records import SESSION_KIND_MAIN, SESSION_KIND_SUBAGENT, _as_str


class SessionListQueries:
    """List-view queries. Expects ``self._execute`` from the host class."""

    def list_projects(self) -> list[dict]:
        """List projects with per-kind session counts.

        Counts are split by ``session_kind`` rather than summed,
        because a subagent transcript is not a conversation a reader
        opens from a project list, and a NULL kind is reported on its
        own as ``unclassified_session_count`` instead of being folded
        into either bucket.

        Returns:
            list[dict]: one row per project, most recently active
            first, each with id, slug, guessed_path, session_count,
            subagent_session_count, unclassified_session_count,
            last_session_at.
        """
        from sqlalchemy import text as sa_text

        sql = sa_text(
            """
            SELECT p.id AS id,
                   p.slug AS slug,
                   p.guessed_path AS guessed_path,
                   sum(CASE WHEN s.session_kind = :main THEN 1 ELSE 0 END)
                       AS session_count,
                   sum(CASE WHEN s.session_kind = :subagent THEN 1 ELSE 0 END)
                       AS subagent_session_count,
                   sum(CASE WHEN s.session_kind IS NULL AND s.id IS NOT NULL
                            THEN 1 ELSE 0 END) AS unclassified_session_count,
                   max(s.started_at) AS last_session_at
            FROM projects p
            LEFT JOIN sessions s ON s.project_id = p.id
            GROUP BY p.id, p.slug, p.guessed_path
            ORDER BY last_session_at DESC NULLS LAST
            """
        )
        rows = self._execute(
            sql, {"main": SESSION_KIND_MAIN, "subagent": SESSION_KIND_SUBAGENT}
        )
        return [
            {
                "id": row.id,
                "slug": row.slug,
                "guessed_path": row.guessed_path,
                "session_count": int(row.session_count or 0),
                "subagent_session_count": int(row.subagent_session_count or 0),
                "unclassified_session_count": int(
                    row.unclassified_session_count or 0
                ),
                "last_session_at": _as_str(row.last_session_at),
            }
            for row in rows
        ]

    def count_sessions(self, project_id: Optional[int], kind: Optional[str]) -> int:
        """Count sessions matching a filter.

        Args:
            project_id: restrict to one project, or None for all.
            kind: restrict to one ``session_kind``, or None for all.

        Returns:
            int: total matching rows, so a pager can render "page 1 of
            N" instead of guessing from a short page.
        """
        from sqlalchemy import text as sa_text

        where, params = _session_filter(project_id, kind)
        sql = sa_text(f"SELECT count(*) FROM sessions{where}")
        return int(self._execute(sql, params)[0][0])

    def list_sessions(
        self,
        project_id: Optional[int],
        kind: Optional[str],
        limit: int,
        offset: int,
    ) -> list[dict]:
        """List sessions newest first, with subagent counts.

        Args:
            project_id: restrict to one project, or None for all.
            kind: restrict to one ``session_kind``, or None for all.
            limit: page size, already capped by the caller.
            offset: rows to skip.

        Returns:
            list[dict]: one row per session with the header fields a
            list view needs (cwd, git_branch, cc_version, model,
            message_count, sidechain_message_count, subagent_count).
        """
        from sqlalchemy import text as sa_text

        where, params = _session_filter(project_id, kind)
        params.update({"limit": limit, "offset": offset})
        sql = sa_text(
            f"""
            SELECT id, session_uuid, project_id, cwd, git_branch, cc_version,
                   model, slug, custom_title, started_at, ended_at,
                   message_count, sidechain_message_count, session_kind,
                   agent_type, agent_id, parent_session_id, workflow_id
            FROM sessions{where}
            ORDER BY started_at DESC, id DESC
            LIMIT :limit OFFSET :offset
            """
        )
        rows = self._execute(sql, params)
        sessions = [
            {
                "id": row.id,
                "session_uuid": row.session_uuid,
                "project_id": row.project_id,
                "cwd": row.cwd,
                "git_branch": row.git_branch,
                "cc_version": row.cc_version,
                "model": row.model,
                "slug": row.slug,
                "custom_title": row.custom_title,
                "started_at": _as_str(row.started_at),
                "ended_at": _as_str(row.ended_at),
                "message_count": row.message_count,
                "sidechain_message_count": row.sidechain_message_count,
                "session_kind": row.session_kind,
                "agent_type": row.agent_type,
                "agent_id": row.agent_id,
                "parent_session_id": row.parent_session_id,
                "workflow_id": row.workflow_id,
            }
            for row in rows
        ]
        counts = self.count_subagents([s["id"] for s in sessions])
        for session in sessions:
            session["subagent_count"] = counts.get(session["id"], 0)
        return sessions

    def count_subagents(self, session_ids: list[int]) -> dict[int, int]:
        """Count subagent sessions filed under each given session.

        Uses ``parent_session_id`` (indexed as ``ix_sessions_parent``),
        which is the ROOT session a transcript was filed under. That is
        the count a list view wants: "how many agent transcripts hang
        off this conversation". It is NOT the spawn graph, which needs
        ``spawn_session_id`` and is a later phase.

        Args:
            session_ids: parent session ids for the current page.

        Returns:
            dict[int, int]: session id to subagent count. Ids with no
            subagents are absent; callers default them to 0.
        """
        if not session_ids:
            return {}
        from sqlalchemy import text as sa_text

        names = ", ".join(f":p{i}" for i in range(len(session_ids)))
        params = {f"p{i}": sid for i, sid in enumerate(session_ids)}
        sql = sa_text(
            "SELECT parent_session_id AS pid, count(*) AS n FROM sessions "
            f"WHERE parent_session_id IN ({names}) GROUP BY parent_session_id"
        )
        return {row.pid: int(row.n) for row in self._execute(sql, params)}

def _session_filter(
    project_id: Optional[int], kind: Optional[str]
) -> tuple[str, dict[str, Any]]:
    """Build the WHERE clause shared by the session list and its count.

    One builder for both so a filtered page can never disagree with its own
    total.

    Args:
        project_id: restrict to one project, or None.
        kind: restrict to one ``session_kind``, or None.

    Returns:
        tuple[str, dict]: SQL fragment (with a leading space, or empty) and
        its bind parameters.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if project_id is not None:
        clauses.append("project_id = :project_id")
        params["project_id"] = project_id
    if kind is not None:
        clauses.append("session_kind = :kind")
        params["kind"] = kind
    if not clauses:
        return "", params
    return " WHERE " + " AND ".join(clauses), params
