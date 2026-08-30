#!/bin/sh
# Pre-commit hook: refuse a commit that stages credential material.
#
# WHAT IT SCANS. Only the lines the commit ADDS, via git diff --cached.
# A credential already sitting in a file you happened to touch does not
# block you, because blocking on someone else's old line is how a hook
# gets uninstalled.
#
# WHAT IT NEVER DOES. It never prints, logs or writes a matched value.
# The report is path, line, detector and a sha256 prefix, plus a masked
# excerpt. See scripts/scan_secrets.py.
#
# EXIT CODES. 0 clean, 1 findings (commit refused), 2 could not scan
# (commit refused, and it SAYS it could not scan). 2 is not 0. A hook
# that waves a commit through because it failed to run is worse than no
# hook, because it produces a record of having checked.
#
# BYPASS. git commit --no-verify. Documented deliberately: a hook you
# cannot get past in an emergency is a hook that gets deleted instead.
#
# Install:   ./scripts/install-secret-hook.sh
# Uninstall: ./scripts/uninstall-secret-hook.sh
# Docs:      docs/secret-scanning.md

set -u

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "pre-commit secret scan: not in a git work tree, refusing" >&2
    exit 2
}

SCANNER="$REPO_ROOT/scripts/scan_secrets.py"
if [ ! -f "$SCANNER" ]; then
    echo "pre-commit secret scan: $SCANNER is missing, refusing" >&2
    echo "  (uninstall with ./scripts/uninstall-secret-hook.sh)" >&2
    exit 2
fi

# The scanner is stdlib-only on purpose, so the hook still works when the
# virtualenv is absent, half-built or mid-upgrade. Prefer it when present
# only so the hook runs the same interpreter the tests do.
if [ -x "$REPO_ROOT/venv/bin/python3" ]; then
    PY="$REPO_ROOT/venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
    PY=python3
else
    echo "pre-commit secret scan: no python3 found, refusing" >&2
    exit 2
fi

"$PY" "$SCANNER" --staged --repo "$REPO_ROOT"
exit $?
