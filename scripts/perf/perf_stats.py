"""Percentile math and table rendering for the performance baseline harness.

WHY A SEPARATE, DEPENDENCY-FREE MODULE. Every other file under
``scripts/perf/`` needs a live server, a real tmux socket, or a real
browser to do anything useful, so none of them can run as a fast unit
test. The arithmetic in this file needs none of that, so it is split out
on purpose: ``tests/test_perf_stats.py`` imports only this module and
proves the percentile math is correct in well under a second, which is
the "smoke test that runs fast" the harness is required to carry in the
normal suite.

WHY NEAREST-RANK, NOT INTERPOLATED. ``numpy`` and most statistics
libraries interpolate between the two nearest order statistics for a
percentile that does not land on an exact index. That is a defensible
choice for a large, smooth distribution, but this harness is deliberately
run against SMALL samples (a few dozen keystrokes, a handful of session
switches) where interpolating invents a number between two measurements
that never happened. The nearest-rank method (used by nginx's
``$upstream_response_time`` percentiles and by most APM p99 dashboards)
always returns a VALUE THAT WAS ACTUALLY MEASURED, which is the right
property for a baseline other phases will be compared against - a
comparison should never be able to say "regressed" or "improved" against
a number nobody's clock ever produced.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence


@dataclass
class Percentiles:
    """The three percentiles this project reports, plus the sample count.

    Inputs: none at construction beyond the fields below.
    Output: an object with ``p50``, ``p95``, ``p99`` (milliseconds, or
      None when the sample was empty) and ``n`` (the sample count that
      produced them).
    Example: Percentiles(p50=12.0, p95=40.0, p99=55.0, n=30)
    """

    p50: Optional[float]
    p95: Optional[float]
    p99: Optional[float]
    n: int
    min_ms: Optional[float] = field(default=None)
    max_ms: Optional[float] = field(default=None)
    mean_ms: Optional[float] = field(default=None)


def nearest_rank_percentile(samples: Sequence[float], pct: float) -> float:
    """One percentile of ``samples`` by the nearest-rank method.

    Inputs: samples (Sequence[float]) - non-empty, need not be sorted;
      pct (float) - in (0, 100].
    Output: float - a value that is a MEMBER of ``samples`` (never
      interpolated).
    Raises: ValueError - samples is empty, or pct is out of (0, 100].
    Example: nearest_rank_percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) -> 10
    """
    if not samples:
        raise ValueError("cannot take a percentile of an empty sample")
    if not (0 < pct <= 100):
        raise ValueError(f"pct must be in (0, 100], got {pct}")
    ordered = sorted(samples)
    # Nearest-rank: rank = ceil(pct/100 * n), 1-indexed, clamped into range.
    rank = math.ceil((pct / 100.0) * len(ordered))
    rank = max(1, min(rank, len(ordered)))
    return ordered[rank - 1]


def summarize(samples: Iterable[float]) -> Percentiles:
    """Reduce a list of millisecond samples to p50/p95/p99 plus a count.

    Inputs: samples (Iterable[float]) - millisecond latencies. May be
      empty (some interaction/session-count/cold-warm cell can genuinely
      have nothing to report, e.g. a browser dependency was unavailable).
    Output: Percentiles - every percentile field is None when the input
      was empty, rather than 0.0, so an unmeasured cell can never be
      confused with a real zero-latency measurement.
    Example: summarize([10, 20, 30]).p50 -> 20
    """
    values = list(samples)
    if not values:
        return Percentiles(p50=None, p95=None, p99=None, n=0)
    return Percentiles(
        p50=nearest_rank_percentile(values, 50),
        p95=nearest_rank_percentile(values, 95),
        p99=nearest_rank_percentile(values, 99),
        n=len(values),
        min_ms=min(values),
        max_ms=max(values),
        mean_ms=sum(values) / len(values),
    )


def fmt_ms(value: Optional[float]) -> str:
    """Render a millisecond value (or ``None``) for a markdown table cell.

    Inputs: value (Optional[float]).
    Output: str - ``"n/a"`` for None, otherwise one decimal place.
    Example: fmt_ms(12.345) -> '12.3 ms'; fmt_ms(None) -> 'n/a'
    """
    if value is None:
        return "n/a"
    return f"{value:.1f} ms"


def verdict(p95: Optional[float], target_ms: float) -> str:
    """Say PASS/FAIL/N-A for one measured p95 against one plan target.

    Inputs: p95 (Optional[float]) - measured p95 in ms, or None when
      unmeasured; target_ms (float) - the plan's target ceiling.
    Output: str - one of "PASS", "FAIL", "N/A (unmeasured)".
    Example: verdict(40.0, 50.0) -> 'PASS'
    """
    if p95 is None:
        return "N/A (unmeasured)"
    return "PASS" if p95 <= target_ms else "FAIL"
