# Sprint-2 close brief (for both gates)

Review the AGGREGATE, not each PR (workflow.md sprint-close). Task graph: `.claude/sprint2-taskgraph.md`.
Plans: `.claude/sprint2-plan-architect.md`, `.claude/sprint2-plan-sysdesign.md`.

## Delivered (merged to main)
- Sprint-1 integration #913 (merged), lane fix #917 (green, unmerged), landing-page honesty (merged pre-#913).

## Delivered (green + review-approved, UNMERGED — founder-gated)
| PR | content | state |
|----|---------|-------|
| #914 | scaffold parity: health route both templates, image-intercept reconciled, 10-copy scan-pin (closes #910/#911) + the tomatchobject race fix (c3a8ca51) | 27/27 green, ready |
| #915 | ADR-0044 byte cap Option C on the binary (closes #743); Bun 1.4 chunked counting is security-load-bearing | 27/27 green, ready |
| #917 | compat-vinext + e2e lanes pnpm→bun (protects the nightly credential lane) | 27/27 green, ready |
| #919 | #894 post-compile RuntimeContract smoke, fail-never-skip, --skip-smoke loud (2 review rounds) | green, ready |
| #920 | T2 skew-ID chain (closes #892): verify-the-claim guard (not discovery — `_vinext_fonts` lesson), marker at write site, GC reclaim proved on a mutable store, NEXT_DEPLOYMENT_ID via spec.env (2 rounds + polish) | green, ready |
| #927 | G1-G5 + #912: guard-prover driver, per-prover liveness audit, dated exemptions (#928), SE-3 derived, real skip scan, pnpm prose sweep (4 rounds) | green, ready |
| #935 | T6a-c + S2 + S5 (T6d measured already-done by #911): provenance-pinned e2e installs, prod seam gate, realpath smoke mode, native-integrity opt-in fail-closed, metric-docs contract both directions (3 rounds) | green, ready |
| #938 | D9 + #918 scratch-space scan (write half + lifetime ratchet 161/48, #939 burn-down) + V4 decision-free anchor test (5 rounds) | finalizing CI |
| #934 | workflow step-10 amendment (reap agents/panes at every checkpoint) — founder-directed | open |

## Escalations fired during the sprint (the close must judge these)
1. **V4/#850 discovered fact**: the packed-closure content anchor ALREADY exists (`compat-window-fingerprint.mjs:184-202`; measured identical digest across rebuilds `sha256:fb964074…`). #850's remaining AC is an ADR-0007 amendment — recorded on #850. The sprint plan's V4 premise was moot.
2. **#926**: release.yml runs `pnpm install --frozen-lockfile` in three jobs with no pnpm-lock.yaml — the npm publish lane cannot install on main; fix moves which action holds NODE_AUTH_TOKEN (security.md trigger, founder/maintainer decision).
3. **#918 race** (fixed in #914's branch): the tomatchobject guard's in-repo scratch + concurrent suite reddened the typecheck gate deterministically per-branch; guard gap now closed by #938's scan.
4. **T6b's second half** (moving `__` seams off the published subpath) deferred as a public-API trigger — #936 + dated exemption in published-seam-policy.mjs.

## Refuse-to-close-without (system designer's own list, task graph lines 54-57)
1. Byte cap enforced on the binary, chunked case proved → **delivered in #915** (T1 experiment: chunked 5000B → 413 on Bun 1.4).
2. A scaffolded app that boots, goes READY, optimizes images, caches ISR → **NOT cluster-verified**: #914/#920 prove at CR/test level; kind/OKE verification requires the merges (founder-gated). The close must state this honestly: exit criterion is NOT met until post-merge cluster verification runs.
3. Id flow closed end to end, lock-step guard failing loudly → delivered at CR level (#920); cluster half same gate as (2).

## Data for sprint-3 planning
- The review pipeline found real defects EVERY round (5 rounds on #938, 4 on #927) — the successive-round class is alive; the scratch-space scan alone needed 4 same-class fixes (existential pairing, drain double-credit, $-boundary, non-identifier drains).
- Provers caught 4 decorative guards on #935's branch alone and 2 of the implementer's own spurious kills on #927.
- 160+ leaking temp-dir sites (#939), 156-entry burn-down.
- Follow-up issues filed this sprint: #918(closed by #938), #921-#925, #926, #928-#933, #936, #937, #939.
- Founder queue: merge the 9 green PRs (order: #914→#915→#917→#919/#920/#927→#935→#938; #917 protects the nightly), then kind/OKE verification of exit criteria 2/3, apply the §4 rules draft, #853 npm token, #872, GHCR visibility, #926 decision.

## What each gate produces
- Architect: `.claude/sprint2-close-architect.md` — did the task graph hold; ADR/hard-rule compliance of the aggregate; the #850 ADR-0007-amendment question; verdict CLOSE / CLOSE-WITH-CONDITIONS / BLOCK.
- System designer: `.claude/sprint2-close-sysdesign.md` — exit criteria honestly scored; failure-mode review of the new guards fleet; the merge-gated cluster-verification condition; verdict same scale.
Both: top-5 candidate items for sprint 3, with the one-line reason each.
