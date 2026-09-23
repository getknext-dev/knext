# ADR-0056: Credential v1.0 per runtime×builder cell, against a frozen release-candidate ref

- **Status:** Accepted (2026-09-23) — encodes two founder decisions recorded on #850 and #1218.
  The **mechanism** lands with this ADR; **cutting a release candidate is a founder action** and
  none is cut here.
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
