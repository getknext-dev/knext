# Architect sign-off — PR #815 (`fix(cli): doctor distinguishes 'no cluster connected yet' from a network flake`)

**SIGN-OFF** — no ADR or hard rule (`.claude/rules/architecture.md` §4, `CLAUDE.md` §10) is contradicted.

Scope reviewed: `packages/kn-next/src/cli/doctor.ts`, `packages/kn-next/src/__tests__/doctor.test.ts`,
`apps/docs/content/docs/cli.mdx`. Summoned by the mechanical `packages/kn-next/src/cli/` trigger
(workflow.md), not by a reviewer escalation.

## 1. ADR compliance
- **ADR-0001 / operator = single source of truth.** No cluster write of any kind. The change adds
  *local file reads* (`existsSync`/`readFileSync` of kubeconfig) and text classification. No new
  second-writer of deployment shape, no raw Knative manifest, no out-of-band mutation. Clean.
- **Official-adapter-only, proto-as-source-of-truth.** Untouched.
- **ADR-0022 (doctor strict mode).** The load-bearing invariant there is the *unreachable-gate
  degrade*: `cluster` WARNs, every other check SKIPs, exit 0. The PR preserves it byte-for-byte in
  behaviour and pins it in each new test (`warn` + `skip` for crd/operator/knative + `exitCode 0`).
  Only the `detail`/`hint` strings change. It does **not** pre-implement the deferred `--strict`
  flag — correct, ADR-0022 says "do not implement now".
- **#230/#231 truthfulness rules (referenced by ADR-0022).** `auth`/`forbidden` classifications keep
  precedence over the new diagnosis, and a corrupt/unparseable kubeconfig returns
  `has-current-context` so doctor never *invents* a "no cluster" claim. Fail-safe direction is
  correct: ambiguity degrades to the legacy generic hint, never to a confident wrong answer.
- **ADR-0046 (CLI verb dispatch contract).** No new verb, no flag surface, no `KNOWN_VERBS` change;
  the help/usage text edit is descriptive. ADR-0046's binding persona is explicitly "a Next.js
  developer with no Kubernetes background" — this change serves that persona rather than fighting it.
- **ADR-0023 / ADR-0026 (health taxonomy, shallow readiness, probe paths).** Different subject
  (in-cluster app readiness), no interaction; nothing here touches probe paths or status verdicts.

## 2. Sequencing / scope
Ergonomics-ledger finding 1c is Tier-A-adjacent product-path correctness on an already-shipped
command. No deferred scope (gRPC/ADR-0002, zones/PWA) is pulled forward. No new subsystem: the
change is ~90 lines of classification plus one injected dependency.

## 3. Boundaries & contracts
- The `KubeconfigInspectFn` seam is a plain injected function on the existing `DoctorDeps` with a
  production default — an appropriate boundary, and it is exercised end-to-end once (the
  default-wiring test), so the seam is not decorative.
- The read-only kubectl verb guard (`doctor.test.ts:644`, get/version only) still holds *by
  construction*: the new path issues no kubectl call at all.
- One accepted trade, recorded rather than blocked: knext now carries its **own minimal
  interpretation of kubeconfig resolution** ($KUBECONFIG list vs `~/.kube/config`, current-context
  presence) instead of shelling out to `kubectl config current-context`. That can drift from
  kubectl's precedence rules (e.g. `--kubeconfig`, first-file-wins on merge). It is acceptable here
  because the blast radius is *advice text only* — every divergence falls back to the pre-existing
  generic message, and no deployment decision is derived from it. It would stop being acceptable the
  moment anything other than a hint string reads `inspectKubeconfig()`.

## 4. Positioning
Onboarding guidance for "knext deploys into a Kubernetes cluster; you don't have one yet" is
adapter-scoped. It does not provision, install, or manage a cluster — no PaaS drift.

## 5. Decision hygiene
Not ADR-class on its own (output classification within an already-documented contract). The docs
change lands in the same PR, satisfying workflow step 5.

## Follow-up ADR
Amend **ADR-0022** with one clause: doctor may consult *read-only local host state* (kubeconfig) to
classify the unreachable gate, ambiguity must fall back to the generic hint, and the WARN/SKIP/exit-0
degrade contract is unchanged — so the next person adding a local-state input has the boundary
written down rather than inferred from this PR.
