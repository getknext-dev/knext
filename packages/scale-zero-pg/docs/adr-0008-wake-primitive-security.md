# ADR-0008 — Wake-primitive security: the wake is a bounded, observable shared-plane property, not a pre-authenticated one

- **Status: ACCEPTED — owner-ratified 2026-07-12** (was PROPOSED 2026-07-07). The
  layered model (B ship-now rate-limit/budget/alert + C NetworkPolicy via #118) is
  the ratified wake-primitive tenant-isolation answer; Option A (pre-auth) stays
  rejected. **Ratification note:** the entire consequence set has SHIPPED — the
  per-app wake budget + `53400` refusal + `WakeBudgetExceeded` alert (#116), the
  wake-budget review (#165), the alert debounce (#184), and the residual accepted &
  documented (#158, the md5 cold-wake downgrade window — see docs/operations.md
  "Accepted residual: md5 cold-wake downgrade window (#158)"). This flip ratifies
  what already shipped; the decision below is unchanged. Closes the design half of
  issue #116 (unauthenticated wake side-channel). Decides HOW the wake primitive is secured
  now that the #112 data-plane superuser bypass is fixed: **not** by making the
  gateway authenticate before waking (rejected — see §Decision), but by a
  **layered control** — a per-app wake **rate-limit + budget + alert** shipped now
  (CNI-independent), paired with a **NetworkPolicy** second layer that lands with a
  policy-capable CNI (#118, documented here, not implemented here).
- **Date:** 2026-07-07
- **Deciders:** architecture owner (to ratify); design by the scale-zero-pg lane.
- **Source:** v1.0.0 principal-architect release review — the residue of the #112
  attack chain, listed as a *known, documented, non-blocking* item in the v1.0.0
  release notes but with no tracked issue until #116.
- **Relates to:** #112 (CRITICAL gateway-bypass superuser — FIXED, the pg_hba
  `cloud_admin` TCP-reject); #115 (the security-review fixes bundle); #117 (md5 →
  SCRAM-SHA-256 — reinforces that the compute, not the gateway, verifies auth);
  #118 (ship a policy-capable CNI so `apps-compute-ingress` actually enforces — the
  network layer of this ADR); #74 (the apps-gateway `(user,database)` pre-wake
  authz); #92 (the existence-oracle / uniform-refusal hardening); ADR-0003
  (branch-per-app: template timeline, per-app compute, apps-gateway `template`
  routing); CLAUDE.md **rule 5** (don't rebuild what Neon gives free — the gateway
  holds no credentials by design).

---

## THE DECISION (RATIFIED 2026-07-12 — read first)

> **RATIFIED.** The owner accepted the layered model on 2026-07-12; the text below
> is retained as the decision record. Everything it decided has shipped (#116/#165/#184)
> and the residual is accepted & documented (#158).

**Ratify the layered model as the wake-primitive tenant-isolation answer — vs
demanding full pre-authentication before wake.**

This ADR asserts that on a shared plane where the gateway holds **no tenant
credentials by design** (rule 5, reinforced by #117), the honest and correct
control for the wake primitive is:

- **(B) SHIP NOW — per-app wake rate-limit + budget + alert (CNI-independent).** A
  foreign/unauthenticated in-cluster pod can still *wake* a sleeping app (the
  wake-on-connect UX is the product), but **cannot cheaply or repeatedly exceed a
  per-app wake budget** — the excess is refused without scaling, and an anomalous
  per-app wake rate **pages**. This bounds the blast radius of the side-channel to
  a rate the plane already tolerates and makes abuse loud.
- **(C) PAIR — NetworkPolicy `apps-compute-ingress`/`pggw-apps` ingress (via #118).**
  Restrict who can even *reach* the apps-gateway to authorized app namespaces/pods,
  removing cross-tenant network reachability entirely. This depends on a
  policy-capable CNI (kube-flannel enforces none — #114/#118) and is therefore
  **documented here, implemented in #118**, not in this change.

**The residual, stated honestly:** an **authorized, in-budget** caller (or any pod
that can reach `pggw-apps` until #118 lands) can still *trigger* wakes. The wake is
**bounded and observable, not prevented.** This is an accepted shared-plane
property, not a defect — the alternative (pre-auth, Option A below) trades a
*confidentiality* property the platform does not need here for the *denial/cost*
property it does, at the cost of the gateway's no-credentials design.

**Owner call (settled 2026-07-12):** accepted (B now + C via #118) as the
wake-primitive isolation model; Option A (full pre-authentication) stays rejected.

---

## Context

### What the wake primitive is
The apps-gateway (`pggw-apps`, ADR-0003 `template` mode) is a wake-on-connect
Postgres proxy. On a client startup packet it:

1. parses the `(user, database)` from the StartupMessage;
2. **authorizes the pair** (#74: `user` must be `app_<database>`, `database` must
   not be reserved, must be a valid label) — a clean uniform `28P01` on failure,
   **no wake** (#92);
3. resolves `compute-<database>` and, if asleep, **scales it 0→1** via the k8s API;
4. replays the startup and becomes a dumb byte pipe. **Auth (SCRAM/md5) is verified
   by the compute, never by the gateway.**

### The gap (issue #116)
Step 2 gates the *routing*, but a **syntactically-valid** pair — `user=app_<app>`,
`database=<app>` — passes it **before any password is checked**, and step 3 then
wakes `compute-<app>`. So an unauthenticated in-cluster actor who knows (or guesses)
an app name can **force-wake any tenant's compute at will**:

- **cost / DoS / noisy-neighbour** on the shared plane (repeated 0→1 churn burns
  compute-start cost and storage-plane attach work), and
- it was the *enabling first step* of the #112 gateway-bypass chain (wake the
  target, then dial `compute:55433` directly as `cloud_admin`). **The second step is
  now closed** by the #112 pg_hba `cloud_admin`-loopback-reject (CNI-independent).

Post-#112 this is a **denial/cost side-channel, not a data-confidentiality break.**
But "any pod can wake any tenant" is inconsistent with the GA tenant-isolation
claim, so it must be bounded and observable.

### Why the gateway holds no credentials (the constraint that shapes the decision)
By deliberate design (CLAUDE.md rule 5; reinforced by #117 moving auth to
SCRAM-SHA-256 verified *by the compute*), the gateway is a **credential-free byte
pipe** after the handshake. It does not, and must not, hold per-app passwords or
verifiers. This is what keeps the gateway small, stateless, rotation-free, and out
of the tenant-secret blast radius. Any control that requires the gateway to *verify*
a tenant credential before waking undoes that property.

### Blast radius that already bounds the side-channel
Even before this ADR, the damage an attacker can do via the wake primitive is
bounded by controls that already ship:

- **`GW_MAX_CONNS`** (90 per app on `pggw-apps`, 81-apps-gateway.yaml) — caps
  concurrent connections per compute; a connection storm is refused `53300`, not
  turned into unbounded goroutines/wakes.
- **Tenant CPU/memory quotas** and the per-app compute's own `resources` — a woken
  compute cannot starve the node.
- **`GW_IDLE_MS`** — a force-woken idle compute scales back to zero on its own,
  so the *steady-state* cost of a one-shot wake is transient.
- **#74 pre-wake authz + #92 uniform refusal** — a *malformed* / *cross-app* /
  *reserved* / *cloud_admin* startup is refused with **no wake at all** and no
  existence oracle. Only a *well-formed pair for a real app name* reaches the wake.

What was missing: a bound on the **rate** at which well-formed startups can force
wakes, and an **alarm** when that rate is anomalous. That is what (B) adds.

---

## Decision (proposed)

### Rejected — Option A: fully authenticate before wake (gateway as credential holder)
Make the gateway verify a tenant credential (a per-app password/verifier, or a
per-app wake token it must store and check) before scaling 0→1.

**Rejected**, because:

1. **It undoes the gateway's no-credentials design (rule 5, #117).** The gateway
   would become a per-app credential/verifier holder — new secret-distribution,
   rotation, and blast-radius surface, exactly what keeping auth *in the compute*
   avoids. A gateway compromise would then leak tenant auth material it currently
   never touches.
2. **It buys the wrong property.** Pre-auth defends *confidentiality* of the wake
   (only the holder can wake). But post-#112 the threat is **denial/cost**, not
   confidentiality — the woken compute still enforces SCRAM itself, so a wake alone
   grants **no data access**. We would pay a large architectural cost to convert a
   cost/DoS bound (which a rate-limit gives cheaply) into a confidentiality bound we
   do not need.
3. **A wake token is still a shared secret on the plane.** Any scheme cheap enough
   to not be full SCRAM (a static per-app wake token) is itself force-multipliable
   and distribution-coupled — it recreates the #112 shared-credential shape one
   layer up.

### Adopted — the LAYERED control

**(B) SHIP NOW — per-app wake rate-limit + budget + alert (CNI-independent).**
A **token-bucket per compute key** (`compute-<app>` in template mode → genuinely
per-tenant) on the wake primitive:

- Each app gets `GW_WAKE_BUDGET` **burst** wakes that **refill over
  `GW_WAKE_WINDOW_MS`** (default **15 / 60 000 ms** on `pggw-apps`).
- A wake is consulted **only when the compute is actually asleep** — a warm app
  answers `TryConnect` and is **never gated**, so the wake-on-connect UX and
  cold-wake latency are unchanged for legitimate traffic.
- When an app **exceeds its budget**, the gateway **refuses to scale**: a clean,
  transient **`53400`** ("wake rate limit exceeded; retry shortly") is returned and
  the compute is **not touched**. A burst therefore **cannot force unbounded 0→1
  churn** — it is capped at the budget.
- The refusal is counted — `pggw_wake_budget_exceeded_total` (fleet) and
  `pggw_system_wake_budget_exceeded_total{system=<app>}` (per-tenant, names the
  source) — **distinct from a wake *failure*** (a real cold-start error), so the two
  never share an alert.
- **`WakeBudgetExceeded`** (deploy/60, `plane: apps`) **pages** on a sustained
  per-app breach — the signature of the side-channel being exercised.

Chosen numbers: a real app wakes **once** on the first visitor, then stays warm for
`GW_IDLE_MS` — its sustained wake rate is far below 1/window. `15 / 60 s` leaves
generous headroom for a legitimate **reconnect storm** (an app-pod restart
reconnecting), while capping a malicious loop to ~**1 wake / 4 s** sustained instead
of unbounded. Tunable per `docs/operations.md` "Wake budget & wake side-channel
(issue #116)".

**(C) PAIR — NetworkPolicy (via #118, documented not implemented).**
Restrict `pggw-apps` ingress (and `compute-<app>:55433`) to authorized app
namespaces/pods, so a foreign pod **cannot even reach** the wake front door. This is
the network layer that removes cross-tenant *reachability* rather than *rate-limiting*
it. It **requires a policy-capable CNI** — kube-flannel on the GA cluster enforces no
NetworkPolicy (#114), so `apps-compute-ingress` is currently *defined but inert*.
Shipping/enforcing it is the scope of **#118** (infra-risk CNI swap), cross-referenced
here; this ADR does **not** implement it.

### Why B before C
(B) is **CNI-independent** and ships today with zero infra risk; it bounds the
*cost/DoS* threat immediately and makes abuse observable. (C) is strictly stronger
(reachability, not just rate) but is gated on an infra change (#118) with its own
risk/sequencing. Layering them means the plane is **defended now** and **defended in
depth later** — no single control (and no single regression) re-opens the whole
boundary.

---

## The residual (stated plainly)

Under the adopted model, the following remain TRUE and ACCEPTED:

- An **authorized, in-budget** caller can trigger wakes (that is the product).
- Until #118 lands, **any pod that can reach `pggw-apps`** can trigger up to the
  budget of wakes per app per window — bounded and alerted, **not prevented**.
- The `53400` budget refusal is returned **after** the #74 pre-wake authz passes, so
  it only ever reaches a caller targeting a **well-formed, real** app — a caller who,
  by definition, already caused (and observed) the wakes that tripped the budget. It
  is therefore **not a new existence oracle** beyond what #92 already accounts for,
  and it shares the apps-gateway constant-floor refusal delay.

This is the honest tenant-isolation posture of the wake primitive on a shared
scale-to-zero plane: **bounded + observable, layered toward reachability-removal via
#118** — not a pre-authenticated wake.

---

## Consequences & follow-ups

- **Positive:** the #116 cost/DoS side-channel is bounded and observable today, with
  no change to the gateway's no-credentials design, no new secret surface, and no
  regression to cold-wake UX. Per-app keying means one hostile tenant cannot starve
  another's wake budget.
- **Negative / accepted:** the wake is still *triggerable* by any reachable pod
  until #118; the budget is a rate bound, not an identity bound. Documented above.
- **Per-replica enforcement (accepted).** Each gateway pod runs its own in-memory
  token bucket (no cross-fleet coordination, mirroring nothing of the peer-idle
  checker), and connections load-balance across replicas — so the effective per-app
  ceiling before refusals begin is `GW_WAKE_BUDGET × replicas` (30 at 15×2 today).
  This is still a hard bound (not unbounded churn) and still alerted in aggregate;
  it just means the knob is "per replica." Tighten by lowering `GW_WAKE_BUDGET`, and
  size it against the replica count. A fleet-shared bucket (Redis/peer-gossip) is a
  possible follow-up if a tighter global ceiling is ever required — deliberately not
  built now (it would add coordination + a dependency for a cost/DoS bound the
  per-replica budget already delivers).
- **Follow-up #118 (network layer):** ship/enforce a policy-capable CNI so
  `apps-compute-ingress` and a `pggw-apps` ingress policy actually restrict
  reachability; upgrade `_verify-netpol.sh` to assert a foreign pod is
  *network*-blocked. On completion, update this ADR's residual (reachability closed
  for the reference platform).
- **Tuning:** `GW_WAKE_BUDGET` / `GW_WAKE_WINDOW_MS` are per-plane knobs
  (docs/operations.md). If legitimate reconnect storms trip the alert, raise the
  budget; if abuse is seen, lower it — the metric names the offending app.

---

## Evidence (live drill)

`deploy/_verify-wake-guard.sh` proves the control on OKE (context
`context-ckmva7v7zvq`, ns `scale-zero-pg`) against a throwaway `wgapp` branch:

1. **No regression** — a legitimate single wake through `pggw-apps` (valid creds)
   still cold-starts the sleeping app and returns a row.
2. **Budget cap** — an **unauthenticated** parallel burst of `(budget + EXCESS)`
   startups for one sleeping app is capped: at most `GW_WAKE_BUDGET` wakes, the
   excess refused `53400`; `compute-<app>` never exceeds one replica; the gateway
   logs the refusals.
3. **Observable** — `pggw_wake_budget_exceeded_total{gateway="pggw-apps"}` rises and
   the **`WakeBudgetExceeded`** alert reaches **firing** in alertmanager.

Numbers recorded in `docs/BENCHMARKS.md`.
