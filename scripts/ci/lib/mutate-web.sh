#!/bin/bash
# Run one vitest file for a mutation harness, and refuse to guess when it
# cannot be run at all.
#
# WHY THIS EXISTS. Slice 7 of the Svelte migration deleted
# `client/js/launchpad.js`, and with it the standalone `tests/*.node.mjs`
# suites that several mutate-*.sh scripts used to run for their client
# half. The behaviour those suites measured did not go away - it moved
# into `web/src/lib/**` and is covered by VITEST files, which a bare
# `node <file>` cannot execute. So the client half of a mutation script
# now needs a second runner, and it needs one with different failure
# modes from `node`.
#
# THE WHOLE POINT IS THE THIRD OUTCOME. A mutation script proves a suite
# can go RED. It has exactly two useful answers per mutant, killed and
# survived, and one answer that is neither: the suite could not be run,
# so nothing was measured. `node` collapses that into "non-zero", which a
# mutation script reads as KILLED - a mutant that was never evaluated
# would be scored as caught, and the script would report success while
# measuring nothing. That is the exact false green this whole family of
# scripts exists to prevent, so it gets its own exit code here.
#
# The vocabulary is borrowed verbatim from scripts/web-build-check.sh
# rather than invented: "Exit 2 - COULD NOT EVALUATE. 2 IS NOT 0."
#
# Globals read: MUTATE_ROOT (set by mutate_arm_trap).

# Description: is the web/ vitest runner actually usable right now.
#   Checks the three things that are separately absent on a fresh clone,
#   a CI box that skipped the install, and a machine with no node.
# Inputs: root (str) - repo root, absolute.
# Output: 0 when vitest can run, 1 when it cannot. Prints the reason to
#   stderr on 1, naming which of the three is missing.
mutate_web_available() {
    local root="$1"
    if ! command -v node >/dev/null 2>&1; then
        echo "mutate_web: node is not on PATH" >&2
        return 1
    fi
    if [ ! -d "${root}/web" ]; then
        echo "mutate_web: no web/ directory at ${root}/web" >&2
        return 1
    fi
    if [ ! -x "${root}/web/node_modules/.bin/vitest" ]; then
        echo "mutate_web: vitest is not installed - run 'cd web && npm ci'" >&2
        return 1
    fi
    return 0
}

# Description: refuse the whole script when the client half cannot be
#   evaluated. Call this ONCE, beside the baseline gate, in any script
#   that carries web mutants. It exits 2 rather than returning, because
#   there is no honest way to continue: every web mutant would be
#   unmeasured and the script's final "MUTATION CHECK PASSED" would be a
#   lie about coverage it never had.
# Inputs: root (str) - repo root, absolute.
# Output: none on success. Exits 2 otherwise.
mutate_web_require() {
    local root="$1"
    if ! mutate_web_available "$root"; then
        echo "CANNOT EVALUATE the client half. Nothing was proven about it." >&2
        echo "2 IS NOT 0 - this is not a pass." >&2
        exit 2
    fi
}

# Description: run ONE vitest file through mutate_run, so the trap still
#   tracks the child pid and a signal can still interrupt it.
#
#   THE PATH IS REPO-RELATIVE AND THE FILTER IS ANCHORED. vitest is run
#   from inside web/ and given a path relative to web/, and `--dir` is
#   not used: a bare substring filter that matches NOTHING makes vitest
#   exit non-zero, which this script would score as a killed mutant. The
#   caller passes a real file path and `mutate_web_file_exists` below is
#   what proves it is real, BEFORE any mutation is applied.
# Inputs: root (str) - repo root. file (str) - a path under web/,
#   relative to the repo root, e.g. "web/src/lib/sessions/listing.test.ts".
# Output: the vitest exit status. 0 green, non-zero red.
mutate_web_run() {
    local root="$1" file="$2"
    local rel="${file#web/}"
    ( cd "${root}/web" && exec ./node_modules/.bin/vitest run --reporter=dot "$rel" ) \
        >/dev/null 2>&1 &
    MUTATE_CHILD_PID=$!
    wait "$MUTATE_CHILD_PID"
    local rc=$?
    MUTATE_CHILD_PID=""
    return "$rc"
}

# Description: assert every vitest file a script names actually exists,
#   before the script mutates anything.
#
#   A MISSING TEST FILE IS NOT A RED SUITE. vitest exits non-zero when a
#   filter matches no file, and a mutation script reads non-zero as
#   "killed". So a test file that gets renamed or deleted would silently
#   turn every mutant it guards into a free pass. Checking the paths up
#   front turns that into a loud refusal instead, at the one moment
#   nothing has been mutated yet.
# Inputs: root (str) - repo root. files... (str...) - repo-relative paths.
# Output: none. Exits 2 if any path is missing.
mutate_web_files_exist() {
    local root="$1"; shift
    local f missing=0
    for f in "$@"; do
        if [ ! -f "${root}/${f}" ]; then
            echo "mutate_web: named vitest file does not exist: ${f}" >&2
            missing=1
        fi
    done
    if [ "$missing" -ne 0 ]; then
        echo "CANNOT EVALUATE - a suite this script scores against is missing." >&2
        echo "2 IS NOT 0 - this is not a pass." >&2
        exit 2
    fi
}
