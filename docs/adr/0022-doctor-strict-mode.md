# ADR-0022 — `kn-next doctor --strict`: opt-in WARN-is-failure mode for CI preflight gates

- **Status:** Proposed *(decision recorded; implementation deferred until a CI
  consumer actually asks for it — see Action items)*
- **Date:** 2026-07-12
- **Relates to:** #230/#231 (doctor probe-failure truthfulness, the ERROR class
  and the exit-code contract), the P3 RBAC-Forbidden classification (same PR as
  this ADR), `packages/kn-next/src/cli/doctor.ts`.

## Context

`kn-next doctor` is the cluster-prereq preflight. Its exit-code contract today
(established in #230/#231 and pinned by `doctor.test.ts`):

- **FAIL** (a verified cluster-state problem) and **ERROR** (a probe that could
  not verify the cluster — network / auth / RBAC) → **exit 1**. An errored
  probe reporting green would be a lie.
- **WARN** (e.g. cert-manager absent, ingress-class mismatch heuristics,
  non-anonymously-pullable operator image) → **exit 0**.
- The **unreachable-gate degrade**: when the initial `kubectl get --raw
  /version` probe fails, the `cluster` check WARNs, **every** subsequent check
  SKIPs, and doctor **exits 0**. This is a documented, tested contract — an
  interactive user with no kubeconfig context should not see a red exit.

That contract is right for the primary audience (a human diagnosing a
workstation). It is arguably wrong for a second audience that is emerging now
that doctor is exercised in the kind e2e lane (#229): a **CI preflight gate**
("fail this pipeline unless the cluster is verifiably ready for knext"). In
CI, "the apiserver was unreachable, so I checked nothing" exiting 0 makes the
gate vacuous, and WARN-level findings (cert-manager missing → operator webhook
Certificates cannot issue) are frequently deploy-blocking in practice.

## Decision

**Recommend Option B**: add an opt-in `--strict` flag under which

1. any **WARN** check causes **exit 1**, and
2. the **unreachable-gate degrade** (WARN + all-SKIP) also causes **exit 1**
   — an unverified cluster is a gate failure, not a pass.

Non-strict behavior stays byte-for-byte identical (default unchanged; the
interactive contract above is untouched). The JSON output surface should carry
the effective mode so machine consumers can tell which contract produced
exit 0.

**Do not implement now.** This ADR records the decision shape only; per the
plan gate, doctor has no confirmed CI consumer demanding strictness yet, and
design-before-code applies. Implementation happens in its own PR when demand
materializes, with tests pinning both contracts side by side.

## Options considered

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| A. Status quo | WARN and unreachable-gate always exit 0 | Zero change; interactive UX already correct | CI gate is vacuous when unreachable; WARN-level deploy blockers pass silently |
| **B. `--strict` flag (recommended)** | Opt-in: WARN ⇒ exit 1, unreachable-gate ⇒ exit 1; default unchanged | Both audiences served; no breaking change; contract stays explicit per invocation | Two exit-code contracts to document and test; flag surface grows |
| C. Always-strict | Make WARN/unreachable exit 1 unconditionally | One contract; simplest mental model | Breaks the documented interactive degrade (no-kubeconfig ⇒ red); punishes advisory heuristics (e.g. ingress-class warns) that are sometimes intentionally tolerated |

Option C is rejected outright: the unreachable degrade-to-SKIP behavior exists
because a laptop without a cluster context is a normal doctor invocation, not a
failure. Option A is rejected as the end state because the CI-gate audience is
real (kind e2e lane) even if not yet demanding.

## Consequences

- **Positive:** doctor becomes usable as a genuine CI gate without degrading
  the interactive contract; the WARN semantics ("advisory for humans, blocking
  under `--strict`") become explicit instead of ambient.
- **Negative / cost:** dual exit-code contracts must both be tested (strict and
  non-strict fixtures for the same check states); docs must state which mode CI
  recipes should use.
- **Neutral:** no change to check classification itself — ERROR vs WARN vs FAIL
  assignment is orthogonal to this ADR and stays governed by the #230/#231
  truthfulness rules.

## Action items

- [ ] Implement `--strict` in `doctor.ts` (`parseDoctorArgs` + exit-code
  roll-up) **only when** a CI consumer needs it; tests must pin the non-strict
  contract unchanged alongside the strict one.
- [ ] On implementation: document the mode in the CLI help + doctor docs, and
  surface the effective mode in the JSON output.
- [ ] On implementation: switch the kind e2e doctor spec (#229) to `--strict`
  if and only if its assertions want WARN-blocking semantics.
