# The vinext-axis replacement compat bar (T1 of the #605 go/no-go)

**Status: PROPOSAL — pending system-designer (compat-gate-integrity) gate ratification.**
This defines the bar #605 requires ("vinext's own coverage pass in place of the official suite —
an undefined bar is not a bar"). The *structure* and *denominator* below are grounded in the
already-shipped lane; the **threshold values are the gate's call** and are marked as such.

## Why this exists

`#605` proposes making compiled `vinext` the sole runtime, which forfeits the project's
verified-adapter north star — the official-suite **778/0** credential, earned on the node target
ADR-0048 made un-selectable. The founder accepts *vinext's own coverage pass* as the replacement.
That replacement is worthless unless it is **as falsifiable and honest as the credential it
replaces**. This document is that definition.

## What already exists (do not rebuild — guard it)

`.github/workflows/compat-vinext.yml` + `tests/compat-vinext-lane.test.ts` already give the bar its
machinery, and it is directly comparable to node's 778:

- **Same denominator.** Runs `test/deploy-tests-manifest.knext.json` (the §d selection behind the
  node 778) at the **same 16 shards** — the lane test asserts byte-equality of the manifest and
  shard total against the node lane.
- **Only one variable changes** vs the node credential: the artifact. Each fixture is built by
  `vite build` (vinext → nitro bun preset) and compiled with `dist/adapters/vinext-compile.js`
  (`bun build --compile --minify --bytecode`); the **binary** is booted, not `.output/server`.
- **Red-on-fail, no escape hatch.** No `continue-on-error` anywhere; the per-shard gate exits
  non-zero on `failed>0`, `notRun>0`, a missing summary, or a truncated shard; the ledger fails when
  summaries disagree with `COMPAT_SHARD_TOTAL`. A red scheduled run opens its own "Compat weekly RED
  (vinext axis)" issue — never the node credential's.
- **Lane-attributable.** Every summary carries `builder:vinext`, `runtime:bun`, and the observed
  `bun --version` (≥1.4.0 floor, enforced).
- **Dispatchable + weekly.** `workflow_dispatch` (produces T2's first number on demand) plus a
  `17 7 * * 0` Sunday schedule.

So the bar does **not** need new machinery. It needs two definitions the machinery does not encode:
**the acceptance threshold** and **the stability requirement**.

## The bar has two tiers — do not conflate them

### Tier 1 — the DECISION bar (input to the #605 verdict, T3)

What vinext's first published number (T2) must show for the gate + founder to vote **go**.

**Framing (jev pick, conf 1.00): an honest red-on-fail number PLUS a credible path to Tier 2 —
NOT a hard numeric cutoff.** A single first number, taken right after the #1031 install-bug
unmask, rarely reflects steady state; a cutoff would either reject a fixable near-miss or bless a
lucky run. The gate judges:

1. **An honest, published, red-on-fail number** on the vinext lane (T2). `X passed / Y failed /
   0 notRun` across all 16 shards, `builder:vinext`. No skips.
2. **Coverage ≥ the uncompiled-vinext baseline** — the compile+bytecode step must add **no** net
   regressions over what `vite build` + bun-standalone already passes. This is the founder's own
   stated floor ("coverage ≥ uncompiled vinext") and is the honest thing the *compiled artifact*
   is on the hook for; gaps below uncompiled-vinext are knext's to fix, gaps that uncompiled vinext
   also has are upstream/vinext's.
3. **A credible, written path** from that number to Tier 2, each remaining red triaged to a cause
   (knext bug / bun-version-gated / upstream gap) with an owner — the same evidence contract the
   node quarantine ledger already meets.

A **no-go signal** is: the number is far below the uncompiled-vinext baseline with no path, i.e.
the compile step itself destroys coverage.

### Tier 2 — the CREDENTIAL bar (what replaces 778/0 at v1.0)

What vinext must **sustain** to be the thing knext points at when it says "verified adapter." This
tier IS a hard, falsifiable threshold, because it inherits the north star:

- **Node-parity denominator: 778 passed / 0 failed / 0 notRun across all 16 shards**, `builder:vinext`.
  Anything less is a *stated, bounded, evidence-backed quarantine ledger* (mirroring node's
  runtime-prefetch family) — never a silent skip, and the passed+quarantined+excluded count must
  reconcile to the full corpus.
- **Sustained, fingerprint-stable** — the node lane's rule (ADR-0039 / `window-node-lane.md`):
  N consecutive qualifying scheduled runs on an unchanged harness fingerprint, zero net-new
  quarantine.

## The cadence tension the gate MUST resolve (discovered during T1)

Node's credential window is **14 consecutive nightlies** (~a fortnight). The vinext lane is
**weekly** (the workflow comment calls a second 16-shard nightly "pure cost"). Applying "14
consecutive" verbatim to a weekly lane = **~3.5 months** of unbroken green — and node has never
reached 14 even nightly (#850: the window is restart-prone by construction). A weekly vinext
credential window is therefore *not achievable* as written. The gate must pick one:

| Option | What it means | Cost / risk |
|---|---|---|
| **A · promote vinext to nightly** for the credential run | same 14-consecutive rule as node | a second 16-shard nightly — the cost the workflow explicitly avoided; doubles CI + inherits #850's restart fragility on *two* lanes |
| **B · define the window in consecutive weeklies with a smaller N** (e.g. 4–6) | fortnight-to-6-week window on the existing weekly cadence | weaker statistical bar than node's 14; must be justified in the ADR, not smuggled |
| **C · fixed observation window** (e.g. green on ≥M of the last N weeklies) | tolerates CI-infra loss (node lost a shard to a runner disconnect once) | must define M/N so a real regression can't hide in the tolerance |

**Recommendation: C**, with M/N chosen so a single `failed>0` still reds the credential — it is
the only option that both fits the weekly cadence and is honest about CI-infrastructure loss (the
exact failure that disqualified node's 08-03 night). But this is a **compat-gate-integrity
decision** and belongs to the system-designer gate. It also interacts with **#850**: whatever
window rule Tier 2 adopts should be solved *once* for both lanes, not forked.

## Ratification checklist (for the gate)

- [ ] Tier-1 decision-bar framing (number + path, not cutoff) — accept / revise.
- [ ] Tier-2 credential threshold (node-parity 778/0 + bounded ledger) — accept / revise.
- [ ] Cadence resolution (A/B/C) — **required**; an unresolved window is an undefined bar.
- [ ] Whether the Tier-2 window rule is unified with #850's node-lane fix.
- [ ] A guard test enforcing whichever window rule is chosen (deferred to that decision — building
      it now would bake an unratified threshold into a gate).
