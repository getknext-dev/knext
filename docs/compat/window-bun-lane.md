# Compat window — bun lane

The credentialing bar for the **Bun runtime axis** (`KNEXT_RUNTIME=bun`, `next build`
standalone booted on Bun). Sibling of [`window-node-lane.md`](window-node-lane.md); this file
defines what "credentialed" means for the bun lane and (once the scheduled lane exists) records it.

**The bar: 14 consecutive scheduled bun-lane runs, every shard `failed:0`/`notRun:0`, zero
net new quarantine entries, the harness fingerprint unchanged across all of them, and the
observed Bun version unchanged across all of them.**

That is the **same contract class** as the node lane's 14-night gate, plus one bun-specific
clause (rule 4 below). It is deliberately not a weaker bar: the bun axis is the v1.0 default
target under ADR-0054, so "credentialed" for it must clear the same height "green" clears for node,
not a discounted version of it.

## Status

**NOT OPEN.** The bar cannot start until a **scheduled** bun-1.4.0 lane exists to produce nights;
today the bun lane is `workflow_dispatch`-only, so its 778/0 is **verified-once** (two dispatch
runs, 2026-09-22), not **credentialed**. Standing up that scheduled lane is issue #1147; this
file is its acceptance target. Until #1147 lands there is no window to grade and no streak to
count — the compat-matrix Bun row stays ✅-verified-once, never credentialed, and this file's
record table below is empty by construction.

| | |
|---|---|
| lane | bun (`KNEXT_RUNTIME=bun`, standalone `server.js` on Bun) |
| required nights | **14** consecutive qualifying (`WINDOW_REQUIRED_NIGHTS`, `scripts/compat-window-audit.mjs`) |
| grader | `node scripts/compat-window-audit.mjs --fetch --lane bun` — the lane is read from each run's `compat-run-ledger`, already lane-attributed |
| window opened | — (blocked on #1147; not yet scheduled) |
| current streak | 0 / 14 — no scheduled nights exist |

## The rules a night must satisfy to qualify

A night that fails **any** of these **restarts the count at zero**. It does not pause it — same
semantics as the node lane.

1. **Fingerprint identical to the start fingerprint.** Any change inside the frozen set — the
   workflow, `scripts/e2e-*.sh`, the deploy manifest, or the packed `@getknext/*` closure in full
   (including `dist/cli/**` and the shared chunks) — restarts the count. There is no "that change
   didn't really matter" exception, exactly as `window-node-lane.md` rule 1.
2. **Every shard `failed:0` and `notRun:0`.** A shard that enumerated no tests is not a pass; the
   per-shard test-count floor exists to catch it.
3. **Zero net new quarantine entries.** A quarantine added mid-window to make a night green
   converts the gate into a pass-count — the failure mode the ledger exists to prevent. As on the
   node lane this is subsumed by rule 1 (the manifest lives inside the frozen harness set) but is
   stated because it names the intent the fingerprint enforces.
4. **The observed Bun version is unchanged across the window — and is part of the frozen
   fingerprint.** This is the clause the node lane does not need. The bun lane's result is
   *version-dependent*: Bun ≤1.3.14 is **deterministically red** on three documented edge-`fetch()`
   / not-found-`invariant` files, and Bun 1.4.0 is **green** on the same corpus. A bar that let the
   runtime version drift would credential a moving target — a green streak assembled across a
   1.3.14→1.4.0 bump would be meaningless. So a Bun version move **resets** the streak the same way
   a harness move does. The lane already records the observed `bun --version` as `runtimeVersion` on
   every `compat-suite-summary-*.json` artifact (absent on the node lane), so this rule is
   mechanically gradable today; #1147 must fold `runtimeVersion` into the bun lane's frozen
   fingerprint (or treat any change in it as a rule-1 restart) so the audit script enforces it
   rather than a human eyeballing it.

## What credentialing this lane does and does not claim

- **Does:** that the bun axis holds 778/0 across the official deploy-suite corpus for 14 straight
  scheduled nights on one unchanged harness **and one unchanged Bun**, with revocation teeth (a red
  scheduled bun run opens its own "Compat nightly RED (bun lane)" issue — never the node
  credential's — and flips the matrix row back).
- **Does not:** extend to the compiled **vinext single-executable** axis (a separate row / lane,
  ADR-0048/0051), nor to any Bun version other than the one the streak was measured on. A later Bun
  bump is a fresh streak, not an inherited credential.

## What this log does not yet do

Same honest limit as the node lane: this file's record table is transcribed by hand from the
`scripts/compat-window-audit.mjs --lane bun` output; it is not auto-generated. When #1147 opens the
window, whoever updates this file runs the audit script and copies its summary block rather than
eyeballing a run list — the script's grading, not the prose here, is authoritative.
