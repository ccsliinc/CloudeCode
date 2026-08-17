#!/bin/bash
# The double-clickable front door. Ships on the dmg as
# "Install Cloude Code.command"; Finder opens a .command file in Terminal, so
# the user gets a real, visible terminal session rather than a silent one.
#
# It does nothing but locate the payload beside itself and hand over to
# install.sh. All the logic lives there; this is the affordance.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/.payload"

if [ ! -x "$PAYLOAD/install.sh" ]; then
    echo "could not find the installer payload next to this file."
    echo "expected: $PAYLOAD/install.sh"
    echo "re-download the disk image and try again."
    echo
    read -r -p "press return to close this window. " _
    exit 1
fi

# A dmg is mounted read-only, so the installer runs from the image and writes
# only into the user's home. Nothing is copied to /Applications.
"$PAYLOAD/install.sh" "$@"
status=$?

echo
if [ "$status" -eq 0 ]; then
    echo "installation finished."
else
    echo "installation did not finish. the reason is above."
fi
read -r -p "press return to close this window. " _
exit "$status"
