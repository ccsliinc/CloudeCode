#!/bin/bash
# Thin entry point so the dmg build is discoverable from the usual place.
# All of the work lives in packaging/dmg/build-dmg.sh, next to the payload
# and the artwork it assembles. Arguments are passed straight through.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packaging/dmg/build-dmg.sh" "$@"
