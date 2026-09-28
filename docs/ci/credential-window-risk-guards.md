# Credential-window risk guards (#1530)

Sprint B4 (milestone "v1.0 Credential Windows") asked for one guard per risk
named against the v1.0 credential harness (ADR-0056,
`docs/ci/credential-freeze-guard.md`). This doc covers what shipped, what a
"night" outcome means for each guard, and — honestly — what did not ship and
why.

## The three outcome kinds a scheduled run can now carry

Before this work, `scripts/compat-window-audit.mjs` recognized exactly two
outcomes for a scheduled night: **eligible** (a real green) and
**disqualified** (a red, or an `UNRESOLVED` night whose ledger could not be
obtained — both RESET the streak). This adds two more, and neither is a
synonym for either of those:

| Outcome | What it means | Effect on the streak | Effect on `met`/CI |
|---|---|---|---|
| green (`eligible: true`) | every rule satisfied | extends | — |
| red / disqualified | a rule failed, or the ledger was lost (`UNRESOLVED`) | **resets** | fails the shard/night |
| **INVALID** (new) | the run's precondition was proven untrustworthy *before it produced a single shard result* | **pauses** — the streak either side of it still joins | never a pass, but never charged either |
| **infra-classified red** (new) | the run's precondition failed *and the shard still failed*, for a reason that is a runner/environment fault, not a claim about the knext ref under test | resets, same as any red | fails the shard, but is labelled distinctly from `kind: 'assertion'` so triage is not misdirected |

The distinction between "pauses" and "resets, but labelled" is deliberate and
maps to two different failure shapes:

- an **INVALID** night never ran a single test — grading it as a normal red
  would silently accuse the knext ref under test of something the operator
  digest mismatch actually caused, and grading it as absent (skipping it)
  would let two unrelated streaks quietly merge, which is exactly the
  silently-dropped-night failure rule 5 already exists to prevent. Pausing is
  the only choice that is honest in both directions.
- an **infra-classified** shard DID attempt to run, failed for an
  environmental reason (the runner's own disk), and must still cost the
  streak (a runner fault proves nothing green either) — but a reviewer
  triaging a red night must not go looking for a product regression that
  does not exist.

## Guard 1 — the OKE operator-digest pre-check

`scripts/compat-operator-digest-check.mjs` compares the OKE operator
Deployment's *live* running image digest against the digest recorded in the
digest-pinned `install.yaml` release asset for the RC tag
`scripts/compat-credential-ref.mjs` resolved. A mismatch marks the night
**INVALID** (`scripts/compat-window-audit.mjs`'s `INVALID_REASONS`,
`operator-digest-mismatch`) — see the table above for what that means for the
streak.

**Honesty note on wiring.** The four wired v1.0 credential cells
(`CREDENTIAL_CELLS` in `scripts/compat-window-audit.mjs`) all run from
`.github/workflows/test-e2e-deploy.yml`, and that workflow's `deploy-tests`
job runs the official Next.js compat suite's *own* `deploy-tests` category —
every fixture is built and served as a **local process on the GitHub-hosted
runner** (`scripts/e2e-deploy.sh`). Nothing in that job holds a kubeconfig, a
kube-context, or any reference to a live cluster; it never touches OKE. So
this guard's pre-check function and its ledger semantics are built, tested,
and mutation-proved here, but **not yet wired into a workflow step**, because
there is currently no credential-cell job that reaches a live cluster to
check a digest against. It is ready to be called the day a credential cell
(or a different workflow this ADR's scope grows to cover) actually deploys
through OKE; until then it is a proven, unused primitive, not decoration —
the alternative (fabricating a `kubectl` step into a workflow that runs
nothing on a cluster) would exercise nothing real.

## Guard 3 — the free-disk floor

`.github/workflows/test-e2e-deploy.yml`'s `deploy-tests` job now runs a
"Free disk floor" step before the real test-run step. It shells out to
`scripts/compat-disk-floor-check.mjs`, which fails closed on an unreadable
reading and compares free space against a floor (5GB — a first estimate, not
a measured one; a future breach should turn into a measured number in
`docs/ci/capacity-budget.md`, not a bigger guess here).

On a breach, the step writes the shard's own summary JSON directly —
synthesizing a `kind: 'infra'` failure — and the real test-run step and the
normal summarize step both skip their bodies (branching internally on the
disk-floor step's own output, never on their own `if:`, because both sit
inside the job's unconditional reporting tail; narrowing an `if:` there is
exactly what `tests/helpers/workflow-conditioning.ts`'s tail audit exists to
catch). `scripts/compat-window-audit.mjs`'s `isInfraOnlyRedShard` gives the
disqualifier a distinct `infra-classified:` label, mirroring how `#1520`
already separated `kind: 'deploy'` from a real assertion regression.

## Guard 2 — per-cluster concurrency + namespace per lane: not shipped, and why

This is the one guard in the issue that did **not** ship, and it is worth
saying precisely why rather than shipping something decorative to match the
issue's wording. "Per-cluster concurrency" and "a distinct namespace per
cell" both presume the credential cells deploy into a shared Kubernetes
cluster. They do not: as guard 1's honesty note above establishes, every
wired credential cell runs entirely on GitHub-hosted runners with no cluster
in the loop at all. There is no k8s namespace to scope and no cluster deploy
slot to serialize — adding YAML that pretends otherwise would pass a workflow
scan while proving nothing.

The workflow's own existing design comment (`.github/workflows/test-e2e-deploy.yml`,
`concurrency:` block) documents a *related* but different concurrency
decision made deliberately the other way: credential and early-warning crons
are **never** grouped together, specifically so an in-progress credential
night's shards are never cancelled by a later cron starting (cancelling a
pending credential run resets its 14-night window). Adding a per-cluster lock
across those same crons would need to reopen that decision, not layer on top
of it.

If a future credential cell (or a different workflow this scope grows to
cover) does deploy through a shared cluster, this guard's concurrency +
namespace requirement should be re-scoped against that workflow's real
job/step shape rather than assumed from this doc.
