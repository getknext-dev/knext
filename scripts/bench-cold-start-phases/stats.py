#!/usr/bin/env python3
"""Two-sample comparison used by the per-phase benchmark (stdlib only).

    python3 stats.py run.jsonl <metric> <groupA> <groupB> [--node=<ip>]

<metric> is a phase from analyze.py's milestone names, as `a..b` (b minus a) or a
single milestone (time after the request). A group is `arm` or `arm[treatment]`.
Prints medians, the exact two-sided Mann-Whitney p (exact null distribution by
dynamic programming, ties handled by a normal approximation fallback) and a
bootstrap 95% CI (4000 resamples, fixed seed) of the difference of medians A-B.
"""
import json
import math
import pathlib
import random
import statistics
import sys
from functools import lru_cache

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import analyze  # noqa: E402  (same directory)


def u_stat(a, b):
    u = 0.0
    for x in a:
        for y in b:
            u += 1.0 if x > y else 0.5 if x == y else 0.0
    return u


def exact_p(a, b):
    n, m = len(a), len(b)
    u = u_stat(a, b)
    if len(set(a + b)) < n + m:  # ties: normal approximation
        mu, sd = n * m / 2, math.sqrt(n * m * (n + m + 1) / 12)
        z = (abs(u - mu) - 0.5) / sd
        return math.erfc(max(z, 0) / math.sqrt(2))

    @lru_cache(maxsize=None)
    def count(i, j, k):  # ways for i a's and j b's to give U == k
        if k < 0:
            return 0
        if i == 0 or j == 0:
            return 1 if k == 0 else 0
        return count(i - 1, j, k - j) + count(i, j - 1, k)

    total = math.comb(n + m, n)
    lo = min(u, n * m - u)
    tail = sum(count(n, m, k) for k in range(int(lo) + 1)) / total
    return min(1.0, 2 * tail)


def boot_ci(a, b, reps=4000, seed=7):
    rnd = random.Random(seed)
    d = sorted(statistics.median(rnd.choices(a, k=len(a))) - statistics.median(rnd.choices(b, k=len(b)))
               for _ in range(reps))
    return d[int(0.025 * reps)], d[int(0.975 * reps)]


def compare(a, b):
    return dict(nA=len(a), nB=len(b), medA=statistics.median(a), medB=statistics.median(b),
                diff=statistics.median(a) - statistics.median(b), p=exact_p(a, b), ci=boot_ci(a, b))


def main():
    path, metric, ga, gb = sys.argv[1:5]
    node = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--node=")), None)
    for x in sys.argv:
        if x.startswith("--activator="):
            analyze.load_cp("activator", x.split("=", 1)[1])
        if x.startswith("--autoscaler="):
            analyze.load_cp("autoscaler", x.split("=", 1)[1])
    rows = [json.loads(l) for l in open(path) if l.strip()]
    rows = [r for r in rows if "error" not in r and r.get("code") == 200 and r.get("marker")]
    if node:
        rows = [r for r in rows if r["node"] == node]

    def grp(g):
        arm, _, tr = g.partition("[")
        return [r for r in rows if r["arm"] == arm and (not tr or r.get("treatment") == tr.rstrip("]"))]

    a_name, _, b_name = metric.partition("..")

    def val(r):
        m = analyze.milestones(r)
        if b_name:
            return None if m.get(a_name) is None or m.get(b_name) is None else m[b_name] - m[a_name]
        return m.get(a_name)

    A = [v for v in map(val, grp(ga)) if v is not None]
    B = [v for v in map(val, grp(gb)) if v is not None]
    c = compare(A, B)
    print(f"{metric}: {ga} n={c['nA']} median {c['medA']:.0f} | {gb} n={c['nB']} median {c['medB']:.0f} | "
          f"diff {c['diff']:+.0f} ms, Mann-Whitney p={c['p']:.3g}, bootstrap 95% CI [{c['ci'][0]:+.0f}, {c['ci'][1]:+.0f}]"
          + (f" (node {node})" if node else ""))


if __name__ == "__main__":
    main()
