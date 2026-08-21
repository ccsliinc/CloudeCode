#!/usr/bin/env bash
#
# check-js-syntax.sh - parse every browser JavaScript file with node --check.
#
# Description:
#   The client is served as plain static files with no bundler, transpiler or
#   test runner, so a syntax error in client/js reaches the browser unnoticed
#   and breaks the app at load time. This script is the cheapest possible
#   guard: node --check parses each file and reports syntax errors without
#   executing anything.
#
# Inputs:
#   $1 (string, optional) - single directory to scan. When omitted, every
#                           directory in DEFAULT_SCAN_DIRS below is scanned,
#                           resolved relative to the repo root.
#
#   macOS/ is in that list deliberately. It was not until 2026-08-21, so the
#   Electron main process - which spawns the uninstaller - was the one JS
#   tree in this repo that CI never parsed. A syntax error there breaks the
#   tray app at launch exactly the way one in client/js breaks the browser.
#
# Outputs:
#   Exit code 0 - every file parsed cleanly.
#   Exit code 1 - at least one file failed to parse; each failure is printed
#                 to stderr with the node diagnostic.
#   Exit code 2 - the target directory does not exist or holds no .js files.
#
# Example:
#   scripts/ci/check-js-syntax.sh
#   scripts/ci/check-js-syntax.sh client/js
#
set -uo pipefail

DEFAULT_SCAN_DIRS=("client/js" "macOS")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

targets=()
if [ "$#" -gt 0 ]; then
    targets+=("$1")
else
    for d in "${DEFAULT_SCAN_DIRS[@]}"; do
        targets+=("${repo_root}/${d}")
    done
fi

for target in "${targets[@]}"; do
    if [ ! -d "${target}" ]; then
        echo "check-js-syntax: not a directory: ${target}" >&2
        exit 2
    fi
done

checked=0
failed=0

for target in "${targets[@]}"; do
    while IFS= read -r -d '' file; do
        checked=$((checked + 1))
        if ! node --check "${file}"; then
            echo "check-js-syntax: SYNTAX ERROR in ${file}" >&2
            failed=$((failed + 1))
        fi
    done < <(
        find "${target}" -type f -name '*.js' \
            -not -path '*/node_modules/*' -print0 | sort -z
    )
done

if [ "${checked}" -eq 0 ]; then
    # An empty result almost always means a moved directory or a bad path
    # argument, not a genuinely empty client. Fail loudly rather than
    # reporting a vacuous pass.
    echo "check-js-syntax: no .js files found under ${targets[*]}" >&2
    exit 2
fi

if [ "${failed}" -gt 0 ]; then
    echo "check-js-syntax: ${failed} of ${checked} file(s) failed to parse" >&2
    exit 1
fi

echo "check-js-syntax: ${checked} file(s) parsed cleanly"
exit 0
