#!/bin/bash
# scripts/ci/roundtrip-upgrade-downgrade.sh
#
# Answers ONE question by executing it: after the new version migrates
# config.json and imports into cloude.db, can the OLD version be dropped
# back in and still work?
#
#   ./scripts/ci/roundtrip-upgrade-downgrade.sh [options]
#
#   --old REF         the version being downgraded TO. Default v0.8.1, the
#                     newest published release tag that predates BOTH the
#                     config_version machinery and the datastore.
#   --new REF         the version being upgraded TO. Default
#                     integration/ui-only.
#   --source-repo DIR the repo to clone the two versions out of. Default:
#                     the repo this script lives in.
#   --seed-config F   config.json to start the OLD install from. Default:
#                     tests/fixtures/roundtrip/old_config.json. Point it at
#                     a COPY of a real config to test a real shape; never
#                     at the real file, this harness writes to it.
#   --work-dir DIR    throwaway run directory. Default a timestamped dir
#                     under $HOME/Scratch/llmScratch.
#   --venv DIR        an existing venv to reuse. Default: build one in the
#                     work dir. Both versions pin identical requirements,
#                     so one venv serves both.
#   --port N          base port to probe upward from. Default 8137.
#                     NEVER 8000 (a real install) and NEVER 5000 (AirPlay).
#   --keep            do not delete the work dir on success.
#
# SAFETY. This script only ever writes inside its own work directory. It
# clones the source repo rather than checking anything out in place, it
# never touches ~/Library/Application Support/CloudeCode (it points
# CLOUDE_STATE_DIR at the work dir), it never runs nuke.sh or reset.sh,
# and it starts servers only on a port it has just proven to be free.
#
# Exit codes: 0 every step passed. 1 a step failed. 2 a step could not be
# evaluated and none failed. 3 the harness itself could not set up - which
# is NOT a verdict about the round trip, and is reported as such.
#
# Portability: bash 3.2 (macOS /bin/bash). No ${v,,}, no declare -A, no
# mapfile, no `wait -n`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
LIB_DIR="${SCRIPT_DIR}/roundtrip_lib"

OLD_REF="v0.8.1"
NEW_REF="integration/ui-only"
SOURCE_REPO="${REPO_ROOT}"
SEED_CONFIG="${REPO_ROOT}/tests/fixtures/roundtrip/old_config.json"
WORK_DIR=""
VENV_DIR=""
BASE_PORT=8137
KEEP=0

while [ $# -gt 0 ]; do
    case "$1" in
        --old) OLD_REF="$2"; shift 2 ;;
        --new) NEW_REF="$2"; shift 2 ;;
        --source-repo) SOURCE_REPO="$2"; shift 2 ;;
        --seed-config) SEED_CONFIG="$2"; shift 2 ;;
        --work-dir) WORK_DIR="$2"; shift 2 ;;
        --venv) VENV_DIR="$2"; shift 2 ;;
        --port) BASE_PORT="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown flag: $1 (see --help)" >&2; exit 3 ;;
    esac
done

say()  { printf '[roundtrip] %s\n' "$*"; }
setup_fail() { printf '[roundtrip][SETUP-FAIL] %s\n' "$*" >&2; exit 3; }

[ "${BASE_PORT}" = "8000" ] && setup_fail "refusing base port 8000 - that is a real install"
[ "${BASE_PORT}" = "5000" ] && setup_fail "refusing port 5000 - AirPlay"

if [ -z "${WORK_DIR}" ]; then
    WORK_DIR="${HOME}/Scratch/llmScratch/cc-roundtrip-run-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "${WORK_DIR}/artifacts" || setup_fail "cannot create work dir ${WORK_DIR}"
INSTALL="${WORK_DIR}/install"
STATE_DIR="${WORK_DIR}/state"
LOG_DIR="${WORK_DIR}/logs"
PROJ_DIR="${WORK_DIR}/projects"
mkdir -p "${STATE_DIR}" "${LOG_DIR}" "${PROJ_DIR}"

say "work dir:     ${WORK_DIR}"
say "source repo:  ${SOURCE_REPO}"
say "old ref:      ${OLD_REF}"
say "new ref:      ${NEW_REF}"
say "seed config:  ${SEED_CONFIG}"

[ -f "${SEED_CONFIG}" ] || setup_fail "seed config not found: ${SEED_CONFIG}"

# --- a genuinely free port ---------------------------------------------------
#
# Measured, not assumed. Binding is the only check that cannot be wrong
# about whether a port is available.
PORT="$(python3 - "${BASE_PORT}" <<'PY'
import socket, sys
base = int(sys.argv[1])
for p in range(base, base + 200):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p))
    except OSError:
        continue
    finally:
        s.close()
    print(p)
    break
PY
)"
[ -n "${PORT}" ] || setup_fail "no free port found from ${BASE_PORT}"
say "port:         ${PORT} (bound successfully before use)"

# --- clone the source repo once ---------------------------------------------

git clone -q "${SOURCE_REPO}" "${INSTALL}" || setup_fail "clone of ${SOURCE_REPO} failed"
git -C "${INSTALL}" rev-parse --verify -q "${OLD_REF}^{commit}" >/dev/null \
    || setup_fail "old ref ${OLD_REF} does not exist in ${SOURCE_REPO}"
git -C "${INSTALL}" rev-parse --verify -q "${NEW_REF}^{commit}" >/dev/null \
    || git -C "${INSTALL}" rev-parse --verify -q "origin/${NEW_REF}^{commit}" >/dev/null \
    || setup_fail "new ref ${NEW_REF} does not exist in ${SOURCE_REPO}"

# --- venv --------------------------------------------------------------------

if [ -z "${VENV_DIR}" ]; then
    VENV_DIR="${WORK_DIR}/venv"
    say "building venv (both refs pin identical requirements)"
    python3 -m venv "${VENV_DIR}" >/dev/null 2>&1 || setup_fail "venv creation failed"
    "${VENV_DIR}/bin/pip" install -q --disable-pip-version-check \
        -r <(git -C "${INSTALL}" show "${NEW_REF}:requirements.txt" 2>/dev/null \
             || git -C "${INSTALL}" show "origin/${NEW_REF}:requirements.txt") \
        || setup_fail "pip install failed"
fi
PY_BIN="${VENV_DIR}/bin/python3"
[ -x "${PY_BIN}" ] || setup_fail "no python at ${PY_BIN}"
ln -sfn "${VENV_DIR}" "${INSTALL}/venv"

# --- .env --------------------------------------------------------------------
#
# Dummy secrets. Real ones are never read, copied or written by this
# harness; AuthConfig only requires them to be non-empty.
cat > "${INSTALL}/.env" <<EOF
HOST=127.0.0.1
PORT=${PORT}
DEFAULT_WORKING_DIR=${PROJ_DIR}
SESSION_TIMEOUT=3600
LOG_DIRECTORY=${LOG_DIR}
CLOUDE_STATE_DIR=${STATE_DIR}
AUTH_CONFIG_FILE=./config.json
TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
JWT_SECRET=roundtrip-harness-not-a-real-secret
EOF

# --- helpers -----------------------------------------------------------------

# Description: check out one ref into the install, preserving config.json,
#   .env and venv (all gitignored, so a checkout leaves them alone).
# Inputs: $1 - git ref.
# Output: 0 on success, non-zero on failure.
checkout_ref() {
    local ref="$1"
    git -C "${INSTALL}" checkout -q --detach "${ref}" 2>/dev/null \
        || git -C "${INSTALL}" checkout -q --detach "origin/${ref}"
}

# Description: start the install's server, wait for /health, then stop it.
#   Writes a JSON result to the step's .server.json artifact. The three
#   outcomes are distinct: ok, fail (process alive or dead but /health
#   never answered), unknown (the harness could not even launch it).
# Inputs: $1 - artifact prefix path (without extension).
# Output: 0 always; the verdict lives in the artifact.
start_stop_server() {
    local out="$1.server.json"
    local log="$1.server.log"
    (
        cd "${INSTALL}" || exit 1
        exec "${PY_BIN}" -m src.main
    ) > "${log}" 2>&1 &
    local pid=$!
    local i=0
    local status="fail"
    local detail="server never answered /health within 45s"
    while [ $i -lt 90 ]; do
        if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            status="ok"
            detail="/health answered on port ${PORT}"
            break
        fi
        if ! kill -0 "${pid}" 2>/dev/null; then
            status="fail"
            detail="process exited before /health answered (see $(basename "${log}"))"
            break
        fi
        sleep 0.5
        i=$((i + 1))
    done
    if kill -0 "${pid}" 2>/dev/null; then
        kill "${pid}" 2>/dev/null
        local w=0
        while kill -0 "${pid}" 2>/dev/null && [ $w -lt 20 ]; do sleep 0.25; w=$((w + 1)); done
        kill -9 "${pid}" 2>/dev/null
    fi
    wait "${pid}" 2>/dev/null
    python3 - "${out}" "${status}" "${detail}" <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps(
    {"status": sys.argv[2], "detail": sys.argv[3]}, indent=2) + "\n")
PY
    return 0
}

STEP_N=0

# Description: capture one step - mark it, snapshot config.json, run the
#   probe, and (unless $2 is "noserver") start and stop the server.
# Inputs: $1 - step name. $2 - optional "noserver".
# Output: 0 always.
capture_step() {
    local name="$1"
    local mode="${2:-server}"
    STEP_N=$((STEP_N + 1))
    local prefix
    prefix="$(printf '%s/artifacts/%02d-%s' "${WORK_DIR}" "${STEP_N}" "${name}")"
    : > "${prefix}.step"
    say "--- step $(printf '%02d' ${STEP_N}): ${name}"
    if [ "${mode}" != "noserver" ]; then
        start_stop_server "${prefix}"
    fi
    [ -f "${INSTALL}/config.json" ] && cp "${INSTALL}/config.json" "${prefix}.config.json"
    (
        cd "${INSTALL}" || exit 1
        "${PY_BIN}" "${LIB_DIR}/probe_install.py" \
            --install-dir "${INSTALL}" --label "${name}" --state-dir "${STATE_DIR}"
    ) > "${prefix}.probe.json" 2> "${prefix}.probe.err"
    # The app prints a banner to stdout on some failure paths, so keep only
    # the JSON object the probe emits last.
    python3 - "${prefix}.probe.json" <<'PY'
import json, sys
p = sys.argv[1]
raw = open(p).read()
start = raw.find("{")
if start < 0:
    sys.exit(0)
try:
    obj = json.loads(raw[start:])
except ValueError:
    sys.exit(0)
open(p, "w").write(json.dumps(obj, indent=2, sort_keys=True) + "\n")
PY
    return 0
}

# --- 1. OLD, configured ------------------------------------------------------

checkout_ref "${OLD_REF}" || setup_fail "could not check out ${OLD_REF}"
cp "${SEED_CONFIG}" "${INSTALL}/config.json" || setup_fail "could not seed config.json"
capture_step "old-baseline"

# --- 2. OLD writes, to prove the seeded state is live ------------------------
#
# A config the old version merely READS is weaker evidence than one it has
# also WRITTEN through, because the write paths are where key loss would
# happen. This exercises the raw-dict round trip the old version uses.
say "--- exercising OLD write paths (save_project)"
(
    cd "${INSTALL}" || exit 1
    "${PY_BIN}" - <<'PY'
import sys
sys.path.insert(0, ".")
from src.config import Settings, ProjectConfig
s = Settings()
try:
    s.save_project(ProjectConfig(
        name="roundtrip-probe-project",
        path="~/projects/roundtrip-probe",
        description="written by the round-trip harness on the OLD version",
    ))
    print("OLD_WRITE_OK")
except Exception as e:
    print("OLD_WRITE_FAILED:", e)
PY
) > "${WORK_DIR}/artifacts/old-write.log" 2>&1
cat "${WORK_DIR}/artifacts/old-write.log" | tail -2

capture_step "old-after-write" noserver

# --- 3. UPGRADE --------------------------------------------------------------
#
# The real path from ${OLD_REF}. scripts/upgrade.sh does NOT exist at
# v0.8.1, so it cannot be the upgrade path FROM that release; what a user
# actually does is replace the tree and start the app, whose startup runs
# ensure_config_migrated -> ensure_db_migrated -> run_first_run_import.
# That startup sequence IS the migration, and starting the server is how
# this harness runs it.

checkout_ref "${NEW_REF}" || setup_fail "could not check out ${NEW_REF}"
capture_step "upgraded-new"

# --- 4. DOWNGRADE - the step that answers the question -----------------------

checkout_ref "${OLD_REF}" || setup_fail "could not check back out ${OLD_REF}"
capture_step "downgraded-old"

# --- 5. OLD writes again, post-upgrade ---------------------------------------
#
# The question that decides whether a downgrade is merely survivable or
# actually safe: when the OLD version writes the config back out, does it
# preserve the keys the NEW version added?
say "--- exercising OLD write paths again, on the migrated config"
(
    cd "${INSTALL}" || exit 1
    "${PY_BIN}" - <<'PY'
import sys
sys.path.insert(0, ".")
from src.config import Settings, ProjectConfig
s = Settings()
try:
    s.save_project(ProjectConfig(
        name="roundtrip-probe-after-downgrade",
        path="~/projects/roundtrip-after",
        description="written by the OLD version AFTER the upgrade",
    ))
    print("OLD_WRITE_POST_UPGRADE_OK")
except Exception as e:
    print("OLD_WRITE_POST_UPGRADE_FAILED:", e)
PY
) > "${WORK_DIR}/artifacts/old-write-post.log" 2>&1
cat "${WORK_DIR}/artifacts/old-write-post.log" | tail -2

capture_step "downgraded-old-after-write" noserver

# --- 6. RE-UPGRADE -----------------------------------------------------------

checkout_ref "${NEW_REF}" || setup_fail "could not re-check-out ${NEW_REF}"
capture_step "re-upgraded-new"

# --- 7. report ---------------------------------------------------------------

"${PY_BIN}" "${LIB_DIR}/report_roundtrip.py" --run-dir "${WORK_DIR}"
RC=$?

say "artifacts: ${WORK_DIR}/artifacts"
say "verdict:   ${WORK_DIR}/verdict.json"
if [ "${KEEP}" = "0" ] && [ "${RC}" = "0" ]; then
    say "run passed; work dir kept anyway for inspection (nothing here is deleted automatically)"
fi
exit ${RC}
