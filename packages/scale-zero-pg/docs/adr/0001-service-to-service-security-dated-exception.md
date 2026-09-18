# ADR-0001 (scale-zero-pg): Dated exception for gateway↔compute plaintext transport and the unauthenticated peer idle-scrape

- Status: Accepted (platform-owner/founder, 2026-09-08 — the architect sprint-8 close gate had already required this dated exception exist)
- Date: 2026-09-08
- Scope: `packages/scale-zero-pg/` (the scale-to-zero PostgreSQL wake-on-connect gateway). Module-local ADR — does not amend any main-repo ADR.
- Expiry: this exception lapses at **scale-zero-pg GA / first external-tenant use, whichever comes first** — at which point both gaps must be closed or re-justified, not silently carried.
- **Amended by ADR-0002 (2026-09-19): the F6 clause is CLOSED** — the peer idle-scrape is now
  bearer-authenticated and fail-closed by construction (`GW_PEER_TOKEN`; `/metrics.json` 401 on
  mismatch/absent). **F5 (gateway→compute plaintext transport) remains DEFERRED** with the expiry
  above intact. Read the F6 rows below as historical context for a gap that is now closed.

## Context

A read-only hardening scan of the scale-zero-pg subsystem surfaced two security gaps that the
sprint-8 close gates (architect + system-designer) asked be made **explicit and dated** rather than
left silent — `security.md`'s own standard is that a documented expectation degrades and its efficacy
is unobservable until it has already failed, so an unaddressed gap must at least be legible.

**F5 — gateway→compute hop is plaintext TCP.** Front-door TLS (client↔gateway) is implemented
(`loadTLS`, `internal/gateway/gateway.go:198`), but the gateway→compute connection is unencrypted:
`TryConnect` → `net.DialTimeout("tcp", …)` (`internal/wake/wake.go:323-324`) is the only dialer. SCRAM
auth material and all query traffic cross the pod network in cleartext. `security.md` calls for
service-to-service mTLS with "no implicit trust between pods."

**F6 — peer idle-scrape endpoint is unauthenticated.** The fleet idle decision reads peer connection
counts over plain HTTP from `http://<podIP>:<metricsPort>/metrics.json` with no auth
(`internal/gateway/peers.go:80-99`; the metrics handler serves it openly, `metrics.go:228`). An
in-namespace pod answering on that IP could bias the idle decision — report high → pin awake (cost
leak); report 0 → premature sleep. This is an **integrity gap on a decision input, not an open
mutating endpoint** (confirmed by the sprint-8 system-designer close review), so it does not cross
`security.md`'s hard line on unauthenticated mutating routes.

Both gaps require an **in-namespace foothold** to exploit, and the default NetworkPolicy is the
standing compensating control — but that control is **CNI-conditional** (flannel, which OKE GA and
OrbStack run, ships no NetworkPolicy controller, so on those clusters the policy is declarative only).
That caveat is exactly why silent reliance on it is unacceptable and this exception is dated.

## Decision

**Accept both gaps as a time-boxed exception**, on the compensating control of the internal-only
NetworkPolicy plus the requirement of an in-namespace foothold, **until the expiry above**. Record
the accepted risk here so it is observable and has a hard review date, rather than discovering it has
lapsed after a failure.

- **F5:** defer gateway→compute mTLS/TLS. Compensating control: NetworkPolicy restricts who can reach
  the compute port; no external ingress to the backend. Risk carried: an in-namespace attacker on the
  pod network can read SCRAM material + query traffic in cleartext.
- **F6:** defer authenticating the peer idle-scrape. Compensating control: same NetworkPolicy scoping;
  the endpoint is integrity-affecting (idle decision) not mutating. Risk carried: an in-namespace pod
  can bias fleet sleep/wake (a cost/availability nuisance, not data exposure).

This is a **priority-sequencing** decision (the fame-phase north star is verified-adapter status, not
DBaaS hardening), NOT a judgment that mTLS/auth are unnecessary — they are owed at the expiry.

## Options considered

| Option | Pro | Con | Verdict |
|--------|-----|-----|---------|
| **A. Dated exception now, fix at GA (this ADR)** | Legible + review-dated; no effort spent on a pre-GA data layer while the north star is compat | Risk carried until expiry; relies on CNI-conditional NetworkPolicy | **Recommended** |
| B. Fix F5 (gateway→compute mTLS) now | Closes the larger gap; matches `security.md` mTLS intent | Real design+build cost (cert distribution, rotation) on a pre-GA subsystem; diverts from the north star | Deferred to expiry |
| C. Fix F6 (peer-scrape auth) now | Cheap-ish (shared token/mTLS on the scrape) | Low severity (integrity of a cost decision, foothold-gated); still diverts | Deferred to expiry |
| D. Leave both undocumented | Zero effort | Violates the "make the gap legible / dated" standard both close gates required; degrades silently | Rejected |

## Consequences

- The two gaps are now **tracked with a hard expiry** instead of living only in a scan doc.
- Any claim that scale-zero-pg "isolates" or "encrypts" its data path MUST carry the plaintext-hop +
  CNI-conditional-NetworkPolicy caveat until F5 is closed.
- At the expiry (GA / first external tenant), F5 and F6 become blocking: close them or re-author this
  ADR with a new dated justification. A lapsed-but-uncarried exception is itself the failure mode
  `security.md` warns about.

## Action items

- [x] **Founder accepted** this exception 2026-09-08 (Status → Accepted). Risk is now formally accepted, dated, and expiry-bound.
- [x] **F6 CLOSED by ADR-0002 (2026-09-19)** — peer-scrape bearer auth, fail-closed boot, and the
      C1 reader fix (non-200 → postpone sleep) shipped.
- [ ] File a tracking issue for F5 (gateway→compute mTLS) tagged to the expiry milestone, so closure
      is scheduled, not incidental.
- [ ] At GA / first external-tenant use: re-review this ADR; close F5+F6 or re-justify.
- [ ] Keep the plaintext-hop + CNI-conditional caveat in any user-facing isolation/encryption claim.
