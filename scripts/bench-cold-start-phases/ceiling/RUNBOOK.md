# Kubelet ceiling test: runbook

**Status: prepared; the kind rehearsal (section 3) was executed on 2026-11-05, the OKE run was not.** Founder-approved on 2026-11-04 as a **measurement, not a shipped
default**, on these terms: **one existing worker is patched (call it P), the other (S) is the untouched
control**, and the founder applies a host log reader on request. Nothing here has touched OKE. The
agent that wrote it had no cluster access; a second agent ran only the local kind rehearsal (cluster
`ceiling-rehearsal`, `REHEARSAL.md`), and no image was pushed.
Every cluster step needs the founder's explicit go, and section 1 lists every approval it needs. The steps
are for a human operator.

**What this will probably show.** The runbook's own estimate is a P median first byte near 1090 ms (section
10, H3), so the expected outcome is **a diagnosis and probably a floor near 1.09 s, not a shipped change**.
That is why the run is staged: a two-block **screen** first (stock, then relist100; section 10 "Phase 1"),
and the six-block run only if the screen shows the wait collapsing.

Background: `docs/benchmarks/cold-start-node-diagnosis-oke-2026-11-02.md`. The question: is the kubelet's
1 s PLEG relist the wait between the queue-proxy starting and the pod IP reaching the API, and what does the
cold-start median look like when the relist is 100 ms on one worker?

## 0. Scope rules (read first)

- **Cluster work is a queue of one.** Concurrent traffic keeps pods warm, so a "cold" start is not cold.
- **Never run `kubectl delete`, `kind delete`, `kubectl drain` or `--force`.** Deleting is founder-only. This
  runbook cordons and uncordons, restarts a service on a node, and removes named files on a node. It never
  removes a pod, node, namespace or cluster.
- **Cordon only, no drain.** P keeps the pods it already runs (Knative components, CoreDNS and the like).
  Section 2 says what a kubelet restart does to them, and what is claimed from memory.
- **Node names are never assumed.** Record the name, UID and versions of P and S from the cluster first.
- **The host log reader is a separate, founder-applied step** (section 12). Nothing here applies it.
- **Claims marked "(from memory, verify)" have not been checked** against a running system. The kind
  rehearsal (section 3) is where they get checked, and it is a required step.
- **Order of operations. Phase 1, the screen:** section 4 (preconditions and setup), section 5 (stage and
  fire-test), **two blocks of section 6 (`b2` stock, then `b3` relist100)**, section 8 (revert) once at the
  end or at once on any abort, then section 13 (analysis). **Phase 2, the full run, only if the screen shows
  the wait collapsing (section 10):** the six blocks of section 6, optionally section 11 (the CRI-O debug
  block), then section 8 once at the very end or at once on any abort, then section 13. Phase 2 reuses
  section 5's staging and fire test unless the node rebooted or `revert.sh` changed. Section 8 is the only
  revert; it covers everything the earlier sections change on P. Section 14 is the founder-only cleanup.

## 1. Decisions, and every approval the run needs

Record each in the run log (a file on the operator's workstation, not in the repo). A conversation message
from an agent is not approval. The founder approved: one existing worker patched, the other the control, a
host log reader on request. **Everything below is beyond that and needs its own approval.** It is split into
what the **screen** (Phase 1, section 10) needs and what the **full run** (Phase 2) adds.

### 1a. The screen (Phase 1): what the founder approves first

Two blocks on P (`b2` stock, `b3` relist100), 30 pairs each; 64 P windows; 5 kubelet restarts; about
2.9-3.4 h of cluster time.

| # | Step | Why it needs its own approval |
|---|---|---|
| A1 | **Our own stock build runs on P** (block b2) | The patched build was approved. The stock build is a second binary, built by us, same toolchain and flags, no patch. Without it the OKE-versus-patched difference mixes the constant with the build |
| A2 | **The timed auto-revert, and its fire test** (a transient systemd timer; the fire test starts our stock kubelet on P and lets the timer revert it, section 5) | A unit that restarts the kubelet on its own, on a clock |
| A3 | **Staging directory, volatile drop-in, and 5 kubelet restarts on P** (`/var/lib/ceiling`, `/run/systemd/system/kubelet.service.d`; two for the fire test, one each for b2 and b3, one for the revert) | Files on the node; the drop-in changes what systemd starts |
| A4 | **An OCI serial console connection to P**, and the SSH path | A cloud resource, and a login route into the node |
| A6 | **The kind rehearsal cluster** (section 3) | Created on the workstation; deleting it is `kind delete`, founder-only |
| A7 | The host log reader (section 12), optional | Refused once already; founder-applied only |
| A8 | **Creating the cluster objects:** NextApps `ceil-p` and `ceil-s`, the harness pod, the node-agent pods and the harness RBAC (section 4) | New objects in the bench namespace |
| A9 | **Cordoning P for the whole screen, about 2.9-3.4 h** | The cluster has one schedulable worker (S) for that time, apart from P's own wake windows |
| A10 | **Toggling S's and P's cordon around every P wake: 64 P windows, 4 cordon writes each, 256 writes** | S was approved as untouched. Its binary is, but its schedulability flips for the length of each P wake, because **the NextApp has no field to pin a pod to a node** (see section 2). Avoiding it needs a node selector in the NextApp CRD and operator, a CRD change out of scope here |
| A12 | **The founder personally runs the SSH steps throughout** (sections 5, 6 steps 2-4 and 7, 8 and 9) | Kubelet restarts, hashes and metric reads on P are done by hand by the founder for the whole window |
| A13 | **A cluster-wide freeze of other work for the whole window** | During a P window S is cordoned, so any pod scheduled anywhere lands on P, and the run aborts on it (`--abort-on-foreign`). No deploys, scale-ups or cron jobs for the duration |
| A14 | **Founder-only cleanup afterwards** (section 14) | The runbook lists it and runs no delete |

**Risks accepted, stated so the approval is informed:**
- The 100 ms relist costs about ten times the kubelet CPU: about 25% of a core instead of 2.5%, on a node that
  also runs its existing pods.
- The harness pod runs as root (its image's default user) and sleeps for 48 hours before it exits.
- If the workstation dies in the middle of a P window, **P stays open and S stays closed until a human fixes
  them** (section 6 step 6); the next start refuses until they are right.
- The expected result is a diagnosis and probably a floor near 1.09 s, not a shipped change.

### 1b. The full run (Phase 2) adds, only if the screen shows the wait collapsing

Six blocks on P (`b1` ... `b6`), plus the optional CRI-O block (`b7`): 192 P windows, 8 kubelet restarts, about
9-11 h.

| # | Step | What it adds |
|---|---|---|
| A1 | Our stock build also runs in block b5 | The ABBA order needs the stock build twice |
| A3 | 8 kubelet restarts in total | Three more: b4, b5, b6 |
| A5 | **CRI-O debug logging on P**, final block only (section 11) | Changes P's runtime config; a drop-in under `/etc/crio` |
| A9 | **Cordoning P for about 9-11 h** (six blocks, fire test, CRI-O block, revert) | The same cordon, three times as long |
| A10 | **224 P windows, 896 cordon writes**: 6 blocks x 32 windows = 192 (768 writes) plus 32 for the CRI-O block (128 writes) | Every window is 4 cordon writes |
| A11 | **Repeats, conditional on `RELIST_IS_WAIT_GOAL_MET_ONCE`:** at least three independent runs for any pass claim (section 10) | The runbook itself predicts about 1090 ms, so repeats are not expected. If a run does print it: three full runs plus two 2-hour gaps are 31-36 h, three screen-size runs 13-14 h; fresh pods each time; A1-A14 apply to each |

## 2. Design, node roles, and what a kubelet restart does

- **P** is the patched worker. It runs six blocks of 30 pairs, **in ABBA order**: `b1` OKE original, `b2` our
  stock build, `b3` relist100, `b4` relist100, `b5` our stock build, `b6` OKE original. Stock versus
  relist100 isolates the constant. OKE versus our stock build measures the build. The final OKE block checks
  carryover from the swaps. The middle four blocks are ABBA, not ABAB, **so a linear drift on P alone cancels
  in the stock-versus-relist100 difference** (stock sits at positions 1 and 4, relist100 at 2 and 3, of the
  four); an ABAB order would leave one block's worth of drift in it, which the carryover check could miss
  (about 330 ms of drift would pass it at 30 pairs, against an effect of about 450 ms). **Every block starts
  with a kubelet restart, including `b4` (the same binary again)**, so each block is equally "freshly
  restarted"; `b1` follows the fire test's revert restart instead, with a 10-minute settle (section 6
  step 2).
- **S** stays on its OKE binary, untouched, with no debug logging, in every block. It is the concurrent drift
  control. A pair is one wake on P and one on S in the same round, **back to back** (the driver wakes the two
  arms serially, with no wait between them, and waits for zero pods only at the start of a round).
- **Primary hypothesis: the wait.** The wait is the pod IP time minus the queue-proxy's first log, per wake.
  Under the stock relist it is spread over about 0-1000 ms. With a 100 ms relist it should fall to about
  150 ms or less. It is judged as a **difference in differences against S**. The cycle lock is secondary.
- **How the wait is timed.** `pod_ip` is **the harness's own watch time** (its clock), not a node timestamp.
  The queue-proxy's first log is a CRI-O log timestamp on the **node's** clock, re-based onto the harness
  clock by an offset the harness measures against a node-agent pod on that node (`clock.offset_ms`, with its
  round trip `clock.rtt_ms`, whose half bounds the error). `cold-cycle.mjs` falls back to offset 0 if it
  finds no agent on the node, which would put raw clock skew into P's wait against a 150 ms limit. **The
  analyzer therefore treats a row with no offset, or with a round trip over 50 ms, as unusable and counts
  it, and prints the median and max round trip per arm.**
- **Placement.** The harness pod runs on **S**, not P: P's kubelet is restarted several times (five in the screen, eight in
  the full run) and a harness on it would be disturbed. `ceiling-setup.example.yaml` pins it to S by `nodeName` (which also bypasses the
  cordon); confirm with `kubectl --context "$CTX" get pod ceil-harness -o wide`. If it is on P, **stop**: moving it needs a
  delete, which is founder-only. **Network asymmetry, stated:** harness-to-pod traffic is same-node for S
  wakes and cross-node for P wakes, so first byte carries a small constant offset between arms. It is the
  same in every block, so it cancels in the difference in differences; it does not affect the wait.
- **The two arms are two NextApps** (`ceil-p`, `ceil-s`) with identical specs, because one app cannot be woken
  twice in a round without waiting for zero pods between. Arm identity is therefore aliased with node. That
  is acceptable: the contrast that matters, relist100 against stock, is within P.
- **Pinning uses cordons, because the NextApp cannot pin.** Checked in `api/v1alpha1/nextapp_types.go`: the
  NextApp spec has no `nodeSelector`, `affinity`, `tolerations` or pod-template field, and the operator is
  the single source of truth for cluster objects, so there is no node-level placement in the CR, and the
  harness writes no Knative objects. Pinning by selector would need a CRD and operator change, which is out
  of scope (and a CRD change is an escalation trigger). A wake is therefore placed by cordoning the other
  node for its duration.
- **How the cordons are protected** (`drive.py --place-mode=restore`, tested):
  - It snapshots every managed node's cordon first and works only on the nodes of the pools the arms name.
    It refuses to start if any other node is schedulable (a wake could land there), and it aborts on any
    refused cordon.
  - **It reads the live node, never a cache.** Before each placement, after each change and after each wake it
    reads the node back. If a node's live state is not what **this run** last set (someone else cordoned S, or
    uncordoned P), it **stops, leaves that node as the other party left it**, and says so. A cordon whose
    response was lost but which took effect counts as done; one that reported success but did not take effect
    is an error.
  - After every wake and at exit it puts each node back to the snapshot, **unless that node was changed by
    someone else**, in which case it reports and exits 1. P is cordoned by the founder before the run, so P
    stays cordoned except during its own wake.
  - SIGTERM and SIGHUP run the restore. **SIGKILL cannot be caught**, so a killed driver leaves P open and S
    closed, and the next block's fresh snapshot would take that for the rest state. `--expect-state` is the
    guard: each block's command states the rest state (P cordoned, S open) and the driver refuses to start
    from any other.
  - A **lock file** allows one restore-mode driver per workstation. It does not span workstations; the
    section 4 check of the cluster covers that.
- **What this cannot guarantee.** During a P wake, S is cordoned, so any pod scheduled anywhere in the cluster
  in that window lands on P. The harness lists, after each wake, pods that appeared on the woken node and are
  not the arm, a DaemonSet pod or already there (`foreign_new_pods`), **prints `FOREIGN POD on pool ...` at
  once, and with `--abort-on-foreign=<P pool>` stops the run** after restoring the cordons. Detection, not
  prevention.
- **What a kubelet restart does to running pods (verified on kind, not yet on OKE).** The container
  runtime owns the containers, so they keep running; the kubelet re-adopts them on start. Pods are not
  restarted unless the kubelet computes a different container hash, which is why the version must match and
  the rehearsal compares `restartCount` and container IDs before and after. While the kubelet is down, no
  status is reported; a restart of a few seconds is under the node-monitor grace period (about 40-50 s), so
  the node should not go NotReady. If it did, pods without their own tolerations would be evicted after 300 s
  (the default not-ready toleration), which is why section 7 reverts after 2 minutes, not 5.
  Kind measured it (REHEARSAL.md): three running pods kept the same container IDs and `restartCount` across
  every kubelet restart that was checked (stock, relist100, the original, a 54 s crash-loop, both auto-revert
  firings); the new kubelet re-adopted them. Pods were NOT restarted by a kubelet swap from 1.34.11 to our 1.34.10 builds and back.
  The 100 ms relist costs more kubelet CPU: the earlier estimate here was about ten times (about 25% of a core
  instead of 2.5%), which is unmeasured. On an idle kind node it was 0.6% (stock) against 1.1% (relist100), about 2x; in 10 s reads during pod
  creation, 0.6-1.1% against 1.8-1.9%. OKE's cost is still to be read.
- **p95 is descriptive.** At 60 pairs per treatment the tail is too thin to judge; the analyzer prints it
  with that sentence and gives no interval for it.

## 3. Kind rehearsal of swap, revert and the CGO-off binary (REQUIRED; DONE on kind 2026-11-05 for arm64, see REHEARSAL.md)

**Status.** Executed once on a local kind cluster (arm64, kubelet v1.34.11 node image, containerd), steps 1-6
below (steps 1-5), with the results, commands and the procedure change it forced in `REHEARSAL.md` (same directory).
**Not done:** step 6 (the driver dry-run and the SIGKILL `--expect-state` check; it needs Knative and the
NextApps, which the kind cluster does not have), and **still required on the real node:** everything in step 7.
The amd64 build was not started anywhere (only the arm64 build was). The two things the rehearsal could not show are named in
`REHEARSAL.md` ("What kind cannot show"). Treat it as evidence about mechanism, not about OKE.

**How the rehearsal differs from production, so it is not read as proving more than it does:**
- kind runs the kubelet from kubeadm's layout: `ExecStart` is set in `/etc/systemd/system/kubelet.service.d/10-kubeadm.conf`.
  A later-sorting drop-in (`99-ceiling.conf`) with an `ExecStart=` reset should override it, and the
  rehearsal is where that is checked. Production's section 5 stop condition is written for the same case.
- The runtime is containerd, not CRI-O; there is no SELinux enforcement to speak of, no OCI console, and
  `docker exec` stands in for SSH. `/run` is a tmpfs in the node container, which is what the reboot drill
  needs. The architecture may be arm64.

1. Create a throwaway kind cluster with a name that cannot be mistaken for another (A6). Build for the
   cluster's architecture **into its own output directory** (an arm64 build refuses the default one, which
   holds the amd64 `SHA256SUMS`):
   `KUBELET_CEILING_GOARCH=arm64 scripts/bench-cold-start-phases/ceiling/build.sh /path/to/rehearsal-build`
   on Apple Silicon, or use an amd64 node image. **Starting the CGO-off binary is the first thing to
   check: it has never been started.** Record whether it starts and reports Ready on a kind node, and which
   kubelet version the node image runs (it must be v1.34.x for the comparison to mean anything).
2. Deploy a small workload on the kind worker. Record container IDs and `restartCount`.
3. Do the section 5-6 procedure inside the kind node with `docker exec` standing in for SSH: stage the
   binaries with `install`, write the volatile drop-in, restart, hash `/proc/<pid>/exe` and compare the
   `cmdline` hash, then revert and hash again. Confirm the workload's container IDs and `restartCount` did
   not change across a restart, and record how long the node took to return to Ready.
4. **Failure drills.** (a) Point the drop-in at a binary that exits at once; confirm the node goes NotReady
   and `/var/lib/ceiling/revert.sh` brings it back with no kubelet. (b) Fire the timed auto-revert (section
   5's fire test) and confirm it reverts. (c) Restart the kind node container (`docker restart`) with the
   drop-in in place and confirm the stock kubelet starts: `/run` is memory, so the drop-in is gone.
5. Read `kubelet_pleg_relist_interval_seconds` before and after, confirming mean 1.0 s versus 0.1 s.
6. Dry-run the driver against the kind cluster with `--place-mode=restore`, then kill it with SIGKILL during
   a wake and confirm `--expect-state` refuses the next start.
7. **Not rehearsable on kind, so unverified until a real node:** CRI-O (kind uses containerd), SELinux labels
   and the OKE unit file, the OKE kubelet being a plain upstream build, a real reboot, the OCI console.

## 4. Preconditions and setup

1. Section 1 approvals (A1-A14, the 1a list for the screen) and the rehearsal (section 3) recorded, with dates.
2. Builds exist and match. From the build output directory:
   ```
   shasum -a 256 -c SHA256SUMS
   ```
   Recorded from the 2026-11-04 local build with go1.25.12: `kubelet-v1.34.10-stock-linux-amd64` =
   `e4b218a2eb2c52ba157c0cd2c8157efec2a4a2723ade149dec4b937e55a1acdc`,
   `kubelet-v1.34.10-relist100ms-linux-amd64` =
   `e8d9fa854e5383685abe9690f4634a5a1645a788db3d5c55519ef523ae1446e0`. A rebuild must match, or the new sum is
   recorded before anything else. Not re-verified by the agent that wrote this.
3. **Name the cluster once, and pass it everywhere.** `CTX=<the kubeconfig context of the ceiling cluster, from
   the founder>`, defined in the workstation shell. Every `kubectl` below carries `--context "$CTX"`, the
   driver gets `--context="$CTX"`, and the heartbeat helper takes it as a required argument and refuses to run
   without one: **the current-context of whichever shell runs a command is never relied on**, because this
   run touches one cluster and a stale current-context points elsewhere. Check `kubectl --context "$CTX" get
   nodes` shows P and S before anything else.
   Nodes, from the cluster (read-only):
   ```
   kubectl --context "$CTX" get nodes -o wide
   kubectl --context "$CTX" get node <P> -o jsonpath='{.metadata.uid} {.status.nodeInfo.kubeletVersion} {.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   kubectl --context "$CTX" get node <S> -o jsonpath='{.metadata.uid} {.status.nodeInfo.kubeletVersion} {.status.nodeInfo.containerRuntimeVersion}{"\n"}'
   kubectl --context "$CTX" get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable
   ```
   Expect `v1.34.10` on both and a CRI-O 1.34.x. Record each node's current **UNSCHEDULABLE** state: that is
   the state the revert restores. **Stop if any node other than P and S exists and is schedulable**
   (`drive.py` would refuse, correctly). The founder names P and S; never infer them from name patterns.
4. **Create the cluster objects (A8), with no hard-coded node.** The repo manifests under
   `scripts/bench-cold-start-phases/` carry node names from an older cluster (`nodeName: 10.0.1.118` and
   `10.0.1.169`); **do not apply them as they are.** Work from copies in a scratch directory:
   - `harness-rbac.yaml`: keep only its **first three documents** (ServiceAccount, Role, RoleBinding) and
     replace `bench-cells` with `<NS>`. Delete the pod documents (`phase-bench`, the `clock-*` pods).
   - `node-agents.yaml`: replace the two `nodeName:` values with P's and S's names, and `bench-cells` with
     `<NS>`. The harness finds the agent as the pod labelled `app=phase-agent` on the woken pod's node, so
     the pod names do not matter.
   - `ceiling/ceiling-setup.example.yaml`: fill `<NS>`, `<S node>` (the harness pod's `nodeName`, which pins
     it to S) and `<IMAGE>` (pinned by digest, never `:latest`).
   Then verify before applying: `grep -n 'nodeName' <the copies>` lists only P's and S's names, and
   `grep -n '10\.0\.1\.' <the copies>` finds nothing. Apply with `kubectl --context "$CTX" apply --validate=strict -f`, then
   `kubectl --context "$CTX" get pods -n <NS> -o wide`: the harness on S, one agent on each node, `ceil-p` and `ceil-s` Ready
   at zero pods (`minScale: 0`).
5. **Harness on S** (section 2): `kubectl --context "$CTX" get pod ceil-harness -n <NS> -o wide`.
6. **The image is on both nodes.** The first wake after a missing image includes a pull. Check on each node
   over SSH (authoritative): `sudo crictl images --digests | grep <digest from the NextApp spec.image>`.
   The API view `kubectl --context "$CTX" get node <n> -o jsonpath='{.status.images[*].names}'` is a quick look only: the
   kubelet reports at most 50 images by default (from memory), so absence there proves nothing. If missing,
   do two unrecorded wakes per arm first and re-check.
7. Nothing else is benching:
   ```
   kubectl --context "$CTX" get pods -A -o wide | grep -Ei 'bench|phase|harness|loadtest|k6' || true
   kubectl --context "$CTX" get nextapp -A
   pgrep -fl 'drive.py|baseline-stability|prepull|burst-ab|bunexec|cpu-boost' || true   # on the workstation
   ```
   Expected: the harness pod, `ceil-p`, `ceil-s` and the node agents. Ask the founder about anything else.
   The driver's lock covers this workstation only; a driver on another workstation is covered only by this
   check and by the live-cordon abort.
8. **A tested access path to P before any swap (A4).** All of these, recorded:
   - SSH to P with sudo: `ssh <user>@<P address> 'sudo -n true && echo ok'`. Keep **a second SSH session open**
     for the whole run.
   - An **OCI serial console connection to P is created and a login prompt reached** (the route that works
     when the network or sshd is down). The OCI steps are per the OCI documentation; verify them, they were
     not run.
   - **The recovery route does not rely on the kubelet.** `kubectl debug node` needs a working kubelet and
     leaves a pod behind that only the founder can delete, so it is not used.
9. **Build equivalence, off the node.** Copy the OKE kubelet off P and inspect the copy on the workstation,
   which has Go (a node has none, so `go version -m` is not run there):
   ```
   ssh <user>@<P address> 'systemctl show kubelet -p ExecStart'      # read the real binary path
   scp <user>@<P address>:<path from ExecStart> ./oke-kubelet         # read-only copy; also an off-node backup
   shasum -a 256 ./oke-kubelet
   go version -m ./oke-kubelet                                         # build flags, -X version values, CGO setting
   go version -m <build dir>/kubelet-v1.34.10-stock-linux-amd64
   file ./oke-kubelet                                                  # statically or dynamically linked
   ./oke-kubelet --version                                             # on a linux host; expect Kubernetes v1.34.10
   ```
   **Start check of the amd64 builds, off the node (before any cluster step).** Neither amd64 build has ever
   run as a kubelet; only the arm64 builds did (kind rehearsal). On the workstation, with Docker, run each under
   x86-64 emulation (the image is the amd64 manifest of `busybox:1.37.0`, pinned by digest):
   ```
   docker run --rm --platform linux/amd64 -v <build dir>:/k:ro --entrypoint /k/kubelet-v1.34.10-stock-linux-amd64 busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4 --version
   docker run --rm --platform linux/amd64 -v <build dir>:/k:ro --entrypoint /k/kubelet-v1.34.10-relist100ms-linux-amd64 busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4 --version
   ```
   Each must print `Kubernetes v1.34.10`; anything else is a stop. Run on 2026-11-05 on an arm64 Mac (OrbStack):
   both did, and the rebuild reproduced the two sums recorded above exactly. **This proves only that the ELF
   loads and executes** (`--version`); it does not prove a kubelet starts, registers and holds a node, which only
   the node can show. That is the stop condition in section 5.
   Any difference beyond the relist constant (CGO, flags, `-X` values, a vendor patch) is named as a confound
   in the result. The `oke` blocks and the `stock` blocks exist to measure it.
10. Record the start time. Cluster time, from the arithmetic in section 6 step 6: **the screen about 2.9-3.4 h**,
    the full run (six blocks, fire test, CRI-O block, revert) **about 9-11 h**.

## 5. On P: variables, staging, the revert script, the timer and its fire test (founder-run, over SSH)

**Cordon P first**, from the workstation: `kubectl --context "$CTX" cordon <P>` (verify `SchedulingDisabled`; no drain). P then
takes no new work while it runs our binaries.

Commands in the code blocks below run **on P** unless marked `# workstation`: a worker may have no kubectl.
Define the variables and helpers in one shell on P first; every later command on P uses them.

```
sudo systemctl cat kubelet                        # the whole unit including drop-ins; read it
sudo systemctl show kubelet -p ExecStart -p FragmentPath -p DropInPaths
KP=<the path= value of ExecStart, the real binary>
sudo head -c 4 "$KP" | od -An -c                  # expect: 177   E   L   F
kpid()     { systemctl show -p MainPID --value kubelet; }
exe_sum()  { sudo sha256sum /proc/"$(kpid)"/exe | cut -d' ' -f1; }
args_sum() { sudo cat /proc/"$(kpid)"/cmdline | tr '\0' '\n' | tail -n +2 | sha256sum | cut -d' ' -f1; }
OKE_EXE=$(exe_sum); OKE_ARGS=$(args_sum); echo "$OKE_EXE $OKE_ARGS"      # record both
sudo sha256sum "$KP"                              # the file; must equal the off-node copy's sum
```
`exe_sum` hashes the **running process's** executable and `args_sum` hashes its **arguments** (everything
after argv[0]). Both are recorded for the OKE kubelet now; every later restart must reproduce `OKE_ARGS`, so
flag equality between the arms is checked, not assumed.

**Stop conditions.** Stop and report if any is true: `ExecStart` is a shell script or wrapper (the first four
bytes are not `ELF`); `ExecStart` runs more than one command; an existing drop-in sets `ExecStart` and sorts
**after** `99-ceiling.conf` (ours would not win; one that sorts before is expected and is what the `ExecStart=`
reset overrides, see section 3); `findmnt -T /var/lib -o OPTIONS` shows `noexec`; the unit uses a
`ExecStartPre` that touches the binary path.

**Stop condition: an amd64 build that does not start as a kubelet.** Each build is started on P for the first time
only under an armed revert timer: `stock` in the fire test (step 1 below, under the 150-minute timer armed
above) and `relist100` in the first block that uses it (section 6 step 1 re-arms the timer first). If after
that first start `scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120` exits non-zero, or `exe_sum` is not that build's sum, or
`args_sum` is not `$OKE_ARGS`, or `systemctl show kubelet -p NRestarts --value` is above 0 or still rising, **stop
the whole run**: read `HB` again, run `sudo /bin/sh /var/lib/ceiling/revert.sh`, prove the OKE binary is back
(section 8 step 2), and report with `journalctl -u kubelet -n 200 --no-pager`. Do not try the other build or
another block first. No block starts, and none continues, on a build that has not started cleanly.

**SELinux, for the binaries and for the revert script** (the labelling step comes after staging, below).
`getenforce` first. The revert script is never exec'd directly: the timer runs it as
**`/bin/sh /var/lib/ceiling/revert.sh`**, so only `/bin/sh` needs to be executable and the script only
readable. Whether that holds on the real node is proved by the fire test below, not assumed. If it fails,
look for the denial (`sudo ausearch -m avc -ts recent`), stop, and report.

Stage (copy by the founder's approved means; the sums are the control):
```
sudo install -d -m 0700 /var/lib/ceiling
sudo install -m 0755 <stock file>     /var/lib/ceiling/kubelet-stock
sudo install -m 0755 <relist100 file> /var/lib/ceiling/kubelet-relist100
sudo sha256sum /var/lib/ceiling/kubelet-stock /var/lib/ceiling/kubelet-relist100   # equal the SHA256SUMS values
```
**Then label them, if SELinux is `Enforcing`.** The staged binaries must be executable by systemd under the
node's policy. `install` gives a new file the directory's default label, so it would reset a label set
earlier: **label after staging, and again after any re-stage.** Compare `ls -Z "$KP" /var/lib/ceiling/*`, then
make each staged binary match `$KP` with `sudo chcon --reference="$KP" <file>` (`restorecon` would keep
`var_lib_t`, which an enforcing node may refuse to exec) and confirm with `ls -Z` again.
**No file at `$KP` is ever overwritten.** The test binaries live under `/var/lib/ceiling`, and a block is
selected by a **volatile drop-in under `/run`**, which is memory. This avoids two traps: `cp` over a running
binary fails with ETXTBSY, and a replaced `$KP` would survive a reboot as a bad binary. Here a reboot, or
removing the drop-in, gives back the untouched OKE binary.

The drop-in repeats `ExecStart` with the binary replaced and the arguments verbatim (copy them from
`systemctl cat`, do not retype):
```
# /run/systemd/system/kubelet.service.d/99-ceiling.conf
[Service]
ExecStart=
ExecStart=/var/lib/ceiling/kubelet-<stock|relist100> <every argument of the original ExecStart, unchanged>
```
Write it with `sudo install -d /run/systemd/system/kubelet.service.d` and `sudo tee`; the `oke` blocks have
**no** drop-in.

The revert script, also staged now (it works with the kubelet down, and is safe to run twice). It also
removes the CRI-O debug drop-in, which lives in `/etc` and would otherwise survive a reboot:
```
sudo tee /var/lib/ceiling/revert.sh >/dev/null <<'EOF'
#!/bin/sh
rm -f /run/systemd/system/kubelet.service.d/99-ceiling.conf
if [ -e /etc/crio/crio.conf.d/99-ceiling-debug.conf ]; then
  rm -f /etc/crio/crio.conf.d/99-ceiling-debug.conf
  systemctl reload crio
fi
systemctl daemon-reload
systemctl restart kubelet
EOF
sudo chmod 0600 /var/lib/ceiling/revert.sh
```

**Timed auto-revert (A2), armed before the first swap and re-armed at the start of every block.** If the
operator or the workstation vanishes, P returns to the OKE binary by itself:
```
sudo systemctl stop ceiling-revert.timer ceiling-revert.service 2>/dev/null || true
sudo systemd-run --unit=ceiling-revert --on-active=150m --timer-property=AccuracySec=1s /bin/sh /var/lib/ceiling/revert.sh
systemctl list-timers ceiling-revert.timer
```
The first line stops an elapsed timer that may still be loaded under the same name. `AccuracySec=1s` is set
because systemd's default accuracy window is 1 minute (from memory), which lets a timer fire late.

**Why 150 minutes.** The timer must outlast the longest stretch between a re-arm and the end of the block's
checks, or it fires in the middle of the block and the rest of it runs on the OKE kubelet (and section 7
aborts). That stretch is, worst case: 17 minutes of restart, metric reads, 5-minute settle, 2 warm-up rounds
and after-block checks, plus 30 rounds at 2.4 minutes (72 minutes) = **89 minutes**. A round is the zero-pod
wait (median 84-92 s in the 2026-11-02 stability study), the 10 s settle and two wakes, 1.9-2.4 minutes. 150
minutes is a margin of 1.7x. The price is that, with the operator gone, P can stay on a test kubelet for up to
150 minutes. The timer is transient (memory), so it does not survive a reboot, and does not need to for the
kubelet (the `/run` drop-in does not either); the CRI-O drop-in is the exception, handled in section 9.
**If the timer fires during a block, the rest of that block ran on the OKE kubelet.** Check
`systemctl list-timers` and `exe_sum` at the end of every block; a block where it fired is discarded.

**Waiting for the new kubelet (measured on the kind rehearsal).** After a kubelet restart the API server keeps
the old kubelet's Ready=True for about 54 s, even when the new kubelet is crash-looping, so a
`kubectl wait` on the Ready condition returns at once and proves nothing. A stale Ready=True is what you read
for the first minute. The check that works is the Ready condition's `lastHeartbeatTime`: the new kubelet posts
one within about 0.5-0.8 s of starting. Read it with the helper **immediately before the restart whose effect is waited for, and again before every
later restart** (a value read before an earlier swap is stale by then, because the swapped kubelet has already
posted newer heartbeats, and the wait would pass at once), and wait for it to change:
`HB=$(scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh read "$CTX" <P>)`, then `scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120` (tested against a stub
kubectl). It exits 1 on timeout, which means revert (section 8), and **2 when kubectl itself fails** (a wrong
context, an unreachable API, an unknown node), which is a different problem and is reported as such, not as a
timeout; it also refuses to run without a context. `exe_sum` on P is still the proof of
which binary runs; the heartbeat is the proof that it started and reached the API.

**`daemon-reload` re-bases a pending `--on-active` timer (measured, systemd 257 on kind).** Each
`systemctl daemon-reload` moves `ceiling-revert.timer`'s next elapse to reload time plus the full delay (it
read 11:41:07, then 11:41:32 after a reload five seconds later, and did not move without one). The swap's
reload therefore only ever postpones the revert, and the 150-minute margin is measured from the last
reload, not from arming. Re-arming at the start of every block, as above, is unaffected. OKE's systemd may differ
and is not tested, so **the first reload on P is a stop-condition check, run once with the 150-minute timer armed and
before the fire test**:
```
systemctl list-timers ceiling-revert.timer --no-pager; date -u      # record NEXT_before and now_before
sudo systemctl daemon-reload
systemctl list-timers ceiling-revert.timer --no-pager; date -u      # NEXT_after and now_after
```
Pass: the timer is still listed, `NEXT_after` is **not earlier than `NEXT_before`**, and `NEXT_after` is no
later than `now_after` plus 151 minutes (either left alone, or re-based to reload time plus 150 minutes).
**Stop if** the timer is no longer listed, `NEXT_after` is earlier than `NEXT_before` (a reload that shortens
the net could fire mid-block), or `NEXT_after` is more than 151 minutes ahead (the net is longer than its
margin). Re-arm once (the arm command above) and repeat the check; if it fails the same way, run `revert.sh`
and report. **If the timer cannot be proved still armed after a reload, the run does not start.**

**Fire test: the net is proved before anything relies on it. Do not start block 1 without it** (in the
screen: before `b2`).
1. Write the **stock** drop-in, then restart:
   ```
   # workstation, BEFORE the restart: the Ready heartbeat to compare against (see "Waiting for the new kubelet")
   HB=$(scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh read "$CTX" <P>)
   ```
   ```
   sudo systemctl daemon-reload
   sudo systemctl restart kubelet
   ```
   ```
   # workstation
   scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120
   ```
   On P, `exe_sum` must equal the stock sum and `args_sum` must equal `$OKE_ARGS`. (This is also the first
   time our stock build runs on the node.)
2. Re-read the heartbeat now, because step 1's restart moved it and a stale `$HB` would pass at once:
   ```
   # workstation
   HB=$(scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh read "$CTX" <P>)
   ```
   Then fire the timer on a short delay, through the same explicit interpreter, and **poll** for the effect rather
   than sleeping a fixed time:
   ```
   sudo systemctl stop ceiling-revert-test.timer ceiling-revert-test.service 2>/dev/null || true
   sudo systemd-run --unit=ceiling-revert-test --on-active=30s --timer-property=AccuracySec=1s /bin/sh /var/lib/ceiling/revert.sh
   for i in $(seq 1 24); do test ! -e /run/systemd/system/kubelet.service.d/99-ceiling.conf && break; sleep 5; done
   sleep 20
   sudo journalctl -u ceiling-revert-test.service --no-pager | tail -n 5
   test ! -e /run/systemd/system/kubelet.service.d/99-ceiling.conf && echo drop-in-gone
   exe_sum; args_sum
   ```
   ```
   # workstation: HB was re-read just before the timer was armed, so this waits for the timer's own restart
   scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120
   ```
   The first line stops an elapsed test timer that may still be loaded from an earlier try.
3. **The proof is the effect, not the unit's state** (a successful transient service is collected): the
   drop-in is gone, `exe_sum` equals `$OKE_EXE`, `args_sum` equals `$OKE_ARGS`, and P is Ready. **If any of
   these is not so, stop the run**: read `HB` again (it is stale now), run `sudo /bin/sh /var/lib/ceiling/revert.sh` by hand, confirm the same
   three things, and report. The run does not start on an untested net.

## 6. The block loop (founder-run on P; the workstation runs the harness)

P was cordoned at the start of section 5 and stays cordoned (no drain).

**Phase 1, the screen, runs only `b2` (stock) and then `b3` (relist100)**, writing to `ceiling-screen.jsonl`.
**Phase 2 runs all six**, writing to `ceiling-rows.jsonl`. The two phases never share a file.

For each block `bK` with its kubelet `X`, in this order: `b1` oke, `b2` stock, `b3` relist100, `b4`
relist100, `b5` stock, `b6` oke:

1. **Re-arm the auto-revert** (section 5).
2. **Select X and restart, in every block but `b1`** (`b4` restarts onto the same binary as `b3`, so each
   block is freshly restarted). **`b1` follows the fire test's revert restart instead: wait 10 minutes after
   that revert before its checks.** `oke`: remove the drop-in if present. `stock`/`relist100`: write it. Read the
   heartbeat first, just before the restart (it is stale after any earlier swap), then restart:
   ```
   # workstation
   HB=$(scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh read "$CTX" <P>)
   ```
   ```
   sudo systemctl daemon-reload
   sudo systemctl restart kubelet
   ```
   ```
   # workstation, after the restart: wait for the new heartbeat (HB was read just before it, see above)
   scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120
   ```
   If P has no new heartbeat after 120 s, **revert at once** (section 8).
3. **Prove which binary and which flags are running** (the file on disk proves nothing; the running process
   does): `exe_sum` must equal the OKE sum (`oke`), the stock sum or the relist100 sum, and **`args_sum` must
   equal `$OKE_ARGS` in every block**. A mismatch is an abort.
4. **Prove the relist period** with the metric, not the assumption. The histogram is cumulative since the
   kubelet started, so read twice, 60 s apart, and use the delta:
   ```
   kubectl --context "$CTX" get --raw "/api/v1/nodes/<P>/proxy/metrics" | grep -E '^kubelet_pleg_relist_interval_seconds_(sum|count)'
   ```
   mean = (sum2 - sum1) / (count2 - count1). Pass: `oke` and `stock` about 1.00 s; `relist100` between 0.095
   and 0.110 s. Do the same for S: about 1.00 s. A mismatch is an abort.
5. **Settle 5 minutes** after the restart, then **two unrecorded warm-up rounds**: the step 6 command with `2`
   in place of `30`, the output file `ceiling-warmup.jsonl` and `--block=warmup`. Each is a P window, counted
   in section 1.
6. **Run the block** from the workstation, 30 rounds, with the block label. `<P node>` and `<S node>` are node
   names; `<P pool>` is the value of the `kubernetes.io/hostname` label on P (the same as the node name on
   many clusters, but check):
   ```
   PHASE_POD=ceil-harness python3 scripts/bench-cold-start-phases/drive.py 30 \
     'ceil-p@<P pool>,ceil-s@<S pool>' ceiling-rows.jsonl \
     --place-mode=restore --pool-label=kubernetes.io/hostname --namespace=<NS> --context="$CTX" \
     --expect-state='<P node>:cordoned,<S node>:open' \
     --abort-on-foreign='<P pool>' --abort-failed-fraction=0.10 --block=b1
   ```
   `--block=b1` for the first block, then `--block=b2` ... `--block=b6` (the screen uses `--block=b2` then
   `--block=b3` and the file `ceiling-screen.jsonl`). All blocks of a phase append to the **same** file. Check the first two rows: `node` equals P for `ceil-p@...` and S for `ceil-s@...`, and the arm
   strings are the ones passed to the analyzer. Do not continue if they differ. **Timing:** a round is the
   zero-pod wait (median 84-92 s), the 10 s settle and two wakes, 1.9-2.4 minutes, so 30 rounds are
   57-72 minutes; with 17 minutes of restart, metric reads, settle, warm-up and checks a block is 74-89
   minutes. Screen: 15 (fire test) + 2 blocks + 10 (revert) = 173-203 minutes = 2.9-3.4 h. Full run: 15 + 6
   blocks + 1 CRI-O block + 10 = 543-648 minutes = 9-11 h. **The driver exits non-zero, and says why, on:** a cordon changed by someone else, a refused
   cordon, a foreign pod on P (`FOREIGN POD on pool ...`), failed wakes past 10% of the planned ones
   (`stopping: N failed wakes of M planned`, observable mid-run), a held lock, or an unexpected rest state.
   **Treat every non-zero exit as a stop.** Run `kubectl --context "$CTX" get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable`
   and compare with section 4 step 3 (P cordoned, S as it was) before deciding anything. If the driver was
   SIGKILLed, P may be open and S closed: set them by hand, and `--expect-state` will refuse the next start
   until they are right.
7. **After the block:** repeat steps 3 and 4 (`exe_sum`, `args_sum` and the relist mean, which must be
   unchanged), check `systemctl list-timers ceiling-revert.timer` still shows the timer, and
   `systemctl is-active kubelet`. Read the kubelet's CPU from the same metrics endpoint
   (`process_cpu_seconds_total`, two reads).

## 7. Abort criteria (stop, then section 8; section 9 if a node is affected)

Stop the run and report if any of these holds:
- `wait-kubelet-heartbeat.sh wait` finds no new heartbeat on P **2 minutes** after a kubelet restart, or S is ever not Ready.
- A pod outside the bench namespace is evicted, restarted, or fails to schedule, or the driver prints
  `FOREIGN POD on pool <P pool>` (it also stops itself with `--abort-on-foreign`).
- The kubelet crash-loops (more than 2 restarts in 10 minutes), or its CPU stays above half a core for 10 min.
- The driver stops with `stopping: N failed wakes of M planned` (more than 10% of a block), or the analyzer
  later exits 4.
- `exe_sum` or `args_sum` or the relist mean is not the expected one for the block, or the auto-revert fired.
- The driver reports a cordon changed by someone else, or the cordons are not in the recorded state.
- Another benchmark appears on the cluster.
- A step seems to need `kubectl delete`, `--force`, a drain, or a namespace outside the bench namespace.

## 8. Revert (always run, once, at the end or at once on an abort)

All of it works with the kubelet dead, over SSH. It covers the kubelet drop-in and the CRI-O debug drop-in
together, because `revert.sh` removes both:
1. Read the heartbeat **immediately before the revert restart**, then cancel the timer and revert. The swapped
   kubelet has posted newer heartbeats since any earlier read, so an older `$HB` makes step 2 pass on a stale
   value:
   ```
   # workstation
   HB=$(scripts/bench-cold-start-phases/ceiling/wait-kubelet-heartbeat.sh read "$CTX" <P>)
   ```
   ```
   sudo systemctl stop ceiling-revert.timer 2>/dev/null || true
   sudo /bin/sh /var/lib/ceiling/revert.sh
   ```
   This removes the volatile drop-in (and the CRI-O one, if present) and restarts the kubelet: the original
   `$KP` was never touched.
2. Prove it: `exe_sum` equals `$OKE_EXE`, `args_sum` equals `$OKE_ARGS`, and
   `wait-kubelet-heartbeat.sh wait "$CTX" <P> "$HB" 120` succeeds (`$HB` is the one read in step 1, just before the revert).
3. Verify the relist is back: the section 6 step 4 query on P gives about 1.00 s.
4. Verify CRI-O is back if section 11 ran: `test ! -e /etc/crio/crio.conf.d/99-ceiling-debug.conf` and
   `sudo crio-status config | grep log_level` shows the original level (normally `info`).
5. **Uncordon P only now, and only if it was schedulable before the run:** `kubectl --context "$CTX" uncordon <P>`, then
   `kubectl --context "$CTX" get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable` equals the
   state recorded in section 4 step 3. Leave `/var/lib/ceiling` in place until the analysis is done; removing
   a named file there is a node file removal, not a cluster delete.

## 9. Recover a NotReady node (no step relies on the kubelet)

Do not delete the node, the pod or the namespace. Do not use `kubectl debug node`.
1. SSH to P, run `sudo /bin/sh /var/lib/ceiling/revert.sh`, then `systemctl status kubelet` and
   `journalctl -u kubelet -n 200 --no-pager`.
2. SSH down: log in on the **OCI serial console** and do the same.
3. Neither works: a **founder-only** OCI soft reset of the instance. The kubelet drop-in lives in `/run`, so
   the original kubelet starts on boot (verified on kind by a `docker restart` of the node container: `/run` was empty, the original binary ran, the timer was gone; kind's container restart is not a real reboot). The
   timer does not survive the reboot and does not need to. **The CRI-O debug drop-in does survive it**
   (it is in `/etc`): after any reboot, check `/etc/crio/crio.conf.d/99-ceiling-debug.conf` and run
   `revert.sh` if it is there.
4. Keep P cordoned until it is Ready and `exe_sum` is the original. If it is still not Ready after
   10 minutes, node replacement through the OKE console is the founder's decision.
5. Record every action in the run log with the time and the hash at each step.

## 10. Pre-registration: hypotheses, sample, and what each result means

Fixed before any data. Do not revise after the run.

**Phase 1, the screen (pre-registered first).** Two blocks on P, 30 pairs each, stock then relist100 (`b2`,
`b3`): about 3 hours, 64 P windows, 5 kubelet restarts. Analyze with `--blocks=b2:stock,b3:relist100`. The
reading is the table below, with one block per treatment: no carryover row, no mixed row, and the 1 s lock is
judged at alpha / 1. **What it cannot separate:** order (stock always runs first, so a drift or a restart
effect between the blocks lands in the contrast) and the build (no OKE block, so it says nothing about whether
OKE's own kubelet differs from our stock build). **Decision rule:** go on to the full run only if the screen's
verdict is `WAIT_REMOVED_LOCK_UNSEEN`, `RELIST_IS_WAIT_GOAL_MET_ONCE` or `RELIST_IS_WAIT_FLOOR` (the wait
collapsed). Anything else is the answer: report it, revert, stop. The full run exists to separate order and
build effects from the constant, and is worth 9-11 hours only if there is a wait to attribute.

**Hypotheses.**
- **H1 (baseline lock).** On P under the stock build, in every stock block, the 1 s cycle lock is present:
  the Rayleigh statistic in the 1 s band exceeds the 95th percentile of its per-group shuffled null with
  p < 0.05. (The analyzer tests each block and arm on its own: a kubelet restart resets the phase, and a
  drifting period smears a pooled peak.) The 2026-11-02 data showed it on two nodes with about 25 wakes
  each; whether 30 wakes per block is enough power is unverified.
- **H2 (primary, the wait).** Under relist100 the wait on P collapses from about 0-1000 ms to about 150 ms or
  less. Two conditions, both required: P's median wait under relist100 has a 95% bootstrap upper bound of
  150 ms or less, **and** the difference in differences (the P-minus-S median wait difference under
  relist100 minus the same under stock) has an interval entirely below 0.
- **H2b (secondary, the lock).** In the relist100 blocks the 1 s lock on P is gone and a 100 ms lock is
  present. The 1 s lattice has an exact tenth sub-harmonic inside the 100 ms band; a 100 ms lock counts as
  that sub-harmonic only if its period matches a tenth of the 1 s period to within the measured resolution
  (about period squared over span, not a fixed percentage). **Multiplicity:** "the 1 s lock persists" is
  judged at alpha 0.05 divided by the two relist100 blocks (0.025) and needs **both** blocks; one block with
  the lock back is `INCONCLUSIVE_LOCK_MIXED`, never a condemned binary. A working patch still gives a mixed
  result about 5% of the time. This needs at least 40 permutations (the analyzer enforces it).
- **H3 (goal).** The relist should move P's median first byte by about the wait it removes, 450-550 ms
  against the control. From a stock median of about 1640 ms that predicts about **1090 ms (1640 - 550), not
  below 1000**; the sprint plan's own estimate is 1077 ms. So **the goal is not expected to be met by this
  change alone**, and the pre-registered expectation is a floor near 1.08 s. The goal criterion the analyzer
  applies is that the 95% upper bound of P's relist100 median first byte is under 1000 ms. **It is not
  evaluated for an invalid or unattributable run** (rows 1-5 below), and the analyzer prints
  `goal criterion: not evaluated` there.
- **One run cannot pass.** First-byte medians vary between 1276 and 1806 ms from run to run with no change
  at all. The analyzer has no PASS verdict: the best it prints is `RELIST_IS_WAIT_GOAL_MET_ONCE`. A pass
  claim needs the goal criterion met in at least three independent runs, each on fresh pods and at least
  two hours apart. **Repeats are conditional on `RELIST_IS_WAIT_GOAL_MET_ONCE`** (A11): the runbook's own
  estimate is about 1090 ms, so a first run printing it is not expected and repeats are not planned.

**Sample.** Screen: 2 blocks x 30 pairs = 120 wakes. Full run: 6 blocks x 30 pairs = 360 wakes; 60 pairs per
stock and per relist100 treatment, 60 for oke.
Gate: every block needs at least 24 complete pairs and at most 10% unusable wakes (error rows, no node, no
first byte or IP, no logs, no clock offset or one with a round trip over 50 ms are skipped and counted, not
fatal). The 10% limit is checked on a partial file too, before the missing-block check. Intervals are
2000-resample bootstraps, resampled within each block; the lock null uses 100 permutations.
**The blocks are treated as fixed:** only pairs within a block are resampled, and block-to-block variance
(two blocks per treatment) is not, so the intervals are narrower than a random-block model would give. The
carryover screen is the only guard against block-level shifts.

**Reading (fixed in advance).** The analyzer's `VERDICT` is the first row that matches, top to bottom. The
old table had two rows that overlapped (the 1 s lock persists; the median moves 300 ms but the 1 s lock
persists). They are one row now (row 2), and the precedence is this order.

| # | Verdict | Condition | Report as |
|---|---|---|---|
| 1 | `INVALID_NODES` | P rows on more than one node, S rows on more than one, or P and S on the same node | **Invalid.** The arms are not what the design says. Nothing is judged |
| 2 | `INVALID_LOCK_PERSISTS` | the 1 s lock persists on P in **all** relist100 blocks (each at alpha / 2) | **Invalid** for H2: the binary did not run or the relist is not the lock's source. Check the relist metric. Any move in the wait or median (even 300 ms or more) is **reported, not attributed to the relist** |
| 3 | `NO_BASELINE_LOCK` | no 1 s lock on P in some stock block | **Nothing to remove.** Wait results reported, not attributed |
| 4 | `INCONCLUSIVE_LOCK_MIXED` | the 1 s lock persists in some relist100 blocks but not all | **Inconclusive.** Check the relist metric of each block; repeat |
| 5 | `CARRYOVER` | blocks of one treatment differ (a 99% interval on last minus first block's P-S wait delta excludes 0) | **Order-confounded.** No attribution; repeat |
| 6 | `WAIT_WORSE` | difference in differences interval above 0 | **Unexpected.** Reported as measured |
| 7 | `FLOOR_WAIT_UNMOVED` | 1 s lock gone, difference in differences interval includes 0 | **Floor, wait unattributed:** the wait is elsewhere in the pod path |
| 8 | `FLOOR_WAIT_PARTIAL` | difference in differences below 0, but P's relist100 wait upper bound is over 150 ms | **Floor.** Part of the wait is not the relist |
| 9 | `WAIT_REMOVED_LOCK_UNSEEN` | wait collapsed and 1 s lock gone, **no 100 ms lock detected** | **Wait attributed to the relist constant; the lock mechanism is not confirmed** ("1 s lock gone, 100 ms lock undetected") |
| 10 | `RELIST_IS_WAIT_GOAL_MET_ONCE` | row 9's conditions plus a 100 ms lock, and the goal criterion met | **Goal met once.** Not a pass (needs three independent runs). Founder decides on a custom node image, an upstream push, or the early announcer |
| 11 | `RELIST_IS_WAIT_FLOOR` | row 9's conditions plus a 100 ms lock, goal criterion not met | **Floor.** The relist is the wait; removing it does not reach the goal on OKE |

**`WAIT_REMOVED_LOCK_UNSEEN` may be the best verdict reachable, and the wait is the primary signal.** A
simulation of the lock test during review found a 100 ms lock in 0 of 12 runs at 1 ms of per-cycle jitter and
in 9 of 12 at 0.5 ms (reported to this change, not reproduced here). Row 9 is therefore a likely outcome even
when the relist is the wait; it is not a failure. The goal is judged on the wait and the first byte, not on the
lock.

Any valid result that does not meet the goal is reported as a **floor**, not as a shipped default; a
non-pass reads as a floor. Nothing here changes what ships.

Secondary reading, never a verdict row: the slower-cluster share (bound to user first log of 650 ms or more)
as a difference in differences. An interval excluding 0 means the slow cluster moved with the treatment;
including 0 is **not resolved at this n** and cannot show the shares are equal.

**Known confounds, stated in advance.**
- Build: oke blocks run the OKE binary, stock and relist100 run ours (CGO off, `-trimpath`). The oke-versus-
  stock comparison (`wait build effect`) measures it; the section 4 step 9 check and the per-block
  `args_sum` check name any other difference.
- Node and app: P and S are different nodes and different NextApps with identical specs; the difference in
  differences removes what is constant between them.
- Drift: a linear drift on P alone cancels in the ABBA stock-versus-relist100 contrast; a non-linear one does
  not, and the blocks are fixed effects in the intervals (above).
- Harness placement: same-node for S, cross-node for P (section 2).
- Restarts: every block follows a restart (`b1` follows the fire test's revert, after a 10-minute settle).
  Carryover compares same-treatment blocks.
- Cordon-only: P keeps its existing pods, and takes any new pod scheduled during a P wake window.
- Timestamps: `pod_ip` is the harness's clock and the queue-proxy log is the node's clock re-based by the
  measured offset (section 2); the offset's error bound is half its round trip, not subtracted.

## 11. Final attribution block, CRI-O debug (P only; after the six blocks, before the section 8 revert)

Not part of the design above and not analyzed with it. S carries **no** debug logging, ever.
1. P is on the OKE kubelet after `b6`. **Re-arm the timer** (section 5), so a vanished operator is covered
   for this block too; `revert.sh` also removes the CRI-O drop-in.
2. Write the drop-in (A5) and reload:
   ```
   sudo tee /etc/crio/crio.conf.d/99-ceiling-debug.conf >/dev/null <<'EOF'
   [crio.runtime]
   log_level = "debug"
   EOF
   sudo systemctl reload crio
   ```
3. **Verify the live daemon, not the files.** `crio config` prints what the files say, not what the running
   daemon uses. Check the daemon: `sudo crio-status config | grep log_level` (it queries the daemon over its
   socket; from memory, verify) and `sudo journalctl -u crio -n 100 --no-pager | grep -c 'level=debug'`
   must be above 0 and growing. Whether `log_level` reloads on SIGHUP is from memory (crio.conf(5)); verify.
4. Run 30 pairs with `--block=b7` into a **separate** file (`ceiling-b7-debug.jsonl`); the analyzer rejects
   unknown labels. Use the same command as section 6 step 6. Compare with `b6` by eye, descriptively, to see
   what debug logging costs.
5. Then run section 8, which removes the debug drop-in with the rest.

## 12. Host log reader (separate, founder-applied step; read-only queries only)

Not created or applied by this runbook. After the window, on P and S:
```
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager -o short-iso
sudo journalctl -u kubelet --since "<start ISO>" --until "<end ISO>" --no-pager | grep -E 'pleg|SyncPod|Pod status|generic'
sudo journalctl -u crio --since "<start ISO>" --until "<end ISO>" --no-pager
sudo sha256sum /proc/$(systemctl show -p MainPID --value kubelet)/exe
```

## 13. After the run

1. Section 8 done: P and S Ready, P's exe hash the original, cordons as recorded, CRI-O back.
2. Analyze. **Phase 1, the screen:**
   ```
   python3 scripts/bench-cold-start-phases/ceiling/lattice_analyze.py ceiling-screen.jsonl --blocks=b2:stock,b3:relist100 \
     --p-arm='ceil-p@<P pool>' --s-arm='ceil-s@<S pool>' --perms=100 --boot=2000
   ```
   Apply the section 10 decision rule. **Phase 2, the six blocks:**
   ```
   python3 scripts/bench-cold-start-phases/ceiling/lattice_analyze.py ceiling-rows.jsonl \
     --p-arm='ceil-p@<P pool>' --s-arm='ceil-s@<S pool>' --perms=100 --boot=2000
   ```
   Use the arm strings exactly as the harness wrote them. Exit 3 means a block is missing or short; exit 4
   means more than 10% of a block's wakes were unusable; both judge nothing.
3. Report the `VERDICT` line and its `reading`, the per-block lock table, the wait difference in differences,
   the build and carryover lines, the clock round trips, and the descriptive p95 with its caveat. Report a
   missed goal as a floor.

## 14. Cleanup (founder-only deletes; nothing in this runbook runs one)

After the analysis, and only when the founder decides. This section **lists** what was created; it deletes
nothing.
- **Cluster objects from section 4 (A8):** the NextApps `ceil-p` and `ceil-s`, the pod `ceil-harness`, the
  node-agent pods, and the harness ServiceAccount, Role and RoleBinding in `<NS>`. Removing them is a
  founder-only delete. Until then the harness pod runs as root and sleeps for 48 hours before it exits on its
  own; the agents have no expiry and answer a clock request on port 8080.
- **Files on P:** the contents of `/var/lib/ceiling` (named-file removals, not a cluster delete). The kubelet
  drop-in under `/run` and the CRI-O drop-in are already gone after section 8.
- **The OCI serial console connection (A4):** removed in the OCI console.
- **The kind rehearsal cluster (A6):** a founder-only `kind delete`.
- **Cordons:** P and S are back to the recorded state (section 8 step 5); nothing to do.
- **Keep:** the run log, `ceiling-screen.jsonl`, `ceiling-rows.jsonl`, `ceiling-warmup.jsonl` and
  `ceiling-b7-debug.jsonl` on the workstation.

## 15. What only a real node can answer (unverified)

- Whether the CGO-off kubelet starts and behaves on OKE at all (also first checked on kind).
- Whether the OKE kubelet is a plain upstream build, and whether the volatile drop-in, SELinux labels and the
  OKE unit layout behave as described; whether `ExecStart` is a wrapper; whether the fire test passes under
  the node's SELinux policy.
- What a kubelet restart does to P's existing pods and to node Ready on OKE (kind showed no pod restarts; OKE runs CRI-O, and its pods are Knative's).
- A reboot reverting to the OKE binary on a real instance, and the OCI console route.
- Whether CRI-O reloads `log_level` on SIGHUP and `crio-status config` reports the live level.
- Whether 30 wakes per block is enough power for the 1 s lock test, and the real size of carryover.
- That no foreign pod lands on P during the P wake windows.
- That a node-agent pod exists and answers on both nodes (otherwise every row is unusable).
