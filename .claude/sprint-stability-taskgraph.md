# Sprint plan of record — STABILITY (reliability · security · tech debt)

Synthesized from the two planning-gate artifacts (read them for evidence and full reasoning):
- `.claude/plan-stability-architect.md` (strategy, sequencing, ADR coherence)
- `.claude/plan-stability-sysdesign.md` (failure modes with file:line, severity, debt inventory)

Sprint theme (founder-directed): the performance question is closed (vinext + Bun 1.4 + bytecode
single executable, ADR-0048 Amendment 3). This sprint buys **stability**.

## The two discovered facts that shaped this plan

1. **Eight of the eleven "open reliability issues" are the red gates of ONE unmerged stack**
   (`main ← #883 ← #890 = HEAD`). There is no "parallel teams on main" sprint; the spine is
   landing the stack green. (workflow.md discovered-fact trigger — stated, not adjusted around.)
2. **ADR-0048 moved the artifact, not the evidence.** Three green gates were repointed at the last
   surviving instance of the retired shape — a green check asserting the opposite of its name
   (sigterm→db-demo, seam→gone subject, compat-matrix ✅ on a path the validator rejects).

## Lane A — land the stack green (SERIALISED, one team, own branch per task on the stack tip)

| id | task | exit criteria | expected triggers | blast radius |
|---|---|---|---|---|
| A1 | #886(b) **UNFILED half: scaffold ships NO cacheHandler** — `next.config.ts.hbs` wires none, so every `kn-next create` app silently has no ISR/data cache | scaffolded app SETs and HITs the Redis cache under the compiled binary; red test first | CLI/scaffold surface | templates/, compat-smoke |
| A2 | #886(a) ISR under vinext (`export const revalidate` dropped — partly upstream) | either cached-and-green or a red+documented refusal in compat-matrix; never silent | discovered-fact | file-manager, vinext pin |
| A3 | #887 SIGTERM drain: the container e2e boots the real binary but never signals it — add the TERM case; retire the `sigterm-drain-shipped` job's false CMD claim | e2e sends SIGTERM to the shipped binary, asserts drain order; mutation-proved (`s.stop()`→`s.stop(true)` reds) | security invariant (graceful shutdown) | ci.yml (one owner), bun-exec e2e |
| A4 | #885 seam guard: subject (#352 webpack-layer duplication) cannot occur under rollup — RETIRE with evidence, don't repoint | guard removed + architecture.md §4 amendment drafted for maintainer; adr-state-claims-style pin that the retirement reasoning stays true | ADR/hard-rule (architecture.md names the file) | seam-alive*, rules amendment draft |
| A5 | #884 coverage gate: merge lcov from both runners (option A; dropping `--coverage` out of bounds) | honest denominator restored (338 files); ratchet re-baselined | none | scripts/, ci.yml |
| A6 | residual reds + `design-gate:cleared` ack; fold file-manager into the closure audit | `gh pr checks 890` fully green; stack merges | none | misc |

Ordering inside A: A1/A2 first (data-plane correctness), A3 next, A4/A5 parallel-safe after
(disjoint files), A6 last. ci.yml is touched by many — ONE owner, others hand patches.

## Lane B — the centerpiece: verification story for the shipped artifact

| id | task | exit criteria |
|---|---|---|
| B1 | Stand up the **vinext-axis compat lane**: same 778-test corpus/manifest/ledger, new axis = the compiled binary. Retire #710's bun-standalone weekly into it (that cell is no longer selectable). First run publishes a NUMBER, red-on-fail — green is explicitly NOT this sprint's bar (#850 window is multi-sprint) | lane exists, runs the corpus against the binary, publishes pass-count; compat-smoke ALSO boots the binary (today it boots `.output/server/index.mjs` under bun — misses the dlopen shim and asset-root divergences) |
| B2 | **compat-matrix honesty** — the ✅ official-suite credential currently sits on the retired node-standalone lane; merging #890 without this ships a false credential | matrix states: credential earned on a path users can no longer build; compiled path = measured-per-feature + B1's number. MUST land with lane A |

## Lane C — security of the new artifact (parallel from day one)

| id | task | exit criteria | note |
|---|---|---|---|
| C1 | **SEV-1: the production image's JS closure is scanned by NOTHING** — the compiled binary is Trivy-opaque, and supply-chain.yml attests that vacuous SBOM (a signed attestation asserting nothing is worse than none). ADR-0042 C6 built the right gate but scoped it to examples/bun-exec; #785's "no publish lane exists" premise is stale (supply-chain.yml:176 pushes one) | pre-compile closure SBOM generated per USER build, scanned red-on-HIGH, cosign-attested onto the image digest; the vacuous image-SBOM attestation retired or truthfully labeled | security invariant |
| C2 | `native/` (sharp @img tree) ships with zero integrity check → dlopen'd | provenance pinned (hash from lockfile → verify at stage time), covered by test | security invariant |
| C3 | #743 byte-cap: the ADR-0044 exception's expiry ("Tier-A exit") became UNREACHABLE when ADR-0048 killed suite-green Tier-A — a live security exception whose deadline can never fire. **Founder decision, not a task**: re-anchor via ADR-0044 amendment (recommended: "sprint close after the first vinext-axis lane run") | amendment accepted; never silently re-dated |
| C4 | #744 NetworkPolicy observability: sysdesigner found it DONE (condition + doctor check exist, netpol_enforcement.go:54-128, doctor.ts:1178-1268) | verify both signals, then close the issue citing the code |

## Lane D — observability + detectors (parallel)

| id | task | exit criteria |
|---|---|---|
| D1 | #792 generalised: metric NAMES drifted to zero overlap with alerts/dashboards — all 4 knext.app alerts and 5 dashboards are dead; binary emits 4 unlabelled series (no status_class/duration → no error-rate or latency SLO computable) | metric names contract-tested against alert/dashboard queries; `absent()`/`up==0` meta-alert added (pattern exists at scale-zero-pg:265) |
| D2 | #888 docs closure nightly RED — fix the detector, not just the instance | nightly green, failure mode named |

## Lane F — post-stack (blocked on A)

#894 post-compile RuntimeContract smoke (health/metrics/drain — the entry registers NO health
route today) · #893 stale-binary stamp (cut --arch to next sprint) · #892 GC vinext namespace —
**hard edge: skew protection must land BEFORE the GC fix** (the GC gap currently masks the dead
skew path: BUILD_ID guard skips every deploy, no NEXT_DEPLOYMENT_ID injection — fixing GC first
removes the accidental safety).

## OUT this sprint, with reasons

#872 CLOSE (premise dead — Amendment 3 disproved the trade it would re-measure) · #891 stays
trigger-gated on B1 green · #794 edits nextapp_types.go which the stack holds · #892 in F not A
(fail-safe: over-keep, money not correctness) · zones/gRPC/positioning tickets #614-620 untouched;
#605-611 V-map: keep #608+#610, fold #609/#611 into a future ADR-0048 Amendment 4, close #605.

## Founder decisions required (with recommendations)

1. **#608 acceptance bar**: keep knext's 778-test corpus, change only the axis (run it against the
   compiled binary); do NOT substitute vinext's self-reported coverage. Folds #850.
2. **B1 as centerpiece**: yes to standing the lane up; green is a later sprint.
3. **#743 byte-cap expiry re-anchor** (C3 above) — a security exception needs a reachable deadline.
4. **Maintainer-only process blocker E1**: amend architecture.md §4's official-adapter-default rule
   (ADR-0048 action item 7) — every task this sprint contradicts a live hard rule until amended.
   Also owed: §4 seam clause retirement (with A4), ROADMAP Tier-A exit definition, CLAUDE.md §3/§9/§10.
5. Human-only: #853 npm token rotation; GHCR visibility.

## Refuse-to-ship-v1.0-without (system designer, ranked)

1. Proof the shipped binary drains on SIGTERM (every scale-to-zero IS a SIGTERM — the gap sits on
   the product thesis).
2. A supply-chain gate that sees the production image's actual dependencies.
3. ISR working in a scaffolded app, or a red+documented refusal.
