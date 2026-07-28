# Compat window — node lane

The v1.0 gate. **14 consecutive scheduled node-lane runs, every shard `failed:0`/`notRun:0`, zero
net new quarantine entries, and the harness fingerprint unchanged across all of them.**

This file is the record. It is deliberately hand-maintained *for now* — see
[What this log does not yet do](#what-this-log-does-not-yet-do), which is the honest limit and the
reason a follow-up exists.

## Status

**NOT YET OPEN.** The clock starts on the first scheduled node-lane run after
`scripts/compat-window-fingerprint.mjs` landed (#574), because that is the first run whose harness
identity is recorded. Nights before that cannot count — a night with no recorded fingerprint has no
provable harness, and ADR-0039 makes the ledger fail on a missing one rather than let it pass.

| | |
|---|---|
| lane | node (`cron: 17 3 * * *`, nightly 03:17 UTC) |
| start ref | *(first qualifying run — fill in below)* |
| start fingerprint | *(from that run's `compat-window-fingerprint.json`)* |
| nights recorded | 0 / 14 |

## The rules this log enforces

Read [ADR-0039](../adr/0039-compat-window-freeze-scope.md) for what is frozen and why. The three
that decide whether a night counts:

1. **Fingerprint identical to the start fingerprint.** Any change inside the frozen set — the
   workflow, `scripts/e2e-*.sh`, the deploy manifest, or the packed `@getknext/*` closure **in
   full, including `dist/cli/**` and the shared chunks** — restarts the count at zero. There is no
   "that change didn't really matter" exception; a fingerprint you can argue with is not a
   fingerprint.
2. **Every shard `failed:0` and `notRun:0`.** A shard that enumerated no tests is not a pass —
   that is what the per-shard test-count floor exists to catch.
3. **Zero net new quarantine entries.** A quarantine added mid-window to make a night green
   converts the gate into a pass-count, which is the failure mode the whole ledger exists to
   prevent.

A night failing any of these **restarts the count**. It does not pause it.

## Nights

| # | date (UTC) | run | fingerprint | shards | quarantine Δ | counts |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | *(no qualifying night yet)* |

## Suite provenance — recorded, not frozen

Each run also records the `vercel/next.js` checkout commit and the resolved `next` tarball digest
(`recorded.suite`, `frozen: false`). These are **outside** the fingerprint by design: `NEXTJS_REF`
is a git *tag* resolved fresh nightly, and that checkout supplies the compat suite itself — so a
retag would move what "green" means. Folding it into the digest would make a legitimate suite bump
indistinguishable from tampering; recording it means a bump is a **visible decision**.

If the recorded suite commit changes mid-window, that is not automatically a restart — it is a
question for whoever is policing the window, and it must be answered in this file rather than
noticed later.

## What this log does not yet do

Stated plainly because the gap is the reason this file is not self-certifying:

- **Nothing compares tonight's fingerprint to last night's.** CI fails a run that records *no*
  fingerprint; it does not detect a *changed* one. That comparison is done by a human reading this
  log — which is the exact mechanism ADR-0039's Context says the fingerprint exists to replace. The
  fingerprint makes the evidence **retained and tamper-evident**; it does not yet make the check
  automatic. Closing that is the filed follow-up (the ledger job reading the previous scheduled
  run's artifact).
- **`main` has no branch protection** (#555). A mid-window merge is therefore *detectable* but not
  *preventable*. That does not make a completed window's claim false — the fingerprint would change
  and the count would restart — but it does mean the window can be restarted an unbounded number of
  times by an unreviewed merge. This is a **schedulability** risk, not a correctness one, and
  branch protection is what makes "we'll just not count that merge" non-negotiable.

## How to record a night

1. Open the scheduled run, download the `compat-window-fingerprint` artifact.
2. Compare its `fingerprint` to the start fingerprint above, **exactly** — not the component
   digests, and not by eye over a truncated prefix.
3. Read the run ledger for per-shard `failed`/`notRun` and the quarantine delta.
4. Append a row. If the night does not count, append it anyway with `counts = NO` and the reason.
   **A window log that only records successes is not evidence.**

## Two operational rules established by measurement (2026-07-29)

### The start fingerprint MUST come from CI, never a local run

The digest covers built `dist/**` bytes, so it depends on the build that produced them.

Measured, because the alternative would have been fatal: a **rebuild with no source change** moved
the digest here (`20dbd49e…` → `4e3bec22…`). If that were non-determinism the window could never
reach 14 nights, since CI rebuilds every night. It is not — two further consecutive rebuilds were
**byte-identical** (`4e3bec22…`). The first delta was a stale `dist` from earlier local work.

So: **the build is deterministic, and the window design holds** — but a local `dist` of unknown
provenance yields a different digest than CI's. Take the start value, and every nightly comparison,
from the run's own `compat-window-fingerprint.json` artifact. Never from a laptop.

### The suite exercises a different `next` than the repo ships

`NEXTJS_REF` is **not** merely the checkout ref for the test suite. `test-e2e-deploy.yml:240` does
`NEXT_NPM_VERSION="${NEXTJS_REF#v}"` and `npm pack`s that published `next` into every fixture.

As of 2026-07-29 that is `next@16.2.0`, while the repo pins **`16.2.11`** (bumped for four HIGH
advisories). **So the gate every parity claim rests on validates a version users do not get.**

This is not a defect in the fingerprint — `NEXTJS_REF` lives inside the workflow and is therefore
inside the digest, so it cannot drift silently. It is a question about what "green" should mean, and
it wants an answer **before** 14 nights start counting toward a 1.0 claim:

- keep them independent deliberately (the suite pins the compatibility target, the repo pins what it
  ships), and say so in the compat matrix; or
- move `NEXTJS_REF` to track the shipped version, accepting that each move restarts the window.

Recorded here rather than decided: moving `NEXTJS_REF` changes what the gate means, which is a
design-gate call, and it is inside the frozen set.
