# ADR-0056: Credential v1.0 per runtime×builder cell, against a frozen release-candidate ref

- **Status:** Accepted (2026-09-23) — encodes two founder decisions recorded on #850 and #1218.
  The **mechanism** lands with this ADR; **cutting a release candidate is a founder action** and
  none is cut here. **Amended** by Amendment 1 (2026-09-24, Proposed): bytecode-liveness grading
  (D4), per-cell fingerprint closure (D5), the freeze guard (D6) and the v1.0 cell set (D7).
- **Amends** ADR-0039 (the frozen set is unchanged in scope — still tarball-inclusive, still not
  narrowed — but its *workflow* entry is now read from the commit that actually executed; see
  ADR-0039 Amendment 1). **Supersedes** the node-lane-only definition in `docs/V1_ROADMAP.md` §3.
  **Relates to** ADR-0007 (the official-suite gate), ADR-0054 (bun-standalone default).
- **Trigger-class:** ADR + CI + release process — flagged for the sprint-close design review.

## Context

Three facts, each already measured or decided, collide in the v1.0 gate.

1. **The window cannot hold on `main`.** ADR-0039 freezes the harness *and* every packed
   `@getknext/*` tarball in full, and it records that narrowing the digest to exclude
   `dist/cli/**` "was wrong". So every merge that touches shipped bytes restarts the 14-night
   count. `docs/compat/window-node-lane.md` measured the cost: 10 fingerprint moves across 27
   nights, longest streak 7, and not one night lost to a test failure. The runtime-axis sprint
   churns `packages/kn-next/src` on almost every merge, so on `main` it would invalidate its own
   credential. Narrowing the fingerprint is ruled out (ADR-0039); the remaining lever is to stop
   counting nights on a moving ref.
2. **The credential is a matrix, not a lane** (#1218, founder, 2026-09-23). v1.0 is credentialed
   on every *supported* runtime × builder cell — node/bun × vinext/turbopack/webpack — each with
   its own 14-consecutive-green-nights window on the official suite, and every cell must have
   bytecode caching live. `docs/V1_ROADMAP.md` §3 still says "14 consecutive scheduled
   **node-lane** runs" and "Bun is out of the 1.0 verified surface", which contradicts ADR-0054's
   bun-standalone default. That contradiction is resolved here.
3. **The credential runs against a frozen RC tag** (#850, founder, 2026-09-23). `main` nightlies
   continue as early warning but never advance a count. A window resets only when *its own
   cell's* fingerprint changes. rc.1 is cut only once every cell's prerequisites have landed.

## Decision

### D1 — A credential night is a scheduled night on a frozen RC tag

- The **credential ref** is a tag matching `v<major>.<minor>.<patch>-rc.<n>`, named in a pin file
  on `main`: `.github/compat-credential-ref.json` (`{"rcTag": "v1.0.0-rc.1"}`, or `null` before
  rc.1 is cut). `scripts/compat-credential-ref.mjs` resolves it through `git ls-remote` to a
  peeled commit SHA, and the run checks out **that SHA**, not the tag name, so a tag moved mid-run
  cannot switch what was built.
- `test-e2e-deploy.yml` gains **two credential crons** (`17 1 * * *` node, `47 5 * * *` bun). The
  two existing crons (`17 3` node, `47 4` bun) keep running on `main`, now labelled
  **early-warning**. The mode is decided only by the cron literal (`KNEXT_COMPAT_MODE`), so a
  `workflow_dispatch` can never produce a credential night.
- **Fail-closed resolution.** On a credential cron, a missing, unreadable, `null`, malformed or
  unresolvable pin **refuses the run** (the first job fails and nothing else runs). There is no
  fallback to `main`. A `null` pin, which is the declared "not cut yet" state, refuses without
  opening a red-alert issue so the nights before rc.1 do not spam the tracker. Every other
  refusal alerts.
- **The run ledger records the ref.** Every `compat-run-ledger.json` now carries `compatMode`,
  `credential`, `knextRef` (`refs/tags/v…-rc.N`, or `refs/heads/main`), `knextSha`, and
  `workflowSha`. The ledger job fails a run that claims `credential` on a non-RC ref.
- **The audit counts only credential nights.** `scripts/compat-window-audit.mjs` grades the
  credential window by default. A `main` night is *excluded* from it, the same way a bun night is
  excluded from the node window: it neither extends a streak nor restarts one. A night that
  *claims* credential through any one signal (`credential`, `compatMode`, or an RC-shaped
  `knextRef`) is selected and must then satisfy all of them. A night that claims credential on a
  non-RC ref is disqualified, which restarts the count. `--scope early-warning` reports the `main`
  streak, and its report can never print "GATE MET".
- **Attribution survives a lost ledger.** The first job publishes `compat-lane-<lane>` and
  `compat-mode-<mode>` marker artifacts before anything that can fail. An unresolved night whose
  mode marker says early-warning cannot restart a credential window. One with an unreadable mode
  is admitted to it (fail closed, same as rule 5 for lanes).

### D2 — One window per cell, and a cell resets only on its own fingerprint

- A **cell** is a runtime × builder pair. Its window key is its lane id: the lanes that exist
  today map as `node` = node × turbopack, `bun` = bun × turbopack. New cells take lane ids of the
  form `<runtime>-<builder>`. `CREDENTIAL_CELLS` in the audit lists every supported cell and
  whether it is wired to a credential cron yet.
- Streak continuity is keyed on the cell's **fingerprint**, not on the ref. Cutting rc.N+1
  therefore restarts only the cells whose fingerprint actually moved. The fingerprint stays
  **tarball-inclusive** (ADR-0039, not narrowed).
- **v1.0 is met when every supported cell has banked 14 consecutive qualifying credential
  nights** (`auditCredentialMatrix(...).allMet`). A cell with no credential lane wired is *not
  met*. It is never treated as vacuously passing.

### D3 — The harness digest hashes the workflow that ran

GitHub runs a scheduled workflow from the default branch. On a credential night the *scripts,
manifest and packed tarballs* come from the RC tag, but the *workflow YAML* is `main`'s. So the
fingerprint's `.github/workflows/test-e2e-deploy.yml` entry is now read from a sparse checkout of
`github.workflow_sha` (`--workflow-file`). Without this, the digest would hash the RC's copy of a
file that did not run. On early-warning nights the executing commit *is* the checkout, the bytes
are identical and the digest does not move. This is ADR-0039 Amendment 1.

## Options considered

| option | pro | con | verdict |
|---|---|---|---|
| **Scheduled credential crons on `main` that check out a pinned RC tag; per-cell windows keyed on fingerprint** | keeps the audit's "scheduled only, first attempt only" anti-inflation rules intact; one run per cron, so no night can be bought by dispatching; a restart is a deliberate RC cut | the executing workflow file is `main`'s, so a `test-e2e-deploy.yml` edit on `main` restarts every credential cell (D3 makes that visible rather than silent); `main`'s workflow must stay compatible with the RC's scripts; doubles nightly compute once rc.1 exists | **chosen** |
| A `main` cron that `workflow_dispatch`es `test-e2e-deploy.yml` **at the RC tag** | the whole tree — workflow included — is the frozen RC | credential nights become `workflow_dispatch` events, so the audit loses its "scheduled only" rule; a maintainer can dispatch extra green runs at the tag and bank 14 nights in a day unless a forgeable provenance token is added | rejected: it trades the strongest existing anti-inflation property for tidiness |
| Auto-resolve the latest `v*-rc.*` tag instead of a pin file | cutting rc.N+1 is one action (push a tag) | a stray or mistyped tag silently becomes the credential; nothing is reviewable or testable in-repo | rejected: the pin is a reviewed PR, and cutting is rare enough to afford two steps |
| Keep counting `main`, narrow the fingerprint to "what matters" | no RC process | ADR-0039 already records that narrowing was wrong: `dist/cli/**` shares chunks with the adapter, so there is no seam | rejected (ADR-0039) |
| Keep counting `main` under a merge freeze | no new mechanism | ~2 weeks of frozen `main` per attempt, and pack-order races (#850 comments) flip the digest even under a freeze | rejected: measured unreachable |
| Repository variable (`vars.*`) for the RC ref | no file | not reviewable, not testable, invisible in `git log` | rejected |

## Consequences

- **A credential count can now only be advanced by a scheduled run on an RC tag.** `main`
  nightlies keep alerting as before (early warning), but they are invisible to the credential
  window. Guarded by `tests/compat-credential-ref.test.ts` (guards 1–3 below).
- **Nothing credentials until rc.1 is cut.** The credential crons refuse, visibly and without
  issue spam, while the pin is `null`. Cutting rc.1 is gated on every cell's prerequisites: the
  webpack builder (#1219), compiled bytecode bun-standalone (#1166), the bytecode-live check
  (#1221), and vinext × node compile-cache wiring.
- **Shared code restarts every cell.** All cells install the same packed `@getknext/*` tarballs,
  so a change to shipped package bytes moves every cell's fingerprint. D2's "only the cells whose
  fingerprint changed" is therefore selective only for cell-specific inputs (the Bun build, a
  cell's deploy script). This follows from keeping the fingerprint tarball-inclusive and is
  accepted deliberately.
- **`test-e2e-deploy.yml` is effectively frozen during a credential window** (D3). An edit
  restarts every credential cell on this workflow, even though the RC tag did not move.
- **Operational coupling:** `main`'s workflow drives the RC's scripts. A `main` change that calls
  a script flag the RC does not have makes the credential night go red, loudly, and the remedy is
  to cut a new RC. It cannot silently pass.
- **Compute:** once rc.1 exists, four 16-shard nightlies instead of two. Whether to thin the
  early-warning `main` nightlies (e.g. to weekly) is left to the founder. Nothing here decides it.
- **Cutting rc.N+1 takes two steps:** push the tag, then merge a PR that bumps the pin.

### Guards (mutation-proved by exit code)

1. A `main`-ref night never increments a credential window: 14 green early-warning nights leave
   the credential count at 0, and interleaved `main` nights neither extend nor break an RC streak.
2. A fingerprint change for cell X restarts X's window and not cell Y's, and a ref change with an
   unchanged fingerprint (rc.1 → rc.2) does not restart it.
3. The credential lane refuses to run when no RC ref is resolvable. A missing, `null`,
   malformed or unresolvable pin never falls back to `main`.

## Action items

- [x] `scripts/compat-credential-ref.mjs` + `.github/compat-credential-ref.json` (pin = `null`).
- [x] `test-e2e-deploy.yml`: `credential-ref` first job (markers + resolve), credential crons,
      RC checkout in `build-next` / `shard-ledger`, executing-workflow fingerprint, mode-aware alert.
- [x] Ledger records `compatMode` / `credential` / `knextRef` / `knextSha` / `workflowSha`.
- [x] Audit: credential scope by default, `--scope early-warning`, mode marker,
      `CREDENTIAL_CELLS` + `auditCredentialMatrix`.
- [x] `docs/V1_ROADMAP.md` §3, `docs/compat/window-{node,bun}-lane.md` amended.
- [ ] **Wire the remaining cells** as their builders land: vinext × bun (`compat-vinext.yml` is
      weekly and has no credential mode yet), vinext × node, webpack × {node, bun}. Each needs a
      credential cron, the same `credential-ref` job, and a lane id of the form
      `<runtime>-<builder>`. Until then `allMet` is false by construction.
- [ ] **Founder:** cut `v1.0.0-rc.1` and bump the pin once the prerequisites above have landed.
- [ ] **Founder (open, not decided here):** whether to thin the early-warning nightlies, and
      whether the *harness* half of the digest should ever be scoped per cell. Today a
      vinext-only `scripts/e2e-deploy-vinext.sh` change moves the turbopack cells' harness digest
      too, because `HARNESS_ROOTS` scans `scripts/e2e-*`. Narrowing that is an ADR-0039 scope
      change, so it is left to the founder.
- [ ] `docs/compat-matrix.md`: restate the official-suite row as the per-cell credential once the
      first cell banks 14 RC nights.

## Amendment 1 (2026-09-24): liveness grading, per-cell fingerprint closure, the freeze guard, and the v1.0 cell set

- **Status:** **Proposed (2026-09-24).** Trigger-class (it changes what counts as a credential
  night), so it needs founder review before merge. D4 and D5 record mechanisms already merged
  (#1280, #1312). D6 records one that is planned (#1302). D7 records the founder decision on
  #1295 (see ADR-0058).
- **Implements:** #1303 (b). **Relates to:** ADR-0039 Amendment 1 (the executing-workflow
  entry), ADR-0054 Amendment 7 (mandatory bytecode), ADR-0058 (the four-cell v1.0 scope),
  ADR-0059 (the image bake the node grade exercises).

### Context

The Decision above defines a credential night by ref, mode and fingerprint. Three things have been
added to that definition since it was accepted, and one decision has changed which cells it
applies to:

1. **Bytecode caching must be proven live, not configured** (founder, #1218; built in #1280). A
   night whose server ran without its bytecode mechanism is not a night of the shipped artifact.
2. **vinext × bun runs from a second workflow.** `compat-vinext.yml` builds and boots the compiled
   vinext exec, while D3 hashed `test-e2e-deploy.yml` for every lane. An edit to
   `compat-vinext.yml` therefore moved no fingerprint (#1294).
3. **D3 left the executing workflow unguarded.** "`test-e2e-deploy.yml` is effectively frozen
   during a credential window" (Consequences) is a consequence, not a guard. Nothing stops an edit
   that restarts every cell.
4. **Founder, 2026-09-24 (#1295, ADR-0058):** v1.0 credentials four cells, and the vinext cells
   get no window in v1.0.

### Decision

#### D4. A credential night requires bytecode caching proven live on every shard

- **One definition**, in `scripts/e2e-bytecode-liveness.mjs`, shared by the deploy script (per
  deploy), the workflow (per shard) and the audit (per night). It is keyed on the cell's
  **runtime**, so a lane wired later inherits it by writing the same evidence lines (`:45-46`).
- **Bun:** the deploy booted the compiled exec (`mode=compiled-exec`), and the fail-closed
  build-time verifier passed on that file (`bytecode_verified=true`) (`:150-163`).
- **Node:** the shipped bake driver succeeded (`compile_cache_bake=ok`), and V8 accepted cached
  code at boot (`:165-203`). The counts come from the running server's own
  `NODE_DEBUG_NATIVE=COMPILE_CACHE` output, scoped to modules under the standalone tree, so the
  supervisor's own modules are excluded (`countNodeCompileCache`, `:100-114`), up to readiness.
  The constants are:
  - `NODE_CACHE_ACCEPTED_FLOOR = 100` accepted entries (`:64`);
  - `NODE_CACHE_HIT_RATIO_FLOOR = 0.5`, where the ratio is accepted / (accepted + missed +
    rejected) (`:67`).

  Measured on a real Next 16.2 standalone server with the shipped bake and supervisor: baked
  424 / 0 / 0, unbaked 0 / 425 (`:31-36`). The floors sit far from both ends, so neither a
  smaller fixture nor a Next.js refactor that moves a few modules flips the verdict. A populated
  cache directory is **not** evidence, because Node writes one on exit even after a cold boot
  (`:28-29`).
- **Where it is enforced:** per shard, the "Verify boot-mode ledger" step fails the job when a
  shard is not live (`test-e2e-deploy.yml:1727-1743`). Per night, audit rule 7
  (`compat-window-audit.mjs:481-494`) disqualifies the night when any shard's evidence is
  missing, is for the wrong runtime, or has `live < deploys` (`isShardBytecodeLive`,
  `e2e-bytecode-liveness.mjs:248-271`). A non-live night **restarts** the streak. It is not
  skipped.
- **The harness warms fixtures that do not answer 2xx.** The upstream fixtures have no health
  route and are often built to 404 or 500, and a rendered error page still loads the server
  runtime. So the harness renders a server route and accepts any complete HTTP response, through
  `KNEXT_WARM_ACCEPT_ANY_STATUS=1` (`scripts/e2e-deploy.sh:591-630`). A connection error still
  fails. It also snapshots and restores the fixture tree around the bake, so that only the
  compile cache survives (`:617-638`). The product default stays strict 2xx. **(RESOLVED, #1299.)**
  The knob no longer lives in the shipped bake template — `knext-compile-cache-bake.mjs.hbs` reads
  no such variable and is unconditionally strict. The harness interprets
  `KNEXT_WARM_ACCEPT_ANY_STATUS` itself now, in `scripts/e2e-bake-accept.mjs`, a harness-owned
  wrapper that spawns the shipped driver as a child and re-derives the tolerant verdict from its
  stdout + exit code — the driver's own bytes, and what a real user's `docker build` runs, are
  unaffected either way.
- **Trust assumption, stated:** only lines that begin with Node's own `[compile cache]` prefix
  count, so an app cannot manufacture a hit by logging the phrase mid-line. A process that writes
  a whole line with that prefix could. The code under test is the pinned upstream fixtures plus
  knext's own tarballs, so this is a check against knext regressing, not against a hostile
  fixture (`e2e-bytecode-liveness.mjs:83-89`).
- **Mutation-proved:** `scripts/mutation-prove-bytecode-liveness.mjs`, 9 of 9 mutations caught
  (#1280).

#### D5. Each cell's fingerprint hashes its own executing workflow and the full closure it runs

- **One declared table.** `CREDENTIAL_CELLS[*].workflowFile` (`compat-window-audit.mjs:152-161,
  176-244`) names the workflow that executes each cell: `test-e2e-deploy.yml` for the turbopack
  cells and `compat-vinext.yml` for vinext × bun. It is `null` for the cells with no workflow yet
  (both webpack cells, and vinext × node, whose only candidate workflow runs the wrong runtime).
  `workflowRootForLane` throws on `null` (`compat-window-fingerprint.mjs:338-350`), so an unwired
  cell cannot be fingerprinted by guessing. D3's executing-workflow override still applies on
  credential nights.
- **The closure is extracted by a parser, not a tokenizer.** The `e2e-*` harness scripts are
  closure entries (`compat-window-fingerprint.mjs:117-122`). Their local JS imports are found
  with the TypeScript parser (`:102`, `jsLocalImportSpecifiers` at `:168`). A non-literal
  specifier is **refused** with an error that names the file and line (`:219`), because a guess
  about whether it is a relative path is exactly what the freeze cannot afford. Three rounds of a
  hand-written tokenizer each found a new hole (#1294), which is why the parser was chosen.
- **Declared extras.** `extraFiles` lists the files a cell's run executes by subprocess or reads
  directly (the RC pin, `compat-run-ledger.mjs`, `compat-credential-ref.mjs`), because no import
  or `source` statement reaches them (`compat-window-audit.mjs:163-175`). Each extra is walked as
  a closure entry, so its own imports are frozen too. A declared extra that does not exist is a
  hard error (`compat-window-fingerprint.mjs:440-458`).
- **An independent scan keeps the table honest.**
  `tests/compat-window-fingerprint-execution-scan.test.ts` re-implements the discovery on its own.
  It scans the real workflow `run:` steps and every harness script for `node`, `bash`,
  `${SCRIPT_DIR}` and `${KNEXT_REPO_ROOT}` references, and fails when a repo file it finds is
  neither declared nor on its reasoned, dated exemptions list. Mutation-proved by
  `scripts/mutation-prove-compat-cell-fingerprint.mjs` (3 of 3 caught, #1312).
- **Unchanged:** the fingerprint stays tarball-inclusive (ADR-0039). The shared harness roots are
  still shared by every cell, so a `scripts/e2e-*` change moves every cell's digest. Scoping the
  harness half per cell is still an ADR-0039 scope question for the founder, as the action item
  above says.

#### D6. While an RC is pinned, the executing credential inputs are frozen on `main` (planned, #1302)

- A **required check** fails any PR that touches an executing credential workflow
  (`test-e2e-deploy.yml`, `compat-vinext.yml`), `scripts/e2e-*`, or any other fingerprint input,
  whenever `.github/compat-credential-ref.json` has a non-null `rcTag`. The one exception is an
  explicit, dated, founder-approved RC bump.
- The file set is **derived from the same tables the fingerprint reads** (`workflowFile`,
  `HARNESS_ROOTS`, `extraFiles` and the closure). It is not a second hand-kept list, so the guard
  cannot drift from what is actually frozen.
- When the pin is `null`, the guard is green, because there is no window to protect.
- **Exit:** mutation-proved in both directions. An edit while frozen goes red, and the same edit
  with the pin cleared goes green.
- **Until #1302 merges, this is documented practice, not enforcement,** and rc.1 must not be cut
  without it.

#### D7. v1.0 windows exist only for the four credentialed cells

- Per ADR-0058, v1.0 is met when node/bun × turbopack/webpack have each banked 14 qualifying
  credential nights. D2's "every supported cell" now reads "every v1.0-credentialed cell".
- **vinext × bun and vinext × node get no 14-night window in v1.0.** `compat-vinext.yml` stays
  weekly and early-warning. It gets no credential cron, its number is published as a measurement,
  and it does not run the D4 liveness step. It gets a window only once one full run is green or
  its failures fit a bounded, dated ledger (#1321), and it joins the credential set through an
  amendment to ADR-0058.
- The vinext cells **stay in `CREDENTIAL_CELLS`**, because D5's `workflowFile` table is what
  freezes `compat-vinext.yml`. What changes is the v1.0 verdict. `auditCredentialMatrix` counts
  every listed cell by default (`compat-window-audit.mjs:763-783`), so it needs a v1.0-scope
  field. That is an ADR-0058 action item.

### Options considered

| Decision | Option | Verdict |
|---|---|---|
| D4 node liveness | **Observed V8 acceptance at boot, with count and ratio floors** | **chosen**: it is the only one that proves the cache was used |
| | `NODE_COMPILE_CACHE` is set (configuration) | rejected: configured is not live, and the node lane booted with no cache at all before #1280 |
| | The cache directory is populated | rejected: Node writes the directory on exit, so a cold boot leaves one too |
| D4 harness warm | **Any complete response on a server route (internal knob), tree restored after** | **chosen** (jev 0.94 on #1259) |
| | Warm a static asset | rejected: serving a file compiles no server code (jev 0.05) |
| D5 closure | **Parser-extracted imports + declared extras + an independent scan** | **chosen** |
| | A hand-kept file list | rejected: it drifts silently, which is how `compat-vinext.yml` went unfrozen |
| | A hand-written tokenizer | rejected: three review rounds each found a new hole (#1294) |
| D6 freeze | **A required CI check keyed on the pin** | **chosen** |
| | A documented convention | rejected: its efficacy is unobservable until it has already failed (`security.md`) |
| | Branch protection or CODEOWNERS | rejected: it gates who may approve a change, not whether the credential inputs change |
| D7 vinext windows | **No window until green or bounded** | **chosen (founder)**: a window now would red every night on about 60 deterministic failures |

jev (jev-1.13.0), on a fact sheet with D4–D7: required CI check p = 1.00 (confidence 1.00);
observed-acceptance liveness p = 1.00 (confidence 1.00). It gave 0.74 that these belong in an
amendment rather than a new ADR, and 0.90 that the harness knob in the shipped template is worth
recording as an open item.

### Consequences

- **A green suite on an uncached server is no longer a credential night.** A regression that
  quietly drops the bake, or boots `server.js` on a Bun cell, restarts the window and reds the
  shard, which is loud rather than silent.
- **The liveness floors are frozen inputs.** `e2e-bytecode-liveness.mjs` matches the `e2e-*`
  harness glob, so lowering a floor moves every cell's fingerprint and restarts the window.
  Loosening the grade to rescue a streak is visible by construction.
- **The node grade depends on the image bake contract** (ADR-0059). A change there, such as the
  network restriction or the framework-only opt-out, has to keep the harness's shipped-driver
  path producing the same evidence line.
- **Editing `compat-vinext.yml` moves the vinext × bun fingerprint and not the turbopack ones.**
  Measured by #1312. It matters now only for the weekly measurement, and later for the v1.x
  window.
- **Until D6 lands, one careless merge can restart every cell.** This is why #1302 is an rc.1
  prerequisite.
- **The vinext number keeps publishing without a liveness grade.** That is acceptable because it
  is not a credential. It must gain the D4 step before it can hold a window.

### Action items

- [x] Liveness definition, per-shard step, audit rule 7, and mutation prover. *(#1280)*
- [x] `workflowFile` table, parser closure, `extraFiles`, execution-scan test, and prover.
      *(#1312)*
- [ ] Freeze guard as a required check, derived from the fingerprint tables and mutation-proved.
      **rc.1 prerequisite.** *(#1302)*
- [x] Move `KNEXT_WARM_ACCEPT_ANY_STATUS` out of the shipped template into the harness, keeping
      the evidence line identical. *(#1299, `scripts/e2e-bake-accept.mjs`)*
- [ ] v1.0-scope field on `CREDENTIAL_CELLS` / `auditCredentialMatrix`. *(ADR-0058 action item)*
- [ ] Before vinext × bun gets a window: add the D4 liveness step to `compat-vinext.yml`, a
      credential cron and the `credential-ref` job, and amend ADR-0058.
