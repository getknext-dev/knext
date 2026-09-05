# Spec review — PR #942 (sprint-3 A2 / issue #926)

**Verdict: APPROVE** (3 non-blocking notes). Reviewed read-only; all checks re-run
independently in a throwaway `git clone --shared` at `/tmp/spec942` (removed afterwards).

## A2 exit criteria

| criterion | verdict | evidence |
|---|---|---|
| Guard reds on the pre-fix tree, green after | **MET (reproduced myself)** | Guard green on the PR tree (4 pass). Reverting only `release.yml` + `release-ghp.yml` to `origin/agent/s2-tail` → exit 1 with exactly 5 sites: release.yml:114 ×3 (`audit`, `version-pr`, `release`), release-ghp.yml:70 ×2 (`audit`, `publish-ghp`). Emptying `PENDING_FIXES` adds the other 2 (compat-vinext.yml:107, test-e2e-deploy.yml:201, both job `build-next`) — so all 7 claimed sites are real and the ledger covers live violations. |
| Decision-free: NODE_AUTH_TOKEN untouched | **MET** | `git diff … -- .github/workflows/` contains **zero** `+/-` lines matching `NODE_AUTH_TOKEN\|NPM_TOKEN\|changesets/action\|secrets\.\|environment:\|permissions:`. Only changes: 5× setup-bun-for-pnpm/action-setup swap, 5× `bun install --frozen-lockfile`, 4× `bun run --filter … build`, `version-script:`, `publish=`. Credential still sits on the gate step + changesets/action in `release`. PR body states the decision is open. |
| setup-bun SHA-pinned, comment resolvable by the nightly | **MET** | `gh api repos/oven-sh/setup-bun/git/ref/tags/v2.2.0` → `commit 0c5077e51419868618aeaa5fe8019c62421857d6`, identical to the pin (lightweight tag, no deref needed). `scripts/verify-action-pins.mjs` `PINNED_WORKFLOWS = ['release.yml','release-ghp.yml']` → both in scope. |
| #917 blast radius disjoint | **MET** | `git diff base...head -- compat-vinext.yml test-e2e-deploy.yml` = 0 lines. |
| Mutation table 8/8, #926 defect verbatim as a mutation | **MET (re-run)** | `node scripts/mutation-prove-workflow-install-lockfile.mjs` → canary red, M1–M8 as declared (6 KILLED, 2 negative controls TOLERATED), `{"declared":8,"run":8}`, exit 0, tree restored clean. M1 = `pnpm install --frozen-lockfile` on the audit job, verbatim. |
| `mutation-prove-release-lane.mjs` declared==run | **MET (re-run)** | 22 red, 0 green, `{"declared":22,"run":22}`, exit 0. |
| Non-vacuity floors real | **MET** | 22 tracked workflows > 15 floor; installs > 0; M4 (corpus collapse) and M5 (stale exception) both red. |
| Sibling guards follow the subject | **MET** | `bun test` on bun-version-pins / release-action-pins / release-lane-liveness / release-ghp-workflow / changesets-cli-action-compat → 55 pass, 0 fail. |
| Escalation label | present (`design-gate:cleared`), PR still draft. |

## #926 acceptance criteria — what this PR may and may not claim

Met: bun install on the lane + resolvable SHA pin; `release-action-pins` allowlist updated in the
same PR; the general-form lockfile guard; the release-lane prover completing with declared==run.

Still open, and the PR body says so: the **credential decision** (which action holds
`NODE_AUTH_TOKEN`) and **#853 npm token rotation**. Nothing here pre-empts either. The lane is
*repaired*, not *exercised* — no publish has run — and the body does not claim otherwise.

## Notes (non-blocking)

1. **Unverifiable claim: "`node scripts/audit-published.mjs` end-to-end PASS locally".** No bun
   ≥1.4 exists on this machine (1.2.2 / 1.3.5 only) and `bun pm pack` under 1.3.5 dies with
   `Unknown lockfile version` on the repo's `bun.lock` (lockfileVersion 3), so I could not
   reproduce it. Risk is low, not zero: `audit-published.mjs` runs **only** in
   `release.yml`/`release-ghp.yml`, never on PRs — but `scripts/install-smoke.mjs` already packs
   with `bun pm pack` on the same workspace:^ rewrite argument and *is* PR-gated, so the mechanism
   is CI-proved elsewhere. Worth asking the implementer which bun version produced the local PASS.
2. **Residual exception hole, narrower than the one asked about.** A new *knext-side* install
   cannot hide under the `next.js/` exception in the general case — in both harness workflows knext
   is checked out at `path: knext`, so its installs resolve under `knext/` and stay in scope, and
   M3/M5 close the "name a directory `next.js/`" and "stale exception" variants. What remains: an
   install deliberately given `working-directory: next.js` (or a self-checkout nested under it) in
   a workflow that *does* check out vercel/next.js there would be exempted, because the exception
   matches on directory, not on which repo the install belongs to. Acceptable and documented; note
   it rather than fix it here.
3. **`PENDING_FIXES` dates are comments, not a clock.** The forcing function is liveness
   (self-enforcing, proved by M8 and by my own removal test), which is stronger than an expiry for
   this shape — but the entries are removed only when #917 lands. If #917 is abandoned they persist
   with no expiry, and they do not go through `scripts/lib/dated-exemptions.mjs`. Sprint-3 A10
   (exemption registry) is the right place to reconcile that, not this PR.
