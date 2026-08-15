#!/bin/bash
# Generate the web-app icon set (apple-touch-icon + manifest icons) from the
# single 1024px source already used for the macOS menu-bar app.
#
# One source, one look: the home-screen icon on a phone is the SAME artwork
# as the desktop app icon rather than a second thing to keep in sync.
#
# Sizes and why each exists:
#   180  apple-touch-icon. iOS uses this for "Add to Home Screen". iOS does
#        NOT read SVG here, so a PNG is mandatory.
#   192  web app manifest baseline (Android/Chrome install prompt).
#   512  web app manifest large / splash.
#   512  maskable variant. Declared "any maskable" on the 512 entry; the
#        source art already carries its own padding, so no re-crop is done.
#
# Rerun after changing macOS/assets/AppIcon-1024.png. Output is committed:
# the server has no image pipeline and must not grow one just to ship five
# static files.
#
# Usage: scripts/generate-web-icons.sh

set -euo pipefail

REPO_ROOT="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/macOS/assets/AppIcon-1024.png"
OUT_DIR="$REPO_ROOT/client/assets/icons"

if [ ! -f "$SRC" ]; then
    echo "generate-web-icons: source not found: $SRC" >&2
    exit 1
fi

# sips ships with macOS; no Homebrew dependency for a five-file resize.
if ! command -v sips >/dev/null 2>&1; then
    echo "generate-web-icons: sips not found (macOS only)" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

for size in 180 192 512; do
    sips -s format png -z "$size" "$size" "$SRC" \
        --out "$OUT_DIR/icon-${size}.png" >/dev/null
    echo "generate-web-icons: wrote icon-${size}.png"
done

echo "generate-web-icons: done ($OUT_DIR)"
