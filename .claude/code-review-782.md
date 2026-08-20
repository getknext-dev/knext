# Code review — PR #782 (docs: warm-on-boot declared target-specific, ADR-0042 / #765)

**Verdict: ISSUES_FOUND** (docs-only; two claims fail verification against `origin/main`, two are
overreach/nits. Nothing here is a security or hard-rule violation.)

## Verified TRUE (no action)

- **Mechanism** (`knext-bun-entry.mjs` on main, lines ~208-231): `KNEXT_WARM_PATH` default
  `/api/health`, `.split(',')`, warmed **sequentially** in a `for…of` with `await`, fired
  concurrently (not awaited) after both listeners bind → genuinely overlaps the readiness window;
  `if (process.env.KNEXT_EAGER_WARM !== '0')` is the escape; `WARMED:<path> status=… ms=…` log.
  Gated by `examples/bun-exec/test/alpine-image.docker-e2e.test.ts:295`
  (`/WARMED:\S+ status=200 ms=\d+/`, no skip path, mutation-proved per its comment). Provenance
  `#771` is correct (`git log -S KNEXT_WARM_PATH` → `e873265`).
- **"exists only in the bun/vinext entry"**: `KNEXT_WARM_PATH`/`KNEXT_EAGER_WARM` appear in exactly
  4 tracked files, none under `packages/`. `node-server.ts`'s "warm" hits are the metrics-graph
  warm only — no app warm-on-boot. TRUE.
- **~1.2 s provenance**: recorded at `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md:34`
  ("vinext was paying ~1.2 s lazy app-graph evaluation *after readiness*") — vinext entry, as
  claimed.
- **`/` writes the shared Redis page cache**: `cache-handler.js` `set()` does
  `tx.set(cacheKey(key), …, 'EX', ttl)` against shared Redis, and
  `fm-confirmatory-prepulled-ab-2026-08-18.md:76` records `KNEXT_WARM_PATH=/` as "pre-fills the
  Redis page cache at startup". TRUE.
- **Consistency with D3 / "What must NOT be done"**: no contradiction. D3 forbids *undeclared*
  asymmetry and a third `RuntimeContract` implementation; an explicit target-specific declaration is
  the option #765 permits, and warm-on-boot is not one of ADR-0036's seven enumerated contract
  items. Declaring satisfies D3 rather than violating it.

## Issues

1. **`docs/adr/0042-…md:450` — "the same both-images shape the sigterm gates already use" is not
   true today, and contradicts this same ADR's Phase 4 exit criterion.**
   On main the sigterm coverage is two *separate, duplicated* lanes, not a parameterised gate:
   `ci.yml:348-417` (`sigterm-drain-shipped`) runs `apps/file-manager/sigterm-drain-e2e.test.ts` +
   `sigterm-hardcap-e2e.test.ts` against the **node** standalone bundle only, and `ci.yml:1032`
   (`bun-exec-hardcap`) runs a **different** file, `examples/bun-exec/test/sigterm-hardcap-e2e.test.ts`
   — hardcap only, no drain lane on the bun side, and both are process/harness-level, not image-level.
   ADR-0042's own Phase 4 exit criterion still lists "`sigterm-drain-e2e` and `sigterm-hardcap-e2e`
   **parameterised over both images**" as *future* work (§Phased plan, Phase 4). Why it matters: the
   promotion criterion now cites a precedent shape that does not exist, and one document asserts in
   two places that the same work is both done and pending — exactly the prose-drift this ADR
   elsewhere complains about. Fix: say "the both-target shape the sigterm gates *will* take at
   Phase 4", or drop the clause.

2. **`docs/adr/0042-…md:458-459` — "`/` stays a *documented* per-app recommendation via `spec.env`"
   is unbacked.** `KNEXT_WARM_PATH` appears nowhere user-facing: zero hits under `apps/docs/`, and
   the only tracked mentions are the entry, its e2e, `docs/benchmarks/fm-confirmatory-…md`, and
   `docs/adr/0045-scale-down-delay.md:69` — where it appears inside a *rejected-option* table
   ("already fully settable via `spec.env`"), not as a recommendation. Why it matters: the ruling's
   safety argument depends on `/` being reachable *by an informed user*; per `workflow.md` step 5 an
   undocumented env var is undelivered. Either weaken to "an intentionally undocumented per-app
   override, docs owed" or land the doc alongside.

3. **`docs/adr/0042-…md:442-443` — "the baked `NODE_COMPILE_CACHE` layer, ADR-0035, already absorbs
   the compile share of that cost" overreaches ADR-0035, in a sentence that just said the cost is
   unmeasured.** ADR-0035 measured **`Started → Ready` boot** (COLD 3162 ms vs WARM 2769 ms, 393 ms),
   i.e. pre-readiness compile — it measured nothing about post-readiness first-request lazy cost.
   Coverage of page-route modules exists only because `scripts/warm-compile-cache.sh:293` fires a
   **best-effort** `curl … "/" || true` after the health probe, and the script's plausibility guard
   (200 files / 1 MB) does not assert those modules are present. So the compile-cache mitigation is
   plausible but unverified — state it as "plausibly absorbs part of", not "already absorbs".

4. **Nits (non-blocking).**
   - `:440` "−1.2 s" — the minus-sign framing reads as a warm-attributable saving. The record's
     1.2 s was the *lazy* entry's post-readiness evaluation on a different build/cache state
     (yesterday); the same-day warm evaluation measured 430–480 ms and the A/B median delta vs node
     was −1330 ms (p=0.201, no separation). Consider "≈1.2 s (measured on the lazy entry, 2026-08-18)".
   - **Placement:** the section lands as a `###` inside `## Consequences`, whose body is otherwise a
     flat numbered list 1–14 with no `###` children — it reads as a new top-level topic wedged into
     a list. And **Decision 3 gets no back-pointer**, so a reader who goes to D3 (the clause being
     discharged) will not find the declaration.
   - The **>200 ms promotion criterion is prose-only**. ADR-0042 keeps machine-readable criteria in
     `docs/adr/gates/adr-0042-gates.json` precisely because "phases were prose, so 'has Phase 1
     passed?' was a judgement call". A criterion with no owner, no trigger and no gate entry is the
     same shape.

## Test quality

Docs-only; no tests expected and none weakened. The behaviour described is already gated by the
alpine e2e's `WARMED:` assertion (no skip path, mutation-proved), so the bun half is enforced.
Nothing, however, guards the *declaration itself* — if `node-server.ts` later grows
`KNEXT_WARM_PATH`, or the bun entry loses it, no check reds and this section silently goes stale.
