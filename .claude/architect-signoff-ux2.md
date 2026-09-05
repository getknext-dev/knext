SIGN-OFF — no ADR or hard rule in `.claude/rules/architecture.md` / CLAUDE.md §10 is contradicted.

## 1. The fall-through-to-deploy default — not a violation, and this PR narrows it
`security.md`'s "no unauthenticated mutating endpoints" governs **network-reachable handlers**
(app routes, operator webhooks, service-to-service). A local CLI verb typed at a prompt is
authenticated by construction — it runs under the caller's own kubeconfig and RBAC. Stretching the
rule to typo-routing is an analogy, not the rule, and this gate does not block on analogies.

ADR-0001 holds in its strong form: the only write the fall-through can reach is `deploy.ts`'s apply
of the **NextApp CR**. A typo'd verb cannot produce a second writer of deployment shape — it
produces an unintended CR apply, which the operator reconciles like any other. That is a UX defect,
not an architecture defect.

The PR moves in the right direction: two verbs are **removed** from the fall-through set, so the
blast radius shrinks. Demanding `unknown verb -> error` in the same PR would break the documented
bare `npx @getknext/core` invocation — the main advertised entry point — which is itself a
CLI-surface decision (a trigger). Correctly **not** bundled here.

## 2. Exposing `cleanup` / `build` commits the project to the *right* surfaces
- `cleanup.ts:48` issues **only** a `nextapp` CR removal via kubectl (`--ignore-not-found`). No
  ksvc / SA / PVC / StatefulSet child removals; child reaping is the operator's finalizer
  (ADR-0008). This is the ADR-0001-compliant teardown path, so advertising it entrenches the
  invariant rather than a retired surface. The pre-PR state was the hazard: `kn-next cleanup`
  **deployed**.
- `build.ts` has no `kubectl` at all.
- `INTERNAL_ONLY_VERBS` (`preview`, `loadtest`) makes the exclusion an explicit, asserted decision
  rather than drift — correct handling of a surface that is CI/runbook-driven, not human-typed.

## 3. `ConfigNotFoundError` code-tag — sound, and the right lesson applied
A string `code` on the error, not `instanceof`. Under tsup with dynamic-imported subcommand chunks,
two copies of a class can coexist and `instanceof` silently stops matching — the same duplication
class as the #352 webpack-layer bug behind ADR-0027. ADR-0027's `globalThis` + `Symbol.for(...)`
requirement binds **mutable module state**; there is none here, so it does not apply. Value-based
discrimination (Node's own `ENOENT` convention) is duplication-proof without a seam. `instanceof`
here would have been the defect.

## Boundaries, sequencing, positioning
No out-of-band cluster mutation, no runtime rewrite, no second writer. `help.ts` is a leaf module
(imports nothing; `shared.ts -> help.ts` only, no cycle). Nothing touches deferred scope (gRPC
ADR-0002/0003/0004, zones) — this is Tier-A ergonomics under the founder's 2026-08-21 goal. The
surface gets **narrower and more honest**, not broader: no PaaS drift.

Guard hygiene meets the repo's own bar — `dispatchedVerbs()` **scans** the routing branch (both
halves: help contains every dispatched verb, and help advertises nothing unroutable), mutation-proved
by deleting the `cleanup` dispatch branch.

## Follow-up ADR
Write an ADR on the **CLI default-verb contract** — ratify or replace bare-invocation-and-unknown-verb
-> `deploy`, preserving `npx @getknext/core` while making a typo'd verb an error.
