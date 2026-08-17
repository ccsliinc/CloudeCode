#!/bin/bash
# run.sh - what the LaunchAgent actually executes.
#
# Its one job beyond starting the server is to stamp the INSTALLED RELEASE
# TAG into the environment, so the app displays the tag it is really running
# rather than a literal maintained somewhere else. src/core/version.py reads
# CLOUDE_APP_VERSION first for exactly this reason.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/upgrade-model.sh
source "$HERE/lib/upgrade-model.sh"

cd "$CC_APP" || { echo "no install at $CC_APP" >&2; exit 78; }

# Empty when the checkout is not parked on a tag. Empty is correct: the app
# then falls back through its own resolver rather than being handed a lie.
CLOUDE_APP_VERSION="$(um_current_tag "$CC_APP" 2>/dev/null || true)"
export CLOUDE_APP_VERSION

exec "$CC_APP/venv/bin/python3" -m src.main
