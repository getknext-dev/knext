# Tech-debt & bug ledger — one row per loop iteration, counted not estimated

> The standing loop (goal set 2026-08-22): **assess all tech debt, test and count all bugs,
> iterate on fixing both, re-assess after each iteration.** Same discipline as
> `docs/benchmarks/cold-start-ledger.md` and `docs/ux/ergonomics-ledger.md`: every number is
> measured, every claim carries its command, re-counts happen after every iteration.

## Iteration 0 — 2026-08-22, the counted baseline

| metric | count | command / source |
|---|---|---|
| Open issues | **53** | `gh issue list --state open` |
| TODO/FIXME markers in tracked source | **4** | `git grep -cE "TODO|FIXME" -- packages/*/src apps/*/src …` |
| Test `.skip`/`.todo` sites | **33** | `git grep -cE "\.skip\(|\.todo\(" -- **/*.test.ts*` |
| Biome errors / warnings | **0 / ~749** | `biome check .` (warnings noConsole-dominated) |
| @getknext/core line coverage | **~90.6%** (floor 90; margin 0.57% ≈ 17 lines) | CI Lint & Test; residual: `adapters/node-server.ts` 0% (55 lines, known spawn-entry residual) |
| Known flaky tests | **2** (`image-cache-sync-watch` fs.watch race ~1/3 full-suite runs #805; compat shard-level flake #545) | issue evidence |
| Standing nightly reds | **2 lanes** (Operator E2E #670; Anonymous-install #198) + bun-weekly #710, docs-closure #708 to re-verify | run history |

### The 53 open issues, classified (so "53" is legible)

- **Planning/decision tickets (wayfinder maps), not debt: ~15** — positioning (P1–P6, #614–620),
  vinext go/no-go (V3–V6, #605–611), stability-plan workstreams (W3–W8, #588–596). These resolve by
  decision, not by code; they stay OUT of this loop's fix queue.
- **Org/human-gated: 5** — #198/#707/#670 (ghcr visibility family), #785 (needs a publish lane),
  #751 (operator now IS on OKE — re-verify and possibly close).
- **User-decision platform knobs: 3** — #779, #781, #761.
- **Bugs (real defects, agent-fixable): 12** — #805 (flake), **#804 (apps/file-manager in NO
  typecheck gate — real TS errors ship invisibly)**, **#797 (scale-zero-pg `_validate.sh` dies on
  the first bad file — every later contract silently unenforced)**, #798 (rotate-cred clobbers
  custom-zone override), #793 (duplicate fsGroup key), #792 (5-week-stale live Prometheus config —
  partially addressed by the converged config this week; re-verify), #790 (per-replica idle timers
  defeat keepwarm — partially superseded by hold-shape keepwarm; re-verify), #744 (NetworkPolicy
  inert on flannel, unobservable), #750, #753, #755, #545.
- **Guard/process debt: 6** — #639 (half-scan rule amendment — this session added 4 more
  instances), #742/#758 (roadmap gaps), #743 (Option C brief), #731, #807 (bun 1.4 compat).
- **Docs owed: 2** — #783, plus #742's missing ROADMAP.md target.
- **Perf: 3** — **#441 (the 842ms knext wrapper overhead, +43% — the largest remaining in-repo
  cold-start lever, connects to the cold-start ledger)**, #592, #593.
- **Features: 7** — #794 (imagePullSecrets on the CR — same family as #198), #471 follow-ups,
  #306 (EKS), #387–389.
- **Likely already fixed, verify-and-close: 2** — **#754 (bun pinned nowhere — #806 pinned all
  five sites + #816-era scanning guard + e2e dispatch default; close with evidence)**, #792/#790
  (partially, see above).

## Iteration 1 — plan (chosen for value × disjointness; per-PR reviews as always)

1. **#804** — put apps/file-manager under a typecheck gate (guard-class: invisible TS errors are
   the definition of silent debt). Blast radius: ci.yml + fm tsconfig.
2. **#797** — make `_validate.sh` continue-and-aggregate (or fail at END) so every contract runs;
   its current first-death silently unenforces the rest (guard-integrity, same class as the
   session's decorative-guard findings). Blast radius: scale-zero-pg scripts.
3. **#805** — fix the fs.watch race flake (taxes ~1/3 of ALL full-suite runs — the highest-tax
   single item). Blast radius: one test + maybe the watch impl.
4. **#793** — duplicate fsGroup key (trivial YAML fix, same PR as #797 if convenient).
5. **Verify-and-close sweep** — #754 (evidence: five pins + guard), #751 (operator runs on OKE
   since 2026-08-20), #792/#790 partials (cluster evidence from this week's keepwarm/Prometheus
   work).

Exit criterion for iteration 1: items 1–4 merged through per-PR review; the close-sweep issues
closed or re-scoped with evidence; then **re-count everything above** as iteration 2's row.
