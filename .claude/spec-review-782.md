# Spec review — PR #782 vs issue #765

Scope: does PR #782 (docs-only, one hunk in `docs/adr/0042-vinext-bun-bytecode-as-the-default-runtime.md`,
lines 431–458) do what #765 asked? Read-only review.

## Checklist

| # | Criterion (from #765) | Verdict | Evidence |
|---|---|---|---|
| 1 | Warm-on-boot must not remain an **undeclared** asymmetry — either declare it contract (both entries implement) or declare it **target-specific** | **met** | `docs/adr/0042…md:436-438`: "Decision 3 mandates one `RuntimeContract` with two implementations and no undeclared asymmetry, so this asymmetry is hereby **declared**: warm-on-boot is a **target-specific behaviour of the bun/vinext entry**, not a contract obligation the node standalone entry must implement." One of the two permitted branches, taken explicitly. |
| 1a | …"in the contract doc" — right place? | **met** | The `RuntimeContract` exists only as prose in ADRs-0036/0042 (`docs/adr/0044-ingress-hardening.md:74`: "`RuntimeContract` itself exists only in ADRs-0036/0042 today, not as code"). No `docs/runtime-contract.md` exists (grep over `docs/`, `packages/`, `apps/`). #765 itself anchors on **ADR-0042 Decision 3** (`0042:203-206`), which is the mandate being satisfied, and the new text sits as the last subsection of **`## Consequences`** (heading map: `## Consequences` at :213, new section :431, `## Phased plan` at :460) — the same section of ADR-0036 that carries the 7-item enumeration (`0036:146-163`). Placement is correct. *Nit (non-blocking):* ADR-0036's enumeration bills itself "full … both targets MUST satisfy all of it"; a one-line pointer there to the 0042 exclusion would close the discoverability gap. Not required — warm-on-boot is absent from items 1–7, so there is no contradiction to fix. |
| 2 | Related `/`-vs-`/api/health` ruling transcribed faithfully; poisoning rationale + open keying question survive intact | **met** | `0042:452-458` vs the issue text, clause by clause: default stays `/api/health` (inert) ✓; warm is "a synthetic localhost request — no cookies, no auth, no real `Host`" ✓ (issue: "no cookies/auth/real Host"); "**writes the shared Redis page cache**" ✓ (issue's WRITES emphasis preserved); "fine for an app like file-manager, a shared-cache-poisoning risk as a default for arbitrary apps whose `/` may be auth-gated, redirecting, or personalised" ✓ verbatim in substance; "`/` stays a documented per-app recommendation via `spec.env`" ✓; open question verbatim: "is the synthetic warm render keyed identically to the first real anonymous request?" ✓. **Nothing weakened.** One wording delta: the issue says `/` was "RESHAPED away", the ADR says "rejected" — *stronger*, not weaker, and immediately qualified by "`/` stays a documented per-app recommendation", so the reshaped-not-banned meaning survives. Corroborated elsewhere in-tree: `docs/adr/0045-scale-down-delay.md:69` records `KNEXT_WARM_PATH` as fully settable via `spec.env` (a dedicated CR field rejected). |
| 3 | Promotion criterion concrete enough to be actionable | **met** | `0042:446-450`: a **number** (">200 ms" post-readiness first-request lazy cost), a **named subject** (the node standalone entry), a **measurement-triggered consequence** ("warm-on-boot becomes **contract**"), and a **defined promotion shape** (`node-server.ts` implements the same env surface `KNEXT_WARM_PATH`/`KNEXT_EAGER_WARM`, the same `WARMED:` log line, e2e parameterised over both images). Not vague. |
| 4 | "Closes #765" honest — nothing in the issue left undone | **met** | #765 asks for exactly two things: the declaration and the recorded ruling. Both land in the one hunk. Diff is 29 additions / 0 deletions, single file — **no scope drift**. |

## Factual claims in the new text, checked against the tree

- "`KNEXT_WARM_PATH` (comma-separated, sequential)" → **true**: `examples/bun-exec/knext-bun-entry.mjs:213-216` (`.split(',')`), `:219` sequential `for … await`.
- "`KNEXT_EAGER_WARM=0` as the escape" → **true**: `knext-bun-entry.mjs:217` (`!== '0'`).
- "gated by the alpine e2e's `WARMED:` assertion" → **true**: `examples/bun-exec/test/alpine-image.docker-e2e.test.ts:293-295` (`toMatch(/WARMED:\S+ status=200 ms=\d+/)`), run by the `bun-exec-alpine-image` job with no skip path (`.github/workflows/ci.yml:1073-1104`).
- "exists **only in the bun/vinext entry**" → **true**: grep for `KNEXT_WARM_PATH|KNEXT_EAGER_WARM|WARMED:` across the tree hits only the bun entry, its alpine e2e, two benchmark records and ADRs — nothing in `node-server.ts`; `examples/bun-exec/runtime-contract.mjs` and its test assert no warm behaviour, consistent with target-specific.
- "−1.2 s of post-readiness lazy module evaluation" → **corroborated**: `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md:34` — "vinext was paying ~1.2 s lazy app-graph evaluation *after readiness*".
- "the node standalone path's first-request lazy cost has **not been measured**" → consistent with the benchmark records (no node-side post-readiness lazy figure found).

## One defect worth fixing before merge (non-blocking, not an unmet criterion)

**`0042:450` — "the same both-images shape the sigterm gates already use" is not the current state.**
The sigterm gates are two *separate, per-target* jobs, not a parameterised one:
- node: `ci.yml:414-417` runs `apps/file-manager/sigterm-drain-e2e.test.ts` + `sigterm-hardcap-e2e.test.ts` against the standalone build only;
- bun: `ci.yml:1032-1053` (`bun-exec-hardcap`) runs `examples/bun-exec/test/sigterm-hardcap-e2e.test.ts` — and `examples/bun-exec/test/` has **no drain e2e** at all.

Parameterisation is still *open work* in this very ADR: Phase 4's exit criterion (`0042:631-632`) lists "`sigterm-drain-e2e` and `sigterm-hardcap-e2e` parameterised over both images", and action item **A5** (`0042` action items) reads "Additive `build` field per ADR-0040; **both drain e2e gates parameterised**". Suggested fix, one line: *"…the both-images shape Phase 4 / A5 specifies"* rather than "already use". As written it understates the cost of promotion by pointing at a precedent that does not yet exist.

**Observation (inherited from the issue, not introduced):** the promotion criterion has no owner, no date and no action-item entry, so the measurement that would trigger promotion is nobody's obligation — the asymmetry can persist by default. #765 did not ask for one and "target-specific" is a terminal declaration, not a deferral, so this is not an unmet criterion; recording it so it is a conscious choice.

## Verdict

**APPROVE** — all four of #765's asks are met by the one hunk: the target-specific branch is declared explicitly in the doc that carries the Decision-3 mandate, the `/api/health`-not-`/` ruling is transcribed with the poisoning rationale and the open cache-keying question intact (nothing weakened), the promotion criterion is a real number plus a defined shape, and "Closes #765" is honest with no scope drift. Recommend the one-line correction to the "sigterm gates already use" clause at `0042:450` before merge.
