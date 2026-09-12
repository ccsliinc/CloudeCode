#!/bin/bash
# Mutation check for the tmux three-outcome listing.
#
# A guard you have not proven can fail is not a guard. Every mutation below
# takes one place that says "I could not evaluate this" and makes it say "I
# evaluated it and the answer is zero" - which is the exact defect the whole
# change removes. Each one must turn the suite RED. A survivor means the
# test that supposedly covers that guard would also pass against the bug.
#
# The mutations come in three families:
#   A. the TYPE - unavailable() stops meaning unavailable
#   B. the SPLIT - "no server running" and a real error collapse together,
#      in each direction (a one-way test would miss one of them)
#   C. the CONSUMERS - the reconciler, the route and the client stop
#      honouring ok=False even though the type still reports it honestly
#
# THE CLIENT HALF MOVED, IT DID NOT GO AWAY. Slice 7 deleted
# `client/js/launchpad.js`, which armed this script with a file that no
# longer exists and made it abort at mutate_arm_trap before a single
# mutant ran. All five client claims survived the port essentially line
# for line: `_noteListingUnknown` and `_listingReasonFromError` are now
# `web/src/lib/sessions/listing.ts` (which says so in its own header),
# the two fetch guards are `web/src/lib/sessions/running.ts`, and the
# attention block and its count badge are
# `web/src/lib/launchpad/RunningSessions.svelte`. So they are repointed
# rather than dropped, and they are scored against VITEST files instead
# of the deleted `tests/test_running_sessions_unknown.node.mjs`.
#
# Every mutated file is restored on exit, including on failure.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/ci/lib/mutate-trap.sh"
source "$ROOT/scripts/ci/lib/mutate-web.sh"
LISTING="$ROOT/src/core/tmux_listing.py"
BACKEND="$ROOT/src/core/tmux_backend.py"
MANAGER="$ROOT/src/core/session_manager.py"
# THE ATTACHABLE ROUTE MOVED in the backend decomposition: it is no
# longer in src/api/routes.py, which is why this mutant read
# CANNOT_DETERMINE rather than survived. It is src/api/session_attach_routes.py now.
ROUTES="$ROOT/src/api/session_attach_routes.py"
WEB_LISTING="$ROOT/web/src/lib/sessions/listing.ts"
WEB_RUNNING="$ROOT/web/src/lib/sessions/running.ts"
WEB_SECTION="$ROOT/web/src/lib/launchpad/RunningSessions.svelte"

STDERR="$ROOT/src/core/tmux_stderr.py"

# The vitest files the client mutants are scored against. Named here so
# mutate_web_files_exist can prove they are real BEFORE anything is
# mutated: vitest exits 1 when a filter matches no file (measured), and
# a mutation script reads non-zero as "killed", so a renamed suite would
# silently turn every client mutant into a free pass.
# MEASURED, NOT GUESSED. Each file below was confirmed to go RED for at
# least one mutant here by applying the mutation and running it alone;
# the first draft of this list named running-host.test.ts and four
# mutants SURVIVED, which is how the list was corrected.
# RunningSessions.behaviour.test.ts is the direct successor to the
# deleted tests/test_running_sessions_unknown.node.mjs and says so in its
# own header.
WEB_TESTS=(
  "web/src/lib/sessions/listing.test.ts"
  "web/src/lib/sessions/running.test.ts"
  "web/src/lib/sessions/store.test.ts"
  "web/src/lib/launchpad/RunningSessions.behaviour.test.ts"
)

FILES=("$LISTING" "$STDERR" "$BACKEND" "$MANAGER" "$ROUTES" \
       "$WEB_LISTING" "$WEB_RUNNING" "$WEB_SECTION")
mutate_arm_trap "$ROOT" "${FILES[@]}"
mutate_web_require "$ROOT"
mutate_web_files_exist "$ROOT" "${WEB_TESTS[@]}"

PY="$ROOT/venv/bin/python3"
if [ ! -x "$PY" ]; then PY="/Users/jsugamele/Development/CloudeCode/venv/bin/python3"; fi

survived=0
cannot_determine=0
killed=0

restore_all() {
  mutate_restore_files
}

# Runs the two suites that own this behaviour. A mutant is KILLED if either
# goes red. Scoped to these two files on purpose: the point is whether THESE
# tests can detect the bug, not whether the repo happens to notice elsewhere.
# Each suite runs through mutate_run so a signal that reaches only this
# script's own PID can still interrupt a suite that is mid-run (see
# scripts/ci/lib/mutate-trap.sh for why a plain foreground call cannot be
# interrupted that way).
run_suites() {
  mutate_run "$PY" -m pytest "$ROOT/tests/test_tmux_listing.py" \
    "$ROOT/tests/test_tmux_listing_consumers.py" -q >/dev/null 2>&1 || return 1
  local wt
  for wt in "${WEB_TESTS[@]}"; do
    mutate_web_run "$ROOT" "$wt" || return 1
  done
  return 0
}

# mutate <name> <file> <old||=>||new>
mutate() {
  local name="$1" file="$2" expr="$3"
  restore_all
  python3 - "$file" "$expr" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
old, new = expr.split('||=>||')
if old not in text:
    sys.exit('mutation target not found: ' + old[:70])
open(path, 'w', encoding='utf-8').write(text.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then echo "CANNOT_DETERMINE $name (target moved)"; cannot_determine=$((cannot_determine + 1)); return; fi
  if run_suites; then
    echo "SURVIVED $name"
    survived=$((survived + 1))
  else
    echo "killed   $name"
    killed=$((killed + 1))
  fi
}

# --- A. the type itself stops distinguishing the two outcomes ----------
mutate "unavailable() reports ok=True" "$LISTING" \
  "return cls(ok=False, sessions=[], reason=reason, detail=detail)||=>||return cls(ok=True, sessions=[], reason=reason, detail=detail)"

# --- B. the split collapses, in BOTH directions ------------------------
mutate "every failure is read as 'no server'" "$STDERR" \
  "    return classify_tmux_stderr(stderr_text) == STDERR_NO_SERVER||=>||    return True"

mutate "'no server' is read as a real error" "$STDERR" \
  "    return classify_tmux_stderr(stderr_text) == STDERR_NO_SERVER||=>||    return False"

mutate "classify_listing_failure always answers zero" "$LISTING" \
  "    if verdict == STDERR_NO_SERVER:||=>||    if True:"

# --- A2. the backend's own could-not-evaluate branches -----------------
mutate "missing tmux binary reports zero sessions" "$BACKEND" \
  "                TmuxListing.unavailable(
                    REASON_TMUX_MISSING,
                    detail=\"tmux not found on PATH or at any well-known \"
                           \"install location\",
                ),||=>||                TmuxListing.answered([]),"

mutate "a timed-out probe reports zero sessions" "$BACKEND" \
  "                TmuxListing.unavailable(
                    REASON_TIMEOUT,
                    detail=f\"tmux did not answer within {LIST_TIMEOUT_SECONDS}s\",
                ),||=>||                TmuxListing.answered([]),"

mutate "the listing subprocess loses its timeout" "$BACKEND" \
  "                timeout=LIST_TIMEOUT_SECONDS,||=>||                timeout=None,"

# --- C. the consumers stop honouring ok=False --------------------------
mutate "the reconciler prunes against an unavailable listing" "$MANAGER" \
  "        listing = coerce_listing(probe.discover_existing())
        if not listing.ok:||=>||        listing = coerce_listing(probe.discover_existing())
        if False:"

mutate "the attachable route answers 200 [] on a failed probe" "$ROUTES" \
  "    listing = coerce_listing(session_manager.list_attachable_sessions())
    if not listing.ok:||=>||    listing = coerce_listing(session_manager.list_attachable_sessions())
    if False:"

mutate "the client latches the listing back to ok" "$WEB_LISTING" \
  "    state.ok = false;||=>||    state.ok = true;"

mutate "a second probe failure overwrites the first reason" "$WEB_LISTING" \
  "    if (!state.reason) state.reason = reason || DEFAULT_REASON;||=>||    state.reason = reason || DEFAULT_REASON;"

mutate "the attention block is never rendered" "$WEB_SECTION" \
  "    const listingOk = \$derived(!listing || listing.ok !== false);||=>||    const listingOk = \$derived(true);"

mutate "the heading reports a count it never measured" "$WEB_SECTION" \
  "        listingOk
            ? runningCountLabel(rows.length, t)
            : runningCountUnavailableLabel(t),||=>||        runningCountLabel(rows.length, t),"

mutate "the failed fetch falls back to an empty list again" "$WEB_RUNNING" \
  "        rows = [];
        noteListingUnknown(
            listing, 'attachable',||=>||        rows = [];
        if (false) noteListingUnknown(
            listing, 'attachable',"

mutate "a malformed attachable body is read as an empty list" "$WEB_RUNNING" \
  "    noteListingUnknown(listing, 'attachable', 'malformed_response', malformedDetail);||=>||    void malformedDetail;"

mutate "the failed live merge is swallowed again" "$WEB_RUNNING" \
  "        if (status !== 404) {||=>||        if (false) {"

restore_all
echo
echo "killed $killed, survived $survived"
if [ "$survived" -ne 0 ] || [ "$cannot_determine" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
