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
#   $1 (string, optional) - directory to scan. Defaults to CLIENT_JS_DIR
#                           below, resolved relative to the repo root.
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

readonly CLIENT_JS_DIR="client/js"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="${1:-${repo_root}/${CLIENT_JS_DIR}}"

if [ ! -d "${target}" ]; then
    echo "check-js-syntax: not a directory: ${target}" >&2
    exit 2
fi

checked=0
failed=0

while IFS= read -r -d '' file; do
    checked=$((checked + 1))
    if ! node --check "${file}"; then
        echo "check-js-syntax: SYNTAX ERROR in ${file}" >&2
        failed=$((failed + 1))
    fi
done < <(find "${target}" -type f -name '*.js' -print0 | sort -z)

if [ "${checked}" -eq 0 ]; then
    # An empty result almost always means a moved directory or a bad path
    # argument, not a genuinely empty client. Fail loudly rather than
    # reporting a vacuous pass.
    echo "check-js-syntax: no .js files found under ${target}" >&2
    exit 2
fi

if [ "${failed}" -gt 0 ]; then
    echo "check-js-syntax: ${failed} of ${checked} file(s) failed to parse" >&2
    exit 1
fi

echo "check-js-syntax: ${checked} file(s) parsed cleanly"
exit 0
