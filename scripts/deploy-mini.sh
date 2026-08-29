#!/bin/bash
# deploy-mini.sh - push working-tree code from this Mac to the mini.
#
# WHY THIS EXISTS. Neither install on the mini is a git checkout: the live
# one is a copied server dir inside the app bundle's support folder, and
# v1.1 is a clone that is NOT kept in sync by pulling (you develop here,
# not there). So "deploy" means copying the files you changed and
# restarting the right server - which was being done by hand, one scp at a
# time, all through the session this script came out of.
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
# Usage:
#   ./scripts/deploy-mini.sh                 # changed files -> v1.1, restart
#   ./scripts/deploy-mini.sh --target live   # -> the live install
#   ./scripts/deploy-mini.sh --all           # every tracked src/client file
#   ./scripts/deploy-mini.sh --no-restart    # copy only
#   ./scripts/deploy-mini.sh --dry-run       # print what would go
#
# Exit codes: 0 ok, 1 copy or restart failed, 2 nothing to deploy.
set -euo pipefail

HOST="mac-mini-m4"
TARGET="v11"
RESTART=1
ALL=0
DRY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --target)     TARGET="$2"; shift 2 ;;
        --all)        ALL=1; shift ;;
        --no-restart) RESTART=0; shift ;;
        --dry-run)    DRY=1; shift ;;
        -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

case "$TARGET" in
    live) REMOTE="/Users/jsugamele/Library/Application Support/cloude-code-menubar/server"
          # THE SECOND TARGET IS NOT OPTIONAL. The packaged app treats
          # Resources/src inside the bundle as authoritative and copies it
          # over the server dir on every start, so a deploy that lands ONLY
          # in the server dir is reverted by the next restart - including
          # the restart this script issues. Measured 2026-08-29: file
          # correct before kickstart, original hash after it, three times.
          # Deploy to both, then verify the file SURVIVED the restart.
          BUNDLE="/Applications/Cloude Code.app/Contents/Resources"
          PORT=8000; LABEL="LIVE (the app you use)" ;;
    v11)  REMOTE="/Users/jsugamele/CloudeCode-v1.1"
          BUNDLE=""
          PORT=8001; LABEL="v1.1 (disposable)" ;;
    *) echo "unknown target: $TARGET (want: live | v11)" >&2; exit 64 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# WHAT TO COPY. Uncommitted changes by default, because that is what you
# are iterating on; --all for a fresh clone or when you have lost track.
# Deleted files are excluded - this copies, it does not remove, and a
# delete needs a human looking at it.
if [ "$ALL" -eq 1 ]; then
    FILES=$(git ls-files src client | grep -E '\.(py|js|css|html|json)$' || true)
else
    FILES=$( { git diff --name-only --diff-filter=d -- src client
               git diff --name-only --diff-filter=d --cached -- src client
               git ls-files --others --exclude-standard -- src client
             } | sort -u | grep -E '\.(py|js|css|html)$' || true )
fi

if [ -z "$FILES" ]; then
    echo "nothing to deploy (no changed files under src/ or client/)"
    exit 2
fi

COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
echo "target : $LABEL"
echo "         $HOST:$REMOTE"
echo "files  : $COUNT"
echo "$FILES" | sed 's/^/         /'

if [ "$DRY" -eq 1 ]; then
    echo
    echo "(dry run - nothing copied)"
    exit 0
fi

# One rsync, not N scps: it makes the directories it needs and reports a
# partial failure instead of leaving half a deploy behind.
echo
echo "$FILES" | rsync -a --files-from=- --relative . "$HOST:$REMOTE/" \
    || { echo "COPY FAILED - nothing restarted, the target still runs the old code" >&2; exit 1; }

# The bundle copy, for a packaged install. See the BUNDLE comment above:
# without this the next app start reverts everything just copied.
if [ -n "${BUNDLE:-}" ]; then
    echo "$FILES" | rsync -a --files-from=- --relative . "$HOST:$BUNDLE/" \
        || { echo "BUNDLE COPY FAILED - the server dir was updated but the app will revert it on restart" >&2; exit 1; }
fi
echo "copied."

[ "$RESTART" -eq 0 ] && { echo "(--no-restart: the target is still running the OLD code)"; exit 0; }

# The live server is supervised by the Electron app, which restarts it on
# its own; v1.1 is bare and must be relaunched here.
if [ "$TARGET" = "live" ]; then
    # Kill by the pid that OWNS THE PORT, not by a name match. A bare
    # `pgrep -f src.main | head -1` matches the v1.1 server too and picks
    # whichever pid sorts first, so it could stop the wrong install.
    ssh "$HOST" "P=\$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1); [ -n \"\$P\" ] && kill \"\$P\"" || true
else
    ssh "$HOST" "pkill -f 'CloudeCode-v1.1.*src.main' || true; sleep 2; cd '$REMOTE' && nohup ./venv/bin/python3 -m src.main > /tmp/v11-server.log 2>&1 & sleep 1" || true
fi

# VERIFY IT CAME BACK. A deploy that ends at "restart issued" has not been
# checked - the whole point is the new code answering, not the old one
# having been killed.
printf "waiting for :%s " "$PORT"
for _ in $(seq 1 30); do
    if curl -s -o /dev/null --max-time 2 "http://10.0.1.150:$PORT/" 2>/dev/null; then
        echo "- up"
        # DID THE DEPLOY SURVIVE THE RESTART? Answering "the port came
        # back" is not answering "the new code is what came back". For a
        # packaged install the app re-copies its bundle over the server
        # dir on start, so this compares content on BOTH sides rather
        # than trusting that the copy earlier in this script still holds.
        FIRST=$(echo "$FILES" | head -1)
        LOCAL_H=$(shasum -a256 "$FIRST" | cut -d" " -f1)
        REMOTE_H=$(ssh "$HOST" "shasum -a256 '$REMOTE/$FIRST' 2>/dev/null" | cut -d" " -f1)
        if [ -z "$REMOTE_H" ]; then
            echo "CANNOT DETERMINE: could not hash $FIRST on the target." >&2
            exit 3
        elif [ "$LOCAL_H" != "$REMOTE_H" ]; then
            echo "REVERTED: $FIRST on the target does not match what was sent." >&2
            echo "  the app restored it from its bundle - deploy to \$BUNDLE too." >&2
            exit 4
        fi
        echo "verified: $FIRST matches after restart"
        exit 0
    fi
    printf "."
    sleep 2
done
echo
echo "TIMED OUT: :$PORT did not answer after the restart." >&2
[ "$TARGET" = "v11" ] && echo "check: ssh $HOST 'tail -20 /tmp/v11-server.log'" >&2
exit 1
