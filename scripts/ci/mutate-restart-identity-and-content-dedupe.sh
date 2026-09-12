#!/bin/bash
# Mutation check for the two fixes in this change:
#   (1) RESTART of a stopped session must carry its identity and its
#       conversation, and must never present a blank session as a resumed
#       one.
#   (2) Transcript ingest idempotency must be CONTENT-addressed, not
#       path-addressed, and a mass re-archive must be loud.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific, real way this build step can silently
# hand the user a wrong answer, and every one must turn a suite red.
#
# BLOCK 1 - THE IDENTITY THE RESTART CARRIES. These mutants put the code
# back the way it was: the title absent from the button markup, the uuid
# never read out of the dataset, the handler taking a bare working dir. If
# the suite stays green under any of them, the tests are asserting on a
# plan object rather than on what was rendered and what was called.
#
# BLOCK 2 - THE THREE OUTCOMES OF A RESTART. 'resumed', 'none_recorded'
# and 'unknown' must produce three different user-visible sentences, and a
# row with no session_uuid must not start a blank session in silence. Each
# mutant collapses one of those into another.
#
# BLOCK 3 - THE SERVER SIDE. Resolution must key on the durable
# session_uuid (not the reusable tmux name), must report a row with no
# claude_session_uuid as its own outcome, and must never report an absent
# row as one that simply has no conversation.
#
# BLOCK 4 - CONTENT ADDRESSING. The lookup must be GLOBAL (the whole
# defect was a path scope), the duplicate row must store a sentinel and
# point at the row holding the bytes, and the line index must be copied.
#
# BLOCK 5 - PREFIX DEDUPE MUST SURVIVE. The two mechanisms share
# superseded_by_archive_id. A mutant that lets a GROWN file take the
# content-duplicate branch, or that breaks the chain walk, must be caught.
#
# BLOCK 6 - THE FINDING. A mass re-archive was completely silent. A
# mutant that suppresses the finding, or that fires it on every pass
# (furniture), must be caught.
#
# All mutated files are restored on exit, including on failure and on
# SIGINT/SIGTERM - see scripts/ci/lib/mutate-trap.sh.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
PY="${ROOT}/venv/bin/python3"
TESTS="tests/test_transcript_content_dedupe.py \
tests/test_session_restart_source.py \
tests/test_transcript_corpus_ingest.py \
tests/test_transcript_prefix_dedupe.py"
# SLICE 4 REMOVED `tests/test_session_restart_identity.node.mjs`: its
# last three cases were all about the project tree's ended restart
# button, and the tree is a Svelte component now. The equivalent
# assertions live in
# web/src/lib/launchpad/ProjectTree.behaviour.test.ts, which this script
# cannot drive - it mutates `client/js/launchpad.js` and runs node
# scripts. THE BLOCK 1 TREE MUTATIONS BELOW ARE THEREFORE DEAD: the
# strings they patch no longer exist in that file, so they will report
# `cannot_determine` rather than a false `killed`, which is the honest
# outcome and is what that counter is for. Rebuilding this script against
# the vitest suite is its own job.
# SLICE 7 took client/js/launchpad.js AND tests/test_recent_sessions.node.mjs.
# The restart plan is web/src/lib/launchpad/recent.ts, the action is
# recent-actions.ts, and the three conversation verdicts live in
# client/js/labels/recent-session.js, which BOTH clients import.
WEB_TESTS=(
  "web/src/lib/launchpad/recent.test.ts"
  "web/src/lib/launchpad/recent-actions.test.ts"
)

FILES=(
  "src/core/transcript_corpus_ingest.py"
  "src/core/transcript_content_dedupe.py"
  "src/core/session_restart.py"
  "web/src/lib/launchpad/recent.ts"
  "client/js/labels/recent-session.js"
)

mutate_arm_trap "$ROOT" "${FILES[@]}"
mutate_web_require "$ROOT"
mutate_web_files_exist "$ROOT" "${WEB_TESTS[@]}"

survived=0
cannot_determine=0
killed=0

# BASELINE GATE. A mutation run measures the DIFFERENCE between a green
# suite and a mutated one; a red baseline would make every mutant read as
# killed for free.
echo "--- baseline: every suite must be GREEN before anything is mutated ---"
if ! mutate_run "$PY" -m pytest $TESTS -q -p no:randomly >/dev/null 2>&1; then
  echo "BASELINE IS RED (python). Every mutant would read as killed. Refusing to run."
  exit 2
fi
for nt in "${WEB_TESTS[@]}"; do
  if ! mutate_web_run "$ROOT" "$nt"; then
    echo "BASELINE IS RED ($nt). Refusing to run."
    exit 2
  fi
done
echo "baseline green"

restore_all() {
    mutate_restore_files
}

# Apply one textual mutation, run the suites, expect RED.
#   mutate <name> <file> <old||=>||new>
# A target that no longer exists counts as CANNOT_DETERMINE, never as a
# skip and never as a kill - an anchor that moved means the mutant was
# never evaluated, which is not evidence of anything.
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
  if mutate_run "$PY" -m pytest $TESTS -q -p no:randomly >/dev/null 2>&1; then
    : # python green, fall through to node
  else
    killed=$((killed + 1))
    echo "killed   $name"
    return
  fi
  for nt in "${WEB_TESTS[@]}"; do
    if ! mutate_web_run "$ROOT" "$nt"; then
      killed=$((killed + 1))
      echo "killed   $name"
      return
    fi
  done
  echo "SURVIVED $name"
  survived=$((survived + 1))
}

# SIX MUTANTS ARE GONE WITH THEIR MECHANISM, NOT WITH THEIR CLAIM. The
# "RECENT/TREE button drops data-title" and "handler never reads
# data-uuid/data-title" pairs each described a DOM ROUND TRIP: the
# renderer wrote an attribute, a delegated click handler read it back,
# and the two could disagree. There is no round trip now.
# RecentSessions.svelte calls restartRecentSession(row.restart, ...) with
# the object itself, and EndedSessionRow.svelte calls
# host.restartEnded(row) - which is also why the ended button has no
# data-title left to drop. The attributes that remain REPORT the value;
# they do not carry it.
#
# THAT WAS CONFIRMED RATHER THAN ASSUMED: removing data-title from the
# RECENT restart button was tried as a mutant of its own and SURVIVED the
# whole vitest suite, which is the correct answer for an attribute
# nothing reads, not a coverage gap. The CLAIM those six protected - the
# uuid and the title must reach the restart - is decided in restartPlan,
# and three of the mutants below hit it exactly there.

echo "--- BLOCK 1: the identity a RESTART carries ---"

mutate "the title is dropped from the unidentified-restart payload" \
  "web/src/lib/launchpad/recent.ts" \
  '    if (title) payload.project_name = title;||=>||    if (false) payload.project_name = title;'

echo "--- BLOCK 2: the three outcomes of a RESTART must not collapse ---"

mutate "a known uuid falls through to a blank create anyway" \
  "web/src/lib/launchpad/recent.ts" \
  '    if (sessionUuid) {
        return { mode: '"'"'restart'"'"', sessionUuid, payload: null, mustExplain: false };
    }||=>||    if (false) {
        return { mode: '"'"'restart'"'"', sessionUuid, payload: null, mustExplain: false };
    }'

mutate "a row with NO session_uuid starts a blank session in SILENCE" \
  "web/src/lib/launchpad/recent.ts" \
  '    return { mode: '"'"'create_unidentified'"'"', sessionUuid: '"'"''"'"', payload, mustExplain: true };||=>||    return { mode: '"'"'create_unidentified'"'"', sessionUuid: '"'"''"'"', payload, mustExplain: false };'

mutate "'none_recorded' is reported exactly like a clean resume" \
  "client/js/labels/recent-session.js" \
  '    if (kind === '"'"'none_recorded'"'"') {||=>||    if (false) {'

mutate "an UNKNOWN conversation verdict is treated as a resume" \
  "client/js/labels/recent-session.js" \
  '    if (kind !== '"'"'resumed'"'"') {||=>||    if (false) {'

mutate "a missing response body reads as a clean pass" \
  "client/js/labels/recent-session.js" \
  '    if (!result) return t(RECENT_KEYS.restartUnsaid);||=>||    if (!result) return null;'

mutate "a resumed restart whose lineage failed is reported as clean" \
  "client/js/labels/recent-session.js" \
  '    if (result.row_reused === false) {||=>||    if (false) {'

echo "--- BLOCK 3: the server must resolve the RIGHT row, and say which case it is ---"

mutate "resolution keys on the reusable tmux name instead of the durable uuid" \
  "src/core/session_restart.py" \
  '        "WHERE session_uuid = ? LIMIT 1",||=>||        "WHERE tmux_name = ? LIMIT 1",'

mutate "a row with no conversation is reported as RESUMABLE" \
  "src/core/session_restart.py" \
  '    if not uuid:
        return RestartSource(
            RESTART_NO_CONVERSATION,||=>||    if False:
        return RestartSource(
            RESTART_NO_CONVERSATION,'

mutate "an ABSENT row is reported as merely having no conversation" \
  "src/core/session_restart.py" \
  '    if row is None:
        return RestartSource(
            RESTART_UNRESOLVED,||=>||    if row is None:
        return RestartSource(
            RESTART_NO_CONVERSATION,'

mutate "the title is not carried out of the stored row" \
  "src/core/session_restart.py" \
  '    title = data.get("title") or label_from_tmux_name(data.get("tmux_name"))||=>||    title = None'

echo "--- BLOCK 4: content addressing must be GLOBAL, and the row shape must hold ---"

mutate "the content lookup is re-scoped to source_path - the ORIGINAL 3.78 GB defect" \
  "src/core/transcript_content_dedupe.py" \
  '        " WHERE content_sha256 = ?"||=>||        " WHERE content_sha256 = ? AND source_path = ?"'

mutate "the content check is skipped entirely, so a moved corpus re-archives" \
  "src/core/transcript_corpus_ingest.py" \
  '    match = find_archive_by_content(conn, current_sha)||=>||    match = None'

mutate "the duplicate row does not point at the row holding its bytes" \
  "src/core/transcript_content_dedupe.py" \
  '            match.archive_id,
            stamp,
            source_mtime,||=>||            None,
            stamp,
            source_mtime,'

mutate "the duplicate row is not marked, so nothing can tell it apart" \
  "src/core/transcript_content_dedupe.py" \
  '            DEDUPE_KIND_CONTENT_DUPLICATE,
            match.archive_id,||=>||            None,
            match.archive_id,'

mutate "the duplicate row gets NO line index, silently under-reporting every join" \
  "src/core/transcript_content_dedupe.py" \
  '    conn.execute(
        "INSERT INTO transcript_records"||=>||    _skip = lambda *a, **k: None
    _skip(
        "INSERT INTO transcript_records"'

mutate "a duplicate attaches to another sentinel rather than the content holder" \
  "src/core/transcript_content_dedupe.py" \
  '        " ORDER BY (superseded_by_archive_id IS NOT NULL) ASC, id ASC"||=>||        " ORDER BY id DESC"'

echo "--- BLOCK 5: prefix dedupe must still work for a genuinely GROWN file ---"

mutate "a grown file is misreported as a content duplicate" \
  "src/core/transcript_corpus_ingest.py" \
  '    match = find_archive_by_content(conn, current_sha)
    if match is not None:||=>||    match = find_archive_by_content(conn, current_sha) or (
        find_archive_by_content(conn, existing["content_sha256"])
        if existing else None
    )
    if match is not None:'

mutate "the content branch runs BEFORE the unchanged-file fast path, so a re-run duplicates" \
  "src/core/transcript_corpus_ingest.py" \
  '    if existing is not None and existing["content_sha256"] == current_sha:||=>||    if False:'

echo "--- BLOCK 6: a mass re-archive must be LOUD, and an ordinary one must be QUIET ---"

mutate "the mass-rearchive finding is never emitted - the original silence" \
  "src/core/transcript_corpus_ingest.py" \
  '    if report.content_duplicates <= MASS_REARCHIVE_THRESHOLD:
        return False||=>||    if True:
        return False'

mutate "the finding fires on EVERY pass with any duplicate at all (furniture)" \
  "src/core/transcript_corpus_ingest.py" \
  '    if report.content_duplicates <= MASS_REARCHIVE_THRESHOLD:||=>||    if report.content_duplicates < 1:'

mutate "the finding detail loses the count it exists to report" \
  "src/core/transcript_content_dedupe.py" \
  '        f"{duplicate_count} files in one pass had a content_sha256 already "||=>||        f"some files in one pass had a content_sha256 already "'

mutate "an unrecordable finding is allowed to kill the whole ingest pass" \
  "src/core/transcript_corpus_ingest.py" \
  '    except (sqlite3.Error, ValueError) as exc:||=>||    except (ZeroDivisionError,) as exc:'

restore_all
echo
echo "killed ${killed}, survived ${survived}, cannot_determine ${cannot_determine}"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
