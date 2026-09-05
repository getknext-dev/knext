# Review — #744 netpol-inert observability (adversarial)

**Verdict: ISSUES_FOUND** — the architecture, contracts, and tests all hold and were
independently re-proven, but the brief's "Calico installed but crashed" attack lands: the
detection claims **enforced** from a DaemonSet *name* alone, and both halves word that claim
stronger than the signal supports. One fixable finding class; everything else verified clean.

Worktree `/Users/banna/alpheya/pocs/knext-wt/netpol-inert`, branch
`feat/netpol-inert-observability`, one commit (8e936c8) vs origin/main. 12 files, +1085/−29.

## Finding 1 (must fix) — a crashed/inert enforcing agent still yields "enforced"

`classifyCNIEnforcement` (both halves) consumes only `{namespace, name}`. A cluster where
`calico-node` exists but is CrashLoopBackOff / 0-ready produces:

- doctor PASS: "…the operator's default-on NetworkPolicy **is enforced on this cluster**"
  (`doctor.ts`, verdict `enforced` branch);
- operator condition True: "…the reconciled NetworkPolicy **is in force**"
  (`status_verdict.go`, `ReasonPolicyControllerDetected`).

That is a false "enforced" — precisely the "security control believed in force but silently
inert" failure #744 exists to eliminate, now asserted affirmatively instead of by silence.
The data to avoid it is **already in hand in both halves**: doctor fetches the full DaemonSet
JSON (`status.numberReady`/`desiredNumberScheduled` are in `ds.stdout`), and the operator
lists full `appsv1.DaemonSet` objects before shrinking them to `dsRef`. Fix: an enforcing-agent
match with 0 ready pods must degrade to **unknown** ("agent installed but not running — treat
as unenforced"), never "enforced". Add the crashed-agent case to both classifier test tables.

## Finding 2 (should fix, same patch) — "enforced" wording overclaims even when the agent is healthy

The brief's attack (3): CNI present ≠ policies enforced **for this namespace**. A healthy
`cilium` DaemonSet with `policyEnforcementMode: never`, or Calico configured to exempt a
namespace, still gets "is in force"/"is enforced on this cluster". Signature detection cannot
see per-namespace/config exemptions — the messages should claim what the signal supports:
"a NetworkPolicy-enforcing agent is running (…) — NetworkPolicy objects should be enforced;
per-CNI configuration can still exempt traffic; verify if isolation is load-bearing." The
False/Unknown wording is already honest; only the True/PASS side overclaims.

## What was attacked and held

- **Read-only contract:** diff scanned — zero `kubectl create/apply/run/patch/delete` added;
  the only probe is `kubectl get daemonsets -A -o json`. No probe pods. HOLDS.
- **No recognizable CNI:** WARN "cannot determine … treat as UNENFORCED until verified", with
  an explicit `expect(c.status).not.toBe("pass")`. Never a false enforced. HOLDS.
- **RBAC-denied list:** WARN cannot-determine (not ERROR), RBAC hint present; network-flake is
  ERROR exit 1 per #230. HOLDS.
- **Cilium in a nonstandard namespace:** matching is name-only and namespace-agnostic
  (`-A` / cluster-wide List); tested with `calico-node` in `calico-system`. HOLDS.
- **Canal precedence:** enforcing agent outvotes flannel; tested in both halves. HOLDS.
- **Hard rule (no new Reconcile status branches):** the Reconcile diff only observes
  (`detectNetworkPolicyEnforcement`) and passes `netpolEnforcementState` into
  `computeStatusVerdict`; the condition/event mapping lives entirely in `status_verdict.go`.
  The `if np.enabled` in Reconcile is I/O gating, not a status branch. HOLDS.
- **Status-only, no CRD change:** no `api/`/CRD path in the diff, AND `make test` re-ran
  `manifests generate` with the tree staying clean — independent proof of zero schema drift.
  HOLDS. (The mechanical CLI-surface trigger still fires — `packages/kn-next/src/cli/` is in
  the diff — so the design-gate summon at PR time stands, as the implementer flagged.)
- **Flannel caveat:** doctor WARN names "declarative only", "enforces NOTHING", OKE GA +
  OrbStack, with the Calico/Cilium hint; operator False message matches. HOLDS.
- **Event churn:** Warning event transition-gated on entering NoPolicyController; messages
  static per cluster state (evidence sorted both halves); disabled ⇒ condition dropped only if
  previously present. Covered by `TestVerdictNetpol*` (5 tests) + 3 envtest specs. HOLDS.
- **DaemonSet RBAC:** `get;list;watch` already in the kubebuilder marker + `role.yaml` — no
  new permission needed. HOLDS.

## Mutation proof (mine, independent of the implementer's M1–M5)

- **TS half:** always-enforced stub at the top of `classifyCNIEnforcement` (anchored insert,
  anchor asserted unique) → **15 of 96 tests red**, genuine assertion failures (my first
  attempt was a syntax-error false kill from a literal `\n` — detected via the log, thrown
  away, redone). Restored, verified clean.
- **Go half (stronger, wiring-level):** always-enforced stub at the top of
  `detectNetworkPolicyEnforcement` — classifier unit tests deliberately stay green, so this
  isolates the envtest's power → focused run first proven green ("Ran 3 of 108 Specs",
  absolute KUBEBUILDER_ASSETS), then **2 of 3 specs red** (Unknown-fallback + flannel-False).
  Restored, `git status` clean.

Both halves red under an inert detection. The suite is not decoration.

## Gates (run by me)

| Gate | Result |
|---|---|
| operator `make test` (fmt+vet+manifests+generate+full envtest) | EXIT 0, controller 83.0% |
| vitest — all 4 doctor suites | 108/108 pass |
| `tsc --noEmit` | clean **after** building `@getknext/lib`+`@getknext/db` (first run failed on missing workspace dist — pre-existing class, not this change) |
| `biome check .` | clean |

## Minor notes (no action required)

- `flannel` substring match could false-positive on an unrelated DS name containing "flannel"
  (e.g. a monitoring exporter) → likely-unenforced WARN. Fails toward caution, acceptable.
- Condition named `NetworkPolicyEnforced` vs the brief's "NetworkPolicyEnforcement" — the
  implementer's K8s-convention rationale is sound; lead/gate to confirm the literal name.
- `DOCTOR_HELP` uses `\n` escapes inside a template literal — renders correctly, style-odd only.
- AC5 (reference-cluster CNI decision) correctly deferred to the architect, not decided here.

## Bottom line

Fix Finding 1 (0-ready enforcing agent ⇒ unknown, both halves, with tests) and hedge the
True/PASS wording (Finding 2), then this is approvable. Everything else — contracts, hard
rules, honesty of the Unknown/False paths, TDD, mutation resistance — survived attack.

---

# Round 2

**ISSUES_FOUND** — the Go half is a genuine, well-reasoned fix for both findings, but it is
**uncommitted**, the **doctor half was never touched**, and in its current state it leaves the
operator envtest suite **RED**. Three blockers, one gap.

## State of the branch (check this first — it is not what the request assumed)

`HEAD` is still **`8e936c8`**, byte-identical to what I reviewed in round 1;
`origin/feat/netpol-inert-observability` points at the same commit. **Nothing was committed.**
The fix exists only as uncommitted working-tree modifications to **four Go files**:

```
 M internal/controller/netpol_enforcement.go        (+31)
 M internal/controller/netpol_enforcement_test.go   (+79)
 M internal/controller/status_verdict.go            (+27)
 M internal/controller/status_verdict_test.go       (+45)
```

`git status -- packages/kn-next/` is **empty**. No TypeScript changed at all.

## Blocker A — the operator test suite is RED right now

The fix breaks the branch's own AC-proving envtest spec:

```
[FAIL] NetworkPolicyEnforced condition (#744)
       [It] reports False/NoPolicyController on flannel, then True once a policy controller appears
       netpol_enforcement_envtest_test.go:132
Ran 3 of 108 Specs — 2 Passed | 1 Failed
```

Line 132 is `Expect(c.Status).To(Equal(metav1.ConditionTrue))`. **Cause:** envtest runs no
kubelet and no DaemonSet controller, so a DaemonSet created via `k8sClient.Create` keeps
`status.numberReady = 0` forever. The new `ready: ds.Status.NumberReady > 0` therefore files the
freshly-created `calico-node` into the crashed bucket → Unknown, never True. **Fix:** after
creating the calico DaemonSet the spec must set the status subresource explicitly
(`k8sClient.Status().Update(...)` with `NumberReady: 1`), which is also what closes Gap C below.

This was easy to miss and worth stating: the Go unit tests pass, and my own M2 mutation run
(`ready: true`) went green precisely *because* it masked this. Only running the full suite on the
unmutated tree surfaced it.

## Blocker B — the doctor half is entirely unfixed (both findings)

The brief required both halves. In `packages/kn-next/src/cli/doctor.ts`, unchanged since round 1:

- `DaemonSetRef` is still `{ namespace, name }` — **no readiness field**, so a caller cannot even
  express "not running". The only `readyReplicas` reads in the file (lines 381/385/893) belong to
  the operator-Deployment check, not this one.
- Line 1190 still carries the exact Finding-2 overclaim:
  `"…the operator's default-on NetworkPolicy is enforced on this cluster"`.

**Demonstrated, not just read.** A throwaway probe against the current classifier (run, then
deleted; tree verified clean afterwards):

```
PROBE_VERDICT=enforced
AssertionError: expected 'enforced' to be 'unknown'
```

So `kn-next doctor` on a cluster whose `calico-node` is in CrashLoopBackOff still prints **PASS —
"is enforced on this cluster"**. The round-1 false green is live in the shipped CLI path.

## Gap C — the one line that reads the cluster fact has zero coverage

Mutation **M2**: `ready: ds.Status.NumberReady > 0` → `ready: true`, run against the **full**
controller package including all 108 envtest specs → **green, survived**. The classifier tests
hand `ready` in as a literal, so they can never catch a broken read of the real DaemonSet status.
By this repo's own standard ("a guard that stays green when its subject is removed is
decoration") the cluster-facing half of the Finding-1 fix is currently unguarded. Fixing
Blocker A with an explicit status update, plus a 0-ready spec, kills M2 and closes this.

## What the Go fix gets right (keep all of it)

- **Finding 1:** `dsRef.ready`; a matched-but-0-ready agent goes to a `crashed` bucket returning
  **Unknown** with evidence naming the dead agent. Precedence is deliberate and defensible —
  a ready agent still wins (rolling restarts), and a dead agent outranks the flannel fallback as
  the more specific signal. Documented in the comment, not just the code.
- **Finding 2:** the True message is now *"a NetworkPolicy-enforcing agent is running (…) —
  NetworkPolicy objects **should be** enforced; per-CNI configuration can still exempt traffic, so
  verify directly if isolation is load-bearing"* — exactly the honest ceiling, with the Cilium
  `policyEnforcementMode` case named in the comment. `"is in force"` is gone.
- **Unknown now has two flavors** sharing one reason, both static per cluster state (#98 holds).
- **Tests (5 new, all passing):** crashed-alone, crashed+flannel, ready-beats-crashed,
  crashed-names-the-dead-agent, and a wording test that asserts **both halves** — the hedge is
  present *and* `"is in force"` is absent. That negative assertion is the right pattern.
- **Mutation M1** (classifier ignores `ds.ready`) → 2 tests red. Killed.

## Round-1 items re-verified clean

| Item | Result |
|---|---|
| Read-only doctor contract | No mutating `kubectl` in branch **or** uncommitted diff. HOLDS |
| `status_verdict.go` placement (hard rule) | `nextapp_controller.go` untouched by the fix; mapping stays wholly inside `computeStatusVerdict`. HOLDS |
| Status-only / no CRD change | Zero `api/` or `config/crd/` paths. HOLDS |
| `go vet` / `gofmt` | Clean |
| Go unit tests (classifier + verdict) | 16/16 pass |

## Minor (not blocking)

`NumberReady > 0` treats *partial* readiness as enforced — `calico-node` ready on 2 of 5 nodes
means no enforcement on the other 3. `NumberUnavailable == 0` would be stricter. The new hedged
wording ("verify directly if isolation is load-bearing") softens this, so it is a judgement call
worth a comment rather than a required change.

## To clear round 3

1. Set `NumberReady: 1` via the status subresource on the calico DaemonSet in the existing envtest
   spec → suite green again.
2. Add a 0-ready envtest spec (create a `calico-node` DaemonSet, leave status zeroed, assert
   Unknown + "not running") → kills M2, closing the untested read.
3. Port the fix to `doctor.ts`: add `ready` to `DaemonSetRef`, populate it from
   `status.numberReady` (already present in the `-o json` the check fetches), degrade a 0-ready
   match to the WARN cannot-determine path, and hedge line 1190's wording to match the operator's.
   Cover both in `doctor-netpol.test.ts`.
4. **Commit it** — and re-run the full operator suite *and* vitest on the committed tree, not a
   filtered subset.

**Reviewer hygiene:** the tree held uncommitted work, so I backed the files up and restored by
SHA-256 rather than `git checkout` (which would have destroyed the fix). Both mutations were
anchored on an assert-exactly-once script; final checksums verified identical to the pre-review
state, and the temporary probe file was removed. `git status` is back to the same four modified
files plus the untracked implementer report.

---

# Round 3

**APPROVE** — both halves now agree, all three round-2 blockers are closed, and the ready-check
reds **independently in each half** at both the classifier and the cluster-read layer. Round-1's
clean list is intact. No new findings.

Commit `22f0ec1` on top of `8e936c8`, pushed (`origin/feat/netpol-inert-observability` matches).
Working tree clean apart from the untracked implementer report. 8 files, +356/−51.

## Round-2 blockers — all closed

**A. Suite red → green.** The envtest gained `markDaemonSetReady`, which writes the status
subresource a real DaemonSet controller would (`NumberReady: 1` et al.), and the enforced-case
spec now calls it. The helper's comment states the trap in full — envtest runs no kubelet, so an
unmarked DaemonSet *is* the crashed case, meaning an enforced-case spec would silently test the
wrong thing. `make test` exits 0.

**B. Doctor half implemented, mirroring Go.** `DaemonSetRef.ready` is now required (so a caller
cannot omit readiness), a `crashed` bucket returns `unknown` with evidence naming the dead agent,
and a dedicated WARN branch fires for it with a genuinely useful hint (pointing the reader at the
agent's own pods). The read is `(i.status?.numberReady ?? 0) > 0` — **absent status coerces to 0,
i.e. not running**, which is the fail-safe direction. Precedence matches Go exactly: ready wins,
dead agent outranks the flannel fallback, nothing recognized is unknown.

**C. The cluster-read seam is now guarded — in both halves.** This was round 2's surviving
mutation; it no longer survives (see below).

## Mutation proof — four mutations, four kills, both halves independently

| # | Mutation | Layer | Result |
|---|---|---|---|
| MG1 | Go classifier `if ds.ready` → `if true` | pure classifier | **2 unit tests red** |
| MG2 | Go detector `ds.Status.NumberReady > 0` → `true` | live cluster read | **envtest red** ("Ran 4 of 109 — 1 Failed") |
| MT1 | TS classifier `if (ds.ready)` → `if (true)` | pure classifier | **3 tests red** |
| MT2 | TS `(i.status?.numberReady ?? 0) > 0` → `true` | JSON→ref mapping | **1 test red** |

MG2 is the one that matters most: in round 2 it survived the **entire** 108-spec suite, proving
the cluster-facing half of the fix was decoration. The new spec — "reports Unknown when an
enforcing agent is installed but has no running pod", which creates a `calico-node` DaemonSet and
*deliberately leaves its status zeroed* — kills it. Its comment says exactly why it must exist:
the classifier tests hand `ready` in as a literal and can never catch a broken read.

MT2 kills the TS equivalent because the fixture helper builds real `status.numberReady` JSON
(`ready === false ? 0 : 1`, fixtures opting **in** to health), so `runDoctor` exercises the true
parse→map→classify path rather than calling the classifier directly. All failures were genuine
assertions — no syntax/transform errors. Tree restored and verified clean after each.

## Finding 2 wording — hedged in both halves, pinned by tests

- **doctor PASS:** "a NetworkPolicy-enforcing agent is running (…) — the operator's default-on
  NetworkPolicy objects **should be** enforced; per-CNI configuration can still exempt traffic, so
  verify directly if isolation is load-bearing."
- **operator True:** same hedge, same two clauses.
- `"is enforced on this cluster"` and `"is in force"` are both **gone from every message string**.
  The only surviving `"is in force"` in the tree is at `status_verdict.go:494` — inside a comment
  stating the rule (*"Should be enforced", never "is in force"*), which is documentation, not
  output. Zero `Message:` lines contain it.
- Both halves pin it with **both-halves assertions**: the hedge must be present *and* the
  overclaim absent (`expect(c.detail).not.toMatch(/is enforced on this cluster/i)`;
  `if strings.Contains(c.Message, "is in force") { t.Fatalf(...) }`). That satisfies this repo's
  most-common-defect rule rather than merely asserting the happy string.

## Round-1 clean list — no regressions

| Item | Verification | Result |
|---|---|---|
| Read-only doctor contract | Full-branch diff scanned for cluster-mutating kubectl verbs; `doctor.ts` grepped for the same | **0 hits — creates nothing, no probe pods** |
| `status_verdict.go` placement (hard rule) | `nextapp_controller.go` not in the round-3 commit; mapping wholly inside `computeStatusVerdict` | HOLDS |
| No spec/CRD schema change | Zero `api/` or `config/crd/` paths in the full branch, **and** `make test` re-ran `manifests generate` leaving `git status` clean | **status-only confirmed independently** |
| Flannel caveat, canal precedence, RBAC-denied → WARN, network-flake → ERROR, event churn | Covered by the unchanged round-1 specs, still green | HOLDS |

## Gates (run by me, on the committed tree)

| Gate | Result |
|---|---|
| operator `make test` (manifests+generate+fmt+vet+full envtest) | **EXIT 0**, controller **83.2%** — matches the implementer's report |
| Manifest drift after `make test` | none (`git status` clean) |
| vitest — all 4 doctor suites | **112/112** (was 108; +4 new) |
| `biome check` (doctor.ts + netpol tests) | clean |
| `tsc --noEmit` | **0 errors outside generated fixture residue** |

One honest note on that last row: `tsc` does emit two `TS1128` errors in
`src/__tests__/fixtures/dev-edge-fence/.next/dev/types/routes.d.ts`. That file is **untracked
build residue** (`git ls-files` does not know it) and absent from the branch diff — same
pre-existing class as round 1's missing-dist failures, not attributable to this change. Excluding
generated fixture output, the count is zero.

## Minor, non-blocking (unchanged judgement from round 2)

- `numberReady > 0` still treats *partial* readiness as enforced (agent up on 2 of 5 nodes). The
  implementer now documents the trade-off explicitly in `doctor.ts` — the verdict answers "is an
  enforcing agent alive at all", with the hedged wording covering the rest. Reasoned, not
  overlooked; fine as is.
- doctor's PASS string reads slightly awkwardly — "the operator's default-on NetworkPolicy
  **objects** should be enforced" grafts the plural onto the singular policy. Pure prose; the
  operator's phrasing ("NetworkPolicy objects should be enforced") is cleaner. Optional tidy.
- Round 1's open items still stand and are not this PR's to close: the `flannel` substring match,
  the `NetworkPolicyEnforced` type name for the lead to confirm, and AC5 (the reference-cluster CNI
  decision) remaining an architect call.

## Verdict

The security control now reports its own inertness honestly at both the CLI and the cluster: an
installed-but-dead agent, an unrecognized CNI, and a denied read all land on "treat as
unenforced", while "enforced" claims only what a running agent supports. Both halves are tested,
both resist mutation at both layers, and the read-only/status-only/no-Reconcile-branch contracts
are intact. **APPROVE.** The mechanical CLI-surface trigger still fires
(`packages/kn-next/src/cli/` is in the diff), so the design-gate summon at PR time remains the
lead's call — that is process, not a review objection.
