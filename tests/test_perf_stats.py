"""Fast, dependency-free unit test for the perf harness's percentile math.

WHY THIS IS THE HARNESS'S "SMOKE TEST IN THE NORMAL SUITE". Every other
piece of ``scripts/perf/`` needs a real tmux socket, a real subprocess
server and a real browser, none of which belong in the default fast
pytest run. ``scripts/perf/perf_stats.py`` is the one module with zero
such dependencies, so this file proves the arithmetic the whole baseline
report is built on without paying for any of that - it runs in a few
milliseconds. ``tests/test_perf_harness_smoke.py`` is the sibling file
that boots a real (throwaway) server and is the actual "does the harness
still work end to end" check; this one is the "is the math right" check.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_PERF = Path(__file__).resolve().parents[1] / "scripts" / "perf"
if str(SCRIPTS_PERF) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_PERF))

from perf_stats import fmt_ms, nearest_rank_percentile, summarize, verdict  # noqa: E402


def test_nearest_rank_percentile_returns_a_real_sample_never_an_interpolation():
    """p95 of ten ordered values must BE one of those ten values."""
    samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    p95 = nearest_rank_percentile(samples, 95)
    assert p95 in samples
    assert p95 == 10  # ceil(0.95 * 10) = 10th ranked value


def test_nearest_rank_percentile_p50_of_four_values():
    """A known, hand-checkable case: ceil(0.5 * 4) = 2 -> the 2nd value."""
    assert nearest_rank_percentile([10, 20, 30, 40], 50) == 20


def test_nearest_rank_percentile_unsorted_input_is_sorted_first():
    """Input order must not matter - only the multiset of values does."""
    assert nearest_rank_percentile([30, 10, 40, 20], 50) == 20


def test_nearest_rank_percentile_rejects_empty_sample():
    with pytest.raises(ValueError):
        nearest_rank_percentile([], 95)


@pytest.mark.parametrize("pct", [0, -1, 100.1, 101])
def test_nearest_rank_percentile_rejects_out_of_range_pct(pct):
    with pytest.raises(ValueError):
        nearest_rank_percentile([1, 2, 3], pct)


def test_summarize_empty_sample_is_none_not_zero():
    """An unmeasured cell must read as None, never as a false zero-latency win."""
    result = summarize([])
    assert result.n == 0
    assert result.p50 is None
    assert result.p95 is None
    assert result.p99 is None


def test_summarize_reports_p50_p95_p99_and_count():
    samples = list(range(1, 101))  # 1..100
    result = summarize(samples)
    assert result.n == 100
    assert result.p50 == 50
    assert result.p95 == 95
    assert result.p99 == 99


def test_fmt_ms_renders_none_as_na_and_a_value_with_one_decimal():
    assert fmt_ms(None) == "n/a"
    assert fmt_ms(12.345) == "12.3 ms"
    assert fmt_ms(0.0) == "0.0 ms"


def test_verdict_pass_fail_and_unmeasured():
    assert verdict(40.0, 50.0) == "PASS"
    assert verdict(60.0, 50.0) == "FAIL"
    assert verdict(50.0, 50.0) == "PASS"  # boundary is inclusive
    assert verdict(None, 50.0) == "N/A (unmeasured)"
