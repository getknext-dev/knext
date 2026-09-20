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

   **Amendment (D4, 2026-09-20) — the ledger write is a CAS, and the reserve moves BEFORE
   the promotes.** §4 as first written trusted `Recreate` for single-writer safety and
   advanced the ledger *after* promoting. Both assumptions have a hole the partition threat
   model exposes:

   - **`Recreate` guards a ROLLOUT, not a PARTITION.** A node going unreachable leaves its
     `pswatcher` stuck `Terminating`; the standard remediation force-deletes the `Node`
     object, the API force-deletes the pod, and a NEW `pswatcher` starts **while the old one
     may still be running on the isolated kubelet**. That is the only window with two live
     `pswatcher`s — and it is exactly the window in which both decide to fail over. The
     ledger write was a merge-patch with **no precondition**, so the loser could clobber the
     winner's higher generation.
   - **Advancing after promoting is unsafe under two writers.** The loser has ALREADY
     `PUT` tenants at `newGen` before it discovers it lost — two writers both promoted.

   The fix, two parts:

   1. **resourceVersion CAS on every ledger write.** `GetGeneration` returns the ledger
      ConfigMap's `resourceVersion`; `SetGeneration(gen, rv)` writes under that precondition.
      A lost CAS is `ErrLedgerConflict`: the tick **aborts LOUDLY**
      (`pswatcher_ledger_cas_conflicts_total`, alert `PswatcherLedgerCASConflict`) and
      **NEVER retries at the winner's value** — adopting the winner's generation mid-failover
      is how two writers both come to believe they are current.
   2. **Reserve BEFORE promoting.** The order is now *validate the routed set (reads only) →
      CAS-reserve `newGen` → promote every tenant at the reserved generation → flip → bounce*.
      A lost CAS therefore aborts **before any `PUT`**. This is also the SAFE skew direction:
      a ledger AHEAD of reality self-heals (`convergeFailover` re-promotes up to the ledger;
      readers take `max(ledger, view, 1)`), whereas reality ahead of the ledger is the
      fencing hazard. Crash-resume is preserved: an in-instance retry after a PARTIAL
      promotion (a later tenant's `PUT` failed and aborted the tick) resumes at the SAME
      reserved generation — promotion at an already-reserved generation is idempotent — so a
      transient promote error never double-advances the ledger. The consequence for the
      validation-abort tests: a promote-error abort now leaves the ledger reserved one ahead
      (converge heals it), rather than untouched; the load-bearing invariant, unchanged, is
      that the Service never flips onto a half-promoted plane.

   `convergeFailover` is a ledger CONSUMER (it never calls `SetGeneration`), so it does not
   contend; T2 promote-all contends only through the ordering, which the reserve-first
   inversion resolves.

   **The `reservedGen` lifetime contract (made explicit).** The in-instance reservation is a
   single `int` field and its whole safety argument rests on three properties, so they are
   stated rather than assumed:
   - **It is CLEARED at the flip.** Once the flip+bounce completes, `reservedGen` is reset to
     0 — the reservation is outstanding ONLY while a reserve has been written but the flip
     has not yet happened. (A `DeletePods` error after the flip is the one path that retains
     it: the next tick must resume at the SAME generation to re-bounce, not reserve afresh.)
   - **`failover()` runs at most once per process.** The `done` latch makes `failover()`
     unreachable again after a successful completion, so a stale reservation cannot be
     re-adopted through the normal control flow.
   - **`newGen >= ledger` is ASSERTED, not assumed.** After computing `newGen`, the code
     aborts unless it is at least the current ledger generation — a mechanical fence that
     makes "promote below the ledger" unparseable-to-violate even if a future re-entry path
     ever carried a stale reservation past the two properties above. The comparison is `>=`,
     not `>`, because a legitimate crash-resume reads `ledger == reservedGen` (the reserve
     already advanced the ledger) and MUST proceed; only a reservation strictly below the
     ledger is fenced. The absent-ledger reserve is CAS-safe too: `SetGeneration` with an
     empty resourceVersion CREATEs the ledger (a compare-and-swap against non-existence), so
     two partitioned writers reserving from the same absent state cannot both succeed.

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
     absent, correctly. The GET-viewer corroboration remains valid. **Scope of this
     observation (corrected in the D2 amendment below): it was made THROUGH THE ROUTED
     SERVICE, i.e. against the ATTACHED primary, and it does NOT generalise to the
     standby** — where a tenant held as a warm Secondary answers `503`, not `404`. Read it
     as a fact about an attached node, never as a general held/not-held oracle.
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

   **Amendment (D2, 2026-09-20) — RESOLVED, and the first attempt at it was WRONG.**
   The absence detector is moved off the PUT (which `200`-attaches). The first D2 round
   moved it onto the **standby's `GET /v1/tenant/<T>` generation view**, reasoning from
   the C1 observation above that that GET `404`s for an unheld tenant. C1 was observed
   **through the routed Service — i.e. against the PRIMARY**, and it does not generalise
   to the standby: a correctly-warmed standby holds its routed tenants as warm
   **Secondaries**, and the per-tenant endpoints do not answer for a Secondary.

   **Re-verified LIVE against the standby (gke `szpg-f5`, `pageserver-standby-0`,
   2026-09-20) — this is the re-verification this section mandates, actually performed,
   not asserted from unit tests:**

   | Request (standby, tenant held as a warm Secondary) | Response |
   | --- | --- |
   | `GET /v1/tenant/<T>` | **`503`** `"Tenant not yet active"` |
   | `GET /v1/tenant/<T>/location_config` | **`404`**, though the tenant IS held |
   | `GET /v1/location_config` | **`200`** `{"tenant_shards":[["<T>",null],…]}` — lists every held shard, Secondaries included |

   So a pre-flight built on the generation view **errors on the first routed tenant of
   every failover** and aborts it: fail-closed, but HA permanently dead on the real
   plane — the same outcome as no failover at all, reached by the opposite mistake. Unit
   fakes modelled only `200`/`404`, so nothing caught it; this is the second time in one
   ADR that faking status codes hid a live-API fact.

   The detector is therefore the **plane-wide membership listing**: a
   `TenantMembershipViewer` over `GET /v1/location_config`, pointed at the standby,
   reporting held = "the tenant id is in `tenant_shards`". `held=false` means only "the
   standby answered `200` and did not list it"; transport failure, non-2xx, an
   unparseable body or a missing `tenant_shards` field are ERRORS, never absence.
   `failover()` consults it BEFORE every `PUT AttachedSingle`, for every routed tenant,
   and a not-held tenant feeds the EXISTING `skippable()` logic UNCHANGED (base aborts; a
   non-base tenant is skipped only on a routed-vantage-corroborated absence, else aborts
   before the flip).

   The pre-flight is **UNCONDITIONAL and fails closed on omission**: an unwired oracle
   returns `ErrNoStandbyMembership` and aborts rather than falling through to the dead
   PUT-`404` path, since falling through would reinstate the phantom attach by accident
   (ADR-0012: fail toward the reversible state). The `PUT-404 → ErrTenantNotFound`
   mapping and `skippable()` are RETAINED as defence-in-depth for a future pageserver
   image that restores the PUT `404`. The routed-vantage (`GET /v1/tenant/<T>` through the
   client Service) corroboration path is unchanged — it reads the ATTACHED primary, where
   C1's observation does hold. Wired in `cmd/pswatcher`
   (`SetStandbyMembershipViewer`, pointed at `PSW_STANDBY_BASE_URL`) and asserted by
   `deploy/_validate.sh`, which now pins the ENDPOINT as well as the wiring. Any future
   change to the skip logic MUST re-verify against the live v1 API **on the node it will
   actually query, in the location mode that node will actually be in** — the two wrong
   assumptions this section has now replaced are both proof that unit tests, which fake
   exactly these status codes, cannot close it.

   **Known limit, stated rather than discovered later:** membership matches the EXACT
   tenant id. On a sharded plane `tenant_shards` would carry `<tenant>-<shard>` entries,
   which this reports as not-held — so a failover would abort loudly instead of attaching
   onto an unverified standby. The plane is unsharded (verified live); shard-id parsing is
   deliberately not invented ahead of a plane that uses it.

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
  one-shot) warm is the follow-up. **RESOLVED (D1) — see the amendment below.**

  **Amendment (D1, 2026-09-20) — the warm is now CONTINUOUS, not one-shot.** The residual
  above named the wrong trigger. Per-app databases are *timelines* under one apps tenant,
  so the routed set `{base, apps}` does not grow per app — a "never-warmed new app" is not
  the real gap. The real trigger is a FAILOVER: once it succeeds the promoted standby is
  the primary and the ex-primary becomes the standby that **nobody re-warms**, so the
  plane is disarmed from the first successful failover until an operator re-runs the Job.
  `pswatcher` now runs a reconciling standby-warm loop (`reconcileStandbyWarm`, driven by
  `Tick` every `PSW_WARM_INTERVAL_MS`, bounded by `PSW_WARM_DEADLINE_MS`): each pass it
  resolves the CURRENT standby as the node the client Service does NOT select and
  registers any **absent** routed tenant there as a warm Secondary. The one-shot Job (57)
  stays as the deploy-time warm.

  **What the ex-primary comes back as is NOT assumed (correction, #1124 review).** An
  earlier draft of this amendment asserted it returns an "empty standby". That was never
  established, and the common variant contradicts it: `53-pageserver.yaml` RETAINS the PVC,
  so the pod restarts and reloads its **persisted `AttachedSingle` at the OLD generation**.
  It is then listed in `/v1/location_config` — so a membership-only read calls it warm, the
  reconcile skips the PUT, and the gauge publishes "HA armed" for a node that is not an
  armed standby at all: a false green, and weaker than the one-shot Job it replaces. The
  loop therefore reads the location **mode**, not just membership:

  | what the standby lists for a routed tenant | gauge | write | counter |
  |---|---|---|---|
  | absent | 0 until confirmed | PUT warm Secondary | `…_warm_registrations_total` |
  | held, `null` config (Secondary) | 1 | none | — |
  | held, attached config | **0** | **none** | `…_standby_stale_attached_total` |
  | unreadable | 0 | none | `…_warm_errors_total` |

  **The write stays mode-AGNOSTIC on purpose — it PUTs only when the tenant is ABSENT.**
  Making the write mode-aware ("it is attached, not a Secondary, so register one") would
  reintroduce the outage this loop exists to prevent: in the promote-**before**-flip window
  the just-promoted node is attached AND not yet selected by the client Service, so
  `resolveStandby` resolves IT as the standby, and a Secondary PUT there demotes the new
  writer. Mode-aware gauge, mode-agnostic write: a misread mode can then only mis-report,
  never demote. Clearing a genuinely stale attached location is an operator action
  (`PswatcherStandbyStaleAttached` → `docs/operations.md`), not this loop's.

  **The one way this loop could cause the outage it prevents — the never-demote guard.**
  Registering a Secondary on the node the client Service currently selects would DEMOTE the
  live writer. So the standby is resolved from the LIVE selector every reconcile
  (`resolveStandby`), and the warm PUT targets only the node the client Service does NOT
  select — `pageserver-standby` at rest, the rebuilt ex-primary (`pageserver-primary`)
  after a failover. A selector that is empty, names no known node, is ambiguous, or resolves
  to a standby colliding with the primary ABORTS the reconcile (fail toward NOT warming, the
  reversible state), counted on `pswatcher_standby_warm_errors_total`.

  Mutation-proved, each against the test that actually reds (#1124 review, FIX 3 — the
  first draft credited one test for guards it never reaches, and neutering those left the
  suite green): removing the "skip the primary" branch reds
  `TestReconcileStandbyWarmNeverWarmsThePrimary`; neutering the URL-collision check reds
  `TestResolveStandbyAbortsWhenStandbyURLCollidesWithThePrimary`; neutering the
  >1-candidate abort reds `TestResolveStandbyAbortsOnMoreThanOneCandidate`; making the
  write mode-aware reds `TestReconcileStandbyWarmNeverPutsSecondaryOntoAnAttachedNode`;
  making the gauge mode-blind reds `TestReconcileStandbyWarmAttachedStandbyIsNotWarm`.

  **The reconcile cannot slow failover detection.** It is deferred to the END of `Tick`, so
  it runs after every detection/promotion path has returned its verdict, and one pass is
  bounded by `PSW_WARM_DEADLINE_MS`. Run at the top of the tick (where it first landed) a
  standby wedged on its object store would hold the single control goroutine for a
  membership timeout plus a warm PUT per routed tenant, stretching the ~6 s
  `PSW_POLL_MS` × `PSW_FAIL_THRESHOLD` detection window. Deferring also makes
  "best-effort" structural rather than conventional: a deferred call cannot touch the
  tick's return values, so no warm failure can ever become failover-blocking
  (`TestStandbyWarmRunsAfterFailoverDetection`,
  `TestFailingStandbyWarmStillPromotesOnDeadPrimary`,
  `TestStandbyWarmReconcileIsDeadlineBounded`).

  No new RBAC: the loop reads the client Service selector (existing
  `services get`) and PUTs over HTTP to the pageservers. Membership uses the same live-
  verified oracle D2 added — `GET /v1/location_config` `tenant_shards` — pointed at the
  standby (`HTTPTenantMembershipAt`), never the per-tenant `GET /v1/tenant/<T>` (503s on a
  Secondary). Loss of warmth is observable per tenant (`pswatcher_standby_tenant_warm`,
  alert `PswatcherStandbyNotWarm`), and a stale attached hold has its own signal
  (`pswatcher_standby_stale_attached_total`, alert `PswatcherStandbyStaleAttached`).

  On-cluster proof is the C2/#1117 drill's job, and it now asserts the **mode**, not just
  membership: after the failover `_verify-failover-multitenant.sh` scales the ex-primary
  back up and requires it to list every routed tenant with a `null` (Secondary) location
  config within the re-arm budget. That assertion is what settles the PVC question above
  empirically — if the ex-primary returns still ATTACHED, the drill reds and says so
  rather than letting the gauge claim the plane is armed.
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
      and recorded in §5 — `GET` 404s on an unheld tenant **on the ATTACHED primary, which
      is where it was observed** (viewer corroboration valid there), `PUT` 200-attaches
      (never 404s; the promoter's 404 skip branch is dead code). Scope corrected by the
      standby re-verify below — the same GET answers `503` on a warm Secondary.
- [x] C1b (D2 round 2): the live API re-verify this ADR mandates was PERFORMED, on the
      standby this time (`szpg-f5`, `pageserver-standby-0`, tenants held as warm
      Secondaries): `GET /v1/tenant/<T>` → `503`, `GET /v1/tenant/<T>/location_config` →
      `404` despite being held, `GET /v1/location_config` → `200` listing every held shard.
      Recorded as a table in §5.
- [x] Follow-up (tech-debt, from §5) — RESOLVED (D2, see the §5 amendment): the absence
      detector is the STANDBY MEMBERSHIP ORACLE (`GET /v1/location_config` membership in
      `tenant_shards`) — NOT the per-tenant generation view, which the round-2 live
      re-verify showed `503`s on a warm Secondary and would therefore abort every failover.
      `failover()` consults it before every PUT, UNCONDITIONALLY (an unwired oracle aborts
      with `ErrNoStandbyMembership`; it never falls through to the dead PUT path), and
      feeds a not-held tenant into the unchanged `skippable()`. The
      PUT-`404`→`ErrTenantNotFound` path + `skippable()` retained as defence-in-depth.
      Wired in `cmd/pswatcher` (`SetStandbyMembershipViewer`) + asserted by
      `deploy/_validate.sh` (wiring AND endpoint); unit-tested (Secondary visible to the
      membership oracle but not the generation view, held/not-held/unreadable parsing,
      phantom-attach abort, base abort, corroborated skip, unreadable-oracle abort on a
      non-base tenant, unwired-oracle abort, all-held promote-all) and mutation-proved.
      On-cluster re-verify of the FAILOVER itself still gated by the C2 drill below.
- [ ] C2: on-cluster verification via the full multi-tenant failover drill (owned by the
      drill task, #1117) on a recovered/clean plane.
- [x] Follow-up (D1): make standby warm-Secondary registration RECONCILING rather than
      one-shot — RESOLVED. See the D1 amendment to §5 below. `pswatcher` now keeps the
      current standby warm continuously; the one-shot Job (57) remains as the deploy-time
      warm. On-cluster proof (a tenant provisioned/rebuilt after the initial warm is
      re-registered) is folded into the C2/#1117 drill.
