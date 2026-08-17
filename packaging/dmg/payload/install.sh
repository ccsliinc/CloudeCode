#!/bin/bash
# install.sh - first-run setup for Cloude Code on macOS.
#
# WHAT IT DOES, in order, and it announces every step:
#   1. checks every precondition BEFORE touching anything
#   2. clones the repo at the chosen release tag into ~/.cloude-code/app
#   3. builds the venv and installs dependencies
#   4. generates a per-install TOTP secret and JWT secret
#   5. writes .env and config.json, mode 600
#   6. installs a USER LaunchAgent and bootstraps it into gui/<uid>
#   7. restarts and verifies health at the REAL bound address
#
# It refuses rather than half-applying. If a precondition fails it says
# exactly what to fix and exits without having written anything.
#
# Usage:
#   ./install.sh [--tag vX.Y.Z] [--host ADDR] [--port N] [--remote URL] [--yes]
#
# --yes takes every default without prompting (for a scripted install).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=lib/upgrade-model.sh
source "$HERE/lib/upgrade-model.sh"

DEFAULT_REMOTE="https://github.com/ccsliinc/CloudeCode.git"
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="8000"
HEALTH_TIMEOUT=90

WANT_TAG=""
WANT_HOST=""
WANT_PORT=""
WANT_REMOTE=""
ASSUME_YES=0

# parse_args ARGS...
# Fill the WANT_* globals from the command line.
# Args: the script's argument vector. Exits 1 on an unknown flag.
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --tag) WANT_TAG="${2:-}"; shift 2 ;;
            --host) WANT_HOST="${2:-}"; shift 2 ;;
            --port) WANT_PORT="${2:-}"; shift 2 ;;
            --remote) WANT_REMOTE="${2:-}"; shift 2 ;;
            --yes|-y) ASSUME_YES=1; shift ;;
            -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
            *) fail "unknown option: $1" "run ./install.sh --help" ;;
        esac
    done
}

# check_preconditions
# Verify everything BEFORE a single file is written. Exits 1 on the first
# hard failure, naming the fix.
check_preconditions() {
    say "checking preconditions (nothing is written until all of these pass)"
    require_macos
    ok "macos $(sw_vers -productVersion)"

    local git_bin python_bin tmux_bin claude_bin
    git_bin="$(find_git)" || fail \
        "git is not installed." \
        "install the command line tools:  xcode-select --install"
    ok "git: $git_bin"

    python_bin="$(find_python)" || fail \
        "python3 is not installed." \
        "install it with:  brew install python@3.12"
    ok "python3: $python_bin ($("$python_bin" --version 2>&1))"

    # tmux CANNOT be bundled. Without it sessions die on every server
    # restart, so this is a hard requirement, not a nice to have.
    tmux_bin="$(find_tmux)" || fail \
        "tmux is not installed, and it cannot be bundled." \
        "sessions would not survive a server restart without it." \
        "install it with:  brew install tmux"
    ok "tmux: $tmux_bin ($("$tmux_bin" -V 2>&1))"

    # The claude CLI cannot be bundled either. The two machines here differ:
    # the mini has the homebrew cask, the workstation has ~/.local/bin.
    if claude_bin="$(find_claude)"; then
        ok "claude cli: $claude_bin"
    else
        fail "the claude cli was not found." \
             "checked the homebrew cask (/opt/homebrew/Caskroom/claude-code/)," \
             "~/.local/bin/claude and ~/.claude/local/claude." \
             "install it, then run this installer again:" \
             "  brew install --cask claude-code" \
             "or follow https://claude.com/download"
    fi

    if [ -e "$CC_APP" ]; then
        fail "there is already an install at $CC_APP." \
             "to move to a newer release run:  $CC_BIN/upgrade.sh" \
             "to start over, remove $CC_ROOT yourself first."
    fi

    mkdir -p "$CC_ROOT" || fail "could not create $CC_ROOT"
    require_free_disk 500 "$CC_ROOT"
    ok "enough free disk"
}

# choose_settings
# Ask the human for the settings that vary per machine. Prompts are visible
# on the tty and default to the safe choice; --yes skips them entirely.
choose_settings() {
    [ -z "$WANT_REMOTE" ] && WANT_REMOTE="$DEFAULT_REMOTE"
    [ -z "$WANT_HOST" ] && WANT_HOST="$DEFAULT_HOST"
    [ -z "$WANT_PORT" ] && WANT_PORT="$DEFAULT_PORT"

    if [ "$ASSUME_YES" -eq 0 ]; then
        echo
        echo "  HOST decides who can reach this server."
        echo "  127.0.0.1 = this mac only (safe default)."
        echo "  a lan address such as 10.0.1.150 = anything on your network."
        echo "  0.0.0.0 = every interface. only do that behind a tunnel."
        echo
        ask "host to bind" "$WANT_HOST" WANT_HOST
        ask "port" "$WANT_PORT" WANT_PORT
        ask "release remote" "$WANT_REMOTE" WANT_REMOTE
    fi
    ok "host=$WANT_HOST port=$WANT_PORT remote=$WANT_REMOTE"
}

# fetch_code
# Clone at the requested tag, or at the newest release tag when none was
# given. Sets WANT_TAG to what was actually checked out.
fetch_code() {
    local newest
    if [ -z "$WANT_TAG" ]; then
        say "asking $WANT_REMOTE for the newest release tag"
        newest="$(git ls-remote --tags --refs "$WANT_REMOTE" 2>/dev/null \
                  | sed -n 's#.*refs/tags/##p' \
                  | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
                  | sort -t. -k1,1V | tail -n 1)"
        [ -z "$newest" ] && fail \
            "could not read the release tag list from $WANT_REMOTE." \
            "check your network, then run this installer again." \
            "to pin a specific release instead:  ./install.sh --tag v0.8.1"
        WANT_TAG="$newest"
        ok "newest release tag is $WANT_TAG"
    fi

    say "cloning $WANT_REMOTE at $WANT_TAG into $CC_APP"
    um_clone "$WANT_REMOTE" "$WANT_TAG" "$CC_APP" || fail \
        "the clone failed." \
        "check that $WANT_TAG exists on $WANT_REMOTE and that you can reach it."
    ok "code is at $WANT_TAG (upgrade model: $(um_model_name))"
}

# build_venv
# Create the virtualenv and install requirements inside the checkout.
build_venv() {
    local python_bin
    python_bin="$(find_python)" || fail "python3 disappeared between checks"
    say "creating the virtualenv and installing dependencies (this takes a minute)"
    "$python_bin" -m venv "$CC_APP/venv" || fail "could not create the virtualenv"
    "$CC_APP/venv/bin/pip" install --quiet --upgrade pip \
        || warn "could not upgrade pip - continuing"
    "$CC_APP/venv/bin/pip" install --quiet -r "$CC_APP/requirements.txt" \
        || fail "dependency install failed. the error is above."
    ok "dependencies installed"
}

# write_secrets_and_config
# Generate per-install secrets and write .env and config.json.
#
# SECRETS ARE GENERATED HERE, NEVER SHIPPED. Nothing in the dmg contains a
# TOTP or JWT secret. Both files are written mode 600 and both live inside
# the checkout, which .gitignore already covers along with their .bak forms.
write_secrets_and_config() {
    local python_bin totp jwt claude_bin
    python_bin="$CC_APP/venv/bin/python3"
    claude_bin="$(find_claude || true)"

    say "generating a totp secret and a jwt secret for this install"
    totp="$("$python_bin" -c 'import pyotp; print(pyotp.random_base32())')" \
        || fail "could not generate the totp secret"
    jwt="$("$python_bin" -c 'import secrets; print(secrets.token_urlsafe(32))')" \
        || fail "could not generate the jwt secret"

    umask 077
    say "writing $CC_APP/.env"
    {
        echo "# generated by install.sh. per install. never commit this file."
        echo "HOST=$WANT_HOST"
        echo "PORT=$WANT_PORT"
        echo "TOTP_SECRET=$totp"
        echo "JWT_SECRET=$jwt"
        echo "AUTH_CONFIG_FILE=./config.json"
        [ -n "$claude_bin" ] && echo "CLAUDE_CLI_PATH=$claude_bin"
        echo "LOG_DIRECTORY=$CC_STATE/logs"
    } > "$CC_APP/.env"
    chmod 600 "$CC_APP/.env"
    ok ".env written, mode 600"

    if [ ! -f "$CC_APP/config.json" ]; then
        say "writing $CC_APP/config.json from the shipped example"
        cp "$CC_APP/config.example.json" "$CC_APP/config.json"
        chmod 600 "$CC_APP/config.json"
        ok "config.json written, mode 600"
    fi

    mkdir -p "$CC_STATE/logs"
    ok "state directory: $CC_STATE"
}

# install_launchagent
# Write the plist from the template and bootstrap it into gui/<uid>.
#
# IT MUST BE A USER LAUNCHAGENT. A LaunchDaemon cannot work: the macOS login
# keychain that holds the claude credentials is unreadable outside a gui
# session, so the service has to run as the logged-in user, in that session.
# This is the single hardest constraint in the project.
install_launchagent() {
    local tmux_bin claude_bin path_value
    tmux_bin="$(find_tmux)"
    claude_bin="$(find_claude || true)"
    path_value="$(dirname "$tmux_bin"):$CC_EXTRA_PATH:/usr/bin:/bin:/usr/sbin:/sbin"
    [ -n "$claude_bin" ] && path_value="$(dirname "$claude_bin"):$path_value"

    say "installing the run wrapper at $CC_BIN/run.sh"
    mkdir -p "$CC_BIN"
    cp -R "$HERE/lib" "$CC_BIN/"
    for script in install.sh upgrade.sh rollback.sh run.sh; do
        [ -f "$HERE/$script" ] && cp "$HERE/$script" "$CC_BIN/$script"
    done
    chmod +x "$CC_BIN"/*.sh

    say "writing $CC_PLIST"
    mkdir -p "$(dirname "$CC_PLIST")"
    sed -e "s#@@LABEL@@#${CC_LABEL}#g" \
        -e "s#@@RUN@@#${CC_BIN}/run.sh#g" \
        -e "s#@@WORKDIR@@#${CC_APP}#g" \
        -e "s#@@PATH@@#${path_value}#g" \
        -e "s#@@LOGDIR@@#${CC_STATE}/logs#g" \
        "$HERE/com.imc.cloude-code.plist.template" > "$CC_PLIST"
    chmod 644 "$CC_PLIST"
    ok "plist written"

    say "bootstrapping into ${CC_GUI_DOMAIN} (a user agent, not a daemon)"
    launchctl bootout "${CC_GUI_DOMAIN}/${CC_LABEL}" 2>/dev/null || true
    launchctl bootstrap "$CC_GUI_DOMAIN" "$CC_PLIST" || fail \
        "launchctl bootstrap failed." \
        "you must be logged in to the desktop for this to work." \
        "the plist is at $CC_PLIST if you want to inspect it."
    launchctl enable "${CC_GUI_DOMAIN}/${CC_LABEL}" 2>/dev/null || true
    ok "launchagent loaded"
}

# verify
# Restart and prove the server answers at the address it actually binds.
verify() {
    service_restart || warn "kickstart returned non-zero - checking health anyway"
    if wait_for_health "$HEALTH_TIMEOUT"; then
        return 0
    fi
    warn "the service did not come up healthy."
    warn "logs: $CC_STATE/logs/launchd.out and launchd.err"
    warn "nothing was rolled back, because this was a fresh install:"
    warn "there is no previous version to go back to. fix the error above"
    warn "and run:  launchctl kickstart -k ${CC_GUI_DOMAIN}/${CC_LABEL}"
    return 1
}

# main ARGS...
# Entry point. Returns 0 on a healthy install, 1 otherwise.
main() {
    parse_args "$@"
    echo "cloude code installer"
    echo "====================="
    check_preconditions
    choose_settings
    fetch_code
    build_venv
    write_secrets_and_config
    install_launchagent
    manifest_write "$WANT_TAG" "$WANT_REMOTE" "$WANT_HOST" "$WANT_PORT"

    local host port
    read -r host port <<< "$(probe_host)"
    if verify; then
        echo
        ok "cloude code $WANT_TAG is installed and running"
        echo "     open:      http://${host}:${port}"
        echo "     pair totp: $CC_APP/venv/bin/python3 $CC_APP/setup_auth.py"
        echo "     upgrade:   $CC_BIN/upgrade.sh"
        echo "     roll back: $CC_BIN/rollback.sh"
        return 0
    fi
    return 1
}

main "$@"
