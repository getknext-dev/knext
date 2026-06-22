# ADR-0013: Per-PR preview environments — lifecycle and data isolation

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0008 (app-namespaced assets +
  deletion finalizer), ADR-0011 (build-id-versioned assets + retention GC), issue #91 (previews),
  issue #92 (rollback / traffic pinning), issue #93 (skew protection)

## Context

A "preview environment" is a per-PR, deploy-on-push instance of the app reviewers can click before
merge (the Vercel/Netlify model). The bucket-2 ("buildable-but-unbuilt") parity gap in `CLAUDE.md`
lists previews as a cheap fame-phase win. We want them WITHOUT widening scope: knext stays the
narrow Next.js-on-Knative adapter, and ADR-0001 still holds — the operator is the single authority
for cluster state, the CLI only emits intent (build → push → apply/delete the `NextApp` CR).

Two questions had to be answered: (1) **how is a preview isolated** from prod and from other
previews? and (2) **what tears it down** (and what data, if any, does it share)?

A useful pre-existing fact: most of the operator side already existed. `NextAppSpec.Preview`
(`{Enabled, Branch, PRID}`) is defined, and the reconciler already applies preview overrides — it
stamps `environment=preview` / `pr-id=<n>` labels and forces `max-scale=1`, `min-scale=0`, and a
`scale-to-zero-pod-retention-period=30s` window when `Preview.Enabled`. What was missing was a CLI
that emits the preview block, tests around the operator behaviour, and a (gated) CI workflow.

## Decision

1. **A preview is a separate `NextApp` named `<app>-pr-<n>`.** The CLI derives the name from the app
   name + PR number, validates it as a DNS-1123 label of ≤63 chars (an over-long app name aborts
   before any cluster write), overrides `config.name`, and applies a `NextApp` CR carrying
   `spec.preview = {enabled:true, prId, branch}`. The operator reconciles the ephemeral overrides
   from that block. New CLI surface: `kn-next preview deploy --pr <n> --branch <ref> [-n <ns>]` and
   `kn-next preview destroy --pr <n> [-n <ns>]`.

2. **Isolation is uniformly NAME-DERIVED — assets, URL, Redis keyspace, and finalizer all key off
   the `<app>-pr-<n>` name:**
   - **Assets** — `appKeyPrefix`/`getAssetPrefix`/`appStoragePrefix` are all `<name>/`-scoped
     (ADR-0008), so a preview uploads/serves under an isolated `<app>-pr-<n>/` prefix.
   - **URL** — the Knative Service is named after the `NextApp`, so a preview gets a distinct ksvc
     URL surfaced as `status.url` (which the CLI reads back and prints for the PR comment).
   - **Redis keyspace** — the asset/URL prefixes are *re-derived* from `name`, but the Redis
     `cache.keyPrefix` is a *verbatim* value, so it is NOT auto-isolated. `kn-next preview deploy`
     therefore explicitly overrides `cache.keyPrefix = <app>-pr-<n>` when building the preview config
     (only when a cache is configured). Without this, a preview would share prod's ISR/data-cache
     keyspace — reading/writing/poisoning prod's cached data — and, far worse, `preview destroy`
     would let the finalizer flush prod's keys (see §4 + the destroy-safety note below). The
     CLI-side override was chosen over an operator-side derive-from-`app.Name` because it is
     simpler and fully contained in the deploy path; the operator's `CleanupCache` needs no change.
   - **Teardown** — the operator's `apps.kn-next.dev/external-cleanup` finalizer (ADR-0008) reaps
     exactly that name's asset prefix + Redis keyspace on delete. Because the preview's keyPrefix is
     `<app>-pr-<n>`, `CleanupCache` can ONLY flush `<app>-pr-<n>:*` — it can never touch prod's keys.
   No operator changes are needed for isolation, GC, or teardown.

3. **A preview is EPHEMERAL and shares nothing stateful with prod — NO database, and its own
   name-scoped Redis keyspace, by default.** It is a throwaway compute environment. Cross-zone data
   sovereignty (`scs-zones.md`) is preserved because a preview owns its own name-scoped object-store
   prefix AND its own name-scoped Redis keyPrefix, and connects to nothing of prod's. A regression
   test (`preview-cli.test.ts`) deploys a preview from a prod config with `cache.keyPrefix: "prod"`
   and asserts the effective keyPrefix is `<app>-pr-<n>`, NOT `prod` — the negative proof that a
   preview can neither read nor reap prod's cache.

4. **Teardown authority = the PR-close event.** `kn-next preview destroy` deletes ONLY the
   `<app>-pr-<n>` `NextApp` CR (`--ignore-not-found`, idempotent); the finalizer + ownerReference GC
   do the rest. There is intentionally **no operator-side TTL / reaper timer** (see rejected
   alternative below).

5. **No `spec.traffic` on a preview.** A preview is a single revision at `max-scale=1`; emitting a
   traffic split (#92) would be meaningless. Its own build-id + `<app>-pr-<n>/` asset prefix mean
   prod's deploy-time retention GC (#93, scoped to prod's `<app>/`) never touches a preview, and a
   preview can never skew prod.

6. **CI is committed but GATED.** `.github/workflows/preview.yml` runs deploy on PR
   open/sync/reopen and destroy on close. It is INERT until a cluster exists: every job is guarded
   by a `vars.PREVIEW_ENABLED` repo variable AND a `preview` PR label. It uses `pull_request` (not
   `pull_request_target`) so fork PRs run with a read-only token and cannot read cluster/registry
   secrets.

## Options considered

| Option | Isolation | Teardown | Verdict |
|---|---|---|---|
| **Separate `<app>-pr-<n>` NextApp (chosen)** | name-derived (assets/URL/finalizer) — zero new code | PR-close event → delete CR; finalizer reaps | **Chosen** — reuses ADR-0008, no operator change |
| Shared NextApp + per-PR Knative revision/tag | weak — assets/Redis NOT name-isolated; revisions share a Route | hard — must prune one revision, not the app | Rejected — leaks prod state into previews, fights ADR-0008 |
| Operator-side TTL / reaper for previews | same as chosen | a timer GC's stale previews | **Rejected** — a second teardown authority competing with the PR-close event; redundant and can race the event. (A *separate* scheduled CI sweep that just calls `preview destroy` for already-closed PRs is acceptable as belt-and-suspenders, since it shares the one authority — the CR delete.) |
| `pull_request_target` so fork PRs get previews | n/a | n/a | **Rejected** — exposes cluster/registry secrets to untrusted fork code. Same-repo + label gate only. |

## Consequences

- Previews ship as a real, tested **mechanism** (operator preview overrides locked by envtest; CLI
  `deploy`/`destroy` argv + DNS-1123 validation + ADR-0001 negative guard locked by unit tests) with
  a **committed-but-gated** workflow. The live per-PR loop is cluster-gated: it activates only once a
  `KUBECONFIG`/registry secret + `PREVIEW_ENABLED` are provisioned. This is honest about what runs
  today vs what needs infra.
- No CRD change: `PreviewSpec` already existed; `make manifests generate` produces no diff.
- Fork PRs do not get auto-previews (security trade-off). Maintainers can still preview a fork PR by
  pushing the branch same-repo and labeling it, or via the manual `workflow_dispatch`.

## Action items

- [x] CLI emits `spec.preview` (`cr-builder.ts` `PreviewInput`) + `preview deploy`/`destroy`
      (`cli/preview.ts`), with DNS-1123/≤63 validation and an ADR-0001 nextapp-only write guard.
- [x] Operator preview-override behaviour locked by envtest (`reconcile_output_test.go`).
- [x] `.github/workflows/preview.yml` — gated deploy/destroy + sticky PR comment.
- [ ] Provision a preview cluster + `PREVIEW_KUBECONFIG` secret + `PREVIEW_ENABLED` var to activate
      the live loop (infra, out of scope for #91).
- [ ] (Optional) a scheduled CI sweep that runs `preview destroy` for already-closed PRs as
      belt-and-suspenders.
