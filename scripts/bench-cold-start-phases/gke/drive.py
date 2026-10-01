#!/usr/bin/env python3
"""GKE variant of ../drive.py (2026-10-01, docs/benchmarks/cold-start-phase-breakdown-gke-2026-10-01.md).
Only the kubectl context changed (knext-coldstart, not knext-oke-sa); the orchestration logic is
identical to the OKE harness. See cold-cycle.mjs / node-agents.yaml / harness-rbac.yaml in this
directory for the per-file adaptation notes (GKE node names are opaque, not internal IPs).

Interleaved per-phase cold-start driver (runs on the operator's workstation).

    python3 drive.py <rounds> <arm1,arm2,...> <out.jsonl> [--dns] [--heal=<arm>]

Each round: wait until EVERY arm has zero pods (+10 s for endpoints to settle),
then wake each arm once, serially, rotating the order by one each round (AB BA
for two arms, ABC BCA CAB for three). One wake = one `cold-cycle.mjs` run inside
the in-cluster `phase-bench` pod (all timing happens there; the kubectl exec
round trip is outside every timed interval). With --dns, right after the wake
the driver also execs a DNS timing script inside the freshly started app
container (dns-probe.js) — that happens AFTER the measured request completed,
so it never perturbs the cold-start numbers.

With --heal=<arm>, on EVEN rounds that arm gets the "early outbound packet"
treatment: as soon as its new pod reports user-container running, the harness
execs a one-shot DNS lookup inside the container (HEAL=1, see cold-cycle.mjs). The lookup's UDP packet makes
the pod ARP for its gateway, which refreshes the node's neighbour entry for the
pod IP (the stale-ARP hypothesis in the benchmark doc). Odd rounds are the
untreated control, so the treatment alternates ABAB on the same Knative Service.

Cluster work is a queue of one: never run two drivers at once.
"""
import json
import pathlib
import subprocess
import sys
import time

CTX = ["kubectl", "--context", "knext-coldstart", "-n", "bench-cells"]
HERE = pathlib.Path(__file__).resolve().parent
DNS_JS = (HERE / "dns-probe.js").read_text()


TRANSIENT = ("Unable to connect", "context deadline exceeded", "i/o timeout", "EOF", "connection reset")


def kc(args, check=True, timeout=180, tries=5):
    """kubectl with retries: the workstation's path to the OKE apiserver drops
    connections intermittently. Only the idempotent calls go through here; the
    timed harness exec does not retry (see wake)."""
    for i in range(tries):
        p = subprocess.run(CTX + args, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 or not any(m in p.stderr for m in TRANSIENT):
            break
        time.sleep(3 * (i + 1))
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, args, p.stdout, p.stderr)
    return p.stdout


def pod_count(arm):
    for _ in range(5):  # tolerate a transient apiserver/kubectl failure
        try:
            j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
            return len(j["items"])
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            time.sleep(2)
    raise SystemExit(f"cannot list pods for {arm}")


def wait_zero(arms, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if all(pod_count(a) == 0 for a in arms):
            return round(time.time() - t)
        time.sleep(3)
    raise SystemExit("timeout waiting for zero pods")


def dns_probe(arm, runtime):
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    if not j["items"]:
        return {"error": "pod gone"}
    name = j["items"][0]["metadata"]["name"]
    binary = "bun" if runtime == "bun" else "node"
    out = kc(["exec", name, "-c", "user-container", "--", binary, "-e", DNS_JS], check=False)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001 - record whatever came back
        return {"error": out[-300:]}


def wake(arm, treat, seq):
    """One harness run, DETACHED inside the phase-bench pod so a dropped
    workstation->apiserver connection cannot lose the cycle: start it with
    nohup, then poll its output file until the JSON line is complete. With
    treat=True the harness itself execs the heal (HEAL=1) — in-cluster, so its
    timing does not depend on the workstation link."""
    out = f"/tmp/run-{seq}.json"
    env = f"HEAL=1 HEAL_BIN={'bun' if 'bun' in arm else 'node'} " if treat else ""
    launch = ["exec", "phase-bench", "-c", "harness", "--", "sh", "-c",
              f"[ -e {out} ] || {{ {env}nohup node /tmp/cold-cycle.mjs {arm} > {out} 2>&1 & }}"]
    kc(launch, check=False)  # idempotent: the [ -e ] guard never starts a second run
    t = time.time()
    while time.time() - t < 240:
        time.sleep(3)
        raw = kc(["exec", "phase-bench", "-c", "harness", "--", "sh", "-c", f"cat {out} 2>/dev/null || echo MISSING"],
                 check=False)
        if "MISSING" in raw and time.time() - t < 30:
            kc(launch, check=False)  # the first launch never reached the pod: re-issue
        lines = [l for l in raw.strip().splitlines() if l.startswith("{")]
        if lines:
            try:
                return json.loads(lines[-1])
            except json.JSONDecodeError:
                pass  # still being written
    return {"arm": arm, "error": "harness produced no result in 240 s"}


def main():
    rounds, arms, out = int(sys.argv[1]), sys.argv[2].split(","), sys.argv[3]
    do_dns = "--dns" in sys.argv
    heal_arm = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--heal=")), None)
    kc(["cp", str(HERE / "cold-cycle.mjs"), "phase-bench:/tmp/cold-cycle.mjs", "-c", "harness"])
    with open(out, "a") as f:
        for r in range(rounds):
            # Rotate the order each round (AB BA for two arms; ABC BCA CAB for
            # three), so every arm takes every wake slot equally often. The slot
            # matters: the scheduler places successive wakes on alternating nodes.
            k = r % len(arms)
            order = arms[k:] + arms[:k]
            waited = wait_zero(arms)
            time.sleep(10)
            for arm in order:
                treat = arm == heal_arm and r % 2 == 1
                row = wake(arm, treat, f"{int(time.time())}-{arm}")
                row.update(round=r + 1, order="fwd" if r % 2 == 0 else "rev", waited_s=waited,
                           treatment="heal" if treat else "none")
                if do_dns and "error" not in row:
                    row["dns"] = dns_probe(arm, "bun" if "bun" in arm else "node")
                f.write(json.dumps(row) + "\n")
                f.flush()
                w = row.get("watch", {})
                print(r + 1, arm, row.get("code"), row.get("node"), "end", w.get("resp_end"),
                      "ready", w.get("cond_Ready"), "qp_ok", w.get("qp_probe_ok"), row.get("error", "")[:120], flush=True)


main()
