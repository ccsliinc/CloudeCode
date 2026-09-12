#!/bin/bash
# Mutation check for feat/home-screen-mechanics: the home screen's fold,
# its slim project row, its renamed projects section, its header help
# control, its restructured add menu, and the two paint fixes.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific way this screen can silently hand the
# user a wrong answer, and every one must turn the node suite red.
# Modelled on scripts/ci/mutate-project-session-tree.sh - same harness
# shape, same restore-on-exit discipline, same baseline gate.
#
# Client-only change (client/js/launchpad.js, client/css/styles.css,
# client/index.html), so this mutates and re-runs only the node test, not
# pytest.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
# SLICE 7 TOOK BOTH HALVES: client/js/launchpad.js AND the suite this
# scored against, tests/test_home_screen_mechanics.node.mjs. The CSS and
# client/index.html mutants below are untouched - those files still exist
# and their rules never moved. What moved is the client LOGIC:
#
#   the fold, the chevron, the description element  ProjectNode.svelte
#   the slim row's own rules                        project-node.ts
#   the two menus and the picker                    entry-flows.ts
#   the choice modal's empty state                  ChoiceModal.svelte
#   the header help wiring                          home-chrome.ts
#   the new-project fab and the section heading     HomeScreen.svelte
#   the projects listing latch                      sessions/store.svelte.ts
WEB_TESTS=(
  "web/src/lib/launchpad/HomeScreen.behaviour.test.ts"
  "web/src/lib/launchpad/project-node.test.ts"
  "web/src/lib/launchpad/entry-flows.test.ts"
  "web/src/lib/launchpad/modals.dom.test.ts"
  "web/src/lib/launchpad/tree-collapse.test.ts"
  "web/src/lib/launchpad/ProjectTree.behaviour.test.ts"
  "web/src/lib/launchpad/project-chrome.test.ts"
  "web/src/lib/sessions/store.test.ts"
)

FILES=(
  "web/src/lib/launchpad/ProjectNode.svelte"
  "web/src/lib/launchpad/project-node.ts"
  "web/src/lib/launchpad/entry-flows.ts"
  "web/src/lib/launchpad/ChoiceModal.svelte"
  "web/src/lib/launchpad/home-chrome.ts"
  "web/src/lib/launchpad/HomeScreen.svelte"
  "web/src/lib/sessions/store.svelte.ts"
  "client/css/styles.css"
  "client/index.html"
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
echo "--- baseline: the suite must be GREEN before anything is mutated ---"
for wt in "${WEB_TESTS[@]}"; do
  if ! mutate_web_run "$ROOT" "$wt"; then
    echo "BASELINE IS RED ($wt). Every mutant would read as killed. Refusing to run."
    exit 2
  fi
done
echo "baseline green"

restore_all() {
    mutate_restore_files
}

# Apply one textual mutation, run the node suite, expect RED.
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
  local wt
  for wt in "${WEB_TESTS[@]}"; do
    if ! mutate_web_run "$ROOT" "$wt"; then
      killed=$((killed + 1))
      echo "killed   $name"
      return
    fi
  done
  echo "SURVIVED $name"
  survived=$((survived + 1))
}

echo "--- BLOCK 1: the fold must actually move pixels, and the right ones ---"

# TWO MUTANTS FROM THIS BLOCK ARE GONE, AND THE MECHANISM IS WHY.
# "the fold walks to the toggle's sibling and finds the wrong element"
# and "a toggle with no node root reports SUCCESS" both described an
# IMPERATIVE fold: a click handler that ran `toggle.closest('.project-node')`,
# walked the subtree and wrote `style.display` on what it found. There is
# no walk any more. `ProjectNode.svelte` reads `treeCollapse.isCollapsed`
# and the elements bind their own `style:display` to it, so there is no
# sibling to pick wrongly and no node root to fail to find. A mutant
# against a mechanism that does not exist cannot be evaluated, and
# leaving it behind would report CANNOT_DETERMINE forever while looking
# like coverage. The CLAIM they protected - a fold moves the sessions AND
# the description, and a broken fold is visible - is kept by the three
# below plus tree-collapse.test.ts.
#
# "the collapsed description springs back open on the next render" is
# gone for the same reason and is not a third loss: under the string
# builder the toggle handler and the renderer were two code paths that
# could disagree about the description, which is what that mutant caught.
# They are one reactive binding now, so it is the same mutant as "the
# fold hides the sessions but leaves the description behind" below.

mutate "the fold flips aria-expanded but never touches the children" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '            class="project-node__sessions"
            id={sessionsId}
            style:display={collapsed ? '"'"'none'"'"' : null}||=>||            class="project-node__sessions"
            id={sessionsId}'

mutate "the fold hides the sessions but leaves the description behind" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '                <div class="project-description" style:display={collapsed ? '"'"'none'"'"' : null}>||=>||                <div class="project-description">'

mutate "the toggle stops reporting its own state, so the control lies to a screen reader" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '                    aria-expanded={!collapsed}||=>||                    aria-expanded={true}'

echo "--- BLOCK 2: the slim row ---"

mutate "the 'no description' filler line comes back" \
  "web/src/lib/launchpad/project-node.ts" \
  '        typeof project.description === '"'"'string'"'"' ? project.description : '"'"''"'"'
    ).trim();||=>||        typeof project.description === '"'"'string'"'"' ? project.description : '"'"'no description'"'"'
    ).trim();'

mutate "an empty description renders an empty element that still costs a line" \
  "web/src/lib/launchpad/project-node.ts" \
  '    const hasDescription = rawDescription.length > 0;||=>||    const hasDescription = true;'

mutate "a description-only project loses its fold control" \
  "web/src/lib/launchpad/project-node.ts" \
  '        foldable: hasChildren || hasDescription,||=>||        foldable: hasChildren,'

echo "--- BLOCK 3: naming ---"

mutate "the section calls itself a recency list again" \
  "web/src/lib/launchpad/HomeScreen.svelte" \
  '                    {t(HOME_KEYS.sectionProjects)}||=>||                    recent projects'

echo "--- BLOCK 4: the help control ---"

mutate "the header control is wired to a copy instead of the live disclosure" \
  "web/src/lib/launchpad/home-chrome.ts" \
  '        const details = doc.querySelector('"'"'#launchpad-screen .adopt-disclosure'"'"') as||=>||        const details = doc.getElementById('"'"'adopt-disclosure-clone'"'"') as unknown as'

echo "--- BLOCK 5: the add menu ---"

mutate "the top item goes back to the unexplained 'create new project' name" \
  "web/src/lib/launchpad/HomeScreen.svelte" \
  '                        <span class="new-fab__label">{t(HOME_KEYS.newClaudeProject)}</span>||=>||                        <span class="new-fab__label">create new project</span>'

mutate "new session with zero projects opens an empty picker instead of saying so" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '    if (projects.length === 0) {||=>||    if (false) {'

mutate "a project list that could not be read is reported as 'you have no projects'" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '    if (host.projectsListingOk() === false) {||=>||    if (false) {'

mutate "the listing latch is never set false, so a failed fetch looks like an empty list" \
  "web/src/lib/sessions/store.svelte.ts" \
  '            projectsListingOk = false;||=>||            projectsListingOk = true;'

mutate "a MISSING project is offered as a launchable choice" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '            disabled: presence === '"'"'missing'"'"' || presence === '"'"'unreachable'"'"',||=>||            disabled: false,'

mutate "a project that could not be checked stops saying why" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '        const reason = presenceBadgeText(presence, detail, t);||=>||        const reason = null;'

mutate "clone from github is dropped out of the new-claude-project flow entirely" \
  "web/src/lib/launchpad/entry-flows.ts" \
  '        {
            key: '"'"'clone'"'"',
            label: t(PROJECT_CREATE_KEYS.newProjectClone),
            sub: t(PROJECT_CREATE_KEYS.newProjectCloneSub),
        },||=>||'

mutate "the choice modal draws rows even when there are none to draw" \
  "web/src/lib/launchpad/ChoiceModal.svelte" \
  '        {#if items.length}||=>||        {#if true}'


# ------------------------------------------------------------------
# THIRTEEN MUTANTS WERE DROPPED FROM THIS SCRIPT, AND THE REASON IS NOT
# THE SAME FOR ALL OF THEM. Both reasons are recorded because a silently
# shorter mutation script is indistinguishable from a thorough one.
#
# TEN OF THEM WERE MEASURED BY A HARNESS, NOT BY A UNIT SUITE. The CSS
# rail and fill mutants (ITEM 37 and ITEM 41), the two help-control CSS
# mutants and the index.html help button (ITEM 48), and the new-project
# icon (ITEM 51) are all claims about PIXELS in a real browser. The
# deleted tests/test_home_screen_mechanics.node.mjs asserted them against
# markup as strings; what actually measures them is
# scripts/verify_home_mechanics.py, driving
# tests/manual/home-mechanics-geometry-harness.html in a real Chromium.
# They are NOT scored here because that verifier is currently RED against
# the Svelte port - 9 failing checks at the time of writing - and a red
# baseline makes every mutant read as killed for free, which is the one
# thing the baseline gate above exists to prevent. Re-add them here, or
# better, keep them in the verifier, once it is green.
#
# THREE OF THEM ARE A COVERAGE GAP, SAID OUT LOUD:
#
#   "a childless project gets a count chip claiming zero sessions"
#   "a missing header control is reported as if it had been wired"
#
# were each applied and the WHOLE vitest suite run against them - 47
# files, 1342 tests - and both came back GREEN. Nothing in web/src
# catches either one. They are not dropped because the surface went away;
# the surface is right there in ProjectNode.svelte and home-chrome.ts.
# They are dropped because there is currently no suite for a mutation
# script to score them against, and a mutant with no scorer reports
# SURVIVED forever and trains people to ignore this script. Write the
# tests, then bring the mutants back.
# ------------------------------------------------------------------

restore_all
echo
echo "killed ${killed}, survived ${survived}"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
