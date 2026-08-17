#!/bin/bash
# build-dmg.sh - build the Cloude Code installer disk image from scratch.
#
# Repeatable, not hand-assembled: run it twice and you get the same image.
# Everything it needs is either generated here or committed beside it.
#
# WHAT LANDS ON THE IMAGE
#   Install Cloude Code.command   the double-clickable front door
#   Read Me First.txt             the human-facing readme
#   .payload/                     install.sh, upgrade.sh, rollback.sh, run.sh,
#                                 lib/, and the launchagent plist template
#   .background/background.tiff   the artwork, 1x and 2x in one file
#
# WHAT DOES NOT, EVER
#   any .env, any config.json, any secret. Secrets are generated per install
#   on the target machine. The staging step below actively refuses to build
#   if it finds one, rather than trusting that nobody added one.
#
# CODE SIGNING: none. There is no developer id certificate here, so the image
# is unsigned and not notarized, and the readme says so plainly to the user.
#
# Usage:
#   ./build-dmg.sh [--out PATH] [--volname NAME] [--version X.Y.Z]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PAYLOAD_SRC="$HERE/payload"
ARTWORK_DIR="$HERE/artwork"

# MUST match WINDOW_W/WINDOW_H and the slot coordinates in
# artwork/make-background.py. The background is drawn for exactly this
# window, so changing one without the other misaligns the whole layout.
WIN_W=660
WIN_H=420
ICON_LEFT_X=190
ICON_RIGHT_X=470
ICON_Y=244
ICON_SIZE=128

ITEM_INSTALL="Install Cloude Code.command"
ITEM_README="Read Me First.txt"

OUT_PATH=""
VOLNAME="Cloude Code"
VERSION=""

# log MESSAGE
# Announce a build step. Args: message. Output: stdout.
log() { printf '==> %s\n' "$*"; }

# die MESSAGE
# Print an error and exit 1. Args: message. Exits: 1.
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# parse_args ARGS...
# Fill OUT_PATH, VOLNAME and VERSION. Exits 1 on an unknown flag.
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --out) OUT_PATH="${2:-}"; shift 2 ;;
            --volname) VOLNAME="${2:-}"; shift 2 ;;
            --version) VERSION="${2:-}"; shift 2 ;;
            -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
    done
}

# resolve_version
# Ask the app's single version resolver what this build is. Never invents a
# literal: an empty answer means the filename simply carries no version.
resolve_version() {
    [ -n "$VERSION" ] && return 0
    VERSION="$(python3 -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("v", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.resolve_version(__import__("pathlib").Path(sys.argv[2])))
' "$REPO_ROOT/src/core/version.py" "$REPO_ROOT" 2>/dev/null || true)"
}

# check_tools
# Verify the build host has what this script needs. Exits 1 naming the fix.
check_tools() {
    command -v hdiutil >/dev/null || die "hdiutil is missing (are you on macos?)"
    command -v python3 >/dev/null || die "python3 is missing"
    command -v rsvg-convert >/dev/null \
        || die "rsvg-convert is missing. install it:  brew install librsvg"
    command -v tiffutil >/dev/null \
        || die "tiffutil is missing (it ships with xcode command line tools)"
    # create-dmg would do the layout for us but is not installed here, so the
    # Finder layout below is driven by AppleScript directly. Nothing depends
    # on create-dmg being present.
    log "build tools present (create-dmg not installed; using hdiutil + applescript)"
}

# build_artwork
# Regenerate the background pngs and fuse them into one retina tiff.
#
# A .tiff with a 1x and a 2x representation is the only way to hand Finder a
# retina background: Finder picks the representation matching the display, so
# on a retina mac the 1320x840 layer is used and the art stays sharp.
build_artwork() {
    log "generating the background artwork"
    python3 "$ARTWORK_DIR/make-background.py" --out-dir "$ARTWORK_DIR" >/dev/null
    [ -f "$ARTWORK_DIR/background.png" ] || die "the 1x background was not produced"
    [ -f "$ARTWORK_DIR/background@2x.png" ] || die "the 2x background was not produced"
    log "fusing 1x and 2x into a retina tiff"
    tiffutil -cathidpicheck \
        "$ARTWORK_DIR/background.png" "$ARTWORK_DIR/background@2x.png" \
        -out "$ARTWORK_DIR/background.tiff" >/dev/null
}

# assert_no_secrets DIR
# Refuse to build if anything secret-shaped is staged. Two near misses are on
# record in this project, so this is a hard gate, not a comment.
# Args: $1 the staging directory. Exits 1 on a hit.
assert_no_secrets() {
    local dir="$1" hits
    hits="$(find "$dir" \( -name '.env' -o -name '.env.*' -o -name 'config.json' \
            -o -name 'config.json.*' -o -name '*.pem' -o -name 'id_*' \) -print)"
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" >&2
        die "refusing to build: secret-shaped files are staged (listed above)"
    fi
    if grep -rlE '^(TOTP_SECRET|JWT_SECRET|API_KEY)=.+' "$dir" 2>/dev/null | head -n 1 | grep -q .; then
        die "refusing to build: a staged file contains a populated secret"
    fi
    log "staging checked: no secrets"
}

# stage STAGE_DIR
# Lay out exactly what the image will contain.
# Args: $1 the staging directory (created fresh by the caller).
stage() {
    local stage="$1"
    log "staging the image contents"

    mkdir -p "$stage/.payload/lib" "$stage/.background"

    install -m 755 "$PAYLOAD_SRC/install.sh" "$stage/.payload/install.sh"
    install -m 755 "$PAYLOAD_SRC/upgrade.sh" "$stage/.payload/upgrade.sh"
    install -m 755 "$PAYLOAD_SRC/rollback.sh" "$stage/.payload/rollback.sh"
    install -m 755 "$PAYLOAD_SRC/run.sh" "$stage/.payload/run.sh"
    install -m 644 "$PAYLOAD_SRC/lib/common.sh" "$stage/.payload/lib/common.sh"
    install -m 644 "$PAYLOAD_SRC/lib/upgrade-model.sh" "$stage/.payload/lib/upgrade-model.sh"
    install -m 644 "$PAYLOAD_SRC/com.imc.cloude-code.plist.template" \
        "$stage/.payload/com.imc.cloude-code.plist.template"
    install -m 644 "$PAYLOAD_SRC/README.txt" "$stage/.payload/README.txt"

    install -m 755 "$PAYLOAD_SRC/install-command-wrapper.sh" "$stage/$ITEM_INSTALL"
    install -m 644 "$PAYLOAD_SRC/README.txt" "$stage/$ITEM_README"
    install -m 644 "$ARTWORK_DIR/background.tiff" "$stage/.background/background.tiff"

    assert_no_secrets "$stage"
}

# apply_finder_layout MOUNT_DIR
# Drive Finder to set the window size, the background and the icon positions,
# and to hide the toolbar. The coordinates match the artwork exactly.
# Args: $1 the mounted read-write image path.
apply_finder_layout() {
    local mount="$1" volume
    volume="$(basename "$mount")"
    log "applying the finder layout (window ${WIN_W}x${WIN_H})"

    # HEADS UP: this step opens and closes a real Finder window on the build
    # machine's desktop. That is unavoidable, not a bug (see below), so run
    # the build once when the layout is right rather than iterating on it.
    #
    # NOTE, measured the hard way on 2026-08-17: the layout mount must NOT be
    # -nobrowse. With -nobrowse the volume is hidden from Finder, and Finder
    # then silently accepts and DISCARDS the window bounds, the icon size and
    # the background picture, while still honouring the icon positions and the
    # toolbar. The result reads as a partial success and is very easy to ship
    # by accident. Every property is read back after this runs.
    #
    # Properties are also set directly on `the icon view options of container
    # window` rather than through a captured variable; the captured form was
    # part of the same silent-discard failure.
    # TWO passes, each ending in `update without registering applications`
    # followed by `close`. Both details were established by measurement, not
    # taste, on 2026-08-17:
    #
    #   - the view options (window bounds, icon size, background picture) are
    #     only flushed to the .DS_Store by that `update` + `close` pair. Set
    #     them and merely close the window and the background alias is never
    #     written, while Finder reports the assignment as having succeeded.
    #   - piling every property into one script silently dropped the icon size
    #     and the background while still applying the icon positions, which
    #     reads as a partial success and is very easy to ship by accident.
    #
    # Do not "tidy" this into one block without re-running the verification
    # below, which is what caught both failures.
    osascript <<APPLESCRIPT || log "warn: the finder view step returned non-zero"
tell application "Finder"
    tell disk "$volume"
        open
        delay 1
        set current view of container window to icon view
        set the bounds of container window to {200, 160, ${WIN_W} + 200, ${WIN_H} + 160}
        set icon size of the icon view options of container window to ${ICON_SIZE}
        delay 1
        update without registering applications
        delay 2
        close
    end tell
end tell
APPLESCRIPT
    sleep 3

    osascript <<APPLESCRIPT || log "warn: the finder background step returned non-zero"
tell application "Finder"
    tell disk "$volume"
        open
        delay 1
        set background picture of the icon view options of container window to file ".background:background.tiff"
        delay 1
        update without registering applications
        delay 2
        close
    end tell
end tell
APPLESCRIPT
    sleep 3

    osascript <<APPLESCRIPT || log "warn: the finder placement step returned non-zero"
tell application "Finder"
    tell disk "$volume"
        open
        delay 1
        set icon size of the icon view options of container window to ${ICON_SIZE}
        set position of item "$ITEM_INSTALL" of container window to {${ICON_LEFT_X}, ${ICON_Y}}
        set position of item "$ITEM_README" of container window to {${ICON_RIGHT_X}, ${ICON_Y}}
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        delay 1
        update without registering applications
        delay 2
        close
    end tell
end tell
APPLESCRIPT
    # Give Finder a moment to flush .DS_Store before the volume is detached.
    sync
    sleep 3
}

# verify_finder_layout MOUNT_DIR
# Read every layout property back out of Finder and fail the build if any of
# them did not stick.
#
# THIS EXISTS BECAUSE THE FAILURE IS SILENT. Finder accepts the assignments,
# returns no error, and simply does not persist them under some mount
# conditions. Trusting the assignment is exactly the "I did not check, so it
# must be fine" pattern this project keeps paying for.
# Args: $1 the mounted image path. Exits 1 on a mismatch.
verify_finder_layout() {
    local mount="$1" volume result
    volume="$(basename "$mount")"
    log "verifying the layout stuck"
    result="$(osascript <<APPLESCRIPT
tell application "Finder"
    tell disk "$volume"
        open
        delay 1
        set b to bounds of container window
        set s to icon size of the icon view options of container window
        set t to toolbar visible of container window
        set p1 to position of item "$ITEM_INSTALL" of container window
        set p2 to position of item "$ITEM_README" of container window
        close
        return "w=" & ((item 3 of b) - (item 1 of b)) & " h=" & ((item 4 of b) - (item 2 of b)) &¬
            " icon=" & s & " toolbar=" & t &¬
            " p1=" & (item 1 of p1) & "," & (item 2 of p1) &¬
            " p2=" & (item 1 of p2) & "," & (item 2 of p2)
    end tell
end tell
APPLESCRIPT
)" || die "could not read the layout back from finder"

    log "layout: $result"

    # The background is verified from the .DS_Store, NOT from Finder.
    # Reading `background picture of the icon view options` throws
    # "AppleEvent handler failed" even when the background is set correctly,
    # so asking Finder produces a false negative every single time. The
    # backgroundImageAlias record in the .DS_Store is the thing that actually
    # ships, so that is what gets checked.
    if ! strings "$mount/.DS_Store" 2>/dev/null | grep -q 'backgroundImageAlias'; then
        die "no backgroundImageAlias record in the .DS_Store: the background did not stick"
    fi
    if ! strings "$mount/.DS_Store" 2>/dev/null | grep -q 'background.tiff'; then
        die "the .DS_Store does not reference background.tiff"
    fi
    log "background verified via the .DS_Store backgroundImageAlias record"

    case "$result" in
        *"icon=${ICON_SIZE}"*) : ;;
        *) die "the icon size did not stick (wanted ${ICON_SIZE})" ;;
    esac
    case "$result" in
        *"w=${WIN_W} h=${WIN_H}"*) : ;;
        *) die "the window size did not stick (wanted ${WIN_W}x${WIN_H})" ;;
    esac
    case "$result" in
        *"p1=${ICON_LEFT_X},${ICON_Y}"*) : ;;
        *) die "the installer icon is not at ${ICON_LEFT_X},${ICON_Y}" ;;
    esac
    case "$result" in
        *"p2=${ICON_RIGHT_X},${ICON_Y}"*) : ;;
        *) die "the readme icon is not at ${ICON_RIGHT_X},${ICON_Y}" ;;
    esac
    log "layout verified"
}

# main ARGS...
# Entry point. Builds the image and prints where it landed.
main() {
    parse_args "$@"
    check_tools
    resolve_version

    local suffix stage rw_dmg mount_point
    # Named for the release tag, because tags are the single version source
    # of truth. dist/ at the repo root is gitignored: the image itself is a
    # build output and is never committed.
    suffix=""
    [ -n "$VERSION" ] && suffix="-v$VERSION"
    [ -z "$OUT_PATH" ] && OUT_PATH="$REPO_ROOT/dist/CloudeCode${suffix}.dmg"
    mkdir -p "$(dirname "$OUT_PATH")"

    build_artwork

    stage="$(mktemp -d /tmp/cloude-dmg-stage.XXXXXX)"
    rw_dmg="$(mktemp -u /tmp/cloude-dmg-rw.XXXXXX).dmg"
    # Detach on EVERY exit path, including a failed layout verification. A
    # build that dies leaving a volume mounted pops a window on the user's
    # desktop and blocks the next run's mountpoint.
    # shellcheck disable=SC2064
    trap "hdiutil detach '/Volumes/$VOLNAME' >/dev/null 2>&1 || true; rm -rf '$stage' '$rw_dmg'" EXIT

    stage "$stage"

    log "creating a read-write image"
    rm -f "$OUT_PATH"
    hdiutil create -srcfolder "$stage" -volname "$VOLNAME" \
        -fs HFS+ -format UDRW -ov "$rw_dmg" >/dev/null

    log "mounting it to apply the layout"
    mount_point="/Volumes/$VOLNAME"
    hdiutil attach "$rw_dmg" -mountpoint "$mount_point" >/dev/null
    # Finder needs a beat to notice the new volume. Without this pause the
    # AppleScript below runs against a volume Finder has not registered yet,
    # and the window properties are accepted and then dropped.
    sleep 3

    apply_finder_layout "$mount_point"
    verify_finder_layout "$mount_point"

    log "detaching"
    hdiutil detach "$mount_point" >/dev/null || {
        sleep 3
        hdiutil detach "$mount_point" -force >/dev/null
    }

    log "compressing to the final read-only image"
    hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 \
        -o "$OUT_PATH" >/dev/null

    # Also drop a copy on the desktop so it can be double-clicked without
    # going and finding it.
    local desktop_copy="$HOME/Desktop/$(basename "$OUT_PATH")"
    if cp "$OUT_PATH" "$desktop_copy" 2>/dev/null; then
        log "copied to: $desktop_copy"
    else
        log "warn: could not copy to $HOME/Desktop - the build is still at $OUT_PATH"
    fi

    log "built: $OUT_PATH"
    log "size:  $(du -h "$OUT_PATH" | cut -f1)"
    log "note:  unsigned and not notarized. see the gatekeeper section of the readme."
}

main "$@"
