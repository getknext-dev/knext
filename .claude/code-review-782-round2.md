# Code review round 2 — PR #782 (415f7bd + 1fc8a97)

**Verdict: APPROVE** — all four round-1 findings are fixed and the new text reads accurately against
the tree. One non-blocking nit below (a wrong internal phase citation introduced by the fix).

## Re-verification of each fix

1. **Sigterm shape (`:452-454`) — FIXED, and the citation checks out.**
   New text: "the both-images shape Phase 4 / A5 *specifies* for the sigterm gates (today those are
   still separate per-target jobs; the parameterisation is open work, so promotion shares its shape,
   not a shipped precedent)."
   - Phase 4 exit criterion does specify it (`…parameterised over both images`); **A5** is a real
     action item and says "Additive `build` field per ADR-0040; **both drain e2e gates
     parameterised**" (`:923`) — correct reference, not an invented one.
   - "separate per-target jobs" is accurate *and* now correctly implies coverage on both sides:
     `ci.yml:348` runs drain+hardcap against the node standalone bundle; `ci.yml:1032`
     (`bun-exec-hardcap`) runs `bun run test` in `examples/bun-exec` with `KNEXT_REQUIRE_BUN=1`,
     which pulls in `runtime-contract.test.ts`'s real-`srvx` drain **and** hardcap e2e — so the bun
     target is drain-covered too, by a separate job rather than a parameterised one. The sentence is
     true as written; the self-contradiction with Phase 4 is gone.

2. **"documented recommendation" (`:461-463`) — FIXED, and the tracking is real.**
   Now "a per-app override via `spec.env` — today an **undocumented** one: `KNEXT_WARM_PATH` has no
   user-facing docs (docs owed; tracked as an issue)". Verified: still zero hits under `apps/docs/`,
   and **issue #783 exists and is open** with exactly the user-words content list (both env vars, the
   `/` recommendation with its synthetic-request caveat, where to set them, suggested docs home).
   Not naming the number inline is also the right call for an ADR that ends up quoted in user docs.

3. **NODE_COMPILE_CACHE (`:441-446`) — FIXED, correctly scoped.**
   "*plausibly absorbs part of* that cost, though ADR-0035 measured pre-readiness boot, not
   post-readiness first-request work, so that mitigation is plausible, not verified." That is exactly
   what ADR-0035 supports (COLD 3162 ms vs WARM 2769 ms on `Started → Ready`), and the sentence no
   longer asserts knowledge about a cost the same paragraph calls unmeasured.

4. **Nits — all addressed.**
   - `:441` now "≈1.2 s of post-readiness lazy module evaluation on the first request, measured on
     the lazy vinext entry, 2026-08-18" — matches `fm-same-source-oke-ab-2026-08-18.md:34` and drops
     the misleading minus sign.
   - **D3 back-pointer** added at `:205-206`: "(One declared asymmetry exists: warm-on-boot is
     target-specific — see the Consequences subsection 'Warm-on-boot', #765.)" The named subsection
     exists, is under `## Consequences`, and the title matches. A reader arriving at D3 now finds the
     declaration — which was the substance of the placement nit; the `###`-inside-a-numbered-list
     cosmetics are no longer worth changing.
   - **A13** added (`:1032-1038`) with an owner, a threshold, a home, and — the good part —
     "record the number even if under threshold, so the criterion is discharged by measurement rather
     than expiring unread". `A13` does not collide with an existing item (A1–A12 in use). It also
     carries the docs debt forward. This converts the prose criterion into something that can be
     falsified, which was the point of the round-1 nit.

## Nit (non-blocking, one-line fix)

- **`:1036` — "Natural home: the Phase 5 A/B sittings" cites a phase that has no A/B sittings.**
  In this ADR the two-arm sittings are **Phase 1** ("Phase 1 — measure the axis… Two arms:
  `node+turbopack` (control) and `bun+vinext-compiled`", exit = distribution separation), tracked as
  **A2**. Phase 5 is the default flip, and every other Phase 5 mention in the file is about exit
  gates, never about running sittings. Since Phase 1's **control arm is the node standalone entry**,
  that is where this measurement rides for free — and doing it there means the number exists before
  the irreversible gate, not after it. Suggest "the Phase 1 / A2 A/B sittings, whose control arm is
  the node standalone entry". Not blocking: Phase 5's exit requires Phase 1 separation anyway, so the
  work lands in that window either way.

## Test quality

Unchanged from round 1: docs-only, no tests expected, none weakened. The bun half of the described
behaviour remains gated by the alpine e2e's mutation-proved `WARMED:` assertion; nothing guards the
declaration itself against future drift (e.g. `node-server.ts` growing `KNEXT_WARM_PATH`), which is
acceptable for a declaration whose whole point is that promotion requires a measurement — A13 is now
the mechanism that stops it persisting silently.
