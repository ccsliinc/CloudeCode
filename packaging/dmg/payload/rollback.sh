#!/bin/bash
# rollback.sh - put an install back on an earlier release tag, deliberately.
#
# upgrade.sh rolls back automatically when a health check fails. This script
# is for the other case: the upgrade succeeded technically, and you want out
# anyway.
#
# CODE AND STATE MOVE AS A PAIR. Every backup directory is named for the tag
# the code was at when it was taken, so a rollback restores a matching pair.
# A datastore is coming and its schema will move with the code; restoring one
# without the other is worse than either. This script will REFUSE to restore
# a state backup against a different tag unless you say --force, and it says
# exactly why.
#
# Usage:
#   ./rollback.sh                 roll back to the most recent backup's tag
#   ./rollback.sh --list          show the available backups and exit
#   ./rollback.sh --tag vX.Y.Z    roll back to a specific tag
#   ./rollback.sh --force         allow a code/state tag mismatch (last resort)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/upgrade-model.sh
source "$HERE/lib/upgrade-model.sh"

HEALTH_TIMEOUT=90
TARGET_TAG=""
FORCE=0
DO_LIST=0

# parse_args ARGS...
# Fill TARGET_TAG, FORCE and DO_LIST. Exits 1 on an unknown flag.
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --tag) TARGET_TAG="${2:-}"; shift 2 ;;
            --list) DO_LIST=1; shift ;;
            --force) FORCE=1; shift ;;
            -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
            *) fail "unknown option: $1" "run ./rollback.sh --help" ;;
        esac
    done
}

# list_backups
# Output: one backup directory name per line, oldest first. Empty when none.
list_backups() {
    [ -d "$CC_BACKUPS" ] || return 0
    ls -1 "$CC_BACKUPS" 2>/dev/null | sort
}

# backup_tag DIRNAME
# Args: $1 a backup directory name such as "v0.8.1-20260817-120000".
# Output: the tag part, "v0.8.1".
backup_tag() {
    printf '%s\n' "${1%-*-*}"
}

# newest_backup_for TAG
# Args: $1 tag name.
# Output: the newest backup directory name for that tag, empty when none.
newest_backup_for() {
    local tag="$1"
    list_backups | grep -E "^${tag}-[0-9]{8}-[0-9]{6}$" | tail -n 1
}

# show_list
# Print the backups a human can choose from, then exit 0.
show_list() {
    local entries
    entries="$(list_backups)"
    if [ -z "$entries" ]; then
        echo "no backups exist under $CC_BACKUPS."
        echo "there is nothing to roll back to."
        exit 0
    fi
    echo "backups under $CC_BACKUPS (oldest first):"
    printf '%s\n' "$entries" | sed 's/^/  /'
    echo
    echo "currently installed: $(um_current_tag "$CC_APP" || echo 'not on a tag')"
    exit 0
}

# check_preconditions
# Everything verified before anything moves. Exits 1 naming the fix.
check_preconditions() {
    say "checking preconditions"
    require_macos
    [ -d "$CC_APP" ] || fail "there is no install at $CC_APP."
    find_git >/dev/null || fail "git is not installed. xcode-select --install"
    require_clean_worktree "$CC_APP"
    ok "the checkout is clean"
    require_free_disk 200 "$CC_ROOT"
}

# main ARGS...
# Entry point. Returns 0 when the rollback verified healthy; exits 1 on any
# failure, having said exactly what state the install was left in.
main() {
    parse_args "$@"
    echo "cloude code rollback"
    echo "===================="
    [ "$DO_LIST" -eq 1 ] && show_list

    check_preconditions

    local current backups chosen chosen_tag
    current="$(um_current_tag "$CC_APP" || true)"
    backups="$(list_backups)"
    [ -z "$backups" ] && fail \
        "no backups exist under $CC_BACKUPS." \
        "there is nothing to roll back to. run ./rollback.sh --list to confirm."

    if [ -z "$TARGET_TAG" ]; then
        # Most recent backup whose tag is NOT what is running now: that is
        # the version we came from.
        chosen="$(printf '%s\n' "$backups" | tail -n 1)"
        TARGET_TAG="$(backup_tag "$chosen")"
        ok "rolling back to $TARGET_TAG (from backup $chosen)"
    else
        chosen="$(newest_backup_for "$TARGET_TAG")"
    fi

    if [ -z "$chosen" ]; then
        fail "no state backup exists for $TARGET_TAG." \
             "restoring the code without its matching state is not safe." \
             "run ./rollback.sh --list to see what is available," \
             "or pass --force if you accept the mismatch."
    fi

    chosen_tag="$(backup_tag "$chosen")"
    if [ "$chosen_tag" != "$TARGET_TAG" ] && [ "$FORCE" -eq 0 ]; then
        fail "backup $chosen belongs to $chosen_tag, not $TARGET_TAG." \
             "code and state must move together. pass --force to override."
    fi

    if [ "$current" = "$TARGET_TAG" ]; then
        ok "already at $TARGET_TAG. nothing to do."
        return 0
    fi

    um_tag_exists "$CC_APP" "$TARGET_TAG" || fail \
        "tag $TARGET_TAG is not in the local checkout." \
        "fetch it first:  git -C $CC_APP fetch --tags"

    # Snapshot where we are NOW before undoing it, so a rollback is itself
    # reversible.
    say "snapshotting the current state before rolling back"
    backup_state "${current:-unknown}" >/dev/null

    say "checking out $TARGET_TAG"
    um_checkout "$CC_APP" "$TARGET_TAG" || fail \
        "could not check out $TARGET_TAG. nothing else was changed."
    ok "code is at $TARGET_TAG"

    restore_state "$CC_BACKUPS/$chosen"

    say "reinstalling the dependency set for $TARGET_TAG"
    "$CC_APP/venv/bin/pip" install --quiet -r "$CC_APP/requirements.txt" \
        || warn "dependency install failed - the service may not start"

    service_restart || warn "kickstart returned non-zero - checking health anyway"
    if wait_for_health "$HEALTH_TIMEOUT"; then
        manifest_write "$TARGET_TAG" "$(um_remote "$CC_APP")" \
            "$(read_env_value HOST "$CC_APP/.env")" \
            "$(read_env_value PORT "$CC_APP/.env")"
        echo
        ok "rolled back to $TARGET_TAG with its matching state, verified healthy"
        return 0
    fi
    fail "rolled back to $TARGET_TAG but the service is not healthy." \
         "this needs a human." \
         "logs: $CC_STATE/logs/launchd.err"
}

main "$@"
