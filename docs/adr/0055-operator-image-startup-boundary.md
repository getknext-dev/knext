# ADR-0055: The image declares how to start itself; the operator selects image + env, never a command

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
   (`:latest` rejected in `validate_image.go:29` `validateImageRef`, surfaced as
   `ReasonInvalidImage`) and a digest is immutable. Determination moves
   from a command string the operator *invents* to an artifact the CR *pins*. The operator's
   cluster-write surface **shrinks by one field**.
3. **Legacy command retirement is behind a strictly-parsed escape hatch.** The forced command
   survives only when the CR carries annotation `apps.kn-next.dev/legacy-bun-command: "true"` —
   **exactly** the string `"true"` engages it; any other value is ignored **and** reported via
   `computeStatusVerdict` (never silently, never a new `Reconcile` branch — `architecture.md` §4).
   When engaged, `computeStatusVerdict` emits an honest-status condition: *drain and `:9464` metrics
   are not active on this container command.* An annotation (not a spec field) is deliberate — it
   needs **no CRD roll**, so there is no operator-first upgrade-order hazard (#548).
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
   rebuild on the shipped template. This is the operator-first ordering story (#548), and the
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
  image-layout knowledge forever.
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

## Action items

1. New template `Dockerfile.standalone.hbs` + `knext-standalone-entry.mjs.hbs`; image-contract test
   asserting the C5 path algebra (mutation-proved). *(#1155)*
2. Operator: leave `Command` `nil` for the standalone shape; strict annotation parse + honest-status
   condition in `computeStatusVerdict`; controller tests. *(#1155)*
3. Both affordances expire at Tier-A exit / v1.0 — tracked, not comment lore. *(#1155)*
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
