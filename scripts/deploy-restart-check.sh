#!/bin/bash
# deploy-restart-check.sh - prove that the process now answering on a port
# is the one this deploy started, and not the one it just killed.
#
# WHY THIS FILE EXISTS. The check it replaces was:
#
#     for _ in $(seq 1 30); do
#         if curl -s -o /dev/null --max-time 2 "http://$HOST:$PORT/"; then
#             UP=1; echo "- up"; break
#         fi
#         sleep 2
#     done
#
# and it reported success while measuring nothing. Two observed failures,
# 2026-09-11, both caught by a human checking the listener separately:
#
#   1. It passed against the DYING OLD PROCESS. `kill` sends SIGTERM and
#      returns immediately; the loop's FIRST probe runs before any sleep,
#      so it landed milliseconds later while the outgoing uvicorn was
#      still draining. curl got its 200 and the script exited 0 before the
#      new process had bound anything. This one is visible in the code:
#      there is no delay at all between the kill and the first probe.
#   2. It reported up while nothing was listening. Note that the loop
#      itself DOES distinguish exhaustion (UP stays 0 and the script
#      exits 1), so a fall-through was not the mechanism. What fits is
#      that curl carried no `--fail`, so ANY completed HTTP transaction
#      counted - a 401, a 404, a proxy's 502 - and `/` on this app answers
#      200 unauthenticated to anything that can speak HTTP on that port.
#
# THE RULE THIS ENCODES: a port being open proves nothing about whose it
# is, and an HTTP 200 proves nothing about which build produced it.
# Identity has to be measured, and every measurement that did not happen
# has to be a refusal rather than a pass.
#
# WHAT IS MEASURED, in order, each with its own refusal:
#
#   A. The OLD listener pids, recorded BEFORE the kill, are GONE. Not
#      "not answering" - absent from the process table (a zombie counts
#      as gone; its parent has simply not reaped it yet).
#   B. A NEW pid holds the listener, and its pid is not in the old set.
#   C. THAT PROCESS IS YOUNGER THAN THE RESTART. Its `ps -o etime` is
#      less than the seconds elapsed on the REMOTE clock since the kill
#      was issued. This is the crux and the only leg that is always
#      decisive: it defeats the dying-old-process pass, it defeats pid
#      reuse, and unlike a version string it does not need anything about
#      the build to have changed. All three readings come from the same
#      machine's clock, so there is no skew to correct for.
#   D. Its working directory is the destination this deploy wrote and
#      hash-verified minutes earlier. Both sides are resolved with
#      `pwd -P` first, because this project has been bitten repeatedly by
#      one directory having two spellings.
#   E. The server answers GET /api/v1/health with a 2xx. `curl --fail`,
#      so a 401/404/502 is a failure and not a pass. That endpoint is
#      unauthenticated by design (see the docstring on health_endpoint in
#      src/api/routes.py) and reports `startup_version()`, which is
#      FROZEN AT PROCESS START.
#   F. The listener pid is unchanged across that request, so the answer
#      is attributable to the pid measured in B-D rather than to whatever
#      happened to hold the port at the instant curl connected.
#
# WHAT THE VERSION STRING CAN AND CANNOT DO. It is REFUTATION ONLY, and
# saying otherwise would be the exact error this file exists to stop.
# deploy-mini.sh copies src/ and client/; the VERSION file sits at the
# source root and is NOT in either, so an ordinary deploy through this
# script does not change the number. Old and new therefore report the
# SAME string in the normal case and a match proves nothing about which
# process answered. A MISMATCH against the deployed tree's VERSION file
# is still worth failing on - it is how the 2026-08-25 incident in
# routes.py would have been caught, where an orphaned v1.0.2 server was
# adopted by a v1.0.3 bundle and served old code for four hours. So:
# mismatch is a hard failure, match is corroboration, and an unreadable
# VERSION file is reported out loud and does not fail on its own, because
# legs A-F have already established identity without it.
#
# `uptime` from that same endpoint is deliberately NOT used. It reads
# "we don't track server start time, so use session uptime as proxy" in
# routes.py and is 0 whenever no session is active. It looks like a
# process age and is not one.
#
# TESTABILITY. Every remote read goes through dl_run_on (deploy-lib.sh),
# so passing the sentinel host "__local__" runs the same code against the
# local machine. That is what tests/test_deploy_restart_check.sh uses to
# drive both failure scenarios against a real throwaway HTTP server
# without opening an ssh connection.

# --------------------------------------------------------------- budgets
# THREE PHASES, THREE BOUNDS, because each expiry means something
# different and deserves its own message. All are seconds and all are
# overridable, so a slow box is a config change rather than a patch.
#
# Justification, not a round number. Normal startup is about 2s since the
# boot integrity gate landed. The worst LEGITIMATE case is that gate
# refusing its cached verdict and running PRAGMA integrity_check over the
# live database, which is MEASURED at 5.1 GB on the target box today. The
# same pragma is recorded at about 14.5s p99 on that file with a warm
# cache; cold it has to read every page off disk, and at an effective
# 30-60 MB/s that is 85-170s on its own, before python import time and
# Electron's own supervision delay. 300s covers that with margin.
#
# The asymmetry is deliberate. Being generous costs only a slower red.
# Being tight costs a FALSE red on a legitimately slow cold boot, and a
# false red on a live box invites a human to start re-deploying or
# killing processes underneath 19 running sessions, which is far worse
# than waiting. Every phase prints progress so a human can tell waiting
# from hung.
DL_OLD_GONE_TIMEOUT="${CLOUDE_DEPLOY_OLD_GONE_TIMEOUT:-60}"
DL_NEW_LISTENER_TIMEOUT="${CLOUDE_DEPLOY_NEW_LISTENER_TIMEOUT:-300}"
DL_HEALTH_TIMEOUT="${CLOUDE_DEPLOY_HEALTH_TIMEOUT:-30}"
DL_POLL_INTERVAL="${CLOUDE_DEPLOY_POLL_INTERVAL:-3}"

# Tolerance on leg C. The restart epoch is read on the remote box before
# the kill and the age is read on the same box after, so this absorbs
# rounding in `ps -o etime` (whole seconds) and nothing else. It is NOT a
# grace period for an old process: at 5s a server that has been up for
# minutes still fails loudly.
DL_AGE_SLACK_SECONDS="${CLOUDE_DEPLOY_AGE_SLACK:-5}"

# dl_etime_seconds - convert a BSD `ps -o etime` field to whole seconds.
# Inputs:  $1 etime string, one of "mm:ss", "hh:mm:ss" or "dd-hh:mm:ss"
#          (all three are emitted by macOS ps; measured on the target).
# Output:  prints the elapsed seconds; returns 0. Prints nothing and
#          returns 1 for an empty or unparseable field, so a caller can
#          tell "could not read an age" from "age is zero". A process that
#          started this second legitimately reports 00:00.
# Example: dl_etime_seconds "14-07:52:26"   ->  1238546
dl_etime_seconds() {
    local raw="$1" days=0 rest hh=0 mm ss
    raw="${raw// /}"
    [ -n "$raw" ] || return 1
    case "$raw" in
        *-*) days="${raw%%-*}"; rest="${raw#*-}" ;;
        *)   rest="$raw" ;;
    esac
    case "$rest" in
        *:*:*) hh="${rest%%:*}"; rest="${rest#*:}"; mm="${rest%%:*}"; ss="${rest##*:}" ;;
        *:*)   mm="${rest%%:*}"; ss="${rest##*:}" ;;
        *)     return 1 ;;
    esac
    case "$days$hh$mm$ss" in
        ''|*[!0-9]*) return 1 ;;
    esac
    # 10# forces base 10; "08" and "09" are otherwise invalid octal and
    # would make this function fail for eight seconds out of every sixty.
    echo $(( 10#$days * 86400 + 10#$hh * 3600 + 10#$mm * 60 + 10#$ss ))
}

# dl_probe_port - one round trip reporting everything known about a port.
# Inputs:  $1 host ("__local__" or an ssh destination), $2 port,
#          $3 destination dir to resolve (may be empty),
#          $4 space separated old pids to report liveness for (may be empty)
# Output:  prints a line-oriented block on stdout and returns 0:
#            NOW <remote epoch seconds>
#            PIDS <space separated listener pids, possibly none>
#            AGE <pid> <etime field>
#            CWD <pid> <resolved working directory>
#            OLD <pid> GONE | OLD <pid> ALIVE <state>
#            DESTREAL <resolved destination dir>
#            __OK__
#          The trailing __OK__ is the point: without it the remote script
#          did not run to completion, and the caller MUST read that as
#          "could not determine" rather than as "nothing is listening".
#          An ssh that dies and an empty port look identical otherwise,
#          and that is precisely how a check comes to measure nothing.
dl_probe_port() {
    local host="$1" port="$2" dest="$3" oldpids="$4"
    # shellcheck disable=SC2016  # deliberately single-quoted: $PORT, $DEST
    # and $p below are the REMOTE shell's variables, read from piped stdin.
    printf '%s\n%s\n%s\n' "$port" "$dest" "$oldpids" | dl_run_on "$host" '
        IFS= read -r PORT
        IFS= read -r DEST
        IFS= read -r OLDPIDS
        echo "NOW $(date +%s)"
        PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr "\n" " ")
        echo "PIDS $PIDS"
        for p in $PIDS; do
            ET=$(ps -p "$p" -o etime= 2>/dev/null)
            [ -n "$ET" ] && echo "AGE $p $ET"
            CW=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p" | sed -n "1p")
            if [ -n "$CW" ]; then
                RP=$(cd "$CW" 2>/dev/null && pwd -P) || RP="$CW"
                echo "CWD $p $RP"
            fi
        done
        for p in $OLDPIDS; do
            ST=$(ps -p "$p" -o state= 2>/dev/null | tr -d " ")
            case "$ST" in
                "")  echo "OLD $p GONE" ;;
                Z*)  echo "OLD $p GONE" ;;
                *)   echo "OLD $p ALIVE $ST" ;;
            esac
        done
        if [ -n "$DEST" ]; then
            DRP=$(cd "$DEST" 2>/dev/null && pwd -P) || DRP="$DEST"
            echo "DESTREAL $DRP"
        fi
        echo "__OK__"
    ' 2>/dev/null
    return 0
}

# dl_probe_ok - did a dl_probe_port block run to completion?
# Inputs:  $1 the captured block
# Output:  returns 0 when the block carries its __OK__ sentinel, 1 otherwise.
dl_probe_ok() { printf '%s\n' "$1" | grep -q '^__OK__$'; }

# dl_probe_field - pull one field out of a dl_probe_port block.
# Inputs:  $1 block, $2 key (NOW, PIDS, DESTREAL)
# Output:  prints the remainder of the first matching line, or nothing.
dl_probe_field() {
    printf '%s\n' "$1" | sed -n "s/^$2 //p" | sed -n '1p'
}

# dl_probe_pid_attr - pull a per-pid attribute out of a block.
# Inputs:  $1 block, $2 key (AGE or CWD), $3 pid
# Output:  prints the value, or nothing when it was not reported.
dl_probe_pid_attr() {
    printf '%s\n' "$1" | sed -n "s/^$2 $3 //p" | sed -n '1p'
}

# dl_pids_still_alive - which of a set of pids does a block report ALIVE?
# Inputs:  $1 block
# Output:  prints the still-living pids, space separated; empty when all gone.
dl_pids_still_alive() {
    printf '%s\n' "$1" | awk '$1 == "OLD" && $3 == "ALIVE" { printf "%s ", $2 }'
}

# dl_new_listener_pid - the first listener pid in a block that is NOT in
# a given old set.
# Inputs:  $1 block, $2 space separated old pids
# Output:  prints one pid, or nothing when every listener is an old one
#          (or there is no listener at all).
dl_new_listener_pid() {
    local block="$1" old=" $2 " pids p
    pids=$(dl_probe_field "$block" PIDS)
    for p in $pids; do
        case "$old" in
            *" $p "*) continue ;;
            *) echo "$p"; return 0 ;;
        esac
    done
    return 0
}

# dl_health_json - GET /api/v1/health and report the status code with it.
# Inputs:  $1 health host, $2 port, $3 max seconds
# Output:  prints "<http_code> <body>" on one line and returns curl's own
#          exit status. --fail is what makes a 401/404/502 a failure
#          instead of the pass the old check counted it as. stderr is NOT
#          redirected to /dev/null: the reason a probe failed is the whole
#          value of the probe, and hiding it is how the original incident
#          became undiagnosable from the transcript.
dl_health_json() {
    local host="$1" port="$2" maxt="$3" out rc
    out=$(curl -fsS --max-time "$maxt" \
        -w '\n__CODE__%{http_code}' \
        "http://$host:$port/api/v1/health" 2>&1)
    rc=$?
    printf '%s %s\n' \
        "$(printf '%s' "$out" | sed -n 's/.*__CODE__//p' | sed -n '1p')" \
        "$(printf '%s' "$out" | sed 's/__CODE__[0-9]*$//' | tr -d '\n')"
    return $rc
}

# dl_json_str - read one top level string field out of a small JSON body.
# Inputs:  $1 json text, $2 field name
# Output:  prints the value; returns 1 when the body will not parse or the
#          field is absent, so "unparseable" never renders as "empty".
dl_json_str() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except (ValueError, TypeError):
    sys.exit(1)
val = doc.get(sys.argv[1]) if isinstance(doc, dict) else None
if val is None:
    sys.exit(1)
print(val)
' "$2" 2>/dev/null
}

# dl_remote_version_file - read the VERSION file out of a deployed tree.
# Inputs:  $1 host, $2 destination dir
# Output:  prints the version, or nothing when the file is absent or
#          unreadable. Absence is a legitimate answer for a source
#          checkout, which is why the caller treats it as "no corroboration
#          available" rather than as a failure.
dl_remote_version_file() {
    local host="$1" dest="$2"
    # shellcheck disable=SC2016  # $DEST is the REMOTE shell's variable.
    printf '%s\n' "$dest" | dl_run_on "$host" '
        IFS= read -r DEST
        [ -f "$DEST/VERSION" ] || exit 0
        grep -v "^#" "$DEST/VERSION" | sed -n "/[^[:space:]]/p" | sed -n "1p"
    ' 2>/dev/null | tr -d ' \r'
}

# dl_capture_listeners - the BEFORE reading, taken prior to any kill.
# Inputs:  $1 host, $2 port
# Output:  prints "<remote epoch> <space separated pids>" and returns 0;
#          returns 3 and prints nothing when the probe did not complete,
#          because a restart whose starting state is unknown cannot be
#          verified afterwards and must not be attempted blind.
# Example: BEFORE=$(dl_capture_listeners mac-mini-m4 8000) || exit 3
dl_capture_listeners() {
    local host="$1" port="$2" block
    block=$(dl_probe_port "$host" "$port" "" "")
    dl_probe_ok "$block" || return 3
    printf '%s %s\n' "$(dl_probe_field "$block" NOW)" "$(dl_probe_field "$block" PIDS)"
}

# dl_confirm_restart - the whole check. Prove the process answering on a
# port is the one this deploy just started.
# Inputs:  $1 host, $2 health host (the address curl dials), $3 port,
#          $4 destination server dir the new process must be running in,
#          $5 remote epoch recorded before the kill,
#          $6 space separated pids that held the listener before the kill
#          (may be empty: a port nobody held is a legitimate starting
#          state and leg A is then vacuously satisfied)
# Output:  returns 0 only when every leg in the header block above was
#          MEASURED and passed. Returns 1 on a measured failure or an
#          expired budget, 3 when a reading could not be taken at all.
#          Prints what it measured either way.
# Example: dl_confirm_restart mac-mini-m4 10.0.1.150 8000 "$DEST" 1757 "38309"
dl_confirm_restart() {
    local host="$1" hhost="$2" port="$3" dest="$4" t0="$5" oldpids="$6"
    local deadline block alive newpid age agesec elapsed cwd destreal
    local code body ver want probe_before probe_after rc

    # ---- leg A: the old process is GONE, not merely quiet.
    printf 'confirming the old process exited '
    deadline=$(( $(date +%s) + DL_OLD_GONE_TIMEOUT ))
    while :; do
        block=$(dl_probe_port "$host" "$port" "$dest" "$oldpids")
        if ! dl_probe_ok "$block"; then
            echo
            echo "  CANNOT DETERMINE: the probe on $host did not complete." >&2
            echo "  This is NOT evidence that nothing is listening." >&2
            return 3
        fi
        alive=$(dl_pids_still_alive "$block")
        [ -z "$alive" ] && break
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo
            echo "  OLD PROCESS STILL ALIVE after ${DL_OLD_GONE_TIMEOUT}s: ${alive% }" >&2
            echo "  SIGTERM did not take. Do not deploy over this." >&2
            return 1
        fi
        printf '.'
        sleep "$DL_POLL_INTERVAL"
    done
    if [ -n "$oldpids" ]; then
        echo "- gone (was ${oldpids% })"
    else
        echo "- nothing was holding :$port before the restart"
    fi

    # ---- legs B, C, D: a NEW pid holds the port, it is younger than the
    # restart, and it is running out of the directory this deploy wrote.
    printf 'waiting for a new process on :%s ' "$port"
    deadline=$(( $(date +%s) + DL_NEW_LISTENER_TIMEOUT ))
    while :; do
        block=$(dl_probe_port "$host" "$port" "$dest" "$oldpids")
        if ! dl_probe_ok "$block"; then
            echo
            echo "  CANNOT DETERMINE: the probe on $host did not complete." >&2
            return 3
        fi
        newpid=$(dl_new_listener_pid "$block" "$oldpids")
        if [ -n "$newpid" ]; then
            age=$(dl_probe_pid_attr "$block" AGE "$newpid")
            agesec=$(dl_etime_seconds "$age") || agesec=""
            elapsed=$(( $(dl_probe_field "$block" NOW) - t0 ))
            if [ -z "$agesec" ]; then
                echo
                echo "  CANNOT DETERMINE: could not read the age of pid $newpid." >&2
                return 3
            fi
            # THE CRUX. A process older than the restart is the one we
            # tried to kill, or an unrelated squatter. Either way it is
            # not what this deploy started, and a 200 from it is exactly
            # the false pass this file exists to prevent.
            if [ "$agesec" -gt $(( elapsed + DL_AGE_SLACK_SECONDS )) ]; then
                echo
                echo "  STALE PROCESS ON :$port. pid $newpid has been running ${agesec}s," >&2
                echo "  but the restart was issued only ${elapsed}s ago." >&2
                echo "  This is NOT the process this deploy started." >&2
                return 1
            fi
            break
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo
            echo "  TIMED OUT after ${DL_NEW_LISTENER_TIMEOUT}s: no new process bound :$port." >&2
            echo "  A timeout is a FAILURE. Nothing was verified." >&2
            return 1
        fi
        printf '.'
        sleep "$DL_POLL_INTERVAL"
    done
    echo "- pid $newpid, ${agesec}s old (restart was ${elapsed}s ago)"

    cwd=$(dl_probe_pid_attr "$block" CWD "$newpid")
    destreal=$(dl_probe_field "$block" DESTREAL)
    if [ -z "$cwd" ] || [ -z "$destreal" ]; then
        echo "  CANNOT DETERMINE: could not resolve the working directory of pid $newpid." >&2
        return 3
    fi
    if [ "$cwd" != "$destreal" ]; then
        echo "  WRONG DIRECTORY: pid $newpid is running in" >&2
        echo "    $cwd" >&2
        echo "  but this deploy wrote and hash verified" >&2
        echo "    $destreal" >&2
        return 1
    fi
    echo "running in the directory this deploy verified: $destreal"

    # ---- legs E and F: it answers, and the answer is attributable to
    # the pid we just measured. Sampling the listener either side of the
    # request is what ties the response to a process; without it this
    # would be back to "something on this port said 200".
    probe_before=$(dl_probe_field "$(dl_probe_port "$host" "$port" "" "")" PIDS)
    printf 'asking /api/v1/health '
    body=$(dl_health_json "$hhost" "$port" "$DL_HEALTH_TIMEOUT")
    rc=$?
    code="${body%% *}"; body="${body#* }"
    if [ "$rc" -ne 0 ]; then
        echo
        echo "  NO USABLE ANSWER from :$port (curl exit $rc, http ${code:-none})." >&2
        echo "  $body" >&2
        return 1
    fi
    probe_after=$(dl_probe_field "$(dl_probe_port "$host" "$port" "" "")" PIDS)
    case " $probe_before " in *" $newpid "*) ;; *)
        echo
        echo "  UNATTRIBUTABLE: pid $newpid did not hold :$port when the request was sent." >&2
        return 1 ;;
    esac
    if [ "$probe_before" != "$probe_after" ]; then
        echo
        echo "  UNATTRIBUTABLE: the listener changed across the request" >&2
        echo "    before: ${probe_before% }   after: ${probe_after% }" >&2
        return 1
    fi
    echo "- http $code from pid $newpid"

    # ---- corroboration only, and it says so. See the header: this
    # script does not deploy a version bump, so a MATCH proves nothing.
    # A MISMATCH is still worth failing on.
    ver=$(dl_json_str "$body" version) || ver=""
    want=$(dl_remote_version_file "$host" "$dest")
    if [ -n "$want" ] && [ -n "$ver" ] && [ "$ver" != "$want" ]; then
        echo "  WRONG BUILD: :$port reports version '$ver' but the deployed tree says '$want'." >&2
        return 1
    fi
    if [ -n "$want" ] && [ -n "$ver" ]; then
        echo "served version $ver matches the deployed VERSION file (corroboration; this"
        echo "  script does not change VERSION, so a match is not by itself proof of a new build)"
    else
        echo "no version corroboration available (served='${ver:-unreadable}', deployed='${want:-absent}');"
        echo "  identity already established by pid, age and working directory above"
    fi
    return 0
}
