APPROVE (final, round 5 on 83256a6 — rounds 1–4 were ISSUES_FOUND; all records kept below, in order)

# Adversarial review — PR #801 (cold-start ledger, row 3) @ e070622

Standard applied: `.claude/review-795.md` + `.claude/review-799.md` (three rounds each). Every
published number was recomputed with `statistics.median` from the raw 8-cycle data; every
cross-row reference was opened in the merged ledger; the attribution chain was checked against
the *code that runs on the pod* (`packages/kn-next/src/adapters/cache-handler.js`), not against
the PR body.

## Arithmetic: clean. All of it.

- Every median in the row matches the instrument summary **exactly**, no hand-computation:
  wake 4917.5 ✓, first 239.5 ✓, warm 125.5 ✓, lazy 112.0 ✓, exec gap 3866.0 ✓
  (`statistics.median`, n=8 → mean of 4th/5th). The recurring wrong-median class does **not**
  recur; `median_wake_ms`/`median_exec_gap_ms` in the harness did their job.
- All eight per-cycle rows reconcile: `first − warm-best − lazy` = `[0,−1,1,0,0,0,0,0]` ✓.
- "7/8 at 95–337 ms" ✓ (`95,95,98,106,118,138,337`); "1/8 at 2.4 s" ✓ (2394); all bodies 14240 =
  the SUCCESS length rows 1–2 established ✓; "no wake shift" ✓ (−76 ms, vs the +544 row 2 had to
  carry); trajectory numbers 4719 ✓ (row 1), 103 ✓ (row 2), 112 ✓ (row 3).

The defects are **not** in the arithmetic this file has historically got wrong. They are in the
evidence chain behind the row's headline — which is the claim the whole iteration turns on.

## Blocking

1. **The row's central premise — that the measured pod was running the rooted `REDIS_URL` — is
   asserted and nowhere evidenced, and the code says the obvious inference is invalid.**
   The plane-state cell says "Redis host rooted (#800) and applied to the running ksvc (new
   revision)"; the attribution cell then says the stall was "on the **rooted** host". But at
   runtime the cache handler reads **`process.env.REDIS_URL` only**
   (`cache-handler.js:73`), and what #800 actually rooted is the *fallback default* in
   `apps/file-manager/kn-next.config.ts:17` (`process.env.REDIS_URL || 'redis://…svc.cluster.local.:6379'`)
   — which is **inert whenever the ksvc sets the env**, i.e. in the deployed case. So "#800 merged"
   + "a new revision rolled" does not establish the premise; only the env value read back off the
   measured pod does. #800's own body says exactly this ("the deployed apps read env from their
   applied CR/ksvc — the plane re-apply happens as the iteration-3 OKE verification … or the row
   measures nothing"). Review-799 raised this as item 9 against row 2 (pin causation to what was
   *running*, not to a PR number) and it is now load-bearing rather than hygienic: if the env was
   unrooted, row 3 is row 2 with a different tail count and the "it's TCP, not DNS" conclusion —
   and therefore the next lever — is unsupported. Publish the revision name and the pod's
   `REDIS_URL` (no credential in it; redact if that ever changes), the same way the row publishes
   bodies and retries.

2. **The stall's log evidence is not published, and its provenance is ambiguous in the one way
   that matters.** The same cell describes *two* log captures — an attribution sitting "between
   rows" that "pinned the residual to ioredis `connect ETIMEDOUT`", and "the one stall logs
   `connect ETIMEDOUT` on the rooted host". The attribution sitting ran **before** the Redis host
   was rooted (that is why #800 exists), so its ETIMEDOUT is evidence about the *unrooted* host.
   Nothing in the row distinguishes "cycle 3 of this sitting was log-captured" from "the earlier
   sitting's finding is being carried forward onto rooted ground". Row 1 set this file's standard
   by quoting the error string with its host (`EAI_AGAIN pggw-apps.scale-zero-pg.svc`); row 3
   quotes no line, no timestamp, no cycle. Publish the captured line for cycle 3 (and note that
   ioredis's `connect ETIMEDOUT` message does not itself carry the hostname — which is precisely
   why finding 1's env read-back is the load-bearing artifact).

3. **2394 ms is arithmetically inconsistent with a completed `connect ETIMEDOUT` under the
   committed defaults — so the published number and the published mechanism disagree.**
   `cache-handler.js:111` `CONNECT_TIMEOUT_MS = envMs('REDIS_CONNECT_TIMEOUT_MS', 5000)`, passed
   as ioredis `connectTimeout`, and `waitForReady` deliberately adds no timer of its own
   (`:186-198`) — the pre-handshake bound *is* that 5 s. A connect that times out therefore costs
   ≈5 s before fail-open, so `first` would be ≈5.1 s, not 2529 ms. (Row 2's 5465 ms residual is
   what a real 5 s budget expiry looks like.) `grep` finds **no `REDIS_CONNECT_TIMEOUT_MS`
   override anywhere in the repo**, so either the deployed env overrides it — publish it — or the
   2.4 s cycle is *not* a completed connect timeout. The parsimonious alternative is a
   SYN-retransmit-delayed connect that eventually **succeeded** (Linux first retransmit at ~1 s),
   which logs nothing at all — and if that is what happened, the `connect ETIMEDOUT` sentence is
   imported from the earlier sitting (finding 2), while the SYN-race conclusion survives on
   weaker, different evidence. Either way the row as written cannot be right about both numbers.

4. **The exec-gap column refutes the cross-row tail trajectory it is deployed to defend, and the
   row does not apply it there.** Median gap = 3866 ms of dead time before the first measured GET.
   Row 1's tail cycles are `[1714,1955,2555,6883,7565,8555,8896]`: **three of the seven are
   shorter than row 3's median gap**, so under the row-2/3 instrument they would have registered
   as ≈0 lazy. The like-for-like comparison is cycles above ~3.9 s: **4/8 → 1/8**, not 7/8 → 1/8
   — and the row's own sentence ("it shifts absolute `lazy` down uniformly") is what forces that
   correction. As written, the row uses the gap number to dismiss the confound in-sitting while
   leaving the headline trajectory computed across instruments as if the gap were zero.
   Related overclaim in the same sentence: "the gap column's first full sitting **bounds the
   row-2 confound** with data" — row 2 never measured the gap. Measuring it in row 3 bounds row 3
   and offers a *stationarity assumption* about row 2; say that.

## Should fix

5. **"Tail trajectory 7/8 → 2–3/8 → 1/8" injects an unpublished sitting as the middle term while
   the published middle term is 2/8** — and the same PR's prose gives the sequence as
   "7/8 → 1/8", dropping the middle entirely. Two different sequences for the same loop, in one
   diff. "2–3/8" has no publishable numerator anywhere in the repo. This file already set the
   precedent for exactly this (review-799 item 7: the discarded sitting's per-cycle lines were
   published rather than left "in the session records"), and the attribution sitting is now
   load-bearing for both the mechanism and the trajectory. Publish its per-cycle lines as an
   appendix, or state the trajectory from published rows: **7/8 → 2/8 → 1/8** (with finding 4's
   instrument correction attached).

6. **"The remaining 2.4 s class is attributed (SYN race on a fresh pod's first Redis connect)" is
   stated flatly; the evidence is n=1 and does not discriminate the mechanism.** A TCP-phase
   failure (or delay) excludes the resolver — it does not select "conntrack/veth SYN race" over:
   Redis-side accept-backlog/CPU starvation on a plane this file documents at **99%/85% CPU
   allocated** (row 1's own caveat, never retracted); kube-proxy/IPVS or NetworkPolicy programming
   lag for the Service on a fresh pod (TCP-phase, not veth); or the redis pod's own state, which
   the row publishes nothing about. The row hedges the *trajectory* ("suggestive, not proven") and
   then does not hedge the *mechanism*, which is the claim the next lever is chosen from. Label it
   a candidate, or name the check that would discriminate it (a `ss`/conntrack or tcpdump capture
   on the next stall is cheap and this loop has a stall roughly 1-in-8).

7. **"unchanged cycle-to-cycle (3730–4730)" overstates uniformity, and the strongest available
   argument is the one not made.** A 1000 ms spread is 27%, and the *maximum*-gap cycle (8, 4730)
   is also the maximum non-stall lazy (337) and the minimum warm (99) — the one cycle where the
   claimed uniformity visibly fails. The clean argument is right there in the data and needs no
   uniformity assumption: **the stall cycle's own gap (3792) sits at the median**, so the gap
   cannot be what made cycle 3 slow.

8. **The next-lever sketch describes app behaviour that does not exist and contradicts a recorded
   decision, and it omits its own main hazard.**
   - "(inside the 4–5 s boot window, **retried before readiness**)" — fm readiness deliberately
     does **not** gate on dependencies: `apps/file-manager/src/app/api/health/route.ts:5-8`
     ("Returns 200 whenever the process/server is up, WITHOUT dialing Postgres/Redis … Gating
     readiness on a scale-to-zero DB's reachability defeats scale-to-zero", #338/ADR-0026), and
     with no readinessProbe on the ksvc the pod is Ready as soon as the server listens. So a boot
     connect races the first visitor rather than being absorbed by readiness — unless the lever
     blocks `listen`, which is the thing ADR-0026 rejected and which would move the cost into
     `wake`.
   - Omitted hazard: a failed boot connect calls `markUnhealthy`, which opens the breaker for
     `RETRY_COOLDOWN_MS = 5000` (`:113,133,243`). The first visitor arriving inside that window
     gets the in-memory fallback **silently** — the lever trades a visible 2.4 s stall for an
     invisible 5 s split-cache window. That is the same shape as the synthetic-warm concern, and
     it belongs in the sketch.
   *(The sketch's one genuinely good distinction — "for connections, not renders" — is correct and
   does side-step the cache-poisoning class; keep it.)*

9. **`103 → 112` is +8.7% and is presented inside an improvement narrative without a word.** The
   honest reading is that #800 moved the **tail**, not the median (the median was already at the
   DNS-free floor), and that 9 ms is inside sitting-to-sitting noise — which the row can only
   assert loosely anyway, since row 2's exec gap is unmeasured (finding 4). One clause fixes it;
   leaving it makes a flat median read as continued progress.

10. **The file's forward-looking sections are now stale and were not touched.** "Next iteration
    (chosen from the measurement)" still says "the still-unrooted app-level Redis host [is an]
    iteration 3 candidate", and lever 1's annotation still ends "the app-level Redis host
    remains" — both falsified by this very row. Row 3's chosen lever exists only inside the row's
    prose, not in the section where this file puts chosen levers, and there is still no
    "Iteration 2/3 — what was proven" heading paralleling iteration 1's. For a file whose stated
    job is the loop's memory, the next reader will re-derive the split that #800 already closed.

11. **The pull column was collected and dropped again — and this row is the one where it would
    have paid.** The harness captures per-cycle `Pulled/Pulling` (`:87-96`) and the file header
    advertises "per-cycle image-presence evidence"; the row-3 table has no such column, while
    cycle 2's **12982 ms** wake is carried as "still unattributed". An image pull is the leading
    candidate for exactly that, the evidence existed at run time, and cluster events expire in
    ~1 h — so this becomes permanently uncheckable, as row 2's already did. Same for
    `x-nextjs-cache`, which for cycle 3 is the discriminator between "slow dependency" and
    "MISS vs HIT".

12. **Cycle-1 `lazy` cell (98) does not match the run output you supplied (95).** `lazy_ms =
    round(f_ms − min(w1,w2))` computed on unrounded floats can diverge from
    `round(first) − round(warm)` by at most **±1**, so a 3 ms gap is not a rounding artefact —
    either the cell is hand-derived from the two rounded columns or the transcription is off.
    No published median changes (112 either way), but this is the hand-computation class this
    ledger has now been burned by five times; reconcile the cell against the emitted JSON line.

13. **Carry-over, still open:** `bench-timer` has no manifest anywhere in the repo, so row 3, like
    row 2, is not reproducible by a future reader (review-799 item 11).

## Security / conventions

Docs-only, one file, additive. No secrets, no `:latest`, no shell, no cluster mutation, no code.
The one artifact I am asking you to publish (finding 1) is a `redis://host:6379` DSN with no
credential — safe as-is; redact if that ever carries auth.

## Test quality

Arithmetic is the only guard available and it now closes on **every** published cell — all five
medians match the instrument's own summary exactly and all eight per-cycle rows reconcile, which
is the first row in this ledger's history where the number-checking finds nothing. The guard that
moved into the harness worked. What is unguarded is now entirely **provenance**: the row's
headline rests on an env value nobody published, a log line nobody published, and a sitting nobody
published — and its one hard number (2394 ms) contradicts the committed 5 s connect budget the
mechanism requires. The ledger's own standard ("the loop's memory must be derivable") is what
these fail, not the arithmetic.

---

# Round 2 — verdict on 9e80190 (e070622..9e80190)

**ISSUES_FOUND.** Eight of the nine are genuinely closed and I re-derived each rather than
accepting the summary — including a live read-back off OKE, which I did rather than trusting the
row. But the fix to findings 2+3 **introduced a claim the committed code falsifies**: Appendix C's
captured line cannot have come from the cache handler's client, so the mechanism cell's surviving
hard claim ("TCP-phase on the Redis path") and the appendix's new boot-phase escape hatch both
rest on lines emitted by a *different* client. That is the successive-round class `workflow.md`
names, and it is two sentences from closed.

## Verified independently, not from the row

- **The premise is real. I read it off the cluster.**
  `kubectl --context context-ckmva7v7zvq get revision fm-node-00093` →
  `REDIS_URL=redis://redis.default.svc.cluster.local.:6379` ✓ (rooted, trailing dot), and the
  ksvc's `latestReadyRevisionName` **and** its 100%-traffic target are both `fm-node-00093` ✓
  (revision created 10:38:08Z — i.e. by the hand patch, before #800 merged at 10:45:28Z, exactly
  as the row now states). The Revision object is durable, so this stays checkable. Round-1
  finding 1 is closed in the strongest available form.
- **No timeout overrides in the deployed env** — the same read-back carries no
  `REDIS_CONNECT_TIMEOUT_MS`/`REDIS_COMMAND_TIMEOUT_MS`, so the committed defaults (connect 5000,
  command 2000, breaker 5000) *are* the deployed numbers. That makes the budget arithmetic below
  binding rather than theoretical.
- **Row-2 above-gap count: your correction is right, mine was unstated and yours is arithmetic.**
  Row-2 lazies `[98,105,3591,101,122,90,95,5465]` → only 5465 exceeds 3866 → **1/8** ✓.
- **Appendix B reconciles:** `[92,5615,101,193,3376,95,6386,115]` → 3/8 raw tail ✓, **2/8** above
  the gap (5615, 6386) ✓. Row 1 4/8 ✓, row 3 1/8 ✓. So `4/8 → 1/8 → 2/8 → 1/8` is correct and in
  chronological order ✓. The old unpublishable "2–3/8" is now a published sitting.
- Gap argument replaced with the assumption-free form (stall cycle's 3792 = the median) ✓;
  27% spread and the cycle-8 counterexample conceded ✓; "stationarity assumption about row 2"
  stated ✓; +8.7% stated plainly as tail-moved-not-median ✓; lever reshaped against ADR-0026 with
  readiness untouched and the `markUnhealthy`/5 s breaker hazard named as a must-not-trip
  requirement ✓; mechanism cell no longer asserts the SYN race and names the discriminator ✓.

## Blocking

1. **Appendix C's line cannot have been emitted by the cache handler — the code makes that
   impossible — so the capture does not evidence the cache path.**
   `node_modules/ioredis/built/Redis.js:580-585`: `[ioredis] Unhandled error event:` is printed
   **only** when `this.listeners('error').length === 0`. The cache handler attaches a permanent
   error listener the moment the client is constructed (`cache-handler.js:171-173`, before any
   connect — `lazyConnect: true`), so its failures surface as `[CacheHandler] Redis error: …`
   (`:172`) and `[CacheHandler] Redis unhealthy, failing open: …` (`:145`) and **never** as
   `[ioredis] Unhandled error event`. Two other clients in the same process do produce exactly
   that string, and both fit the magnitude better than anything the row proposes:
   - `apps/file-manager/src/app/api/cache/events/route.ts:32-37` — **module-scope**, no
     `lazyConnect` (so it dials on module evaluation), **no error listener**, `connectTimeout: 2000`;
   - `packages/lib/src/health/index.ts:90-93` — same shape, `connectTimeout: 2000`, no listener
     (deep-health only, so less likely under this instrument, which hits shallow `/api/health`).
   Consequences the row must absorb: (a) "**TCP-phase on the Redis path**" is true only of
   *whichever client logged it*, not of the cache path the tail is about; (b) the new boot-phase
   caveat is right for the wrong reason — the cache client has **no** boot phase at all
   (`lazyConnect` + `/api/health` never touches Redis ⇒ its first connect *is* the measured GET),
   whereas a module-scope client's dial genuinely can predate it; (c) four unhandled ETIMEDOUTs at
   a 2 s budget with ioredis's default retry ≈ 8–10 s of the pod's life, which fits a cycle
   comfortably and tells you the emitter was reconnecting in a loop, not stalling one request.

2. **The discriminating line was in the same capture window and its presence/absence is not
   stated — and Appendix B proves it is the discriminator.** Appendix B records that all three
   pre-#800 stalls logged ioredis ETIMEDOUT **plus** `[CacheHandler] Redis unhealthy, failing
   open`. Appendix C shows only the ioredis lines. If that is complete, the cache handler did
   **not** fail open in cycle 3 — which is positive evidence for the delayed-success reading and
   against the ETIMEDOUT-during-the-GET reading, i.e. the strongest sentence available and it is
   missing. If the `[CacheHandler]` line *was* present and was trimmed, then Appendix C is not
   "verbatim" and the reading inverts. One clause either way: *"no `[CacheHandler]` error or
   failing-open line appeared in the capture."*

3. **The mechanism chosen as "parsimonious" is the worst numeric fit of the available
   candidates.** Linux SYN-retransmit backoff is quantised (~1 s, then ~3 s, ~7 s), so a
   retransmit-delayed connect lands near 1.1 s or 3.1 s — **not** 2394 ms. Three committed 2000 ms
   budgets sit right on it: `connectTimeout: 2000` on both non-cache clients above, and —
   the one that touches the render path — **`COMMAND_TIMEOUT_MS = 2000`** (`cache-handler.js:112,165`),
   which by the file's own documentation bounds the **ready-check `INFO`**, i.e. the second half
   of `waitForReady` (`:191-196`, with a test named for the busy-but-never-ready server). A cache
   connect whose TCP handshake **succeeded** and whose ready-check `INFO` then timed out at 2 s
   produces ≈2000 ms + connect + render delta ≈ the observed 2394 ms, and it is **post-handshake**
   — a Redis-server-responsiveness fault on a 99%/85%-allocated plane, *not* a TCP-phase one. It
   is absent from the candidate list while the cell's headline still says "TCP-phase … resolver
   excluded". Add it, and soften the headline to what survives: *something in the pod could not
   reach or could not be answered by Redis inside a 2 s budget around the measured GET.*

## Should fix

4. **The boot-phase ambiguity is carried forever for no reason — it is one flag.**
   `kubectl logs --timestamps --since-time=<wake t_done>` resolves it permanently, and the
   instrument already records the in-pod epoch stamps (`LAST_CALL["done"]`) that give you the
   cutoff. `--tail 60` on a boot-noisy pod is *why* the ambiguity exists. Name the flag in the
   appendix so the next stall's capture is unambiguous; this is the same "collected and dropped"
   class as the pull column.
5. **Round-1 findings 10–13 were not in the "nine" and are still open.** Two are cheap and one is
   now permanent:
   - **#10 (worth fixing before merge):** "Next iteration" still lists "the still-unrooted
     app-level Redis host" as an iteration-3 candidate and lever 1's annotation still ends "the
     app-level Redis host remains" — both falsified by this row; and row 3's chosen lever still
     lives only in row prose, not in the section this file reserves for chosen levers.
   - **#12 (one cell):** cycle-1 `lazy` 98 vs the run output's 95; rounding cannot produce Δ3.
   - **#11:** the pull column is dropped again while cycle 2's 12982 ms wake stays unattributed —
     now permanently uncheckable (events expired). Appendix B's own bimodal-wake note ("image
     present every cycle") shows the evidence existed for *that* sitting and was again not
     published as a column.
   - **#13:** `bench-timer` still has no manifest; rows 2–3 remain non-reproducible.
6. **The PR title, body and commit message still carry the narrative the row now corrects.**
   Title "tail down to 1/8" and body "tail 7/8 → 1/8" versus the row's corrected
   `4/8 → 1/8 → 2/8 → 1/8`. The commit message is permanent, and by the corrected series **row 2
   and row 3 are indistinguishable (1/8 each)** — what row 3 adds is the evidence class and the
   evidenced premise, not a tail reduction. The row's own "the multi-second tail shrank" plus the
   bold **1/8** tail cell still invite the #800-shrank-it reading; one clause ("row 2 was already
   1/8 above-gap; the change here is the evidence class, not the count") closes it. This is
   `workflow.md`'s "re-read your own claims against the current tree before merging".

## Test quality (round 2)

Arithmetic remains clean on every published cell and now on two newly published sittings
(Appendix B reconciles to its own claims, the above-gap recount is right, the row-2 correction is
yours and it is correct). The premise moved from assertion to a cluster-durable object I verified
myself — that is the single best edit in this commit. What is still unguarded is the same thing as
in round 1, one level down: the log capture is the only non-numeric evidence in the row, and
nobody checked *which client* could have produced it. The committed code answers that question
unambiguously, and it answers against the row.

---

# Round 3 — verdict on 6cedd7f (9e80190..6cedd7f)

**ISSUES_FOUND** — narrowly, and not on anything rounds 1–2 raised. The provenance analysis is now
**exactly right** and I re-verified every clause of it against the installed code, including the
retry arithmetic. But the absence-discriminator I asked for has been used to carry a conclusion it
does not support, and the one thing that would bound it — the capture command — was **deleted**
from the appendix in this same commit. Both are one clause from closed.

## Verified — the provenance analysis is correct, clause by clause

- `Unhandled error event` only without an error listener ✓ (`ioredis/built/Redis.js:580-585`);
  cache handler attaches one at construction before any dial ✓ (`cache-handler.js:171-173`,
  `lazyConnect`); its failures log as `[CacheHandler] Redis error` / `failing open`
  (`:145,172`) ✓.
- The fitting emitters are named correctly ✓ — `api/cache/events/route.ts:32-37` (module-eval
  dial, no listener, `connectTimeout: 2000`) and `lib/health/index.ts:90-93`.
- **The retry arithmetic checks out**: ioredis's default `retryStrategy` is
  `min(2^(times−1)·50, 5000) + jitter≤200` (`RedisOptions.js:11-16`), so 4 timeouts at a 2 s
  budget ≈ 8.0 s + ~0.5 s of backoff ≈ **8.5 s** — "≈8–10 s of reconnect loop" ✓.
- "The cache client has no boot phase; the module-scope clients genuinely do" ✓, and the
  knock-on (b) app-defect call is correct — that client dials at module evaluation with no
  listener and loops forever. Worth filing.

## Blocking

1. **The absence argument is used to select a Redis reading, but the measured page's own
   dependency is Postgres — and nothing published excludes it.**
   `apps/file-manager/src/app/dashboard/page.tsx:1-24` is `unstable_noStore()` plus **three raw
   `db.query` calls** through `getDbPool()`. So the dominant first-request work on the measured
   path is the **PG pool's first connect**, and row 0 attributed multi-second `first` values to
   exactly that class. "No `failing open` line" establishes only that *the cache handler's connect
   budget did not expire*; it says nothing about what consumed the 2394 ms. Two readings are as
   compatible with that absence as the one the row chose, and both change the lever:
   - **PG first-connect / pool warm on a fresh pod** — not excluded anywhere for cycle 3.
     (Appendix B's "zero PG-side `EAI_AGAIN`" excludes only the *resolver* failure mode, in a
     *different* sitting.)
   - **A cache connect that handshook fast and whose ready-check `INFO` was slow but stayed
     inside `COMMAND_TIMEOUT_MS = 2000`** (`:112,165`, the bound documented at `:191-196`) —
     no failing-open line either, and it is post-handshake, i.e. Redis-server responsiveness, not
     TCP.
   As written the cell reads "the 2394 ms reads as its first (lazy) connect being
   retransmit-delayed and succeeding", which is one of at least three. Either publish the cycle-3
   capture's PG evidence (or state its absence, as you did for Redis) or list these two alongside.
   *Note the lever consequence, which is the reason this is blocking rather than a nit:* eager
   cache-handler connection at boot does nothing at all under the PG reading, and little under the
   slow-`INFO` reading.
2. **The capture's command and window were removed in this commit, and the absence argument
   depends on them.** The previous revision said "Capture is `kubectl logs --tail 60` on the
   cycle's pod AFTER the measured GET"; that sentence is gone, so the appendix now leans harder on
   what the capture does *not* contain while no longer stating what the capture *was*. This is
   quantifiable and it is not comfortable: `console.error("[ioredis] Unhandled error event:",
   error.stack)` prints a **full stack** (~10 lines), so the four events the appendix itself
   annotates "with stack" plausibly consume **~40 of the 60 lines**. A
   `[CacheHandler] … failing open` line emitted during the measured GET is evicted if ~60 lines
   followed it. My round-2 wording was conditional ("*if* that is complete") and the commit took
   the first branch without establishing completeness. Restore the command, and either quantify
   the window (line budget vs stacks) or re-capture with `--timestamps --since-time=<wake t_done>`
   — the instrument already records that stamp, and it closes this and the boot-phase ambiguity
   permanently, for one flag.

## Should fix

3. **"Retransmit-delayed" still does not fit the number, and the candidate that does was
   dropped.** Linux SYN backoff is quantised (~1 s, ~3 s, ~7 s), so a retransmit-delayed connect
   lands near 1.1 s or 3.1 s — 2394 ms is neither. The cell's candidate list kept the SYN race and
   dropped the 2 s command-timeout/ready-check candidate raised in round 2, which is the only
   committed budget the magnitude sits on. Keeping "retransmit-delayed" as *the* reading while
   the number fits no retransmit step is the kind of claim this file has twice had to walk back.
4. **Round-1 items 10 and 12 are still open after three rounds and are each one line.** The file
   still tells the next iteration to root "the still-unrooted app-level Redis host" (Next-iteration
   section + lever 1's annotation) — falsified by this very row, in the same file; and cycle 1's
   `lazy` cell (98) still disagrees with the run output (95) by more than rounding permits. Items
   11 (pull column, now permanently uncheckable) and 13 (`bench-timer` has no manifest) I would
   not re-round for, but they should be named in the row as known limits rather than silently
   carried.

## Test quality (round 3)

The evidence chain is now the strongest it has been: the premise is a cluster-durable object I
read myself, the log provenance is derived from the installed ioredis source and matches the row's
text clause for clause, and the mechanism is explicitly labelled undiscriminated. What round 3
adds is a reminder that an *absence* is only as strong as the window it was observed in and the
alternatives it rules out — and this row's absence was published without its window and used to
rule out alternatives it does not touch, one of which (Postgres) is the measured page's only real
dependency.

---

# Round 4 — verdict on 382de8d (6cedd7f..382de8d)

**ISSUES_FOUND — on two one-line items only, both raised in round 1 and still open.** Everything
substantive is closed and verified; nothing below requires me to re-derive anything, and I would
approve on sight of the two edits named in §Blocking.

## Verified — round-3 items are genuinely closed

- **The absence argument is now scoped to exactly what it establishes** ("establishes ONLY that
  the cache handler's 5 s connect budget did not expire in cycle 3") with the three compatible
  readings listed and **PG-pool first-connect leading** ✓. The supporting facts are correct as
  stated: `/dashboard` is `unstable_noStore()` with three raw `db.query` calls through the pool
  (`page.tsx:1-24`) ✓; reading 3 is correctly labelled post-handshake rather than TCP ✓; the
  Appendix-B zero-`EAI_AGAIN` caveat ("resolver mode only, different sitting") is exactly right ✓.
- **The lever is gated, and gated on the right thing** — heading changed to "GATED on
  discrimination", and iteration 4 now *opens* with discrimination (per-dependency timing +
  conntrack on the next stall), the eager-connect lever taken only if the cache-TCP reading wins ✓.
  That is the structural fix, not a wording one: the row no longer names a lever its own evidence
  cannot support.
- **Capture command restored** ✓, and the newly disclosed keyword filter is a net gain in honesty
  (the `[CacheHandler] … failing open` string contains both "Redis" and "open", so the filter
  would not have hidden it). The `--tail 60` line-budget worry I raised is now **self-limiting and
  I withdraw it as a defect**: the published 2394 ms independently corroborates "budget did not
  expire" — a 5 s expiry cannot produce a 2.5 s render — so the conclusion no longer rests on the
  absence alone. Worth one clause in the appendix, not a round.

## Blocking (both are single-line edits; no re-review of anything else needed)

1. **Row-3 table, cycle 1, `lazy` = 98 vs the run output's 95 — unresolved after four rounds, and
   it is in the row's own published table.** `lazy_ms = round(f_ms − min(w1,w2))` computed on
   unrounded floats can differ from `round(first) − round(warm)` by at most **±1**, so Δ3 is not a
   rounding artefact: either the cell was derived from the two rounded columns or the transcription
   in the task brief was wrong. No median changes (112 either way), and the fix may well be "confirm
   against the JSON, change nothing" — but this file's entire defect history is wrong-cell
   arithmetic, and right now the only record of the run output contradicts the published table.
   Paste the emitted line for cycle 1, or correct the cell.
2. **The file still contradicts itself about what iteration 4 should do.** `:244` ("the
   still-unrooted app-level Redis host [is an] iteration 3 candidate") and `:257` (lever 1's
   annotation, "the app-level Redis host remains") are falsified by the row directly above them —
   the host is rooted and cluster-verified. A reader of "Next iteration (chosen from the
   measurement)" gets the wrong instruction from the section whose whole job is to give the right
   one. (Row 2's *historical* cell at `:38` is fine and should not be rewritten — history is
   history; the forward-looking section is not.) Row 3's chosen next step — discrimination — also
   still lives only in the row cell, not in that section.

## Nits (do not re-round)

- Reading 2 ("retransmit-delayed but succeeding") is the numerically weakest of the three: Linux
  SYN backoff is quantised (~1.1 s / ~3.1 s), and 2394 ms sits on neither. One clause would rank
  the readings by fit instead of leaving them equal.
- Appendix C's heading still says "verbatim" while the body discloses a keyword filter — "verbatim,
  keyword-filtered" costs two words.
- Round-1 items 11 (pull column, now permanently uncheckable) and 13 (`bench-timer` has no
  manifest, so rows 2–3 are not reproducible) should be named as known limits of these rows rather
  than silently carried.

## Test quality (final)

Four rounds, every round found something real, and the shape of the findings moved the right way:
round 1 was arithmetic and unpublished evidence, round 2 was a premise I could read off the
cluster, round 3 was an inference reaching past its evidence, and round 4 is two leftovers. What
the row now claims, it can support: the premise is a durable cluster object, the log provenance is
derived from the installed ioredis source, the mechanism is explicitly undiscriminated with three
ranked-by-plausibility readings, and the next lever is gated on discriminating them rather than
assumed. That is a materially different artifact from the one I first read, and the two open items
do not touch any of it.

---

# Round 5 — FINAL VERDICT on 83256a6 (382de8d..83256a6)

**APPROVE.** Both round-4 items are closed, and I checked the two claims the fix itself makes
rather than accepting them.

- **Item 1 — resolved in the table's favour, and the resolution is now findable.** The quoted
  emitted line reconciles exactly: `warm = min(139, 123) = 123`, `221 − 123 = 98` = the published
  cell ✓. The Δ3 was the brief's transcription, not the ledger — and quoting the line in the row
  is the right close, because the contradiction is now resolvable by a future reader instead of
  living in a review file. Six wrong-cell candidates in this file's history, and this one was the
  ledger being right.
- **Item 2 — the forward-looking section no longer contradicts the row.** "Next iteration" now
  records both levers as taken (#796 minted PG DSNs, #800 the Redis host, cluster-verified on
  `fm-node-00093`) and opens iteration 4 with **discrimination** rather than a lever — consistent
  with the mechanism cell, which is what the gating was for ✓. Lever 1 is annotated "TAKEN in
  full" with both rows cited ✓.
- **I checked the new claim's weakest word.** "Rooted … everywhere **taught** and deployed" is the
  exact assertion review-800 round 1 falsified against the docs site and the deploy skill. It now
  holds: `apps/docs/content/docs/oke.mdx:102` and `openshift.mdx:95` both carry
  `…svc.cluster.local.` and `.claude/skills/knext-deploy/SKILL.md:79` is `redis://redis.shop.svc.:6379`
  ✓ — closed before #800 merged, so the sentence is accurate rather than aspirational.

Nothing else changed; every number, the premise, the log provenance, the three-reading mechanism
and the gated lever are as verified in rounds 1–4.

## Final note on quality

Five rounds. Round 1 found unpublished evidence behind a published conclusion; round 2 found a
premise that turned out to be true and is now a durable cluster object; round 3 found an inference
reaching past what an absence can establish; round 4 found two leftovers; round 5 found nothing.
The row that merges is not the row that opened: its premise is cluster-verified, its log evidence
is bound to the client that provably emitted it, its mechanism is explicitly undiscriminated with
three readings ranked by the measured page's own dependencies, its trajectory is
instrument-corrected, and its next step is discrimination gated on that ambiguity rather than a
lever assumed from it. Ship it.
