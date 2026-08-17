#!/bin/bash
# upgrade.sh - move an install to a newer release tag, safely.
#
# THE ORDER MATTERS AND IT IS NOT NEGOTIABLE:
#   1. check every precondition. refuse rather than half-apply.
#   2. back up state BEFORE a single file moves. config, .env and the state
#      directory, into a dated dir OUTSIDE the checkout.
#   3. swap the code to the target tag.
#   4. run migrations.
#   5. restart with launchctl kickstart -k, then verify health at the REAL
#      bound address (probing localhost is a false negative when HOST is
#      pinned to a lan address).
#   6. if health does not come back: AUTOMATICALLY roll back the code AND the
#      matching state snapshot TOGETHER, restart, and say plainly that it
#      rolled back and why.
#
# IDEMPOTENT: running it when already on the target tag is a no-op that says
# so. It does not re-run migrations.
#
# Usage:
#   ./upgrade.sh [--tag vX.Y.Z] [--yes]
# With no --tag it upgrades to the newest release tag on the remote.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/upgrade-model.sh
source "$HERE/lib/upgrade-model.sh"

HEALTH_TIMEOUT=90
TARGET_TAG=""
ASSUME_YES=0
BACKUP_DIR=""
PREVIOUS_TAG=""

# parse_args ARGS...
# Fill TARGET_TAG and ASSUME_YES. Exits 1 on an unknown flag.
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --tag) TARGET_TAG="${2:-}"; shift 2 ;;
            --yes|-y) ASSUME_YES=1; shift ;;
            -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
            *) fail "unknown option: $1" "run ./upgrade.sh --help" ;;
        esac
    done
}

# check_preconditions
# Everything that must be true before anything is touched. Exits 1 naming the
# fix on the first hard failure. Nothing has been written at this point.
check_preconditions() {
    say "checking preconditions (nothing moves until all of these pass)"
    require_macos

    [ -d "$CC_APP" ] || fail \
        "there is no install at $CC_APP." \
        "install first, from the dmg."

    find_git >/dev/null || fail \
        "git is not installed, and this install upgrades by git tag." \
        "install the command line tools:  xcode-select --install"
    ok "git is present"

    # Refuse on local modifications rather than clobbering them.
    require_clean_worktree "$CC_APP"
    ok "the checkout is clean"

    find_tmux >/dev/null || fail \
        "tmux is missing. install it before upgrading:  brew install tmux"
    ok "tmux is present"

    find_claude >/dev/null || fail \
        "the claude cli is missing." \
        "checked the homebrew cask, ~/.local/bin/claude and ~/.claude/local." \
        "install it before upgrading:  brew install --cask claude-code"
    ok "the claude cli is present"

    require_free_disk 500 "$CC_ROOT"
    ok "enough free disk"

    PREVIOUS_TAG="$(um_current_tag "$CC_APP" || true)"
    if [ -z "$PREVIOUS_TAG" ]; then
        fail "this checkout is not parked on a release tag." \
             "upgrade and rollback both work by tag, so there is no safe" \
             "'previous version' to return to. park it on a tag first:" \
             "  git -C $CC_APP checkout --detach refs/tags/vX.Y.Z"
    fi
    ok "currently installed: $PREVIOUS_TAG"
}

# resolve_target
# Work out which tag to move to, and prove it exists. Exits 1 when the remote
# cannot be reached: an unreachable remote is "could not evaluate", never
# "already up to date".
resolve_target() {
    local tags newest
    say "fetching the release tag list from $(um_remote "$CC_APP")"
    tags="$(um_list_tags "$CC_APP")" || fail \
        "could not reach the release remote." \
        "check your network. nothing has been changed."
    [ -z "$tags" ] && fail "the remote published no release tags. nothing to do."

    if [ -z "$TARGET_TAG" ]; then
        newest="$(printf '%s\n' "$tags" | tail -n 1)"
        TARGET_TAG="$newest"
        ok "newest release tag is $TARGET_TAG"
    fi

    um_tag_exists "$CC_APP" "$TARGET_TAG" || fail \
        "tag $TARGET_TAG does not exist on the remote." \
        "available:" \
        "$(printf '%s\n' "$tags" | tail -n 5 | tr '\n' ' ')"
    ok "target tag $TARGET_TAG exists"
}

# confirm
# Show what will happen and get a visible yes. --yes skips it.
confirm() {
    local answer=""
    echo
    echo "  upgrade plan"
    echo "    from:   $PREVIOUS_TAG"
    echo "    to:     $TARGET_TAG"
    echo "    app:    $CC_APP"
    echo "    backup: $CC_BACKUPS/<tag>-<timestamp>  (written before anything moves)"
    echo "    on failure: automatic rollback to $PREVIOUS_TAG plus its state backup"
    echo
    [ "$ASSUME_YES" -eq 1 ] && return 0
    ask "proceed" "no" answer
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) echo "nothing was changed."; exit 0 ;;
    esac
}

# swap_code
# Move the checkout onto the target tag.
# Returns: 0 on success, 1 on failure (the caller rolls back).
swap_code() {
    say "checking out $TARGET_TAG"
    um_checkout "$CC_APP" "$TARGET_TAG" || return 1
    ok "code is at $TARGET_TAG"
    return 0
}

# run_migrations
# Install any new dependencies and let the app run its own config migration.
# The app migrates config.json itself at startup, so this only has to make
# the environment right.
# Returns: 0 on success, 1 on failure.
run_migrations() {
    say "installing dependencies for $TARGET_TAG"
    "$CC_APP/venv/bin/pip" install --quiet -r "$CC_APP/requirements.txt" || return 1
    ok "dependencies are current"
    say "config migrations run inside the app at startup; nothing to do here"
    return 0
}

# roll_back_now REASON
# Restore the previous tag AND its state snapshot together, restart, and say
# plainly what happened. Code and state move as a pair; restoring one without
# the other is worse than either.
# Args: $1 the reason, printed to the user.
# Exits: 1 always. An upgrade that rolled back is not a success.
roll_back_now() {
    local reason="$1"
    echo
    warn "the upgrade failed: $reason"
    warn "rolling back to $PREVIOUS_TAG and its state backup"
    um_checkout "$CC_APP" "$PREVIOUS_TAG" \
        || warn "could not check out $PREVIOUS_TAG - the checkout needs manual attention"
    [ -n "$BACKUP_DIR" ] && restore_state "$BACKUP_DIR"
    "$CC_APP/venv/bin/pip" install --quiet -r "$CC_APP/requirements.txt" \
        || warn "could not reinstall the previous dependency set"
    service_restart || true
    if wait_for_health "$HEALTH_TIMEOUT"; then
        fail "rolled back to $PREVIOUS_TAG. the service is healthy again." \
             "the upgrade to $TARGET_TAG was NOT applied. reason: $reason" \
             "state was restored from $BACKUP_DIR"
    fi
    fail "rolled back to $PREVIOUS_TAG, but the service is STILL not healthy." \
         "this needs a human. reason for the original failure: $reason" \
         "state backup: $BACKUP_DIR" \
         "logs: $CC_STATE/logs/launchd.err"
}

# main ARGS...
# Entry point. Returns 0 on a healthy upgrade or a no-op; exits 1 otherwise.
main() {
    parse_args "$@"
    echo "cloude code upgrade"
    echo "==================="
    check_preconditions
    resolve_target

    # IDEMPOTENT: already there is a no-op that says so, not a second run.
    if [ "$PREVIOUS_TAG" = "$TARGET_TAG" ]; then
        ok "already at $TARGET_TAG. nothing to do."
        return 0
    fi

    confirm
    BACKUP_DIR="$(backup_state "$PREVIOUS_TAG" | tail -n 1)"

    swap_code || roll_back_now "the checkout of $TARGET_TAG failed"
    run_migrations || roll_back_now "dependency install failed on $TARGET_TAG"

    service_restart || warn "kickstart returned non-zero - checking health anyway"
    wait_for_health "$HEALTH_TIMEOUT" \
        || roll_back_now "the service did not answer healthily on $TARGET_TAG"

    manifest_write "$TARGET_TAG" "$(um_remote "$CC_APP")" \
        "$(read_env_value HOST "$CC_APP/.env")" \
        "$(read_env_value PORT "$CC_APP/.env")"

    echo
    ok "upgraded $PREVIOUS_TAG -> $TARGET_TAG and verified healthy"
    echo "     state backup kept at: $BACKUP_DIR"
    echo "     to go back:           $CC_BIN/rollback.sh"
    return 0
}

main "$@"
