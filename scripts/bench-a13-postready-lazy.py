#!/usr/bin/env python3
# A13 (ADR-0042): node standalone entry post-readiness first-request lazy cost.
# Methodology mirror of the vinext measurement: post-readiness, first request,
# warm image. Wake via /api/health (Knative queues it until Ready; the app
# graph is untouched), then the FIRST GET / on the fresh, ready process pays
# whatever lazy evaluation the node entry defers — warm renders are the
# baseline. lazy = first - min(warm1, warm2).
import subprocess, time, json, urllib.request

KCTX = ["kubectl", "--context", "context-ckmva7v7zvq"]
URL = "http://fm-node.default.51.170.86.139.sslip.io"
N = 8
results = []


def pods():
    out = subprocess.run(
        KCTX + ["get", "pods", "-l", "serving.knative.dev/service=fm-node", "-o", "json"],
        capture_output=True, text=True,
    ).stdout
    return json.loads(out)["items"] if out.strip() else []


def timed_get(path):
    t0 = time.monotonic()
    req = urllib.request.Request(URL + path, headers={"User-Agent": "a13-bench"})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
        return (time.monotonic() - t0) * 1000, r.status, r.headers.get("x-nextjs-cache", "-"), len(body)


for i in range(1, N + 1):
    while pods():
        time.sleep(5)
    time.sleep(10)  # settle after the last pod is gone

    wake_ms, ws, _, _ = timed_get("/api/health")
    f_ms, fs, fc, fb = timed_get("/dashboard")
    w1_ms, s1, c1, _ = timed_get("/dashboard")
    w2_ms, s2, c2, _ = timed_get("/dashboard")

    pull = "?"
    p = pods()
    if p:
        name = p[0]["metadata"]["name"]
        ev = subprocess.run(
            KCTX + ["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"],
            capture_output=True, text=True,
        ).stdout
        items = json.loads(ev).get("items", []) if ev.strip() else []
        msgs = [e["message"] for e in items if e.get("reason") in ("Pulled", "Pulling")]
        pull = "; ".join(msgs)[:140]

    warm = min(w1_ms, w2_ms)
    row = dict(
        cycle=i, wake_ms=round(wake_ms), first_ms=round(f_ms),
        warm1_ms=round(w1_ms), warm2_ms=round(w2_ms), lazy_ms=round(f_ms - warm),
        wake_status=ws, first_status=fs, first_cache=fc, first_bytes=fb, pull=pull,
    )
    results.append(row)
    print(json.dumps(row), flush=True)

lazies = sorted(r["lazy_ms"] for r in results)
firsts = sorted(r["first_ms"] for r in results)
warms = sorted(min(r["warm1_ms"], r["warm2_ms"]) for r in results)
print(json.dumps(dict(
    median_lazy_ms=lazies[len(lazies) // 2],
    median_first_ms=firsts[len(firsts) // 2],
    median_warm_ms=warms[len(warms) // 2],
    lazies=lazies,
)), flush=True)
