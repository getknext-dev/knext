# Compat window — bun lane

The credentialing bar for the **Bun runtime axis** (`KNEXT_RUNTIME=bun`, `next build`
standalone booted on Bun). Sibling of [`window-node-lane.md`](window-node-lane.md); this file
defines what "credentialed" means for the bun lane and (once the scheduled lane exists) records it.

**The bar: 14 consecutive scheduled bun-lane runs, every shard `failed:0`/`notRun:0`, zero
net new quarantine entries, the harness fingerprint unchanged across all of them, and the
observed Bun build (the `bun-version` input + `bun --revision`, not just the version string)
unchanged across all of them.**

That is the **same contract class** as the node lane's 14-night gate, plus one bun-specific
clause (rule 4 below). It is deliberately not a weaker bar: the bun axis is the v1.0 default
target under ADR-0054, so "credentialed" for it must clear the same height "green" clears for node,
not a discounted version of it.

## Status

**SCHEDULED — window not yet banked.** The scheduled bun-1.4.0 lane now exists (#1147: cron
`47 4 * * *` in `test-e2e-deploy.yml`), so the bar can start counting on its first qualifying
night. Until **14** consecutive scheduled bun nights bank on one unchanged harness **and one
unchanged Bun build**, its 778/0 stays **verified-once** (two dispatch runs, 2026-09-22), not
**credentialed** — the compat-matrix Bun row stays ✅-verified-once, and this file's record table
below fills as scheduled nights land.

| | |
|---|---|
| lane | bun (`KNEXT_RUNTIME=bun`, standalone `server.js` on Bun) |
| required nights | **14** consecutive qualifying (`WINDOW_REQUIRED_NIGHTS`, `scripts/compat-window-audit.mjs`) |
| grader | `node scripts/compat-window-audit.mjs --fetch --lane bun` — the lane is read from each run's `compat-run-ledger`, already lane-attributed. Grades rules 1–3 (and the three stricter audit rules); **rule 4 (Bun-build freeze) landed with #1147** — the fingerprint folds the observed `bun --version` + `bun --revision` on the bun lane. |
| window opened | on the first scheduled bun night (lane landed #1147, cron `47 4 * * *`); none banked yet |
| current streak | 0 / 14 — lane scheduled, awaiting first qualifying night |

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
4. **The observed Bun build is unchanged across the window — and is part of the frozen
   fingerprint. Any Bun build move resets the streak.** This is the clause the node lane does not
   need, because the bun lane's result is *build-dependent*: Bun ≤1.3.14 is **deterministically red**
   on three documented edge-`fetch()` / not-found-`invariant` files, while **stable Bun 1.4.0 is
   green** on the same corpus (runs 35652804130 / 35659440363, 778/0). The version *string* alone is
   not a sufficient freeze key: a **canary that also reported `1.4.0`** (run 28622051531) was **red**
   on those files, so two builds carrying an identical `bun --version` produced opposite outcomes —
   freezing only the version string would still credential a moving target. So the frozen key is the
   **`bun-version` workflow input together with `bun --revision`** (the build hash), not just
   `bun --version`, and any change in it **resets** the streak the same way a harness move does. The
   lane already records the observed `bun --version` as `runtimeVersion` on every
   `compat-suite-summary-*.json` artifact (absent on the node lane); #1147 must additionally record
   `bun --revision` and fold both into the bun lane's frozen fingerprint (or treat any change as a
   rule-1 restart), so the audit script enforces this rather than a human eyeballing it. A Bun build
   move **resets** the streak; it never merely pauses it, and a maintainer may **not** waive it.

**Plus the three stricter rules the audit script applies that this list does not restate**, exactly
as [`window-node-lane.md`](window-node-lane.md) enumerates them under "Three rules the audit script
applies that this list did not state": a **re-attempted run** (`runAttempt !== '1'`,
`scripts/compat-window-audit.mjs`) is **not** a qualifying night — a re-run green does not bank, so
the #545 "re-run until green" vector cannot operate here; a **short ledger** (fewer shards than
expected) is not a green night; and an **unobtainable ledger** is disqualified, never treated as
absent. "Same contract class as the node lane" means these too, not only rules 1–4.

## What credentialing this lane does and does not claim

- **Does:** that the bun axis holds 778/0 across the official deploy-suite corpus for 14 straight
  scheduled nights on one unchanged harness **and one unchanged Bun**, with revocation teeth (a red
  scheduled bun run opens its own "Compat nightly RED (bun credentialing)" issue — never the node
  credential's — and flips the matrix row back).
- **Does not:** extend to the compiled **vinext single-executable** axis (a separate row / lane,
  ADR-0048/0051), nor to any Bun build other than the one the streak was measured on. A later Bun
  bump is a fresh streak, not an inherited credential.

## What this log does not yet do

Same honest limit as the node lane: this file's record table is transcribed by hand from the
`scripts/compat-window-audit.mjs --lane bun` output; it is not auto-generated. When #1147 opens the
window, whoever updates this file runs the audit script and copies its summary block rather than
eyeballing a run list — the script's grading, not the prose here, is authoritative.
