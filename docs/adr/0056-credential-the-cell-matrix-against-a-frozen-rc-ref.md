# ADR-0056: Credential v1.0 per runtime×builder cell, against a frozen release-candidate ref

- **Status:** Accepted (2026-09-23) — encodes two founder decisions recorded on #850 and #1218.
  The **mechanism** lands with this ADR; **cutting a release candidate is a founder action** and
  none is cut here. **Amended** by Amendment 1 (2026-09-24, Proposed): bytecode-liveness grading
  (D4), per-cell fingerprint closure (D5), the freeze guard (D6) and the v1.0 cell set (D7).
  **Amended** by Amendment 2 (2026-09-28, #1607): D1's "fourteen consecutive nights" is defined
  against the lane's own cron-derived UTC calendar, not sequence adjacency between the nights the
  audit happens to be handed — a scheduled cron GitHub never fires now breaks the streak instead of
  silently bridging it. **Amended** by Amendment 3 (2026-09-30, founder decision #1642): a
  credential slot GitHub never ran resets the cell's window, accepted deliberately; the #1640
  watchdog provides visibility. **Amended** by Amendment 4 (2026-09-30, Accepted, founder rule:
  highest jev score, #1553): a night may be graded VOID — bridged, not counted, not a reset — only
  when a knext-owned marker proves the failure happened before any knext code ran, at most one void
  night per open 14-night streak, recorded in the ledger so the audit can re-prove it.
  **Amended** by Amendment 5 (2026-10-08, Accepted, founder decision): the credential is **14
  consecutive green independent RUNS per cell**, not 14 nights — three scheduled runs per cell per
  day on both release lines, each counted only if it started at least 2 h after the previous
  counted run; every other rule unchanged.
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
- **Amendment (2026-09-28, #1605).** "A `main` night is *excluded*" above means an EXPLICIT
  `compatMode: 'early-warning'` night, never an absence of mode. A **resolved, scheduled,
  lane-matched night with no recorded `compatMode`** is not a `main` night by inference and is not
  excluded — it stays in the graded sequence and is *disqualified* (restarting the count) the same
  way any other non-credential ledger is, rather than being silently dropped before grading. The
  earlier implementation dropped it instead, which let a mode-less run bridge two streaks into one
  on `origin/main`.

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
  compile cache survives (`:617-638`). The product default stays strict 2xx. The knob lives in
  the shipped bake template today (`knext-compile-cache-bake.mjs.hbs:66-70`), which is an open
  item: #1299 moves it into the harness (see ADR-0059).
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
- [ ] Move `KNEXT_WARM_ACCEPT_ANY_STATUS` out of the shipped template into the harness, keeping
      the evidence line identical. *(#1299)*
- [ ] v1.0-scope field on `CREDENTIAL_CELLS` / `auditCredentialMatrix`. *(ADR-0058 action item)*
- [ ] Before vinext × bun gets a window: add the D4 liveness step to `compat-vinext.yml`, a
      credential cron and the `credential-ref` job, and amend ADR-0058.

## Amendment 2 (2026-09-28): the missing-night calendar, #1607

- **Implements:** #1607. **Amends:** D1's counting rule.

### Context

D1 says "the audit counts only credential nights" and describes disqualifying a night whose ledger
could not be read (rule 5 in `scripts/compat-window-audit.mjs`). That rule protects a run that
*existed* — `gh run list` named it — but left no gradeable artifact. It has nothing to attach to a
scheduled cron GitHub never fired at all: a scheduled-workflow run dropped under load, a workflow
GitHub auto-disables after 60 days with no commits, or a platform outage. None of those produce a
`gh run list` row, so before this amendment `auditWindow` never even knew to look — it only checked
whether consecutive **graded** nights shared a fingerprint (sequence adjacency), never whether they
were also on consecutive **calendar** UTC dates for the lane's own cron. A dropped night on an
otherwise-unchanged fingerprint would silently bridge the streaks either side of it into one that
never actually ran on the day in between — exactly the failure mode rule 5 exists to prevent for a
lost ledger, left open for a night that never happened.

### Decision

`auditWindow` derives each lane's expected UTC night calendar from its own credential cron and
checks it before computing streaks:

- The cron is **read from the workflow**, not hardcoded — `parseCredentialCronsFromWorkflow` reads
  the `on.schedule` list and the `KNEXT_COMPAT_MODE`/`KNEXT_LANE` expressions and cross-checks them,
  so a moved cron or a newly-wired lane is picked up automatically. It tolerates formatting (quote
  style, operand order, block scalars) but **throws** on meaning it cannot read: a schedule clause
  in an unknown shape, a credential cron missing from `on.schedule`, a non-daily cron, or a wired
  cell left with no cron.
- **Nights are dated by cron slot.** Each run belongs to the latest cron fire time at or before its
  `createdAt` (`gh run list`'s enqueue time, threaded through as `scheduledAt`) — never the
  wall-clock UTC date, which scheduler delay can push past midnight. One slot is one night: two
  runs in the same slot are both disqualified (`duplicate-slot`, the first-attempt-only rule's
  territory), never counted twice.
- For every slot from the earliest graded night through a bounded cutoff, a slot with **no graded
  night at all** becomes a synthetic `missing-night` stand-in — graded exactly like a rule-5
  unresolved night: disqualified, restarting the streak, counted, never silently skipped.
- **Grace, not zero tolerance.** A slot only counts as required once its own fire time plus a grace
  window (`MISSING_NIGHT_GRACE_HOURS`, 10h — headroom over the run's own "better part of an hour"
  documented duration, plus queueing delay) has passed, so a night still plausibly in flight is
  never mistaken for one that never happened.
- **Fail closed when the calendar cannot be verified.** The check needs a scheduling timestamp on
  every graded night and a resolvable cron. When either is missing, or the parser throws, the
  window reports `calendarChecked: false`, `verdict: CALENDAR UNVERIFIED` and **`met: false`**
  however long the streak reads; the report, the `--matrix` view and the tracker say CALENDAR
  UNVERIFIED, never GATE MET. (`--dir` ledgers carry no timestamp, so they can inform but never
  bank a credential.)
- **Scoped to `scope: 'credential'` only.** The four v1.0 cells' own crons are what a "fourteen
  consecutive nights" claim is ever made against (this ADR's own subject); an early-warning `main`
  streak is a forecast with no such claim to protect (`docs/compat/window-node-lane.md`'s own
  words), so extending the same cron-derived calendar there was judged additional blast radius for
  no bar currently gated on it.

### Consequences

- A v1.0 credential claim can no longer be inflated by a night GitHub silently failed to run at
  all, closing the gap D1's own ledger-loss handling left open.
- `--dir`-based historical review (the pre-`--fetch` workflow this ADR's own window-node-lane.md
  history was reconstructed with) is now **unverified** on this axis unless the input carries
  `scheduledAt` — and an unverified window can never meet the gate.
- One credential cron per lane is assumed (`parseCredentialCronsFromWorkflow` throws otherwise) —
  correct for every wired v1.0 cell today; a future design that runs a lane's credential night on
  more than one cron would need this amended again.

## Amendment 3 (2026-09-30): a credential slot GitHub never ran

- **Status:** Accepted (2026-09-30, founder decision #1642). **Amends:** D1 and Amendment 2
  (the missing-night calendar).
- **Relates to:** #1640 (the read-only credential-slot watchdog), #1649 (the rc.2 harness batch
  that raises the grace).
- **Trigger-class:** ADR + CI + release process — flagged for the sprint-close design review.

### Context

Amendment 2 made the audit date every night by its cron slot and turn a slot with no run into a
`missing-night` that restarts the 14-night streak, once the slot's fire time plus
`MISSING_NIGHT_GRACE_HOURS` has passed. Two things happened in the week of 2026-09-22:

1. **Delay.** GitHub started scheduled credential runs up to 6h13m after their cron fire time
   (the bun credential slot, 05:47 UTC, ran at about 12:00). Under the grace in force then (6h), a
   night that was only queued read as missing. #1649 raises the grace to **10h**, which covers the measured worst
   case with about 4h of headroom and still resolves each slot long before the next one fires.
2. **Drop.** GitHub documents that scheduled workflows can be delayed, and under load dropped,
   by its scheduler. A delay is now absorbed by the grace; a drop is not. ADR-0056 has no remedy
   for a night GitHub itself never ran: the slot becomes a `missing-night`, and the cell's window
   resets.

The question was what the credential should do about a dropped slot.

### Options considered

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Slot-stamped backfill** | When a slot has **no run at all** at grace expiry, one `workflow_dispatch` run is started for that lane, stamped with the missing slot. The audit counts it as that slot's night only if it is the first and only backfill for the slot, runs on the same RC commit with the same window fingerprint, is a first attempt, and was started before the next slot fires. | A GitHub scheduler fault no longer costs up to 14 nights per cell. | Changes D1 ("a credential night is a scheduled night; dispatches never count"). Adds a path that can mint a credential night, which needs its own authorization story (who or what may dispatch, how the audit tells a sanctioned backfill from any other dispatch) and its own guards. #1640's watchdog is read-only by design; this makes something dispatch. More harness code inside the frozen set. |
| **B. Accept the reset risk (chosen)** | A slot GitHub never ran stays a `missing-night` and restarts the streak. Delay is handled by the 10h grace; visibility by the #1640 watchdog, which alerts when a slot is late or missing. | Keeps D1's definition exact: every counted night was scheduled and ran unattended. No new write path into the credential. Nothing new to guard. | A true drop costs the cell its window (up to 14 more nights). The GA date absorbs that risk. |
| C. Excuse N missing nights per window | Allow, say, one missing slot per 14-night window without a reset. | Simple to implement. | Weakens "fourteen consecutive nights" for every cause of a missing night, not only GitHub drops. The audit cannot tell a scheduler drop from a broken lane. |

### Decision

**Accept the reset risk.** A credential night stays a scheduled night; a slot GitHub never ran
is a `missing-night` and restarts the cell's streak, as Amendment 2 already specifies.

Why B over A (slot-stamped backfill dispatch) and C (excusing missing nights, rejected because it weakens "fourteen consecutive nights" for every cause of a missing night, and the audit cannot tell a scheduler drop from a broken lane): the credential is a public
claim that a cell passed on fourteen consecutive unattended nights on a frozen tag. Its value is
that nobody chose which nights counted. A backfill path keeps the tag and fingerprint fixed, but
it reintroduces a dispatch that counts, and that dispatch then has to be authorized, rate-limited,
audited and guarded against cherry-picking. All of that sits inside the frozen harness during a
live window. The delay problem that actually happened this week is fixed by the 10h grace. What
remains is outright drops, which have not been observed on these crons, only read about. If drops
do start costing windows, this amendment should be revisited with measured drop counts, and a
backfill design is the fallback.

### Consequences

- No change to D1, the audit, or the harness beyond the grace bump that #1649 already carries.
- The #1640 watchdog is the operational answer. It alerts on a late or missing slot, so a drop is
  seen the same morning, not at the next audit.
- A dropped slot resets that cell's window. The rc.2 → GA plan should keep slack for one reset per
  cell.
- **Revisit trigger:** two or more `missing-night` resets in one release cycle that the watchdog
  attributes to GitHub (no run created at all for the slot), not to a lane failure.

## Amendment 4 (2026-09-30): a bounded VOID grade for a proven pre-knext failure (#1553)

- **Status:** Accepted (2026-09-30, founder rule: highest jev score — option B scored 0.90 against
  0.10 for A and 0.00 for C). **Amends:** D1's counting rule (rule 9 in
  `scripts/compat-window-audit.mjs`'s header). **Implements:** #1553, raised from the #1550 round-1
  review of #1520.
- **Relates to:** #1520/#1550 (the `kind: 'deploy'` label, which this amendment does NOT grant a
  VOID grade — see Context), Amendment 3 above (whose Option C — excusing N missing nights per
  window unconditionally — was rejected for a reason this amendment takes care not to repeat).
- **Trigger-class:** ADR + credential-window counting rule — flagged for the sprint-close design
  review.

### Context

#1520 proposed grading a night whose only redness was a `kind: 'deploy'` shard failure as VOID —
bridged over the streak, neither extending nor resetting it — on the theory that a `createNext`
deploy-script/harness failure is evidence-free about the knext ref under test. The #1550 round-1
review found the naive form unsound on three counts, all still true and none of them repealed here:

1. **A `kind: 'deploy'` failure is not reliably evidence-free.** `scripts/e2e-deploy.sh` runs
   `next build` through the knext adapter under test and boots the knext server, so "Custom deploy
   script failed" is *also* what an adapter build crash or a server crash-on-boot reports. Grading
   it VOID would let a real product regression go uncounted.
2. **Unbounded bridging inflates the streak.** 13 green + N void + 1 green reading as a 14-night
   streak, for any N, is exactly the shape a later #1604 round-1 attempt (an "invalid night pauses
   the streak" semantic for the operator-digest guard) reproduced and had rejected on the identical
   fixture: 13 green + 30 invalid + 1 green read `current=14, met=true`, and nothing in that case
   had touched a cluster at all.
3. **Message shape is not a safe per-file classifier.** Mixed files, retries and echoed logs mean a
   shard's `kind: 'deploy'` count cannot be trusted to partition cleanly from a real assertion
   failure without the count-match guard `isDeployOnlyRedShard` already carries.

Round 2 (#1550, lead-directed) therefore removed the VOID grade entirely: a deploy-classified red
disqualifies a night exactly like any other red, labelled only for readability. That is unchanged
by this amendment. #1553 asked the sprint-close design gate a narrower question the round-2 fix
deliberately left open: **is a VOID grade acceptable at all, and if so under what proof?**

Amendment 3 above answered an adjacent question — whether to excuse a *missing* night — and its
Option C ("excuse N missing nights per window") was rejected because "the audit cannot tell a
scheduler drop from a broken lane." A VOID grade for #1553 must not repeat that mistake: it must
excuse nothing by *absence* of information, only by *proof*.

### Decision

**A night may be graded VOID only when a knext-owned marker proves the failure happened before any
knext code ran**, bounded to **at most one void night per 14-night window per cell**, recorded in
the ledger so the audit can re-prove the exemption from the ledger alone.

#### The marker: what it is, and why it cannot be knext's own failure wearing a costume

The marker is a **preflight WORKFLOW STEP's own output**, never the deploy-test harness's — the
same structural guarantee `scripts/compat-disk-floor-check.mjs`'s `kind: 'infra'` failure already
relies on (its header: "the workflow step — not this script — writes the shard's OWN summary JSON
directly"). Concretely, a shard's credential run has (at least) three phases in strict sequence,
enforced by GitHub Actions' own step ordering (a step does not run once an earlier one without
`continue-on-error` has failed):

1. **`runner-setup`** — checkout, toolchain install, cache restore.
2. **`dependency-install`** — resolving/restoring/reinstalling next.js's own harness dependencies
   and hydrating next.js's own prebuilt build closure from published tarballs, so the jest harness
   can discover and load deploy tests.
3. **`cluster-bringup`** — kind/cluster provisioning, if the cell needs one, before a single
   `next build` or server boot runs for this shard's first deploy-test file.

**Correction (round 2, #1553, 2026-09-30 — review finding).** The line above originally read
"`dependency-install` — installing the packed `@getknext/*` tarballs under test (installing them is
not running them — no adapter code executes here)". That was wrong, and the wiring round it
described matched the wrong text: `scripts/e2e-preflight.mjs` — the step that actually installs the
packed `@getknext/*` tarballs — npm-installs them into a scratch dir, resolves
`@getknext/core/adapter`, and dynamically **imports** `@getknext/db/migrate` (the exact import
`kn-next db migrate` performs at runtime). That is knext code executing, not merely "installing", and
the first wiring round had placed that step, plus a `chmod` of knext's own lifecycle scripts, INSIDE
the `dependency-install` phase's fault-detection window — before "Mark dependency-install phase
complete". A genuine knext packaging bug caught there would have graded `kind: 'pre-knext'` and could
have bridged a credential streak over a real regression, the exact failure mode this whole amendment
exists to rule out. Fixed by moving both steps to run AFTER the `dependency-install` phase's marker
and detector, with their own `failure()`-gated detector ("Adapter-tarball preflight fault detector
(#1553 round 2)") that writes `kind: 'deploy'`, not `kind: 'pre-knext'` — per `isDeployOnlyRedShard`
(below), a `kind: 'deploy'`-only red is never void-eligible, so this failure mode now always resets
the streak like any other real defect. The steps that remain INSIDE the `dependency-install` window
are exactly the ones the corrected phase-2 description above lists — generic next.js-harness
tooling only, verified step-by-step against `.github/workflows/test-e2e-deploy.yml` and locked by an
explicit per-phase allowlist test (`tests/compat-suite-workflow.test.ts`, "pre-knext phase boundaries
stay knext-free").

A dedicated preflight step runs at the end of phase 3, immediately before the per-file deploy-test
loop starts. If, and only if, an earlier phase failed, this step — and *only* this step — writes the
shard's summary JSON directly with a single synthesized failure `{ kind: 'pre-knext', phase:
'runner-setup' | 'dependency-install' | 'cluster-bringup' }`, `failed: 0`, `notRun: <the shard's
whole expected file count>` (nothing ran), and stamps the run's ledger with a **self-referencing**
`preKnextVoidMarker: { runId, lane, phase }` naming *this exact run and lane*. Two properties make
this provably NOT a knext failure:

- **It cannot run after knext code has.** The step that would write `kind: 'pre-knext'` is placed,
  and only fires, *before* the step that invokes `next build` through the adapter or boots the
  knext server for this shard. A knext adapter crash or server crash-on-boot — the #1550 round-1
  finding's whole point — happens *inside* the deploy-test harness, strictly *after* this point, and
  reports through the harness's own `kind: 'deploy'` path, never `kind: 'pre-knext'`. The two kinds
  are therefore mutually exclusive by construction, not by convention.
- **It is self-referencing.** A marker naming a different `runId` or `lane` — copied, forged, or
  left over from a template — proves nothing about *this* night and is rejected (see "Fails
  closed" below).

`scripts/compat-window-audit.mjs`'s `isPreKnextVoidRedShard` grades a shard's redness
void-*labelled* on this shape (mirroring `isDeployOnlyRedShard`/`isInfraOnlyRedShard`'s existing
fail-closed conventions: `failedCount > 0` or `notRunCount === 0` is NEVER pre-knext; every named
failure must carry `kind: 'pre-knext'` AND a recognised `phase` — checked independently, so a
`kind: 'deploy'` failure carrying a forged pre-knext-shaped `phase` field still never classifies).
`isValidPreKnextVoidMarker` separately validates the ledger's `preKnextVoidMarker` against the
ledger's own `runId`/`lane`. A night is **void-eligible** only when (a) the marker validates and
(b) *every* disqualifier on the graded night traces back to a pre-knext-attributed shard — a
`bytecode-not-live` disqualifier on that SAME shard is allowed (a shard that never booted cannot
prove liveness either, and that absence is not itself evidence of a knext regression), but any
OTHER disqualifier — a bad ref, a rerun, a short ledger, a duplicate-slot, a red on a *different*
shard that is not itself pre-knext-attributed — makes the night NOT void-eligible. The marker only
ever excuses "this shard never ran"; it cannot launder anything else wrong with the night.

**This is honest about what it does and does not prove.** Exactly like D4's bytecode-liveness trust
assumption ("this is a check against knext regressing, not against a hostile fixture"), the
preflight step's provenance rests on the workflow YAML being what it says it is — the same trust
boundary every other ledger field in this ADR already sits on (D1's `credential`/`compatMode`
markers, D5's `workflowFile` table). It is not a defense against a compromised workflow; it is a
defense against the SPECIFIC hole #1550 found in the `kind: 'deploy'` heuristic — a real knext
failure wearing a matching message shape.

**Wired and proven live in this PR (lead-directed follow-up, 2026-09-30).** The producer — the
per-shard fault-injection input, the two phase-boundary markers, and the two `failure()`-gated
detector steps — is wired into `test-e2e-deploy.yml`, and `scripts/compat-run-ledger.mjs` builds the
self-referencing `preKnextVoidMarker` from the aggregated shard summaries. Proved live by two
`workflow_dispatch` runs on this branch, identified by their own `dispatchId` (never "latest"):

- **Fault run** (`preKnextFault=runner-setup`, dispatchId `1553-fault-runner-setup`), run
  [36648004813](https://github.com/getknext-dev/knext/actions/runs/36648004813): every one of 16
  shards reported `kind: 'pre-knext', phase: 'runner-setup'` (`failed:0, notRun:1`), and the
  `compat-run-ledger` artifact carried `"preKnextVoidMarker": {"runId": "36648004813", "lane":
  "node", "phase": "runner-setup"}` — self-referencing this exact run. Per-shard step trace
  confirms the intended sequencing: the fault-injection step failed, the runner-setup
  phase-complete marker was correctly SKIPPED (never marks a phase complete that didn't complete),
  the detector step ran and wrote the summary, every dependency-install-phase step and "Run
  official deploy tests" were skipped (default `success()` gating), and "Summarize shard result"
  did not clobber the honest summary with a false-green parse.
- **Normal run** (no fault, dispatchId `1553-normal-smoke`), run
  [36648007554](https://github.com/getknext-dev/knext/actions/runs/36648007554): concluded
  `success`; `preKnextVoidMarker: null`, no shard carries a `kind: 'pre-knext'` failure — the
  steady state is untouched.
- **Fed through the real audit code** (`gradeNight`/`auditWindow`), the fault run's actual ledger —
  byte-identical shard failures and marker, only the orthogonal "is this a scheduled credential
  night" fields overlaid, since a `workflow_dispatch` can never itself be one (ADR-0056 D1) —
  grades `voidEligible: true`, and spliced between 13 and 1 synthetic green credential nights on
  the same fingerprint, `auditWindow` reports `met: true, longest.nights: 14, streaks: 1,
  voidNights: [{runId, marker, date}]`: the exact 13+1+1=14 bridge this amendment specifies. An
  earlier pass of this same check, with the marker's `runId` left unrenamed to match a relabelled
  night, correctly reported `voidEligible: false` — the self-reference validation failing closed
  exactly as designed, not a defect.

No currently-banked or in-progress **credential** streak is affected: these are `workflow_dispatch`
early-warning runs (ADR-0056 D1 — a dispatch is never a credential night), and
`.github/compat-credential-ref.json`'s `paths`-scoped `rcBumpMarker` covers exactly the three files
this touches (`scripts/compat-window-audit.mjs`, `scripts/compat-run-ledger.mjs`,
`.github/workflows/test-e2e-deploy.yml`).

#### The bridging rule: exactly what "13 green + 1 void + 1 green = 14" means

A void-eligible night, when one is already open on the **same fingerprint**, **bridges** the
streak: it is spliced out of the sequence — counted as neither one of the fourteen required nights,
nor a reset. Fingerprint continuity is checked explicitly (not inferred): a void-eligible night
whose `windowFingerprint` differs from the currently-open streak's does NOT bridge, because the
fingerprint is what proves nothing else about the shipped bytes moved during the gap, and the
marker only ever excuses "this shard never ran" — it says nothing about what ran on adjacent
nights.

**"One void night per 14-night window" means: at most one bridge per currently-OPEN streak
attempt.** The budget (`auditWindow`'s `open.voidUsed`) is spent the instant the FIRST void-eligible
night in an attempt is bridged, and is refilled only when that attempt next restarts from zero (any
ordinary disqualifying reset, or a void-eligible night that could not bridge). Concretely:

- **13 green + 1 void + 1 green = a 14-night MET streak.** The void night is bridged (spliced out);
  the streak's own night-count goes 13 → (bridge, unchanged) → 14. `auditWindow` reports ONE streak
  of 14 nights, not two streaks of 13 and 1.
- **A SECOND void night before the streak next restarts is an ordinary reset**, not a second
  bridge — `open.voidUsed` is already true, so `canBridge` is false, and the night falls through to
  the same "night restarts the count" path any other disqualified night takes
  (`restartCause: 'night-void-unbridged'`, distinct from `'night-disqualified'` so a report never
  conflates "a proven exemption ran out of budget" with "an ordinary red").
- **A void-eligible night with NO open streak to bridge** (the very first graded night, or the
  night immediately after a reset) is also an ordinary reset — there is nothing on either side of it
  to splice it out of.
- **A void-eligible night whose fingerprint does not match the open streak** is also an ordinary
  reset, for the reason above.

This is deliberately a NARROWER shape than Amendment 3's rejected Option C ("excuse N missing
nights per window"): that excused an *absence* of information (no run at all) for *any* number of
nights up to a cap, and was rejected because the audit could not tell a scheduler drop from a
broken lane. This amendment excuses nothing by absence — it requires a *positive, self-referencing,
structurally-provable* marker for the ONE night it bridges, and every disqualifier that night
carries must trace back to that proof.

#### Recorded in the ledger so the audit can re-prove it

Every night `gradeNight` grades carries `voidEligible` (recomputed a second time inside
`auditWindow`, AFTER the rule-8 duplicate-slot pass, so a night that is ALSO a duplicate-slot
violation is never void-eligible on stale information) and, if `auditWindow` actually bridges it,
`bridgedVoid: true`. `auditWindow`'s own return value carries `voidNights` (every bridged night,
with its marker) alongside each `streaks[*].voidNights` (scoped to the one streak it bridged),
mirroring the existing `unresolvedNights` field's shape (rule 5) — a consumer does not have to
re-derive which run was excused or why; it is printed by `formatReport` as `VOID — bridged, not
counted (#1553)`, distinctly from the ordinary `NO — …` a non-bridged red (including a deploy- or
infra-classified one) still prints.

### Options considered

| Option | What it means | jev score | Verdict |
|---|---|---|---|
| **B. A bounded VOID grade, gated on a knext-owned pre-knext marker** | As decided above: proof-gated, one bridge per open streak, fingerprint-continuity-checked, fully recorded. | **0.90** | **chosen (founder rule: highest score)** |
| A. No VOID grade at all — keep #1550 round 2's answer permanently | Simplest; zero new surface in the frozen harness/audit. | 0.10 | rejected: leaves a real, previously-measured failure mode (run 36312054519, 419 files failed on a harness/deploy-script fault unrelated to the ref under test) with no path to ever being distinguished from a real regression, however strong the future evidence. |
| C. Grade any `kind: 'deploy'`-only red night VOID (the original #1520/#1604-round-1 shape) | Reuses the existing label; no new marker. | 0.00 | rejected: this is the exact shape #1550 round 1 and the #1604 round-1 review both already found unsound — `kind: 'deploy'` is not reliably evidence-free (a knext adapter/server crash reports through it), and unbounded bridging measurably inflates the streak (the 13+30+1 fixture). Repeating it here would undo round 2's fix. |

### Consequences

- **No currently-banked or in-progress credential streak is affected by this PR.** The producer is
  wired and proven live (see above), but only `workflow_dispatch` runs have exercised it so far —
  every credential cron still runs unmodified `main`/RC-tag code until this PR merges, and even
  then a real credential night simply CANNOT need the grace unless a genuine pre-knext fault occurs
  on one.
- **The credential's integrity is preserved, not traded for tolerance.** Every branch of the gate —
  the kind check, the marker's three self-reference fields, the credential-scope restriction, the
  fingerprint-continuity requirement, and the one-bridge-per-streak cap — is independently
  mutation-proven (`scripts/mutation-prove-compat-window-audit.mjs`, guards 18-25): removing any one
  of them is caught by a dedicated fixture in `tests/compat-window-audit.test.ts`.
- **A `kind: 'deploy'` red still always resets, marker or not.** This amendment does not reopen
  #1520/#1550 — the mutual-exclusion between `kind: 'deploy'` and `kind: 'pre-knext'` is structural
  (see "why the marker cannot be knext's own failure"), so a knext adapter/server crash can never
  acquire the grace this amendment grants.
- **The one-bridge-per-streak cap means a genuinely flaky pre-knext-only failure mode (e.g. a
  chronically unreliable cluster-bringup step) still eventually resets a streak** — the second such
  night in the same attempt is an ordinary reset. This is deliberate: repeated pre-knext failures on
  the SAME cell are themselves a signal the harness needs fixing, not indefinitely bridged over.

### Action items

- [x] Ledger schema (`preKnextVoidMarker`), shard-level classification
      (`isPreKnextVoidRedShard`, `PRE_KNEXT_PHASES`), marker validation
      (`isValidPreKnextVoidMarker`), night-level eligibility (`computeVoidEligible`,
      `everyDisqualifierIsPreKnextVoid`), and the bridging rule in `auditWindow`
      (`open.voidUsed`, `streaks[*].voidNights`, `audit.voidNights`).
- [x] `formatReport` prints a bridged night as `VOID — bridged, not counted (#1553)`, distinctly
      from an ordinary `NO — …` red.
- [x] Mutation-proved (guards 18-25, `scripts/mutation-prove-compat-window-audit.mjs`) and
      TDD'd (`tests/compat-window-audit.test.ts`, `#1553` describe block).
- [x] **Wire the producer**: a dispatch-only, default-off `preKnextFault` input plus, per phase
      (`runner-setup`, `dependency-install`), a fault-injection step, a phase-complete marker, and a
      `failure()`-gated detector in `test-e2e-deploy.yml`, writing the shard summary JSON and (via
      `scripts/compat-run-ledger.mjs`) the run-level `preKnextVoidMarker`. Proved live on two
      `workflow_dispatch` runs (fault + normal, run ids and the fed-through-the-audit result above).
- [x] **Round 2 (#1553, review finding, 2026-09-30):** moved the adapter-tarball preflight
      (`scripts/e2e-preflight.mjs`) and its `chmod` sibling OUT of the `dependency-install` phase's
      fault-detection window (they execute real knext code — see the Correction above) and gave them
      a dedicated `failure()`-gated detector writing `kind: 'deploy'`. Locked by an explicit
      per-phase step allowlist (`tests/compat-suite-workflow.test.ts`) and a `gradeNight`/
      `auditWindow` fixture for a MIXED night (some pre-knext shards, some genuinely red ones) never
      being void-eligible (`tests/compat-window-audit.test.ts`).
- [ ] `cluster-bringup` has no producer yet: `test-e2e-deploy.yml` runs no cluster today, so
      `PRE_KNEXT_PHASES` carries that phase name for a future cell that needs one, unproduced until
      then. Do not treat its absence as a defect in this PR.
- [ ] Verify on a real SCHEDULED night (early-warning `main` first, never a credential cron
      directly) that an UNPLANNED, genuine pre-knext failure — not the dispatch-only fault
      injection — produces a night the audit grades void-eligible, before ever relying on the grace
      on a credential cron.

## Amendment 5 (2026-10-08): fourteen consecutive green RUNS per cell, not fourteen nights

- **Status:** Accepted (2026-10-08, founder decision given to the lead in chat; jev 0.99 on the
  decision itself). **Amends:** D1 and D2 (the unit is a run, not a night), Amendment 2 (the
  calendar places every *fire* of a cell's cron, not one slot per day), Amendment 3 (a fire with no
  run still resets — unchanged in kind) and Amendment 4 (one VOID bridge per open streak — unchanged,
  now per open streak of runs).
- **Applies to both release lines:** v1.0 (`test-e2e-deploy.yml`, pin
  `.github/compat-credential-ref.json`) and the parallel v1.3 lane (`compat-credential-v1.3.yml`,
  derived by `scripts/compat-line-workflow.mjs`, pin `.github/compat-credential-ref-v1.3.json`).
- **Trigger-class:** ADR + credential window definition + CI capacity — flagged for the
  sprint-close design review.

### Context

D1 made a credential *night* a scheduled run on a frozen RC tag, and D2 required fourteen
consecutive qualifying nights per cell. Each cell ran once a day, so the shortest possible
credential was fourteen calendar days per cell, and any reset (a red, a fingerprint move, a dropped
slot) cost up to another fourteen. Release candidates were paced around that clock.

The founder's decision of 2026-10-08 replaces the time rule: **the credential is fourteen
consecutive green, independent, full-suite runs per cell, triggered per cycle.** Release candidates
are cut per milestone (the one-rc-per-day rule is gone). The bar itself is not lowered — still
fourteen, still the whole suite, still every integrity rule — but "consecutive" now counts runs.
Independence is the price of that: two runs that shared a runner window or a warm cache are not two
samples. The founder set three requirements: a minimum spacing of about two hours between counted
runs of the same cell, fresh caches (no warm reuse that would mask flakiness), and a separate runner
per run, within the shared pool's capacity (about three to four runs per cell per day, so about four
to five days to fourteen).

Measured before choosing anything (48 scheduled `test-e2e-deploy.yml` runs, 2026-10-01..08):

| Measure | Value |
| --- | --- |
| GitHub schedule delay (creation − cron fire) | 139–441 min (2.3–7.4 h), median 355 min; fires 01:00–06:00 UTC saw 5.3–7.4 h, fires 22:00–00:00 saw 2.3–4.0 h |
| Start − creation | 0 min on all 48 runs |
| Run duration | 36–66 min, median 48 |
| Pool | GitHub Free, 20 concurrent jobs; each run peaks at 8 shard jobs (`max-parallel: 8`) |
| Cells | 8 (4 v1.0 + 4 v1.3), plus 2 v1.0 early-warning runs a day |

### Decision

#### D8 — The credential unit is a run

A cell's window is met by **14 consecutive qualifying runs** (`WINDOW_REQUIRED_RUNS`). Every rule a
night had to satisfy, a run has to satisfy: scheduled (a dispatch never counts), first attempt, an RC
tag on the right line with the commit recorded, every shard green with the shard count matching,
bytecode caching proven live, the fingerprint continuous. A red run resets the count; a fingerprint
move restarts it. Docs still claim "verified" or "credentialed" only at 14/14.

#### D9 — Three scheduled runs per cell per day, from one cron literal per cell

Each credential cron is **one literal with a comma-listed hour field**, firing three times a day,
eight hours apart. `github.event.schedule` is the literal as written, so every env expression that
maps a cron to its lane, runtime, builder and mode keeps working unchanged, and a dispatch still can
never produce a credential run.

| Line | Cell | Cron (UTC) |
| --- | --- | --- |
| v1.0 | node × turbopack | `17 1,9,17 * * *` |
| v1.0 | bun × turbopack | `47 5,13,21 * * *` |
| v1.0 | node × webpack | `17 6,14,22 * * *` |
| v1.0 | bun × webpack | `47 7,15,23 * * *` |
| v1.3 | node × turbopack | `32 0,8,16 * * *` |
| v1.3 | bun × turbopack | `32 2,10,18 * * *` |
| v1.3 | node × webpack | `32 3,11,19 * * *` |
| v1.3 | bun × webpack | `32 4,12,20 * * *` |

Each v1.0 cell keeps its previous fire as one of the three. Together the two lines put exactly one
credential fire in every clock hour (24 a day); the two v1.0 early-warning crons (03:17, 04:47) are
unchanged. `:32` is a minute no other workflow uses.

Why eight hours: the audit places a run on the latest fire of *its own* cron at or before the run's
creation (D10), so the gap between a cell's fires must exceed GitHub's delay. The measured worst
delay is 7.4 h. Eight hours also keeps two runs of a cell at least 8 − (7.4 − 2.3) = 2.9 h apart
under the measured delay spread, above the two-hour spacing floor.

#### D10 — The audit counts runs on a per-fire calendar, with a spacing floor

- **Per-fire calendar (Amendment 2 generalised).** A run belongs to the latest fire of its cell's
  cron at or before its `createdAt`. Every fire is its own slot; a multi-fire cron's slot is labelled
  by fire time (`YYYY-MM-DDTHH:MMZ`), a once-a-day cron keeps its date label. A fire with no run once
  its fire time plus `MISSING_NIGHT_GRACE_HOURS` (10 h) has passed is a `missing-night` stand-in that
  restarts the count (Amendment 3, unchanged in kind: a dropped or deleted run cannot be bridged). Two
  runs in one slot are both `duplicate-slot`.
- **Delay longer than the fire gap fails closed.** A run delayed past its cell's next fire lands in
  that later slot: the earlier slot reads missing and the later one holds two runs. The cell resets;
  the streak is never stretched. A non-inflating repair (move the earlier of two runs back into an
  empty preceding slot) was considered and rejected: it would also hide a dropped fire followed by a
  GitHub double-fire.
- **Rule 10, spacing.** A green run counts only if it *started* (GitHub's `run_started_at`, threaded
  through `fetchLedgers` as `startedAt`, falling back to `createdAt`) at least
  `MIN_RUN_SPACING_HOURS` (2 h) after the previous **counted** run of the same streak. A run that is
  too close is **not counted and does not reset**: it is green, it is just not an independent sample.
  A recorded start that cannot be read fails closed (not counted). An undated run (offline `--dir`
  input) is counted but recorded in `spacingUnverified`, which holds `met` false — the same input
  already fails rule 8.
- **Every existing rule stands.** Wrong tag, dispatch, rerun, short ledger, bytecode not live, mode
  missing, fingerprint change, lost ledger, the bounded VOID bridge (now one per open streak of runs).

#### D11 — Independence: a separate runner and fresh caches for every counted run

- **A separate runner per run:** every job runs on an ephemeral GitHub-hosted VM, and scheduled runs
  get a concurrency group keyed on `run_id`, so no two runs share a runner or cancel each other.
- **Fresh caches:** every credential run starts cold. On a credential run
  (`KNEXT_COMPAT_MODE == 'credential'`, which only a credential cron can produce) every `actions/cache`
  step is skipped, so it neither restores nor saves: the next.js harness's pnpm store and the
  Playwright browsers are downloaded fresh. The Prepare job does not warm Playwright for a cache that
  nothing will save, `oven-sh/setup-bun` runs with `no-cache`, and `actions/setup-node` with
  `package-manager-cache: false`. Early-warning runs and dispatches keep the caches. The v1.3 lane
  gets the same rule from its derivation: a tag cut before this amendment (`nights` shape, rc.9) has
  the lines added by declared substitutions, and a later tag carries them itself.
  `tests/compat-credential-runs.test.ts` scans every step of both credential workflows, classifies
  each action by its cache behaviour, and fails on an unclassified action.
- **Cost (measured, then estimated).** On the 2026-10-08 01:54 run, whose caches had been evicted,
  the Prepare job's cold harness install took 27 s against 11-15 s warm, and the Playwright
  download 22 s; across four cold runs (2026-10-03..08) the download took 21-24 s. A shard skips a
  3-11 s cache restore and pays the same download and install, so each shard costs about 20-30 s more
  and the Prepare job about the same as before. With 16 shards run 8 at a time that is about one
  minute of wall clock and about seven job-minutes per run, against a median run of 48 minutes.
- **Risk.** Each credential run now downloads Chromium once per shard (up to 8 at once) instead of
  once per cache key. In an earlier throttled-network incident concurrent downloads timed out and
  the browser-driving tests failed. The download step retries four times with a 15-minute limit per
  attempt, and is non-fatal, so a CDN outage now reads as a red credential run, which resets the cell.
  That is the price of fresh caches, accepted rather than hidden.

#### D12 — The v1.3 lane gets the same schedule now, not at its next pin bump

The v1.3 workflow is derived from the pinned tag's own `test-e2e-deploy.yml`. Its pin
(`v1.3.0-rc.9`) predates this amendment, so the tag's own schedule still fires once a day. The
derivation therefore sets the v1.3 crons **regardless of the tag's own crons**:
`scripts/compat-line-workflow.mjs` declares the two known source shapes (`SOURCE_SHAPES`: `nights`
for tags cut before this amendment, `runs` for tags cut after it), detects which one the tag has,
and replaces that shape's cell crons with `CREDENTIAL_LINES['v1.3'].cronMap` (keyed by cell). Both
shapes derive to the same v1.3 crons and the same "14-run" alert prose. Underiving tries each shape
and keeps the one whose recovered source hashes to the recorded digest. The run-time `--check`
against `v1.3.0-rc.9` passes byte for byte.

#### D13 — The late-slot watchdog checks every fire that came due since its previous run

With fires eight hours apart and an eight-hour grace, "the latest fire at or before now" is never
past its grace, so a watchdog keyed on it could never alert. A fire is therefore checked only once it
is due (at or before its start minus the grace).

GitHub starts the watchdog late too, by a different amount each run (measured 4.9-6.6 h), so a
watchdog that checks only each lane's latest due fire skips a fire whenever two consecutive runs'
delays differ enough, and checks another twice. Each scheduled run (`25 1,9,17 * * *`) instead
checks **every** fire in `(previous scheduled watchdog run's start − grace, this run's start − grace]`,
both starts read from the Actions API. Consecutive windows meet exactly whatever the delays, so every
fire is checked once and a missing run alerts once. A cancelled previous run is skipped (it may not
have evaluated). Without a readable previous run the window is the last 24 hours: at least the
watchdog period plus the worst measured delay (8 + 7.4 h), and one dropped watchdog run
(2 × 8 + 7.4 h); it may repeat a check, never skip one. A previous run more than 72 hours back raises a
`coverage-gap` alert. Each fire is judged in its own context (every lane's slot at that fire), so
attribution and the ambiguity rule are unchanged per fire, and a run whose own mode marker reads
early-warning is never credited to a credential lane. A seeded simulation over ten days, with the
measured delays and with wider ones plus a dropped watchdog run, checks every fire exactly once and
alerts exactly the dropped runs, once each.

### Options considered

| Option | What it means | For | Against | Verdict |
| --- | --- | --- | --- | --- |
| Keep nights | One credential run per cell per day; 14 calendar days | Simple; no change | 14 days minimum per cell, a reset costs up to 14 more; release cadence bound to the calendar | rejected (founder) |
| **Runs per cycle with spacing** | Several scheduled runs per cell per day, each counted only if it started ≥ 2 h after the previous counted one; every integrity rule kept | ~4.7 days to 14; still scheduled, unattended, first-attempt, on a frozen tag; independence enforced on actual start times | More pool use (≈ 21 run-hours a day); a delay longer than the fire gap resets the cell | **chosen** |
| Back-to-back runs | Fire the next run as soon as the previous one ends | Fastest to 14 | Correlated flakiness (same runner window, same upstream state, same registry mirrors) reads as independence; warm caches; a burst can bank 14 in a day | rejected |

Sub-decisions, each scored with `jev pick` on the measured numbers above:

| Question | Options (score) | Chosen |
| --- | --- | --- |
| Runs per cell per day | 2 (0.06), **3 (0.94)**, 4 (0.00) | 3 — 4 puts the fire gap (6 h) below the measured worst delay (7.4 h) and spacing below 2 h |
| Slot attribution | **one multi-hour literal per cell, attribute by time (0.88)**, one literal per fire + run-name (0.12), nearest fire of any cron (0.00) | multi-hour literal |
| Slot grid | **keep each v1.0 fire, v1.3 fills free hours at :32 (0.93)**, strict alternation (0.06), line blocks (0.01) | keep v1.0 fires |
| Delay past the next fire | **strict reset (0.77)**, repair by reassignment (0.23) | strict |
| Caches | **disable on credential runs (0.97)**, keep and document (first scored 0.93 for keep, before the review held the founder's fresh-cache requirement) | disable on credential runs |
| Watchdog window | **every due fire since the previous watchdog run (0.99)**, fixed lookback without de-duplication (0.01), latest due fire only (0.00; first chosen at 0.97, it skips fires under jittered starts) | every due fire since the previous run |
| In-file cron stagger test | **relax to ≥ 30 min, drop the 08:30 rule (0.72)**, re-grid to keep ≥ 60 min (0.28) | relax |

### Consequences

- **Time to a credential:** fourteen runs at three a day is 4 days 16 hours per cell at the
  earliest, against fourteen days.
- **Capacity:** 24 credential runs plus 2 early-warning runs a day, about 21 pool run-hours. About
  one full run is active every hour, using 8 of the 20 concurrent jobs. Overlap costs queueing, never
  cancellation, but PR CI and the merge queue share the pool. The literal cron stagger (#1301) is
  relaxed from 60 to 30 minutes inside `test-e2e-deploy.yml`, and the 08:30 UTC pile-up rule is
  dropped: with a fire in nearly every hour neither can hold, and the measured 2.3–7.4 h delay plus
  `max-parallel: 8` are what bound contention.
- **Fresh caches** cost about one minute of wall clock and about seven job-minutes per credential run
  (D11), and make a Playwright CDN outage a red credential run.
- **The fetch horizon** doubles (`DEFAULT_FETCH_LIMIT` 100 → 200): the workflow now fires 14
  scheduled runs a day.
- **The v1.0 rc.6 window:** this amendment edits `test-e2e-deploy.yml`, whose executing-workflow
  bytes are part of every v1.0 cell's fingerprint (D3), so the first credential run after the merge
  starts a fresh streak in every v1.0 cell (`fingerprint-changed`). Measured at the time of writing,
  the rc.6 window had banked **zero** credential runs: every credential run so far was on rc.5, and
  the first rc.6 slot (22:17 UTC on 2026-10-08) had not yet started. The reset therefore costs at
  most the rc.6 runs that complete before the merge. Older once-a-day history is graded against the
  new three-a-day calendar and reads as missing fires; it predates the fingerprint move and changes
  nothing.
- **The v1.3 window:** regenerating `compat-credential-v1.3.yml` changes its bytes, so the v1.3
  fingerprint moves too. No v1.3 credential run had completed (only one dispatch dry run), so the
  reset costs nothing. Editing `compat-window-audit.mjs` also changes the v1.3 guard digests, which is
  why the file had to be regenerated.
- **Risk, stated:** a scheduled run delayed more than eight hours resets its cell. The measured worst
  is 7.4 h, and it grew from 6.2 h in late September. **Revisit trigger:** two or more
  delay-misattribution resets (a `missing-night` immediately followed by a `duplicate-slot`) in one
  release cycle.

### Action items

- [x] Audit: per-fire calendar, `WINDOW_REQUIRED_RUNS`, rule 10 spacing on `startedAt`,
      `spacingSkipped` / `spacingUnverified`, `fetchLedgers` threads `startedAt`, report wording in
      runs. Tests: `tests/compat-credential-runs.test.ts`; the once-a-day rule suites run on a pinned
      once-a-day calendar.
- [x] v1.0 schedule: four multi-hour credential crons in `test-e2e-deploy.yml`; alert prose says
      "14-run window". Fresh `rcBumpMarker` for the frozen files touched.
- [x] v1.3: `cronMap` keyed by cell, `SOURCE_SHAPES` in `compat-line-workflow.mjs`, regenerated
      workflow, `--check` against `v1.3.0-rc.9`.
- [x] Watchdog: hours-aware slots, `25 1,9,17 * * *`, every due fire since the previous watchdog
      run (seeded jittered simulation in `tests/credential-slot-watchdog.test.ts`).
- [x] Fresh caches on credential runs, both lines; scanned by `tests/compat-credential-runs.test.ts`.
- [x] Trackers: "run N of 14" and "14 consecutive green runs" wording, both lines.
- [x] Mutation prover: `scripts/mutation-prove-compat-credential-runs.mjs`.
- [ ] User docs pages that `release/prepare-v1.0.0` also edits (`README.md`, `stability`,
      `compat-matrix`, `compat-suite`, `docs/RELEASING.md`, `docs/release/v1.0.0.md`) still say
      nights; they are reworded after that branch merges, to avoid a conflicting edit (#ISSUE).
- [ ] Measure the actual spacing and delay distribution after the first full week on the new grid,
      and revisit N if the pool is saturated or delays exceed eight hours.
