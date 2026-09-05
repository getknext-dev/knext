APPROVE

> Final verdict, set at **round 3 (`4d8743e`)**, conditional on the PR-body correction in
> §M. Rounds 1 and 2 below each closed as ISSUES_FOUND; they are kept verbatim as the record.

# Spec review — PR #796 (fix/appdb-fqdn-dsn) vs cold-start ledger lever 1

Spec: "Rooted FQDN (trailing dot) in **every platform-minted hostname** — the appdb operator's
DSNs **and the docs' recipes** … Client compatibility with the trailing dot must be verified
**per consumer, not assumed**." (`docs/benchmarks/cold-start-ledger.md:86-90`, PR #795 branch)

## Checklist

| # | criterion | verdict | evidence |
|---|---|---|---|
| 1 | appdb operator mints rooted DSNs | **met** | `internal/appdb/ports.go:180` `DefaultGatewayHost = "pggw-apps.scale-zero-pg.svc.cluster.local."`; `cmd/appdb-operator/main.go:48,78`; `deploy/83-appdb-operator.yaml:141`. Tests green on a clean tree: `TestDefaultGatewayHostIsRooted`, `TestMintedWriterDSNUsesRootedHost`, `TestDerivedROKeyKeepsRootedHost`, `TestGatewayHostDefaultIsRooted` (re-run `go test -count=1`). |
| 2 | **every** platform-minted hostname rooted | **NOT met** | `deploy/gen-secrets.sh:174` `DBHOST=pggw.scale-zero-pg.svc.cluster.local` — unrooted 4-dot. See §A. |
| 3 | docs' recipes updated | **partial** | 4 files updated under `packages/scale-zero-pg/docs/`; 4 tracked recipes still print the short host. See §B. |
| 4 | consumer compat verified, not assumed | **partial (discharged in review)** | lib/pq: `TestLibPQPreservesRootedHost` + `TestWarmHoldDSNRewriteKeepsRootedHost` re-run green. node consumers were only path-read; a stronger offline check existed. See §C. |
| 5 | honest scope (minted-once, filemanager) | **met on mechanism, partial on consequence** | `internal/appdb/k8s.go:82-84` `IsAlreadyExists(err) → nil`. See §D. |
| 6 | red commit `804611d` fails for its claimed reason | **partial** | It asserted the **opposite** contract. See §E. |
| 7 | new guard actually enforces | **NOT met** | `_validate.sh` aborts before reaching it. See §F. |

## A. A platform-minted, app-consumed short hostname escaped (blocking)

`deploy/gen-secrets.sh:174-181` mints the base-tier `myapp-database` Secret —
`DATABASE_URL` / `DATABASE_URL_RO` — at
`pggw.scale-zero-pg.svc.cluster.local:55432` (4 dots, **no** trailing dot). By this PR's own
arithmetic (`ports.go:161-163`, "Qualifying without rooting is not a fix") that value still walks
all five search entries. It is:

- **platform-minted** — a platform script, not a user's hand-made Secret (`30-knext-secret.yaml:5-10`
  makes gen-secrets.sh the owner of record);
- **app-consumed** — copied into `NextApp.spec.secrets.envMap.DATABASE_URL` (`30-knext-secret.yaml:18-26`);
- **reconciled, not create-once** (`gen-secrets.sh:169-171`, `create --dry-run=client | apply`) — so
  unlike the operator's Secrets, rooting it would reach existing installs on the next run. It is the
  *cheapest* remaining instance of this lever and it was not taken.

It is also **not in the PR's enumerated deferral set** ("ZONE_GATEWAY_HOST … gateway-internal dial
targets"), so the enumeration is presented as complete when it is not. Same class, also unlisted:

- `packages/scale-zero-pg/demo/manifests/10-database-secret.yaml:20` — shipped `pg-demo-db`
  DSN, unrooted `pggw.scale-zero-pg.svc.cluster.local`;
- `apps/file-manager/kn-next.config.ts:17` — default `redis://file-manager-redis.default.svc.cluster.local:6379`,
  unrooted. Ledger row 1 names the ioredis `connect ETIMEDOUT` as half the fresh-pod tail, so this is
  the same lever on the *other* measured consumer. (Arguably app-level, not platform — but then say so.)

`ZONE_GATEWAY_HOST` (`cmd/zone-operator/main.go:74`) — I verified the PR's characterisation is
correct: it feeds `conninfo()` for logical-replication subscriptions (`internal/zone/reconcile.go:328,491`),
a compute-side dial, not an app-consumed Secret. That deferral is honest.

## B. Docs half — one copy fixed, its duplicate missed

Commit `39926d9` claims "+ docs", so docs are in scope, not excluded. Still short-host:

- `docs/guides/database-platform.md:169` — the **exact same recipe** as
  `packages/scale-zero-pg/docs/getting-started.md:167` which the PR *did* fix. Two docs in one repo
  now print different values for the same `kubectl get secret … DATABASE_URL` command; the unfixed
  one is now simply wrong about what the operator mints.
- `docs/guides/postgres-binding.md:154-155` — a hand-authored Secret recipe teaching the short host.
- `packages/scale-zero-pg/demo/README.md:96`.

Either fix them or state the scoping ("minted values + the scale-zero-pg package docs only");
neither was done.

## C. "verified per consumer" — a cheaper, stronger check was skipped

The report (§2) marks node-postgres/ioredis "NOT runnable in the Go module — deferred to OKE",
verified by path-reading. But the **real parsers are installed in the main checkout**. One command:

```
node -e '…pg-connection-string@2.11.0 … ioredis@5.9.2 …'
pg-connection-string host: "pggw-apps.scale-zero-pg.svc.cluster.local."  port: 55432
WHATWG URL hostname:      "pggw-apps.scale-zero-pg.svc.cluster.local."
ioredis host:             "file-manager-redis.default.svc.cluster.local." port: 6379
```

All three preserve the root label. So the outcome is favourable and this is **not** blocking — but
the spec said *verified, not assumed*, and executing the installed parser was strictly stronger and
cheaper than reading its source. Fold the above into a test (or the PR body) rather than carrying it
to OKE as the first real check. `pq.ParseURL` byte-for-byte preservation: **re-run, confirmed**.

## D. Honest-scope claims — true, but one consequence is unstated

`k8s.go:82-84` (`CreateSecret`, `IsAlreadyExists → nil`) confirms mint-once; `EnsureSecretOwnerRef`
(`k8s.go:90+`) never touches data. So "existing Secrets unaffected" and "filemanager Secret hand-made
and unaffected" are **accurate**.

What is not said: the ledger's measured subject (`fm-node`, whose `EAI_AGAIN
pggw-apps.scale-zero-pg.svc` chose this lever) is **in the unaffected set**. As scoped, this PR can
land and the next ledger row show no change, for a reason that is not a measurement failure. State
that in the PR/ledger, or re-mint the benchmark app's Secret as part of the OKE verification.

## E. Red commit `804611d` — fails, but for the inverted contract

It does fail (`DefaultGatewayHost` / `gatewayHostFromEnv` undefined at that commit; both are added in
`b89cea3`). But its assertions were:

```
func TestDefaultGatewayHostIsFullyQualified   // want "…svc.cluster.local" (no dot)
if strings.HasSuffix(DefaultGatewayHost, ".") { t.Fatalf("… must NOT carry a trailing dot …") }
```

i.e. the red commit encoded the **opposite** of the shipped contract and was reversed in the green
commit. The *rooted* requirement — the actual lever — therefore never had a red-first test. Not a
correctness defect (the HEAD guards do assert it, and I mutation-proved the manifest guard myself),
but the TDD claim in the PR body should not be read as covering the rooted form.

## F. The new `_validate.sh` guard never runs (blocking-ish)

`deploy/_validate.sh` is a CI gate (`packages/scale-zero-pg/.github/workflows/ci.yml:31-32`, kind +
`sh deploy/_validate.sh`). Run here on this branch:

```
ok - 87-zone-operator.yaml validates (server dry-run)
FAIL: 88-loadsoak-k6.yaml does not validate: … yaml: line 50 …
```

The script is `set -eu` with `fail() { … exit 1; }` (`_validate.sh:5,8`), and the new rooted-host
contract sits at ~line 491 — **after** the abort. So the claimed mutation "manifest value loses its
trailing dot → `_validate.sh` RED" does not hold on the real execution path; it holds only for the
lifted snippet. The report discloses the pre-existing break honestly but does not draw this
conclusion. (I did mutation-prove the guard's logic standalone on temp copies: OK on the real file,
RED on unrooted-qualified, RED on short, RED on removal — the logic is good, it is the reachability
that is missing.) Either fix `88-loadsoak-k6.yaml` in this PR or say plainly that the guard is
dormant until it is fixed.

## G. Process hazard observed during review

A first `go test` run in this worktree went **red** (`gatewayHostFromEnv() … = "pggw-apps.scale-zero-pg.svc"`)
with `git status` showing an uncommitted `internal/appdb/reconcile.go`; both were gone seconds later.
Something is still mutating this worktree. Per `.claude/rules/workflow.md` step 10, stop the
implementer before the tree is read as authoritative — a concurrent mutation run makes any reviewer's
red/green meaningless. All results above were re-taken on a verified-clean tree.

## Verdict

**ISSUES_FOUND.** Must-fix before merge:

1. Root `deploy/gen-secrets.sh:174` (and `demo/manifests/10-database-secret.yaml:20`), or move them
   into an explicit, justified deferral list — the current enumeration reads as complete and is not.
2. Fix or explicitly scope out `docs/guides/database-platform.md:169`,
   `docs/guides/postgres-binding.md:154-155`, `demo/README.md:96`.
3. State that the new `_validate.sh` contract is unreachable until `88-loadsoak-k6.yaml` parses.
4. State that the benchmarked app is in the unaffected set (§D), so row 2 is not a test of this PR.

Nice-to-have: land §C's parser check as a test; correct the PR body's TDD claim per §E.
"Closes #…" honesty: the PR does not claim to close the ledger lever, and it should not — as scoped
it is a subset of lever 1.


---

# Round 2 — verified at `11ba6c5` (base `ca6be8b`)

Re-verified where a maintainer would look, on a tree confirmed clean before and after every
run (only `.claude/impl-fqdn-report.md` is modified, pre-existing). Round 1's churn is gone —
finding (G) is closed.

| round-1 finding | round-2 verdict | evidence |
|---|---|---|
| A minted short hosts | **met, and went further** | `gen-secrets.sh:175` rooted; `demo/manifests/10-database-secret.yaml:20` rooted; **and two writers I missed** — `provision-app.sh` `mint_credential():169` *and* `cmd_rotate_cred():613`, the latter of which would have silently reverted a rooted DSN on every rotation. Both rooted. |
| A deferral list in-tree | **met** | `tests/rooted-minted-hosts.test.ts:44-64` (fm redis, ZONE_GATEWAY_HOST, wake targets, ADRs), plus in-tree comments at `cmd/zone-operator/main.go:74-80` and `deploy/87-zone-operator.yaml:118-122`. I re-verified the ZONE deferral's premise independently in round 1; it holds. |
| B doc recipes | **partial — three survivors, same class** | see §H |
| C parser check | **met in substance, broken in mechanics** | see §I |
| D benchmark-app consequence | **met** | `docs/appdatabase-api.md:216-223` (blockquote: "a post-merge cold-start measurement taken without re-minting measures the *old* host… `provision-app.sh rotate-cred <app>`"), mirrored in the PR body. `rotate-cred` is a valid re-mint tool: it applies in place (`provision-app.sh:616-620`) and the operator re-derives `DATABASE_URL_RO` from the writer every pass (`k8s.go:129-148`), so RO self-heals. |
| E TDD claim | **met** | see §J |
| F `_validate.sh` reachability | **NOT met — still dead before the contract** | see §K |
| G worktree churn | **closed** | tree clean across ~10 runs. |

Also corrected in round 2 without being asked: the ndots arithmetic itself. Round 1 shipped
"3-entry search path / 3 dots"; `ports.go:155-170`, `docs/appdatabase-api.md:191-205` and
`provision-app.sh:169-172` now carry the **measured** five-entry path (3 standard + 2 OCI VCN)
and the correct 2-dot count for the short form. The docs now match the ledger.

## Re-run mutations (singly, anchor-asserted, restored + verified)

Harness: `python3`, anchor count asserted before substitution, abort on no-change, `git checkout`
restore then byte-compare, branch on **exit code** (never output grep).

```
baseline                                                            rc 0
MUT1  gen-secrets.sh DBHOST loses the root label                    rc 1  (RED)
MUT2  provision-app.sh rotate-cred DSN only (LAST of 2 occurrences) rc 1  (RED)
```

MUT2 is the important one: mutating **only** the rotate path — leaving `mint_credential` rooted —
still reds, so the guard covers the writer that round 1 never knew existed.

## H. Docs — three base-tier recipes still teach the short host (must-fix)

Round 2 fixed the three I named, then reproduced the same miss one layer down. All three below
are **app-consumed `DATABASE_URL` recipes**, and each now contradicts `gen-secrets.sh`, which this
PR rooted:

- `docs/guides/database-platform.md:110` — copy-paste Secret: `…@pggw.scale-zero-pg.svc:55432/postgres`.
  (Line 169, the app-db recipe, *was* fixed — so the file is now internally inconsistent.)
- `packages/scale-zero-pg/docs/connecting.md:118,120` — the base-tier two-DSN block
  (`DATABASE_URL` / `DATABASE_URL_RO`), short host. Same file whose app-db lines 261/321 were fixed.
- `packages/scale-zero-pg/demo/README.md:26` — "The `DATABASE_URL` Secret → `pggw.scale-zero-pg.svc:55432`",
  describing the very manifest rooted at line 20. Line 96 was fixed; line 26 was not.

Root cause is structural, and it is the thing the new guard's own docblock warns about:
`MINTING_ARTIFACTS` (`tests/rooted-minted-hosts.test.ts:37-42`) is an **enumerated four-file list**
inside a test titled "SCAN, don't enumerate". It scans *within* files, not *across* the repo, and
it scans **no docs at all**. A repo-wide `git grep` for `pggw…svc` with an explicit deferral
allowlist is tractable — it is how I found all three above in one command, and it would also cover
the fifth minting artifact nobody has written yet.

Minor, same file: the rooted predicate is
`!h.endsWith('.cluster.local.')` (`:90`), so a **correctly rooted custom zone** fails. Proved:
substituting `pggw.scale-zero-pg.svc.mycorp.internal.` into the demo manifest reds the guard with
"NOT rooted (trailing dot)" — a false statement about a rooted host, and a direct contradiction of
the operator's documented custom-zone contract (`ports.go:176-178`, "a cluster with a custom zone
overrides this … kept rooted"). `_validate.sh:541` gets this right (trailing dot only).
Recommend `h.endsWith('.')`.

## I. C landed, but the test cannot import its subjects in CI (must-fix)

`tests/rooted-host-parsers.test.ts` is the right test — it executes the real parsers and includes a
negative control (`:50-58`, the unrooted host parses to a different string, so the assertions are
not trivially true). It passes here (4/4).

But it passes for a reason that will not survive CI:

- `ioredis` and `pg-connection-string` are **not** in root `package.json` (deps `@next/env`;
  devDeps have no `pg*`/`ioredis`), and the PR does not touch `package.json`.
- They are not in this worktree's `node_modules` either. `require.resolve` from `tests/` walks
  **out of the worktree** into the parent checkout: `/Users/banna/alpheya/pocs/knext/node_modules/ioredis`.
- That parent copy is **stale, non-pnpm residue**: pnpm-managed root deps are symlinks into `.pnpm`
  (`vitest -> .pnpm/…`, dated Aug 19), while `ioredis` and `pg-connection-string` are plain
  directories dated **Jun 20**. The repo is `nodeLinker: isolated` with `publicHoistPattern: []`
  (`node_modules/.modules.yaml`), so `pnpm install --frozen-lockfile` on a clean checkout will not
  create them.
- CI runs the root suite (`.github/workflows/ci.yml:182`, `pnpm exec vitest run --coverage`), and
  every other root-level `tests/*.ts` import is a declared root devDep (`typescript`, `vitest`,
  `yaml`). These two are the first exceptions.

Fix: add both to root `devDependencies` and re-run. Until then "landed as a real CI test" is not
established — the likely CI outcome is a module-resolution error, i.e. a red that looks like an
infra failure rather than the contract it encodes.

## J. E — the round-2 red is red for the right reason (met)

Proved directly rather than read: checking out the four scanned artifacts at `ca6be8b` and running
the HEAD guard:

```
× provision-app.sh … NOT rooted … pggw-apps.$NS.svc, pggw-apps.$NS.svc, pggw-apps.$NS.svc
× gen-secrets.sh   … NOT rooted … pggw.scale-zero-pg.svc.cluster.local
× 10-database-secret.yaml … NOT rooted … pggw.scale-zero-pg.svc.cluster.local
Tests 3 failed | 2 passed
```

`83-appdb-operator.yaml` correctly stays green there (round 1 had already rooted it). Exactly the
commit message's claim. The PR body's TDD paragraph now states the round-1 inversion accurately.

## K. F — still not fixed in effect (must-fix, or restate)

`88-loadsoak-k6.yaml` does now parse, and the script gets ~340 lines further. It still never
reaches the rooted-host contract:

```
$ bash deploy/_validate.sh
…
FAIL: 60 phantom-keepalive honesty rule was lost      # _validate.sh:413
```

The rooted-host contract is at `_validate.sh:527-546` — **114 lines after** the abort
(`set -eu`, `fail() { … exit 1; }`). Cause is pre-existing and unrelated: the guard greps
`min_over_time(sum(pggw_active_connections)` while `60-prometheus.yaml:162` has
`min_over_time((sum(pggw_active_connections)` — one paren of drift, and `60-prometheus.yaml` is
untouched by this PR (`git diff main...HEAD` empty for it). So the whole tail of that script has
been dead on `main` for some time.

Two things follow. First, "the contract evaluates on a real run" is **not** true at `11ba6c5` —
either fix the line-413 grep here or say plainly that the script's tail is still unreachable.
Second, a **correction to my own round-1 framing**: I called `_validate.sh` a CI gate. The
implementer's in-tree note (`tests/rooted-minted-hosts.test.ts:17-21`) is more accurate —
`packages/scale-zero-pg/.github/workflows/ci.yml` is subtree residue that GitHub never runs
(only root `.github/workflows` executes), so it gates nothing *in knext*. It does gate the
upstream `scale-zero-pg` repo, where the same line-413 breakage applies. Moving primary
enforcement into the root vitest guard was the right call; §I is what makes that real.

## L. PR body is stale against its own branch

- Bullet 2 still says node-postgres/ioredis are "verified by **path-reading** … runtime proof
  landing in the lead's OKE measurement". Round 2 executes the real parsers — the body undersells
  what shipped and misstates the verification method.
- The closing note still says `_validate.sh` "dies on `88-loadsoak-k6.yaml` … ~line 50" — fixed in
  this PR; it now dies at `:413` for a different, pre-existing reason (§K).
- "Five mutations red" is unchanged though round 2 added guards; and "manifest dot loss →
  `_validate.sh` RED" still needs the §K qualifier.
- Neither `tests/rooted-minted-hosts.test.ts` nor `tests/rooted-host-parsers.test.ts` is mentioned,
  although the first is now the *only* enforcement that runs in knext CI.
- The deferral bullet omits the fm redis default, which the in-tree list does carry — make them agree.

## Round-2 verdict

**ISSUES_FOUND** (down from six must-fixes to three, none of them architectural):

1. **§I** — declare `ioredis` + `pg-connection-string` in root `devDependencies`; the parser test
   currently resolves only through stale residue outside the repo.
2. **§H** — root `docs/guides/database-platform.md:110`, `packages/scale-zero-pg/docs/connecting.md:118,120`,
   `packages/scale-zero-pg/demo/README.md:26`; and either widen the guard to a repo-wide scan with a
   deferral allowlist, or drop the "scan, don't enumerate" claim in its docblock. (Also `:90`
   `endsWith('.')`.)
3. **§K** — `_validate.sh` still aborts 114 lines before the new contract; fix the `:413` grep or
   restate the claim.

4. **§L** — refresh the PR body; three of its statements are now false about its own branch.

Everything else I raised in round 1 is genuinely closed, and two of the fixes (the rotate-cred
writer, the corrected ndots arithmetic) go beyond what I asked for.

> **Addendum (churn, again).** Immediately after this round-2 verdict was written,
> `tests/rooted-minted-hosts.test.ts` appeared **uncommitted** in the worktree (+35/−7: a
> `GATEWAY_HOST_IN_POSITION` regex and an exported `gatewayHostsInText`), i.e. round-3 work
> landing while the review ran. Everything above is pinned to committed `11ba6c5` and does not
> cover that edit. Finding (G) is therefore only closed for the duration of round 2 — sequence
> the implementer against the reviewer, or the next verdict is again taken on a tree that no
> longer exists.


---

# Round 3 — verified at `4d8743e`

Tree quiet throughout (only `.claude/impl-fqdn-report.md` modified, pre-existing); every result
below re-taken on a clean tree and restored byte-for-byte.

| round-2 item | verdict | evidence |
|---|---|---|
| §H the three doc survivors | **met** | `docs/guides/database-platform.md:110`, `packages/scale-zero-pg/docs/connecting.md:118,120`, `demo/README.md:26` all rooted — plus seven more the scan found (`apps/docs/…/scale-to-zero-database.mdx`, `scale-zero-pg/README.md`, `deploy/10-gateway.yaml`, `30-knext-secret.yaml:36-37`, `81-apps-gateway.yaml`, `docs/getting-started.md`, `docs/knext-handoff-prompt.md`). |
| §H structural (scan, not enumerate) | **met** | `tests/rooted-cluster-hosts-repo-wide.test.ts` — `git ls-files` over every tracked file (`:150-152`), URL authority *and* bare cluster-DNS in prose (`:32,40`), with a vacuity guard (`:174-181`). |
| §H minor (custom zone) | **met** | predicate is now uniform `!h.endsWith('.')` (`rooted-minted-hosts.test.ts:98`). Re-ran my round-2 probe: `pggw.scale-zero-pg.svc.mycorp.internal.` is now **green** — the false positive is gone. |
| §I undeclared deps | **met** | `package.json:39,42` (`ioredis ^6.0.0`, `pg-connection-string ^2.14.0`), lockfile updated; `require.resolve` from `tests/` now lands **inside the worktree** (`node_modules/.pnpm/ioredis@6.0.0/…`), no longer the parent checkout's stale Jun-20 directories. Parser suite green on the **major bump** (4/4) — the root label survives ioredis 6. |
| §K `_validate.sh` | **met, by restatement — the honest option** | The abort is now diagnosed in-tree (`_validate.sh` reachability header): the script exits at `:411` on a **stale anchor**, not a lost alert. I verified that independently: `60-prometheus.yaml:161` still carries `ComputePhantomKeepalive`, reworked by #777 to subtract `appdb_warm_hold_active`, so the grep — not the alert — is what rotted. Deciding the new assertion is that rule owner's call; deferring it to #797 and pointing live enforcement at the two root-suite guards is correct, and it is now stated in the file rather than implied. |
| §J / red-first | **met** | Checked out the ten pre-fix files at `11ba6c5` and ran the scan: **exactly 10 violations**, including all three §H survivors, `Tests 1 failed`. Restored and green. |

## Mutation proofs I ran on the new scan (all restored, exit-code-branched)

```
baseline                                                          rc 0
plain unrooted host in a user doc                                 rc 1  RED
bare prose host, NO url scheme (the demo/README:26 form)          rc 1  RED
stale deferral — root 25-compute-warm's only host so the
  'platform-internal-dial-targets' rule matches nothing            rc 1  RED
```

The third is the one that matters: the fail-closed-**both**-ways claim is real, not decorative —
a deferral that stops covering anything reds the build, which is what stops an allowlist rotting
into a standing exemption.

## §N. Two deferrals are host-matched, so they exempt the whole repo (new, non-blocking)

The deferral list's *justifications* hold on inspection — I read all twelve, and the two I probed
hardest are sound: `operations.md` genuinely carries no minted DSN recipe (only prose about the
`cloud_admin` credential at `:1098`), and the `tls-san-list` deferral names the verify-full
mismatch as a follow-up for the TLS owner instead of burying it.

But two rules match on the **host string** rather than the **file path**, which makes them
repo-wide exemptions rather than the scoped decisions their prose describes. Proved by probe, not
argued:

```
inject  APPDB_REDIS_URL = redis://pgredis.scale-zero-pg.svc:6379   into 83-appdb-operator.yaml
  -> scan stays GREEN   (rule 'app-level-redis', match: /redis/i.test(host))
inject  postgres://u:p@my-gw.scale-zero-pg.svc:55432/db            into 83-appdb-operator.yaml
  -> scan stays GREEN   (rule 'documentation-placeholder-hosts', match: /^(acme|shop|byo|my)[-.]/)
```

So a *platform-minted* Redis host in an operator manifest is silently excused today, and the
ledger names ioredis `connect ETIMEDOUT` as the other half of the very tail this lever targets —
i.e. the most likely next instance is the one the guard cannot see. Fix is one line each: scope
`app-level-redis` to `apps/**` plus the docs that mirror it, and `documentation-placeholder-hosts`
to doc paths, matching the file-scoped style of the other ten rules. Not blocking — no such host
exists today, and the vacuity + stale-deferral guards remain intact — but it should not wait for a
third instance of the same lesson.

## §M. PR body — still stale (must fix before merge, not another review round)

Three sentences remain false about their own branch (unchanged since round 2):

1. "node-postgres/ioredis compat verified by **path-reading** … runtime proof landing in the lead's
   OKE measurement" — `tests/rooted-host-parsers.test.ts` executes the real parsers in CI, now on
   declared deps at ioredis 6.
2. "`deploy/_validate.sh` dies on `88-loadsoak-k6.yaml` (kubectl YAML parse, ~line 50)" — fixed in
   this PR; it now exits at `:411` on the stale phantom-keepalive anchor (#797).
3. "Five mutations red" — rounds 2 and 3 added the repo-wide scan, the stale-deferral half and the
   bare-prose form; and neither new test file is mentioned, though `rooted-cluster-hosts-repo-wide.test.ts`
   is now the broadest enforcement that actually runs in knext CI.

This is the "re-read your own claims against the current tree before merging" rule, and it is a
text edit, so it gates the merge rather than a fourth round.

## Round-3 verdict

**APPROVE**, conditional on §M.

Every spec criterion of ledger lever 1 is now met by tested behaviour: every platform-minted
hostname is rooted (enforced by a real repo-wide scan with a fail-closed-both-ways deferral list),
the docs' recipes are rooted, and consumer compatibility is *executed* per consumer — lib/pq in Go,
pg-connection-string and ioredis 6 in the root suite — rather than assumed. Scope is stated
honestly, including the part that costs the authors something: the benchmark subject is in the
unaffected set, so the next ledger row proves nothing unless it is re-minted first.

Carry forward, not blocking: §N (scope the two host-matched deferrals), the `gen-tls.sh`
verify-full SAN mismatch already flagged in-tree for the TLS owner, and #797 (`_validate.sh`
reachability + the stale phantom-keepalive anchor).
