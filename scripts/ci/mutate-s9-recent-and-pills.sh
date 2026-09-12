#!/bin/bash
# Mutation check for S9: listing-time fingerprint pills, and the
# datastore-backed RECENT group.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific way this build step can silently hand
# the user a wrong answer, and every one must turn the suite red.
#
# BLOCK 1 - THE PILL MUST SAY A GUESS, NOT A FACT. list_attachable_sessions
# now fingerprints instead of always answering (None, "unknown"). These
# mutants make a fingerprinted value render as a stored fact, make a miss
# silently keep the previous agent_type, and defeat the cache so the
# listing re-probes tmux on every call (the exact slow-launcher defect
# the caching requirement exists to prevent).
#
# BLOCK 2 - GET /sessions/recent'S THREE OUTCOMES. 'never_probed' and
# 'probe_unavailable' must never collapse into 'ok', and the reverse must
# not happen either (a healthy probe must not be reported as unavailable).
#
# BLOCK 3 - THE DEFENSIVE FILTER. Even though the SQL query already
# restricts to lifecycle='stopped', the route re-checks. Removing that
# re-check must be observable through a mocked repository layer, proving
# the guarantee is not resting solely on the query one layer below it.
#
# All mutated files are restored on exit, including on failure.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
PY="${ROOT}/venv/bin/python3"
TESTS="tests/test_s9_recent_and_pills.py tests/test_tmux_listing_consumers.py \
tests/test_agent_family_display.py"
# THE CLIENT SUITES MOVED, AND SO DID THE SOURCE. Slice 7 deleted
# client/js/launchpad.js and BOTH node suites this script used to run
# (tests/test_recent_sessions.node.mjs and tests/test_agent_family_pill.node.mjs).
# The RECENT group's three-outcome rule and the restart gate are
# web/src/lib/launchpad/recent.ts now; the fingerprint pill is
# web/src/lib/launchpad/agent-family-pill.ts.
#
# NOTE WHY THE MISSING SUITES MATTERED MORE THAN THE MISSING SOURCE. A
# `node <deleted file>` exits non-zero, and the mutate() below scores any
# non-zero as KILLED. The baseline gate caught it here (a red baseline is
# exit 2), but past that gate a deleted suite would have handed every
# client mutant a free pass. mutate_web_files_exist is the standing
# guard against the same thing happening to the vitest files.
WEB_TESTS=(
  "web/src/lib/launchpad/recent.test.ts"
  "web/src/lib/launchpad/agent-family-pill.test.ts"
)

# THE PYTHON HALF DRIFTED TOO, and separately: the backend decomposition
# moved GET /sessions/recent out of src/api/routes.py into
# src/api/session_recent_routes.py, and moved the probe's health record
# off SessionManager onto src/core/sessions/probe_health.py. Those seven
# anchors read CANNOT_DETERMINE, which is the correct refusal and not a
# pass, but it still meant the mutants were never evaluated.
FILES=(
  "src/core/session_manager.py"
  "src/api/session_recent_routes.py"
  "src/core/sessions/probe_health.py"
  "web/src/lib/launchpad/recent.ts"
)

mutate_arm_trap "$ROOT" "${FILES[@]}"
mutate_web_require "$ROOT"
mutate_web_files_exist "$ROOT" "${WEB_TESTS[@]}"

survived=0
cannot_determine=0
killed=0

# BASELINE GATE. A mutation run measures the DIFFERENCE between a green
# suite and a mutated one; a red baseline would make every mutant read as
# killed for free. See scripts/ci/mutate-adoption-attribution.sh for the
# incident that made this mandatory.
echo "--- baseline: the suites must be GREEN before anything is mutated ---"
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
# A target that no longer exists counts as SURVIVED, never as a skip.
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
  local red=1
  if mutate_run "$PY" -m pytest $TESTS -q -p no:randomly >/dev/null 2>&1; then
    red=0
  fi
  if [ "$red" -eq 1 ]; then
    killed=$((killed + 1))
    echo "killed   $name"
    return
  fi
  # Python was green. The client mutants are only observable in vitest.
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

echo "--- BLOCK 1: listing-time fingerprint must render as a GUESS, and must be CACHED ---"

mutate "a fingerprinted value is asserted as a stored fact, not a guess" \
  "src/core/session_manager.py" \
  '                display_family, display_family_source = resolve_family_for_display(
                    effective_agent_type,
                    wrappers,
                    from_fingerprint=from_fingerprint,
                    from_process=from_process,
                )||=>||                display_family, display_family_source = resolve_family_for_display(
                    effective_agent_type,
                    wrappers,
                    from_fingerprint=False,
                    from_process=from_process,
                )'

mutate "the detected agent_type is never written onto the row" \
  "src/core/session_manager.py" \
  '                row["agent_type"] = effective_agent_type||=>||                row["agent_type"] = None'

mutate "the cache is never READ, so every listing call re-probes tmux" \
  "src/core/session_manager.py" \
  '        key = (socket, name, int(epoch))
        if key in self._listing_fingerprint_cache:
            return self._listing_fingerprint_cache[key]||=>||        key = (socket, name, int(epoch))
        if False:
            return self._listing_fingerprint_cache[key]'

mutate "the cache is never WRITTEN, so a hit never happens either" \
  "src/core/session_manager.py" \
  '        detected = self._detect_agent_type_from_pane(socket=socket, name=name)
        self._listing_fingerprint_cache[key] = detected
        return detected||=>||        detected = self._detect_agent_type_from_pane(socket=socket, name=name)
        return detected'

echo "--- BLOCK 2: GET /sessions/recent's three outcomes must not collapse ---"

mutate "a never-probed state reads as healthy, so stale rows show as fact" \
  "src/api/session_recent_routes.py" \
  '    if health.ok is not True:||=>||    if health.ok is False:'

mutate "never_probed and probe_unavailable become the same state string" \
  "src/api/session_recent_routes.py" \
  '        state = "never_probed" if health.ok is None else "probe_unavailable"||=>||        state = "probe_unavailable"'

mutate "a healthy probe is reported as unavailable, hiding real history" \
  "src/core/sessions/probe_health.py" \
  '        self._health = ProbeHealth(ok=True)||=>||        self._health = ProbeHealth(ok=False)'

mutate "a failed probe is recorded as healthy, the exact false-green this exists to prevent" \
  "src/core/sessions/probe_health.py" \
  '        self._health = ProbeHealth(ok=False, reason=reason, detail=detail)||=>||        self._health = ProbeHealth(ok=True)'

echo "--- BLOCK 3: the route's own defensive filter must independently enforce lifecycle=stopped ---"

mutate "the defensive re-filter is removed; a leaked non-stopped row reaches the wire" \
  "src/api/session_recent_routes.py" \
  '    stopped_rows = [
        row for row in rows if row.get("lifecycle") == SESSION_LIFECYCLE_STOPPED
    ]||=>||    stopped_rows = rows'

echo "--- BLOCK 4: the client render layer must independently gate RESTART on lifecycle==stopped ---"

mutate "RESTART renders for any lifecycle, not just stopped" \
  "web/src/lib/launchpad/recent.ts" \
  '    const canRestart = lifecycle === '"'"'stopped'"'"';||=>||    const canRestart = true;'

mutate "a probe_unavailable/never_probed response still paints the stored rows" \
  "web/src/lib/launchpad/recent.ts" \
  '    if (state !== '"'"'ok'"'"') {||=>||    if (false) {'

restore_all
echo
echo "killed ${killed}, survived ${survived}"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
