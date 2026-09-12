#!/bin/bash
# deploy-mini.sh - push code from this Mac to the mini, and prove it landed.
#
# WHY THIS EXISTS. Neither install on the mini is a git checkout: the live
# one is a copied server dir inside the app bundle's support folder, and
# v1.1 is a clone that is NOT kept in sync by pulling (you develop here,
# not there). So "deploy" means copying files and restarting the right
# server, which was being done by hand, one scp at a time.
#
# TWO TARGETS, and they must never be confused:
#   live  port 8000, state ~/Library/Application Support/CloudeCode,
#         tmux socket `cloude`. This is the app you actually use.
#   v11   port 8001, state ~/Library/.../CloudeCode-v1.1,
#         tmux socket `cloude-v11`. Disposable.
#
# Default target is v11 ON PURPOSE. Deploying to live is the destructive
# one, so it must be typed.
#
# LIVE HAS TWO DESTINATIONS AND BOTH ARE MANDATORY. The packaged app
# treats Resources/src inside the bundle as authoritative and copies it
# over the server dir on every start, so a deploy that lands ONLY in the
# server dir is reverted by the next restart, including the restart this
# script issues. Measured 2026-08-29: file correct before the restart,
# original hash after it, three times. (That restart is NOT
# `launchctl kickstart -k`, which orphans the server; it is the app
# noticing its process is gone and starting a new one.) The bundle is written FIRST, so
# that the one survivable partial state is the one we end up in if the
# second copy fails.
#
# Usage:
#   ./scripts/deploy-mini.sh                 # -> v1.1, restart
#   ./scripts/deploy-mini.sh --target live   # -> the live install
#   ./scripts/deploy-mini.sh --all           # every tracked src/client file
#   ./scripts/deploy-mini.sh --no-restart    # copy only
#   ./scripts/deploy-mini.sh --dry-run       # print what would go
#   ./scripts/deploy-mini.sh --verify-only   # hash the target, copy nothing
#
# MIRROR, NOT MERGE (Punchlist #23). Every real destination write goes
# through ditto, which only ever adds and overwrites - a file removed from
# git stays behind on the target forever, and the old verification only
# ever hashed files that SHOULD be present, so it could never see one that
# should not be. Every deploy now also prunes any file under a
# destination's src/ or client/ that is not tracked at HEAD (dl_prune_stale
# in deploy-lib.sh), and verification checks BOTH directions: the tracked
# files are present and correct (dl_verify) AND nothing untracked remains
# (dl_verify_no_extra). The prune baseline is EVERY tracked src/client
# file regardless of extension, not just the EXT_RE set this script
# copies - a tracked-but-undeployed asset (a doc, a vendor font) must
# never be mistaken for a leftover.
#
# THE COMMITTED SVELTE BUNDLE IS CHECKED BEFORE ANYTHING IS COPIED
# (2026-09-09). client/dist/app.js and app.css are a BUILD ARTIFACT that
# is committed, because this script ships the committed file set and the
# mini runs no build. That makes a stale bundle invisible to every check
# below: the bytes on the target really do match the bytes on this Mac,
# because they are both the stale ones. scripts/web-build-check.sh
# rebuilds from web/src and fails if the committed bundle drifted, and it
# runs BEFORE the transfer so a stale one is caught while nothing has
# been written anywhere. Its exit 2 (could not evaluate: no node, no npm,
# build failed) becomes this script's exit 3, because a check that did
# not run is not a check that passed. Set CLOUDE_DEPLOY_SKIP_WEB_CHECK=1
# to deploy from a machine with no node toolchain; it prints a loud line
# saying the bundle went unverified, which is the whole difference
# between an accepted risk and a silent one.
#
# Exit codes:
#   0  DEPLOYED and verified (both directions: present+correct, and clean)
#   1  DEPLOY FAILED (transfer, copy, prune or restart)
#   2  NOTHING DEPLOYED (no files matched; the target was NOT updated)
#   3  CANNOT DETERMINE (verification could not be evaluated)
#   4  VERIFICATION FAILED (bytes don't match, OR an untracked file remains)
#  64  usage error
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy-lib.sh
. "$SCRIPT_DIR/deploy-lib.sh"
# shellcheck source=scripts/deploy-restart-check.sh
. "$SCRIPT_DIR/deploy-restart-check.sh"
cd "$SCRIPT_DIR/.."

# Extension set, ONE definition. json is included on every path: the
# themes under client/css/themes/*/theme.json and src/data/slash-commands.json
# are real deployable assets, and leaving json out of the changed-files
# path (as this script used to) meant a theme edit silently never shipped.
EXT_RE='\.(py|js|css|html|json)$'

# Self test hooks. These exist so the transfer and verification can be
# exercised against a scratch directory instead of production. They are
# environment only, never flags, and the destinations are printed on
# every run so an override can never be silent.
HOST="${CLOUDE_DEPLOY_HOST:-mac-mini-m4}"
HEALTH_HOST="${CLOUDE_DEPLOY_HEALTH_HOST:-10.0.1.150}"

TARGET="v11"
RESTART=1
ALL=0
DRY=0
VERIFY_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --target)      TARGET="${2:-}"; shift 2 ;;
        --all)         ALL=1; shift ;;
        --no-restart)  RESTART=0; shift ;;
        --dry-run)     DRY=1; shift ;;
        --verify-only) VERIFY_ONLY=1; RESTART=0; shift ;;
        # The header grew when the committed-bundle check landed
        # (2026-09-09). The range ends at the last usage line rather than
        # at a number somebody has to remember to move.
        -h|--help)     sed -n '2,34p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

# TARGET RESOLUTION. `live` must be typed. Anything not in the set is a
# usage error rather than a fallback, so a typo can never resolve to a
# destination the operator did not name.
case "$TARGET" in
    live) DEST_SERVER="${CLOUDE_DEPLOY_DEST_SERVER:-/Users/jsugamele/Library/Application Support/cloude-code-menubar/server}"
          DEST_BUNDLE="${CLOUDE_DEPLOY_DEST_BUNDLE:-/Applications/Cloude Code.app/Contents/Resources}"
          PORT=8000; LABEL="LIVE (the app you use)" ;;
    v11)  DEST_SERVER="${CLOUDE_DEPLOY_DEST_SERVER:-/Users/jsugamele/CloudeCode-v1.1}"
          DEST_BUNDLE="${CLOUDE_DEPLOY_DEST_BUNDLE:-}"
          PORT=8001; LABEL="v1.1 (disposable)" ;;
    *) echo "unknown target: '$TARGET' (want: live | v11)" >&2; exit 64 ;;
esac

# ONE list drives transfer AND verification, so a destination can never
# be written without also being checked. Bundle first, see the header.
DESTS=()
DEST_NAMES=()
if [ -n "$DEST_BUNDLE" ]; then
    DESTS+=("$DEST_BUNDLE");  DEST_NAMES+=("app bundle Resources")
fi
DESTS+=("$DEST_SERVER");      DEST_NAMES+=("server dir")

# ---------------------------------------------------------------- outcome
# THREE OUTCOMES, three banners, three exit codes. "nothing to do" is not
# a quieter kind of success and must never be phrasable as one, so every
# terminating path below prints one of these and none exits silently.
say_deployed()  { echo; echo "== DEPLOYED =="; }
say_nothing()   { echo; echo "== NOTHING DEPLOYED =="; }
say_failed()    { echo; echo "== DEPLOY FAILED ==" >&2; }

# ------------------------------------------------------------ file choice
# Changed files by default, because that is what you are iterating on.
# A CLEAN TREE FALLS BACK TO THE COMMITTED STATE rather than doing
# nothing: `deploy-mini.sh --target live` right after a commit means "put
# the committed code on the mini", and the old behaviour of printing
# "nothing to deploy" and exiting was repeatedly read as a successful
# deploy. A deleted file is excluded from THIS list (the copy step never
# needs to touch it) but is not exempt from the deploy: the prune step
# below mirrors every destination against all_tracked_files(), always the
# FULL current tracked set regardless of which of these two functions
# picked $FILES, so a git-level delete is removed from every destination
# on the very next deploy of anything, incremental or not.
committed_files() { git ls-files src client | grep -E "$EXT_RE" || true; }
changed_files() {
    { git diff --name-only --diff-filter=d -- src client
      git diff --name-only --diff-filter=d --cached -- src client
      git ls-files --others --exclude-standard -- src client
    } | sort -u | grep -E "$EXT_RE" || true
}
# all_tracked_files - the mirror baseline: every tracked src/client path,
# ANY extension. Broader than committed_files() (EXT_RE only, the set
# this script actually copies) on purpose - a tracked file this script
# never deploys (a doc, a vendor font under client/vendor) is still
# legitimate at HEAD and must never be pruned as if it were a leftover
# from a git-level delete. Used only to decide what counts as stale, never
# to decide what to copy.
all_tracked_files() { git ls-files src client | LC_ALL=C sort; }

SELECTION=""
if [ "$VERIFY_ONLY" -eq 1 ] || [ "$ALL" -eq 1 ]; then
    FILES=$(committed_files); SELECTION="every tracked src/ and client/ file"
else
    FILES=$(changed_files)
    if [ -n "$FILES" ]; then
        SELECTION="uncommitted changes under src/ and client/"
    else
        FILES=$(committed_files)
        SELECTION="working tree is CLEAN, so deploying the committed state"
    fi
fi

echo "target : $LABEL"
echo "host   : $HOST"
for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
    echo "dest   : ${DEST_NAMES[$i]}"
    echo "         ${DESTS[$i]}"
done
echo "select : $SELECTION"

if [ -z "$FILES" ]; then
    say_nothing
    echo "no files under src/ or client/ matched ${EXT_RE}."
    echo "The target was NOT updated and is still running whatever it had."
    echo "Nothing was copied, nothing was restarted, nothing was verified."
    exit 2
fi

COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')
echo "files  : $COUNT"
if [ "$COUNT" -le 25 ]; then
    printf '%s\n' "$FILES" | sed 's/^/         /'
else
    printf '%s\n' "$FILES" | head -10 | sed 's/^/         /'
    echo "         ... and $(( COUNT - 10 )) more"
fi

# ------------------------------------------------- committed bundle check
# BEFORE THE TRANSFER, on every path that actually copies. See the header.
# --verify-only and --dry-run are exempt: neither writes a destination, so
# neither can ship a stale bundle, and refusing to re-hash a target
# because this Mac has no node would be answering a question nobody asked.
if [ "$VERIFY_ONLY" -eq 0 ] && [ "$DRY" -eq 0 ]; then
    if [ "${CLOUDE_DEPLOY_SKIP_WEB_CHECK:-0}" = "1" ]; then
        echo
        echo "web    : SKIPPED by CLOUDE_DEPLOY_SKIP_WEB_CHECK=1."
        echo "         The committed client/dist bundle is going out UNVERIFIED."
    else
        echo
        echo "web    : checking the committed client/dist bundle ..."
        set +e
        "$SCRIPT_DIR/web-build-check.sh"
        WRC=$?
        set -e
        if [ "$WRC" -eq 1 ]; then
            say_failed
            echo "The committed client/dist does not match web/src." >&2
            echo "Nothing was copied. Rebuild and commit the bundle first." >&2
            exit 1
        elif [ "$WRC" -ne 0 ]; then
            say_failed
            echo "CANNOT DETERMINE whether client/dist is current." >&2
            echo "Nothing was copied. Install node and npm, or set" >&2
            echo "CLOUDE_DEPLOY_SKIP_WEB_CHECK=1 to ship it unverified." >&2
            exit 3
        fi
    fi
fi

LIST=$(mktemp -t cloudedeploy)
LOCAL_SHA=$(mktemp -t cloudedeploy)
ALLTRACKED=$(mktemp -t cloudedeploy)
STAGE="/tmp/cloude-deploy-stage-$$-$(date +%s)"
# shellcheck disable=SC2329  # invoked indirectly, by the trap below
cleanup() { rm -f "$LIST" "$LOCAL_SHA" "$ALLTRACKED"; }
trap cleanup EXIT
printf '%s\n' "$FILES" > "$LIST"
dl_local_hashes "$LIST" "$LOCAL_SHA"
all_tracked_files > "$ALLTRACKED"

if [ "$DRY" -eq 1 ]; then
    echo
    echo "(dry run, nothing copied and nothing verified)"
    echo
    echo "mirror preview (read-only; nothing below is deleted by --dry-run):"
    for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
        echo "checking ${DEST_NAMES[$i]} for files not tracked at HEAD ..."
        dl_prune_stale "$HOST" "${DESTS[$i]}" "$ALLTRACKED" 1 || true
    done
    exit 0
fi

# ----------------------------------------------------------- verify only
# Re-check a target without touching it. This is the same code the deploy
# runs, which is the point: a verification path that is only exercised by
# a passing deploy has never been shown capable of failing.
if [ "$VERIFY_ONLY" -eq 1 ]; then
    echo
    RC=0
    for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
        echo "verifying ${DEST_NAMES[$i]} ..."
        set +e
        dl_verify "$HOST" "${DESTS[$i]}" "$LIST" "$LOCAL_SHA" "${DEST_NAMES[$i]}"
        V=$?
        dl_verify_no_extra "$HOST" "${DESTS[$i]}" "$ALLTRACKED" "${DEST_NAMES[$i]}"
        NX=$?
        set -e
        if [ "$V" -eq 0 ]; then echo "  OK: $COUNT/$COUNT files match this Mac."; fi
        if [ "$NX" -eq 0 ]; then echo "  OK: no untracked files under src/ or client/."; fi
        RC=$(dl_combine_rc "$RC" "$(dl_combine_rc "$V" "$NX")")
    done
    if [ "$RC" -ne 0 ]; then
        say_failed
        if [ "$RC" -eq 4 ]; then
            echo "VERIFICATION FAILED: the target's bytes don't match this Mac, or holds files not tracked at HEAD." >&2
        else
            echo "CANNOT DETERMINE: verification could not be evaluated for at least one destination." >&2
        fi
        exit "$RC"
    fi
    echo
    echo "== VERIFIED ==" ; echo "all destinations match this Mac, mirror-clean. Nothing was copied."
    exit 0
fi

# ------------------------------------------------------------------ stage
# Land everything in one staging dir and hash it BEFORE production is
# touched. A broken pipe or a corrupted transfer dies here, with the real
# destinations still holding the code that was working ten seconds ago.
echo
echo "staging $COUNT files on $HOST ..."
if ! dl_stage "$HOST" "$LIST" "$STAGE"; then
    dl_unstage "$HOST" "$STAGE"
    say_failed
    echo "TRANSFER FAILED before anything was written to a real destination." >&2
    echo "The target still runs the old code. Nothing was restarted." >&2
    exit 1
fi

set +e
dl_verify "$HOST" "$STAGE" "$LIST" "$LOCAL_SHA" "staging area"
V=$?
set -e
if [ "$V" -ne 0 ]; then
    dl_unstage "$HOST" "$STAGE"
    say_failed
    echo "THE STAGED COPY DOES NOT MATCH THIS MAC (code $V)." >&2
    echo "Nothing was written to a real destination. The target still runs the old code." >&2
    exit "$V"
fi
echo "staged and hash checked: $COUNT/$COUNT files match this Mac."

# ----------------------------------------------------------------- commit
for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
    echo "writing ${DEST_NAMES[$i]} ..."
    if ! dl_commit "$HOST" "$STAGE" "${DESTS[$i]}"; then
        dl_unstage "$HOST" "$STAGE"
        say_failed
        echo "COPY FAILED writing ${DEST_NAMES[$i]}:" >&2
        echo "  ${DESTS[$i]}" >&2
        if [ "$i" -gt 0 ]; then
            echo "PARTIAL DEPLOY: an earlier destination was already written." >&2
            echo "Re-run this script before restarting anything." >&2
        else
            echo "No destination was written. The target still runs the old code." >&2
        fi
        exit 1
    fi
done
dl_unstage "$HOST" "$STAGE"

# ------------------------------------------------------------------ prune
# ditto only ever added and overwrote. Mirror each destination against
# the FULL tracked set now, before anything is verified or restarted, so a
# file removed from git does not survive this deploy - Punchlist #23.
for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
    echo "pruning ${DEST_NAMES[$i]} (files not tracked at HEAD) ..."
    if ! dl_prune_stale "$HOST" "${DESTS[$i]}" "$ALLTRACKED" 0; then
        say_failed
        echo "PRUNE FAILED at ${DEST_NAMES[$i]}:" >&2
        echo "  ${DESTS[$i]}" >&2
        echo "The new/changed files were copied but a stale file could not be removed." >&2
        exit 1
    fi
done

# ----------------------------------------------------------------- verify
# The independent measurement, both directions. Every tracked file, every
# destination, compared by content against this Mac (dl_verify) - AND a
# check that nothing untracked remains (dl_verify_no_extra), because a
# verification that only hashes files that should be present can never
# catch one that should not be. `git rev-parse` on either side would only
# read back the claim this script already believes.
echo
RC=0
for i in $(seq 0 $(( ${#DESTS[@]} - 1 ))); do
    echo "verifying ${DEST_NAMES[$i]} ..."
    set +e
    dl_verify "$HOST" "${DESTS[$i]}" "$LIST" "$LOCAL_SHA" "${DEST_NAMES[$i]}"
    V=$?
    dl_verify_no_extra "$HOST" "${DESTS[$i]}" "$ALLTRACKED" "${DEST_NAMES[$i]}"
    NX=$?
    set -e
    if [ "$V" -eq 0 ]; then echo "  OK: $COUNT/$COUNT files match this Mac."; fi
    if [ "$NX" -eq 0 ]; then echo "  OK: no untracked files under src/ or client/."; fi
    RC=$(dl_combine_rc "$RC" "$(dl_combine_rc "$V" "$NX")")
done
if [ "$RC" -ne 0 ]; then
    say_failed
    echo "The files were copied but do NOT match this Mac, or a stale file remains. Nothing was restarted." >&2
    exit "$RC"
fi

if [ "$RESTART" -eq 0 ]; then
    say_deployed
    echo "$COUNT files verified on ${#DESTS[@]} destination(s)."
    echo "(--no-restart: the target is still RUNNING the old code.)"
    exit 0
fi

# ---------------------------------------------------------------- restart
# The live server is supervised by the Electron app, which restarts it on
# its own; v1.1 is bare and must be relaunched here.
#
# RECORD WHO HOLDS THE PORT FIRST. Everything the check after the restart
# can prove rests on knowing which pids were there before it, so this
# reading is taken before anything is killed and a failure to take it
# aborts the restart rather than proceeding blind. A restart whose
# starting state is unknown cannot be verified afterwards, and "verified"
# is the only reason this script exists.
echo
echo "reading :$PORT before the restart ..."
if ! BEFORE=$(dl_capture_listeners "$HOST" "$PORT"); then
    say_failed
    echo "CANNOT DETERMINE: could not read who holds :$PORT on $HOST." >&2
    echo "Nothing was restarted. The files are deployed and the old code is still running." >&2
    exit 3
fi
RESTART_T0="${BEFORE%% *}"
OLD_PIDS="${BEFORE#* }"
[ "$OLD_PIDS" = "$BEFORE" ] && OLD_PIDS=""
echo "  holder(s): ${OLD_PIDS:-none}"

if [ "$TARGET" = "live" ]; then
    # Kill by the pid that OWNS THE PORT, not by a name match. A bare
    # `pgrep -f src.main | head -1` matches the v1.1 server too and picks
    # whichever pid sorts first, so it could stop the wrong install.
    #
    # EVERY holder, not `head -1`. A port can be held by more than one
    # process (a leaked old one, or separate v4 and v6 sockets), and
    # killing the first one lsof happens to print leaves the others
    # serving - after which the check below would correctly refuse, but
    # only after a pointless wait. `head -1` was masking that case.
    #
    # The status is NOT swallowed with `|| true`. An ssh that failed means
    # nothing was killed, and that used to be indistinguishable from a
    # clean kill.
    # shellcheck disable=SC2029  # $PORT is ours and must expand here
    if ! ssh "$HOST" "P=\$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | sort -u); [ -z \"\$P\" ] || kill \$P"; then
        say_failed
        echo "RESTART FAILED: could not signal the process holding :$PORT on $HOST." >&2
        echo "The files are deployed. The old code is still running." >&2
        exit 1
    fi
else
    # shellcheck disable=SC2029  # $DEST_SERVER is ours and must expand here
    if ! ssh "$HOST" "pkill -f 'CloudeCode-v1.1.*src.main' || true; sleep 2; cd '$DEST_SERVER' && nohup ./venv/bin/python3 -m src.main > /tmp/v11-server.log 2>&1 & sleep 1"; then
        say_failed
        echo "RESTART FAILED: could not relaunch the v1.1 server on $HOST." >&2
        echo "check: ssh $HOST 'tail -20 /tmp/v11-server.log'" >&2
        exit 1
    fi
fi

# THE UP CHECK. See scripts/deploy-restart-check.sh for what each leg
# measures and why. What matters here is that it can no longer pass
# against the process this script just killed, it can no longer count a
# 401 or a proxy's 502 as "up", and an expired budget returns a failure
# rather than falling out of a loop into the success path below.
echo
# NOT `if ! dl_confirm_restart ...`. Inside the body of an `if !`, `$?` is
# the status of the NEGATION, which is 0, so capturing it there would have
# made every failure of this check exit 0 - the very defect this change
# exists to remove. Capture first, branch second.
set +e
dl_confirm_restart "$HOST" "$HEALTH_HOST" "$PORT" "$DEST_SERVER" "$RESTART_T0" "$OLD_PIDS"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
    say_failed
    if [ "$RC" -eq 3 ]; then
        echo "CANNOT DETERMINE: the restart could not be verified on :$PORT." >&2
        echo "That is NOT the same as a failed restart, and NOT a pass. Check by hand." >&2
    else
        echo "THE RESTART DID NOT PRODUCE A VERIFIED SERVER on :$PORT." >&2
        echo "The files are verified on disk but nothing provable is serving them." >&2
    fi
    [ "$TARGET" = "v11" ] && echo "check: ssh $HOST 'tail -20 /tmp/v11-server.log'" >&2
    exit "$RC"
fi

# DID THE DEPLOY SURVIVE THE RESTART? "The port came back" does not
# answer "the new code is what came back". A packaged install re-copies
# its bundle over the server dir on start (bootstrap.js syncBundledAssets,
# rsync -a --delete for src/ and client/), so re-hash the SERVER DIR,
# every file, after the restart rather than trusting the check above -
# and re-run the negative check too, in case that resync ever changes
# shape and stops mirroring the bundle's own leftovers away.
echo "re-verifying the server dir after the restart ..."
set +e
dl_verify "$HOST" "$DEST_SERVER" "$LIST" "$LOCAL_SHA" "server dir (post restart)"
V=$?
dl_verify_no_extra "$HOST" "$DEST_SERVER" "$ALLTRACKED" "server dir (post restart)"
NX=$?
set -e
RC=$(dl_combine_rc "$V" "$NX")
if [ "$RC" -ne 0 ]; then
    say_failed
    echo "REVERTED: the server dir no longer matches what was deployed, or holds a stale file again (code $RC)." >&2
    echo "The app restored it from its bundle. Check the bundle destination." >&2
    exit "$RC"
fi

say_deployed
echo "$COUNT files verified on ${#DESTS[@]} destination(s), server answering on :$PORT,"
echo "and still matching this Mac after the restart."
exit 0
