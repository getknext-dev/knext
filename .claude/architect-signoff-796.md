SIGN-OFF

# Architect sign-off — PR #796 (`fix/appdb-fqdn-dsn`, head 4d8743e)

Scope of this gate: architecture only. Code review (`.claude/code-review-796.md`) and spec review
(`.claude/spec-review-796.md`) both APPROVE at round 3; I did not re-litigate line-level findings.

## Verdict: **SIGN-OFF**

## 1. ADR / contract compliance — clean

- **ADR-0001 (operator = single source of truth).** No new cluster writer. The diff changes the
  *value* of a host string in paths that already own their writes: the appdb operator's minted
  `app-db-<app>` Secret (`internal/appdb/reconcile.go:92`), the two `provision-app.sh` mint paths,
  `gen-secrets.sh`, and declarative manifests. Nothing new applies Knative objects, nothing mutates
  cluster state out of band. `deploy/_validate.sh` remains a validator, not a writer.
- **Custom-zone contract — preserved, and the reviewers' false positive was resolved the right way.**
  `APPDB_GATEWAY_HOST` is `env(...)`-read and passed through **verbatim** — never auto-qualified,
  never auto-rooted (`cmd/appdb-operator/main.go:43-49`), and that promise is stated identically in
  four places (`ports.go` `DefaultGatewayHost` docblock, `83-appdb-operator.yaml`,
  `docs/appdatabase-api.md`, the test). Critically, the *rooted short name* case is handled
  consistently: `gatewayhost_test.go` asserts **only** `HasSuffix(".")` and explicitly refuses a
  dot-count floor ("a rooted SHORT name … is absolute and perfectly correct"), and the repo-wide scan
  keys on `!h.endsWith('.')`, not on `.cluster.local`. So a cluster with a non-default DNS zone can
  set any rooted name — short or long — and both the guard and the operator accept it. The invariant
  encoded is "absolute", not "cluster.local", which is the correct contract.
- **Adapter / proto / Nitro rules:** untouched. No runtime change, no second runtime, no CRD or
  public-API surface change (`packages/kn-next/src/cli/`, `config.ts`, `nextapp_types.go`, package
  subpaths all unmodified). Root `package.json` gains two **devDeps only** (`ioredis`,
  `pg-connection-string`) used to execute real consumer parsers — they are outside the published
  production closure, so the npm SBOM/audit gate is unaffected.

## 2. Deferral boundary — principled, not convenient

The line drawn is **"platform-minted, app-consumed value" vs "internal dial target / app-level
config"**, and it is drawn on the *consumer*, which is the same axis the lever itself is defined on
(a freshly-scheduled app pod's first UDP flows):

- `ZONE_GATEWAY_HOST` — embedded in `conninfo()` for `CREATE SUBSCRIPTION`/FDW, resolved by the
  **compute's** libpq on a long-lived replication connection. Different consumer, unmeasured, and
  the deferral is recorded **in-tree at the site** (`zone-operator/main.go:74`), not only in the PR
  body. That in-tree note is what makes the inconsistency between two operators readable rather than
  a trap.
- `apps/file-manager` Redis default — app-level config, not a platform-minted Secret. This is the
  right side of `.claude/rules/scs-zones.md`'s core-vs-app boundary; changing an app's default is a
  separate blast radius and the deferral says so.
- drill/bakeoff/wake internals, runbook dial targets, doc placeholder hosts, historical ADR/benchmark
  records — none are minted values; rooting the placeholders would actively teach the dot as part of
  a user's own name, and rewriting the records would falsify them.

Each deferral is a stated decision with a reason, and each is machine-asserted to still cover
something. That is a boundary, not an escape hatch.

## 3. Guard doctrine — consistent, and an improvement on the enumerated form

`tests/rooted-cluster-hosts-repo-wide.test.ts` is the doctrine as written in
`.claude/rules/workflow.md`: **scan, don't enumerate** (`git ls-files`, URL *and* bare-prose forms —
the bare form is exactly how the three surviving recipes evaded round 2), **fail-closed both ways**
(an unmatched host fails *and* a deferral matching nothing fails, the #784 allowlist pattern, which
is what stops a deferral outliving its excuse), plus a **vacuity guard** so a broken regex or a
broken `git ls-files` cannot read as green. 24 mutations red across three rounds, anchor-asserted and
exit-code-detected. Division of labour with `rooted-minted-hosts.test.ts` (values per writer vs
references everywhere) is deliberate and documented. A repo-root guard scanning a package's naming
is fine in this monorepo — `tests/` already holds repo-wide guards of exactly this class.

## 4. gen-tls.sh SAN × verify-full — deferring is sound, verified not assumed

Checked what the minted DSNs actually carry today, rather than trusting the deferral's claim: every
platform-minted DSN is `sslmode=disable` (`reconcile.go:92`, `provision-app.sh` both mint paths,
`gen-secrets.sh`). The only `sslmode=require` in the tree is a verification script
(`_verify-multitenant.sh:115`), and `require` performs **no hostname/SAN comparison**. Nothing in
the tree uses `verify-ca`/`verify-full`. So no certificate-name comparison is in play, the rooted
host cannot break a live path, and the mismatch is **pre-existing** (it already failed for the 4-dot
form). Correctly classed as a follow-up for the TLS owner, and stated in the deferral rather than
silently accepted. It does **not** block. It does become blocking the moment anyone moves a minted
DSN to `verify-full` — which is why it needs to be written down (below), not left in a test comment.

## 5. Positioning / scope — no drift

One host literal per writer, plus guards, plus docs. This is lever 1 of the measured cold-start
ledger (#795) and nothing else: no new capability, no new CRD field, no new endpoint, no PaaS-ward
surface. The honesty caveats are the right ones and are in the durable artifact rather than only the
PR body — mint-once scope, and the explicit warning that a post-merge measurement taken without
re-minting the benchmark app measures the **old** host and proves nothing. That warning is doing real
architectural work: it pre-empts a false negative being read as "the lever doesn't work."

## Follow-up ADR (recommendation, not a condition of this sign-off)

Write **`packages/scale-zero-pg/docs/adr-0010-rooted-platform-minted-hostnames.md`**: codify (a) all
platform-minted hostnames are rooted while env overrides pass through verbatim, (b) the deferral
boundary — app-consumed Secret vs internal dial target vs app-level config, and (c) the open
SAN×`verify-full` interaction as a named consequence with an owner, so the TLS story cannot adopt
`verify-full` without meeting it. Today that decision lives only in a const docblock and an
allowlist comment; an ADR is where a repo-wide invariant with a deferral set belongs.
