# Credential-window risk guards (#1530)

Sprint B4 (milestone "v1.0 Credential Windows") asked for one guard per risk
named against the v1.0 credential harness (ADR-0056,
`docs/ci/credential-freeze-guard.md`). This doc covers what shipped, what a
"night" outcome means for the guard that shipped, and — honestly — what did
not ship and why, including one dropped in review.

## Guard 1 — the OKE operator-digest pre-check: dropped in review, not shipped

An earlier round of this PR added `scripts/compat-operator-digest-check.mjs`
and a new `INVALID` outcome kind in `scripts/compat-window-audit.mjs`
(`INVALID_REASONS`, `invalidNight`, `isInvalid`) that would have **paused** a
streak — the qualifying nights either side of an invalid night still joining
— rather than resetting it like every other disqualifier. Round-2 review
found the pause semantics unbounded: nothing capped consecutive invalid
nights or tied them to a calendar bound, so a fixture of 13 green nights, 30
consecutive invalid nights, and 1 more green night graded as one continuous
14-night streak (`met: true`). That is exactly the VOID-bridging question
already parked, undecided, at #1553 — this PR is not the place to resolve a
counting-rule change with a live safety hole and no real producer to justify
it (guard 1's own script was never wired into a workflow step; the credential
lanes never touch a live cluster — see below).

**Decision (lead-directed): drop the pause semantics entirely.**
`scripts/compat-window-audit.mjs` is restored to `main`'s counting rules
byte-for-byte except for the guard-3 labelling described below.
`scripts/compat-operator-digest-check.mjs`, its test, and its mutation prover
are removed from this PR rather than left as unwired dead library code. The
right home for an operator-digest pre-check is the tag-time platform e2e that
builds the operator from the release tag (#1305 / G2), where a real digest
comparison has a real producer. Until that lands, no digest check exists, and
this doc records why rather than leaving a decision-shaped hole for someone
to rediscover.

## Guard 3 — the free-disk floor

`.github/workflows/test-e2e-deploy.yml`'s `deploy-tests` job runs a
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
already separated `kind: 'deploy'` from a real assertion regression. An
infra-classified night still **disqualifies** the streak exactly like any
other red — it is never a pass and never charged as anything gentler — the
label only steers triage away from a phantom product regression.

**Wiring is load-bearing, and now tested as such.** Round-2 review mutated
the live workflow with an anchor-exact mutator (asserting exactly one match,
then restoring byte-exact) and found the wiring itself unguarded: removing
the whole "Free disk floor" step, removing the skip branch in "Run official
deploy tests" (so the suite runs after a breach), or removing the early
`exit 0` in "Summarize shard result" (so an empty-log 0/0/0 overwrites the
infra summary) all left the existing pure-function unit tests green. A
workflow-scan test now reds on each of those three mutations independently
(anchor-exact, byte-exact restore, exit-code proof) — the guard's *wiring*,
not just its labelling function, is covered.

## Guard 2 — per-cluster concurrency + namespace per lane: not shipped, and why

This is the one guard in the issue that did **not** ship, and it is worth
saying precisely why rather than shipping something decorative to match the
issue's wording. "Per-cluster concurrency" and "a distinct namespace per
cell" both presume the credential cells deploy into a shared Kubernetes
cluster. They do not: every wired credential cell (`CREDENTIAL_CELLS` in
`scripts/compat-window-audit.mjs`) runs entirely on GitHub-hosted runners,
via `.github/workflows/test-e2e-deploy.yml`'s `deploy-tests` job running the
official Next.js compat suite's own `deploy-tests` category
(`scripts/e2e-deploy.sh`) — every fixture is built and served as a local
process on the runner. This is a **discovered fact, not an assumption**:
there is no `kubectl`/kubeconfig/kube-context reference anywhere in that job
or the scripts it transitively calls. So there is no k8s namespace to scope
and no cluster deploy slot to serialize — adding YAML that pretends
otherwise would pass a workflow scan while proving nothing. It also means
guard 1's dropped digest check (above) would have compared against nothing
these lanes actually observed, which is the same discovered fact playing out
twice.

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
namespace requirement — and guard 1's operator-digest pre-check — should be
re-scoped against that workflow's real job/step shape rather than assumed
from this doc.
