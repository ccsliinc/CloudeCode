#!/bin/bash
#
# Reset script for Cloude Code.
#
# Two modes, auto-detected:
#
#   launchd-managed - the server runs under a macOS LaunchAgent with
#     KeepAlive=true (label defaults to com.imc.cloude-code, override
#     with CLOUDE_LAUNCHD_LABEL). Under that setup, stop.sh killing the
#     port-8000 process triggers an IMMEDIATE launchd respawn, and this
#     script's own start.sh then races that respawn for the same port -
#     one of the two loses and the reset either half-works or leaves two
#     processes fighting over the port. `launchctl kickstart -k` is the
#     correct primitive here: it asks launchd itself to restart its own
#     managed job, so there is exactly one respawn, not two.
#
#   unmanaged - no matching launchd job is loaded (e.g. running via
#     `./start.sh` directly, or on Linux/CI). Falls back to the original
#     stop.sh + sleep + start.sh flow.
#
# Inputs: none (reads CLOUDE_LAUNCHD_LABEL from the environment, optional).
# Output: exit 0 on a verified-up server on :8000, exit 1 otherwise.

LAUNCHD_LABEL="${CLOUDE_LAUNCHD_LABEL:-com.imc.cloude-code}"

echo "=== Resetting Cloude Code Server ==="

launchd_job_loaded() {
    # Description: True if a launchd job with $LAUNCHD_LABEL is loaded
    #   for the current console user. macOS-only (launchctl doesn't
    #   exist on Linux/CI, where this always returns false).
    command -v launchctl >/dev/null 2>&1 || return 1
    launchctl list 2>/dev/null | grep -q "$LAUNCHD_LABEL"
}

if launchd_job_loaded; then
    echo "Detected launchd-managed job '$LAUNCHD_LABEL' - using launchctl kickstart"
    echo "(stop.sh + start.sh would race the launchd respawn for port 8000)"

    UID_NUM=$(id -u)
    if launchctl kickstart -k "gui/${UID_NUM}/${LAUNCHD_LABEL}"; then
        echo "Waiting for launchd to bring the service back up..."
        sleep 3
        if lsof -ti:8000 > /dev/null 2>&1; then
            echo "Server is running on port 8000"
            echo "Reset complete!"
            exit 0
        else
            echo "WARNING: launchctl kickstart returned success but port 8000 is not listening yet"
            exit 1
        fi
    else
        echo "ERROR: launchctl kickstart failed for gui/${UID_NUM}/${LAUNCHD_LABEL}"
        exit 1
    fi
fi

echo "No launchd job '$LAUNCHD_LABEL' found - using stop.sh + start.sh"

# Stop the server
./stop.sh
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to stop server"
    exit 1
fi

# Wait a moment before starting
echo "Waiting 2 seconds before restart..."
sleep 2

# Start the server in the background
echo "Starting server..."
./start.sh &

# Give it a moment to start
sleep 3

# Verify the server is up
if lsof -ti:8000 > /dev/null 2>&1; then
    echo "Server is running on port 8000"
    echo "Reset complete!"
    exit 0
else
    echo "WARNING: Server may not have started properly"
    exit 1
fi
