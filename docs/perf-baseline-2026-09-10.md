# Performance baseline, 2026-09-10

Measured against the current tip with `venv/bin/python3 scripts/perf/run_baseline.py`, one isolated server per session count, throwaway tmux socket, `CLOUDE_TEST_MODE=1`, `agent_type=shell` for every session (no real `claude` binary, no LLM turns - see the harness module docstring for why).

Reproduce with: `venv/bin/python3 scripts/perf/run_baseline.py --sessions 1,10,50`

**Machine load during this capture.** This numbered run shared the box with several other concurrent agent sessions (`uptime` load average measured as high as 96 on a 10-core machine partway through this work, settling to roughly 10-16 by the end). Every number below is real - a genuine wall-clock measurement of the real client against a real isolated server - but the ABSOLUTE latencies are inflated by that contention, most visibly in boot time (24-45s here, versus 4-10s measured on the same harness on a quiet box earlier the same session) and in the multi-second `launch` figures. Treat the RELATIVE shape (which interactions dominate, cold vs warm direction, N=1 vs N=50 direction) as reliable, and re-run on an idle machine before using an absolute number to judge a future phase's fix. `--quick` mode was used throughout (reduced repetition counts per interaction: see `run_baseline.py --help`), which is why several cells show `n=1`; a non-quick run should be part of any phase-close-out re-measurement.

**Known gap.** `settings open, cold/warm` reads `n/a` in every column: `#settingsBtn` was measured to still report "not visible" to a forced click immediately after the preceding menu interaction closes, in every run of this baseline. A `wait_for_selector(state="visible")` was added ahead of the click (see `perf_browser.click_tolerant`) and fixed the same class of failure for the notification-toast step, but did not fully resolve this one. Tracked as a harness follow-up (see the caller's final report for the numbered problem).

## Plan targets

| Interaction | Target | N=1 p95 / verdict | N=10 p95 / verdict | N=50 p95 / verdict |
|---|---|---|---|---|
| Deterministic terminal echo (warm) | <= 50.0 ms | 120.5 ms / FAIL (n=4) | 121.0 ms / FAIL (n=4) | 51.4 ms / FAIL (n=4) |
| Warm switch, unchanged geometry | <= 200.0 ms | 163.4 ms / PASS (n=1) | 285.7 ms / FAIL (n=1) | 871.4 ms / FAIL (n=1) |
| Menu open (cold) | <= 16.7 ms | 37.3 ms / FAIL (n=1) | 145.9 ms / FAIL (n=1) | 702.6 ms / FAIL (n=1) |
| Local hook to visible toast | <= 100.0 ms | n/a / N/A (unmeasured) (n=0) | n/a / N/A (unmeasured) (n=0) | 140.8 ms / FAIL (n=3) |

## Full measurements (p50 / p95 / p99, ms)

| Interaction | N=1 | N=10 | N=50 |
|---|---|---|---|
| typing echo - dispatch to ws-send (browser), cold | 1.6 ms / 2.2 ms / 2.2 ms (n=3) | 12.5 ms / 16.1 ms / 16.1 ms (n=3) | 10.1 ms / 188.5 ms / 188.5 ms (n=3) |
| typing echo - ws-send to first byte back (network+server), cold | 14.2 ms / 31.0 ms / 31.0 ms (n=3) | 7.6 ms / 13.0 ms / 13.0 ms (n=3) | 205.9 ms / 273.3 ms / 273.3 ms (n=3) |
| typing echo - first byte to onRender (browser render), cold | 11.0 ms / 14.8 ms / 14.8 ms (n=3) | 60.5 ms / 111.5 ms / 111.5 ms (n=3) | 12.0 ms / 18.0 ms / 18.0 ms (n=3) |
| typing echo - total, cold | 21.8 ms / 48.0 ms / 48.0 ms (n=3) | 84.2 ms / 137.0 ms / 137.0 ms (n=3) | 227.5 ms / 463.1 ms / 463.1 ms (n=3) |
| typing echo - dispatch to ws-send (browser), warm | 1.0 ms / 7.7 ms / 7.7 ms (n=4) | 3.7 ms / 9.6 ms / 9.6 ms (n=4) | 5.5 ms / 84.1 ms / 84.1 ms (n=4) |
| typing echo - ws-send to first byte back (network+server), warm | 11.7 ms / 16.6 ms / 16.6 ms (n=4) | 10.2 ms / 106.5 ms / 106.5 ms (n=4) | 21.7 ms / 37.2 ms / 37.2 ms (n=2) |
| typing echo - first byte to onRender (browser render), warm | 14.8 ms / 102.9 ms / 102.9 ms (n=4) | 7.6 ms / 15.2 ms / 15.2 ms (n=4) | 0.0 ms / 7.7 ms / 7.7 ms (n=2) |
| typing echo - total, warm | 36.1 ms / 120.5 ms / 120.5 ms (n=4) | 27.6 ms / 121.0 ms / 121.0 ms (n=4) | 13.2 ms / 51.4 ms / 51.4 ms (n=4) |
| session entry (launchpad row -> interactive) | 1261.9 ms / 1261.9 ms / 1261.9 ms (n=1) | 2176.9 ms / 2176.9 ms / 2176.9 ms (n=1) | 3149.7 ms / 3149.7 ms / 3149.7 ms (n=1) |
| session switch, cold | 283.6 ms / 283.6 ms / 283.6 ms (n=1) | 178.1 ms / 178.1 ms / 178.1 ms (n=1) | 1550.3 ms / 1550.3 ms / 1550.3 ms (n=1) |
| session switch, warm (unchanged geometry) | 163.4 ms / 163.4 ms / 163.4 ms (n=1) | 285.7 ms / 285.7 ms / 285.7 ms (n=1) | 871.4 ms / 871.4 ms / 871.4 ms (n=1) |
| launch, cold (create -> interactive) | 6431.2 ms / 6431.2 ms / 6431.2 ms (n=1) | 3941.3 ms / 3941.3 ms / 3941.3 ms (n=1) | 7860.5 ms / 7860.5 ms / 7860.5 ms (n=1) |
| launch, warm | 6465.7 ms / 6465.7 ms / 6465.7 ms (n=1) | 8016.0 ms / 8016.0 ms / 8016.0 ms (n=1) | 9250.8 ms / 9250.8 ms / 9250.8 ms (n=1) |
| menu open, cold | 37.3 ms / 37.3 ms / 37.3 ms (n=1) | 145.9 ms / 145.9 ms / 145.9 ms (n=1) | 702.6 ms / 702.6 ms / 702.6 ms (n=1) |
| menu open, warm | 162.3 ms / 162.3 ms / 162.3 ms (n=1) | 108.4 ms / 108.4 ms / 108.4 ms (n=1) | 180.9 ms / 180.9 ms / 180.9 ms (n=1) |
| settings open, cold | n/a / n/a / n/a (n=0) | n/a / n/a / n/a (n=0) | n/a / n/a / n/a (n=0) |
| settings open, warm | n/a / n/a / n/a (n=0) | n/a / n/a / n/a (n=0) | n/a / n/a / n/a (n=0) |
| notification: hook to visible toast | n/a / n/a / n/a (n=0) | n/a / n/a / n/a (n=0) | 59.8 ms / 140.8 ms / 140.8 ms (n=3) |
| archive-scroll proxy: frame gap (launchpad list, requestAnimationFrame) | 8.5 ms / 91.7 ms / 108.1 ms (n=39) | 9.5 ms / 88.0 ms / 116.7 ms (n=39) | 38.5 ms / 159.3 ms / 222.1 ms (n=39) |
| startup, cold (real TOTP login) | 2051.5 ms / 2051.5 ms / 2051.5 ms (n=1) | 3854.3 ms / 3854.3 ms / 3854.3 ms (n=1) | 1497.6 ms / 1497.6 ms / 1497.6 ms (n=1) |
| startup, warm (reload, token held) | 1264.9 ms / 1264.9 ms / 1264.9 ms (n=1) | 1464.8 ms / 1464.8 ms / 1464.8 ms (n=1) | 3354.1 ms / 3354.1 ms / 3354.1 ms (n=1) |

## Server resources and boot

| | N=1 | N=10 | N=50 |
|---|---|---|---|
| boot time (process start to /health 200) | 24.29 s | 44.92 s | 38.07 s |
| idle CPU % (0 sessions) | 0.3% | 0.2% | 0.3% |
| idle CPU % (N sessions, no viewer) | 0.0% | 0.7% | 2.7% |
| idle CPU % (after full run) | 0.9% | 0.7% | 2.7% |
| RSS, MB (0 sessions) | 92.7 MB | 92.5 MB | 92.7 MB |
| RSS, MB (N sessions, no viewer) | 93.1 MB | 93.5 MB | 96.2 MB |
| RSS, MB (after full run) | 104.3 MB | 103.8 MB | 103.7 MB |
| direct DB read (`SELECT COUNT(*) FROM sessions`), fresh connection | 29.3 ms | 18.2 ms | 1.4 ms |

