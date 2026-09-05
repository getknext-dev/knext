APPROVE  <!-- final verdict, round 3 @ 4d8743e. Rounds 1 and 2 were ISSUES_FOUND — history preserved below. -->

# Code review — PR #796 (root the minted-DSN gateway host)

Reviewed in worktree `agent-a6bb3259f2a40347c`. Read the full changed files, not just the diff.
`go test ./...` (10 pkgs), `gofmt -l`, `go vet` — all clean. No secrets, no new endpoint, no `:latest`,
no shell interpolation added. The DNS claim itself **holds** (see §DNS below).

## Issues

1. **`packages/scale-zero-pg/deploy/provision-app.sh:169` and `:609` — the OTHER minting path for
   the SAME app-consumed Secret still writes the short, unrooted host** (`pggw-apps.$NS.svc`).
   `:609` is `rotate-cred`, which **overwrites `app-db-<app>`'s `DATABASE_URL` in place** — so an app
   the operator minted with the rooted DSN silently **reverts** to the search-walking host on the next
   credential rotation. `:169` is the script `create` path, which the appdb reconciler itself
   acknowledges as live ("Secrets … minted by provision-app.sh", reconcile.go step 3a). Why it
   matters: the fix is one of two writers, the PR's own "scan, don't enumerate" guard scans only
   `83-appdb-operator.yaml`, and no test covers the script — so the exact regression this PR exists to
   prevent has an unguarded path back in. (Also `demo/manifests/10-database-secret.yaml:20` and
   `demo/README.md:96`, lower blast radius.)

2. **`gateway/internal/appdb/ports.go:157-162`, `deploy/83-appdb-operator.yaml:134-136`,
   `deploy/_validate.sh:495-498`, `docs/appdatabase-api.md:192-197` — the ndots arithmetic in every
   shipped artifact contradicts the live measurement in sibling PR #795 and in this PR's own body.**
   The artifacts say **3-entry** search path / **3 attempts** / **6 queries**; #795's live
   `resolv.conf` (and #796's PR description) say **five-entry** (standard three + two OCI VCN
   domains) / **5 attempts** / **10 queries**, two of which leave the cluster. Separately,
   `"pggw-apps.scale-zero-pg.svc"` is labelled **"(3 dots)"** — it has **2**, wrong under either
   story. Why it matters: the durable artifact a maintainer reads carries the unmeasured textbook
   number and understates the win ~40%, while the ephemeral PR body carries the measured one — the
   inverse of where the truth should live, and the "re-read your claims against the tree" rule.

3. **`gateway/cmd/zone-operator/main.go:74` + `deploy/87-zone-operator.yaml:118` — the deliberate
   `ZONE_GATEWAY_HOST` deferral is stated only in the PR body / impl report, nowhere in the tree.**
   Two operators now disagree on the same gateway name with no in-tree note. (The deferral itself is
   sound — verified: `internal/zone/sql.go:175 conninfo()` is embedded in `CREATE SUBSCRIPTION`/FDW
   and resolved by the **compute's** libpq, a genuinely different consumer.) Why it matters: the next
   reader "fixes the inconsistency" in either direction without knowing which was intended.

4. **`gateway/internal/appdb/ports.go:174-175` — "proved at runtime by the OKE verification" is
   written in the present tense for a run that has not happened** (impl report §6: "Not run: kind /
   OKE"). Why it matters: a code comment asserting evidence that does not exist is how an unverified
   claim becomes load-bearing later.

5. **`deploy/_validate.sh:499-502` — the new manifest contract cannot be reached by a full run.**
   The script's earlier dry-run loop (`for f in [0-9][0-9]-*.yaml`, :58) dies on
   `88-loadsoak-k6.yaml` (kubectl YAML parse, ~line 50), and `_validate.sh` is not invoked by any
   `.github/workflows`. Cause is pre-existing and correctly noted by the author, but the net effect is
   that this PR's only deploy-side guard has never executed in situ. I lifted the three lines and
   mutation-proved them standalone: **PASS** on the real manifest; **FAIL** on short host, on the
   unrooted 4-dot form, and on the env var removed entirely. Logic is sound; reachability is not.

6. Nit — `gateway/internal/appdb/gatewayhost_test.go:26` (`strings.Count(host,".") < 5`) encodes a
   slightly wrong model: a rooted *short* name (`pggw-apps.scale-zero-pg.svc.`) is absolute and
   correct yet fails this assert; the `HasSuffix(".")` check two lines up already carries the
   invariant. Harmless today, misleading later.

## DNS claim — checked, holds

Trailing dot suppresses the search walk in every resolver that matters here: glibc `res_search`
(trailing dot ⇒ tried absolute only), **musl** `__lookup_name` (suppresses search when the name ends
in `.`, and does honour `options ndots`), Go's `nameList` (rooted ⇒ single name, so the operator's own
`lib/pq → net.Dialer` hold path does not re-append), Node/libuv → `getaddrinfo` → same libc. `lib/pq`
carries the root label byte-for-byte (proved by the PR's own test, re-run green). One nuance the
comment misses: musl issues A+AAAA in parallel, so the *saving* on an alpine app image is smaller than
the sequential-query arithmetic implies.
**Postgres surfaces are clean:** every minted DSN carries `sslmode=disable`, so no cert-name or SCRAM
channel-binding comparison is in play (channel binding requires TLS; SCRAM never hashes the host).
Informational: `deploy/gen-tls.sh:48` SANs stop at `pggw-apps.scale-zero-pg.svc`, so anyone flipping
to `verify-full` mismatches the rooted host (OpenSSL's `X509_check_host` does not strip a trailing
dot) — already broken for the 4-dot FQDN pre-PR, but now one step further from the SAN list.

## Mutation re-run (independent, anchor-asserting, exit-code only — never output-grep)

Baseline green first (`rc=0`), each anchor asserted to occur **exactly once** or abort, restore via
`git checkout --` between runs, tree verified clean after. All **RED**:
unrooted 4-dot default (the defect the brief itself contained) · short 2-dot default · `main.go`
hardcodes short, ignoring the const · env override auto-rooted instead of verbatim · mint path
(`reconcile.go:92`) bypasses `d.GatewayHost` · manifest loses the dot · manifest env removed.
The 4-dot pin is real, not decorative.

## Test quality

Strong for what it covers — assertions run through the real mint path and the derived RO key, both
halves of the env override (verbatim, including a deliberately-unrooted and an IP value), and a real
consumer proof via `pq.ParseURL` rather than a mock; nothing tautological and nothing weakened
(`reconcile_test.go:252`'s old short host is a pre-existing harness default the new test overrides
explicitly). The gap is coverage, not rigour: **no test touches `provision-app.sh`**, which is where
issue 1 lives.

---

# Round 2 — verified at `11ba6c5` (`ca6be8b` red → `11ba6c5` green)

**Verdict: ISSUES_FOUND** (two residuals, both minor; one is a one-line guard fix. Round 1's
blocker is genuinely gone.)

## Round-1 findings: re-verified

| # | Finding | State |
|---|---------|-------|
| 1 | `provision-app.sh` both writers short | **FIXED** — `:173` (create) and `:617` (rotate-cred) both rooted, each with an in-line "do not clean up" rationale; help text at `:327` too. Independently mutation-proved below. |
| 2 | ndots arithmetic wrong | **FIXED** — five-entry / 5 attempts / 10 queries (2 leaving the cluster) now in `ports.go`, `83-appdb-operator.yaml`, `_validate.sh`, `appdatabase-api.md`, `provision-app.sh`, `gen-secrets.sh`, `tests/rooted-minted-hosts.test.ts`. The "(3 dots)" mislabel is gone. One straggler — see R2-2. |
| 3 | `ZONE_GATEWAY_HOST` deferral undocumented | **FIXED** — in-tree at both sites (`cmd/zone-operator/main.go:74-81`, `87-zone-operator.yaml:118-122`), each naming the consumer (compute libpq on a long-lived replication conn) rather than just "deferred". |
| 4 | `ports.go` OKE tense | **FIXED** — Node half now points at `tests/rooted-host-parsers.test.ts`, which *executes* `pg-connection-string`, `ioredis` and WHATWG `URL` against the rooted host (strictly stronger than the source-reading claim it replaced), and the resolver saving is correctly left as an on-cluster measurement. |
| 5 | `_validate.sh` contract unreachable | **PARTLY** — see R2-3. |
| 6 | dot-count nit | **FIXED** — assert dropped, with a comment explaining that a rooted *short* name is also absolute. |

Also fixed beyond my set: `gen-secrets.sh:175`, `demo/manifests/10-database-secret.yaml:20`,
`demo/README.md`, `docs/guides/{database-platform,postgres-binding}.md`. `gen-secrets.sh`'s
`DBHOST` feeds only DSN construction (`:176-177`, `sslmode=disable`) — no cert/SAN surface touched.
`go test ./...`, `gofmt`, `go vet`, and `biome check` on the two new specs: all clean.

## Independent mutation re-run (line-targeted, anchor-asserted, exit-code only)

Baseline green first (vitest `rc=0`, go `rc=0`); each mutation asserted to land on the intended
line or abort; `git checkout --` between runs; tree clean after.

- `provision-app.sh:173` (create) → short `…$NS.svc` — **RED**
- `provision-app.sh:617` (rotate-cred) → short `…$NS.svc` — **RED**  ← the silent-revert path, pinned singly
- `provision-app.sh:173` → 4-dot `…svc.cluster.local` (the defect form) — **RED**
- `provision-app.sh:173` → **bare `pggw-apps`** — **GREEN (survives)** → R2-1
- round-1 Go set (unrooted default, short default, main.go hardcode, env auto-rooting, mint bypass, manifest dot loss, manifest env removal) — all still **RED**

`tests/rooted-minted-hosts.test.ts` does run in root CI (`ci.yml:182 pnpm exec vitest run --coverage`
picks up `tests/*.test.ts`; `vitest.config.ts` excludes only `**/.claude/**` and docker-e2e), so the
enforcement claim holds. Its per-file "at least one host" vacuity guard is real.

## Residuals

**R2-1 (minor, one line) — `tests/rooted-minted-hosts.test.ts:90` and `_validate.sh:544`: the
scan is gated on `.svc`, so the WORST form evades it.** The filter is
`hosts.filter(h => h.includes('.svc') && !h.endsWith('.cluster.local.'))`; a regression to the bare
service name (`@pggw-apps:55432` — one label, so it walks all five suffixes, strictly worse than
the two forms the guard does catch) contains no `.svc` and passes. Mutation-proved above.
`_validate.sh`'s sibling scan has the same shape (`grep 'pggw-apps\.'`, anchored on a dot, so the
bare form is not even matched). Not hypothetical: `deploy/_verify-scale-ceiling.sh:141` already
uses `@pggw-apps:55432`, so it is an in-repo copy-paste away. Why it matters: the docstring's
promise is "SCAN, don't enumerate", and this guard silently enumerates a substring condition —
this repo's most-repeated defect class. Fix is one predicate: require every matched gateway host to
end in `.`, rather than only auditing the `.svc` ones.

**R2-2 (nit) — `gateway/internal/appdb/gatewayhost_test.go:16` still says "3-entry search path".**
Last surviving instance of the corrected arithmetic; every other artifact now says five. Same class
as round-1 finding 2, just missed in one comment.

**R2-3 — the reachability claim is one hop optimistic, and the report-not-fix call is right.**
Verified by running the real `_validate.sh` against the live context: `88-loadsoak-k6.yaml` **does**
now validate ("server dry-run of the placeholder-rendered template"), so the quoting fix + the
placeholder-rendering branch work as described. But the script then **exits 1 at `:411`** ("60
phantom-keepalive honesty rule was lost") — 54 `ok`s, and **no rooted-host `ok` line**, because that
contract sits at `~:517`, *after* the new failure. So `_validate.sh`'s rooted-host contract still has
never executed in a real run; `tests/rooted-minted-hosts.test.ts` is the only live enforcement (which
is fine — I proved it red on both writers). Please restate the claim as "unblocked one hop, still
blocked at `:411`" rather than "the new contract evaluates".
**Reporting `:411` rather than fixing it is the correct call**, and for a stronger reason than
scope: the rule it greps for was deliberately reworked by #777/#791 (`60-prometheus.yaml:151` —
"DELIBERATE warm holds are NOT phantoms"), so the anchor is stale, not a lost alert. Deciding what
the honesty rule should now assert is an alerting-semantics call belonging to that owner; a DNS PR
guessing at it would be worse than #797.

## Test quality (round 2)

Improved on round 1 in the way that matters: the new guard is a *scan* over a declared artifact list
with a per-file vacuity assertion and an explicit, reasoned NOT-SCANNED list (so the list reads as a
decision, not an exhaustiveness claim), and it lives where CI actually runs it. The parser spec
executes the real `pg-connection-string`/`ioredis`/`URL` instead of arguing from their source, and
its fourth case exists precisely to stop "it parsed" from standing in for "the root label survived".
Both provision-app.sh writers are pinned individually, which is the guard round 1 was missing. The
one gap is R2-1.

---

# Round 3 — verified at `4d8743e` — **APPROVE**

**Verdict: APPROVE.** R2-1 and R2-2 are fixed, R2-3 is restated honestly at the source, and the
repo-wide scan added beyond my set is the strongest guard in the PR. One non-blocking follow-up
(R3-1) and one nit (R3-2) below — neither warrants another round.

## R2-1 — fixed, and the fix found a second defect I missed

`tests/rooted-minted-hosts.test.ts:72-100` now anchors on **host position**
(`@` / `=` / `: "`) with an optional dotted tail, and applies one uniform predicate,
`!h.endsWith('.')`, shared by the file scan and the unit cases so the two cannot drift.
`_validate.sh:544` was re-anchored the same way (`@`-anchored, bare-inclusive) instead of on
`pggw-apps\.`, which by construction could not see the bare form.

Independently mutation-proved at `4d8743e` (baseline green first, line-targeted, anchor-asserted,
exit-code only, `git checkout --` between runs, tree clean after):

- bare `pggw-apps` in `provision-app.sh:173` (my surviving R2-1 case) — now **RED**
- unroot a host in a non-deferred doc (`docs/getting-started.md`) — **RED** (repo-wide scan sees it)
- deferral rule pointed at a nonexistent path (stale-allowlist half) — **RED**
- `BARE_GATEWAY_DNS` regex neutered (vacuity half) — **RED**
- rooted **short** name `pggw-apps.$NS.svc.` — **GREEN**, correctly *accepted*

That last case is the real gain: the old `.svc`-gated predicate would have **failed a legitimately
rooted short name**, contradicting the custom-zone contract that `APPDB_GATEWAY_HOST` is honoured
verbatim. Fixing the false negative I reported removed a false positive I did not — the predicate is
now the invariant itself ("ends in a dot"), not a proxy for it. Encoding the mutation as permanent
cases (`describe('the rooted-host predicate')`) is the right call: a mutation proof demonstrates a
hole once and evaporates.

## Repo-wide scan (`tests/rooted-cluster-hosts-repo-wide.test.ts`) — the strongest guard here

Correct on the three things this class usually gets wrong: it is **fail-closed in both directions**
(an unmatched violation fails *and* a deferral covering nothing fails, so an exemption cannot
outlive its subject — both halves mutation-proved above); it carries a **vacuity guard** so a broken
`git ls-files`/regex cannot read as green; and each of its 12 deferrals states a *consumer-level*
reason rather than a path. The division of labour against the minted-hosts guard (values vs
references) is stated and real. Ten genuine survivors were found and fixed — three of them
app-consumed `DATABASE_URL` recipes still teaching the short host *after* two rounds, which is the
empirical case for scanning over enumerating.

Blast-radius check on the ten: `10-gateway.yaml:131`, `81-apps-gateway.yaml:180` and
`30-knext-secret.yaml:36-37` are **comments and a commented-out example** — zero runtime effect. The
rest are docs. Nothing in the round-3 diff changes a value a running component reads.

## R2-2, R2-3 — fixed / restated

- `gatewayhost_test.go:13-19` now carries the five-entry/10-query arithmetic; a repo grep finds no
  surviving "3-entry" or "(3 dots)".
- `_validate.sh:530-545` now states plainly that the contract has **never executed**, with both
  reasons separated (not wired into root CI; and `set -eu` exits at `:411`), names the live
  enforcement, and records `:411` as a **stale anchor, not a lost alert**, with the evidence
  (`60-prometheus.yaml:151`, #777/#791) and the reason it is #797's call. That is exactly the right
  disposition — a DNS PR guessing at reworked alerting semantics would be worse than the report.
- `gen-tls.sh` SAN interaction is now a *stated* deferral with a named owner rather than an
  unrecorded consequence — which is the right home for it, since the `verify-full` mismatch predates
  this change.

## Residuals (neither blocking)

**R3-1 (follow-up) — the ioredis proof runs against a major the runtime does not ship.**
`package.json` declares the root devDep `ioredis: ^6.0.0` (installed: 6.0.0), but every shipping
consumer is on **5.x**: `packages/lib:72` `^5.9.3`, `packages/kn-next:170` `^5.9.2`,
`apps/file-manager:27` `^5.9.2`. So `tests/rooted-host-parsers.test.ts` proves root-label
preservation on ioredis 6 while the measured consumer in the ledger is ioredis 5. Behaviourally this
is near-certainly identical (both hand the host string to `net.connect` unmodified) and the Go/pg
halves are unaffected — but the honest claim is "verified on 6.0.0", not "verified for the consumer".
Cheapest fix: declare `^5.9.2` to match what ships, or say the version in the docblock. Worth noting
that this is the same class the implementer just fixed by declaring the dep at all — the residue is
gone, the *version* is now the loose end.

**R3-2 (nit) — `rooted-cluster-hosts-repo-wide.test.ts:31/42` can false-positive on prose
punctuation.** `CONNECTION_URL`'s character class admits `,` and `;`, so a rooted host written
mid-sentence (`…cluster.local.,`) would be captured with the comma attached and fail the
`endsWith('.')` test. No instance exists today (baseline green), and the failure mode is a loud
false positive rather than a silent miss, so it is safe to leave — but it will surprise whoever
writes that sentence.

## Final state

`go test ./...` (10 pkgs), `gofmt`, `go vet`, `biome check` on all three specs, and `tsc --noEmit`
(no diagnostics for the new files): clean. 24 implementer mutations claimed; I re-ran 16 of my own
across three rounds — every one red where it should be, and the one that was green in round 2 is red
now. Housekeeping: `.claude/impl-fqdn-report.md` is still **modified-uncommitted** in the worktree
(pre-existing, not mine — every mutation I ran was restored).

Test quality across the PR: strong, and the trajectory is the point — each round converted a
transient mutation proof into a permanent case, replaced an enumeration with a scan, and stated its
own reachability limits in the artifact rather than in a PR body that disappears. Ship it.
