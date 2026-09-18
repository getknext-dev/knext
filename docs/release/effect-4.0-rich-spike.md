# Effect-TS 4.0 rich spike — Layers / retry / interruption under `bun --compile`

Follow-up to `effect-4.0-spike.md` (which measured only bundle+boot for a trivial handler). This spike
exercises the surfaces most likely to break in a 4.0 beta *and* under `bun build --compile` — the
compiled single-exec being knext's actual runtime (ADR-0048/0052/0053). Effect **4.0.0-rc.115**, Bun 1.4.2.

## What was exercised
One handler using all of: **DI (Context.Service + Layer)**, **typed errors** (`Data.TaggedError`),
**Schedule/retry**, **timeout + interruption + finalizer**, and **defect (`die`) vs typed-failure**
distinction — the exact Effect features ADR-0053's constraints depend on (C2 retry, C4 die→deny auth,
C5 typed-error→Code mapping).

## Result — works identically interpreted and compiled
| feature | interpreted (bun) | `bun --compile` single-exec |
|---------|-------------------|-----------------------------|
| DI (Context.Service + Layer.succeed) | `DI:OK:row(ping)` | `DI:OK:row(ping)` |
| typed error (Data.TaggedError → Exit.failure) | `TYPED_ERR:OK` | `TYPED_ERR:OK` |
| Schedule/retry (succeeds on attempt 3) | `RETRY:OK:attempts=3` | `RETRY:OK:attempts=3` |
| timeout + interruption + finalizer | `TIMEOUT:OK finalizerRan=true` | `TIMEOUT:OK finalizerRan=true` |
| defect (`die`) caught, distinct from failure | `DEFECT:OK` | `DEFECT:OK` |
| single-exec size | — | **~59.4 MB** (≈ baseline; no growth) |

**Conclusion: no `bun --compile`-specific Effect 4.0 breakage.** The full DI/retry/interruption surface
behaves the same compiled as interpreted — the single-exec runtime path (knext's target) is clean for
Effect 4.0. The finalizer running on interrupt (`finalizerRan=true`) is the mechanism ADR-0053 C2 relies
on ("finalizers may only release, never resubmit").

## Upstream (adopt→find→PR) — honest outcome: no bug, two migration deltas
No Effect *defect* surfaced. The two failures hit were **3.x→4.0 API renames** (a large-rewrite beta,
expected), confirmed against the installed d.ts, not bugs:
- **DI:** `Context.Tag("id")()` (3.x) → **`Context.Service("id")`** + `Layer.succeed(Svc)(impl)` (4.0).
  `Context.Tag`/`GenericTag` are gone.
- **Cause predicates:** `Cause.isFailType`/`isDieType` (3.x) → **`Cause.isFailReason`/`isDieReason`** (4.0);
  extraction via `findFail`/`findDie` (Option-returning).

**So there is nothing to file against `Effect-TS/effect` from this spike** — the friction is migration,
not correctness. The contribution surface, if pursued, is **docs/examples** (any Effect 4.0 example still
showing the 3.x `Context.Tag`/`isFailType` idiom is stale) or knext's own **migration notes** for the
template — not a code bug. Recorded honestly rather than manufacturing an upstream PR that isn't real.

## For ADR-0053's build phase
- **C5 seam confirmed richer:** typed errors, defects, and interruption all survive compile — the
  `runPromiseExit`-per-RPC seam can carry the full error taxonomy (typed → Connect `Code`, `die` →
  `Internal`, D5 die→deny).
- **C2 still the blocker (unchanged):** `Effect.retry(Schedule.recurs(3))` demonstrably re-runs the
  effect (attempts=3) — this IS the in-handler retry plane C2 forbids on mutations. The spike *shows the
  hazard is real and easy* (one `.pipe(Effect.retry(...))`), reinforcing that idempotency-key-by-
  construction (not "don't add a Schedule") is the right fix. The fault-injection exactly-once arm
  remains unbuilt (needs a datastore) and remains the hard build blocker.
- **C3 eager-Layer** still untested — this spike's `DbLazy` acquires nothing; the cold-start risk is a
  Layer that connects eagerly. Untested here.

> Scratch: `effect-spike/rich.mjs` + `bin-rich`. Throwaway per ADR-0053 — not committed.
