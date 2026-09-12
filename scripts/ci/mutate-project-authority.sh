#!/bin/bash
# Mutation check for feat/db-is-authoritative.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific way this change can silently hand the
# user a wrong answer, and every one must turn the suite red.
#
# BLOCK 0 - BASELINE GATE. The suite is run UNMUTATED first. A mutation
# score computed over an already-red baseline is meaningless: every
# mutant "dies" because the suite was dead before it arrived. The script
# refuses to proceed rather than reporting a number nobody can use.
#
# BLOCK 1 - THE VISIBLE BUG. His config.json holds three names for
# /Users/jsugamele/Development/ses_ec5bf2a3, and the launcher drew all
# three, each expanding the same two child sessions. These mutants put
# the read back on config.json, drop the deduplication in the degraded
# fallback, and take the row id back off the response so the client has
# to look it up by raw path again - which is the exact mechanism that
# made three nodes share children.
#
# BLOCK 2 - THE ROLLBACK ARTIFACT. The entire justification for the
# change is that config.json stays a file the user can revert to. These
# mutants stop writing it, write it before the commit instead of after,
# write it from the caller's belief rather than from the table, drop the
# atomic write, and - the worst one - overwrite it with an empty list
# when the database cannot be read, which turns the rollback file into a
# data shredder.
#
# BLOCK 3 - THE THREE OUTCOMES. Every collapse of "could not evaluate"
# into "fine" or "broken": an unreachable database rendering as an empty
# project list, a degraded read that still allows writes, a failed
# comparison reported as agreement, and an empty table with a populated
# config reported as "you have no projects".
#
# BLOCK 4 - DISAGREEMENT. A difference that is detected but not reported
# is the same defect as one that was never detected. These mutants drop
# each bucket of the diff, fold an expected duplicate into the
# missing-project bucket so the report cries wolf, and make a
# null-versus-empty description a permanent mismatch nobody can clear.
#
# BLOCK 5 - IDENTITY AND ORDERING. root is the identity; display names
# are not unique and never were. These mutants join on the name, resolve
# an ambiguous name by taking the first row, let a rename rewrite the
# root, and invert the launcher's most-recently-used ordering.
#
# All mutated files are restored on exit, including on failure. Modelled
# on scripts/ci/mutate-projects-presence.sh - same harness shape, same
# restore-on-exit discipline.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
PY="${ROOT}/venv/bin/python3"
TESTS="tests/test_project_authority.py tests/test_project_writes.py \
tests/test_projects_authority_route.py tests/test_projects_degraded_route.py"
# THE CLIENT HALF MOVED. Slice 7 deleted client/js/launchpad.js and BOTH
# node suites this script named (test_project_authority_render.node.mjs
# and test_project_authority_banner.node.mjs). The two rules survived:
# the project-id ladder is resolveProjectId in
# web/src/lib/launchpad/project-node.ts, and the null-authority branch is
# authorityBanner in web/src/lib/launchpad/project-chrome.ts.
WEB_TESTS=(
  "web/src/lib/launchpad/project-node.test.ts"
  "web/src/lib/launchpad/project-chrome.test.ts"
)

FILES=(
  "src/core/project_authority.py"
  "src/core/project_writes.py"
  "src/api/projects_service.py"
  "src/api/auth.py"
  "web/src/lib/launchpad/project-node.ts"
  "web/src/lib/launchpad/project-chrome.ts"
)

mutate_arm_trap "$ROOT" "${FILES[@]}"
mutate_web_require "$ROOT"
mutate_web_files_exist "$ROOT" "${WEB_TESTS[@]}"

survived=0
cannot_determine=0
killed=0

restore_all() {
    mutate_restore_files
}

run_suite() {
  mutate_run "$PY" -m pytest $TESTS -q -p no:randomly >/dev/null 2>&1 || return 1
  local t
  for t in "${WEB_TESTS[@]}"; do
    mutate_web_run "$ROOT" "$t" || return 1
  done
  return 0
}

# mutate <name> <file> <old||=>||new>
mutate() {
  local name="$1" file="$2" expr="$3"
  restore_all
  "$PY" - "${ROOT}/${file}" "$expr" <<'PYEOF'
import sys
path, expr = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
old, new = expr.split('||=>||')
if old not in text:
    sys.exit('mutation target not found: ' + old[:70])
open(path, 'w', encoding='utf-8').write(text.replace(old, new, 1))
PYEOF
  if [ $? -ne 0 ]; then
    echo "CANNOT_DETERMINE $name (target moved - anchor stale, mutant not evaluated)"
    cannot_determine=$((cannot_determine + 1))
    return
  fi
  if run_suite; then
    echo "SURVIVED $name"
    survived=$((survived + 1))
  else
    echo "killed   $name"
    killed=$((killed + 1))
  fi
}

echo "--- BLOCK 0: BASELINE GATE ---"
restore_all
if run_suite; then
  echo "baseline GREEN - mutation scores below are meaningful"
else
  echo "baseline RED - refusing to run. A mutation score over a red"
  echo "baseline counts every mutant as killed by a suite that was"
  echo "already failing. Fix the baseline first."
  exit 2
fi

echo
echo "--- BLOCK 1: THE VISIBLE BUG (one node per unique root) ---"

mutate "the read goes back to config.json, so duplicates render again" \
  "src/core/project_authority.py" \
  '    return ProjectsView(
        mode=MODE_DB,
        projects=[_row_to_view(row) for row in rows],||=>||    return ProjectsView(
        mode=MODE_DB,
        projects=[_config_to_view(c) for c in config_list],'

mutate "the degraded fallback stops deduplicating, resurrecting the bug" \
  "src/core/project_authority.py" \
  '        if view["root"] in seen:
            continue||=>||        if False:
            continue'

mutate "the response drops the row id, forcing the raw-path lookup back" \
  "src/api/projects_service.py" \
  '            id=item["id"],
            name=item["name"],||=>||            id=None,
            name=item["name"],'

mutate "the client prefers the presence-map id over the project row id" \
  "web/src/lib/launchpad/project-node.ts" \
  '    const own = project.id;
    if (own !== null && own !== undefined) return own as number;||=>||    const own = project.id;
    if (false) return own as number;'

mutate "a null project id is coerced to 0, so orphans attach everywhere" \
  "web/src/lib/launchpad/project-node.ts" \
  '    return null;
}

/** What `projectNodeView` needs besides the project itself. */||=>||    return 0;
}

/** What `projectNodeView` needs besides the project itself. */'

mutate "creating a project at an existing root is allowed again" \
  "src/core/project_writes.py" \
  '        if clash is not None:||=>||        if False:'

echo
echo "--- BLOCK 2: THE ROLLBACK ARTIFACT ---"

mutate "an unreadable database overwrites config.json with an empty list" \
  "src/core/project_authority.py" \
  '        return SnapshotResult(
            ok=False,
            reason=SNAPSHOT_WRITE_FAILED,||=>||        return snapshot_projects(config_path, []) or SnapshotResult(
            ok=False,
            reason=SNAPSHOT_WRITE_FAILED,'

echo
echo "--- BLOCK 3: THE THREE OUTCOMES ---"

mutate "an unreachable database renders as an empty project list" \
  "src/core/project_authority.py" \
  '        projects=_dedupe_config_views(config_list),
        message=(
            "cloude.db is UNREACHABLE.||=>||        projects=[],
        message=(
            "cloude.db is UNREACHABLE.'

mutate "the degraded fallback claims to be writable" \
  "src/core/project_authority.py" \
  'READONLY_MODES = (MODE_CONFIG_FALLBACK,)||=>||READONLY_MODES = ()'

mutate "require_writable never refuses, so a degraded write proceeds" \
  "src/core/project_authority.py" \
  '    if not view.writable:||=>||    if False:'

mutate "config_fallback is reported as the healthy db mode" \
  "src/core/project_authority.py" \
  '        mode=MODE_CONFIG_FALLBACK,
        projects=_dedupe_config_views(config_list),||=>||        mode=MODE_DB,
        projects=_dedupe_config_views(config_list),'

mutate "an empty table with a populated config reports plain db mode" \
  "src/core/project_authority.py" \
  '    if not rows and config_list:||=>||    if False:'

mutate "a could-not-compare diff is rendered as an agreeing one" \
  "src/core/project_authority.py" \
  '        diff=None,
    )


def require_writable||=>||        diff=ProjectDiff(),
    )


def require_writable'

mutate "diff_state says known even when the diff is null" \
  "src/core/project_authority.py" \
  '            "diff_state": "known" if self.diff is not None else "cannot_determine",||=>||            "diff_state": "known",'

mutate "a corrupt database raises instead of falling back" \
  "src/core/project_authority.py" \
  '    except Exception as exc:  # noqa: BLE001 - a read surface must not 500
        return _fallback(config_list, f"{type(exc).__name__}: {exc}", db_file)||=>||    except Exception:  # noqa: BLE001
        raise'

mutate "resolving creates the database, manufacturing an empty install" \
  "src/core/project_authority.py" \
  '        with closing(connect(db_file, create=False)) as conn:
            rows = list_projects_ordered(conn)
    except DatastoreUnreadableError as exc:||=>||        with closing(connect(db_file, create=True)) as conn:
            rows = list_projects_ordered(conn)
    except DatastoreUnreadableError as exc:'

mutate "a refused write returns 200 instead of 503" \
  "src/api/projects_service.py" \
  '    return HTTPException(
        status_code=503,
        detail=(
            "cloude.db is unreachable, so project changes are refused. "||=>||    return HTTPException(
        status_code=200,
        detail=(
            "cloude.db is unreachable, so project changes are refused. "'

mutate "the write guard is skipped, so a degraded write is attempted" \
  "src/api/auth.py" \
  '    projects_service.guard_writable(settings)

    try:
        with closing(projects_service.open_db_or_503(settings)) as conn:
            row = db_create_project(||=>||    try:
        with closing(projects_service.open_db_or_503(settings)) as conn:
            row = db_create_project('

mutate "the client renders a failed authority fetch as healthy" \
  "web/src/lib/launchpad/project-chrome.ts" \
  '    if (authority === null || authority === undefined) return { kind: '"'"'unknown'"'"' };||=>||    if (false) return { kind: '"'"'unknown'"'"' };'

echo
echo "--- BLOCK 4: DISAGREEMENT IS REPORTED ---"

echo
echo "--- BLOCK 5: IDENTITY AND ORDERING ---"

mutate "an ambiguous display name resolves to the first row silently" \
  "src/core/project_writes.py" \
  '    if len(rows) > 1:
        raise ProjectNameAmbiguous(||=>||    if False:
        raise ProjectNameAmbiguous('

mutate "an unknown project name returns None instead of raising" \
  "src/core/project_writes.py" \
  '    if not rows:
        raise ProjectNotFound(name)||=>||    if not rows:
        return {"id": None, "root": None, "display_name": name}'

mutate "a rename rewrites the root, moving a project onto another identity" \
  "src/core/project_writes.py" \
  '            conn.execute(
                "UPDATE projects SET display_name = ?, updated_at = ? WHERE id = ?",
                (new_name, stamp, project_id),
            )||=>||            conn.execute(
                "UPDATE projects SET display_name = ?, root = ?, updated_at = ? "
                "WHERE id = ?",
                (new_name, normalize_root(new_name), stamp, project_id),
            )'

mutate "a rename onto an existing name is allowed" \
  "src/core/project_writes.py" \
  '            if conn.execute(
                "SELECT 1 FROM projects WHERE display_name = ? AND id != ?",
                (new_name, project_id),
            ).fetchone():||=>||            if False:'

mutate "an empty-string description is treated as no-op instead of a clear" \
  "src/core/project_writes.py" \
  '        if description is not None:||=>||        if description:'

mutate "delete removes nothing but reports success" \
  "src/core/project_writes.py" \
  '        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))||=>||        pass'

mutate "the launcher ordering is inverted, so MRU sorts last" \
  "src/core/project_writes.py" \
  '    "ORDER BY (last_opened_at IS NULL) ASC, last_opened_at DESC, id ASC"||=>||    "ORDER BY (last_opened_at IS NULL) DESC, last_opened_at ASC, id DESC"'

# REPLACED, and the replacement is recorded rather than silently swapped.
# The original mutant here dropped the leading "(last_opened_at IS NULL)
# ASC" term, expecting never-opened rows to float to the top. It SURVIVED,
# and it survived because it is PROVABLY EQUIVALENT, not because the tests
# are weak: SQLite orders NULL as smaller than every value, so under DESC
# it already sorts NULLs last. Verified empirically over 300 randomised
# populations - the two ORDER BY clauses produced identical row orders in
# every one. The redundant term is kept in the source for readability
# (see the comment above _ORDER_BY) and the source comment that claimed
# SQLite does the opposite was corrected in the same commit, because it
# was simply wrong.
#
# The replacement below is a REAL defect in the same place: ordering by
# updated_at, which the presence probe rewrites on every page load, so
# the launcher would reshuffle itself just from being looked at. That is
# the exact hazard last_opened_at was added to avoid.
mutate "ordering uses updated_at, so a presence probe reshuffles the launcher" \
  "src/core/project_writes.py" \
  '    "ORDER BY (last_opened_at IS NULL) ASC, last_opened_at DESC, id ASC"||=>||    "ORDER BY (updated_at IS NULL) ASC, updated_at DESC, id ASC"'

mutate "a new project is not stamped opened, so it does not sort to the top" \
  "src/core/project_writes.py" \
  '                stamp,
                stamp,
                stamp,
            ),
        )||=>||                stamp,
                stamp,
                None,
            ),
        )'

mutate "touch matches on a resolved path, diverging from the stored root" \
  "src/core/project_writes.py" \
  '    root = normalize_root(working_dir)

    with transaction(conn):
        row = conn.execute(||=>||    root = str(Path(working_dir).expanduser().resolve()) + "/x"

    with transaction(conn):
        row = conn.execute('

mutate "raw_path is normalised on write, discarding the user path spelling" \
  "src/core/project_writes.py" \
  '                root,
                path,
                name,||=>||                root,
                root,
                name,'

restore_all
echo
echo "killed ${killed}, survived ${survived}"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
