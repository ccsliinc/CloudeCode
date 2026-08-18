#!/bin/bash
# tests/test_upgrade_backup.sh — tests for take_backup / restore_backup /
# resolve_log_dir in scripts/upgrade_lib/upgrade_rollback_common.sh.
#
# Plain bash test (no pytest bridge exists for these functions — they are
# bash, not Python). Run directly: ./tests/test_upgrade_backup.sh
# Exits 0 if every case passes, 1 on the first failure, printing which.
#
# Covers the three-outcome contract for backup/restore:
#   - a file that lives in LOG_DIRECTORY (not the install dir) is actually
#     found and backed up there — the exact bug a design review caught:
#     the original implementation looked in the wrong directory for four
#     of six declared files and silently reported success.
#   - a declared-but-missing REQUIRED file (refresh_tokens.db) makes
#     take_backup die, not warn.
#   - a legitimately-absent OPTIONAL file (never pinned a theme) is
#     recorded as NOT_PRESENT and does not fail the backup.
#   - restore puts every file back exactly where the app reads it from,
#     verified with cmp, not just "the copy didn't error".

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${TEST_DIR}/.." && pwd -P)"
# shellcheck source=../scripts/upgrade_lib/upgrade_rollback_common.sh
source "${REPO_ROOT}/scripts/upgrade_lib/upgrade_rollback_common.sh"

FAILURES=0

# Description: minimal fail-fast assertion. Prints PASS/FAIL and tracks
#   failures in $FAILURES rather than exiting immediately, so one run
#   reports every case instead of stopping at the first.
# Inputs: $1 - condition already evaluated to 0/1. $2 - description.
# Output: none; increments FAILURES on a non-zero condition.
assert() {
    local rc="$1" desc="$2"
    if [ "${rc}" -eq 0 ]; then
        printf 'PASS: %s\n' "${desc}"
    else
        printf 'FAIL: %s\n' "${desc}"
        FAILURES=$((FAILURES + 1))
    fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------------------------------------------------------------------- #
# Case 1: a fully-configured install — refresh_tokens.db present
# (REQUIRED), session_metadata.json present (OPTIONAL, present),
# pinned_themes.json / unread_state.json absent (OPTIONAL, legitimately
# not present). Backup must succeed and record all three outcome kinds.
# ---------------------------------------------------------------------- #

INSTALL1="${WORK}/install1"
LOGDIR1="${WORK}/logs1"
mkdir -p "${INSTALL1}" "${LOGDIR1}"
printf 'LOG_DIRECTORY=%s\nPORT=8000\n' "${LOGDIR1}" > "${INSTALL1}/.env"
echo '{"config_version": 1}' > "${INSTALL1}/config.json"
echo 'fake-refresh-token-db-bytes' > "${LOGDIR1}/refresh_tokens.db"
echo '{"session":"one"}' > "${LOGDIR1}/session_metadata.json"

BACKUP1="${WORK}/backup1"
OUT="$(take_backup "${INSTALL1}" "${BACKUP1}" 2>"${WORK}/case1.stderr")"
RC=$?
assert "${RC}" "case 1: take_backup exits 0 on a fully-configured install"
assert "$([ "${OUT}" = "${BACKUP1}" ] && echo 0 || echo 1)" "case 1: take_backup prints the backup dir"

assert "$(grep -q '^BACKED_UP	state	refresh_tokens.db$' "${BACKUP1}/.manifest" && echo 0 || echo 1)" \
    "case 1: refresh_tokens.db backed up from LOG_DIRECTORY (not the install dir)"
assert "$(grep -q '^BACKED_UP	state	session_metadata.json$' "${BACKUP1}/.manifest" && echo 0 || echo 1)" \
    "case 1: session_metadata.json backed up from LOG_DIRECTORY"
assert "$(grep -q '^NOT_PRESENT	state	pinned_themes.json$' "${BACKUP1}/.manifest" && echo 0 || echo 1)" \
    "case 1: pinned_themes.json recorded NOT_PRESENT (never pinned), not a failure"
assert "$(grep -q '^NOT_PRESENT	state	unread_state.json$' "${BACKUP1}/.manifest" && echo 0 || echo 1)" \
    "case 1: unread_state.json recorded NOT_PRESENT"
assert "$([ -f "${BACKUP1}/state/refresh_tokens.db" ] && echo 0 || echo 1)" \
    "case 1: refresh_tokens.db bytes actually present in the backup"
assert "$(cmp -s "${LOGDIR1}/refresh_tokens.db" "${BACKUP1}/state/refresh_tokens.db" && echo 0 || echo 1)" \
    "case 1: backed-up refresh_tokens.db is byte-identical to the source"

# ---------------------------------------------------------------------- #
# Case 2: configured install, but refresh_tokens.db is MISSING from
# LOG_DIRECTORY (server never started, or state already lost). Must HALT,
# not warn-and-continue.
# ---------------------------------------------------------------------- #

INSTALL2="${WORK}/install2"
LOGDIR2="${WORK}/logs2"
mkdir -p "${INSTALL2}" "${LOGDIR2}"
printf 'LOG_DIRECTORY=%s\n' "${LOGDIR2}" > "${INSTALL2}/.env"
echo '{"config_version": 1}' > "${INSTALL2}/config.json"
# refresh_tokens.db deliberately NOT created

BACKUP2="${WORK}/backup2"
# die() calls `exit`, which would kill this whole test script if invoked
# directly (not just return from the function) — run it in a subshell so
# only the subshell exits, and we can inspect the exit code here.
( take_backup "${INSTALL2}" "${BACKUP2}" > "${WORK}/case2.stdout" 2>"${WORK}/case2.stderr" )
RC=$?
assert "$([ "${RC}" -ne 0 ] && echo 0 || echo 1)" \
    "case 2: take_backup DIES (non-zero exit) when a REQUIRED state file is missing"
assert "$(grep -q 'refresh_tokens.db' "${WORK}/case2.stderr" && echo 0 || echo 1)" \
    "case 2: the failure message names the missing file"

# ---------------------------------------------------------------------- #
# Case 3: never-configured install (no .env, no config.json). Must
# succeed with an empty-but-honest backup, not fail and not fabricate
# state-dir entries.
# ---------------------------------------------------------------------- #

INSTALL3="${WORK}/install3"
mkdir -p "${INSTALL3}"

BACKUP3="${WORK}/backup3"
take_backup "${INSTALL3}" "${BACKUP3}" > "${WORK}/case3.stdout" 2>"${WORK}/case3.stderr"
RC=$?
assert "${RC}" "case 3: take_backup succeeds on a never-configured install"
assert "$(grep -q '^BACKED_UP' "${BACKUP3}/.manifest" && echo 1 || echo 0)" \
    "case 3: nothing is recorded BACKED_UP (there is nothing to back up yet)"

# ---------------------------------------------------------------------- #
# Case 4: restore puts every BACKED_UP file back where the app reads it
# from — install files into install_dir, state files into the CURRENT
# LOG_DIRECTORY (read from the just-restored .env), verified with cmp.
# ---------------------------------------------------------------------- #

INSTALL4="${WORK}/install4"
mkdir -p "${INSTALL4}"
# Simulate "after a bad upgrade": wrong config, no state dir contents at
# the new LOG_DIRECTORY (as if the app hasn't run there yet).
LOGDIR4_NEW="${WORK}/logs4_new"
mkdir -p "${LOGDIR4_NEW}"
printf 'LOG_DIRECTORY=%s\n' "${LOGDIR4_NEW}" > "${INSTALL4}/.env"
echo '{"config_version": 4, "wrong": true}' > "${INSTALL4}/config.json"

# Corrupt the destination refresh_tokens.db BEFORE restoring, so a
# post-restore match actually proves the restore wrote it, rather than
# trivially matching a file that was never touched.
echo 'CORRUPTED-BY-TEST' > "${LOGDIR1}/refresh_tokens.db"

restore_backup "${INSTALL4}" "${BACKUP1}" > "${WORK}/case4.stdout" 2>"${WORK}/case4.stderr"
RC=$?
assert "${RC}" "case 4: restore_backup exits 0"
assert "$(cmp -s "${INSTALL1}/.env" "${INSTALL4}/.env" && echo 0 || echo 1)" \
    "case 4: .env restored byte-identical to the original"
assert "$(cmp -s "${INSTALL1}/config.json" "${INSTALL4}/config.json" && echo 0 || echo 1)" \
    "case 4: config.json restored byte-identical to the original (overwrote the 'wrong' one)"
# LOG_DIRECTORY in install4's restored .env is LOGDIR1 (that's what backup1
# recorded), so the state files must land in LOGDIR1, not LOGDIR4_NEW.
assert "$(cmp -s "${BACKUP1}/state/refresh_tokens.db" "${LOGDIR1}/refresh_tokens.db" && echo 0 || echo 1)" \
    "case 4: refresh_tokens.db restored into LOG_DIRECTORY, overwriting the corrupted copy"
assert "$([ ! -f "${LOGDIR4_NEW}/refresh_tokens.db" ] && echo 0 || echo 1)" \
    "case 4: refresh_tokens.db NOT dumped into the stale/wrong log dir"

echo ""
if [ "${FAILURES}" -eq 0 ]; then
    echo "ALL PASS"
    exit 0
else
    echo "${FAILURES} FAILURE(S)"
    exit 1
fi
