# Sprint-2 close — SYSTEM DESIGNER gate

Scope: the sprint AGGREGATE (`.claude/rules/workflow.md` sprint-close), not each PR.
Everything below was verified against the branches/PRs, not the brief. Method note: the
sprint's branches are **stacked** — `origin/agent/s2-tail` contains the content of
`s2-scaffold-parity`, `s2-byte-cap`, `s2-guard-provers` and `s2-hardening` — so a diff against
`main` from any one of them over-reports. I read each subject file at its owning branch.

## Verdict

**CLOSE WITH CONDITIONS.** The sprint did real, load-bearing work and one live security
exception (ADR-0044 Option C) genuinely closed. But **two of my three refuse-to-close-without
criteria are met only as source-level claims**, and the sprint produced 8,458 lines of new
scanner/prover code (73% of everything it added) whose own defect rate this sprint exceeded that
of the code it guards. Closing is right; closing *unconditionally* would ratify "a guard asserting
text about the system" as equivalent to "the system observed working", which is the exact
substitution `workflow.md` step 4 exists to forbid.

---

## 1. The three refuse-to-close-without criteria, scored honestly

### (1) Byte cap enforced on the binary, chunked case proved — **MET**

Verified, not taken on trust:

- `runtime-contract.mjs` (all copies): `DEFAULT_MAX_REQUEST_BYTES = 8 MiB`,
  `METRICS_MAX_REQUEST_BYTES = 64 KiB` **fixed**, `MAX_REQUEST_BYTES_ENV = KNEXT_MAX_REQUEST_BYTES`.
- Wired at **both** listeners: the srvx app serve (`knext-bun-entry.mjs.hbs:195`) and the `:9091`
  `Bun.serve` (`:259`) — the co-resident path ADR-0044 named as unbounded at Bun's 128 MB default.
- Defaults fail **closed**: an invalid value falls back to the default with a warning (never to
  uncapped); `=0` uncaps the app loudly **and still caps `:9091`** (`tests/request-byte-cap.test.ts`
  asserts "the knob must not reach it").
- Behavioural proof over real sockets: `examples/bun-exec/test/request-byte-cap.test.ts` — honest
  413, **chunked-413 with no `Content-Length`**, under-limit pass-through, bodyless `Upgrade`
  pass-through, streaming SSE response still streaming, `:9091` capped with a working scrape.
  **It runs in CI**: `examples/bun-exec` `"test": "node ../../scripts/bun-test.mjs …"` is invoked by
  the `bun-exec-hardcap` job with `KNEXT_REQUIRE_BUN=1` (skip → throw). Not an orphan test.
- Wiring proof is a **scan** of every file importing `srvx/bun` (five entry copies + the harness), so
  a cap wired into two of five reds. Mutation-proved (`scripts/mutation-prove-bytecap.mjs`, 7/7).
- The Bun floor is pinned as a dependency (`BUN_COUNTED_BODY_FLOOR`) — correct, because the
  counted-bytes guarantee is Bun's, not ours.
- ADR-0044 Amendment 4 states the one Decision-4 constraint that could **not** be met (the 413
  cannot name which cap fired; Bun synthesizes it before user code) rather than dropping it, and
  explicitly refuses to claim rate limiting is closed. That honesty is why I score this MET.

Two scope facts to keep straight, neither a defect: the cap lives on the **vinext single-executable
target**, which under **ADR-0048 is the only target**, so "a platform control on every path" holds
*given ADR-0048* — it would be overbroad the day a second target returns. And the cap is an
**app-side env**, so a user can uncap their own pod via `spec.env`; there is deliberately no CRD
field (avoids the #548 upgrade-order trigger). It is therefore a per-pod default, not an
operator-enforced invariant. If it should become one, that is a CRD change and a #548 trigger.

### (2) A scaffolded app that boots, goes READY, optimizes images, caches ISR — **NOT MET**

Source-level evidence is good:

- `templates/app/src/app/api/health/route.ts.hbs` exists in **both** scaffolders, shallow by
  construction (no imports, no I/O, no env reads), `dynamic = 'force-dynamic'`, and it matches the
  operator's default probe path (`nextapp_controller.go:759` → `/api/health`).
- The `/_next/image` intercept is reconciled into the templates and all copies pinned by scan
  (`scripts/lib/runtime-entry-copies.mjs`, prover committed).

But **no scaffolded app has been observed running**. Every artifact here is a template file and a
drift scan. The ISR half is weakest of all: the guard that covers ISR under vinext
(`cache-handler-isr-staleness.test.ts`, #906) is one of the **four guards shipped with a dated
exemption instead of a prover** (#928) — and #928 itself ranks it *highest priority, write this
first*. So exit criterion 2's ISR clause is backed by a guard that is neither mutation-proved nor
cluster-observed. **Score: not met. Do not record it as met at the next planning meeting.**

### (3) Id flow closed end to end, lock-step guard failing loudly — **MET at CR level only**

Read at `origin/agent/s2-skew-chain:packages/kn-next/src/cli/deploy.ts`:

- The vinext leg (`~:523`) has **no skip path**, runs under `--skip-build`, and throws — a
  `UsageError` with a one-word fix under `--skip-build`, a plain `Error` otherwise. It asks the same
  question the #892 marker write asks (`verifyVinextStaticPrefix`), so marker key ≡ protection key
  ≡ image tag ≡ `spec.buildId` **by construction**, not by two call sites agreeing. That is the
  right structural fix and it is what the sprint plan asked for.
- The surviving ENOENT-warn-skip is scoped to the **non-vinext** leg, with the reason written down.
  Under ADR-0048 that leg is not a shipping path. Acceptable; not a fail-open on the shipped target.
- Scoping to `hasStorage(config) && !options.skipUpload` is a scope, not a skip — where the subject
  exists, every branch aborts. Verified by reading the branches, not the comment.

Cluster half pending, same gate as (2).

### What the post-merge kind/OKE verification MUST exercise

Run on **kind first, then OKE**. On OKE, confirm the **deployed operator image digest** before
attributing any behaviour to code — this sprint's plan already lost a hypothesis to
operator-source-vs-deployed once. Write results to a file; a green terminal is not evidence.

| # | step | assertion that makes it evidence |
|---|---|---|
| a | `kn-next create` a fresh app (NOT `apps/docs` or `file-manager`) | the subject is a **generated** app; a repo app proves nothing about the templates |
| b | vinext build + deploy | build target is vinext; record the built static prefix and the deploy tag |
| c | **boot → READY** | revision `Ready=True`; probe path is `/api/health` and returns 200; **and the negative**: pod `restartCount == 0` after ≥5 min (liveness is the half that restart-loops) |
| d | **`/_next/image` 200 via sharp** | `GET /_next/image?url=…&w=640&q=75` → 200, `content-type: image/webp` (or avif), transferred bytes **< source bytes**, and evidence the transform ran (sharp in the boot/req log), not a pass-through 200 |
| e | **ISR revalidation** | hit an ISR route → `x-nextjs-cache: MISS`; again → `HIT`; wait past `revalidate` → `STALE` then `HIT` with **new content**; assert the key exists in **Redis** (`cache-handler.js` is the ISR store, not GCS) |
| f | **skew guard aborts** | deploy with `NEXT_DEPLOYMENT_ID` ≠ the built static prefix → the CLI **aborts** with the fixed sentence, cluster untouched; then the positive: a matched deploy leaves the prior revision's assets present and a GC run reaps only a genuine orphan |
| g | **byte cap 413 on the wire** | `POST` 9 MiB honest → 413 (empty body); `POST` 9 MiB **chunked, no Content-Length** → 413; `POST` 1 MiB → 200; `GET :9091/metrics` → 200 while `POST` 65 KiB to `:9091` → 413; boot log shows `REQUEST_BYTE_CAP:8388608 METRICS_BYTE_CAP:65536 (default)` |
| h | probe hygiene | nothing probes a deep-dependency path; `/api/health` still 200 with the database scaled to **zero** |

Until (c)–(e) are green on OKE, exit criterion 2 stays open and sprint 3 inherits it.

---

## 2. Failure-mode review of the new guard fleet, as a system

The fleet now is: the **prover lane** (discovery + runner-resolution audit + spec-framework match +
#912 anchor liveness), the **per-prover liveness audit**, **dated exemptions**, the **scratch-space
scan** (location / write-destination / lifetime), the **skip scan**, the **metric-docs contract**,
the **seam-relocation clock**, the **native-integrity clock**, the **entry-copy parity scan** and the
**byte-cap serve-site scan**. Provers went **16 → 31**; root `tests/` **103 → 111**.

### Where it still fails open

1. **Static scanning is the fleet's shared, unbounded blind spot.** Nearly every new guard is a
   regex over blanked source. Its own comments admit it: *"a scan of blanked code cannot see a call
   at all"*; `proverSubjectPaths` resolves string literals and `const`-bound identifiers only. A
   computed destination (`join(ROOT, name)` where `name` is a parameter, a `.map()`, a template
   hole), a helper in another file, or a dynamic import is **invisible and reports clean** — the
   exact `anchors=0 && bindings=0` shape review caught on four provers, where repointing one at a
   **deleted** file left the lane green. The `$`-boundary class taking 5 rounds is the same disease.
   **Nothing in the fleet asserts a lower bound on what the scanners can see.** A scanner that finds
   zero sites and a scanner that finds every site are indistinguishable in a green run.
2. **Six dated exceptions, all clocked to roughly the same window, each enforced by a member of the
   fleet.** #928's four unproven guards (2026-11-01), #939's 161-leaks/48-files ratchet (recorded
   2026-09-05), the write licence, the coverage branch/statement drop, the native-integrity clock,
   the seam-relocation clock (#936). If they lapse as a bloc, CI reds on six fronts at once and the
   cheap response is to re-date all six — which is how a dated exception becomes a permanent one.
   This is a **systemic** fail-open, not six local ones.
3. **The lane audits provers; nothing audits the lane.** `tests/mutation-prover-lane.test.ts` (634
   lines) and `scripts/lib/prover-lane.mjs` (710) are now the fleet's root of trust and are
   themselves scanners. The recursion has to stop — but the stopping point should be *named and
   argued*, not reached by running out of sprint.
4. **Native integrity is a clock, not a control.** `KNEXT_REQUIRE_NATIVE_INTEGRITY` is **opt-in**;
   absent the env, an absent manifest is still accepted. The PR correctly fixed the fail-open where
   `=true` silently meant off — but the **default is still off**. Nobody may describe this sprint as
   having shipped native-addon integrity enforcement.
5. **Behavioural proof is thin relative to scan proof.** The only genuinely behavioural new evidence
   in the whole sprint is the byte-cap socket e2e and the post-compile smoke. Everything else
   asserts *text about* the system.

### Is guard complexity itself now a risk? Yes — scored

**Cost.** 12 Opus-class review rounds on guard PRs alone (5 on #938, 4 on #927, 3 on #935). 8,458
of 11,521 added lines (**73%**) are `scripts/` + `tests/` scaffolding. And the decisive number:
**every one of the four same-class fixes on the scratch-space scan was a defect in the guard, not in
its subject.** This sprint the guards generated more defects than the code they guard. That is the
threshold at which "more guards" stops being risk reduction.

**Benefit is real and must not be discounted.** The provers caught 4 decorative guards on #935's
branch and 2 spurious kills on #927; the anchor-liveness check caught a genuine #912 instance. The
answer is not fewer guards — it is **cheaper controls for the same risk**:

| risk | today | simpler control |
|---|---|---|
| scratch dirs in the repo / leaked temp dirs (#939, 161 sites) | 487-line three-rule source scanner + 67-line exception ratchet, 4 guard-defects, 5 review rounds | a **runtime** global test-setup hook: snapshot repo-root + `tmpdir()` before/after the suite, fail on delta. ~20 lines, **no blind spots**, catches computed paths, `node -e` writes and dynamic imports the scanner cannot see. **Strongly recommend replacing, not extending.** |
| runtime-entry copies drifting (10 copies scan-pinned) | parity scanner + prover | **stop having 10 copies** — generate them from the template at build time. Drift becomes impossible rather than detected; the guard is deleted, not maintained. |
| retired-toolchain prose / skip scan | 472 + 226 lines of scanning | a lint rule or a CODEOWNERS review; low blast radius, low value at this price |
| **keep as-is** | byte-cap serve-site scan (small, security, high value); anchor liveness (caught a real #912); post-compile smoke (behavioural) | — |

---

## 3. Security invariants — regression check on the aggregate

- **No regression found.** NetworkPolicy is untouched by the sprint (only `docs/security/threat-model.md`
  prose changed). ADR-0044's port-restricted default policy stands, CNI caveat unchanged.
- **Net improvement:** the byte cap closes a live dated security exception on its own terms, with
  fail-closed defaults and a metrics listener the app knob cannot re-open.
- **Do not over-claim:** `security.md`'s runtime-hardening line is now satisfied for **payload** and
  still open for **rate limiting**, which remains a documented recipe. Am4 says so; keep it that way.
- **Native integrity: default-off** (see §2.4). A clock, not a control.
- **Seam gate** (`cache-handler-seam-gate.test.ts` + prover) is a genuine hardening — an
  unconditional throw under `NODE_ENV=production`. The residual (moving `__` seams off the published
  subpath) is correctly deferred as a **public-API trigger** with a dated clock (#936), not decided
  by the implementer. Right call.
- **#926 exposure.** The release lane runs `pnpm install --frozen-lockfile` in three jobs against a
  repo with no `pnpm-lock.yaml`, so **every job dies at install**. Read correctly, the exposure is
  *inertness*, not a live vulnerability: the publish path cannot run at all, so `@getknext/*` cannot
  be republished and users are pinned to what is already on npm. The consequences that matter:
  (i) **there is currently no route to ship a security fix to npm users** — #926 and #853 (dead
  token) are two independent blockers on that one path, so any sprint-3 plan that assumes "we can
  publish a fix" is invalid until both land; (ii) the fix **moves `NODE_AUTH_TOKEN` from
  `pnpm/action-setup` to `oven-sh/setup-bun`**, widening the credential-bearing allowlist in
  `tests/release-action-pins.test.ts` — a `security.md` supply-chain change that belongs at the gate,
  not with an implementer, and #926 correctly refuses to fix it inline; (iii) the **mutation prover
  for that same credentialed lane has been silently dead** (exits 2 before planting) and is fixed
  only on `agent/s2-guard-provers` — so until #927 merges, the guard over the publish path is inert.
  That makes #917 and #927 the two merges with a *security* reason to go early.

---

## 4. Conditions (these become the sprint-3 entry gate)

- **C1 — merge mechanics.** The branches are **stacked**; merge in the stated order
  (#914 → #915 → #917 → #919/#920/#927 → #935 → #938) and re-run CI **at each new head**, verifying
  the next PR's diff shrinks as expected. **#915 is still a DRAFT PR** — it cannot merge as-is;
  mark it ready before the queue starts.
- **C2 — cluster verification of exit criteria 2 and 3** per the (a)–(h) table in §1, kind then OKE,
  results written to a file, OKE run made against a **confirmed deployed operator digest**.
- **C3 — #906's ISR-under-vinext prover is written first in sprint 3.** It is #928's own top
  priority and the unproven half of exit criterion 2.
- **C4 — #926 + #853 before any claim that a fix can reach users.** The `NODE_AUTH_TOKEN` action
  move goes through the security gate.
- **C5 — no new *scanning* guard in sprint 3 without a simpler alternative rejected on the record**;
  and the temp-dir scanner is **replaced** by the runtime snapshot control, not extended.
- **C6 — consolidate the six dated exceptions into one registry with one test and *staggered*
  expiries**, so they cannot lapse as a bloc and get re-dated as a bloc.

---

## 5. Top-5 sprint-3 candidates (system designer's seat)

1. **Cluster verification of the sprint-2 aggregate (kind → OKE), per the (a)–(h) script.** Three
   exit criteria are source-level claims; the sprint has no evidence a scaffolded app runs anywhere.
2. **#906 ISR-under-vinext prover + a real ISR behavioural test on the cluster.** The only exit-
   criterion half with neither a mutation prover nor a cluster observation.
3. **Replace the scratch-space scanner with a runtime before/after snapshot and burn down #939.**
   Retires the sprint's most defect-prone guard *and* 161 leaks with one cheaper, blind-spot-free
   control.
4. **#926 + #853 release-lane repair (gate-owned credential move).** Two independent blockers on the
   only path to users, plus a prover over that lane that has been inert.
5. **Generate the runtime-entry copies from the template instead of scan-pinning ten of them.**
   Deletes a guard by removing the duplication it polices — the one structural fix in the list.

*Honourable mention (architect's seat, flagged not claimed):* ADR-0048 action item 7 — `CLAUDE.md`
and `.claude/rules/architecture.md` still name node/official-adapter the default while ADR-0048 made
vinext the only target. Every gate reading the rules starts from a stale premise, and this sprint's
byte-cap scope argument depends on which is true.
