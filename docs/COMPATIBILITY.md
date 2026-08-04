# knext compatibility matrix — operator ↔ CLI ↔ packages

> Internal maintainer doc (it may reference issues and workflow internals). The policy that governs
> it — cadence, what a version promises, support window, deprecation — is
> [`docs/RELEASE_POLICY.md`](RELEASE_POLICY.md). The user-facing version of this page is the docs
> site's *Versioning & compatibility*.
>
> **Who updates it, and when:** whoever merges the **"version packages"** PR, in that same PR. It is
> not left to discipline — `tests/release-policy-matrix.test.ts` asserts the matrix carries a row
> for the version in the tree, so the release PR is red until the row is added.

## The three axes

knext ships three things that version on **separate** lines. Nothing forces them to move together:

| Thing | Ships as | Version line |
| --- | --- | --- |
| `@getknext/core`, `@getknext/lib`, `@getknext/db` | npm packages | semver, **one shared number** across the three |
| the operator | a container image + an `install.yaml` bundle | **no semver line today** — see below |
| the `NextApp` CRD | inside the operator bundle | the Kubernetes ladder: `v1alpha1` → `v1beta1` → `v1` |

## The matrix

| Package set | CRD `apiVersion` | Operator bundle | Notes |
| --- | --- | --- | --- |
| `0.3.0` (in tree) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | current `main`; the three are version-locked from this release on |
| `@getknext/core@0.3.0`, `@getknext/lib@0.2.0`, `@getknext/db@0.2.1` (published 2026-07-26) | `apps.kn-next.dev/v1alpha1` | `operator-latest` | the first npm release; the three published at **different** numbers — see "the drift" below |

Every row so far names the same CRD `apiVersion`, which is the point: within `v1alpha1` the schema
is additive-only, so no released package set has ever needed a *newer* CRD than another.

### Reading a row

- **Package set** — the number you pin. One number covers all three packages.
- **CRD `apiVersion`** — the value a hand-authored or GitOps-managed `NextApp` must carry, and the
  value the CLI emits. Verified mechanically against both the ADR that declares it and the CRD
  manifests the operator actually serves.
- **Operator bundle** — where the matching operator comes from. Today there is exactly one address:

  ```sh
  kubectl apply -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml
  ```

### The drift, recorded rather than tidied away

The first npm release published the three at **different** version numbers. That is inconsistent
with the "ship as a set" rule those same release notes stated, and it is why the rule is now
mechanical (a Changesets `fixed` group plus the guard) rather than a promise. The published set is
internally consistent — `@getknext/core@0.3.0` depends on `@getknext/lib@^0.2.0` and
`@getknext/db@^0.2.1`, both of which exist — so nothing is broken for a consumer; from the next
release on, one number covers all three.

## Upgrade order

**Upgrade the operator (and therefore the CRD) BEFORE the CLI: operator/CRD first, then CLI.**

An **older CLI against a newer CRD is always valid** — a client that emits a subset of the schema
never trips unknown-field validation — so the two are *not* required to be in lockstep. Only the
reverse (CLI ahead of CRD) is unsupported.

The runbook, the exact apiserver error, and the residual gaps strict validation does *not* close are
in [`docs/RELEASING.md`](RELEASING.md#upgrade-order); the decision is ADR-0020.

## What is checked mechanically, and what is not

Checked (`tests/release-policy-matrix.test.ts`, plus
`packages/kn-next/src/__tests__/crd-api-version.test.ts`):

- the three published packages carry one version, and Changesets is configured to keep it that way;
- no fourth publishable package exists — the workspace is **scanned**, not enumerated;
- the CRD `apiVersion` in this matrix equals the one ADR-0017 declares **and** the one the
  operator's generated CRD manifests + Go API package actually serve;
- the CLI names no other CRD `apiVersion` anywhere under `src/cli/`;
- a row exists for the version currently in the tree.

Checked at deploy time, in the CLI: the schema preflight (`src/cli/schema/preflight.ts`) compares
the fields this CLI emits against the CRD installed on the target cluster and refuses **before any
side effect** if the cluster cannot store one, naming the field.

**Not** checked, stated so nobody assumes otherwise:

- **the operator has no semver release line.** Its images are tagged by commit SHA and pinned by
  digest in the bundle; `operator-latest` is re-pointed at `main` on each publish. So "minimum
  operator version" cannot be expressed as a number today, and the matrix cannot assert one. The
  practical protection is the ordering rule plus the deploy-time preflight above — not this table.
- **nothing here verifies a registry.** The guard reads this repo; it cannot confirm what is
  actually installed on npm or in a cluster.
