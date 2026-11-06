# Kubelet ceiling test: kind rehearsal results (2026-11-05)

Executed from `RUNBOOK.md` section 3, on a throwaway local kind cluster. **No OKE or remote cluster was
touched**; every kubectl call named `--context kind-ceiling-rehearsal` with a private kubeconfig. Nothing was
deleted, nothing was pushed to a registry. "Measured" below means observed in this run; "inferred" means
reasoned and not observed.

## Setup (measured)

| Item | Value |
|---|---|
| Cluster | `ceiling-rehearsal`: kind v0.29.0, one control-plane and one worker (`ceiling-rehearsal-worker` is P) |
| Node image | `kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d` (no v1.34.10 kind image is published: tags are 1.34.0, .2, .3, .8, .11) |
| Node OS / runtime | Debian 13, systemd 257.13, containerd 2.3.4, arm64, OrbStack kernel 7.2.12 |
| Node's own kubelet | v1.34.11, `/usr/bin/kubelet`, 56,164,617 bytes, sha256 `f1287987...c8ba`; args sha256 `c13e566e...cceb` |
| Our builds | `KUBELET_CEILING_GOARCH=arm64 build.sh <outdir>`, go1.25.12, CGO off, v1.34.10 at `bd6c4ad1...` |
| Stock (control) | `d19dc3198886ad0011cd8ed59e30b727fac5f3484f187bec4d8bb79f221fd309`, 113,433,380 bytes |
| relist100 | `c46982029810d5320e029c73b27f3b678538d65d7536b5dff349e3a98c51b9f4`, 113,433,204 bytes |

The arm64 sums are not the runbook's amd64 sums (those are for amd64). They were built once, not rebuilt to
check reproducibility. `shasum -a 256 -c SHA256SUMS` passed, and the staged copies on the node hashed
equal to them. The builds are `statically linked, with debug_info, not stripped` (`file`), twice the size of
the node's own kubelet; the cause is inferred to be the absence of `-s -w` and was not checked. A 1.34.10
binary ran on a 1.34.11 control plane without trouble.

Unit layout on the kind node: `kubelet.service` plus drop-ins `10-kubeadm.conf` and `11-kind.conf` (the
latter adds `ExecStartPre` lines that do not touch the binary), `Restart=always`, `RestartSec=1s`,
`StartLimitInterval=0`. The args come from `$KUBELET_*` environment variables, so the drop-in repeats them
by reference:

```
# /run/systemd/system/kubelet.service.d/99-ceiling.conf
[Service]
ExecStart=
ExecStart=/var/lib/ceiling/kubelet-<stock|relist100> $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

`/run` in the node is a `tmpfs` with `noexec`; `/var/lib` is not `noexec`. Staging used
`docker exec -i <node> sh -c 'cat > ...' < file`, because `docker cp` into the node's `/tmp` (a tmpfs) silently
copied nothing. This is a kind detail, not a runbook change.

## 1. Do the CGO-off builds start and make the node Ready? PASS (measured)

Both start, register, and report. After `daemon-reload` + `restart kubelet` with the drop-in:

| Build | `/proc/<pid>/exe` sha256 | args sha256 vs original | Node `VERSION` | Ready heartbeat after restart |
|---|---|---|---|---|
| original | `f1287987...` | `c13e566e...` | v1.34.11 | n/a |
| stock | `d19dc319...` (= SHA256SUMS) | equal | v1.34.10 | 0.45-0.83 s |
| relist100 | `c4698202...` (= SHA256SUMS) | equal | v1.34.10 | 0.45 s, 0.81-0.83 s later swaps |

`systemctl restart` itself returned in 0.08-0.09 s. The readiness number is the Ready condition's
`lastHeartbeatTime` moving (see "Procedure change" below). `args_sum` was identical across every swap, so
flag equality is checked, not assumed.

## 2. Swap, revert, and what happens to pods. PASS (measured)

- Swap = write the volatile drop-in, `daemon-reload`, `restart kubelet`. Revert = remove the drop-in, same two
  commands. After the revert, `exe_sum` and `args_sum` equalled the original again, and the file
  `/usr/bin/kubelet` was never written.
- Three pause pods (pinned to the worker) plus kindnet and kube-proxy: **container IDs and `restartCount`
  (all 0) unchanged** after stock, after relist100, after the revert, after the crash-loop drill, and after both
  auto-revert firings (diffed against the pre-run listing each time). The kubelet swap from 1.34.11 to our
  1.34.10 and back did not restart any pod.
- Kubelet down for about 54 s (drill a): `crictl ps` still showed 5 running containers; none restarted.

## 3. Failure drill and auto-revert. PASS (measured)

- **(a) A binary that exits at once** (`#!/bin/sh; exit 1` as `kubelet-bad`): `systemctl restart` returned 0.18 s
  with exit 0 (systemd reports success for a restart, then crash-loops: 43 restarts before recovery). The API
  still said Ready=True until **53.6 s**, then `NotReady` (Unknown). `sh /var/lib/ceiling/revert.sh`, run with
  no kubelet alive, brought the node back: Ready=True 1.2 s after the revert started, original binary and args
  sums, drop-in gone, workload identical.
- **(b) Fire test, kubelet up:** stock drop-in active; `systemd-run --unit=ceiling-revert-test --on-active=30s
  --timer-property=AccuracySec=1s /bin/sh /var/lib/ceiling/revert.sh`. Drop-in gone **30.6 s** after arming,
  original binary running and node Ready with a new heartbeat at 30.8 s. The service had been collected
  (`Deactivated successfully` in the journal), so the proof was the effect, as the runbook says.
- **Kubelet-down case:** stock drop-in active, then `systemctl stop kubelet` (inactive, pid 0). At +20 s still
  inactive. The timer fired and the kubelet was **active again at 30.8 s**, drop-in gone, original binary and
  args sums, node Ready, workload identical. The net works with the kubelet stopped.
- **Timer re-basing (new, measured):** `systemctl list-timers` showed `ceiling-revert.timer` (150 min) NEXT at
  11:41:07, then 11:41:32 after a `daemon-reload` five seconds later, and unchanged over six seconds without
  one. Every `daemon-reload` moves a pending `--on-active` timer to reload time plus the full delay, in
  systemd 257. The original arming was 11:33:54. Consequence: swaps only postpone the revert; it never fires
  early. OKE's systemd version is unknown.

## 4. The relist constant really changed. PASS (measured)

`kubectl get --raw /api/v1/nodes/<n>/proxy/metrics`, `kubelet_pleg_relist_interval_seconds_{sum,count}` read
twice 60 s apart, mean of the delta; `process_cpu_seconds_total` over the same 60 s.

| Kubelet | Mean relist interval | Samples | Kubelet CPU |
|---|---|---|---|
| original (before) | 1.0030 s | 60 | 0.60% of a core |
| stock build | 1.0029 s | 60 | 0.56% |
| **relist100** | **0.1027 s** | 587 | **1.13%** |
| original (after revert) | 1.0028 s | 60 | 0.60% |

Inside the pod-IP runs (10 s reads, pods being created): stock 1.0022 and 1.0031 s at 0.59% and 1.08%;
relist100 0.1030 and 0.1032 s at 1.77% and 1.87%. CPU is roughly **2x** on a near-idle node, not the runbook's
earlier "about ten times" (that figure was unmeasured and is now replaced). OKE's number is not known.

## 5. Reboot behaviour. PASS on kind (measured), weaker than a real reboot

With the relist100 drop-in and the 150-minute timer both present, `docker restart ceiling-rehearsal-worker`
(returned in 0.5 s): after boot `/run/systemd/system/kubelet.service.d/99-ceiling.conf` was **gone**, the timer
was gone, the **original binary and original args** ran (sums equal), and `/var/lib/ceiling` (staged binaries,
`revert.sh`) persisted. The kubelet was active 2.7 s after the command. The node read Ready True at once, but that
was the stale pre-restart condition (see below), so no readiness time is claimed. All pods' containers were
restarted (`restartCount` 1, new container IDs), as the container runtime restarted too; pod IPs were
reshuffled among the three pause pods. Kind's `docker restart` keeps the host kernel and does not run a
firmware boot or cloud-init, so this proves only that a tmpfs `/run` is not persistent, which it says on the
label. The CRI-O drop-in (in `/etc`) is not covered; it does not exist on kind.

## 6. Pod-create to pod-IP visible, stock against relist100 (kind only, indicative)

**Not an OKE result.** kind uses containerd (not CRI-O), kindnet (not the cloud CNI), pause pods bound to the
node with `nodeName` (the scheduler and Knative are not in the path), and an arm64 laptop VM. What it can show is
the kubelet's own contribution: POST of the pod to the API, then the first watch event carrying `status.podIP`.
Both timestamps are from the same host clock.

Method: 20 pods per arm in four interleaved blocks of 10 (stock, relist100, stock, relist100), a swap and 25 s
settle before each, 3-4 s random gap between creations, `registry.k8s.io/pause:3.10.1` already on the node, a
`kubectl proxy` for the POST and the watch. Zero misses.

| Arm | n | min | p25 | median | p75 | max | IQR | sd |
|---|---|---|---|---|---|---|---|---|
| stock | 20 | 0.496 s | 0.625 | **0.911** | 1.214 | 1.425 | 0.589 | 0.321 |
| relist100 | 20 | 0.528 s | 0.534 | **0.550** | 0.567 | 0.600 | 0.033 | 0.021 |

Per-block medians: stock 0.751 and 0.995 s, relist100 0.551 and 0.549 s. **The stock latencies spread over
0.93 s, one relist period, with nothing clustered; relist100 spreads over 0.07 s.** That is the shape a 1 s
sampling phase produces on the stock kubelet, and it disappears at 100 ms. It is a spread read off 20 points,
not an analyzer lock; `lattice_analyze.py` was not run on it (it needs harness rows). The shift in the median
(-0.36 s) is a kubelet-only effect of the right size for a 1 s relist waited on at a random phase; whether
the same holds on OKE's CRI-O with a Knative pod is exactly what the ceiling run measures.

## 7. `drive.py` restore mode and `lattice_analyze.py`: NOT EXERCISED

The driver needs Knative Serving, the operator, two NextApps, the harness pod and node agents; the kind cluster
has none of them, and standing them up is not cheap. The SIGKILL / `--expect-state` check (runbook section 3
step 6) is therefore also not done. The analyzer and driver are covered only by their existing synthetic tests.

## Procedure change forced by the rehearsal (tested)

**`kubectl wait --for=condition=Ready` after a kubelet restart is worthless.** The API keeps the old kubelet's
Ready=True until the node-lifecycle controller marks it Unknown (53.6 s here), so the wait passes at once, for
a crash-looping kubelet too. The runbook used it in four places as the "did it come back" gate. It is replaced by
`wait-kubelet-heartbeat.sh wait <context> <node> <heartbeat-before-restart> [timeout]`, which succeeds only
when the Ready condition's `lastHeartbeatTime` has changed and Ready is True (new kubelet heartbeat 0.45-0.83 s
after start in every swap here). The heartbeat comes from `... read <context> <node>`, run from the workstation
immediately before each restart: before every block's swap, again in the fire test after the stock restart (so
the timer's restart is the one waited for), and again before the revert (an older value would let the revert check
pass on a heartbeat the swapped kubelet had already posted). The context is a required argument and every kubectl
in the runbook carries `--context "$CTX"`; a kubectl failure exits 2 with its message instead of looking like a
timeout (exit 1). Tests in
`tests/bench-cold-start-ceiling.test.ts` run the script against a stub kubectl (new heartbeat passes; stale
Ready=True, Unknown, False and empty all time out; the context reaches every call; a missing context and a
failing kubectl exit 2) and assert on the runbook: no `kubectl wait`, every wait preceded by a read, the revert
re-reading first, every kubectl naming the context. They are mutation-proved (see the commit message).

**Added after review:** the amd64 off-node start check and its stop condition, and the `daemon-reload` timer
stop condition, are in the runbook (sections 4 and 5) with text guards. The amd64 builds were rebuilt locally
on 2026-11-05 and the sums reproduced the runbook's exactly
(`e4b218a2...1acdc` stock, `e8d9fa85...446e0` relist100). Both print `Kubernetes v1.34.10` from
`docker run --platform linux/amd64 ... --entrypoint /k/<binary> busybox@sha256:66a6306d... --version` on an
arm64 Mac under OrbStack emulation. That shows the ELF loads and runs under x86-64; it does not show that the
amd64 kubelet starts and holds a node, which stays unverified until the fire test on P.

Smaller runbook edits: the stale "from memory" statements for pod survival and for the `/run` reboot now
carry the kind measurement; the "ten times the kubelet CPU" estimate is replaced by the measured 2x with OKE
marked unknown; a paragraph records the `daemon-reload` timer re-basing; the status lines no longer say
nothing was executed.

## What the rehearsal supports for OKE, and what it cannot show

**Supports (inferred from measured mechanism):** the volatile-drop-in swap, the revert by removal, the
`revert.sh` recovery with no kubelet, and the timed auto-revert (kubelet up or stopped) all work as written;
our CGO-off stock and relist100 builds start, register and hold the node; pods on the node survive the
swap; the relist constant is 1.00 s on stock and 0.103 s on the patch. On those grounds the mechanism is safe to
attempt on OKE under the runbook's stop conditions, the access-path checks (A4) and the founder's go, with the
heartbeat-gate change adopted.

**Cannot show:** CRI-O (kind uses containerd), SELinux labels and enforcing mode (`chcon`), the OKE unit
file (may use literal args, a wrapper, an `ExecStart` that sorts after `99-ceiling.conf`, a start-rate limit
unlike kind's unlimited restart), whether the OKE kubelet is a plain upstream build (confound: our builds are
unstripped CGO-off), a real reboot and the OCI console route, the amd64 build (never started),
the 1.34.10 vs 1.34.11 patch difference (the node image runs 1.34.11), the CPU cost under OKE's load,
Knative and the pod-IP wait on a real wake, and the driver's cordon logic. systemd on OKE may be older than 257
and may not re-base timers the same way.

## State left behind

Cluster `ceiling-rehearsal` is running (context `kind-ceiling-rehearsal`; the kubeconfig is
`/private/tmp/claude-501/rehearsal-kubeconfig`, not `~/.kube/config`). The worker is back on its original
kubelet, no drop-in, no timer. `/var/lib/ceiling` on the worker holds `kubelet-stock`, `kubelet-relist100`,
`kubelet-bad` and `revert.sh`. Namespace `ceil-rehearsal` holds 43 pause pods (`w1-w3` and 40 `sa/ra/sb/rb`
pods) that cannot be removed without a delete, which is founder-only. `kind delete cluster --name
ceiling-rehearsal` is the founder's to run.
