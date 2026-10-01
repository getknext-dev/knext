#!/usr/bin/env python3
"""Per-phase tables from harness JSONL.

    python3 analyze.py run.jsonl [--by-node] [--by-treatment] [--rows]
                       [--activator=activator.jsonl] [--autoscaler=autoscaler.jsonl]

Milestones (ms after the request was sent, harness clock; node-side stamps are
re-based with the per-cycle measured clock offset):

  autoscaler_scale  autoscaler log "PA scale got=0, want=1"  (optional log join)
  pod_added         watch: Pod ADDED            (activator -> autoscaler -> Deployment -> ReplicaSet -> Pod)
  pod_bound         watch: spec.nodeName set    (scheduler)
  ctr_first_log     CRI-O stamp of the first line either container wrote (processes running)
  app_listening     CRI-O stamp of Next's "Ready in" line (server bound :3000)
  kubelet_reports_ip  watch: status.podIP first visible (kubelet status sync)
  qp_ready          earliest of: harness's activator-style probe of queue-proxy got 200,
                    pod Ready condition seen on the watch, first response byte
  first_byte        client: first response byte

The control-plane logs (`kubectl -n knative-serving logs deploy/activator`,
`deploy/autoscaler`) are joined to each cycle by revision name and time. Every
cycle's measured node-clock offset was < 1 ms, so their stamps are used as-is.
"""
import datetime
import json
import statistics
import sys

CP = {"activator": [], "autoscaler": []}


def load_cp(kind, path):
    for line in open(path):
        if not line.startswith("{"):
            continue
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = j.get("knative.dev/key", "")
        if "bench-cells/" not in key:
            continue
        base, _, frac = j.get("timestamp", "").rstrip("Z").partition(".")
        t = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()
        CP[kind].append((t * 1000 + (float("0." + frac) * 1000 if frac else 0), key.split("/", 1)[1], j.get("message", "")))
    CP[kind].sort()


def cp_first(kind, rev, t0, pred, within_ms=20000):
    for t, k, m in CP[kind]:
        if k == rev and t0 - 50 <= t <= t0 + within_ms and pred(m):
            return round(t - t0, 1)
    return None


def q(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    lo, hi = xs[: n // 2], xs[(n + 1) // 2:]
    return dict(n=n, med=statistics.median(xs), q1=statistics.median(lo) if lo else xs[0],
                q3=statistics.median(hi) if hi else xs[-1], min=xs[0], max=xs[-1])


def first_log(logs, pred):
    for x in logs:
        if "t" in x and pred(x.get("line", "")):
            return x["t"]
    return None


def milestones(r):
    w = r["watch"]
    lu = r["logs"].get("user-container", [])
    lq = r["logs"].get("queue-proxy", [])
    firsts = [x["t"] for x in (lu[:1] + lq[:1]) if "t" in x]
    ready = [v for v in (w.get("qp_probe_ok"), w.get("cond_Ready"), w.get("first_byte")) if v is not None]
    t0 = datetime.datetime.fromisoformat(r["wall_start"].replace("Z", "+00:00")).timestamp() * 1000
    rev = r["pod"].split("-deployment-")[0]
    return dict(
        autoscaler_scale=cp_first("autoscaler", rev, t0, lambda m: m.startswith("PA scale got=0, want=1")),
        pod_added=w.get("pod_added"),
        pod_bound=w.get("pod_bound"),
        ctr_first_log=min(firsts) if firsts else None,
        app_listening=first_log(lu, lambda l: "Ready in" in l),
        kubelet_reports_ip=w.get("pod_ip"),
        app_tcp_cross_node=w.get("app_tcp_3000"),
        app_tcp_same_node=w.get("same_node_tcp_3000"),
        app_health_same_node=w.get("same_node_health_ok"),
        activator_first_probe=cp_first("activator", rev, t0, lambda m: m.startswith("Failed probing pods")),
        activator_routes=cp_first("activator", rev, t0,
                                  lambda m: "Updating Revision Throttler" in m and "backends = 1" in m),
        qp_ready=min(ready) if ready else None,
        first_byte=w.get("first_byte"),
    )


PHASES = [
    ("0 autoscaler decides 0->1 (log; inside phase 1)", None, "autoscaler_scale"),
    ("1 activation: request -> Pod object", None, "pod_added"),
    ("2 scheduling: Pod -> bound to node", "pod_added", "pod_bound"),
    ("3 sandbox + containers start: bound -> first log line", "pod_bound", "ctr_first_log"),
    ("4 runtime boot: first log -> Next listening", "ctr_first_log", "app_listening"),
    ("5 routable: listening -> ready", "app_listening", "qp_ready"),
    ("6 forward + render: ready -> first byte", "qp_ready", "first_byte"),
    ("total: request -> first byte", None, "first_byte"),
]
EXTRA = [
    ("  5x kubelet status lag: first log -> pod IP visible in API", "ctr_first_log", "kubelet_reports_ip"),
    ("  5y net: first log -> TCP :3000 from the other node", "ctr_first_log", "app_tcp_cross_node"),
    ("  5y net: first log -> TCP :3000 from the same node", "ctr_first_log", "app_tcp_same_node"),
    ("  5z app: listening -> /api/health 200 (same node, direct)", "app_listening", "app_health_same_node"),
    ("  5w activator: first log -> activator marks pod healthy", "ctr_first_log", "activator_routes"),
]


def dur(m, a, b):
    if m.get(b) is None or (a and m.get(a) is None):
        return None
    return m[b] - (m[a] if a else 0)


def table(rows, title):
    ms = [milestones(r) for r in rows]
    print(f"\n### {title} (n={len(rows)})\n")
    print("| phase | median ms | IQR [Q1, Q3] | min–max |")
    print("|---|---|---|---|")
    for label, a, b in PHASES + EXTRA:
        s = q([dur(m, a, b) for m in ms])
        if s:
            print(f"| {label} | {s['med']:.0f} | {s['q3'] - s['q1']:.0f} [{s['q1']:.0f}, {s['q3']:.0f}] | "
                  f"{s['min']:.0f}–{s['max']:.0f}" + ("" if s["n"] == len(rows) else f" (n={s['n']})") + " |")


def main():
    for a in sys.argv:
        if a.startswith("--activator="):
            load_cp("activator", a.split("=", 1)[1])
        if a.startswith("--autoscaler="):
            load_cp("autoscaler", a.split("=", 1)[1])
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    bad = [r for r in rows if "error" in r or r.get("code") != 200 or not r.get("marker")]
    rows = [r for r in rows if r not in bad]
    print(f"valid {len(rows)}, excluded {len(bad)}: "
          f"{[(b.get('round'), b.get('arm'), str(b.get('error', b.get('code')))[:80]) for b in bad]}")
    groups = {}
    for r in rows:
        key = r["arm"] + (f" [{r.get('treatment')}]" if "--by-treatment" in sys.argv else "")
        groups.setdefault(key, []).append(r)
    for key in sorted(groups):
        table(groups[key], key)
        if "--by-node" in sys.argv:
            for node in sorted({r["node"] for r in groups[key]}):
                table([r for r in groups[key] if r["node"] == node], f"{key} on {node}")
    if "--rows" in sys.argv:
        cols = list(milestones(rows[0]))
        print("\n| round | arm | treatment | node | pod IP | " + " | ".join(cols) + " | clock offset/RTT ms |")
        print("|" + "---|" * (len(cols) + 6))
        for r in rows:
            m = milestones(r)
            print(f"| {r['round']} | {r['arm']} | {r.get('treatment', 'none')} | {r['node']} | {r.get('pod_ip_addr', '')} | "
                  + " | ".join("" if v is None else f"{v:.0f}" for v in m.values())
                  + f" | {r['clock']['offset_ms']}/{r['clock']['rtt_ms']} |")


if __name__ == "__main__":
    main()
