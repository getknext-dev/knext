#!/usr/bin/env python3
"""Per-arm summary + the IQR verdict for the 1.3.1 Node-vs-Bun A/B (stdlib only).

    python3 report.py run.jsonl [armA armB]

Total = the harness's `watch.first_byte` (ms from request sent to first response byte).
Quartiles use the lower-half / upper-half method (as release-cells 09-30 and rc6 10-07).
Verdict rule: the arms differ only when their IQRs do not overlap; otherwise "tie".
Also prints the Hodges-Lehmann shift (A - B) with a 4000-resample percentile bootstrap CI
and the two-sided Mann-Whitney p from scripts/bench-cold-start-phases/stats.py.
"""
import json
import pathlib
import random
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[4] / "scripts" / "bench-cold-start-phases"))
import stats  # noqa: E402


def quartiles(xs):
    s = sorted(xs)
    h = len(s) // 2
    lo, hi = s[:h], s[h + (len(s) % 2):]
    return statistics.median(lo), statistics.median(s), statistics.median(hi)


def hl(a, b):
    return statistics.median([x - y for x in a for y in b])


def hl_ci(a, b, n=4000, seed=1):
    rnd = random.Random(seed)
    v = sorted(hl([rnd.choice(a) for _ in a], [rnd.choice(b) for _ in b]) for _ in range(n))
    return round(v[int(0.025 * n)]), round(v[int(0.975 * n) - 1])


def main():
    path = sys.argv[1]
    arms = sys.argv[2:4] or ["n131", "b131"]
    rows = [json.loads(l) for l in open(path)]
    ok = [r for r in rows if "error" not in r and r.get("code") == 200 and r.get("watch", {}).get("first_byte")]
    bad = [r for r in rows if r not in ok]
    print(f"rows {len(rows)}, valid {len(ok)}, invalid {len(bad)}: "
          + ", ".join(f"r{r.get('round')} {r.get('arm')} {r.get('error', r.get('code'))}" for r in bad))
    data = {}
    print("\n| arm | n | median | Q1 | Q3 | IQR | p95 | min - max | median .118 (n) | median .169 (n) |")
    print("|---|---:|---:|---:|---:|---:|---:|---|---|---|")
    for a in arms:
        rs = [r for r in ok if r["arm"] == a]
        xs = [round(r["watch"]["first_byte"]) for r in rs]
        data[a] = xs
        q1, med, q3 = quartiles(xs)
        p95 = sorted(xs)[max(0, round(0.95 * len(xs)) - 1)]
        by = {}
        for r in rs:
            by.setdefault(r.get("node"), []).append(r["watch"]["first_byte"])
        bn = [f"{round(statistics.median(by[n]))} ({len(by[n])})" if n in by else "-" for n in ("10.0.1.118", "10.0.1.169")]
        print(f"| {a} | {len(xs)} | **{med:g}** | {q1:g} | {q3:g} | {q3 - q1:g} | {p95} | {min(xs)} - {max(xs)} | {bn[0]} | {bn[1]} |")
    a, b = (data[x] for x in arms)
    qa, qb = quartiles(a), quartiles(b)
    overlap = not (qa[2] < qb[0] or qb[2] < qa[0])
    p = stats.exact_p([float(x) for x in a], [float(x) for x in b])
    print(f"\n{arms[0]} - {arms[1]}: HL {hl(a, b):+.0f} ms, 95% CI {hl_ci(a, b)}, Mann-Whitney p={p:.3f}, "
          f"IQRs {'overlap' if overlap else 'SEPARATE'}")
    if overlap:
        verdict = "tie"
    else:
        verdict = f"{'Node' if qa[1] < qb[1] else 'Bun'} faster"
    print(f"VERDICT (IQR rule): {verdict}")
    print("\nSamples (round: ms node, wake start)")
    print(f"| round | {arms[0]} | {arms[1]} |\n|---:|---|---|")
    for rnd in sorted({r["round"] for r in rows}):
        cells = []
        for x in arms:
            r = next((r for r in rows if r["round"] == rnd and r["arm"] == x), None)
            if r is None or r not in ok:
                cells.append("invalid" if r else "-")
            else:
                cells.append(f"{round(r['watch']['first_byte'])} (.{r['node'].rsplit('.', 1)[1]}, {r.get('wall_start', '')[11:19]}Z)")
        print(f"| {rnd} | {cells[0]} | {cells[1]} |")


main()
