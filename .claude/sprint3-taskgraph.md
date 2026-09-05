# Sprint-3 task graph (opened 2026-09-05)

Synthesized from `.claude/sprint3-plan-architect.md` + `.claude/sprint3-plan-sysdesign.md`.
Sprint-2 close: both gates CLOSE-WITH-CONDITIONS (`.claude/sprint2-close-{architect,sysdesign}.md`).
Standing rule for every implementer brief this sprint (C5): **prover-first, and every fix to a guard
gets a same-class sweep across its siblings before the round closes.** Vinext discipline (C1 planned-around):
vinext work may only *prove* or *delete* this sprint, never add capability.

## Phase 0 — runnable today (no merge dependency)

| id | task | owner | exit criteria | trigger touches |
|----|------|-------|---------------|-----------------|
| S3-V | Cluster verification of the s2 aggregate on `origin/agent/s2-tail`, kind→OKE, per the P0→P2→A–H runbook in sprint3-plan-sysdesign.md. Evidence → `docs/verification/sprint2-aggregate-2026-09-05.md`. Cluster work = queue of one. | lead (delegated runner, lead adjudicates) | Every A–H row observed or marked UNVERIFIED with the reason; P2 digest gate honored; fresh `kn-next create` app (repo apps disqualify). Discharges close-condition C2. | none |
| A2 | Lockfile guard + decision-free release.yml install fix: the three `pnpm install --frozen-lockfile` jobs → bun (pinned setup-bun by full SHA, per security.md credentialed-workflow rule), NODE_AUTH_TOKEN untouched; guard scans all workflows for install commands whose lockfile doesn't exist (both halves + prover). | implementer | Guard reds on the pre-fix tree, green after; #926 narrowed to the credential decision only. | security.md supply-chain path — acknowledged up front |
| A3 | Compat-window ledger measurement ONLY (numbers for the ADR-0007 amendment; no ADR text). | implementer (read-only + report) | Measured restart-cause table over the ledger; written to `docs/benchmarks/compat-window-ledger-measurement.md`. Feeds A6. | none |
| A5 | #906 `cache-handler-isr-staleness` prover: M1–M6 per sysdesign spec (incl. boundary `<=`→`<`); exemption entry removed in the same PR. Named gap: M1 proved against a pure function — the live-Redis half is S3-V row E. | implementer | 6/6 red, 0 survived, exit-code graded; #928's exemption list shrinks by one. | none |
| A11 | Prove the now-required escalation gate actually reds (a trigger-path change without the label → check fails, blocks merge), both halves, then clean up the probe. | lead | Red observed on a probe PR; probe closed; one-line record in the sprint log. | none (that's the point) |

## Phase 1 — opens on M3 (founder merges the 9-PR queue)

| id | task | needs |
|----|------|-------|
| A4 | compat-vinext publishes a number (re-dispatch after #917), or ADR-0044 records the anchor as still unfired | #917 |
| A6 | ADR-0007 Amendment: per-axis window scope; restart sub-decision ONLY after A3 | A3, gates |
| A7 | Post-merge re-verification of S3-V rows on `main` | M3, S3-V |
| A8 | Runtime before/after snapshot (two halves: fs instrumentation preload + tree diff — tree-diff-only REJECTED on the record, it misses the #918 shape) REPLACES the 1,698-line scratch-space stack; #939 burn-down; net lines down | M3 (#938 in) |
| A9 | `generate-runtime-entries.mjs`: discovery stays, comparison becomes a WRITE + `git diff --exit-code` gate; DIVERGENT pin deleted | M3, S3-V row A |
| A10 | One dated-exception registry (`exemptions/registry.json`) on the EXISTING dated-exemptions.mjs reader; mechanical staggering rule (no shared expiry, ≥7 days apart). 15 entries currently on two dates. | M3, after A5 |

**Slip rule (architect):** if M3 has not happened by day 7, that is the discovered-fact trigger — both gates return; sprint 3 delivers Phase 0 and reports blocked rather than stacking unverified work.

## OUT (with reasons)
C1 §4 amendment (maintainer-owned) · #926 credential move + #853 token (founder/security gate) ·
#891 legacy deletion (trigger = green vinext axis; doesn't exist yet) · #872 · per-PR design gates
(wrong instrument for the 12 rounds) · byte-cap→CRD promotion (needs an ADR, fires #548; cheap partial:
`doctor` reports the value — candidate for sprint 4) · new scanning guards (C5) · new user-facing capability.

## Accepted blind spots (sysdesign §4, named)
B1 nothing audits the lane itself · B2 native integrity default-OFF (never call it enforcement) ·
B3 byte cap invisible to control plane · B4 child-process writes at run granularity · B5 Bun.write/Bun.$
bypass the fs patch · B6 the 161/48 ratchet doesn't burn down this sprint (#939) · B7 skip/prose scanners
survive until A8-class replacements · B8 S3-V is behavioural evidence, never a compat-suite result.

## Refuse-to-close-without (sysdesign)
1. Exit criteria 2+3 OBSERVED on kind AND OKE against a confirmed deployed digest (fresh scaffold, restartCount 0, image bytes < source, unchanged resourceVersion on abort).
2. Scratch-space scanner DELETED and the replacement mutation-proved on the #918 shape.
3. #906 proved on both paths (prover M1–M6 red AND live-Redis key+TTL observed in S3-V row E).

## Founder queue (unchanged, carried forward)
Merge the 9 green PRs in order #914→#915→#917→#919/#920/#927→#935→#938 (+#934); stale-FAILURE run IDs
noted in the close reports (919: 33894955802/33898433110; 927: 33911350365) — later SUCCESS runs are real.
C1 §4 amendment (2 sprints overdue) · #853 npm token · #926 credential decision · GHCR visibility · #872.
