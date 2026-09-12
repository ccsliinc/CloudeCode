#!/bin/bash
# test_deploy_restart_check.sh - drive the post-restart up-check against
# real listening processes and prove it refuses the two situations that
# fooled its predecessor on 2026-09-11.
#
# HOW THIS TEST IS BUILT, because the shape is the point. Every fixture is
# run through BOTH checks:
#
#   the OLD check, reproduced inline (`old_up_check` below) exactly as it
#   was - curl with no --fail, aimed at `/` - and asserted to PASS; and
#   the NEW check (`dl_confirm_restart`), asserted to FAIL.
#
# The old-check assertion is not decoration, it is the fixture's own
# negative control. If a fixture stopped reproducing the fooling
# condition, the old check would start failing on it and this file would
# say so, instead of quietly proving that the new check rejects something
# nothing was ever fooled by. Reproducing the pre-fix behaviour inline
# also means this file goes red if the old loop is ever restored.
#
# THE POSITIVE CONTROL IS MANDATORY (scenario 7). A check that refused
# everything would score a perfect six out of six on the negatives and be
# completely useless, so one fixture is a genuinely fresh, correct server
# that MUST be accepted.
#
# No ssh is opened: every remote read goes through dl_run_on, and the
# sentinel host "__local__" runs the same code against this machine.
# Ports start at 5055; 5000 is AirPlay and is never used.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Budgets are set BEFORE sourcing, so this also exercises the env plumbing
# rather than reaching past it and assigning the DL_* variables directly.
export CLOUDE_DEPLOY_OLD_GONE_TIMEOUT=6
export CLOUDE_DEPLOY_NEW_LISTENER_TIMEOUT=6
export CLOUDE_DEPLOY_HEALTH_TIMEOUT=5
export CLOUDE_DEPLOY_POLL_INTERVAL=1

# shellcheck source=scripts/deploy-lib.sh
. "$ROOT/scripts/deploy-lib.sh"
# shellcheck source=scripts/deploy-restart-check.sh
. "$ROOT/scripts/deploy-restart-check.sh"

WORK="$(mktemp -d -t cloudeupcheck)"
PASS=0
FAIL=0
SERVERS=""

# Deliberately NOT deleted on exit. The fixtures are small, and a test
# that tears its evidence down is a test you cannot look at after it
# fails. The path is printed at the end.
cleanup() {
    local p
    for p in $SERVERS; do kill "$p" 2>/dev/null; done
}
trap cleanup EXIT

cat > "$WORK/fakeserver.py" <<'PY'
"""Stand in for the app on a port: answers / like the real one does (200,
unauthenticated) and /api/v1/health with a configurable status and version.

Inputs (argv): port, health status code, version string.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, CODE, VER = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/api/v1/health":
            body = json.dumps(
                {"status": "running", "uptime": 0, "version": VER}
            ).encode()
            code = CODE
        else:
            # The real app answers / with 200 to anyone. That is what the
            # old check was measuring, and why it measured nothing.
            body, code = b"ok", 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
PY

# start_server - launch a fake server and wait until it actually listens.
# Inputs: $1 port, $2 health status code, $3 version, $4 working directory
# Output: prints the pid. Waiting for the listener matters: a Popen that
#         has returned is not a process that has bound a socket, and a
#         test that times anything against an unbound port measures its
#         own startup race.
start_server() {
    local port="$1" code="$2" ver="$3" dir="$4" pid _
    mkdir -p "$dir"
    ( cd "$dir" && exec python3 "$WORK/fakeserver.py" "$port" "$code" "$ver" ) &
    pid=$!
    SERVERS="$SERVERS $pid"
    for _ in $(seq 1 50); do
        if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
            echo "$pid"; return 0
        fi
        sleep 0.2
    done
    echo "FATAL: server on :$port never came up" >&2
    exit 1
}

# listener_pid - the pid actually holding a port, which is what the check
# reads. It is not always the shell's $! (a subshell may sit between).
listener_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' '; }

# dead_pid - a pid that has certainly exited, for use as a prior holder.
dead_pid() { local p; sleep 0.1 & p=$!; wait "$p" 2>/dev/null; echo "$p"; }

# old_up_check - THE PRE-FIX CHECK, reproduced verbatim in substance:
# curl with no --fail, aimed at /, success on any completed HTTP
# transaction. The loop is shortened; its length was never the defect.
old_up_check() {
    local host="$1" port="$2" _
    for _ in $(seq 1 3); do
        if curl -s -o /dev/null --max-time 2 "http://$host:$port/" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL - $1" >&2; }

# assert_old_fooled - the fixture's negative control.
assert_old_fooled() {
    if old_up_check 127.0.0.1 "$1"; then
        ok "the OLD check says up (fixture reproduces the defect)"
    else
        bad "the OLD check did NOT pass, so this fixture does not reproduce what fooled it"
    fi
}

# assert_new_refuses - the fix.
assert_new_refuses() {
    local out="$1" rc="$2" want="$3"
    if [ "$rc" -eq 0 ]; then
        bad "the NEW check PASSED and must not have (rc 0)"
        return
    fi
    ok "the NEW check refuses (rc $rc)"
    if printf '%s' "$out" | grep -q "$want"; then
        ok "and says why: $want"
    else
        bad "refused, but not for the measured reason; wanted '$want' in:
$out"
    fi
}

run_new() {
    local dir="$1" t0="$2" oldpids="$3" port="$4" out rc
    out=$(dl_confirm_restart __local__ 127.0.0.1 "$port" "$dir" "$t0" "$oldpids" 2>&1)
    rc=$?
    printf '%s\n__RC__%s\n' "$out" "$rc"
}

split_rc() { printf '%s' "$1" | sed -n 's/^__RC__//p' | sed -n '1p'; }
split_out() { printf '%s' "$1" | sed '/^__RC__/d'; }

# ---------------------------------------------------------------- unit
echo "dl_etime_seconds (the three formats macOS ps actually emits)"
[ "$(dl_etime_seconds '00:07')" = "7" ] && ok "mm:ss" || bad "mm:ss"
[ "$(dl_etime_seconds '14:01:19')" = "50479" ] && ok "hh:mm:ss" || bad "hh:mm:ss"
[ "$(dl_etime_seconds '14-07:52:26')" = "1237946" ] && ok "dd-hh:mm:ss" || bad "dd-hh:mm:ss"
# 08 and 09 are invalid octal. Without an explicit base this returns a
# failure for eight seconds in every minute, which is exactly the kind of
# intermittent that gets written off as flakiness.
[ "$(dl_etime_seconds '00:08')" = "8" ] && ok "08 is not parsed as octal" || bad "08 parsed as octal"
if dl_etime_seconds '' >/dev/null 2>&1; then bad "empty etime must not parse"; else ok "empty etime refuses"; fi
if dl_etime_seconds 'garbage' >/dev/null 2>&1; then bad "garbage must not parse"; else ok "garbage refuses"; fi

# ------------------------------------------------- 1: the dying old server
# FAILURE 1, 2026-09-11: the check polled milliseconds after SIGTERM and
# got its 200 from the outgoing process. Here the prior holder is still
# the listener, which is that moment frozen.
echo
echo "1. the process we killed is still the one answering"
D1="$WORK/dest1"; P1=5055
start_server "$P1" 200 "1.4.0" "$D1" >/dev/null
printf '1.4.0\n' > "$D1/VERSION"
OLD1="$(listener_pid "$P1")"
assert_old_fooled "$P1"
R=$(run_new "$D1" "$(date +%s)" "$OLD1" "$P1")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "OLD PROCESS STILL ALIVE"

# ------------------------------------------------------ 2: nothing at all
# FAILURE 2, 2026-09-11: "up" with nothing listening. Note the old loop
# does NOT pass here, so this fixture carries no old-check control; what
# it proves is the other half of that report - that an exhausted budget
# is a failure and cannot fall through to the success path.
echo
echo "2. nothing is listening at all"
D2="$WORK/dest2"; P2=5056
mkdir -p "$D2"; printf '1.4.0\n' > "$D2/VERSION"
if old_up_check 127.0.0.1 "$P2"; then
    bad "something is listening on :$P2; this fixture is invalid"
else
    ok "confirmed nothing is on :$P2"
fi
R=$(run_new "$D2" "$(date +%s)" "$(dead_pid)" "$P2")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "TIMED OUT"
printf '%s' "$(split_out "$R")" | grep -q "A timeout is a FAILURE" \
    && ok "an exhausted budget is named as a failure" \
    || bad "an exhausted budget did not announce itself as a failure"

# ------------------------------------------------------- 3: a stale squatter
# A different pid from the old one, so leg A is satisfied, but the
# process predates the restart. Its age is read from real ps; nothing is
# faked.
echo
echo "3. a process older than the restart holds the port"
D3="$WORK/dest3"; P3=5057
start_server "$P3" 200 "1.4.0" "$D3" >/dev/null
printf '1.4.0\n' > "$D3/VERSION"
echo "  (waiting 8s so the process is measurably older than the restart)"
sleep 8
assert_old_fooled "$P3"
R=$(run_new "$D3" "$(date +%s)" "$(dead_pid)" "$P3")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "STALE PROCESS"

# ------------------------------------------------- 4: answers, but not 2xx
# The old check counted ANY completed HTTP transaction. / is 200 to
# anyone, so a server whose real endpoint is refusing still read as up.
echo
echo "4. / says 200 but /api/v1/health says 401"
D4="$WORK/dest4"; P4=5058
start_server "$P4" 401 "1.4.0" "$D4" >/dev/null
printf '1.4.0\n' > "$D4/VERSION"
assert_old_fooled "$P4"
R=$(run_new "$D4" "$(date +%s)" "$(dead_pid)" "$P4")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "NO USABLE ANSWER"

# ------------------------------------------------------ 5: the wrong tree
echo
echo "5. the process is running out of a directory this deploy did not write"
D5="$WORK/dest5"; E5="$WORK/elsewhere5"; P5=5059
start_server "$P5" 200 "1.4.0" "$E5" >/dev/null
mkdir -p "$D5"; printf '1.4.0\n' > "$D5/VERSION"
assert_old_fooled "$P5"
R=$(run_new "$D5" "$(date +%s)" "$(dead_pid)" "$P5")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "WRONG DIRECTORY"

# ------------------------------------------------------ 6: the wrong build
echo
echo "6. the server reports a different build than the deployed tree"
D6="$WORK/dest6"; P6=5060
start_server "$P6" 200 "1.0.2" "$D6" >/dev/null
printf '1.4.0\n' > "$D6/VERSION"
assert_old_fooled "$P6"
R=$(run_new "$D6" "$(date +%s)" "$(dead_pid)" "$P6")
assert_new_refuses "$(split_out "$R")" "$(split_rc "$R")" "WRONG BUILD"

# -------------------------------------------- 7: THE POSITIVE CONTROL
# Without this, a check that refused everything would pass all six above.
echo
echo "7. positive control: a genuinely fresh, correct server is ACCEPTED"
D7="$WORK/dest7"; P7=5061
printf '1.4.0\n' > "$WORK/dest7_VERSION_placeholder"
T7="$(date +%s)"
start_server "$P7" 200 "1.4.0" "$D7" >/dev/null
printf '1.4.0\n' > "$D7/VERSION"
R=$(run_new "$D7" "$T7" "$(dead_pid)" "$P7")
if [ "$(split_rc "$R")" -eq 0 ]; then
    ok "a correct restart is accepted (rc 0)"
else
    bad "the check refused a correct restart, so every refusal above is worthless:
$(split_out "$R")"
fi

echo
echo "fixtures left in place at: $WORK"
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "== ALL GREEN =="
