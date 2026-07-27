# Sprint 1 — the road to v1.0

> Planned by the architect and system-designer gates under `.claude/rules/workflow.md`.
> Plan: `docs/V1_ROADMAP.md`. Exit-criteria style: `docs/MATURITY_PLAN.md`.
> This is the artifact teams work from. If it disagrees with the code, the code wins — say so.

## The fact that shapes the sprint

**The compat gate is wall-clock bound, not effort bound.** The v1.0 definition of "green" is *14
consecutive scheduled node-lane runs, every shard `failed:0`/`notRun:0`, with zero net new
quarantine entries*. The suite runs nightly, so that is ~2 weeks minimum **from the moment the clock
starts** — and any change to the harness, the lifecycle scripts, the manifest or the shipped adapter
tarball during the window **resets it**.

> Sprint 1's most valuable output is not features. It is **starting the compat clock, once, on a
> harness nobody will need to touch again.** Everything else is scheduled around not disturbing it.

That is why the sprint is front-loaded with two unglamorous tasks, and why several larger P1 items
are deliberately held to sprint 2.

## Tasks

| id | task | issue | track | owner-exclusive files |
|---|---|---|---|---|
| T0 | root `tests/` type-checked | #527 | gate-zero | root tests tsconfig, `package.json`, `ci.yml` |
| T1 | compat shard flakiness — named mechanism | #545 | A | `test-e2e-deploy.yml`, `scripts/e2e-*.sh` |
| T2 | quarantine entries require a real upstream ref | #512 | A | `tests/compat-lane-ledger*.ts`, deploy-tests manifest |
| T3 | open + police the 14-night window (no code) | #410 | A (lead) | window log under `docs/compat/` |
| T4 | close the four unbacked matrix rows | — | B | `scripts/compat-smoke.mjs`, `docs/compat-matrix.md` |
| T5 | emitted-fields extractor + live-CRD schema reader | #314 | C1 | new `src/cli/schema/*` |
| T6 | prune preflight + `doctor` schema coverage | #314 | C1 | `deploy.ts`, `preview.ts`, `doctor.ts` |
| T7 | generated CR/CRD compatibility artifacts | #314 | C2 | new `scripts/gen-*`, `docs/compat/cr-fields.md` |
| T8 | ADR-0017 amendment — CRD versioning at 1.0 | — | C2 | `docs/adr/0017-*`, `docs/PUBLIC_API.md` |
| T9 | document upgrade order (operator/CRD → CLI) | #548 | C2 | `docs/adr/0020-*`, `docs/RELEASING.md` |
| T10 | attribute the ~11 s cold-start mode | #309 | D | analysis + OKE run |
| T11 | per-sample attribution capture + durability | #536, #425, #551 | D | `benchmarks/scale-to-zero-oke/**` |
| T12 | fix, conditional on T10 + an ADR | #309 | D | `nextapp_controller.go` |
| T13 | SIGTERM during revalidation: never torn | #448 (node half) | E | `adapters/shutdown.ts`, `cache-handler.js` |
| T14 | cache-handler failure injection (4 modes) | — | E | same as T13 |
| T15 | nightly SHA↔tag resolution check | #539 | F | one new workflow + its test |
| T16 | EKS credential/budget request (zero code, day 1) | #306 | F (human) | — |

**Critical path:** `T0 → T1 → T2 → T3 → 14 nights`. It completes mid-sprint-2 and *is* the 1.0
critical path.

## Amendment — T10's hypothesis died on day one

The plan proposed a specific cause for the ~11 s mode: the operator pins the readiness probe to
`initialDelaySeconds: 2` / `periodSeconds: 3` with no `failureThreshold`
(`nextapp_controller.go:977-986`), so an app with a ~1.96 s boot floor misses the first tick and
pays `2 + 3 (+3) ≈ 8 s` — discrete, target-independent, and the right magnitude.

**It is falsified, and it never needed a run to falsify it.** The measured arms
(`p1b-node`, `p1b-bunexec`) carry `periodSeconds: 1`, `failureThreshold: 3` and **no
`initialDelaySeconds`** — and there is **no operator on that cluster at all**, so those source
values have never executed there. Against the real config the probe can contribute at most
`3 × 1s = 3s`, against an observed ~8 s step. Off by nearly 3×.

**Root cause of the error: the plan reasoned from operator *source* and treated it as describing the
*running system*.** That is the same class of mistake this project has been retiring from its
strategy docs all week, and it is why `workflow.md` step 4 now says verifying on OKE means verifying
what is *deployed*, not what is in the tree.

T10 is therefore **not** a probe A/B. It is the instrumented attribution run (see below). T12
remains conditional and currently has no hypothesis to implement.

**Surviving lead, explicitly not a conclusion:** every observation of the slow mode has been on an
arm using `httpGet /api/health`; every unimodal arm (`file-manager`, Runs 23 and the current one)
has used a bare `tcpSocket` probe. The difference is the *predicate* — a tcpSocket probe passes when
the socket binds, an httpGet requires the app to serve a request. That is discrete and app-level,
which fits. It is **confounded** (the apps differ in more than their probe) and must be tested by
asking which interval the ~8 s lives in, not by asserting it.

## What each task must assert — the "silently useless" list

For each task, the one way it could be marked done and still protect nobody. These belong in the
exit criteria, not in a reviewer's head.

| task | how it fails silently | therefore assert |
|---|---|---|
| **T6** prune preflight | compares emitted fields against a schema derived from the same source as the emitter, so both move together and skew is undetectable; or downgrades to a warning when the CRD read is denied — exactly when it matters | a CRD fixture with a field **removed**, authored independently of the generator, causes a **non-zero exit**; RBAC denial is a **hard failure** |
| **T7** generated artifacts | generated, then diffed against a checked-in copy the same job just rewrote — self-consistent and permanently green | a **dirty-tree check** after generation reds CI, **and** a hand-broken artifact fails the `⊆` assertion |
| **T10/T11** attribution | every sample gets a `cause` from a heuristic, so 100 % are "classified" and nothing is discriminated | an **`unattributable` bucket that may be non-empty and must be reported**. Zero unattributable samples with no falsification experiment is *suspicious, not good* |
| **T10** bounding the mode | a distribution from one node, one day, one revision — literally honest, and an artifact of that node | ≥ 2 nodes, ≥ 2 days, **stratified per node**; scope disclosed at that granularity; **no median anywhere** |
| **T13** SIGTERM | the signal lands when nothing is mid-write, so the race is never hit and a real torn write still ships | a deterministic seam pauses the write mid-flight, and **the test fails without the fix** |
| **T14** failure injection | injected at the client wrapper, so "Redis timing out" is a mocked rejection — while the case that actually hurts is a socket that **hangs and never rejects**, which a mock cannot produce | at least the hang case is driven at the socket level, not the client API |

## Parallelism

Tracks A–F run concurrently with disjoint owner-exclusive files (above). Constraints that are not
negotiable:

- **T0 is gate-zero.** Nothing else starts on a tier whose own guards are unchecked.
- **The OKE cluster is a queue of one**, regardless of team count. Two runs against it silently
  invalidate each other — concurrent traffic keeps pods warm, so a "cold" start is not cold.
- **The compat suite's scheduled runs are shared and unparallelisable.** Once T3 opens the window,
  Track A stops touching the harness. #528 is out of this sprint for exactly this reason — it edits
  `test-e2e-deploy.yml` — while #539 stays in because it adds a *new* workflow and cannot reset the
  clock.
- **T4 and T7 both want `docs/compat-matrix.md`.** T4 owns it this sprint; rendering it from
  generated artifacts is sprint 2.
- `isolation: "worktree"` is mandatory for concurrent implementers; one branch, one worktree.

## Expected escalations

Named up front so a team recognises one rather than deciding for itself.

1. **T10 — plan-invalidating.** Already fired, before any code. See the amendment above.
2. **T6 — ADR + CRD surface.** A CLI-side preflight cannot protect the GitOps path at all: Argo and
   Flux never invoke the CLI. Both tempting fixes are triggers — a validating webhook (which cannot
   see a field the apiserver already pruned) or a CLI-emitted schema fingerprint the operator
   compares. The latter changes the shape of the emitted CR, which is 1.0-committed. **Expected
   failure mode: quietly narrowing the exit criterion to "preflight passes on kubectl paths" and
   dropping the GitOps residual.**
3. **T4 (ISR row) — discovered fact.** Running ISR with a real `REDIS_URL` for the first time may
   show revalidation is not merely ungated but wrong.
4. **T2 — discovered fact.** If requiring real upstream refs forces removals that red the node lane,
   the sprint's premise is false and T3 cannot open. **Stop; do not re-quarantine.**
5. **T8 — decision.** Ship on `v1alpha1` or graduate. The graph assumes the roadmap's
   recommendation; the other answer makes a conversion webhook the longest pole in 1.0.
6. **T15 — phasing override.** `security.md` calls the SHA↔tag check near-term while the roadmap
   files it under P3. The packages are published, so a live publish credential is in scope; resolved
   in favour of `security.md`. Recorded because it is the architect overriding the roadmap, not a
   team's call.

## Held to sprint 2

EKS (#306, needs T16's credential clock and a second external-state queue) · skew and
upgrade-under-load e2e (needs a published vN-1 operator artifact, and competes with the compat
window) · `kn-next status --explain` (a 1.0-committed CLI surface whose shape T10/T11 will
determine — building it now freezes the wrong one) · rendering the compat matrix from generated
artifacts (T4 owns that file this sprint) · #528 · P2 operability.
