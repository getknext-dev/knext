# ADR-0058: The runtime × builder matrix: six cells as the goal, four credentialed in v1.0

- **Status:** **Proposed (2026-09-24)** — records a founder decision taken on #1295 (option C,
  2026-09-24). Trigger-class (it changes the v1.0 credential scope), so it needs founder review
  before merge.
- **Amends** ADR-0054 Amendment 7, Decision 2 (the six-cell table stops being the v1.0 surface and
  becomes the goal), and ADR-0056 D2 ("v1.0 is met when every supported cell has banked 14
  nights" now reads "every **v1.0-credentialed** cell"). ADR-0036 and ADR-0048 are not edited:
  ADR-0054 already superseded their matrix text, and this ADR amends ADR-0054.
- **Implements:** #1303 (a). **Relates to:** #1218 (the six-cell bar), #1295 (vinext triage),
  #1260 (vinext × node runtime), #1245 (webpack credential lanes), #1183 (default flip), ADR-0059
  (the build-time bake every node cell depends on).

## Context

ADR-0054 Amendment 7 (2026-09-23) made the v1.0 surface the full runtime × builder matrix,
node/bun × turbopack/webpack/vinext, each cell with bytecode caching live and each credentialed
per ADR-0056 (14 consecutive scheduled credential nights against a frozen RC tag). One day of
measurement later, two of those six cells cannot credential on any v1.0 timeline:

- **vinext × bun is measurably below parity.** Three complete 16-shard runs of
  `compat-vinext.yml` (compiled exec) gave 716/62, 716/62 and 715/63 test files of 778; the
  latest run on Bun 1.4.2 (35940993605) gave 716/62. 60 of the 63 failing files fail in every
  run, and 44 of them need an upstream vinext fix to be *released* before they can pass. The
  triage on #1295 put P(green or a bounded, dated ledger within two weeks) at 0.10 (jev).
  Quarantining the rest would need a ledger of about 60 files (7.7%), which jev scored 0.21 as a
  credibly bounded ledger.
- **vinext × node cannot produce a compat run at all.** `compat-vinext.yml:79` pins
  `KNEXT_RUNTIME: bun`, because the Nitro bun preset calls Bun's `serve()` at module top level, so
  there is no node arm to select. The image side exists (#1263 ships a vinext × node image with a
  baked V8 compile cache), but the compat lane does not, and #1260 is still open.

The audit already reflects both facts. `CREDENTIAL_CELLS` (`scripts/compat-window-audit.mjs:176-244`)
lists all six cells. Four are unwired: `node-webpack` and `bun-webpack` (`:204-219`,
`workflowFile: null`), `node-vinext` (`:220-233`, `workflowFile: null`, with the reason in the
comment) and `bun-vinext` (`:234-243`, weekly, no credential mode). `auditCredentialMatrix`
defaults to every listed cell (`:763-783`), so `allMet` cannot be true while any vinext cell is
unwired. Under Amendment 7 as written, v1.0 is therefore unreachable until vinext reaches parity
upstream.

The webpack builder, by contrast, exists and is selectable (`webpackBuilder`, `available: true`,
`packages/kn-next/src/adapters/artifact-contract.ts:237-239`, listed in `BUILDERS` at `:364-368`).
Its missing piece is credential-lane wiring (#1245), which is knext's own work.

One more fact bears on the scope: **the code default builder is still vinext**
(`DEFAULT_BUILDER_ID = "vinext"`, `artifact-contract.ts:388`). ADR-0054 names bun-standalone
(turbopack × bun) as the v1.0 default, and the flip waits on that cell's credential (#1183).

## Decision

1. **The goal stays six cells.** node/bun × turbopack/webpack/vinext remains the matrix knext is
   building toward. Every cell keeps the ADR-0054 Amendment 7 rule: a cell without live bytecode
   caching is not a supported cell.
2. **v1.0 credentials four cells:** node × turbopack, bun × turbopack, node × webpack and
   bun × webpack. Each banks its own 14 consecutive credential nights per ADR-0056, with bytecode
   caching proven live on every shard (ADR-0056 Amendment 1, D4). v1.0 is met when these four are
   met. No other cell can hold v1.0 back, and no other cell can help it along.
3. **vinext × bun slips to v1.x.** It stays a selectable builder, but it is **not credentialed**
   in v1.0. `compat-vinext.yml` keeps running weekly and keeps publishing its measured number
   (latest 716/62 of 778 on Bun 1.4.2) as a measurement, never as a credential. It gets **no
   14-night window** until one full run is green or its failures fit a bounded, dated quarantine
   ledger (#1321). With the ledger at about 60 files it would red every night, so a window now
   would only produce noise. It is credentialed in a v1.x once released upstream fixes make it
   green or bounded.
4. **vinext × node is descoped from v1.0.** It is not credentialed, and it has no window, until
   #1260 gives the compat lane a node arm. The vinext × node image (#1263) keeps its baked
   compile cache and its bytecode rule. Descoping removes the credential, not the requirement.
5. **Sequencing for the vinext cells:** vinext × bun first (the lane exists and the gap is mostly
   upstream), then vinext × node (it needs a runtime arm before it can even be measured). Each
   joins the credential set through its own amendment to this ADR, which records the evidence:
   the green run or the bounded ledger, plus the wired credential cron.
6. **What v1.0 claims.** Credentialed parity is claimed only for the four cells in (2). Anything
   that describes vinext in v1.0 must call its number a measurement.

| cell | v1.0 | bytecode mechanism | state on 2026-09-24 |
|---|---|---|---|
| node × turbopack | **credentialed** | V8 compile cache, baked into the image (ADR-0059) | credential cron wired (`test-e2e-deploy.yml`) |
| bun × turbopack | **credentialed** | compiled `--bytecode` exec | credential cron wired; the lane boots the exec (#1230), but no 16-shard result on it is recorded yet (#1296) |
| node × webpack | **credentialed** | V8 compile cache, baked into the image | builder available; lane not wired (#1245) |
| bun × webpack | **credentialed** | compiled `--bytecode` exec | builder available; lane not wired (#1245) |
| bun × vinext | **v1.x (slipped)** | compiled `--bytecode` exec | weekly measurement only, 716/62; no window |
| node × vinext | **descoped from v1.0** | V8 compile cache, baked (#1263) | no compat runtime arm (#1260); no window |

## Options considered

| Option | Credential reachable? | Honesty of the v1.0 claim | Cost | Verdict |
|---|---|---|---|---|
| **A. All six cells in v1.0** (Amendment 7 as written) | no: needs released upstream vinext fixes plus a node arm; P ≈ 0.10 for vinext × bun in two weeks | high | v1.0 waits on upstream | rejected: v1.0 would be gated on a release knext does not control |
| **B. Four cells now; vinext × bun on a dated slip; vinext × node descoped** (founder's option C) | yes, all four cells are knext's own work | high: vinext keeps a published measured number, labelled as a measurement | the vinext credential waits for v1.x | **chosen (founder decision, 2026-09-24)** |
| C. Four cells now, both vinext cells descoped with no slip date (triage option A) | yes | high | vinext loses a planned route back into the credential | rejected: the founder wants vinext × bun back on a dated path |
| D. Slip v1.0 by 6–8 weeks for a bounded vinext × bun ledger (triage option B) | maybe: about 6–8 weeks, with a ledger of 26 files or fewer | high | the whole release waits; vinext × node slips further anyway | rejected |
| E. Credential vinext × bun now behind a 60-file quarantine | on paper | **low**: the ledger would dwarf the node lane's 14 entries and would read as bought green | cheap | rejected: jev 0.21 that this counts as bounded |

jev (jev-1.13.0), on the fact sheet above: the triage asked "should the founder be asked to descope
or slip now" and got 0.69. On how to record the decision, jev picked a new ADR over an Amendment 8
to ADR-0054 (0.76 vs 0.24, confidence 0.64) and gave editing ADR-0036/0048 in place 0.00.

## Consequences

- **v1.0 becomes reachable by knext's own work.** What is left is wiring the two webpack lanes
  (#1245), recording a suite run on the compiled bun-standalone exec (#1296), and the rc.1
  prerequisites in ADR-0056. None of it waits on an upstream release.
- **The audit must learn the v1.0 scope.** `auditCredentialMatrix` counts all six cells
  (`compat-window-audit.mjs:770`), so its `allMet` stays false by construction while the vinext
  cells are unwired. The fix is a per-cell scope field, so that the v1.0 verdict covers the four
  cells while the vinext cells are still listed and still reported. Keeping them listed matters:
  dropping them from `CREDENTIAL_CELLS` would also drop them from the fingerprint's
  `workflowFile` table (ADR-0056 Amendment 1, D5). jev: 0.91 that this change is needed.
- **The default builder has to move before GA.** v1.0 cannot ship an uncredentialed default, and
  today's default is vinext. So #1183 (flip `DEFAULT_BUILDER_ID` to bun-standalone once that cell
  is credentialed) becomes a v1.0 blocker, not follow-up tech debt. jev: 0.62. This is the least
  certain claim in this ADR, and it is the one the founder should confirm.
- **vinext stays selectable in v1.0** as a supported, uncredentialed builder with a published
  number (jev 0.79 that this is consistent with the decision). The user-facing compatibility
  page must say so plainly.
- **Documents that still carry the six-cell v1.0 wording** need updating in the PR that lands the
  audit change: `docs/V1_ROADMAP.md` §3 ("every supported runtime × builder cell … node/bun ×
  vinext/turbopack/webpack") and its rc.1 prerequisite list, which still names "vinext × node
  compile-cache wiring".
- **Compute:** the v1.0 credential is four 16-shard nightlies once rc.1 exists, not six. The
  weekly vinext measurement is unchanged.
- **Reopen bar:** reopen this ADR if a v1.0 cell cannot bank its window for a reason outside
  knext's control, or if vinext × bun turns green or bounded before rc.1 (it could then join v1.0
  by amendment instead of waiting for v1.x).

## Action items

- [ ] Add a v1.0-scope field to `CREDENTIAL_CELLS` and make the v1.0 verdict of
      `auditCredentialMatrix` cover only the four credentialed cells. Keep the vinext cells listed
      and reported. Mutation-prove both directions: a red vinext cell cannot fail v1.0, and an
      unmet webpack cell does.
- [ ] Wire the webpack × {node, bun} credential lanes. *(#1245)*
- [ ] Run the official suite on the compiled bun-standalone exec. *(#1296, closes #1166)*
- [ ] Treat the `DEFAULT_BUILDER_ID` flip as a v1.0 GA blocker. *(#1183, founder to confirm)*
- [ ] Keep publishing the vinext × bun number weekly, and burn it down through #1320, #1321,
      #1322 and #1323. Credential it through an amendment to this ADR in v1.x.
- [ ] Give vinext × node a compat runtime arm, then measure it. *(#1260)*
- [ ] Update `docs/V1_ROADMAP.md` §3 and the user-facing compatibility page to the four-cell
      v1.0 scope.
- [ ] **Maintainer:** `.claude/rules/architecture.md` §4 and `CLAUDE.md` §3 still describe the
      target set in pre-ADR-0054 terms. Reconcile them with this ADR. They are not an agent's
      files to edit.
