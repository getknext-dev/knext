# knext — Project Strategy & Hard Rules (canonical)

> This is the persistent source of truth for **direction**. Detailed roadmap: `ROADMAP.md`.
> Architect operating discipline: `.claude/rules/architecture.md`. Decisions: `docs/adr/`.
> SCS / Multi-Zones / PWA architecture: rule `.claude/rules/scs-zones.md`, skills `scs-zones` + `pwa-zones`.
> The context-mode operational rules (context-window protection) are retained at the bottom.

## 1. Identity & positioning
- knext is **the scale-to-zero Next.js adapter for Knative/Kubernetes** — a Next.js-specific
  deployment framework, architecturally closer to **OpenNext** than to a PaaS.
- **NOT** a general-purpose PaaS, **NOT** "Coolify for Kubernetes." Coolify/Dokploy are general
  Docker/Swarm PaaSes with always-on containers; knext's differentiator is **Knative +
  scale-to-zero**. Resist scope drift toward a general PaaS.
- Borrow Coolify's **business model** (open-core) if/when we monetize — never its product category.

## 2. Strategy & business model
- **Near-term goal = fame/credibility for the author's career**, not product revenue.
- Separate two revenue paths: **expertise revenue** (consulting/platform-eng roles — fast,
  reliable; knext is the credential) vs **product revenue** (open-core/managed — slow, uncertain;
  a *maybe-later* pivot). **Do not bet financial security on product revenue.**
- **Decision: fame-first now, possible open-core pivot later.** Fame work also builds the user
  funnel a later open-core model would need.
- **North-star credibility lever:** **verified-adapter status** = open source + pass the official
  Next.js compatibility suite + listed in the Next.js docs.

## 3. Technical north star & the migration
- Runtime = a **real Next.js Deployment Adapter on the official API (16.2+)**: `NextAdapter`
  (`adapterPath`/`NEXT_ADAPTER_PATH`), the **official cache interfaces**, `@next/routing`,
  validated by the **official compatibility test suite**. Learn from the **reference Bun adapter**;
  target **Bun + Knative** (also runs on Node).
- **Do NOT reverse-engineer Nitro/Vinext** (old epic #11 approach is superseded).
- **Don't rewrite the runtime twice** — land the adapter migration before other runtime changes.
- **Status:** the official-adapter + `output:'standalone'` migration **merged to `main` (PR #29)**;
  cold-start bytecode caching via `NODE_COMPILE_CACHE`. The Vinext/Nitro runtime coupling is
  **gone from the tracked codebase** — `node-server.ts` is now the standalone-server runtime entry
  (spawns `next build`'s `server.js` + a metrics sidecar), not a Nitro entry.

## 4. Control plane (ADR-0001)
- The **Go operator is the single source of truth** for cluster state. CLI = build/publish + emit a
  CR; operator reconciles.
- **(RESOLVED 2026-07-26, stale-doc fix)** The "CLI must stop generating raw Knative manifests —
  `deploy.ts` mutates the cluster directly and the manifest generator hardcodes
  `containerConcurrency: 100`" note is **done, not outstanding**, and the invariant holds in its
  strong form: **every CLI cluster write targets the `NextApp` CR and nothing else** —
  `deploy.ts:500` (apply), `preview.ts:175` (apply), `db-bind.ts:383` (`patch nextapp`). No raw
  Knative objects anywhere. `deploy.ts`'s header documents the removal of both the raw-ksvc apply
  (was :176) and the infrastructure-manifest apply (was :153); `packages/kn-next/src/generators/`
  contains only `loadtest-job.ts` (no `knative-manifest.ts`); `cr-builder.ts` builds the CR. Do not
  re-file consolidation as open work.
- **Known gap that consolidation did NOT close (see `docs/V1_ROADMAP.md` §2.1):** `cr-builder.ts:364`
  hardcodes `apiVersion: apps.kn-next.dev/v1alpha1` and nothing in `src/cli/` negotiates the version
  against the cluster, so a newer CLI can emit a field an older operator's CRD does not know.
  **Measured, not assumed** (live cluster, server-side dry-run): whether that field is *pruned* or
  *rejected* depends on the apply's validation mode, not on the CRD —
  `kubectl apply --validate=strict` makes the apiserver **reject** it (`strict decoding error:
  unknown field …`), `--validate=ignore` accepts and prunes it. **Mitigated (#547):** every
  `kubectl apply` the CLI issues now passes `--validate=strict` explicitly, so the guarantee is
  knext's rather than the user's kubectl's, and `doctor` reports a client older than v1.25 (where
  that flag value does not exist). **Still open:** GitOps controllers (Argo CD, Flux) do not assert
  strict validation, a `kubectl` shim on PATH can append `--validate=ignore` and win (pflag takes the
  last occurrence), and `doctor` checks only that the CRD *exists*, not that its schema covers what
  the CLI emits — the schema-diff preflight (#314) is the complete fix. Upgrade order is therefore
  load-bearing: **operator/CRD first, then CLI** (#548).
- Enforce **`:latest` rejection / digest pinning everywhere.** (Verified: the operator already
  rejects `:latest` in `nextapp_controller.go:66`; the kubebuilder manager image in
  `config/manager/manager.yaml:66` is still `controller:latest` — fix that placeholder.)

## 5. Backend / gRPC business-logic layer (opt-in module)
- Run business logic as **separate, language-agnostic services**; **Next.js stays the HTTP
  gateway**. **ADR-0002: design now, build post-maturity** (after the migration + Tier-A
  correctness). **Protobuf = single source of truth** for contracts.
- **ADR-0003: transport = Connect + buf.** **ADR-0004: a `BackendService` CRD** — cluster-local,
  scale-to-zero Knative Services over **h2c, NO public ingress**; operator wires discovery into
  the gateway. Templates: **Go + TS first**, Python/Rust fast-follow.
- CLI-generated gateway glue: **server-only** Connect client wrappers (`import 'server-only'`),
  **Server Actions** (`'use server'`) for mutations, **generated API routes** (JSON-over-HTTP
  facade). Generated code runs under the **official adapter**, not Vinext.

## 6. Maturity roadmap (see `ROADMAP.md` for detail + exit criteria)
Phase 0 official-adapter migration (largely done) → **Tier A correctness** (image optimization,
graceful shutdown, control-plane consolidation, compat-suite gate) → **Tier B platform**
(security/SBOM, endpoint auth, previews, rollback, skew protection, RUM) → **Tier C edge** (CDN,
multi-region, WAF — **partly upstream-gated**: edge Middleware/Proxy, PPR/Cache Components are not
yet adapter-standardizable) → **Track P** (GitHub org, landing page, docs site — **dogfood the
docs site on knext**). gRPC layer = **design-now / build-later, after correctness.**

## 7. Security (non-negotiable, every phase)
- **No unauthenticated mutating endpoints.** `POST /api/cache/invalidate` and
  `DELETE /api/cache/events` now require a Bearer token (`CACHE_INVALIDATE_TOKEN`, fail-closed) —
  the audit lives in `docs/security/mutating-endpoints.md` (E4-2). Defense-in-depth: the operator now
  reconciles a default-on internal-only `NetworkPolicy` from the `NextApp` CR (`spec.security.networkPolicy`, #90).
  Never reintroduce an open mutating route.
- **Service-to-service mTLS/authz** gateway↔backends; no implicit trust.
- **Secrets in K8s Secrets only** — never in config files, images, or URLs.
- **Supply chain:** SBOM per image, Trivy/Grype (fail on high severity), cosign signing,
  reproducible builds, short threat model.
- Reverse proxy (nginx/Envoy) in front for rate/payload limits + malformed-request handling.
- **Graceful shutdown** must drain in-flight requests and run `after()` callbacks on SIGTERM.

## 8. Vercel parity framing
knext matches Vercel's **compute layer** (scale-to-zero ≈ Fluid Compute), **not** its global edge.
Gaps: (1) architectural edge we can't easily close (global CDN, edge middleware/PPR — partly
upstream-gated); (2) **buildable-but-unbuilt** — **image optimization** (biggest), endpoint auth,
previews, rollback, skew protection, RUM; (3) deliberate model differences (Prometheus/Grafana vs
Web Analytics; multi-cloud / no lock-in). Fame phase: do bucket-2 cheap wins + security basics;
defer bucket 1.

## 9. As-built truths & known issues (fix, don't propagate)
- ISR/data cache is **Redis** (`cache-handler.js`), **not GCS** — `docs/ARCHITECTURE.md` is stale.
- Real data plane = **GCS + Redis on GKE**. Storage providers `gcs`/`s3`/`minio`/`azure` are all
  validator-accepted CLI shell-outs (`gsutil`/`aws`/`mc`/`az`), each covered by the asset-upload
  contract test (azure promoted from coded-but-blocked, #474). **(RESOLVED)** the DynamoDB cache
  surface was trimmed (never had a runtime, #476); `spec.revalidation.kafka` is ISR-revalidation
  wiring only.
- **(RESOLVED)** Image optimization is **implemented** per ADR-0006
  (`packages/kn-next/src/adapters/image-cache-sync.ts` + tests) — the earlier "missing / biggest
  functional gap" note is stale; don't re-propose it as a work item.
  **But implemented ≠ gated:** its `compat-smoke` check skips rather than fails, as do three sibling
  capability rows. `docs/compat-matrix.md` is the single source of truth for which rows are actually
  backed by a red-on-fail check — read it there rather than duplicating the detail here, and see
  `docs/V1_ROADMAP.md` §3, which makes converting them a v1.0 blocker.
- **(RESOLVED 2026-06-20)** `packages/kn-next/src/adapters/node-server.ts` is **Nitro-free** — it
  spawns the standalone `server.js` (`STANDALONE_SERVER_PATH`, default `.next/standalone/server.js`),
  no `.output/server`/`index.mjs`. Enforced by `adapter-migration.test.ts` (asserts no `.output/server`).
  The only remaining `nitro/runtime` references are **untracked local cruft** (`packages/admin/…`,
  a stray `apps/file-manager/src/server/plugins/knext.ts`) — not in git, nothing to delete from the repo.
- Tests light on core build/deploy/upload/cache paths (manifest gen is covered).
- **(RESOLVED 2026-07-12, stale-doc fix)** Operator status `Conditions` ARE populated (16+
  `SetStatusCondition` sites across the reconcilers, `conditions_test.go`) and finalizer logic
  EXISTS (`internal/controller/finalizer.go` + envtest coverage) — the earlier "not populated /
  no finalizer" note was stale. Still true: API at `v1alpha1`.
- **(RESOLVED 2026-07-26, stale-doc fix)** The "license inconsistency: README says MIT" note was
  **wrong** — nothing in the repo claims MIT. The apparent README hit is a substring match inside
  `$CI_COMMIT_SHA` (`README.md:849`, `docs/ARCHITECTURE.md:627`). The licence is **Apache-2.0
  everywhere and consistently**: root `LICENSE`, a per-package `LICENSE` in each of
  `packages/{kn-next,lib,db}`, `"license": "Apache-2.0"` on all three publishable manifests, and the
  operator source headers (`nextapp_types.go:4`). npm always includes `LICENSE` in a tarball
  regardless of the `files` allowlist, so the published packages carry it. Nothing to pick; do not
  re-file this as a pre-publish blocker.
- npm: packages are unified under the **`@getknext/*`** scope. The **publishable** three are
  `@getknext/core`, `@getknext/lib`, `@getknext/db` — they must ship together or consumers 404 on the
  missing member. `@getknext/ui` is **private** and never publishes; don't list it as a released
  package. The earlier `@kn-next`/`@knative-next` drift is resolved; the `kn-next` bin name is unchanged.
  **No npm release published yet** — that final `npm publish` step (requires npm auth) still blocks
  `npx kn-next` for outside users.
- **(RESOLVED 2026-06-21)** The `kn-next` **TS CLI in `@getknext/core` (`packages/kn-next/src/cli`) is the
  single CLI of record.** The old Go `packages/cli` and the `admin`/`knext` packages have **no tracked
  files** (already gone from git) — the "duplicate CLI" was stale local cruft, not repo debt.
  **(RESOLVED 2026-07-26, stale-doc fix)** The earlier "the CLI is Bun-only (`#!/usr/bin/env bun`,
  imports `bun`), so `npx kn-next` requires Bun" caveat is **wrong for the shipped artifact** — do not
  propagate it, and do not re-file "port the CLI to Node" as E1 work. The published bin is
  `dist/cli/kn-next.js` (`packages/kn-next/package.json:10`), tsup-bundled from `src/cli/deploy.ts`
  (`tsup.config.ts:25`); it carries `#!/usr/bin/env node`, every file in `src/cli/` has the same
  Node shebang, and nothing under `src/cli/` imports `bun`. Proven, not just read: the
  `install-smoke.yml` gate asserts **no bun on PATH**, then packs + `npm install`s the three tarballs
  in a clean dir and runs `kn-next --help` to exit 0 (`scripts/install-smoke.mjs:212-223`), and
  `packages/kn-next/src/__tests__/cli-node-runtime.test.ts` (18 tests) guards the whole claim locally —
  Bun-free static closure, node shebang on every entry, `node kn-next.js <verb> --help` exit 0 for each
  dispatched verb, plus node/bun output parity on the same bundle. So
  `npx kn-next` works under plain Node the moment the packages are published. (Bun is still required
  to run the CLI **from a source checkout**, where the TS is executed directly — that is a contributor
  concern, not a consumer one.)

## 10. Hard rules (enforce in all work)
Official adapter API, not Nitro reverse-engineering · operator = single source of truth ·
proto = single source of truth for services · don't rewrite the runtime twice · gate every
parity claim on the official compatibility suite · **no unauthenticated mutating endpoints** ·
stay the narrow Next.js+Knative adapter, not a general PaaS · design before code, ADRs for
significant decisions.

---

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).
