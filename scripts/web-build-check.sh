#!/usr/bin/env bash
#
# web-build-check.sh - prove the committed client/dist matches web/src.
#
# WHY THIS EXISTS. client/dist is a COMMITTED build artifact, because
# scripts/deploy-mini.sh ships the committed file set by tar and the mini
# runs no build. A committed artifact has exactly one failure mode and it
# is silent: somebody edits web/src, forgets to rebuild, commits, and the
# deploy ships a bundle that does not correspond to any source in the
# repository. Every check downstream still reads green, because the file
# on the target really does match the file on this Mac - they are both
# the stale one.
#
# WHAT IT MEASURES. It rebuilds into client/dist and then asks git whether
# anything moved. `git status --porcelain client/dist` is the whole test:
# empty means the committed bytes are what the current source produces,
# non-empty names the files that drifted. It compares a REBUILD against
# the commit rather than comparing timestamps, so it cannot be fooled by
# a touch and cannot pass because nothing looked.
#
# The build is not deterministic across tool VERSIONS - a different vite
# or svelte emits different bytes - which is why web/package.json pins
# every dependency exactly and web/package-lock.json is committed. Run
# `npm ci` (not `npm install`) if the check reports drift you did not
# cause; an unpinned transitive dependency is the first thing to suspect.
#
# Inputs:
#   none. Set CLOUDE_WEB_CHECK_NO_INSTALL=1 to skip the `npm ci` step when
#   web/node_modules is already known good (the deploy path does not set
#   it; a tight local loop may).
#
# Outputs:
#   Exit 0 - rebuilt, and client/dist is clean against the index.
#   Exit 1 - client/dist DRIFTED. The offending paths are named, and the
#            fix is to commit the rebuilt bundle.
#   Exit 2 - COULD NOT EVALUATE (no node, no npm, no web/ directory, or
#            the build itself failed). 2 IS NOT 0. Nothing was proven.
#
# Example:
#   ./scripts/web-build-check.sh
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"
DIST_DIR="${REPO_ROOT}/client/dist"

fail_cannot_evaluate() {
    echo "web-build-check: CANNOT EVALUATE - $1" >&2
    echo "web-build-check: nothing was proven about client/dist." >&2
    exit 2
}

[ -d "${WEB_DIR}" ] || fail_cannot_evaluate "no web/ directory at ${WEB_DIR}"
command -v node >/dev/null 2>&1 || fail_cannot_evaluate "node is not on PATH"
command -v npm  >/dev/null 2>&1 || fail_cannot_evaluate "npm is not on PATH"
command -v git  >/dev/null 2>&1 || fail_cannot_evaluate "git is not on PATH"

cd "${REPO_ROOT}" || fail_cannot_evaluate "cannot cd to ${REPO_ROOT}"

# A dirty client/dist BEFORE the rebuild is already the answer, but it is
# a different sentence: the tree was left dirty rather than the source
# having moved. Report it after the rebuild either way; recording it here
# is what lets the message say which.
was_dirty_before="$(git status --porcelain -- "${DIST_DIR}" 2>/dev/null)"

if [ "${CLOUDE_WEB_CHECK_NO_INSTALL:-0}" != "1" ]; then
    echo "web-build-check: installing web/ dependencies from the lockfile ..."
    ( cd "${WEB_DIR}" && npm ci --no-fund --no-audit ) \
        || fail_cannot_evaluate "npm ci failed in web/"
fi

echo "web-build-check: building web/ into client/dist ..."
( cd "${WEB_DIR}" && npm run build ) \
    || fail_cannot_evaluate "the vite build failed"

drift="$(git status --porcelain -- "${DIST_DIR}" 2>/dev/null)"
if [ -n "${drift}" ]; then
    echo >&2
    echo "== STALE BUNDLE ==" >&2
    echo "client/dist does not match what web/src builds to:" >&2
    printf '%s\n' "${drift}" >&2
    echo >&2
    if [ -n "${was_dirty_before}" ]; then
        echo "(it was already dirty before this rebuild, so it may simply" >&2
        echo " be an uncommitted build rather than a forgotten one.)" >&2
    fi
    echo "Commit the rebuilt bundle:  git add client/dist && git commit" >&2
    exit 1
fi

echo
echo "== BUNDLE CURRENT =="
echo "client/dist matches what web/src builds to."
exit 0
