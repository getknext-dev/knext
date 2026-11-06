# Cold-start phase harness

One harness measures the per-phase cold start of a Knative Service on any cluster:

- `cold-cycle.mjs` runs inside the cluster (one cold cycle per run, prints one JSON line).
- `drive.py` runs on your workstation, wakes arms in an interleaved order and collects the lines.
- `analyze.py`, `stats.py` turn the JSONL into phase tables and two-sample comparisons.

Nothing about a particular cluster is hard-coded. Cluster-specific settings come from, in order of
precedence: a command-line flag, a `KNEXT_BENCH_*` environment variable, the JSON config file, then
the default.

## Settings

| Setting | Flag | Environment | Config key | Default |
|---|---|---|---|---|
| kubectl context | `--context` | `KNEXT_BENCH_CONTEXT` | `context` | kubectl's current context |
| Namespace | `--namespace` | `KNEXT_BENCH_NAMESPACE` | `namespace` | kubectl's current namespace |
| Harness pod | `--pod` | `KNEXT_BENCH_POD` (or `PHASE_POD`) | `harnessPod` | `phase-bench` |
| Harness container | `--container` | `KNEXT_BENCH_CONTAINER` | `harnessContainer` | `harness` |
| Scratch directory on the pod | `--scratch-dir` | `KNEXT_BENCH_SCRATCH_DIR` | `scratchDir` | `/tmp` |
| Node name to agent pod | `--agent-pods` (JSON) | `KNEXT_BENCH_AGENT_PODS` | `agentPods` | none: the agent is the pod with `--agent-label` on that node |
| Agent pod label | `--agent-label` | `KNEXT_BENCH_AGENT_LABEL` | `agentLabel` | `app=phase-agent` |
| Node pool label (for `arm@pool`) | `--pool-label` | `KNEXT_BENCH_POOL_LABEL` | `nodePoolLabel` | `cloud.google.com/gke-nodepool` |

The config file is `--config=<file>`, else `$KNEXT_BENCH_CONFIG`, else `bench-config.json` next to
`drive.py` (git-ignored). Copy [`bench-config.example.json`](bench-config.example.json) and edit it. An
unknown key is an error, so a typo cannot silently fall back to a default.

`analyze.py` and `stats.py` read the namespace the same way and use it to keep only that
namespace's control-plane log lines. With no namespace set they join log lines to a cycle by
revision name alone.

## Running

```bash
cp bench-config.example.json bench-config.json   # edit context, namespace, agent map
python3 drive.py 11 arm-a,arm-b out.jsonl
python3 drive.py 11 arm-a@pool-1,arm-a@pool-2 out.jsonl   # pin an arm to a node pool
python3 drive.py 30 a@pool-1,b@pool-2 out.jsonl --place-mode=restore --block=b1
                                  # pin by cordon, but leave every cordon as found; label the rows
python3 analyze.py out.jsonl --autoscaler=autoscaler.jsonl --activator=activator.jsonl
```

The in-cluster pieces (`node-agents.yaml`, `harness-rbac.yaml`, `phase-bench-2.yaml`, the study
NextApp manifests, and the GKE variants under `gke/`) are manifests you apply to your own cluster.
They are not templated: each records the cluster one study ran on and starts with a
`CLUSTER-SPECIFIC EXAMPLE` comment saying so. Before applying one, edit:

- `metadata.namespace` (and every `namespace:` in `harness-rbac.yaml`) to match `--namespace`;
- `spec.nodeName` on the agent and harness pods to node names from `kubectl get nodes`, and put the
  same names in the `agentPods` map (or rely on the `--agent-label` lookup);
- the kubectl context in any `kubectl --context ...` example comment to yours.
