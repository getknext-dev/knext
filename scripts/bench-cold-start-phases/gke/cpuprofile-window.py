#!/usr/bin/env python3
"""Summarise a V8 .cpuprofile (node --cpu-prof) over time (2026-10-01 GKE sitting).

    python3 cpuprofile-window.py <file.cpuprofile> [<from_s> <to_s>]

Prints a 100 ms-bucket timeline of busy vs idle samples (relative to profile
start), then, for the optional window, self time by script and by function.
Used with first-request.mjs --gap to separate "after listen" work from boot.
"""
import collections
import json
import sys

p = json.load(open(sys.argv[1]))
nodes = {n["id"]: n for n in p["nodes"]}
t, ts = p["startTime"], []
for d in p["timeDeltas"]:
    t += d
    ts.append(t)
t0 = p["startTime"]
interval_ms = (ts[-1] - ts[0]) / max(1, len(ts) - 1) / 1000

busy, idle = collections.Counter(), collections.Counter()
for s, tt in zip(p["samples"], ts):
    k = int((tt - t0) / 1e5)
    fn = nodes[s]["callFrame"]["functionName"]
    (idle if fn in ("(idle)", "(program)") else busy)[k] += 1
last = max(list(busy) + list(idle))
print(f"mean sample interval {interval_ms:.2f} ms; per 100 ms bucket: busy ms (idle ms)")
print(" ".join(f"{k / 10:.1f}s:{busy[k] * interval_ms:.0f}({idle[k] * interval_ms:.0f})" for k in range(last + 1)))

if len(sys.argv) > 3:
    lo, hi = float(sys.argv[2]) * 1e6, float(sys.argv[3]) * 1e6
    by_url, by_fn = collections.Counter(), collections.Counter()
    for s, tt in zip(p["samples"], ts):
        if lo <= tt - t0 < hi:
            cf = nodes[s]["callFrame"]
            u = cf["url"].split("/node_modules/")[-1] if cf["url"] else f"({cf['functionName']})"
            by_url[u] += 1
            by_fn[f"{cf['functionName'] or '(anon)'}  {u[-70:]}"] += 1
    print(f"\nwindow {sys.argv[2]}-{sys.argv[3]} s: {sum(by_url.values()) * interval_ms:.0f} ms sampled")
    for u, c in by_url.most_common(25):
        print(f"{c * interval_ms:8.1f} ms  {u[-120:]}")
    print("--- top functions")
    for u, c in by_fn.most_common(15):
        print(f"{c * interval_ms:8.1f} ms  {u}")
