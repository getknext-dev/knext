# Is the ~9 s cold-start slow mode caused by the probe timeout itself?

**Status:** complete, 2026-08-12. **Outcome: the hypothesis is REFUTED** — raising the
probe timeout does not shorten the cold-start tail. **The prediction below was written
before the data landed** and is left unedited, so a result cannot be retro-fitted to
whichever mechanism it happens to resemble.

## What is already established

From `slow-mode-attribution.md`, measured under controlled placement:

- roughly a third of cold starts pay a **fixed ~9 s**
- it is **not node-local** (2/8 vs 3/8 across pinned nodes) and **not build-target
  dependent** (fast-mode p50 2.65 s vs 2.55 s)
- both containers are up early and *identically* in fast and slow pods —
  user-container `LISTENING` at 1.0–2.3 s, queue-proxy bound to `:8012` at 1.2–2.5 s
- the entire difference is `listen → Ready`: **−0.4 to 1.2 s** fast, **8.6–9.3 s** slow
- slow pods carry `Unhealthy × 9` — `Get "http://<podIP>:8012/": context deadline
  exceeded`. Fast pods carry **zero** timeout events, only benign 503s.

The 503-vs-timeout distinction is the whole lead. A **503** means queue-proxy answered
and reported the app not ready — normal, clears in ~1 s. A **timeout** means queue-proxy
accepted the connection and never answered at all.

## The hypothesis

Knative's queue-proxy answers the kubelet's readiness probe by probing the user
container *within that request*. If the kubelet's `timeoutSeconds: 1` deadline cancels
the request, the probe's context is cancelled with it — and the next probe starts the
work again from nothing. Nine probes, nine cancellations, no progress: a **livelock
created by the deadline**, not merely measured by it.

If that is right, the ~9 s is not a property of the app at all. It is the cost of
repeatedly aborting a probe that would have succeeded had it been allowed to finish.

### What `LISTENING` actually means (checked, not assumed)

`examples/bun-exec/knext-bun-entry.mjs:186` prints `LISTENING` *after* both listeners are
bound synchronously — its own comment says "nothing accepts a first request before the
app + :9091 listeners are up". So the timestamp is **socket bound**, not **handler warm**.
`Bun.serve({ fetch })` accepts immediately; the first request through that handler can
still pay lazy initialisation.

That matters because it makes a **specific** version of the livelock mechanism plausible:
if the app's first `/api/health` costs somewhere between 1 s and 3 s, then at
`timeoutSeconds: 1` **every** probe is cancelled before it can finish and restarts from
nothing, while at 3 s the first one completes. It also explains the intermittency
without needing a second mechanism — fast pods are the ones whose first request lands
under a second.

It is equally consistent with the fixed-9 s reading if that lazy init genuinely costs
~9 s. The experiment is what separates them; this only sharpens what each outcome would
mean.

## The discriminator, and why it is drift-independent

Raise `readinessProbe.timeoutSeconds` from **1 → 3** and re-run. The slow mode's base
rate drifts between sittings, so incidence alone cannot settle this — but the **count of
timeout events per slow pod** can, and it separates the two mechanisms cleanly:

| | timeout events per slow pod | Ready time | verdict |
|---|---|---|---|
| **Livelock** (deadline causes it) | **0–1** | ~2–3 s | the probe completes once allowed to |
| **Fixed 9 s** (app or queue-proxy is genuinely busy) | **~3** (3 × 3 s) | still ~9–11 s | the timeout only re-shapes the same wall-clock |

Both predictions are falsifiable, and they disagree about *both* numbers, so a
half-result (say, 5 events at 6 s) refutes both and means the mechanism is something
else again.

## Method

- one service (`p1b-bunexec`), image **unchanged** — verified: patching only
  `/spec/template/spec/containers/0/readinessProbe/timeoutSeconds` left every other
  container key byte-identical, which matters because a merge-patch on a ksvc container
  silently drops env/resources/probes while the revision still goes Ready
- **first pass:** 12 cold samples, one sitting, collector attached for per-pod events
  and timings, compared against the timeout=1 baseline (24 ABBA + 16 pinned samples)
- **then a crossover**, because the first pass could not separate the timeout from the
  image: phase 1 `bunexec@t=3` vs `node@t=1` interleaved, phase 2 with the assignments
  swapped. See Result 2. The counts below are the crossover's; the first pass's own
  0/16 is reported there as the non-evidence it turned out to be.

## What this is not

A fix. Even if the livelock reading holds, raising a probe deadline is a **mitigation**:
it stops the cancellation cascade without explaining why the underlying probe needs more
than a second in the first place, on ~a third of starts, when the app is already
listening. That question stays open, and this document should not be read as closing it.

## Result 1 — the app is not the input. My own sub-hypothesis is refuted.

Measured **off-cluster**, running the real bundled server (`.output/server/index.mjs`)
as a fresh process 8 times and timing spawn → `LISTENING` → first 200:

| | measured |
|---|---|
| socket bind | 23–37 ms |
| **first request** | **34–89 ms (HTTP 200)** |
| warm requests | 0–2 ms |
| first request over 1 s | **0 / 8** |

The refined mechanism above — "if the app's first `/api/health` costs between 1 s and
3 s, every `timeoutSeconds: 1` probe is cancelled before it finishes" — **requires an
app first-request cost near a second. It is ~36 ms.** So application lazy
initialisation is not the input to the livelock, and the ~9 s has to originate in
queue-proxy, pod-network programming, or the sandbox rather than the app.

Stated limits, because this is a local measurement: macOS/arm64, outside a container,
with no queue-proxy in the request path. It isolates one candidate input; it does not
reproduce cluster conditions. What it does do is remove the *most convenient*
explanation, which was mine.

## Result 2 — the timeout hypothesis is REFUTED. Raising it does not help.

Phase 2 swapped the assignments, and the slow mode appeared **in the `timeout=3` arm**:

| | phase 1 | phase 2 (swapped) |
|---|---|---|
| `p1b-bunexec` | t=3 → 0/3 slow | t=1 → 0/3 slow |
| `p1b-node` | t=1 → 0/4 slow | **t=3 → 2/6 slow — 10.55 s, 11.59 s** |

> Cell counts are sensitive to where the phase boundary is drawn: the swap took ~40 s,
> and a sample landing inside that window can be attributed either side. Counted from
> the swap timestamps (phase 1 ends 23:55:13, phase 2 begins 23:55:53) the totals are
> 16 samples, 7 at t=1 and 9 at t=3. An earlier pass of this analysis used looser
> boundaries and reported 15; every sample in the disputed window was FAST, so no cell's
> slow count and no verdict moves either way. The load-bearing cell — `node` at t=3 with
> 10.55 s and 11.59 s — is unambiguous.

Two things settle it, and neither depends on the base rate:

**The duration is invariant.** At `timeout=1` the slow band was 10.16–11.57 s. At
`timeout=3` it is 10.55–11.59 s. Raising the deadline threefold moved the tail by
nothing. A livelock caused by the deadline could not survive tripling the deadline.

> **Read that comparison with its asymmetry in view.** The `timeout=1` band is
> **historical** — the 2026-08-10 sitting — because the crossover's own `timeout=1` arm
> produced **zero** slow samples to compare against. So this is "t=3 slow samples land
> inside the previously-measured t=1 band", not "two arms measured side by side". What
> makes the inference hold anyway is that the prediction was about **magnitude**, not
> rate: the pre-registered livelock cell required Ready at ~2–3 s, and 10.55 s / 11.59 s
> falsify that on their own, whatever the base rate was doing.

**The event count tracks the timeout while the wall-clock does not.** Timeout-class
`Unhealthy` events appear at **count 9** on pods from the `timeout=1` era and at
**count 3** on pods from the `timeout=3` era. 9 × 1 s and 3 × 3 s are the same nine
seconds. This is precisely the pre-registered "fixed ~9 s" cell: *the timeout only
re-shapes how the nine seconds is divided.*

> Honesty about the strength of that second point: the pods were reaped before their
> Ready times could be joined to their event counts, so the 9→3 shift is measured
> across the two eras rather than proven per-pod. The duration invariance above needs
> no such join and carries the conclusion on its own.

### The pre-registered rule fired "tracks the IMAGE" — and I do not endorse it

Pooled by image: bunexec 0/6, node 2/10. Pooled by timeout: t=1 0/7, t=3 2/9. The rule
I wrote in advance reads that as image-tracking, and it is **underpowered**: two slow
samples total, against a base rate that swings 0–42%, cannot distinguish an image effect
from chance. I am reporting the rule's output because I committed to it, and rejecting
its conclusion because the evidence does not reach it. What the same data *does* support
is the refutation above, which rests on duration rather than on counting rare events.

**And the wider record refutes image-tracking outright**, which I should have cited
rather than resting on "underpowered". On 2026-08-10 `p1b-bunexec` — the arm that shows
0 slow in the crossover — produced **four** slow samples of its own: 10.66 s, 10.45 s,
10.33 s, 11.38 s
(`grep -h http_req_duration results/p1b-bunexec-20260810*.txt`). The slow mode plainly
occurs on both images. The crossover's 0/6 for bunexec is a small-sample artifact, not a
property of the image, and this was in the results directory the whole time.

## Aside — the control's failure to reproduce, and what it costs

The `timeout=3` run returned **0 slow of 16**, with **zero timeout-class probe events**
against 9 per slow pod at the baseline. Taken alone that looks like a fix. It is not
evidence, for a reason the base-rate history makes plain:

| sitting | timeout | slow rate |
|---|---|---|
| ABBA 2026-08-10 | 1 | **42%** |
| attribution 2026-08-11 | 1 | **0%** |
| per-invocation 2026-08-11 | 1 | **0%** |
| pinned crossover 2026-08-11 | 1 | **31%** |
| `timeout=3` run | 3 | 0% |
| crossover phase 1, **control arm** | **1** | **0 / 4** |

**The slow mode fires 0% in three of six sittings at `timeout=1`.** A quiet sitting and
a working mitigation are indistinguishable, which is exactly the confound that produced —
and then withdrew — the node-local claim. In crossover phase 1 the control arm did not
reproduce the phenomenon at all, so the treatment arm's 0% establishes nothing about the
treatment.

A crossover rules out the image only if the effect appears *somewhere*. With zero slow
samples in every cell it rules out nothing.

## Where this leaves the cold-start work

**Two candidate causes are now dead, both on measurement:**

1. **The app** — its first request costs ~36 ms, not ~1 s (Result 1).
2. **The probe deadline** — tripling it leaves the tail at 10.5–11.6 s (Result 2).

Combined with what was already ruled out — node identity, image pull, idle gap, revision
accumulation, per-invocation structure, CPU/memory/IO/steal starvation, concurrent-start
contention — the ~9 s is a **genuine, fixed period during which queue-proxy accepts the
connection and does not answer**, on roughly a third of cold starts, while the
application behind it is already serving in tens of milliseconds.

That is a much narrower target than when this started, and it is squarely platform-side:
queue-proxy's own probe path, CNI/veth programming, or sandbox setup.

**Do not raise `timeoutSeconds` as a cold-start mitigation *for this slow mode*.** It
does not shorten the tail; it only changes 9 probes into 3.

> Scope, because the flat imperative could be misread as universal. This refutes the
> deadline as a fix for the **~9 s queue-proxy slow mode**, and it rests on Result 1:
> this app answers its first request in ~36 ms, so one second is not a binding
> constraint on it. An app whose OWN first request genuinely exceeds a second — a
> heavier framework, a cold-JIT runtime, a health check that dials a dependency — is a
> different case entirely, and would legitimately need a larger deadline. Nothing here
> measures that case. Both benchmark services were returned to
`timeoutSeconds: 1` after the run, verified, and **no default was changed anywhere** —
there is nothing here to ship.

**The methodological blocker is unchanged and now better quantified.** The slow mode
fires 0% in three of six sittings, so any future test needs either a reproducer that
provokes it on demand, or enough samples to average over a 0–42% swing. n≈4 per cell —
what an ABBA of 3 blocks actually yields once empty `clear_pending` invocations are
excluded — cannot measure anything. Sizing the run is the first thing to fix, before the
next hypothesis is spent on the cluster.
