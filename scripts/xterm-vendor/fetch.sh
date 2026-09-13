#!/usr/bin/env bash
# Re-download the pinned xterm.js assets vendored under client/vendor/xterm/
# and verify each one against the sha256 recorded in this script.
#
# Unlike scripts/codemirror-vendor/ (an npm build workspace that bundles
# CodeMirror's ES module packages into one file), xterm.js ships these six
# files as plain pre-built browser assets straight from its npm packages -
# there is nothing to bundle, so this is a plain curl script instead of an
# npm build.
#
# Usage:
#   scripts/xterm-vendor/fetch.sh
#
# To bump a version: edit the version variables and the matching sha256 in
# the ASSETS list below, run this script, and update
# client/vendor/xterm/VERSION.md with whatever it prints.
#
# Exits non-zero and prints which file failed if a download is empty or its
# sha256 does not match what is pinned here.

set -euo pipefail

XTERM_VERSION="5.3.0"
FIT_VERSION="0.8.0"
WEBGL_VERSION="0.16.0"
UNICODE11_VERSION="0.6.0"
SEARCH_VERSION="0.13.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../../client/vendor/xterm"

# ONE RECORD PER FILE: `name|url|sha256`, one per line.
#
# NOT TWO `declare -A` MAPS, AND THE REASON IS MEASURED. Associative
# arrays are bash 4, and macOS still ships bash 3.2 as /bin/bash. Under
# 3.2 `declare -A` is not an error that stops the script: the array
# subscripts degrade to arithmetic, two parse errors go to stderr, the
# `for file in "${!SOURCE_URL[@]}"` loop iterates ZERO times, and the
# script exits 0 printing "all six xterm assets verified". It downloaded
# nothing and verified nothing while reading exactly like a pass, which
# is the false green this project keeps paying to remove. A plain
# newline-delimited list needs no bash 4 feature at all, so the check
# runs everywhere rather than only where somebody installed a newer bash.
ASSETS="\
xterm.css|https://cdn.jsdelivr.net/npm/xterm@${XTERM_VERSION}/css/xterm.css|832f3f2c603b43ad4351ff04970150cc7a873014276db126a6065c6dd81e4872
xterm.js|https://cdn.jsdelivr.net/npm/xterm@${XTERM_VERSION}/lib/xterm.js|f0aea0f75f48559013ae6643c2479dd737d26da42d5524e6d2b70915ae6523c7
xterm-addon-fit.js|https://cdn.jsdelivr.net/npm/xterm-addon-fit@${FIT_VERSION}/lib/xterm-addon-fit.js|10f3194c5f17c1786fb7d5db865c1ec8539b6736a318063fd38bdaaf7c46848f
xterm-addon-webgl.js|https://cdn.jsdelivr.net/npm/xterm-addon-webgl@${WEBGL_VERSION}/lib/xterm-addon-webgl.js|0c9c48c9391c4cee816eacf95699dbde97e8cc8f191e87f3a571e73d214c8df8
xterm-addon-unicode11.js|https://cdn.jsdelivr.net/npm/xterm-addon-unicode11@${UNICODE11_VERSION}/lib/xterm-addon-unicode11.js|ab10d83642883e5e17ea741cd5b6e5f8c0f6a06e3271f2f0c0e043be4fc5e738
xterm-addon-search.js|https://cdn.jsdelivr.net/npm/xterm-addon-search@${SEARCH_VERSION}/lib/xterm-addon-search.js|6a6db33f16b764552377a2c5ba4327c6dab6beaf25484533afd7dbecd0b03793
"

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        sha256sum "$1" | cut -d' ' -f1
    fi
}

mkdir -p "$OUT_DIR"

echo "fetching pinned xterm assets into $OUT_DIR"

count=0
while IFS='|' read -r file url expected_sha256; do
    [ -n "$file" ] || continue
    dest="$OUT_DIR/$file"

    echo "  -> $file  ($url)"
    curl -sSfL -o "$dest" "$url"

    size=$(wc -c <"$dest" | tr -d ' ')
    if [ "$size" -eq 0 ]; then
        echo "FAIL: $file downloaded empty from $url" >&2
        exit 1
    fi

    actual_sha256=$(sha256_of "$dest")

    if [ "$actual_sha256" != "$expected_sha256" ]; then
        echo "FAIL: sha256 mismatch for $file" >&2
        echo "  expected: $expected_sha256" >&2
        echo "  actual:   $actual_sha256" >&2
        echo "  if this is a deliberate version bump, update ASSETS" >&2
        echo "  in this script and client/vendor/xterm/VERSION.md together" >&2
        exit 1
    fi

    echo "     ok  ($size bytes, sha256 $actual_sha256)"
    count=$((count + 1))
done <<EOF
$ASSETS
EOF

# A COUNT, BECAUSE A LOOP THAT RAN ZERO TIMES IS THE FAILURE THIS SCRIPT
# ALREADY HAD ONCE. Verifying nothing must never print a pass.
if [ "$count" -ne 6 ]; then
    echo "FAIL: verified $count assets, expected 6 - the asset list did not parse" >&2
    exit 1
fi

echo "all six xterm assets verified against pinned sha256"
