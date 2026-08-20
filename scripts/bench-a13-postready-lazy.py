#!/usr/bin/env python3
# A13 (ADR-0042): node standalone entry post-readiness first-request lazy cost.
# A13's terms: post-readiness, first request, warm image. Wake via /api/health
# (Knative queues it until Ready). The wake is NOT app-graph-free — the health
# route evaluates its own slice — but it is production-faithful: the operator
# wires the readiness probe to the same path (absent spec.healthCheckPath), so
# Ready already implies that slice ran. The FIRST GET of the measured page on
# the fresh, ready process then pays the incremental residue; warm renders are
# the baseline. lazy = first - min(warm1, warm2).
# Usage: python3 bench-a13-postready-lazy.py [path]   (default /dashboard)
import statistics, subprocess, sys, time, json, urllib.error, urllib.request

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


def timed_get(path):
    # Workstation-side SYN timeouts (Errno 60, ~75s) happen intermittently on
    # some network paths. A connect that NEVER completed sent nothing to the
    # activator, so retrying is still a genuine cold wake; the retry count is
    # recorded so a row can state it. (This loop was first added mid-sitting in
    # a scratchpad copy on 2026-08-20 — the discarded sitting in the ledger's
    # row-2 block ran on that copy; committing it here closes the provenance.)
    last = None
    for attempt in range(3):
        t0 = time.monotonic()
        req = urllib.request.Request(URL + path, headers={"User-Agent": "a13-bench"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
                return (time.monotonic() - t0) * 1000, r.status, r.headers.get("x-nextjs-cache", "-"), len(body)
        except urllib.error.HTTPError:
            raise  # a response arrived: the wake already fired — retrying would measure a warming pod
        except OSError as e:
            # Retry ONLY the never-connected class (macOS connect ETIMEDOUT,
            # errno 60, observed as ~75s SYN exhaustion): nothing reached the
            # activator, so the retry is still a genuine cold wake. A read
            # timeout / reset / refused AFTER connecting means the request
            # arrived — those raise, because retrying under-reports wake/first
            # against an already-warming pod.
            reason = getattr(e, "reason", e)
            errno_ = getattr(reason, "errno", None)
            if errno_ != 60:
                raise
            RETRIES["n"] += 1
            print(json.dumps(dict(retry=path, attempt=attempt + 1, cls="connect-etimedout", err=str(e)[:80])), flush=True)
            last = e
    raise last


for i in range(1, N + 1):
    while pods():
        time.sleep(5)
    time.sleep(10)  # settle after the last pod is gone

    wake_ms, ws, _, _ = timed_get("/api/health")
    f_ms, fs, fc, fb = timed_get(MEASURED_PATH)
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
print(json.dumps(dict(
    median_wake_ms=statistics.median(wakes),
    median_lazy_ms=statistics.median(lazies),
    median_first_ms=statistics.median(firsts),
    median_warm_ms=statistics.median(warms),
    lazies=lazies,
    workstation_retries=RETRIES["n"],
)), flush=True)
