# knext — Project Strategy & Hard Rules (canonical)

> This is the persistent source of truth for **direction**. Detailed roadmap: `ROADMAP.md`.
> Architect operating discipline: `.claude/rules/architecture.md`. Decisions: `docs/adr/`.
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
  cold-start bytecode caching via `NODE_COMPILE_CACHE`. The deprecated Vinext/Nitro runtime
  (`node-server.ts`) is on its way out.

## 4. Control plane (ADR-0001)
- The **Go operator is the single source of truth** for cluster state. The TS CLI must stop
  generating raw Knative manifests — the live `deploy.ts` path is a **violation** and has drifted
  (e.g. hardcoded `containerConcurrency`). CLI = build/publish + emit a CR; operator reconciles.
- Enforce **`:latest` rejection / digest pinning everywhere** (the revalidator sidecar still uses
  `:latest` — fix).

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
- **No unauthenticated mutating endpoints.** Fix `POST /api/cache/invalidate` (signed token /
  internal-only NetworkPolicy); never repeat the pattern.
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
- Real data plane = **GCS + Redis on GKE**; S3/Azure/MinIO are thin shell-outs; DynamoDB/Kafka are
  config/manifest-only — implement+test or trim the schema/docs.
- **Image optimization missing** (biggest functional gap).
- `node-server.ts` welded to deprecated Vinext/Nitro (removed by the migration).
- Tests light on core build/deploy/upload/cache paths (manifest gen is covered).
- Operator gaps: no status `Conditions`, no finalizers, happy-path reconcile, API at `v1alpha1`.
- **License inconsistency:** root MIT vs operator Apache-2.0 — pick one.
- Nothing published to npm (blocks `npx kn-next` for outside users).
- Duplicate/dead packages: `packages/cli` (Go) vs `packages/kn-next/src/cli` (TS); `admin`/`knext`
  vs `kn-next` naming drift — audit/remove.

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
