# Spec review — PR #957 vs issue #953

**Verdict: ISSUES_FOUND** (4 findings; 1 blocking, 1 blocking-procedural, 2 should-fix)

Subject: `agent/s3-isr-wiring` @ 00afb09f, base `agent/s2-tail` @ 9e96881e.

---

## S1 (BLOCKING) — criterion 3 is not met: compat-smoke check (k) is green-if-deleted for this exact defect

The PR body claims: *"CI's `compat-smoke` job exercises the same path on the actually-compiled
single executable against a real Redis service container (check k: cache-state headers +
`DBSIZE > 0`)."* — offered as the evidence for #953 acceptance criterion 3 ("exercised against a
real Redis somewhere in CI/e2e").

**Measured, not assumed.** Check (k) is *pre-existing* (not in this diff) and it **passed on the
unwired base**. Sibling PRs #940 and #942 sit on the same base `agent/s2-tail`, where
`apps/file-manager/vite.config.ts:44` is a bare `vinext()` with no `cache.data` — the exact
configuration #953 observed as MISS/MISS + `DBSIZE 0` on both clusters. Base run log
(job 101209302554):

```
✓ PASS k. ISR revalidation with a real REDIS_URL   cached HIT/HIT mtnlyclz-… → revalidated mtnlyds4-…; redis keys=19
```

Both of check (k)'s halves are satisfied without the wiring:

- `x-nextjs-cache` ≠ MISS is satisfied by vinext's **per-pod `MemoryCacheHandler`** — the smoke runs
  one process, so an in-process cache produces HIT/HIT and a real revalidation. The check cannot
  distinguish "cached in Redis" from "cached in memory".
- `DBSIZE > 0` (19 keys) is satisfied by *some other* Redis writer in the app; it never asserts the
  **ISR key** exists. `apps/file-manager/knext-bun-entry.mjs` registers no cache handler, so those
  19 keys are not the page artifact.

Consequences:
1. Criterion 3 is backed only by the new unit test, which drives an **in-process fake RESP2 socket**
   (`__tests__/helpers/fake-redis`), not a real Redis in CI/e2e. Strictly better than #906 (which
   deletes `REDIS_URL`), but not what criterion 3 asks for.
2. The PR's CI claim should be withdrawn or made true. Making it true is cheap and is the
   mutation-proof the workflow rule demands: after the revalidate window, assert the **specific ISR
   key** exists (`EXISTS <REDIS_KEY_PREFIX>:cache:/knext-smoke/isr`) and that its `TTL` **exceeds**
   `revalidate` (the #886 rule, which check (k) never asserts either). Then delete `cache.data` from
   `apps/file-manager/vite.config.ts` and show the job goes red.
3. `docs/compat-matrix.md:43` states of the ISR row: *"the configured Redis must then hold keys
   (`DBSIZE > 0` — **the in-memory fallback fails here**)"*. That parenthetical is demonstrably
   false and is the sentence that made this hole invisible. It must be corrected in the same PR.

## S2 (BLOCKING, procedural) — the escalation-trigger gate is RED

`Escalation triggers acknowledged` → **fail** (job 101285287590):

> the published package surface — changes exports/bin/files/main/types/typesVersions in
> `packages/kn-next/package.json` … This PR touches a trigger-class surface and is NOT acknowledged.
> Summon it, then add the `design-gate:cleared` label.

The PR body flags the trigger in prose ("flagged here for the reviewers rather than left to the diff
scan"). That is not what `.claude/rules/workflow.md` step 7 requires: a fired trigger means the
architect / system-designer gate is **summoned**, and the label records it. Prose acknowledgement in
the body is exactly the "a team decides for itself that a trigger doesn't really apply" failure mode
the rule names. Merge is blocked until the gate runs and the label is applied.

## S3 (SHOULD-FIX) — `examples/bun-exec/runtime-contract.mjs` now asserts a wiring that app
deliberately does not have

The retired note is rewritten in all five copies to read:

> Items 1 (health), 4 (Redis cache-handler — **WIRED**: the `vinext()` plugin's `cache.data` adapter
> in `vite.config.ts` registers `@getknext/core/internal/vinext-cache-adapter` in every server
> entry, #953) …

But `examples/bun-exec/vite.config.ts` is the **written exemption** in the test's `EXEMPT` map
(pinned to `vinext@1.0.0-beta.4`, which predates the plugin `cache` option). So that copy now makes
a false statement about its own app, and the `runtime-entry-copy-parity` guard *forces* it to stay
false because the five copies must be byte-identical. This is the same class of defect #953 was
filed for: a file that looks like wiring and isn't. Either phrase the note so it is true of all five
homes, or carry the bun-exec caveat inside the shared text.

## S4 (SHOULD-FIX) — user-facing docs are not updated

- `apps/docs/content/docs/compat-matrix.mdx:41` (shipped to knext.dev) still reads: *"`compat-smoke`
  runs with `REDIS_URL=""` (in-memory fallback) and has no revalidate/ISR-freshness assertion, so
  ISR correctness is unverified by the gate."* Stale, and it contradicts `docs/compat-matrix.md:43`
  (✅ vs ⚠️). #953 criterion 4 explicitly makes the docs part of acceptance.
- Both matrix copies attribute the mechanism to *"Redis cache handler (`cacheHandler` in
  `next.config.ts`)"*. This PR's whole finding is that `cacheHandler` is **inert** on the only
  supported build target. That sentence must now name the `vinext()` `cache.data` hook.
- No docs page anywhere mentions `vite.config.ts` or `vinext(` (`grep` over `apps/docs/content`
  returns nothing). A user who scaffolded **before** this change owns a `vite.config.ts` with no
  `cache.data` block and has no way to learn they must add it — their ISR is silently per-pod
  memory. `upgrading.mdx` covers only operator↔CLI ordering. An upgrade note is needed.

---

## What DOES hold (verified)

- **Registration in both template trees + in-repo apps.** `packages/kn-next/templates/app/`,
  `turbo/generators/templates/zone/`, `apps/docs`, `apps/file-manager` all carry
  `cache: { data: { adapter: '@getknext/core/internal/vinext-cache-adapter' } }`.
- **Scanning, not enumerated.** `discoverVinextViteConfigs` walks the tree for any file matching
  `\bvinext\s*\(`, with a floor assertion pinning the five known homes and a staleness check on the
  exemption map. A new app added without the wiring goes red. *(Minor: the walk only matches the
  exact filenames `vite.config.ts` / `vite.config.ts.hbs`, so a `.mts`/`.js` config would be missed;
  and the `cache…data…adapter:` regex and the specifier check are unanchored to each other, so in
  principle a `cache:` block on a different plugin plus the specifier in a comment would satisfy
  both. Neither is exploitable today.)*
- **Green-if-deleted, local halves — both directions confirmed by reading the assertions.**
  Deleting `cache.data` from a template → layer 1 red. Deleting `src/adapters/vinext-cache-adapter.mjs`
  → layer 2 test 3 and layer 3 red (dynamic import throws). Deleting the export-map entry → layer 2
  test 1 red. Deleting the tsup entry → layer 2 test 2 red, and the `publish-surface` test
  independently asserts every exports subpath exists in `dist`.
- **The negative half is asserted first.** Layer 3 proves `getDataCacheHandler()` is
  `MemoryCacheHandler` *before* registration, so the post-registration `toBeInstanceOf` is not
  vacuous — the right guard for a hook vinext fails **silently**.
- **The factory-vs-class contract** is asserted directly, which is the actual row-E failure shape.
- **TTL ≠ revalidate** (#886 / criterion 2) is asserted at the socket (`EX` argv), through vinext's
  own `isrSet`.
- **"Closes #953" honesty on the cluster half is disclosed.** The body's "What this PR does NOT
  claim" section explicitly leaves the kind + OKE re-observation of row E to the S3-V runner. That
  satisfies the team-lead's disclosure ask. *Caveat:* the body still uses the auto-closing keyword
  `Closes #953` while criteria 1 and 2 (deployed app, key inspected in the running pod) are
  unverified — recommend `Refs #953` so the issue survives to the re-run, matching the sprint
  refuse-list "proved on both paths" discipline.
- Trigger-class additions (the `./internal/*` export-map subpath, the `vinext` devDependency) are
  named in the body. See S2 for why naming them is not sufficient.
