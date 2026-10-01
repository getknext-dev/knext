#!/usr/bin/env python3
"""Per-phase A/B tables with a Holm-corrected family (2026-10-01 GKE runtime + minimisation sitting).

    python3 compare.py <run.jsonl>[,<run2.jsonl>...] <A>:<B>[,<A2>:<B2>...] [--family=phases|total]
                       [--phases=1,2,3,4,5,6,T,5z] [--json=out.json]

Each comparison is arm B minus arm A (A is the reference), per phase, using
../analyze.py's milestones and ../stats.py's exact Mann-Whitney + bootstrap CI.
Holm correction runs across EVERY p-value printed by one invocation (all pairs x
all phases listed), so the family is exactly what the table shows.

An arm may carry a node-pool filter, `arm@pool`, which keeps only the wakes whose
`node` name contains `pool` (used for the machine-family block, where one NextApp
is woken alternately on two node pools).
"""
import json
import pathlib
import statistics
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import analyze  # noqa: E402
import stats  # noqa: E402

PHASES = {
    "1": ("1 activation", None, "pod_added"),
    "2": ("2 scheduling", "pod_added", "pod_bound"),
    "3": ("3 sandbox + containers", "pod_bound", "ctr_first_log"),
    "4": ("4 runtime boot", "ctr_first_log", "app_listening"),
    "5": ("5 listening -> ready", "app_listening", "qp_ready"),
    "6": ("6 forward + render", "qp_ready", "first_byte"),
    "T": ("total request -> first byte", None, "first_byte"),
    "5z": ("5z app: listening -> first /api/health 200", "app_listening", "app_health_same_node"),
    "34": ("3+4 bound -> listening", "pod_bound", "app_listening"),
    "56": ("5+6 listening -> first byte", "app_listening", "first_byte"),
    "B": ("bound -> first byte", "pod_bound", "first_byte"),
}


def load(paths):
    rows = []
    for p in paths.split(","):
        rows += [json.loads(line) for line in open(p) if line.strip()]
    ok = [r for r in rows if "error" not in r and r.get("code") == 200 and r.get("marker")]
    return ok, len(rows) - len(ok)


def select(rows, spec):
    arm, _, pool = spec.partition("@")
    # drive.py records a placed wake's arm as the full `arm@pool` spec.
    return [r for r in rows if r["arm"] in (arm, spec) and (not pool or pool in r.get("node", ""))]


def values(rows, key):
    _, a, b = PHASES[key]
    out = []
    for r in rows:
        m = analyze.milestones(r)
        v = analyze.dur(m, a, b)
        if v is not None:
            out.append(v)
    return out


def iqr(xs):
    s = analyze.q(xs)
    return s["q3"] - s["q1"] if s else None


def holm(ps):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    adj, running = [0.0] * len(ps), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(ps) - rank) * ps[i]))
        adj[i] = running
    return adj


def main():
    rows, bad = load(sys.argv[1])
    pairs = [p.split(":") for p in sys.argv[2].split(",")]
    keys = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--phases=")), "1,2,3,4,5,6,T,5z").split(",")
    out_json = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--json=")), None)
    results = []
    for a, b in pairs:
        ra, rb = select(rows, a), select(rows, b)
        for k in keys:
            va, vb = values(ra, k), values(rb, k)
            if len(va) < 3 or len(vb) < 3:
                continue
            c = stats.compare(vb, va)  # B - A
            results.append(dict(A=a, B=b, phase=PHASES[k][0], key=k, nA=len(va), nB=len(vb),
                                medA=statistics.median(va), iqrA=iqr(va), medB=statistics.median(vb), iqrB=iqr(vb),
                                diff=c["diff"], p=c["p"], ci=c["ci"]))
    for r, ph in zip(results, holm([r["p"] for r in results])):
        r["p_holm"] = ph
    print(f"excluded rows: {bad}; Holm family size: {len(results)}")
    cur = None
    for r in results:
        if (r["A"], r["B"]) != cur:
            cur = (r["A"], r["B"])
            print(f"\n#### {r['B']} vs {r['A']} (n={r['nB']} vs {r['nA']})\n")
            print(f"| phase | {r['A']} median · IQR | {r['B']} median · IQR | diff (B−A) | p | p Holm | 95% CI |")
            print("|---|---|---|---|---|---|---|")
        print(f"| {r['phase']} | {r['medA']:.0f} · {r['iqrA']:.0f} | {r['medB']:.0f} · {r['iqrB']:.0f} | "
              f"{r['diff']:+.0f} | {r['p']:.2g} | {r['p_holm']:.2g} | [{r['ci'][0]:+.0f}, {r['ci'][1]:+.0f}] |")
    if out_json:
        json.dump(results, open(out_json, "w"), indent=1)


if __name__ == "__main__":
    main()
