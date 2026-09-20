# ADR 0010 — Failover promotion scope == routing scope, and the generation ledger as sole authority

Status: Accepted — C1 resolved (live `PUT`/`GET location_config` status codes observed on GKE, §5); C2 pending (one green end-to-end multi-tenant drill)
Date: 2026-09-20

> Numbered to continue past BOTH ADR series in this package: the root
> `docs/adr-0001…0009-*.md` files and the `docs/adr/0001…0003-*.md` sub-series. It was
> first drafted as "0004", which collided with the existing
> `docs/adr-0004-provisioning-bless-or-build.md`; every "ADR-0004" reference elsewhere
> in the repo means that provisioning ADR, not this one.
>
> This ADR is the single home of the **generation-ledger contract**, read side and
> write side. The read half was established by the read-before-attach work
> (`deploy/55-storage-init.yaml`, `deploy/provision-app.sh`): every attach site resolves
> `max(ledger, pageserver-view, 1)` and **fails closed** — refusing to attach — when the
> ledger is unreadable, because flooring to a low generation can hide a higher-generation
> object-store index (silent data loss). The write/seed/heal half is decided below.

## Context

The pageserver auto-failover controller (`pswatcher`) converts the manual failover
runbook into an automatic action: on sustained primary-pageserver death it promotes
the warm standby at `generation+1`, flips the client `pageserver` Service selector to
the standby, and bounces the compute so a cold wake re-attaches to the promoted node.

Two defects were found in that path.

**1. Promotion scope was narrower than routing scope (split-brain).** `pswatcher`
promoted exactly ONE tenant — the base tenant (`PSW_TENANT_ID`). But the `pageserver`
Service it flips routes EVERY tenant the storage plane holds. Investigating the actual
tenant topology:

- The **base tenant** (`f000…`, `compute-config` `TENANT_ID`) — the base app and its
  warm / read-only computes all attach here.
- The **apps tenant** (`a0000000000000000000000000000001`, `APPDB_TENANT_ID` /
  `APPS_TENANT`) — **every per-app `AppDatabase` is a *timeline* branched under this ONE
  tenant**, not a separate tenant (`provision-app.sh`: "each app is a Neon TIMELINE …
  under one 'apps' tenant"; the appdb-operator branches timelines under
  `APPDB_TENANT_ID`).

Neon attach/generation is **per-tenant** (`PUT /v1/tenant/<T>/location_config`), so the
complete routed-tenant set is exactly **{base, apps}** — two well-known ids. Promoting
the apps tenant re-attaches ALL its per-app timelines in one call. Because the old code
promoted only the base tenant, a failover stranded every per-app database on the demoted
pageserver — the split-brain the live GKE run hit and the failover drill's multi-tenant
reachability assertion catches.

**2. The generation ledger's write/heal side was unowned.** T1 (#1095) made the durable
`pageserver-generation` ConfigMap the read authority: bootstrap attach paths read
`max(ledger, pageserver-view, 1)` and **fail closed** on an unreadable/empty ledger. But
T1 also found an upgrade hazard: applying `deploy/57` (which deliberately ships the key
UNDECLARED, `data: {}`) three-way-prunes a live `generation` key from a pre-#1095
install's last-applied-configuration (proved on kind: live `5` → apply → empty). The
fail-closed readers then REFUSE rather than silently floor to `1` — safe, but it turns
an upgrade into a manual runbook step. T1 handed the write/seed/heal side to this task.

## Decision

1. **Promotion scope == routing scope.** On failover, `pswatcher` promotes EVERY tenant
   the flipped `pageserver` Service routes — the base tenant AND the apps tenant — each
   re-attached at the incremented generation, BEFORE the selector flip. The routed set is
   configured explicitly (`PSW_TENANT_ID` + `PSW_APPS_TENANT_ID`), not discovered by
   listing `AppDatabase` CRs: per-app databases are timelines under the single apps
   tenant, so there is no per-app *tenant* to enumerate, and avoiding a CRD list keeps the
   RBAC surface unchanged. Any promotion error ABORTS the failover before the flip
   (retried next tick), so a tenant that exists is never stranded. The flip proceeds only
   if at least one routed tenant was actually promoted.

1b. **A not-found is node-local evidence, never licence to flip.** A `404` means "*this*
   pageserver does not hold the tenant", NOT "the tenant does not exist". Because standby
   warming is best-effort and one-shot (§5), an apps tenant provisioned AFTER
   `pageserver-standby-init` ran is real, routed, and reads as absent there — skipping it
   and flipping would strand every per-app timeline on the demoted pageserver, which is the
   split-brain this ADR exists to close. **OBSERVED-REALITY CORRECTION (C1, §5):** the
   original design read this "not held" signal off the promotion `PUT`, but the live v1 API
   `200`-attaches on `PUT` and only `404`s on `GET`. The valid not-held signal is therefore
   the **GET-viewer** second vantage below, not the PUT — the PUT skip branch is dead code
   against a real pageserver (§5). The corroboration model is unchanged; only which call
   produces the `404` moved. A not-found is resolved by *position and corroboration*:
   - the **base tenant** (first in the routed set — every compute reads through it) is
     **never skippable**: a not-found there aborts the failover, keeping reads on the
     dead primary rather than moving them to a node without the data;
   - a **non-base tenant** may be skipped only when the **second vantage** (§3's routed
     generation view) ALSO reports it absent. That skip is counted
     (`pswatcher_tenant_absent_total`) and alerted (`PswatcherTenantSkipped`);
   - an absence that cannot be corroborated — the vantage errored, or none is wired —
     **aborts**. "We could not check" must never read as "it does not exist".

   The honest consequence: for a plane that DECLARES an apps tenant, warming that tenant
   on the standby becomes a **precondition for automatic failover** rather than an
   optimisation. A blocked, loud, retrying failover is the right trade against a silent
   split-brain, and §5 makes the warming failure visible at deploy time.

2. **The `pageserver-generation` ledger is the sole authority.** `pswatcher` is its sole
   WRITER (advances it on failover) and its SEEDER/HEALER (startup). The single shared
   ledger advances EXACTLY ONCE per failover for the whole plane; every routed tenant is
   promoted at that one generation. Readers (storage-init, provision-app.sh) attach at
   `max(ledger, pageserver-view, 1)` and fail closed — T1's read contract, ratified here.

3. **Startup seed/heal, read from the CURRENTLY-ROUTED pageserver.** The generation view
   (`GET /v1/tenant/<base>`, top-level `generation`) is resolved against the client
   `pageserver` Service — the node the gateway and computes actually dial, and whose
   selector a failover flips — **not** a fixed primary URL. The primary is the node that
   is DOWN in the very failover this controller exists for, and after a failover it is the
   DEMOTED node holding the OLD (lower) generation, so seeding from it under-writes. If
   the routed Service already points at the standby, that is correct: the standby is then
   the authority.

   Two fail-closed rules govern the write:
   - **Never lower.** A ledger ahead of the pageserver's local view (a fresh-PVC
     pageserver reporting 1 / 404ing while the durable ledger is 5) is left untouched;
     an unavailable view leaves the ledger exactly as-is and increments
     `pswatcher_ledger_heal_errors_total` (alert `PswatcherLedgerHealBlind`) so a
     permanently broken vantage cannot turn the heal path into silent dead code.
   - **Never invent.** When the key is ABSENT, the only generation that may be seeded is
     one actually RECOVERED from the pageserver. Writing the base generation on an
     unavailable view — the first draft's behaviour — reopens the silent floor-to-1
     class: a "1" written on a plane that is really at 7 is byte-identical to a genesis
     1, so the fail-closed readers cannot tell it apart and attach low. If nothing can be
     recovered, `SeedLedger` refuses, logs, and leaves the key absent — the readers then
     refuse to attach, which is the loud, correct outcome.

   The same rule governs the failover itself: an absent ledger is recovered from the
   routed view, or the failover aborts. It is never floored to the base generation.

   This still auto-corrects the upgrade-path prune whenever a pageserver is reachable,
   converting the loud fail-closed refusal into automatic recovery.

4. **Single-writer safety is preserved.** `pswatcher` stays a single-replica, crash-only,
   lease-free singleton (`strategy: Recreate`; single-writer is intrinsic to Neon, the
   higher generation fences the dead primary). Multi-tenant promotion is idempotent and
   generation-guarded: re-running converges (each tenant re-promoted at the same
   generation until the flip completes), the ledger never double-advances (advanced once,
   after all tenants promoted), and never promotes below the ledger (`newGen = ledger+1`).

5. **Standby warms the apps tenant — non-fatal at deploy, but LOUD.** The standby-init
   Job registers the apps tenant as a warm Secondary alongside the base tenant. A
   base-only plane legitimately has no apps tenant yet, so a failure there does not fail
   the Job — but it is no longer silent. The helper previously ended in an always-true
   download kick, which made its own failure branch unreachable: a failed registration
   printed nothing. It now returns the REGISTRATION status and the operator gets an
   explicit warning, because under §1b an un-warmed but PROVISIONED apps tenant blocks
   automatic failover rather than cold-attaching.

   **OBSERVED on a live neon pageserver (v1 API, via the routed Service, GKE — C1
   resolved 2026-09-20).** The earlier draft ASSUMED `PUT location_config` answers `404`
   for a tenant the node does not hold. That assumption was WRONG, and it is the exact
   "200 then the tenant goes Broken" case this section flagged as the risk. The two API
   surfaces behave differently and the difference is load-bearing:
   - **`GET /v1/tenant/<unheld>` → `404`** (`{"msg":"NotFound: tenant …"}`). The
     GET-based generation **VIEWER** and the corroboration path built on it — §1b's second
     vantage (`skippable`) and `convergeFailover` — therefore DO see an unheld tenant as
     absent, correctly. The GET-viewer corroboration remains valid.
   - **`PUT /v1/tenant/<unheld>/location_config` `{"mode":"AttachedSingle",…}` → `200`,
     NOT `404`.** The pageserver **ATTACHES**: for a tenant that genuinely exists in the
     object store it attaches it correctly; for a genuinely-nonexistent tenant it creates a
     **phantom empty attachment** that then goes Broken/`503` on use. It never `404`s.

   **Implication, recorded honestly.** The promoter's `404 → ErrTenantNotFound` branch
   (`HTTPPromoter.Promote`) is effectively **dead code against a real pageserver** — the
   PUT never `404`s — so `failover()`'s skip-on-`ErrTenantNotFound` and T5's `skippable`
   corroboration-before-skip are unreachable *via the PUT path*. This does **NOT** reopen
   split-brain: the real routed tenants (base, apps) exist in the object store and attach
   correctly, so promote-all works — proven by the T2 direct-failover run (both tenants
   `1→3`). The residual is narrow: on a plane that DECLARES an apps tenant but has zero
   apps provisioned, a failover PUTs a **phantom empty attach** (`200`) for that apps
   tenant instead of taking the clean skip the `404` branch intended. That phantom attach
   goes Broken on use rather than stranding a real timeline, so it degrades legibility, not
   correctness.

   **Severity correction (D2).** The "degrades legibility, not correctness" framing above
   held only for the case where the apps tenant's timelines genuinely exist on the standby.
   It is WRONG for the case that motivated the automatic-failover safety net in the first
   place: a plane whose standby was **never warmed** for a routed (apps) tenant. There the
   PUT `200`-attaches a **phantom EMPTY tenant** on the standby, `SetGeneration` advances,
   the selector flips, and every per-app DB is then served an empty tenant while the real
   timelines sit fenced on the demoted pageserver — a silent, all-counters-green
   correctness failure worse than split-brain. The `404 → ErrTenantNotFound` detector that
   was supposed to make an un-warmed standby fail LOUDLY is dead against the real
   pageserver, so nothing aborted.

   **Amendment (D2, 2026-09-20) — RESOLVED.** The absence detector is moved onto the
   vantage that WORKS: the **GET standby generation view** (which `404`s correctly), not
   the PUT (which `200`-attaches). `failover()` now consults a standby-pointed
   `GenerationViewer` BEFORE every `PUT AttachedSingle`; a not-held tenant feeds the
   EXISTING `skippable()` logic UNCHANGED (base aborts; a non-base tenant is skipped only
   on a routed-vantage-corroborated absence, else aborts before the flip). This mirrors the
   pattern `convergeFailover()` already used one function away. The `PUT-404 →
   ErrTenantNotFound` mapping and `skippable()` are RETAINED as defence-in-depth for a
   future pageserver image that restores the PUT `404` — the `404` is simply no longer the
   ONLY detector. The GET-viewer corroboration path is unchanged. Wired in `cmd/pswatcher`
   (`SetStandbyGenerationViewer`, pointed at `PSW_STANDBY_BASE_URL`) and asserted by
   `deploy/_validate.sh`. Any future change to the skip logic MUST re-verify against the
   live v1 API — the assumption this section replaced is proof that unit tests, which fake
   exactly these status codes, cannot close it.

## Options considered

| Option | How the routed set is known | Trade-offs |
|---|---|---|
| **A. Configured tenant set {base, apps} (CHOSEN)** | Two well-known ids via env | Matches the real topology (per-app = timelines under one apps tenant); bounded + deterministic; no new RBAC; correct regardless of standby warming (cold attach works). Residual: a tenant id added to the plane outside {base, apps} would need a config change (none exists today). |
| B. List `AppDatabase` CRs and promote each | Kube API list of the CRD | Architecturally wrong — AppDatabases map to timelines under ONE tenant, not to tenants; promoting "per app" would repeatedly re-attach the same apps tenant. Adds CRD list RBAC for no benefit. |
| C. Enumerate from the pageserver's tenant list (`GET /v1/tenant`) | The promotion-target (standby) | Elegant ("promote what the target holds") but only lists tenants registered on the standby (Secondary locations); an apps tenant provisioned AFTER standby-init, or never warmed, is missed → the exact split-brain. Rejected as the sole source; the standby list is an optimisation, not the authority. |
| D. Per-tenant generation ledgers | one ledger key per tenant | Both tenants have always shared one ledger (storage-init + provision-app read the same `pageserver-generation`); per-tenant ledgers would fork the authority and complicate the reader contract for no gain (both attach at the same generation). |

For the generation-view vantage we considered three sources:

| Vantage | Trade-offs |
|---|---|
| **The routed `pageserver` Service (CHOSEN)** | Follows routing rather than a node identity, so it is correct on both sides of a flip: pre-failover it resolves to the primary, post-failover to the promoted standby (the new authority). One address, no reconfiguration after a failover. Residual: during the failover window it resolves to the DEAD primary, so corroboration is unavailable exactly then — which is why §1b fails closed and §5 makes standby warming a precondition. |
| A fixed PRIMARY URL (first draft, REJECTED) | Reads the node that is down in the failover this controller exists for, and that is DEMOTED after one — so the seed/heal under-writes with the OLD generation and the second vantage is permanently unavailable post-failover. |
| The STANDBY's view | Holds Secondary locations that may report a stale generation, and is the same node that produced the 404 — so it is no second vantage at all for §1b. |

A genuinely independent vantage (the object-store index) was not built: it would add S3
credentials and a bucket-scanning code path to the watcher for one decision. That is the
honest gap behind §1b's fail-closed default, not an oversight.

## Consequences

**Positive.**
- A failover recovers reads for EVERY tenant the Service routes — the split-brain is
  closed; the failover drill's multi-tenant reachability assertion goes green.
- The upgrade-path ledger prune self-heals at pswatcher startup — T1's manual runbook step
  becomes automatic, while the fail-closed reader guarantee is unchanged.
- RBAC is unchanged (config + pageserver HTTP only; no `AppDatabase` list).
- New per-app databases are covered for free — they are timelines under the already-routed
  apps tenant.

**Negative / residual (stated honestly).**
- The routed set is config-driven. A future tenant beyond {base, apps} would require a
  `PSW_APPS_TENANT_ID`-style addition; there is no auto-discovery. This matches the fixed
  two-tenant topology but is a coupling to note if the topology grows.
- The `GET /v1/tenant/<T>` top-level `generation` field and the `PUT location_config`
  status behaviour are pinned to the live pageserver (neon:8464). **Now OBSERVED on live
  GKE (C1, §5):** `GET` on an unheld tenant `404`s (so the GET-viewer corroboration is
  valid), but `PUT location_config` **`200`-attaches rather than `404`ing** — the
  promoter's `404` skip branch is dead code against a real pageserver. This does not
  reopen split-brain (real tenants attach correctly; T2 proved `1→3` for both), but a
  declared-but-unprovisioned apps tenant gets a phantom empty attach instead of a clean
  skip. See §5 for the tech-debt follow-up. A future pageserver image change to either
  shape would need re-verification.
- **Apps-tenant warming is now a precondition, not an optimisation, on a plane that
  declares an apps tenant.** One-shot standby-init means an apps tenant provisioned long
  after it ran is un-warmed; because the failover's second vantage (the routed Service)
  resolves to the dead primary during a failover, that absence cannot be corroborated and
  the failover ABORTS, retrying each tick. This is deliberate — it is the fail-closed
  side of the trade against a split-brain — but it is a real availability cost: an
  operator who provisions apps and never re-runs `pageserver-standby-init` has, in
  effect, disabled automatic failover. `_validate.sh` asserts the apps-tenant id is in
  lock-step across the four files that carry it, and the Job now warns loudly on a failed
  registration, but nothing yet *periodically* re-warms. A reconciling (rather than
  one-shot) warm is the follow-up.
- **`pswatcher` now has more reasons to refuse than to act.** Absent-and-unrecoverable
  ledger, base tenant not held, uncorroborated non-base absence — each aborts. Every one
  is loud (log + counter + alert), but the aggregate posture is that this controller
  prefers a continued read outage over a wrong promotion. That is the correct default for
  a single-writer storage plane; it is stated here so it is not discovered during an
  incident.
- Single-replica crash-only means a brief promotion gap during a watcher restart persists
  (unchanged by this ADR); recovery is idempotent.
- **Compute-bounce authority (cross-controller write, recorded on purpose).** On a failover
  `pswatcher` deletes every pod matching `plane=compute` so a cold wake re-attaches to the
  promoted standby. That selector reaches **operator-owned per-app computes** (the
  `appdb-operator`'s writer/RO Deployments), not just the base writer — a controller writing
  to another controller's workload. It is intentional and benign: the owning Deployment
  recreates the pod immediately, and the delete carries no spec change. `pswatcher` holds
  compute-bounce authority during a failover; the `appdb-operator` has no failover awareness
  and needs none, because a recreated compute reads the flipped `pageserver` Service and the
  ledger like any cold wake. RBAC is `pods: [list, delete]` (namespace-scoped) — no Deployment
  mutation. Stated here so a future reader does not read the cross-controller delete as a bug.
- **Failure-domain placement is a precondition, not an implementation detail.** This design
  assumes the promotion target and the observer SURVIVE the node death that triggers a
  failover. That assumption is only true if the standby (57) is never co-scheduled with the
  primary (53) and `pswatcher` (58) is not co-resident with the primary it watches. The
  placement is enforced by anti-affinity: HARD on the standby (57), SOFT on the primary (53)
  and pswatcher (58) so neither can be rendered unschedulable — one hard side already makes
  co-scheduling impossible. Asserted in `deploy/_validate.sh` (term type, `kubernetes.io/hostname`,
  AND the repelled label value) in the same scan-not-comment style as the
  no-unreachable-toleration contract. See ADR-0012 for the reversible-outcome framing and the
  single-node dev tradeoff.

## Action items

- [x] `pswatcher` promotes every routed tenant at the incremented generation,
      abort-on-error, flip only after ≥1 promoted (`internal/pswatcher/watcher.go`).
- [x] Not-found handling per §1b: base tenant never skippable, non-base skipped only on a
      corroborated absence, uncorroboratable absence aborts (`Controller.skippable`).
- [x] Startup ledger seed/heal — heal UP only, never lower, **never invent**: an absent
      key is seeded only from a recovered generation (`SeedLedger`); `failover()` applies
      the same rule instead of flooring to `BaseGeneration`.
- [x] `HTTPGenerationViewer` resolved against the ROUTED Service + `ErrTenantNotFound` on
      404 (`internal/pswatcher/http.go`); `PSW_ROUTED_BASE_URL` replaces the rejected
      `PSW_PRIMARY_BASE_URL` (`deploy/58-pswatcher.yaml`).
- [x] `pswatcher_tenant_absent_total` + `pswatcher_ledger_heal_errors_total` metrics, each
      with an alert (`PswatcherTenantSkipped`, `PswatcherLedgerHealBlind`, `deploy/60`);
      the swallowed vantage error is now logged.
- [x] `warm_secondary()` returns the registration status so its failure branch is
      reachable (`deploy/57-pageserver-standby.yaml`).
- [x] The apps-tenant id lock-step (58 / 83 / 57 / `provision-app.sh`) is ASSERTED by
      `deploy/_validate.sh`, not requested by comments; the routed-tenant derivation is a
      unit-tested helper (`pswatcher.RoutedTenants`).
- [x] Unit tests: all-tenants promotion, corroborated skip, base-not-found abort,
      uncorroborated-absence abort, abort-on-real-error, seed/heal (up + never-down +
      unreachable + refuse-to-invent), absent-ledger recovery + refusal, multi-tenant
      idempotency — each mutation-proved.
- [x] Failure-domain placement: HARD podAntiAffinity keeps the pageserver primary (53) and
      warm standby (57) off the same node; SOFT podAntiAffinity keeps `pswatcher` (58) off the
      primary's node — both scanned by `deploy/_validate.sh` (sprint-close C3, ADR-0012).
- [x] C1: real `PUT`/`GET location_config` status codes OBSERVED on a live GKE pageserver
      and recorded in §5 — `GET` 404s on an unheld tenant (viewer corroboration valid),
      `PUT` 200-attaches (never 404s; the promoter's 404 skip branch is dead code).
- [x] Follow-up (tech-debt, from §5) — RESOLVED (D2, see the §5 amendment): the absence
      detector moved onto the GET standby generation view (404-correct); `failover()`
      consults it before every PUT and feeds a not-held tenant into the unchanged
      `skippable()`. The PUT-`404`→`ErrTenantNotFound` path + `skippable()` retained as
      defence-in-depth. Wired in `cmd/pswatcher` (`SetStandbyGenerationViewer`) + asserted
      by `deploy/_validate.sh`; unit-tested (phantom-attach abort, base abort, corroborated
      skip, unreadable-view abort) and mutation-proved. On-cluster re-verify still gated by
      the C2 drill below.
- [ ] C2: on-cluster verification via the full multi-tenant failover drill (owned by the
      drill task, #1101) on a recovered/clean plane.
- [ ] Follow-up: make standby warm-Secondary registration reconciling rather than
      one-shot, so an apps tenant provisioned after deploy does not block failover.
