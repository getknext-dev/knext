# CR schema preflight — what `kn-next deploy` checks before it does anything

`kn-next deploy` and `kn-next preview deploy` begin with a **schema preflight**:
a server-side dry-run apply of the exact `NextApp` CR they are about to submit.
It runs **before the build, before the asset upload and before the image push**,
so a cluster that would not store your CR intact costs you a round-trip rather
than a bucket full of orphaned assets.

## The problem it removes

The `NextApp` CRD is *structural* and does not preserve unknown fields. A CLI
newer than the operator can therefore emit a field the installed CRD does not
define, and what happens next depends on the apply's validation mode, not on the
CRD:

- `--validate=strict` (what knext always passes) — the apiserver **rejects** the
  object.
- `--validate=ignore` — the apiserver **accepts** it and **prunes** the field
  silently.

The pruning case is the dangerous one. If `spec.database.roSecretRef` is pruned,
the operator never injects `DATABASE_URL_RO`, so `getDbRO()` falls back to the
writer pool and staleness-tolerant reads run on the read-**write** primary
credential — a least-privilege downgrade, on a CR that still reports
`Ready=True`.

## What it does, in three tiers

| tier | what | needs |
|---|---|---|
| 1 — **verdict** | `kubectl apply --dry-run=server --validate=strict` of the exact CR | `create`/`patch` on `nextapps` in the target namespace — **exactly what the deploy already needs** |
| 2 — **diagnosis** | reads the structural schema from the aggregated OpenAPI v3 discovery document to name the field | nothing beyond `system:authenticated` |
| 3 — **enrichment** | `kubectl get crd nextapps.apps.kn-next.dev` | cluster-scoped `get customresourcedefinitions` (optional) |

**Failure of tiers 2–3 degrades the message, never the verdict.** A
namespace-scoped kubeconfig can still deploy: the verdict never requires reading
the CRD, and if the schema reads are denied the field name is recovered from the
apiserver's own `unknown field "…"` rejection.

Verified on a live cluster with a real restricted kubeconfig (a ServiceAccount
whose only rule is `get,list,create,patch,update` on `nextapps` in one
namespace): `kubectl auth can-i get customresourcedefinitions` → **no**, while
the OpenAPI v3 read succeeds.

## What you may rely on

- A deploy either stores the CR intact or **fails**; it never proceeds with a
  field silently dropped.
- On failure, `kn-next deploy` exits **non-zero** and **names the fields** it
  could not get past the installed CRD.
- Nothing has been built, uploaded or applied when a preflight failure is
  reported.
- The preflight needs **no permission the deploy does not already need**.

## What just changed for you

- A deploy that previously "succeeded" while losing a field now exits non-zero.
- A cluster the CLI cannot reach for the dry run fails the deploy early rather
  than at apply time. There is **no flag to skip it** — an escape hatch here
  would be a supported way to reintroduce the silent-pruning bug.
- Fix skew by upgrading in the supported order: **operator/CRD first, then
  CLI** ([RELEASING.md](../RELEASING.md#upgrade-order),
  [ADR-0020](../adr/0020-release-channels.md)).

## Diagnosing without deploying

`kn-next doctor` reports **schema coverage**, not merely CRD existence:

```
$ kn-next doctor
FAIL  NextApp CRD schema coverage
      the installed NextApp CRD does not define 1 field(s) this CLI emits:
      spec.database.roSecretRef
```

If both schema reads are denied, that row **skips** (visibly) — `doctor` is
read-only and advisory, and the verdict belongs to the deploy preflight, which
needs no read at all.

## Which fields are involved

[`docs/compat/cr-fields.md`](../compat/cr-fields.md) lists every field the CLI
can emit, together with `cr-fields.json` for tooling. Both are **generated** by
scanning the CR builder — do not edit them by hand; run
`pnpm gen:cr-fields`.

## What it does not cover

A CLI-side preflight cannot protect the **GitOps** path. Argo CD and Flux never
invoke this CLI and do not assert strict field validation, so a GitOps-managed
`NextApp` can still be pruned. That gap is tracked separately; the CLI's
guarantee stops at the applies the CLI itself issues.
