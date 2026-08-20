#!/usr/bin/env python3
# A13 (ADR-0042): node standalone entry post-readiness first-request lazy cost.
# A13's terms: post-readiness, first request, warm image.
# The timing pod (create before running; deleting it afterwards is human-gated):
#   kubectl run bench-timer --image=python:3.12-alpine --restart=Never \
#     --overrides='{"spec":{"containers":[{"name":"bench-timer","image":"python:3.12-alpine",
#     "command":["sleep","86400"],"resources":{"requests":{"cpu":"50m","memory":"64Mi"},
#     "limits":{"cpu":"200m","memory":"128Mi"}}}]}}' Wake via /api/health
# (Knative queues it until Ready). The wake is NOT app-graph-free — the health
# route evaluates its own slice — but it is production-faithful: the operator
# wires the readiness probe to the same path (absent spec.healthCheckPath), so
# Ready already implies that slice ran. The FIRST GET of the measured page on
# the fresh, ready process then pays the incremental residue; warm renders are
# the baseline. lazy = first - min(warm1, warm2).
# Usage: python3 bench-a13-postready-lazy.py [path]   (default /dashboard)
import statistics, subprocess, sys, time, json, urllib.request

KCTX = ["kubectl", "--context", "context-ckmva7v7zvq"]
URL = "http://fm-node.default.51.170.86.139.sslip.io"
MEASURED_PATH = sys.argv[1] if len(sys.argv) > 1 else "/dashboard"
N = 8
results = []


def pods():
    # check=True: a failing kubectl must ABORT, not return [] — an empty list
    # exits the wait loop and silently measures a warm pod as a cold cycle.
    out = subprocess.run(
        KCTX + ["get", "pods", "-l", "serving.knative.dev/service=fm-node", "-o", "json"],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)["items"]


RETRIES = {"n": 0}
LAST_CALL = {"issue": None, "done": None}


def timed_get(path):
    # Timing runs INSIDE the cluster (pod bench-timer) — the workstation WAN
    # proved to be the dominant noise source (SYN timeouts, 90s transfers on a
    # path that also serves 372ms probes). kubectl-exec overhead is excluded:
    # the milliseconds printed are measured in-pod around the HTTP call only.
    code = (
        "import urllib.request,time,json\n"
        "t_issue=time.time()\n"
        "t0=time.monotonic()\n"
        "r=urllib.request.urlopen('" + URL + path + "', timeout=180)\n"
        "b=r.read()\n"
        "print(json.dumps([round((time.monotonic()-t0)*1000,1), r.status, r.headers.get('x-nextjs-cache','-'), len(b), t_issue, time.time()]))\n"
    )
    last = None
    for attempt in range(3):
        p = subprocess.run(
            KCTX + ["exec", "bench-timer", "--", "python", "-c", code],
            capture_output=True, text=True,
        )
        if p.returncode == 0 and p.stdout.strip():
            ms, status, cache, blen, t_issue, t_done = json.loads(p.stdout.strip().splitlines()[-1])
            LAST_CALL["issue"], LAST_CALL["done"] = t_issue, t_done
            return ms, status, cache, blen
        RETRIES["n"] += 1
        print(json.dumps(dict(retry=path, attempt=attempt + 1, err=(p.stderr or "no output")[:100])), flush=True)
        last = RuntimeError(p.stderr[:200])
        time.sleep(2)
    raise last


for i in range(1, N + 1):
    while pods():
        time.sleep(5)
    time.sleep(10)  # settle after the last pod is gone

    wake_ms, ws, _, _ = timed_get("/api/health")
    wake_done_epoch = LAST_CALL["done"]
    # The exec gap: wall-clock between the WAKE RESPONSE completing in-pod and
    # the FIRST measured GET being ISSUED in-pod. Both stamps come from the
    # same pod's clock (time.time() printed by the in-pod snippet), so this is
    # the actual confound interval — the dead time in which post-readiness
    # lazy work can complete unmeasured (a confound toward smaller lazy
    # values; review of ledger row 2, both rounds).
    f_ms, fs, fc, fb = timed_get(MEASURED_PATH)
    exec_gap_ms = round((LAST_CALL["issue"] - wake_done_epoch) * 1000)
    w1_ms, s1, c1, _ = timed_get(MEASURED_PATH)
    w2_ms, s2, c2, _ = timed_get(MEASURED_PATH)

    pull = "?"
    p = pods()
    if p:
        name = p[0]["metadata"]["name"]
        ev = subprocess.run(
            KCTX + ["get", "events", "--field-selector", f"involvedObject.name={name}", "-o", "json"],
            capture_output=True, text=True, check=True,
        ).stdout
        items = json.loads(ev).get("items", []) if ev.strip() else []
        msgs = [e["message"] for e in items if e.get("reason") in ("Pulled", "Pulling")]
        pull = "; ".join(msgs)[:140]

    warm = min(w1_ms, w2_ms)
    row = dict(
        cycle=i, wake_ms=round(wake_ms), first_ms=round(f_ms),
        warm1_ms=round(w1_ms), warm2_ms=round(w2_ms), lazy_ms=round(f_ms - warm),
        exec_gap_ms=exec_gap_ms,
        wake_status=ws, first_status=fs, first_cache=fc, first_bytes=fb, pull=pull,
    )
    results.append(row)
    print(json.dumps(row), flush=True)

lazies = sorted(r["lazy_ms"] for r in results)
firsts = sorted(r["first_ms"] for r in results)
warms = sorted(min(r["warm1_ms"], r["warm2_ms"]) for r in results)
# statistics.median, NOT lazies[n//2]: the index form is the upper median on
# even n, and it is exactly how this record's first draft got 190/29 instead
# of 164/22. The instrument must not reproduce the defect its record corrects.
wakes = sorted(r["wake_ms"] for r in results)
gaps = sorted(r["exec_gap_ms"] for r in results)
print(json.dumps(dict(
    median_wake_ms=statistics.median(wakes),
    median_exec_gap_ms=statistics.median(gaps),
    median_lazy_ms=statistics.median(lazies),
    median_first_ms=statistics.median(firsts),
    median_warm_ms=statistics.median(warms),
    lazies=lazies,
    workstation_retries=RETRIES["n"],
)), flush=True)
