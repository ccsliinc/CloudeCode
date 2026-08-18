#!/bin/bash
# scripts/upgrade_lib/upgrade_rollback_common.sh
#
# Shared functions for scripts/upgrade.sh and scripts/rollback.sh. Sourced,
# never executed directly. Keeps both scripts DRY and keeps the
# three-outcome contract (pass / fail / could-not-evaluate) implemented in
# exactly one place instead of drifting between two copies.
#
# Not named scripts/lib/ - this repo's .gitignore has a generic Python
# "lib/" entry (build-artifact convention) that would silently swallow
# anything placed there. Named upgrade_lib/ instead so it is actually
# tracked; see the README's "why upgrade_lib, not lib" note if this
# surprises you.
#
# Every function documents Description / Inputs / Output per this repo's
# code-standards.md. None of them use a bare `except`-equivalent: every
# external command's exit code is checked explicitly.

# What "user state" means for a from-source install (Path B in the README).
# Split by WHERE it actually lives, verified against the app's own code
# rather than guessed:
#
#   - .env / config.json live in the install dir (AUTH_CONFIG_FILE default
#     ./config.json, .env read from cwd by both setup_auth.py and the app).
#   - config.json.bak / .update-check.json ALSO live in the install dir
#     (config_migration.py writes the former beside config.json;
#     update_check.py's default_cache_path writes the latter beside
#     repo_root() which for a from-source install IS the install dir).
#   - session_metadata.json, pinned_themes.json, unread_state.json, and
#     refresh_tokens.db do NOT live in the install dir. They live under
#     LOG_DIRECTORY (src/config.py:486-522's get_log_dir /
#     get_session_metadata_path / get_pinned_themes_path / analogous
#     unread-state path, and src/main.py:158-162's RefreshStore). The
#     .env.example default for LOG_DIRECTORY is /tmp/cloude-code-logs,
#     which macOS purges on reboot - a backup that skips this directory
#     entirely because it went looking in the install dir would silently
#     protect nothing for any install still on that default. This split
#     exists specifically so that mistake is structurally impossible: the
#     two arrays are keyed by directory, not merged into one guess.
#
# A single flat list previously named every one of these as if they all
# lived in the install dir. Four of six did not: take_backup found .env
# and config.json, silently found nothing for the rest (wrong directory,
# not "absent"), and reported success anyway - a false green. See
# resolve_log_dir() and take_backup() below for the fix.
INSTALL_REQUIRED_PAIR=(".env" "config.json")          # either both exist or neither does; a half-set is a broken install
INSTALL_OPTIONAL_FILES=("config.json.bak" ".update-check.json")  # app-created lazily; absence is normal
STATE_DIR_REQUIRED_FILES=("refresh_tokens.db")          # RefreshStore.init() runs on EVERY server startup - if the server was running, this exists
STATE_DIR_OPTIONAL_FILES=("session_metadata.json" "pinned_themes.json" "unread_state.json")  # created lazily on first session / theme pin / unread event - legitimately absent on a never-used feature

# DEFAULT_PORT and resolve_port() live in scripts/resolve-port.sh - the
# single shared shell-side port resolver every port-aware script in this
# repo sources, instead of each one carrying its own copy of the "8000"
# literal. See that file's docstring for the three-outcome contract
# (resolve_port returns 1 with a stderr reason on an unparseable PORT= -
# it never silently substitutes DEFAULT_PORT for a value it could not
# parse).
_URC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${_URC_DIR}/../resolve-port.sh"

# --- logging: three outcomes, named, never collapsed ------------------------

# Description: print a PASS-tier informational line. Writes to STDERR, not
#   stdout - load-bearing: several functions (take_backup, current_version,
#   resolve_remote, ...) are called via command substitution where stdout
#   IS the return value, and a log line on stdout would silently corrupt
#   it. Every log_* function in this file writes to stderr for exactly
#   this reason; stdout is reserved for values a caller captures.
# Inputs: $* - message.
# Output: none (writes to stderr).
log_ok() { printf '[OK]   %s\n' "$*" >&2; }

# Description: print a plain step/info line, no verdict implied. See
#   log_ok's docstring for why this is stderr, not stdout.
# Inputs: $* - message.
# Output: none (writes to stderr).
log_step() { printf '[STEP] %s\n' "$*" >&2; }

# Description: print a FAIL-tier line. Does not exit by itself.
# Inputs: $* - message.
# Output: none (writes to stderr).
log_fail() { printf '[FAIL] %s\n' "$*" >&2; }

# Description: print the explicit COULD-NOT-EVALUATE state. Never call
#   log_ok or silently proceed when this is the honest answer - see this
#   project's three-outcome rule in CLAUDE.md.
# Inputs: $* - message describing what could not be checked and why.
# Output: none (writes to stderr).
log_unknown() { printf '[UNKNOWN] %s\n' "$*" >&2; }

# Description: print a FAIL line and exit the script non-zero.
# Inputs: $* - message.
# Output: never returns; exits 1.
die() {
    log_fail "$*"
    exit 1
}

# --- environment resolution --------------------------------------------------

# Description: pick the python interpreter to run install-scoped checks
#   with - the install's own venv when it exists (so we run against the
#   dependency versions that install actually has), falling back to a bare
#   python3 on PATH for a fresh checkout that has no venv yet.
# Inputs: $1 - install_dir.
# Output: prints an absolute path to a python3 executable on stdout. Exits
#   with a die() if neither exists (COULD-NOT-EVALUATE: nothing to run).
resolve_python() {
    local install_dir="$1"
    if [ -x "${install_dir}/venv/bin/python3" ]; then
        printf '%s\n' "${install_dir}/venv/bin/python3"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        command -v python3
        return 0
    fi
    die "no venv at ${install_dir}/venv and no python3 on PATH - cannot run any check"
}

# resolve_port() is sourced from scripts/resolve-port.sh (see the source
# line near the top of this file) rather than defined here.

# Description: resolve LOG_DIRECTORY the SAME WAY the app does -
#   src/config.py's get_log_dir() is ``Path(self.log_directory).expanduser()``
#   with no other transformation, so this reads LOG_DIRECTORY= out of .env
#   and expands it the identical way (via python's os.path.expanduser, not
#   a bash tilde trick, so "~" and "~user" both behave exactly like the
#   app's own Path.expanduser() call). session_metadata.json,
#   pinned_themes.json, unread_state.json, and refresh_tokens.db all live
#   here, not in the install dir - see the STATE_DIR_* arrays above.
# Inputs: $1 - install_dir (must contain a readable .env with LOG_DIRECTORY=).
# Output: prints the expanded absolute log directory path and returns 0.
#   Returns 1 and prints nothing when .env is missing or has no
#   LOG_DIRECTORY= line - callers must treat that as COULD-NOT-EVALUATE for
#   the state-dir files, not as "no state exists".
resolve_log_dir() {
    local install_dir="$1" python_bin
    local env_file="${install_dir}/.env"
    if [ ! -f "${env_file}" ]; then
        return 1
    fi
    local raw
    raw="$(grep -E '^LOG_DIRECTORY=' "${env_file}" | tail -1 | cut -d= -f2-)"
    if [ -z "${raw}" ]; then
        return 1
    fi
    python_bin="$(resolve_python "${install_dir}")"
    "${python_bin}" -c "import os, sys; print(os.path.expanduser(sys.argv[1]))" "${raw}"
}

# Description: confirm install_dir is itself a git work tree root (not an
#   ancestor's), the same guard src/core/version.py's is_git_root enforces
#   for the identical reason - `git -C` walks upward and would otherwise
#   silently answer with an unrelated enclosing repo.
# Inputs: $1 - install_dir.
# Output: exit 0 if install_dir is a git work tree root; exit 1 with a
#   die() otherwise.
require_git_root() {
    local install_dir="$1"
    if [ ! -d "${install_dir}/.git" ]; then
        die "${install_dir} is not a git checkout (no .git). This script only manages a from-source install (README Path B). A packaged .app install upgrades by downloading a new DMG - see the README."
    fi
    local toplevel
    toplevel="$(cd "${install_dir}" && git rev-parse --show-toplevel 2>/dev/null)" || die "git rev-parse failed in ${install_dir} - is git installed?"
    if [ "$(cd "${toplevel}" && pwd -P)" != "$(cd "${install_dir}" && pwd -P)" ]; then
        die "${install_dir} sits inside another repository's work tree (${toplevel}). Refusing - this is exactly the footgun src/core/version.py's is_git_root guards against."
    fi
}

# Description: refuse to touch an install whose tracked files have local
#   modifications. A dirty tree means `git checkout <tag>` can silently
#   discard edits or refuse partway through, and either is worse than
#   stopping up front with a clear message.
# Inputs: $1 - install_dir.
# Output: exit 0 if clean; exit 1 with a die() and the dirty file list
#   otherwise.
require_clean_tree() {
    local install_dir="$1"
    local dirty
    dirty="$(cd "${install_dir}" && git status --porcelain --untracked-files=no)"
    if [ -n "${dirty}" ]; then
        log_fail "tracked files in ${install_dir} have local modifications:"
        printf '%s\n' "${dirty}" >&2
        die "commit, stash, or discard these before upgrading/rolling back - a dirty tree makes 'git checkout <tag>' unsafe to run unattended"
    fi
}

# --- version + tag resolution (delegates to version_probe.py) ---------------

# Description: resolve the currently-installed version via the project's
#   single version resolver (src/core/version.py), never a parallel
#   implementation.
# Inputs: $1 - install_dir. $2 - path to scripts/upgrade_lib/version_probe.py.
# Output: prints the version on stdout and returns 0 on success. Returns 3
#   (COULD-NOT-EVALUATE, not 1) and prints nothing on stdout when the
#   version did not resolve - callers must check the exit code, not assume
#   a non-empty string.
current_version() {
    local install_dir="$1" probe="$2" python_bin
    python_bin="$(resolve_python "${install_dir}")"
    "${python_bin}" "${probe}" current --install-dir "${install_dir}"
}

# Description: resolve which git remote release tags should be read from.
# Inputs: $1 - install_dir. $2 - probe script path.
# Output: prints the remote URL on stdout. Always succeeds (falls back to
#   the public upstream) - see version_probe.py's resolve_remote.
resolve_remote() {
    local install_dir="$1" probe="$2" python_bin config_arg=()
    python_bin="$(resolve_python "${install_dir}")"
    if [ -f "${install_dir}/config.json" ]; then
        config_arg=(--config "${install_dir}/config.json")
    fi
    "${python_bin}" "${probe}" remote --install-dir "${install_dir}" "${config_arg[@]}"
}

# --- confirmation -------------------------------------------------------------

# Description: interactive yes/no gate. Skipped entirely when ASSUME_YES=1.
# Inputs: $1 - prompt text. Reads $ASSUME_YES from the environment.
# Output: exit 0 (proceed) or exit 1 via die() (user declined / non-tty
#   without --yes).
confirm_or_die() {
    local prompt="$1"
    if [ "${ASSUME_YES:-0}" = "1" ]; then
        log_step "non-interactive (--yes): proceeding without a prompt"
        return 0
    fi
    if [ ! -t 0 ]; then
        die "no terminal attached and --yes was not given - refusing to guess. Re-run with --yes for non-interactive use (e.g. from the menu bar app)."
    fi
    local reply
    read -r -p "${prompt} [type yes to continue] " reply
    if [ "${reply}" != "yes" ]; then
        die "not confirmed - no changes made"
    fi
}

# --- backup / restore ---------------------------------------------------------
#
# Every file this backup touches gets exactly one of THREE recorded
# outcomes, written to backup_dir/.manifest as "<OUTCOME>\t<category>\t<name>":
#   BACKED_UP     - copied, bytes verified present in the backup
#   NOT_PRESENT   - legitimately doesn't exist yet (lazily-created file on
#                   a feature never used, or a never-configured install)
#   MISSING       - should exist and does not. This one is FATAL: take_backup
#                   dies rather than returning, because a backup that is
#                   silently missing declared state is worse than no backup -
#                   the caller would proceed to upgrade believing it has a
#                   safety net it does not have.
# Never collapse MISSING into NOT_PRESENT to make a run "succeed" - that is
# the exact false-green this file exists to prevent.

# Description: append one manifest line. Internal helper, not called
#   directly from upgrade.sh/rollback.sh.
# Inputs: $1 - backup_dir. $2 - outcome (BACKED_UP|NOT_PRESENT|MISSING).
#   $3 - category (install|state). $4 - filename.
# Output: none (appends to backup_dir/.manifest).
_manifest_record() {
    printf '%s\t%s\t%s\n' "$2" "$3" "$4" >> "$1/.manifest"
}

# Description: back up every piece of user state this install has, split
#   correctly between the install dir and LOG_DIRECTORY (see the array
#   comments above resolve_log_dir). Safe to call while the server is
#   still running - every copy is a plain read of the source file.
# Inputs: $1 - install_dir. $2 - backup_dir (must not already exist).
# Output: prints the backup_dir on stdout for the caller to surface
#   prominently. Exits via die() if: backup_dir already exists; it cannot
#   be created; any BACKED_UP copy fails; INSTALL_REQUIRED_PAIR is
#   half-present (one of .env/config.json exists, the other does not - a
#   broken install, not a legitimate state); the install is configured
#   (.env present) but LOG_DIRECTORY cannot be resolved from it; or any
#   STATE_DIR_REQUIRED_FILES entry is missing while the install is
#   configured (refresh_tokens.db is created by every server startup, so
#   its absence on a configured, presumably-just-stopped install means
#   something is already wrong and a backup here would be incomplete).
take_backup() {
    local install_dir="$1" backup_dir="$2"
    if [ -e "${backup_dir}" ]; then
        die "backup directory ${backup_dir} already exists - refusing to overwrite a prior backup"
    fi
    mkdir -p "${backup_dir}/install" "${backup_dir}/state" || die "could not create backup directory ${backup_dir}"
    : > "${backup_dir}/.manifest"

    local env_present=0 config_present=0
    [ -f "${install_dir}/.env" ] && env_present=1
    [ -f "${install_dir}/config.json" ] && config_present=1

    if [ "${env_present}" -ne "${config_present}" ]; then
        die "half-configured install in ${install_dir}: .env present=${env_present}, config.json present=${config_present} - a broken install, refusing to guess which half is authoritative"
    fi

    local configured=0
    if [ "${env_present}" -eq 1 ]; then
        configured=1
        local f
        for f in "${INSTALL_REQUIRED_PAIR[@]}"; do
            cp -p "${install_dir}/${f}" "${backup_dir}/install/${f}" || die "failed to back up ${f}"
            _manifest_record "${backup_dir}" BACKED_UP install "${f}"
        done
    else
        log_unknown "${install_dir} has neither .env nor config.json - nothing has been configured yet (fresh checkout); backing up nothing, which is correct, not a failure"
    fi

    local f
    for f in "${INSTALL_OPTIONAL_FILES[@]}"; do
        if [ -f "${install_dir}/${f}" ]; then
            cp -p "${install_dir}/${f}" "${backup_dir}/install/${f}" || die "failed to back up ${f}"
            _manifest_record "${backup_dir}" BACKED_UP install "${f}"
        else
            _manifest_record "${backup_dir}" NOT_PRESENT install "${f}"
        fi
    done

    if [ "${configured}" -eq 1 ]; then
        local log_dir
        log_dir="$(resolve_log_dir "${install_dir}")"
        if [ -z "${log_dir}" ]; then
            die "${install_dir} is configured (.env present) but LOG_DIRECTORY could not be resolved from it - refusing to back up blind. session_metadata.json, pinned_themes.json, unread_state.json, and refresh_tokens.db all live there and would be silently skipped otherwise."
        fi
        log_step "state directory (LOG_DIRECTORY): ${log_dir}"

        for f in "${STATE_DIR_REQUIRED_FILES[@]}"; do
            if [ -f "${log_dir}/${f}" ]; then
                cp -p "${log_dir}/${f}" "${backup_dir}/state/${f}" || die "failed to back up ${f} from ${log_dir}"
                _manifest_record "${backup_dir}" BACKED_UP state "${f}"
            else
                die "expected ${log_dir}/${f} (created by every server startup) but it is missing - either the server never started successfully on this install, or state has already been lost. Refusing to take a partial backup and proceed with a destructive upgrade. If this install genuinely never ran, there is nothing to upgrade yet."
            fi
        done
        for f in "${STATE_DIR_OPTIONAL_FILES[@]}"; do
            if [ -f "${log_dir}/${f}" ]; then
                cp -p "${log_dir}/${f}" "${backup_dir}/state/${f}" || die "failed to back up ${f} from ${log_dir}"
                _manifest_record "${backup_dir}" BACKED_UP state "${f}"
            else
                _manifest_record "${backup_dir}" NOT_PRESENT state "${f}"
            fi
        done
    else
        log_unknown "skipping the state directory entirely - install was never configured, so LOG_DIRECTORY is unknown and nothing could exist there yet"
    fi

    local backed_up_count
    backed_up_count="$(grep -c '^BACKED_UP' "${backup_dir}/.manifest" || true)"
    printf '%s\n' "${backed_up_count:-0}" > "${backup_dir}/.file-count"
    log_ok "manifest: $(grep -c '^BACKED_UP' "${backup_dir}/.manifest" || echo 0) backed up, $(grep -c '^NOT_PRESENT' "${backup_dir}/.manifest" || echo 0) not present (see ${backup_dir}/.manifest)"
    printf '%s\n' "${backup_dir}"
}

# Description: restore every BACKED_UP entry from a backup's manifest back
#   to where the app actually reads it from - install_dir for the
#   "install" category, the CURRENTLY-configured LOG_DIRECTORY for the
#   "state" category. Restores install files FIRST so LOG_DIRECTORY can be
#   read from the just-restored .env before any state file is placed.
#   Does NOT run config migration afterward - the whole point of a
#   rollback is that the restored config matches the OLDER code being
#   checked out alongside it.
# Inputs: $1 - install_dir. $2 - backup_dir (must exist and have a
#   .manifest produced by take_backup).
# Output: prints the number of files restored on stdout. Exits via die()
#   if backup_dir or its manifest is missing, a BACKED_UP install file's
#   restore copy fails, or (once install files are back) LOG_DIRECTORY
#   cannot be resolved while the manifest has BACKED_UP state entries to
#   place, or any of those copies fail. A failure partway leaves
#   install_dir in a MIXED state - reported loudly, never swallowed.
restore_backup() {
    local install_dir="$1" backup_dir="$2"
    if [ ! -d "${backup_dir}" ]; then
        die "backup directory ${backup_dir} does not exist - cannot restore"
    fi
    if [ ! -f "${backup_dir}/.manifest" ]; then
        die "${backup_dir} has no .manifest - it was not produced by take_backup, refusing to trust it"
    fi

    local restored=0
    local outcome category name
    while IFS=$'\t' read -r outcome category name; do
        [ "${outcome}" = "BACKED_UP" ] || continue
        [ "${category}" = "install" ] || continue
        cp -p "${backup_dir}/install/${name}" "${install_dir}/${name}" || die "PARTIAL RESTORE: failed copying ${name} from ${backup_dir}/install - install_dir is now in a mixed state, ${restored} file(s) restored so far. Fix manually: diff ${backup_dir}/install ${install_dir}"
        restored=$((restored + 1))
    done < "${backup_dir}/.manifest"

    if grep -q '^BACKED_UP\tstate\t' "${backup_dir}/.manifest"; then
        local log_dir
        log_dir="$(resolve_log_dir "${install_dir}")"
        if [ -z "${log_dir}" ]; then
            die "PARTIAL RESTORE: install files restored (${restored}), but LOG_DIRECTORY cannot be resolved from the just-restored .env, so session_metadata.json/pinned_themes.json/unread_state.json/refresh_tokens.db could NOT be restored. Fix .env's LOG_DIRECTORY and re-run this script (idempotent) to finish."
        fi
        mkdir -p "${log_dir}" || die "could not create LOG_DIRECTORY ${log_dir} to restore state files into"
        while IFS=$'\t' read -r outcome category name; do
            [ "${outcome}" = "BACKED_UP" ] || continue
            [ "${category}" = "state" ] || continue
            cp -p "${backup_dir}/state/${name}" "${log_dir}/${name}" || die "PARTIAL RESTORE: failed copying ${name} from ${backup_dir}/state to ${log_dir} - ${restored} file(s) restored so far. Fix manually: diff ${backup_dir}/state ${log_dir}"
            restored=$((restored + 1))
        done < "${backup_dir}/.manifest"
    fi

    printf '%s\n' "${restored}"
}

# --- service lifecycle ---------------------------------------------------------

# Description: stop the running server via the install's own stop.sh, so
#   behavior (graceful then SIGKILL, port-free verification) matches
#   exactly what a human running stop.sh by hand gets - no parallel kill
#   logic here.
# Inputs: $1 - install_dir.
# Output: exit 0 if stop.sh reports the port free (or was already free);
#   exit 1 via die() otherwise.
stop_service() {
    local install_dir="$1"
    if [ ! -x "${install_dir}/stop.sh" ]; then
        die "no executable stop.sh in ${install_dir}"
    fi
    (cd "${install_dir}" && ./stop.sh) || die "stop.sh exited non-zero - server may still be running, refusing to proceed with an upgrade against a live process"
}

# Description: start (or restart) the server via the install's own
#   reset.sh, so launchd-managed and unmanaged installs are both handled
#   correctly - same reasoning as stop_service.
# Inputs: $1 - install_dir.
# Output: exit 0 if reset.sh reports success; exit 1 via die() otherwise.
start_service() {
    local install_dir="$1"
    if [ ! -x "${install_dir}/reset.sh" ]; then
        die "no executable reset.sh in ${install_dir}"
    fi
    (cd "${install_dir}" && ./reset.sh) || die "reset.sh exited non-zero - the server did not come back up. Check ${install_dir}/logs and CLOUDE_LAUNCHD_LABEL if this is a launchd-managed install."
}

# --- post-restart verification: THREE outcomes, not two ---------------------

# Description: verify the server actually answers on its health endpoint
#   AND that this install's resolved version equals what was expected.
#   THREE-OUTCOME: distinguishes "confirmed matching" (0), "confirmed
#   wrong/unreachable" (2), and "could not even ask" (3, e.g. curl
#   missing) - never reports the third as if it were the first.
# Inputs: $1 - install_dir. $2 - port. $3 - expected_version. $4 - probe
#   script path. $5 - optional timeout in seconds (default 20).
# Output: prints a human status line. Returns 0 (verified), 2 (verified
#   failure - server answered but wrong version, or never came up within
#   the timeout), or 3 (could not evaluate - curl unavailable, python
#   unavailable to compute the expected-vs-actual comparison).
verify_upgrade() {
    local install_dir="$1" port="$2" expected_version="$3" probe="$4"
    local timeout_s="${5:-20}"

    if ! command -v curl >/dev/null 2>&1; then
        log_unknown "curl is not on PATH - cannot verify the server answers. Check manually: open http://127.0.0.1:${port}/health"
        return 3
    fi

    local waited=0
    local health_ok=0
    while [ "${waited}" -lt "${timeout_s}" ]; do
        if curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
            health_ok=1
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if [ "${health_ok}" -ne 1 ]; then
        log_fail "server did not answer http://127.0.0.1:${port}/health within ${timeout_s}s after restart"
        return 2
    fi
    log_ok "server answers on port ${port} (waited ${waited}s)"

    local actual_version
    actual_version="$(current_version "${install_dir}" "${probe}")"
    local rc=$?
    if [ "${rc}" -ne 0 ] || [ -z "${actual_version}" ]; then
        log_unknown "server is up, but the post-restart version could not be resolved - cannot confirm it is running ${expected_version}"
        return 3
    fi
    if [ "${actual_version}" != "${expected_version}" ]; then
        log_fail "server is up but reports version '${actual_version}', expected '${expected_version}'"
        return 2
    fi
    log_ok "server confirms version ${actual_version}"
    return 0
}
