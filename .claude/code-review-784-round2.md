# Code review round 2 — PR #784 @ f4e2035

Verdict: **APPROVE**

All four round-1 findings are fixed, and each fix is mutation-proved rather than taken on the commit message's word. Nothing new found that rises to a finding.

## Re-verification (everything below run by me in the worktree at f4e2035)

**Baseline.** 80/80 across `tests/precompile-closure-audit.test.ts` (20), `tests/precompile-closure-gate-ci.test.ts` (12), `tests/bun-exec-alpine-image-ci.test.ts` (15), `tests/ci-blocking-gate-proof-runnable.test.ts` (33). Biome clean on all 6 changed script/test/JSON files incl. the new `tests/helpers/vinext-artifact-scan.ts`. Worktree clean after every mutation (only an untracked `.claude/spec-review-784.md` from the sibling reviewer).

**CODE-1 (the over-claim) — both escape routes are really shut, proved by mutation, not by reading the new code.**
- Removed the `|\b(?:bun|npm|pnpm|yarn|npx)\s+run\s+build\b` alternative from `tests/helpers/vinext-artifact-scan.ts:53-54` (anchor asserted to occur exactly once) → **`catches a lane that compiles via the "build" script alias (escape route 2)` goes RED.** The synthetic lane really exercises the escape route I named; it is not a lane the old matcher would also have caught.
- Made `loadWorkflows` (`:134-140`) return only `ci.yml` → **`scans EVERY workflow file, not just ci.yml (escape route 1)` goes RED.** Note the division of labour is sound: the *synthetic* non-ci.yml lane test stays green under that mutation (it calls `parseWorkflow` directly), and the every-file assertion is what actually closes route 1. Together they cover it; separately neither would.
- Confirmed the generalisation from "has `needs: vinext-precompile-closure`" to "has a job running the audit in its transitive `needs` closure" is load-bearing in **both** directions:
  - deleted `needs: vinext-precompile-closure` from ci.yml → `each real one runs the closure audit somewhere in its needs closure` **and** `the real gate job in ci.yml is the one named in the docs` go RED;
  - replaced the gate job's `run: node scripts/precompile-closure-audit.mjs …` with `echo skipping the audit` → **4 assertions go RED**, including the generalised closure one. So swapping the gate for a lookalike job that orders but does not scan is caught.
- `vinextArtifactJobs` correctly reports `gates: []` for a synthetic unguarded `publish-vinext.yml` lane and credits `closure-audit` when the `needs` edge exists — I re-ran those two cases and they are asserting the reported shape, not just "truthy".
- The residual blind spots (reusable workflow / composite action / shell wrapper; user apps on the vinext target; ordering-only vs. the still-owed cosign attestation) are now **stated** in three places that previously carried the strong claim — `tests/precompile-closure-gate-ci.test.ts:32-47`, the ci.yml gate comment, and `docs/security/threat-model.md` — plus a "(built: …, attestation half still owed)" marker in ADR-0042. That is the honest form of the claim.

**CODE-2 (the figures) — re-measured against this tree and they now match.** `installedPackages('examples/bun-exec/node_modules')` → **210**; syft `+javascript-package-cataloger` → **409** npm components, `verifyClosureCoverage` → `{ok:true, coverage:100%, missingAnchors:[]}`, 0 uncovered; `find … -name package.json` → **527**. Every one of those three numbers now appears in `scripts/lib/precompile-closure.mjs:20-30,50-63`, `scripts/precompile-closure-audit.mjs:18-24`, ci.yml and the threat model labelled with **what it counts**, and the floors are described as ~4× (components) / ~2× (installed) headroom, which is what `MIN_NPM_COMPONENTS = 100` / `MIN_INSTALLED_PACKAGES = 100` (`:62-63`) actually have. The one figure I did **not** independently reproduce is trivy's 60 (would need a trivy DB pull); it is unchanged from round 1 and is not load-bearing for any assertion.

**CODE-3 (silent unknown keys) — fixed and verified against the real allowlist.** `ALLOWLIST_ENTRY_KEYS` (`scripts/lib/precompile-closure.mjs:214`) = `[id, justification, added, expires, note]`. Live: `{…, expiress: '2020-01-01'}` → **throws** (`unknown key(s) [expiress] … A misspelled 'expires' never expires`); an unrelated `severity` key → throws; `note` → accepted, and it is documented as the one free-text key in the file's `$schema-note`. Expiry semantics re-confirmed unchanged: 2 active at 2026-08-19, **0 active at 2026-11-20**.

**CODE-4 (the justifications) — fact-checked against vinext's shipped dist, and the new text is accurate.**
- `examples/bun-exec/node_modules/vinext/package.json` → `"image-size": "2.0.2"` — a **direct, exactly-pinned** dep of vinext, as the entry now says (the old "transitive build-time dependency" was wrong).
- Grepped the whole closure for `from 'image-size'` / `require('image-size')`: **exactly one consumer**, `vinext/dist/server/metadata-route-build-data.js` — server-side, as claimed, and no second reachability path the justification would have had to cover.
- Read the call site: `imageSize(buffer)` at `:31` is fed by `readMetadataRouteFile` → `fs.readFileSync(route.filePath)` (`:12`), with `route` coming from the app's metadata route table (`vinext/dist/entries/app-rsc-manifest.js`). No request bytes, no upload, no URL. The "an attacker who can supply that buffer already commits to the repository" argument holds.
- `security/precompile-closure-allowlist.json:5-6` now names GHSA-5p2g-fcmc-qvqq's real subject (JXL/HEIF parser infinite loops) — matches `gh api advisories/…` verbatim, as does the `<= 2.0.2` / `first_patched_version: null` claim for both ids.

**Blocking-gate harness.** `scripts/mutation-prove-ci-blocking-gates.mjs` re-run in full at f4e2035: **`40 disarm(s) went red as required, 0 stayed green`**, `{"declared":40,"run":40}`, tree clean afterwards.

**Emptiness guard re-proved at the new commit** (the lib changed under it): empty `node_modules` → exit 1; nonexistent dir → exit 1 at `syft exited 1 — a failed scanner is NEVER a pass`; 250 synthetic packages, floors and 100% coverage satisfied, **anchors red** → exit 1.

## Residual observations (non-blocking, no action required to merge)

- `runsClosureAudit` (`tests/helpers/vinext-artifact-scan.ts:77-79`) credits a `needs` parent that merely *mentions* the audit script path in any step text, so a job whose step is `echo "see scripts/precompile-closure-audit.mjs"` would falsely count as a gate. Contrived, and the real tree is separately pinned by `auditBlockingGate` and by `the real gate job in ci.yml is the one named in the docs`, which requires the credit to be `vinext-precompile-closure` specifically. Same class as the matcher caveat already documented in the file header.
- The allowlist entry says `resolve.noExternal` is what inlines image-size into the binary; `noExternal` is not in `examples/bun-exec/vite.config.ts` today (that config is the thing C6 gates as a precondition). The conclusion — it is bundled into the compiled binary and runs in production — is still correct via the existing `.output/server` + `bun build --compile` path, so the wording over-states the *mechanism*, never the *exposure*. Fine to leave.

## Test quality

Excellent, and better than round 1: the two escape routes are asserted on **synthetic workflows the current tree does not contain**, which is the only way to prove a rule that must hold for lanes that do not exist yet, and the "scans every workflow file" assertion is the non-vacuity backstop for the synthetic ones. `expiress` was added as a named red-first case. I independently reddened each new guard by deleting its subject; none is decoration.

---

## Post-approval commit 99b1620 — sanity check: **APPROVE, no change to the verdict**

- **Diagnosis is right, and confirmed at the pinned SHA.** `gh api repos/anchore/scan-action/contents/download-grype/action.yml?ref=e1165082…` declares exactly one output, `cmd` — *"An absolute path to the Grype executable"* — and the action's own description is "Downloads the Grype binary and **provides a path to execute it**", i.e. it does not export PATH. So the bare `spawnSync('grype', …)` in `scripts/precompile-closure-audit.mjs:127` really was ENOENT in CI, and green locally only because grype is on the dev machine's PATH (mine included — this is precisely the class my round-1/2 local runs could not catch).
- **Interpolation is acceptable under the repo's rule.** `${{ steps.grype.outputs.cmd }}` is a value produced by a **SHA-pinned third-party action**, not `github.event.*` / PR-author-controlled text, which is what the no-untrusted-interpolation rule targets; it is quoted in the `run:`, and the repo has no guard test forbidding `${{ }}` in `run:` generally (`tests/supply-chain-workflow.test.ts` and siblings assert pin form and scope, not this). Trusting it is the same trust already extended by executing that action at all.
- **Ordering is correct.** ci.yml:1152 `Install grype` (`id: grype`) → :1156-1157 `Put grype on PATH` → :1164 the audit step → :1172 SBOM upload. The PATH export lands before the only consumer.
- **Failure mode is fail-loud, not vacuous.** If `cmd` were ever empty, `dirname ""` appends `.` and the audit dies at `grype could not be run: spawnSync grype ENOENT` via `run()`'s `res.error` branch (`precompile-closure-audit.mjs:78`) — exit 1. A broken toolchain still reds the gate; it cannot go silently green, which is this PR's whole invariant.
- Wiring specs re-run at 99b1620: **60/60 green** (`precompile-closure-gate-ci`, `bun-exec-alpine-image-ci`, `ci-blocking-gate-proof-runnable`). No new `uses:` introduced, so no new pin to audit.
