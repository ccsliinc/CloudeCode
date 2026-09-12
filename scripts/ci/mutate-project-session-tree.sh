#!/bin/bash
# Mutation check for S8: the home-screen project-to-session tree.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below reintroduces one specific way this build step can silently hand
# the user a wrong answer, and every one must turn the node suite red.
# Modelled on scripts/ci/mutate-s9-recent-and-pills.sh - same harness
# shape, same restore-on-exit discipline, same baseline gate.
#
# Client-only change, so this mutates and re-runs only the client suites,
# not pytest.
#
# SLICE 7 TOOK BOTH HALVES OF THIS SCRIPT AT ONCE: the source it mutated
# (client/js/launchpad.js) AND the suite it scored against
# (tests/test_project_session_tree.node.mjs). It armed the missing source
# first, so it aborted at mutate_arm_trap and never reached the missing
# suite. Both are repointed here, and the rules survived the port almost
# line for line:
#
#   the attribution ladder and NEEDS ATTENTION  web/src/lib/launchpad/project-groups.ts
#   presence, the disabled rule, the id ladder  web/src/lib/launchpad/project-node.ts
#   the MISSING badge's own text                client/js/labels/project-tree.js
#   the chevron, the children, the fold         web/src/lib/launchpad/ProjectNode.svelte
#   the collapse set itself                     web/src/lib/launchpad/tree-collapse.svelte.ts
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
cd "$ROOT" || exit 1
WEB_TESTS=(
  "web/src/lib/launchpad/project-groups.test.ts"
  "web/src/lib/launchpad/project-node.test.ts"
  "web/src/lib/launchpad/tree-collapse.test.ts"
  "web/src/lib/launchpad/ProjectTree.behaviour.test.ts"
  # A COVERAGE GAP, RECORDED RATHER THAN PAPERED OVER. Dropping the
  # MISSING badge's text SURVIVED all four suites above; it is caught
  # only by entry-flows.test.ts, which covers the PICKER, and by the i18n
  # coverage test. So the project TREE's own behaviour suite does not
  # assert that a missing project says so on the row, even though that
  # badge is the whole point of the presence probe. Measured by applying
  # the mutation and running each suite alone.
  "web/src/lib/launchpad/entry-flows.test.ts"
)

FILES=(
  "web/src/lib/launchpad/project-groups.ts"
  "web/src/lib/launchpad/project-node.ts"
  "web/src/lib/launchpad/ProjectNode.svelte"
  "client/js/labels/project-tree.js"
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
echo "--- baseline: the suites must be GREEN before anything is mutated ---"
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

mutate "'none' collapsed into 'unknown' - an actionable answer becomes NEEDS ATTENTION" \
  "web/src/lib/launchpad/project-groups.ts" \
  '        if (attribution === '"'"'unknown'"'"') {||=>||        if (attribution === '"'"'unknown'"'"' || attribution === '"'"'none'"'"') {'

mutate "'unknown' collapsed into 'none' - an unproven answer renders as measured" \
  "web/src/lib/launchpad/project-groups.ts" \
  '        if (attribution === '"'"'unknown'"'"') {
            // REASON 4.
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.dirUnreadable,
            });
        } else if (attribution === '"'"'none'"'"') {||=>||        if (attribution === '"'"'__never_matches__'"'"') {
            // REASON 4.
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.dirUnreadable,
            });
        } else if (attribution === '"'"'none'"'"' || attribution === '"'"'unknown'"'"') {'

mutate "presence-disabled state is never computed, so a missing project's actions are never refused" \
  "web/src/lib/launchpad/project-node.ts" \
  '    const isDisabled = presenceState === '"'"'missing'"'"' || presenceState === '"'"'unreachable'"'"';||=>||    const isDisabled = false;'

mutate "the MISSING badge text is silently dropped" \
  "client/js/labels/project-tree.js" \
  '    if (state === '"'"'missing'"'"') return t(PROJECT_TREE_KEYS.presenceMissing);||=>||    if (state === '"'"'missing'"'"') return null;'

mutate "child session rows are never rendered under their project, even when matched" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '    {#if view.hasChildren}||=>||    {#if false && view.hasChildren}'

mutate "the toggle chevron is never rendered, so a populated project looks like it has no sessions" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '            {#if view.foldable}||=>||            {#if false && view.foldable}'

mutate "a failed attribution fetch is silently ignored - sessions render as if attribution succeeded" \
  "web/src/lib/launchpad/project-groups.ts" \
  '        if (!input.sessionAttributionListingOk) {||=>||        if (false) {'

mutate "a session missing from the attribution map is silently skipped instead of flagged" \
  "web/src/lib/launchpad/project-groups.ts" \
  '        // REASON 3.
        if (!rec) {||=>||        // REASON 3.
        if (false) {'

mutate "a project_id-less row is silently dropped from NEEDS ATTENTION instead of flagged" \
  "web/src/lib/launchpad/project-groups.ts" \
  '        } else {
            // REASON 5.
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.noProjectId,
            });
        }||=>||        } else {
            // REASON 5.
        }'

mutate "a node collapsed by the user renders expanded again on the next render" \
  "web/src/lib/launchpad/ProjectNode.svelte" \
  '    const collapsed = $derived(treeCollapse.isCollapsed(view.nodeKey));||=>||    const collapsed = $derived(false);'

restore_all
echo
echo "killed ${killed}, survived ${survived}"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
