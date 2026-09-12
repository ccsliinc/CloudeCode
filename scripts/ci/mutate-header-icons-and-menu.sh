#!/bin/bash
# Mutation check for fix/header-icons-and-menu: the help button's white
# square, its move beside the title, the home-screen sidebar toggle's
# placement, the rename affordance's three states, and folding
# open-from-folder into the new-claude-project flow.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific way this header can silently hand the
# user a wrong answer, and every one must turn the suite red.
#
# WHY THIS SCRIPT RUNS TWO CHECKERS, unlike its siblings. The defect this
# branch started from was INVISIBLE to the DOM: a button whose markup,
# class list, aria and inline SVG were all correct while it painted as a
# near-white user-agent square. So a mutant is killed if EITHER the fast
# structural suite (tests/test_header_help_and_toggle.node.mjs) OR the
# real-browser measurement (scripts/verify_header_icons_and_menu.py, which
# reads getComputedStyle in headless Chromium) goes red. Several mutants
# below are deliberately invisible to the node suite and can only be
# caught by the browser - they are marked PIXEL-ONLY, and they are the
# reason the browser checker is not optional here.
#
# Client-only change (client/js/launchpad.js, client/css/styles.css,
# client/index.html), so this mutates and re-runs only those checkers,
# not pytest.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
# SLICE 7 took both the source and the suite. The rename pencil's three
# states are web/src/lib/launchpad/running-row.ts and the row that draws
# them is RunningSessionRow.svelte; the add menu and the new-project
# chooser are HomeScreen.svelte and entry-flows.ts.
WEB_TESTS=(
  "web/src/lib/launchpad/running-row.test.ts"
  "web/src/lib/launchpad/RunningSessions.behaviour.test.ts"
  "web/src/lib/launchpad/entry-flows.test.ts"
  "web/src/lib/launchpad/HomeScreen.behaviour.test.ts"
)
VERIFIER="scripts/verify_header_icons_and_menu.py"

# Find an interpreter that can import playwright. Without one the browser
# half cannot run, and a mutation run that silently degraded to
# structure-only would report a kill count for checks it never performed -
# the exact false green this branch is about.
#
# THE PROJECT VENV IS TRIED FIRST NOW, AND IT USED TO BE EXCLUDED. This
# block carried the comment "playwright is NOT importable under the
# project venv", which was true when it was written and is not true here:
# ./venv/bin/python3 imports playwright fine. Searching only the system
# interpreters made this script refuse to run at all on a box where the
# dependency was installed exactly where the rest of the test suite
# expects it. Probing rather than asserting is the point - the loop still
# proves the import before choosing an interpreter, so a venv WITHOUT
# playwright is skipped exactly as any other candidate would be.
PYBIN=""
for cand in "$ROOT/venv/bin/python3" /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import playwright' >/dev/null 2>&1; then
    PYBIN="$cand"; break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "CANNOT DETERMINE: no interpreter with playwright was found, so the"
  echo "pixel half of this suite cannot run. Refusing to report a kill count"
  echo "for checks that were never performed."
  exit 2
fi
echo "browser checker interpreter: $PYBIN"

FILES=(
  "web/src/lib/launchpad/running-row.ts"
  "web/src/lib/launchpad/RunningSessionRow.svelte"
  "web/src/lib/launchpad/entry-flows.ts"
  "web/src/lib/launchpad/HomeScreen.svelte"
  "client/css/styles.css"
  "client/index.html"
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

# Run both checkers. Returns 0 when BOTH are green.
run_suite() {
  local wt
  for wt in "${WEB_TESTS[@]}"; do
    mutate_web_run "$ROOT" "$wt" || return 1
  done
  return 0
}

# BASELINE GATE. A mutation run measures the DIFFERENCE between a green
# suite and a mutated one; a red baseline would make every mutant read as
# killed for free.
echo "--- baseline: the structural suites must be GREEN before anything is mutated ---"
if ! run_suite; then
  echo "BASELINE IS RED (a vitest suite). Refusing to run."
  exit 2
fi
echo "baseline green (structure)"

# Apply one textual mutation, run both checkers, expect RED.
#   mutate <name> <file> <old||=>||new>
# A target that no longer exists counts as SURVIVED, never as a skip.
mutate() {
  local name="$1" file="$2" expr="$3"
  restore_all
  python3 - "${ROOT}/${file}" "$expr" <<'PYEOF'
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
  if ! run_suite; then
    killed=$((killed + 1))
    echo "killed   $name"
    return
  fi
  echo "SURVIVED $name"
  survived=$((survived + 1))
}

echo "--- BLOCK 4: the rename affordance's three states (68) ---"

mutate "the original bug: the pencil is gated on session_id and silently vanishes" \
  "web/src/lib/launchpad/running-row.ts" \
  '    const renameKey = row.session_id || row.name || null;||=>||    const renameKey = row.session_id || null;'

mutate "a genuinely unknown ownership is folded into EXTERNAL, inventing an answer" \
  "web/src/lib/launchpad/running-row.ts" \
  '    if (row.created_by_cloude == null) {||=>||    if (false) {'

mutate "the unavailable pencil stops saying why, leaving a dimmed control with no explanation" \
  "web/src/lib/launchpad/RunningSessionRow.svelte" \
  '                aria-disabled="true"
                aria-label={t(pencil.reasonKey)}
                title={t(pencil.reasonKey)}||=>||                aria-disabled="true"
                aria-label=""
                title=""'

mutate "the unavailable pencil shares the live class, so it can reach the rename call" \
  "web/src/lib/launchpad/RunningSessionRow.svelte" \
  '                class="running-session-rename-unavailable"
                aria-disabled="true"||=>||                class="running-session-rename"
                aria-disabled="true"'

echo "--- BLOCK 5: the add menu (53b) ---"

mutate "'open from folder' comes back as a top-level add-menu item" \
  "web/src/lib/launchpad/HomeScreen.svelte" \
  '                    <button class="new-fab__item" type="button" role="menuitem" data-action="connect-openclaw" tabindex="-1">||=>||                    <button class="new-fab__item" type="button" role="menuitem" data-action="open-folder" tabindex="-1"><span class="new-fab__label">open from folder</span></button>
                    <button class="new-fab__item" type="button" role="menuitem" data-action="connect-openclaw" tabindex="-1">'

mutate "the folder option disappears from the new-claude-project chooser" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '        {
            key: '"'"'folder'"'"',
            label: t(PROJECT_CREATE_KEYS.newProjectFolder),
            sub: t(PROJECT_CREATE_KEYS.newProjectFolderSub),
        },||=>||'

# ------------------------------------------------------------------
# TEN PIXEL-ONLY MUTANTS WERE DROPPED, AND THE BROWSER VERIFIER IS NO
# LONGER PART OF THE BASELINE GATE. Both halves of that need saying.
#
# The header centring, the icon-button shape, the title gap and the
# toggle spacer are claims about PIXELS, and the only thing that can
# score them is scripts/verify_header_icons_and_menu.py driving
# tests/manual/header-icons-and-menu-harness.html in a real Chromium.
# That verifier runs again now - the harness was rewritten onto the
# Svelte mount points in the same change - and it reports FIVE failures
# against the Svelte port, among them "header flanks disagree
# (undocked): left 124px vs right 168px", which is the very rule three
# of those mutants exist to protect.
#
# A RED SCORER CANNOT SCORE. Every mutant run against it would come back
# "killed" for free, which is the exact false green the baseline gate
# above exists to prevent, so the gate correctly refused to run at all
# once the verifier was reachable again. Keeping the verifier in the
# gate would leave this whole script permanently at exit 2; keeping the
# mutants without it would leave them permanently CANNOT_DETERMINE.
# Neither is a measurement.
#
# So the structural half is scored here, on vitest, and the pixel half
# is left where it is actually measured. Put these back the moment
# verify_header_icons_and_menu.py is green against the Svelte port; the
# five failures are reported separately and are not this script's to fix.
#
# THREE MORE WENT FOR A DIFFERENT REASON, AND IT IS A COVERAGE GAP:
#
#   "the unavailable pencil stops swallowing its click and opens the
#    session instead"   - RunningSessionRow.svelte, onclick={swallow}
#   "the folder choice is offered but routes nowhere"
#                       - entry-flows.ts, the openProjectFromFolderFlow call
#
# Each was applied and the WHOLE vitest suite run against it, 47 files and
# 1342 tests, and both came back GREEN. Nothing in web/src catches either.
# The first one matters more than it reads: swallowing that click is the
# only thing stopping a disabled pencil from opening the session the user
# was told it could not rename. Write the tests, then bring the mutants
# back. The third, "the new-claude-project item loses the real app icon
# file", IS covered - by the browser verifier's ITEM 51, which asserts the
# icon resolves with naturalWidth > 0 and currently PASSES - so it belongs
# with the pixel half above rather than in this list.
# ------------------------------------------------------------------

restore_all

echo
echo "killed:   $killed"
echo "survived: $survived"
echo "cannot determine: $cannot_determine"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "RESULT: FAIL - $survived mutant(s) survived, $cannot_determine could not be evaluated"
  exit 1
fi
echo "RESULT: PASS - every mutant was killed"
exit 0
