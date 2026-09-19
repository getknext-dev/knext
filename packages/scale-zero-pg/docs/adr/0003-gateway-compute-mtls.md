# ADR-0003 (scale-zero-pg): Gateway→compute mTLS via in-protocol Postgres TLS (F5)

- Status: Accepted (design; phased implementation)
- Date: 2026-09-19
- Scope: `packages/scale-zero-pg/` (the wake-on-connect gateway + the Neon compute
  plane). Module-local ADR. Does **not** amend any main-repo ADR — the operator
  remains the single writer of cluster state (main-repo ADR-0001 upheld: this adds
  cert-manager CRs + Postgres TLS config, no new gateway cluster-write surface).
- Amends: **ADR-0001 (scale-zero-pg)** — the **F5 clause moves from DEFERRED to
  CLOSING (phased, this ADR)**. F5 is **not** fully CLOSED until the phase-3/4 merge
  lands (gateway requires TLS + compute enforces `clientcert=verify-full`); the
  ADR-0001 expiry text stays intact until then.

## Context

ADR-0001 accepted two security gaps as a dated exception. **F6** was closed by
ADR-0002 (peer-scrape bearer auth). **F5** — the gateway→compute hop is plaintext
TCP — remained deferred. The gateway is the only always-on component on the
connection path; front-door TLS (client↔gateway) exists (`loadTLS`,
`internal/gateway/gateway.go`), but the backend leg is unencrypted: `TryConnect` →
`net.DialTimeout("tcp", …)` (`internal/wake/wake.go`) is the only dialer, so SCRAM
auth material and all query traffic cross the pod network in cleartext.
`security.md` calls for service-to-service **mTLS** with "no implicit trust between
pods."

The compensating control ADR-0001 leaned on (the default NetworkPolicy) is
**CNI-conditional** — flannel (OKE GA, OrbStack) ships no NetworkPolicy controller,
so on those clusters the policy is declarative only. That is exactly why the
exception is dated and why F5 is owed at GA.

This ADR records the design the architect + system-designer gates signed off, and
the **phased** rollout that makes it safe to land incrementally.

## Decision

Close F5 with **in-protocol Postgres mTLS on the gateway→compute leg**:

- The gateway, acting as a Postgres **client** re-originating to the compute, sends
  the Postgres `SSLRequest`, requires `'S'`, then `tls.Client(conn, cfg)` and
  proceeds with SCRAM + query proxying over the TLS conn.
- The compute serves TLS (`ssl=on` + a server cert), and its `pg_hba.conf` tightens
  to `hostssl … clientcert=verify-full` to **require + verify** the gateway's client
  cert (the mTLS enforcement).
- Certificates come from **cert-manager**: a self-signed Issuer → a CA `Certificate`
  (`isCA: true`) → a CA `Issuer` → two **shared** role leaves (a compute-server cert,
  a gateway-client cert), finite-duration and auto-rotated. The CA Secret is both the
  gateway's `RootCAs` and the compute's `ssl_ca_file`.

**cert-manager over an extended `gen-tls.sh`.** The compute fleet scales 0↔N and is
ephemeral; a hand-minted CA cannot track rotation across it. The knext operator
already depends on cert-manager (its webhook cert), so a cluster running the unified
platform already has the cert-manager.io CRDs + controller — this introduces that
dependency to scale-zero-pg's own `deploy/`, which the gates approved.

**Shared certs, not per-compute (D3).** The computes are fungible replicas of one
logical service per system, mirroring the existing shared `pggw-tls` front-door
pattern. One compute-server cert (SANs covering the compute Service DNS) is mounted
into every compute pod; one gateway-client cert is mounted into every gateway pod.

### Why NOT a service mesh (architect condition, recorded explicitly)

`security.md` names "mTLS via mesh later." A mesh (Istio/Linkerd sidecar) is
**rejected here** because a sidecar injected on every 0→1 compute wake taxes the
measured ~sub-second cold-start goal that is scale-zero-pg's whole reason to exist —
the sidecar must start, join the mesh, and establish its own TLS before the compute
can serve a query, on the critical wake path. In-protocol Postgres TLS adds a single
TLS handshake to an already-existing dial, no extra pod, no extra process on the wake
path. A mesh can still layer on later for the always-on storage plane; it is the
wrong tool for the scale-to-zero compute leg.

## Options considered

| Option | Pro | Con | Verdict |
|--------|-----|-----|---------|
| **A. In-protocol Postgres mTLS (this ADR)** — SSLRequest→`tls.Client` on the gateway; compute `ssl=on` + `hostssl clientcert=verify-full`; cert-manager CA + shared server/client leaves | Full `security.md` intent (encrypt + verify both ends); one TLS handshake on an existing dial, **no wake-path tax**; reuses cert-manager the platform already runs; auto-rotation across the 0↔N fleet | Real cert-distribution + proxy SSL-negotiation work; a strict phase ordering to avoid breaking live plaintext computes | **Chosen** |
| B. Service-mesh mTLS (Istio/Linkerd) | Transparent to app code; org-standard mTLS; strong per-pod identity | A sidecar on every 0→1 wake **taxes the sub-second cold-start goal** (extra pod + mesh-join + its own TLS on the critical path); heavy new dependency for a pre-GA data layer | Rejected — wrong tool for the scale-to-zero leg (see above) |
| C. One-way TLS (compute server cert; gateway `sslmode=require`, no CA/client verify) | Closes the *confidentiality* half cheaply (SCRAM + queries no longer cleartext) | Does NOT satisfy "no implicit trust" — any pod could impersonate the compute; the gateway verifies nothing; re-opens the argument at GA | Rejected — would re-owe the work |
| D. Plaintext status quo (the dated exception) | Zero effort | The gap ADR-0001 dated; SCRAM material + queries cleartext on a CNI-conditionally-isolated network | The expiring exception — replaced by this ADR at GA |

## The 4-phase migration plan

The compute must accept TLS **before** the gateway requires it, or every connection
breaks. Each phase is an independently safe, revertible PR.

- **Phase 1 (this PR) — cert infrastructure + docs ONLY.** Ship the cert-manager CA
  bootstrap + the two leaf `Certificate`s (`deploy/11-mtls-certs.yaml`), the
  fail-closed `_validate.sh` contract, this ADR, and the operations.md prereq note.
  **No Go code; nothing consumes the certs yet.** Reverting is deleting a manifest.
- **Phase 2 — compute serves TLS, pg_hba still allows plaintext.** Set `ssl=on` +
  `ssl_cert_file`/`ssl_key_file`/`ssl_ca_file` via the compute_ctl GUC channel
  (`config.json` `spec.cluster.settings`), mount `pggw-compute-server-tls` + the CA.
  Leave `pg_hba` as `host` (still accepts plaintext) so an un-migrated gateway keeps
  working. Gateway unchanged (still plaintext).
- **Phase 3 — gateway requires TLS.** The gateway wraps the backend dial in
  `tls.Client` (`GW_COMPUTE_TLS=true`, fail-closed default in shipped manifests) and
  verifies the compute server cert against the CA. **HARD ORDERING GATE below.**
- **Phase 4 — compute enforces `clientcert=verify-full`.** Extend `lib-harden.sh`'s
  pg_hba post-processor to rewrite the network catch-all `host`→`hostssl …
  clientcert=verify-full`, so the compute REQUIRES + verifies the gateway client
  cert. This is the mTLS enforcement; on its merge F5 is fully CLOSED and ADR-0001 is
  amended to CLOSED + the main-repo CLAUDE.md §7 dated-exception is updated.

### Hard ordering requirement (architect condition) — phase 2 → phase 3 gate

**Phase 3 (gateway requires TLS) must NOT advance until phase 1+2 reach 100% fleet
coverage, INCLUDING already-running pre-phase-1 computes.** The compute Deployment
uses the `Recreate` strategy and scales 0↔N, so a compute that was **already awake**
before phase 2 rolled out keeps serving **plaintext** (its pod predates the `ssl=on`
config) until it is recreated. If the gateway flips to require-TLS while such a pod is
live, that database breaks — the gateway sends `SSLRequest`, the old compute replies
`'N'`, and (fail-closed) the connection is refused.

The phase-2→3 gate is therefore: **drain / recreate every live compute** (scale the
awake computes to 0 and let them respawn on the next wake with the TLS config, or wait
a full idle cycle so the whole fleet has scaled to zero and back at least once) before
flipping any gateway to `GW_COMPUTE_TLS=true`. Verify no pre-phase-2 compute pod
remains (`kubectl get pods` age vs the phase-2 rollout time) as the explicit gate.

## Conditions carried forward (action items for phases 2-4)

Recorded now so the later PRs implement them, from both gates:

- **Fail-closed on `'N'` (mutation-proved).** Once `GW_COMPUTE_TLS=true`, a compute
  replying `'N'` to `SSLRequest` (TLS not enabled on that pod) MUST fail closed —
  refuse, surface a clear error — NEVER silently fall back to plaintext (that would
  defeat the control). Guard with a mutation-proved test.
- **Cold-wake TLS-handshake failure is RETRYABLE (solved for free by TryConnect).** A
  compute just waking may not have mounted its cert yet; the TLS dial fails. The wrap
  goes inside `TryConnect`, whose existing wake retry/singleflight already treats a
  failed dial as retryable — so a handshake failure is retried, not fatal. Verify the
  wrap sits inside the retry, not around it.
- **Gateway client cert via `GetClientCertificate`, not read-once-at-boot.** Load the
  client keypair through `tls.Config.GetClientCertificate` (re-read on each handshake)
  so a cert-manager rotation does not require a gateway restart and an expiry does not
  cause an outage. (The front-door `loadTLS` is read-once; the backend path must not
  copy that.)
- **Backend `tls.Config` parity.** `MinVersion: TLS12` + `RootCAs` (the CA) +
  `ServerName` (the compute Service DNS being dialled) + `Certificates`/
  `GetClientCertificate` — all four, or the verification is incomplete.
- **pg_hba first-match keeps loopback `cloud_admin` plaintext.** The
  `clientcert=verify-full` rewrite applies to the **network** catch-all only; the
  existing loopback `cloud_admin` line (pod-local SCRAM material path) must stay a
  plaintext local rule ABOVE it, since pg_hba is first-match.
- **Cold-wake identity-enforcement window.** `harden_pg_hba` runs **async** after the
  compute boots, so `clientcert` is not enforced until the reload lands — there is a
  brief window on a fresh wake where the compute serves TLS but has not yet tightened
  pg_hba. Test + document this window; it is an availability-safe gap (TLS is already
  on; only client-cert *enforcement* lags), not a plaintext window.
- **Compute Postgres SSL is a boot-time restart, not a reload.** `ssl=on` is set via
  the compute_ctl GUC list at boot (compute_ctl restarts Postgres), which the
  Recreate + 0↔N model satisfies for free. Confirm the shipped Neon compute image was
  built with OpenSSL (stock Postgres, near-certain) as a cheap on-cluster check.

## Consequences

- **ADR-0001 F5 is CLOSING (phased), not yet closed.** Any claim that scale-zero-pg
  "encrypts" or "isolates" its data path MUST keep the plaintext-hop +
  CNI-conditional-NetworkPolicy caveat until phase 3/4 merges. The main-repo CLAUDE.md
  §7 dated-exception update happens then, not now.
- **cert-manager is a new deploy-time dependency** for scale-zero-pg. A cluster
  without it cannot apply `deploy/11-mtls-certs.yaml`; that is deliberate fail-closed
  behaviour — absent cert infra must never fall through to a phase that runs
  plaintext. `_validate.sh` asserts the CA Issuer + both leaf Secrets exist when
  cert-manager is present.
- **Auto-rotation replaces manual `gen-tls.sh` for this leg.** Finite `duration` +
  `renewBefore` on the leaves mean cert-manager reissues + re-mounts across the
  ephemeral fleet without operator action — the reliability win the manual path could
  not offer.
- **No main-repo ADR change.** The gateway gains no new cluster-write surface; it
  mounts Secrets and dials TLS. The operator remains the single writer.

## Action items

- [x] **Phase 1:** cert-manager CA + shared server/client leaf `Certificate`s
      (`deploy/11-mtls-certs.yaml`); fail-closed `_validate.sh` contract; this ADR;
      operations.md prereq note. **No Go code.**
- [x] **Phase 2:** compute `ssl=on` + server cert/CA via the compute_ctl GUC channel;
      mount `pggw-compute-server-tls` + the CA; pg_hba stays `host` (plaintext still
      allowed). Confirm the Neon image has OpenSSL. **Shipped:** four ssl GUCs
      (`ssl`/`ssl_cert_file`/`ssl_key_file`/`ssl_ca_file`) in `config.json`
      `spec.cluster.settings`; both Secrets mounted at `/etc/pggw-compute-server-tls`
      + `/etc/pggw-mtls-ca` (CA projects `ca.crt` only — the CA private key never
      reaches compute pods) on all four compute manifests (20/25/26/template); the
      server key is staged to a `0600` postgres-owned path by `lib-harden.sh`
      `stage_tls_key` before `compute_ctl` boots (Postgres rejects a group/world-
      readable key), needing NO securityContext change. Certless dev clusters keep
      booting plaintext (`optional` mounts + GUC strip). `_validate.sh` contract 34
      guards GUC↔mount path parity, the key perms, and that pg_hba is untouched. The
      live `sslmode=require` proof is lead-owned OKE/kind verification.
- [ ] **Phase 2→3 GATE (OPERATIONAL, still open):** drain/recreate every live
      pre-phase-2 compute (or wait a full idle cycle) so 100% of the fleet serves TLS
      before any gateway flips. **The phase-3 CODE default has flipped to
      `GW_COMPUTE_TLS=true`; the ROLLOUT has not.** Shipping the secure value as the
      default is fail-closed by construction (a manifest that forgets the knob is
      encrypted, not plaintext) — it does NOT license rolling the new gateway image
      onto a fleet that still has pre-phase-2 computes awake. Before rolling: scale
      every awake compute to 0 (or wait a full idle cycle) so it respawns with the
      phase-2 TLS config under the `Recreate` strategy, then verify no compute pod
      predates the phase-2 rollout (`kubectl get pods` age vs. that rollout time). A
      compute that predates it answers `'N'` and is REFUSED — that is the control
      working, and `GW_COMPUTE_TLS=false` is the documented dev/rollback safety valve.
- [x] **Phase 3:** gateway wraps the backend dial in `tls.Client`
      (`GW_COMPUTE_TLS=true` fail-closed default); `GetClientCertificate`; full
      backend `tls.Config` (MinVersion/RootCAs/ServerName/Certificates); fail-closed
      on `'N'` (mutation-proved); handshake retry verified inside `TryConnect`.
      **Shipped:** `internal/wake/backendtls.go` — `TryConnectTLS` dials, sets
      `TCP_NODELAY` on the RAW socket *before* the wrap, sends `proto.BuildSSLRequest()`,
      and on `'S'` runs the `tls.Client` handshake; `TryConnect` is now the plaintext
      wrapper over it and `ConnectWithWake` passes `Opts.BackendTLS` on BOTH legs (warm
      fast path + cold-wake poll), so a handshake failure is retried by the existing
      wake loop rather than being fatal. Distinct sentinels keep the classes apart
      (`ErrBackendTLSUnavailable` vs `ErrBackendDialFailed`). The client keypair is
      read inside `GetClientCertificate` (per handshake, rotation-safe), the CA per
      dial; `ServerName` defaults to the dialled compute Service DNS and stays
      UNROOTED (crypto/x509 trims a trailing dot from the candidate name, so an
      unrooted SAN matches a rooted dial host). Both gateway manifests mount
      `pggw-gateway-client-tls` + `pggw-mtls-ca` (ca.crt only — the CA private key
      never reaches a gateway pod) and carry the four env vars; `_validate.sh`
      contract 35 guards env↔mount path parity and `GW_COMPUTE_TLS=true`. Tests:
      `internal/wake/backendtls_test.go` + `internal/gateway/backendtls_wiring_test.go`.
      The live proof (wake over TLS on OKE/kind) is lead-owned.
- [ ] **Phase 4:** `lib-harden.sh` rewrites the network pg_hba catch-all to `hostssl …
      clientcert=verify-full` (loopback `cloud_admin` plaintext kept above); test +
      document the async cold-wake enforcement window. On merge: mark ADR-0001 F5
      **CLOSED**, update main-repo CLAUDE.md §7.
