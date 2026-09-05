SIGN-OFF

# System-designer sign-off — PR #796 (fix/appdb-fqdn-dsn, head 4d8743e)

**Verdict: SIGN-OFF.** No invariant in `scs-zones.md` or `security.md` is violated; no
component boundary moves; the data flow is byte-identical apart from one label in a
hostname. One contract wrinkle is recorded below as a required follow-up, not a block.

## 1. Failure modes of the rooted form across the consumer path
- **Resolvers.** glibc (`__res_context_search` trailing-dot short-circuit), musl
  (`__lookup_name`'s `name[l-1]=='.'` absolute check), Go's pure resolver
  (`conf.nameList` skips search for a rooted name), and Node → `getaddrinfo` all treat
  the root label as absolute. No resolver on the path rejects it; the worst case is a
  no-op, never a NXDOMAIN.
- **Nothing SCRAM- or TLS-shaped compares the hostname.** SCRAM-SHA-256 (RFC 5802)
  hashes no host; channel binding needs TLS and every minted DSN is `sslmode=disable`
  (`provision-app.sh` create + rotate, `gen-secrets.sh`, demo, operator default). The
  gateway authorises by **role/database**, not by peer name (`internal/wake/authz.go`).
  The doc examples that use `sslmode=require` are also safe — libpq does **no** cert-name
  check below `verify-full`.
- **verify-full trap: latent, pre-existing, and explicitly deferred — correctly.**
  `gen-tls.sh` SANs stop at `…svc` (no `cluster.local` at all), so `verify-full` already
  failed for the 4-dot FQDN before this PR; the rooted form adds a second reason
  (OpenSSL's `X509_check_host` does not strip a trailing dot, unlike Go/Node). The
  `tls-san-list` deferral in `tests/rooted-cluster-hosts-repo-wide.test.ts` names exactly
  this, with an owner. Acceptable: it is not reachable from any shipped DSN today.
- **knext-side consumers hold no host-shape assumption.** `db-bind.ts` wires Secret refs
  without parsing the DSN; `pg`/`pg-connection-string` and `ioredis` are executed against
  the rooted literal in CI (`tests/rooted-host-parsers.test.ts`); `lib/pq` is proved
  byte-for-byte, including through the warm-hold `connect_timeout` rewrite.

## 2. `rotate-cred` as the sanctioned re-mint tool — side effects
- **Live connections are not disturbed.** `HoldManager` holds an already-open TCP
  connection; a Secret rewrite cannot reach it. A rotation without `--bounce` leaves the
  running compute on the old verifier, so existing sessions and holds survive.
- **Re-establishment is where it bites (uncovered).** If the hold dies (ping failure,
  operator restart, gateway rollout) after a rotation but before the compute is bounced,
  `EnsureHold` re-reads `app-db-<app>` and dials with the **new** password against a
  compute that still has the **old** verifier → dial fails, the app silently leaves the
  warm set (`appdb_warm_hold_active` drops) and retries every resync until a bounce/wake.
  `operations.md` §"Rotating an app credential" covers the *app consumer* timing but says
  nothing about the warm-hold path; the new re-mint note in `appdatabase-api.md` inherits
  that gap. Benign for the actual benchmark subject (cold tier, at 0, hand-made Secret),
  so it does not block — but a `tier: warm` app re-minted for measurement should be
  rotated with `--bounce`.

## 3. Custom-zone contract — the one wrinkle (follow-up required, not a block)
`APPDB_GATEWAY_HOST` is honoured verbatim by the operator (`gatewayHostFromEnv`, both
halves tested) and documented at `ports.go`, `83-appdb-operator.yaml` and
`appdatabase-api.md`. It is **not** honoured by `provision-app.sh`, which now hardcodes
`pggw-apps.$NS.svc.cluster.local.` at both writers, nor by `gen-secrets.sh` (`DBHOST=`).
Consequence: on a cluster with a custom `--service-dns-domain`, `rotate-cred` overwrites
an operator-minted, correctly-overridden DSN with an **unresolvable** one — the same
"silent revert on rotation" class this PR was written to kill, now pointed at the env
override. Pre-PR the clobber existed but was benign (the short `.svc` form resolves in
any zone); this PR makes it fatal in that configuration. Not blocking because no cluster
in play (OKE, kind, OrbStack, every default installer) uses a non-`cluster.local` zone
and the failure is loud at first connect. Smallest fix, for the follow-up:
`GW_HOST="${APPDB_GATEWAY_HOST:-pggw-apps.${NS}.svc.cluster.local.}"` (and
`DBHOST="${DBHOST:-…}"`), used by both writers — note this also needs
`rooted-minted-hosts.test.ts`'s position regex to accept the `:-` default position, or
its "file contains at least one gateway host" half goes red on the fix.
The repo-wide scan itself handles a legitimately-overridden install acceptably: a custom
zone, rooted or not, is matched up to `…svc.` and passes rather than false-failing.

## 4. Sovereignty & security
No new endpoint, no new mutating surface, no RBAC or NetworkPolicy delta, no cross-zone
read introduced — the change is one label inside a DSN already delivered by K8s Secret →
env. `ZONE_GATEWAY_HOST` (the cross-zone subscription/FDW conninfo) is deliberately left
alone and the deferral is asserted at three sites, so no zone starts reaching another
zone's store differently. Secrets: the two new guards read **tracked files**, never
cluster Secrets; the Go/TS fixtures use the literal `pw`; `rotate-cred` logs no password
and `cmd_create` prints `<per-app-password>`. Nothing new lands in logs. The two added
root **devDependencies** (`ioredis`, `pg-connection-string`) are outside the published
`@getknext/*` production closure, so the publish-blocking npm audit gate is unaffected.
Core-vs-app boundary untouched — this is all `packages/scale-zero-pg` plus root test
infra; nothing pushed into `packages/kn-next` or the operator.

## 5. Measurability contract
Stated in the right places for a measurer: the PR body, `appdatabase-api.md` (blockquote:
the benchmark subject is in the *unaffected* set, re-mint first), `ports.go`'s docblock,
and the guard docstrings. One dangling reference: `docs/benchmarks/cold-start-ledger.md`
does not exist on `main` yet (#795 is still open), so until it merges the citations point
at nothing — cosmetic, and self-healing on that merge.

## Failure mode the tests do not yet cover
A `tier: warm` app that is re-minted with `rotate-cred` (no `--bounce`): every consumer
half is tested, but nothing exercises hold **re-dial across a rotation**, where the
operator reads the new password from the Secret while the running compute still holds the
old verifier and the app drops out of the warm set until the next bounce or wake.
