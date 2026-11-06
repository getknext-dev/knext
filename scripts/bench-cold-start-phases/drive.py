#!/usr/bin/env python3
"""Interleaved per-phase cold-start driver (runs on the operator's workstation).

    python3 drive.py <rounds> <arm1,arm2,...> <out.jsonl> [--dns] [--heal=<arm>] [settings]

Each round: wait until EVERY arm has zero pods (+10 s for endpoints to settle),
then wake each arm once, serially, rotating the order by one each round (AB BA
for two arms, ABC BCA CAB for three). One wake = one `cold-cycle.mjs` run inside
the in-cluster harness pod (all timing happens there; the kubectl exec
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

An arm written `arm@pool` is placed on that node pool: every other pool's nodes
are cordoned for the wake (running pods are untouched; DaemonSets tolerate
cordons) and everything is uncordoned when the run ends. The pool is read from
the node label named by --pool-label.

--place-mode=restore changes that for a run that must not disturb the cluster's cordons (for example
one node of the pool is running a patched kubelet and has to stay closed to other workloads):
  - it reads every node's cordon state first and puts each managed node back to exactly that state
    after every wake and when the run ends, so a node that started cordoned ends cordoned and a cordon
    set by anyone else is kept; nothing is ever uncordoned just because the run finished;
  - it manages only the nodes of the pools the arms name, and refuses to start if any other node is
    schedulable (the wake could land there), without touching it;
  - every arm must be written arm@pool, and a refused cordon aborts the run (no wake is made on a
    guess about where the pod would land);
  - after each wake it lists the pods that appeared on the woken node since the start and are neither
    the arms' own pods nor DaemonSet pods, and writes them to the row as foreign_new_pods.
--block=<label> tags every row with a block label (the ceiling test runs one block per kubelet binary).

Settings (cluster-specific; nothing is hard-coded). Precedence: flag, then
KNEXT_BENCH_* environment variable, then the JSON config file, then default.
See benchconfig.py and bench-config.example.json.

    --config=<file>        JSON config file
    --context=<name>       kubectl context (default: kubectl's current context)
    --namespace=<name>     namespace of the arms and the harness pod (default: kubectl's)
    --pod=<name>           harness pod (default phase-bench; PHASE_POD also works)
    --container=<name>     harness container (default harness)
    --scratch-dir=<dir>    scratch directory on the harness pod (default /tmp)
    --agent-pods=<json>    node name -> node-agent pod; default: find the pod
                           labelled --agent-label that runs on the woken pod's node
    --agent-label=<k=v>    node-agent pod label (default app=phase-agent)
    --pool-label=<key>     node label naming the pool, for arm@pool
    --settle=<s>           idle seconds after the zero-pod wait (default 10)
    --poll-interval=<s>    polling interval while waiting (default 3)

Cluster work is a queue of one: never run two drivers at once.
"""
import argparse
import json
import pathlib
import shlex
import signal
import subprocess
import sys
import time

import benchconfig

HERE = pathlib.Path(__file__).resolve().parent
DNS_JS = (HERE / "dns-probe.js").read_text()

TRANSIENT = ("Unable to connect", "context deadline exceeded", "i/o timeout", "EOF", "connection reset")

# Resolved from the environment and config file at import so other drivers can
# `import drive` and reuse kc()/wake(); main() re-resolves with the command-line flags.
CFG = {}
BASE = ["kubectl"]  # kubectl + --context (node-level calls)
CTX = ["kubectl"]  # kubectl + --context + -n (namespaced calls)
POD = "phase-bench"
SETTLE = 10
POLL = 3


def configure(cli=None, config_path=None):
    global CFG, BASE, CTX, POD
    CFG = benchconfig.resolve(cli, config_path=config_path)
    BASE = ["kubectl"] + (["--context", CFG["context"]] if CFG["context"] else [])
    CTX = BASE + (["-n", CFG["namespace"]] if CFG["namespace"] else [])
    POD = CFG["pod"]


configure()


def scratch(name):
    return f"{CFG['scratch_dir'].rstrip('/')}/{name}"


def kc(args, check=True, timeout=180, tries=5, base=None):
    """kubectl with retries: the workstation's path to the apiserver drops
    connections intermittently. Only the idempotent calls go through here; the
    timed harness exec does not retry (see wake)."""
    for i in range(tries):
        p = subprocess.run((base or CTX) + args, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 or not any(m in p.stderr for m in TRANSIENT):
            break
        time.sleep(3 * (i + 1))
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, args, p.stdout, p.stderr)
    return p.stdout


def install_harness():
    """Copy cold-cycle.mjs onto the harness pod."""
    kc(["cp", str(HERE / "cold-cycle.mjs"), f"{POD}:{scratch('cold-cycle.mjs')}", "-c", CFG["container"]])


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
        time.sleep(POLL)
    raise SystemExit("timeout waiting for zero pods")


def wait_zero_or_bound(arm):
    """After a placed wake the pod is already bound (the harness returns after the
    first byte), so the cordon can be changed for the next arm right away; this
    only double-checks that no pod of `arm` is still Pending."""
    j = json.loads(kc(["get", "pods", "-l", f"serving.knative.dev/service={arm}", "-o", "json"]))
    if any(not p["spec"].get("nodeName") for p in j["items"]):
        time.sleep(5)


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


def harness_env(treat, arm):
    """`KEY=value ` prefix for the in-cluster harness command."""
    env = {}
    if treat:
        env["HEAL"] = "1"
        env["HEAL_BIN"] = "bun" if "bun" in arm else "node"
    if CFG["namespace"]:
        env["NS"] = CFG["namespace"]
    if CFG["agent_pods"]:
        env["AGENT_PODS"] = json.dumps(CFG["agent_pods"], separators=(",", ":"))
    env["AGENT_LABEL"] = CFG["agent_label"]
    return "".join(f"{k}={shlex.quote(v)} " for k, v in env.items())


def wake(arm, treat, seq):
    """One harness run, DETACHED inside the harness pod so a dropped
    workstation->apiserver connection cannot lose the cycle: start it with
    nohup, then poll its output file until the JSON line is complete. With
    treat=True the harness itself execs the heal (HEAL=1) — in-cluster, so its
    timing does not depend on the workstation link."""
    out = scratch(f"run-{seq}.json")
    env = harness_env(treat, arm)
    script = scratch("cold-cycle.mjs")
    launch = ["exec", POD, "-c", CFG["container"], "--", "sh", "-c",
              f"[ -e {out} ] || {{ {env}nohup node {script} {arm} > {out} 2>&1 & }}"]
    kc(launch, check=False)  # idempotent: the [ -e ] guard never starts a second run
    t = time.time()
    while time.time() - t < 240:
        time.sleep(POLL)
        raw = kc(["exec", POD, "-c", CFG["container"], "--", "sh", "-c", f"cat {out} 2>/dev/null || echo MISSING"],
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


POOLS = {}  # pool label value -> node names, filled lazily for `arm@pool` specs


def nodes_by_pool():
    if not POOLS:
        j = json.loads(subprocess.run(BASE + ["get", "nodes", "-o", "json"],
                                      capture_output=True, text=True, check=True).stdout)
        for n in j["items"]:
            pool = n["metadata"]["labels"].get(CFG["pool_label"], "?")
            POOLS.setdefault(pool, []).append(n["metadata"]["name"])
    return POOLS


def place(pool):
    """Make ONLY `pool`'s nodes schedulable for the next wake by cordoning every
    other pool's nodes. `pool=None` uncordons everything."""
    for p, names in nodes_by_pool().items():
        verb = "uncordon" if pool is None or p == pool else "cordon"
        for n in names:
            subprocess.run(BASE + [verb, n], capture_output=True, text=True)


# --place-mode=restore state. REST is what the run found; EXPECT is what this run last set (or found).
# Both are compared with the LIVE node object, never trusted: someone else may change a cordon at any time.
PLACE_MODE = "all"
MANAGED = {}  # node -> pool, only the nodes of the pools the arms name
REST = {}  # node -> cordoned at the start of the run
EXPECT = {}  # node -> cordoned, as this run last set it
SEEN_PODS = {}  # node -> {"ns/name"} present at the start
LOCK_FH = None


def state_word(cordoned):
    return "cordoned" if cordoned else "open"


def live_cordoned(node):
    j = json.loads(kc(["get", "node", node, "-o", "json"], base=BASE))
    return bool(j.get("spec", {}).get("unschedulable"))


def changed_by_others():
    """Managed nodes whose live cordon state is not what this run set: [(node, expected, found)]."""
    out = []
    for name in MANAGED:
        live = live_cordoned(name)
        if live != EXPECT[name]:
            out.append((name, EXPECT[name], live))
    return out


def check_unchanged():
    bad = changed_by_others()
    if bad:
        raise SystemExit("cordon changed by someone else, left as found, run stopped: " + "; ".join(
            f"{n} is {state_word(f)}, this run left it {state_word(e)}" for n, e, f in bad))


def set_cordon(node, want):
    """Cordon or uncordon `node`, then read it back. A call that reports failure but took effect (a lost
    response) counts as done; a call that reports success but did not take effect does not."""
    verb = "cordon" if want else "uncordon"
    p = subprocess.run(BASE + [verb, node], capture_output=True, text=True)
    live = live_cordoned(node)
    if live != want:
        why = p.stderr.strip() or "the node is not " + state_word(want) + " afterwards"
        return f"cannot {verb} {node}: {why}"
    EXPECT[node] = want
    return None


def node_pods(node):
    j = json.loads(kc(["get", "pods", "-A", "--field-selector", f"spec.nodeName={node}", "-o", "json"],
                      base=BASE))
    return j["items"]


def take_lock(path):
    """One restore-mode driver per workstation: a second one would read the first one's open nodes as rest."""
    global LOCK_FH
    import fcntl
    LOCK_FH = open(path, "w")
    try:
        fcntl.flock(LOCK_FH, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit(f"another restore-mode driver holds {path}; cluster work is a queue of one")


def restore_begin(arms, expect_state=None):
    """Snapshot cordon state and pods of the managed nodes; refuse if the pin cannot hold."""
    if any("@" not in x for x in arms):
        raise SystemExit("--place-mode=restore pins by pool: every arm must be written arm@pool")
    pools = {x.partition("@")[2] for x in arms}
    j = json.loads(kc(["get", "nodes", "-o", "json"], base=BASE))
    open_outside = []
    for n in j["items"]:
        name = n["metadata"]["name"]
        pool = n["metadata"]["labels"].get(CFG["pool_label"], "?")
        cordoned = bool(n.get("spec", {}).get("unschedulable"))
        if pool in pools:
            MANAGED[name] = pool
            REST[name] = EXPECT[name] = cordoned
        elif not cordoned:
            open_outside.append(name)
    if open_outside:
        raise SystemExit("node(s) outside the arms' pools are schedulable, so a wake could land there: "
                         + ", ".join(open_outside) + ". Nothing was changed; cordon them first, by hand.")
    missing = pools - set(MANAGED.values())
    if missing:
        raise SystemExit("no node carries pool " + ", ".join(sorted(missing)))
    # A previous driver killed in the middle of a wake leaves the woken node open and the other closed,
    # and a fresh snapshot would take that for the rest state. The expected state is the guard.
    for item in (expect_state or "").split(","):
        if not item:
            continue
        node, _, word = item.partition(":")
        if word not in ("cordoned", "open") or node not in MANAGED:
            raise SystemExit(f"bad --expect-state entry {item!r}; expected node:cordoned or node:open "
                             "for a managed node")
        if REST[node] != (word == "cordoned"):
            raise SystemExit(f"{node} is {state_word(REST[node])} but --expect-state says {word}: a "
                             "previous run may have died mid-wake. Nothing was changed; fix it by hand.")
    for name in MANAGED:
        SEEN_PODS[name] = {f"{p['metadata']['namespace']}/{p['metadata']['name']}" for p in node_pods(name)}


def place_restore(pool):
    """Cordons first, then the uncordon, so the pool being woken is never open alongside another."""
    check_unchanged()
    for want in (True, False):
        for name, p in MANAGED.items():
            if (p != pool) == want and EXPECT[name] != want:
                err = set_cordon(name, want)
                if err:
                    raise SystemExit(err)


def recovery_commands():
    """The exact commands that put every managed node back to the state found at the start."""
    return "; ".join(" ".join(BASE + ["cordon" if was else "uncordon", name]) for name, was in sorted(REST.items()))


def rest():
    """Put every managed node back to the state it had at the start, unless someone else changed it since
    this run set it: that node is left alone and reported. Never raises anything but SystemExit: an API
    outage while restoring (kc gives up after about 45 s) is reported with the exact recovery commands,
    not as a traceback. Reports every failure, then exits 1."""
    failed = []
    for want in (True, False):
        for name, was in REST.items():
            if was != want:
                continue
            try:
                live = live_cordoned(name)
                if live != EXPECT[name]:
                    failed.append(f"{name} is {state_word(live)}, this run left it {state_word(EXPECT[name])}; "
                                  "not touched")
                elif live != was:
                    err = set_cordon(name, was)
                    if err:
                        failed.append(err)
            except Exception as e:  # noqa: BLE001 - whatever the API outage raised
                failed.append(f"{name}: could not read or change it ({type(e).__name__})")
    if failed:
        print("RESTORE FAILED, fix by hand: " + "; ".join(failed), file=sys.stderr, flush=True)
        print("Rest state to set by hand: " + recovery_commands(), file=sys.stderr, flush=True)
        raise SystemExit(1)


def foreign_new_pods(node, arm_names):
    out = []
    for p in node_pods(node):
        key = f"{p['metadata']['namespace']}/{p['metadata']['name']}"
        owners = {o.get("kind") for o in p["metadata"].get("ownerReferences") or []}
        svc = (p["metadata"].get("labels") or {}).get("serving.knative.dev/service")
        if key in SEEN_PODS.get(node, ()) or "DaemonSet" in owners or svc in arm_names:
            continue
        out.append(key)
    return sorted(out)


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="drive.py", description="Interleaved per-phase cold-start driver.")
    ap.add_argument("rounds", type=int)
    ap.add_argument("arms", help="comma-separated arms; arm@pool pins an arm to a node pool")
    ap.add_argument("out", help="JSONL output file (appended)")
    ap.add_argument("--dns", action="store_true")
    ap.add_argument("--heal", metavar="ARM")
    ap.add_argument("--config")
    ap.add_argument("--context")
    ap.add_argument("--namespace")
    ap.add_argument("--pod")
    ap.add_argument("--container")
    ap.add_argument("--scratch-dir", dest="scratch_dir")
    ap.add_argument("--agent-pods", dest="agent_pods")
    ap.add_argument("--agent-label", dest="agent_label")
    ap.add_argument("--pool-label", dest="pool_label")
    ap.add_argument("--place-mode", dest="place_mode", choices=("all", "restore"), default="all")
    ap.add_argument("--block", default=None, help="label written to every row")
    ap.add_argument("--expect-state", dest="expect_state", default=None,
                    help="restore mode: node:cordoned|open,... required at start, else refuse")
    ap.add_argument("--lock-file", dest="lock_file", default=None,
                    help="restore mode: lock file, default in the temp directory")
    ap.add_argument("--abort-on-foreign", dest="abort_on_foreign", default="",
                    help="restore mode: comma-separated pools; a foreign new pod on one stops the run")
    ap.add_argument("--abort-failed-fraction", dest="abort_failed_fraction", type=float, default=None,
                    help="stop when failed wakes exceed this fraction of the planned wakes")
    ap.add_argument("--settle", type=float, default=10)
    ap.add_argument("--poll-interval", dest="poll", type=float, default=3)
    return ap.parse_args(argv)


def main(argv=None):
    global SETTLE, POLL, PLACE_MODE
    a = parse_args(sys.argv[1:] if argv is None else argv)
    cli = {k: getattr(a, k) for k in ("context", "namespace", "pod", "container", "scratch_dir",
                                      "agent_pods", "agent_label", "pool_label")}
    configure(cli, config_path=a.config)
    SETTLE, POLL = a.settle, a.poll
    PLACE_MODE = a.place_mode
    arms = a.arms.split(",")
    if PLACE_MODE == "restore":
        # SIGTERM and SIGHUP (a closed terminal) must run the restore below, as Ctrl-C does. SIGKILL
        # cannot be caught; --expect-state is the guard for the next run.
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, lambda n, *_: sys.exit(128 + n))
        import os
        import tempfile
        take_lock(a.lock_file or os.path.join(tempfile.gettempdir(), "knext-bench-drive.lock"))
    code = 0
    try:
        if PLACE_MODE == "restore":
            restore_begin(arms, a.expect_state)
        run(a.rounds, arms, a.out, a.dns, a.heal, block=a.block,
            abort_on_foreign=[x for x in a.abort_on_foreign.split(",") if x],
            abort_failed_fraction=a.abort_failed_fraction)
    except SystemExit as e:
        # Say why the run stopped before the restore below, which may stop it again with its own message.
        if isinstance(e.code, str):
            print(e.code, file=sys.stderr, flush=True)
            code = 1
        else:
            code = e.code or 0
    except Exception as e:  # noqa: BLE001
        if PLACE_MODE != "restore":
            raise
        # No traceback in restore mode: say what failed, then the finally below restores the cordons.
        print(f"driver error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        code = 1
    finally:
        if PLACE_MODE == "restore":
            if MANAGED:
                rest()
        elif any("@" in x for x in arms):
            place(None)
    if code:
        sys.exit(code)


def run(rounds, arms, out, do_dns=False, heal_arm=None, block=None, abort_on_foreign=(),
        abort_failed_fraction=None):
    install_harness()
    planned, failed_wakes = rounds * len(arms), 0
    with open(out, "a") as f:
        for r in range(rounds):
            # Rotate the order each round (AB BA for two arms; ABC BCA CAB for
            # three), so every arm takes every wake slot equally often. The slot
            # matters: the scheduler places successive wakes on alternating nodes.
            k = r % len(arms)
            order = arms[k:] + arms[:k]
            waited = wait_zero(sorted({x.split("@")[0] for x in arms}))
            time.sleep(SETTLE)
            for spec in order:
                arm, _, pool = spec.partition("@")
                if pool:
                    place_restore(pool) if PLACE_MODE == "restore" else place(pool)
                treat = arm == heal_arm and r % 2 == 1
                row = wake(arm, treat, f"{int(time.time())}-{arm}")
                if pool:
                    row["arm"] = spec
                    row["pool"] = pool
                    wait_zero_or_bound(arm)
                    if PLACE_MODE == "restore":
                        foreign = sorted({k for n, p in MANAGED.items() if p == pool
                                          for k in foreign_new_pods(n, {x.split("@")[0] for x in arms})})
                        row["foreign_new_pods"] = foreign
                        if foreign:
                            print(f"FOREIGN POD on pool {pool}: {', '.join(foreign)}", file=sys.stderr, flush=True)
                if block is not None:
                    row["block"] = block
                row.update(round=r + 1, order="fwd" if r % 2 == 0 else "rev", waited_s=waited,
                           treatment="heal" if treat else "none")
                if do_dns and "error" not in row:
                    row["dns"] = dns_probe(arm, "bun" if "bun" in arm else "node")
                f.write(json.dumps(row) + "\n")
                f.flush()
                w = row.get("watch", {})
                print(r + 1, arm, row.get("code"), row.get("node"), "end", w.get("resp_end"),
                      "ready", w.get("cond_Ready"), "qp_ok", w.get("qp_probe_ok"), row.get("error", "")[:120], flush=True)
                if PLACE_MODE == "restore" and pool:
                    rest()  # after the row is on disk: a refused restore must not lose the wake
                    if row.get("foreign_new_pods") and pool in abort_on_foreign:
                        raise SystemExit(f"stopping: foreign pod(s) appeared on pool {pool}: "
                                         f"{', '.join(row['foreign_new_pods'])}")
                if abort_failed_fraction is not None:
                    if row.get("error") or w.get("first_byte") is None:
                        failed_wakes += 1
                    if failed_wakes > abort_failed_fraction * planned:
                        raise SystemExit(f"stopping: {failed_wakes} failed wakes of {planned} planned, over "
                                         f"{abort_failed_fraction:.0%}")


if __name__ == "__main__":
    main()
