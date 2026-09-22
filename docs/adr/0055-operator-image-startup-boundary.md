# ADR-0055: The image declares how to start itself; the operator selects image + env + probes, never a command

- **Status:** **Accepted (2026-09-22).** Design-gated: system-designer design + architect co-sign,
  both ratified on issue #1155 (SIGN-OFF under conditions C1–C6). This ADR is condition **C1**.
- **Depends on:** ADR-0001 (the Go operator is the single source of truth for **cluster state**).
- **Governs:** the operator↔image **startup contract** for **every** runtime target
  (node-standalone, bun-standalone, vinext), independent of which axis is the default.
- **Relates to:** ADR-0054 (the runtime-axis decision this unblocks — see its Amendment 6),
  ADR-0027 (globalThis seam discipline), ADR-0040 (spec-field validation — this ADR takes a
  deliberate annotation exception, §Consequences), ADR-0044 (dated-exception precedent for the
  expiries below). Implements the gate for #1155 and unblocks #1156/#1157/#1172.

## Context

The operator forces a container command for the standalone shape:
`nextapp_controller.go` sets `Command: ["bun","run","server.js"]` when
`Spec.Build != "vinext" && Spec.Runtime == "bun"`. That command **replaces the image's
entrypoint**, so the image's own supervisor (`node-server.ts`) never runs — and the app silently
loses everything the supervisor provides: SIGTERM forwarding + awaited DB-pool drain + the grace
hardcap (#1156), the eagerly-bound `:9464` metrics endpoint the NetworkPolicy/PodMonitor assume
(#1157), the compat-gated Cache-Control preload (#175), the Bun keep-alive guard (#1153), and the
compile-cache diagnostics.

The root cause is **a boundary violation, not a missing feature**: the operator encodes the
image's internal filesystem layout (`server.js`, relative to an assumed WORKDIR). An image is the
one component that knows how it is built; the operator is not. When the operator invents the start
command, the running shape is determined by a string the operator **assumes**, not by the artifact
the CR **pins**.

## Decision

**The image declares how to start itself. The operator selects image + env + probes, and never a
command.**

1. **The runtime image owns its ENTRYPOINT** — a supervisor entry (`knext-standalone-entry.mjs`
   importing `@getknext/core/internal/node-server`, the runtime-agnostic supervisor). The operator
   leaves `Command`/`Args` **`nil`** for the standalone shape; kubelet runs the image's ENTRYPOINT.
2. **The running shape stays fully CR-determined** — because the CR names the image **by digest**
   (`:latest` rejected in `internal/validation/validate.go:117` `ValidateImageRef` — the single
   source of truth shared by the admission webhook and the reconciler, which reaches it via the
   `controller/validate_image.go` wrapper) and a digest is immutable. Determination moves
   from a command string the operator *invents* to an artifact the CR *pins*. The operator's
   cluster-write surface **shrinks by one field**.
3. **Legacy command retirement is behind a strictly-parsed escape hatch.** The forced command
   survives only when the CR carries annotation `apps.kn-next.dev/legacy-bun-command: "true"` —
   **exactly** the string `"true"` engages it; any other value is ignored **and** reported via
   `computeStatusVerdict` (never silently, never a new `Reconcile` branch — `architecture.md` §4).
   When engaged, `computeStatusVerdict` emits an honest-status condition: *drain and `:9464` metrics
   are not active on this container command.* An annotation (not a spec field) is deliberate — it
   needs **no CRD roll**, so there is no *schema* upgrade-order hazard (#548) — an older operator
   cannot reject a field a newer CLI emits. The distinct *behavioural* #548 hazard — a pre-template
   user-built bun-standalone image flipping Bun→Node when the operator retires its command — is real
   and handled by the annotation + the caveat below, not by the CRD.
4. **Upgrade-order safety via a compat shim.** The same supervisor entry is copied to
   `/app/server.js` — the path the *current* operator command names — so all four upgrade
   directions behave: old-operator × new-image (`bun run server.js` hits the shim → supervisor),
   new-operator × new-image (ENTRYPOINT → supervisor), new-operator × old-image (image's own CMD,
   unchanged), old × old (today).

   **Caveat on the `new-operator × old-image` direction — the one that is asserted, not argued.**
   "Image's own CMD, unchanged" is safe only when that CMD is correct for the workload, which holds
   for a knext-built **vinext** image (the operator already leaves `Command` nil there). It does
   **not** hold for a **user-built bun-standalone** image from *before* this ADR ships a template:
   no bun-standalone image template exists today, so those images were built by hand and relied on
   the operator to force `bun run server.js`. A conventional `next build` standalone image carries
   `CMD ["node","server.js"]` (or none), so retiring the forced command silently flips that
   workload from **Bun to Node** (or leaves it with no command) — a behaviour change with no crash
   to announce it. The `legacy-bun-command` annotation covers it, but it is opt-in per-CR: such an
   operator **must set the annotation before upgrading the operator**, and keep it until they
   rebuild on the shipped template. This is the **behavioural** operator-first ordering story (#548
   — distinct from the absent *schema* hazard in Decision item 3), and the
   #1155 implementation ships the upgrade note to `docs/RELEASING.md` (action item 6).

**This ADR records the invariant, not the entry-file shape (C6).** If the `--compile --bytecode`
path (ADR-0054 action item 1) lands, *which process is PID 1* changes and the supervisor must be
compiled in or wrap the binary — the entry **file** changes, the **invariant holds more strongly**
(a compiled image cannot have its command re-invented by the operator at all).

## Options considered

| Option | Boundary | Upgrade safety | Drain/metrics | Verdict |
|---|---|---|---|---|
| **(a)+(b) image-owned ENTRYPOINT + command retirement + shim** *(chosen)* | image owns layout; operator writes one field fewer | shim covers all 4 directions | restored via supervisor | **Adopt.** jev pick `image_entrypoint` 0.96 |
| (b) alone — repoint the forced command at a supervisor path | operator still holds image-layout knowledge | crash-loops every pre-existing image on operator-first upgrade (#548) | restored | Rejected — same defect relocated |
| (c) sidecar container for drain+metrics | operator unchanged | n/a | **cannot** deliver drain (SIGTERM is per-container; a sidecar cannot await another container's exit) | Rejected — solves the lesser half at higher cost; contends for `:9464` |

## Consequences

- **Improves ADR-0001 rather than weakening it.** ADR-0001 scopes "single source of truth" to
  **cluster state** — no tool but the operator mutates the ksvc/PVC/SA. That is untouched: the
  operator remains the sole ksvc writer; the CLI still only applies the `NextApp` CR. No second
  writer of deployment shape is introduced. The operator stops encoding another component's
  filesystem layout — a cleaner boundary. *(architect jev: P(violates ADR-0001) = 0.08.)*
- **Both back-compat affordances carry a dated expiry (C3, ADR-0044 precedent):** the
  `legacy-bun-command` annotation **and** the `/app/server.js` shim expire at **Tier-A exit / v1.0**.
  Without an expiry the invariant erodes into a permanent dual-path and the operator keeps its
  image-layout knowledge forever. **Anchor caveat, learned from the cited precedent:** ADR-0044
  **Amendment 2** ("the expiry is re-anchored — its old anchor became unreachable") records that
  *this exact* "Tier-A exit / v1.0" phrasing is **unreachable by construction** — no event fires to
  trigger it (#742). So the named milestone is the *intent*, and the *mechanism* is a reachable,
  owned one: the removal of both affordances is a **standing sprint-close review item** (the gate
  that already meets at each sprint boundary owns it), revisited every sprint until it lands — not
  left waiting on an undefined milestone. Action item 3 tracks it as an issue, not comment lore.
- **Annotation vs spec field (C4, ADR-0040 exception):** ADR-0040 validates deploy-affecting inputs
  as spec fields with a CLI mirror. This hatch is a deliberate exception — a transient,
  expiring back-compat lever, not a durable input — so it is an annotation validated **in
  `computeStatusVerdict`**, not a spec field. Recorded here so the omission is a decision, not a gap.
- **The image-contract test asserts the R3 path algebra (C5), not just file presence:**
  `WORKDIR /app` (the old forced `server.js` is **relative** — the shim fails silently if WORKDIR
  moves), the shim at `/app/server.js`, and the real Next server at a **non-colliding**
  `STANDALONE_SERVER_PATH` (`.next/standalone/server.js`). A conventional Next image puts the
  standalone tree's own `server.js` at exactly `/app/server.js`; a collision means the wrong one
  wins silently. Mutation-prove it.
- **Security is a net improvement** — `:9464` returns to the only port the NetworkPolicy admits, and
  bearer-guarded mutating routes regain a drain that lets in-flight mutations settle. Non-root,
  digest-pinned, npm-free runtime layer.

## Amendment 1 (2026-09-23, #1178) — the standalone image's `@getknext/lib/clients` gap is DOCUMENTED-as-degraded, not shipped; the degradation is SURFACED, not silent

The standalone image (action item 1) copies the supervisor's own runtime closure
(`@getknext/core` dist + pino/prom-client/@opentelemetry) but **deliberately omits**
`@getknext/lib/clients`' native closure (`@cerbos/grpc`, `minio`, `pg` — by far the heaviest
graph either supervisor call site can reach, and the biggest CVE surface). Both call sites fail
open when it is absent (`db-drain.ts` catch→warn→return; `image-cache-sync.ts` never imports the
store client unless `STORAGE_BUCKET` is set), so the ENTRYPOINT does not crash-loop — but the
**DB-pool drain (writer + read-only) and image-cache sync then no-op**. The read-only-pool drain
loss is the load-bearing one: un-drained DB sockets can hold a scale-to-zero compute awake (the
#245 loss), defeating the axis's own differentiator.

**Decision: DOCUMENT-as-degraded now + SURFACE loudly; defer the closure/opt-in to the CLI-wiring
increment.** We do **not** ship the heavy closure into the lean supervisor image in this
increment, because:

1. A lean supervisor is this ADR's design intent; `@cerbos/grpc + minio + pg` is the heaviest
   graph and the largest CVE surface, against an image whose whole point is to stay small.
2. The template is **not yet emitted or built by any scaffolder** — there is no build context to
   ship a closure *into*. Installing it belongs to the CLI-selection increment that actually
   renders and builds this file and controls its `.dockerignore` (see the Dockerfile header).
3. Naively copying the closure into the supervisor's `/app/node_modules` may not even restore
   drain: `@getknext/lib` is **bundled** into the app's standalone output (webpack; it must stay
   bundled per `architecture.md` §4 / the #352 rule), so the supervisor's separate copy is a
   different module instance with empty pool state. Restoring drain correctly is a design question
   the opt-in increment must answer, not a COPY line.

**But the honest floor ships now, regardless of ship-vs-document:** the degradation is no longer
silent. `db-clients-probe.ts`'s `warnIfDbClientsUnavailable` runs once, eagerly, in the supervisor
entry (`node-server.ts`, beside `registerDbPoolDrain`). It **resolves** the `@getknext/lib/clients`
specifier — `import.meta.resolve`, never `import()`, so the heavy graph stays off the cold-start
path (#441) — and emits ONE loud WARNING naming the disabled capabilities and the scale-to-zero
consequence when the module is absent. The future path is **opt-in**: an app that needs
drain/image-cache on the standalone axis rebuilds the runtime image with the clients closure
included; wiring that selection is left to the CLI increment (#1155's later increments) that owns
the build context. *(jev cross-check of document-vs-ship: 0.88 for this call.)*

## Action items

1. New template `Dockerfile.standalone.hbs` + `knext-standalone-entry.mjs.hbs`; image-contract test
   asserting the C5 path algebra (mutation-proved). *(#1155)*
2. Operator: leave `Command` `nil` for the standalone shape; strict annotation parse + honest-status
   condition in `computeStatusVerdict`; controller tests. *(#1155)*
3. Both affordances are removed on a **reachable** anchor — a standing sprint-close review item
   (not the unreachable "Tier-A exit / v1.0" milestone; see the anchor caveat above and ADR-0044
   Am. 2), owned by a dedicated issue that stays OPEN until the removal ships, revisited each sprint
   until it lands. *(**#1175** — deliberately NOT #1155, which closes when the image + operator work
   merges, long before every deployment has rebuilt; the removal must outlive it.)*
4. The 778/0 credential covers the harness boot path (raw `server.js` + preloads), **not** the
   supervisor-wrapped entrypoint this ADR ships — close via the target-agnostic conformance suite.
   *(#1172)*
5. ADR-0054 Amendment 6 records the axis-local consequences (the standalone image exists; the
   supervisor is the standalone `RuntimeContract` implementation, #1152).
6. The #1155 implementation PR ships the **operator-first upgrade note** to `docs/RELEASING.md`
   (which already owns the operator-first ordering story): an operator running `runtime: bun` on a
   **user-built** image from before the shipped template must set
   `apps.kn-next.dev/legacy-bun-command: "true"` before upgrading the operator, until they rebuild
   on `Dockerfile.standalone.hbs`. Without it, the `new-operator × old-image` direction silently
   flips such a workload Bun→Node. *(#1155)*
