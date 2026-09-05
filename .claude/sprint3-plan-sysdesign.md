# Sprint-3 plan — SYSTEM DESIGNER's half

Inputs: `.claude/sprint2-close-sysdesign.md` (C1–C6), `.claude/sprint2-close-architect.md` (C1–C5),
`.claude/sprint2-close-brief.md`, `.claude/rules/{workflow,scs-zones,security}.md`.
Everything load-bearing below was re-checked against the tree / `origin/agent/s2-tail`, not the brief.

Standing frame: my close report's §2 finding was that this repo now spends most of its new lines on
guards, and that the guards' own defect rate exceeded their subjects'. Sprint 3's system-design half
is therefore **one verification task and three deletions**. Nothing here adds a scanner.

---

## 0. Sequencing — what runs first, and why it is not merge-gated

The architect **refuted the merge-gated framing as a technical necessity** (close §3.3): `workflow.md`
puts kind (step 3) and OKE (step 4) *before* review, sign-off and merge, and `origin/agent/s2-tail`
already contains all nine PRs' content. So:

| order | task | blocks on |
|---|---|---|
| **S3-V** | the kind→OKE runbook below, run on `origin/agent/s2-tail` | nothing — **starts day 1** |
| S3-A | #906 ISR prover (§3) | nothing (unit-level); its cluster half is S3-V step (e) |
| S3-B | scratch-space runtime control (§2.1) | nothing |
| S3-C | entry-copy generation (§2.2) | S3-V step (a) — do not delete the pin before a scaffolded app is observed booting |
| S3-D | single staggered registry (§2.3) | S3-B lands its own entry set first, else the registry is edited twice |

S3-V is a **queue of one** (`workflow.md`: "cluster work is a queue of one regardless of how many
teams are running"). No other task may touch a cluster while it runs.

---

## 1. S3-V — the kind→OKE verification runbook

Refines my close report's (a)–(h) table into an ordered, executable script. **Rules that make the
output evidence rather than a green terminal:**

- Every step appends to **one evidence file**, `docs/verification/sprint2-aggregate-<date>.md`,
  committed on a branch. A terminal that scrolled away is not a result.
- Each step records the **raw command, the raw output, and the assertion that consumed it**. A step
  that records only "PASS" is a step that did not run.
- **kind first, then OKE.** A kind failure stops the run; OKE time is scarce and a kind red is free.
- On OKE, **no behaviour may be attributed to code before P2 passes.** This sprint's predecessor lost
  a hypothesis to operator-source-vs-deployed exactly once already.

### Phase P0 — worktree and subject hygiene (before any cluster contact)

```
P0.1  git worktree list                       # exactly the intended ones; a stale copy reads authoritative
P0.2  git -C <wt> rev-parse HEAD              # == origin/agent/s2-tail; record the SHA in the evidence file
P0.3  git -C <wt> status --porcelain          # MUST be empty. A dirty tree means the subject is unnamed.
P0.4  record: bun --version, node --version, kubectl version --client, kind --version
```
Assertion: the evidence file names **one commit SHA**, and every later step is attributed to it.

### Phase P1 — kind

```
P1.1  kind create cluster --name knext-s3-verify --wait 120s
P1.2  KNATIVE_VERSION=knative-v1.16.0
      kubectl apply -f .../serving-crds.yaml
      kubectl apply -f .../serving-core.yaml
      kubectl apply -f .../kourier.yaml
      kubectl patch cm/config-network  -n knative-serving --type merge \
        -p '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
      kubectl wait --for=condition=Available --timeout=300s -n knative-serving \
        deployment/controller deployment/webhook deployment/autoscaler deployment/net-kourier-controller
P1.3  install cert-manager (v1.16.2) + wait Available            # the operator webhook needs it
P1.4  build + load the operator image, install the CRD, deploy the operator
P1.5  record: kubectl get deploy -n kn-next-operator-system -o jsonpath='{..image}'   # ← the digest under test
```
Then run **A–H** (below) against kind. Note the deliberate difference from OKE: on kind the operator
image is one you *just built*, so P2's digest precheck is trivially satisfied — record it anyway, so
the two runs are the same shape and comparable.

### Phase P2 — OKE precheck (the one that has already cost a sprint)

```
P2.1  kubectl config current-context                    # must be the OKE context, recorded verbatim
P2.2  kubectl -n kn-next-operator-system get deploy kn-next-operator-controller-manager \
        -o jsonpath='{.spec.template.spec.containers[*].image}'
P2.3  kubectl -n kn-next-operator-system get pods -o jsonpath='{..imageID}'    # the RESOLVED digest
P2.4  compare P2.3's digest against the digest built from P0.2's SHA
```
**Gate.** If P2.3 ≠ the digest of the code under test, the run has exactly two legal outcomes:
either **redeploy the operator from P0.2's SHA and re-run P2**, or **record in the evidence file that
the OKE run tests a different operator** and mark every operator-attributed assertion (C, F, H)
**UNVERIFIED**. Silently proceeding is the failure this precheck exists to prevent.
Also record `kubectl get crd nextapps.apps.kn-next.dev -o jsonpath='{.metadata.generation}'` — the CRD
and the operator can skew independently (#548 upgrade order).

### The A–H script (run identically on kind, then on OKE)

**A — a FRESH scaffolded app, not a repo app.**
```
A.1  cd $(mktemp -d) && kn-next create knext-s3-app --name knext-s3-app
A.2  record: the file list emitted, and that knext-bun-entry.mjs + runtime-contract.mjs are among them
A.3  grep the emitted entry for the /_next/image intercept and the byte-cap wiring
```
Assertion: the subject is a **generated** app. `apps/docs` and `apps/file-manager` prove nothing about
the templates — they are the copies the templates drifted *from*. **A repo app disqualifies the run.**
This also converts §2.2's scan-pin from a claim into an observation: if the scaffolded app lacks the
intercept, the pin was green and wrong.

**B — vinext build + deploy.**
```
B.1  kn-next build            # vinext target (ADR-0048: the only target)
B.2  record: the built static prefix (NEXT_DEPLOYMENT_ID / _vinext_ prefix) and the image tag+digest
B.3  kn-next deploy           # must apply a NextApp CR and NOTHING else
B.4  kubectl get events / audit: assert no raw ksvc, no raw Deployment applied by the CLI  (ADR-0001)
```
Assertion: the recorded prefix from B.2 is the value every later id assertion (F) compares against.

**C — boot → READY, and the negative half.**
```
C.1  kubectl wait --for=condition=Ready --timeout=300s ksvc/knext-s3-app
C.2  curl -s -o /dev/null -w '%{http_code}' https://<url>/api/health        # 200
C.3  kubectl get ksvc knext-s3-app -o jsonpath='{..readinessProbe.httpGet.path}'   # /api/health
C.4  sleep 300; kubectl get pod -l ... -o jsonpath='{..restartCount}'       # MUST be 0
```
C.4 is the half that is normally skipped and is the half that fails: a liveness probe pointed at a
deep path goes Ready and *then* restart-loops. **A run without C.4 does not close criterion 2.**

**D — `/_next/image` really transforms.**
```
D.1  SRC=$(curl -sI https://<url>/<a-source-image> | awk '/content-length/{print $2}')
D.2  curl -sD- -o /tmp/out.img 'https://<url>/_next/image?url=<enc>&w=640&q=75'
D.3  assert: 200; content-type is image/webp or image/avif; wc -c /tmp/out.img  <  $SRC
D.4  kubectl logs <pod> | grep -i sharp       # evidence the transform ran
```
D.3's byte comparison is what distinguishes a transform from a **pass-through 200**, which is what a
mis-wired intercept returns. D.4 alone is not enough (a boot-time import logs without transforming);
D.3 alone is not enough (a smaller source image). **Both, or the row is UNVERIFIED.**

**E — ISR, on the Redis path.**
```
E.1  curl -sI https://<url>/<isr-route> | grep x-nextjs-cache      # MISS
E.2  curl -sI ... again                                            # HIT
E.3  sleep > revalidate; curl -sI ...                              # STALE
E.4  curl -sI ... again                                            # HIT, and the BODY differs from E.2's
E.5  redis-cli --scan --pattern '*<route-key>*'                    # the key EXISTS in Redis
E.6  redis-cli TTL <key>                                           # NOT equal to `revalidate` (the #886 bug)
```
E.5/E.6 are the clause the unit prover (§3) structurally cannot reach: `cache-handler-isr-staleness.test.ts`
runs with `REDIS_URL` **deleted**, so it asserts the TTL rule against a pure function, never against a
live store. E is the only place the Redis half of ISR is observed. Cache store is **Redis**, not GCS
(`CLAUDE.md` §9) — an assertion against GCS here would be evidence of the wrong thing.

**F — the skew guard aborts, and the positive half.**
```
F.1  deploy with NEXT_DEPLOYMENT_ID deliberately != B.2's prefix
     assert: CLI EXITS NON-ZERO with the fixed sentence; and `kubectl get nextapp -o yaml` is UNCHANGED
     (record resourceVersion before and after — "the cluster was untouched" is an assertion, not a hope)
F.2  matched deploy: assert the PRIOR revision's assets are still served (no premature reap)
F.3  kn-next gc: assert it reaps a genuine orphan and NOTHING from F.2
```
F.1 without the resourceVersion comparison proves the CLI printed something, not that it aborted.

**G — the byte cap on the wire.**
```
G.1  head -c 9437184 /dev/zero | curl -sw '%{http_code}' -XPOST --data-binary @- <url>/api/<sink>   # 413
G.2  same 9 MiB with -H 'Transfer-Encoding: chunked' and NO Content-Length                          # 413
G.3  1 MiB POST                                                                                      # 200
G.4  curl -s -o /dev/null -w '%{http_code}' <pod>:9091/metrics                                       # 200
G.5  65 KiB POST to :9091                                                                            # 413
G.6  kubectl logs <pod> | grep 'REQUEST_BYTE_CAP:8388608 METRICS_BYTE_CAP:65536'
```
G.2 is the security-load-bearing case (no `Content-Length` to reject on). G.4+G.5 together are the
co-resident path ADR-0044 named as unbounded; G.4 alone would pass with the cap absent.

**H — probe hygiene.**
```
H.1  assert no probe path resolves to a route that imports the DB / cache / an external service
H.2  scale the database to zero; curl /api/health           # STILL 200
```

### What each row closes

| row | exit criterion | closes |
|---|---|---|
| A, C, D, E | **2** (scaffolded app boots, READY, optimizes images, caches ISR) | the sprint-2 NOT-MET |
| B, F | **3** (id flow end to end, guard fails loudly) | the cluster half of the CR-level MET |
| G | ADR-0044 Am4's "platform control on every path" | upgrades a socket test to a deployed observation |
| H | operator probe contract | the restart-loop class |

**Exit criterion 2 and 3 stay OPEN until A–H are green on OKE**, with the P2 digest recorded. A green
kind run alone does not close them; kind has no Redis-at-scale, no real ingress, and no OKE CNI.

---

## 2. The guard-fleet simplification — three deletions

`workflow.md` C5 (my close): *no new scanning guard in sprint 3 without a simpler alternative rejected
on the record.* Each subsection below carries the simpler-control argument, as required.

### 2.1 Runtime before/after snapshot replaces `scratch-space-scan.mjs`

**What it replaces (measured, on `origin/agent/s2-tail`):**
`scripts/lib/scratch-space-scan.mjs` **733 lines** · `tests/temp-dirs-outside-the-repo.test.ts` **603** ·
`scripts/mutation-prove-scratch-space.mjs` **295** · `tests/scratch-space-exceptions.json` **67**.
**1,698 lines**, five review rounds, and **four same-class defects all in the guard, none in a subject**.

**Design — two halves, because neither half alone is sufficient.**

*Half 1 — in-process fs instrumentation (per test file).*
Hook points already exist and are currently free of this concern:
`vitest.setup.ts` (wired via `setupFiles`, runs **per test file per worker**) and `tests/setup.ts`
(wired via `bunfig.toml` `preload`). Both runners are covered by one shared module.

- **Snapshots:** wrap `mkdtemp{,Sync}`, `mkdir{,Sync}`, `writeFile{,Sync}`, `rm{,Sync}`, `rmdir{,Sync}`,
  `unlink{,Sync}` on `node:fs` + `node:fs/promises`. Record `(absolute resolved path, creating test file,
  stack top frame)` on create; discharge on remove.
- **Reports, at file teardown:** (i) any created path **inside the repo root** that is not licensed →
  fail, naming the destination *and the resolved path*; (ii) any `mkdtemp` still undischarged → fail.
- **How it avoids the scanner's blind spots:** it never parses. A computed destination
  (`join(ROOT, name)`), a `.map()`, a template hole, a helper in another file, a dynamic import, and a
  non-identifier drain (`of [appDir]`, `of dirs.splice(0)`) are all *the same call at runtime*. The four
  defects the scanner needed four rounds to fix — existential pairing, drain double-credit, the
  `$`-boundary class, non-identifier drains — are **all artefacts of static matching** and cease to
  exist. There is no "anchors=0 && bindings=0 reports clean" state, because there is no anchor.

*Half 2 — tree diff (once per run).*
`vitest`'s unused `globalSetup` (with its teardown return) and the existing `scripts/bun-test.mjs`
wrapper give one before/after walk of the repo root + `os.tmpdir()` per **run**, not per file.

- Catches what Half 1 cannot: writes made by a **child process** (`node -e`, a spawned `kn-next`, a
  `bun build`), which have their own `node:fs`.
- Attribution is coarse (the run, not the file); the remedy is a bisect, and a coarse red is still a red.

**Why both. Half 2 alone would have MISSED #918** — the incident that started this whole guard family.
#918 wrote a transient `.ts` into `tests/` and **removed it**, racing the typecheck gate in between. A
before/after tree diff sees an unchanged tree and reports clean. Only Half 1 sees the write. Any
proposal to ship the tree diff alone as "the simpler control" is therefore **rejected on the record**:
it is simpler *and* blind to the originating defect.

**Simpler-control argument.** ~120 lines replacing 1,698, no exception JSON for the leak half (a leak is
now impossible to *add*, so the ratchet's only job is the 161 recorded ones — see §4), no regex classes,
no drain accounting, and — decisively — its failure mode is a **false red** (a legitimate write it does
not know about), whereas the scanner's failure mode is a **false green** (a write it cannot see). Given
this fleet's measured defect profile, trading false-greens for false-reds is the whole point.

**Mutation proof required before the scanner is deleted** (not after): plant the #918 shape — a
`writeFileSync` of a `.ts` into `tests/` followed by an `unlinkSync` in the same test — and require a
**red**. Branch on **exit code, never an output grep** (an ANSI-mangled grep once certified 14
decorative mutations green), and prove the harness can see red before trusting a green.

### 2.2 Generate the runtime-entry copies; delete the scan-pin

**Today:** `scripts/lib/runtime-entry-copies.mjs` (243 lines) + `tests/runtime-entry-copy-parity.test.ts`
maintain **two basenames × five homes** — two `.hbs` templates plus checked-in copies in `apps/docs`,
`apps/file-manager`, `examples/bun-exec` — by scanning, hashing and pinning a `DIVERGENT` exemption
against a sha256 of the bytes it is allowed to have.

**Design: keep the discovery, replace the comparison with a WRITE.**

```
scripts/generate-runtime-entries.mjs
  1. discover destinations exactly as the pin does today — by BASENAME over `git ls-files`
     (so a sixth copy added tomorrow in a directory nobody thought of is a destination, not a miss)
  2. render each from the canonical .hbs in packages/kn-next/templates/app/
  3. WRITE it
CI gate (one line):  node scripts/generate-runtime-entries.mjs && git diff --exit-code
```

- **Discovery is preserved** — that was the pin's genuinely good idea and the reason it beat an
  enumerated list. What goes away is 200 lines of *comparison, header-stripping and hash-pinned
  divergence bookkeeping*.
- **`DIVERGENT` disappears as a concept.** A copy that must differ becomes a **conditional in the
  template**, visible in the template, rather than a sha256 in a guard. Widening an exemption stops
  being "edit a hash".
- **Drift is erased rather than detected.** The class the pin exists to catch — the `/_next/image`
  intercept present in two app copies and absent from the templates, so every scaffolded app shipped
  without image optimization — cannot recur, because generation has one source.
- `git diff --exit-code` is a **both-halves assertion for free**: it reds if the generator stops writing
  *and* if a copy is hand-edited. No mutation prover is needed for a guard that is a diff.

**Sequenced after S3-V step A** — do not delete the pin until a freshly-scaffolded app has been observed
booting with the intercept present. Deleting a green-but-possibly-wrong guard before its subject is
observed is how a real drift ships.

### 2.3 One staggered-expiry registry (C6)

**Measured on `origin/agent/s2-tail`, and the bloc risk is worse than "roughly the same window":**
of the dated entries in `native-integrity-policy.mjs`, `prover-lane.mjs` (`PROVER_AUDIT_EXEMPTIONS` +
`GUARD_PROVER_EXEMPTIONS`) and `published-seam-policy.mjs`, **11 expire on 2026-12-01 and 4 on
2026-11-01**. Fifteen entries on two dates. If they lapse together CI reds on four fronts in one
morning and the cheap response is one commit re-dating all fifteen.

Good news the close under-reported: **the shared reader already exists.** `scripts/lib/dated-exemptions.mjs`
(#927) already throws on an unknown key, requires `expires`, requires a substantive justification,
rejects duplicates and fails closed on lapse. **Do not rewrite it.** C6 is about *where the data lives
and how the dates are spread*, not about the reader.

**Design.**
- One data file — `exemptions/registry.json` — with a `domain` per entry
  (`native-integrity` | `prover-audit` | `guard-prover` | `seam-relocation` | `scratch-space` | `coverage`).
  Each caller reads its domain slice through the existing `activeExemptions()`. The four `Object.freeze([…])`
  arrays become zero lines of source.
- **One test, four assertions:**
  1. schema (delegated to the existing reader — it already throws);
  2. **staggering: no two entries in the whole registry share an `expires` date, and consecutive dates
     are ≥7 days apart.** This is the C6 requirement made mechanical: a bloc re-date now *fails*;
  3. every entry names a tracking issue (`note` must contain `#\d+`);
  4. **count ratchet:** total entries may only decrease. Adding one is a deliberate, visible edit to a
     committed ceiling.
- The **security allowlists stay separate** (`security/gitleaks-allowlist.json`,
  `security/npm-audit-allowlist.json`): those legitimately permit *permanent* acceptance after triage,
  which this registry forbids by design. Merging them would weaken the registry to the looser rule.

**Simpler-control argument.** This adds no scanner: it moves four in-source arrays into data and adds
four assertions over that data. The mechanism it replaces is *nothing* — today the bloc-lapse risk is
controlled by hoping someone notices. And it converts "re-date all six" from six invisible edits across
six files into one diff that the staggering rule **reds**.

---

## 3. S3-A — the #906 ISR staleness prover (C3)

Subject: `packages/kn-next/src/__tests__/cache-handler-isr-staleness.test.ts` (221 lines, `bun:test`,
so it must be driven through `scripts/bun-test.mjs`). It is #928's own top-priority unproven guard and
the unproven half of exit criterion 2. Its docblock claims two things: the three `cacheState`s, and the
Redis TTL rule.

### What the prover must MUTATE — six planted defects, each independently required to RED

Anchors are in `packages/kn-next/src/adapters/cache-handler.js`.

| # | mutation | must red because |
|---|---|---|
| M1 | restore `EX <revalidate>` as the Redis TTL | this **is** the #886 bug: the entry is deleted at the moment it should become stale, so nothing can be served stale |
| M2 | delete the `cacheState` derivation from `get` | all three state assertions must fall; if any survives, the test asserts on something other than the contract |
| M3 | return `cacheState: 'fresh'` unconditionally | the original "every hit reads fresh, background regeneration unreachable" defect |
| M4 | stop writing `revalidateAt` on `set` | STALE becomes unreachable |
| M5 | stop writing `expireAt` on `set` | EXPIRED becomes unreachable |
| M6 | flip the staleness comparison `<=` → `<` (a boundary off-by-one) | **if M6 does not red, the test has no boundary case** — that is a finding to fix, not a prover to weaken |

### What the prover must OBSERVE — the harness rules this repo has already paid for

- **Branch on the process exit code, never on grepped output.** An ANSI-mangled pass/fail grep once
  certified fourteen decorative mutations as all-green.
- **Prove the harness can see red first** (plant a known-fatal mutation before trusting any green).
- **Each anchor must occur exactly once, or ABORT.** A silently-failed substitution is a green run that
  proves nothing. Never `perl`; assert the anchor count and abort otherwise.
- **Restore from a committed baseline, and commit green before mutating** — a `git checkout` restore
  wipes uncommitted work, and residue in a legitimately-modified file is invisible to `git status`.
  This project has twice nearly shipped the inverse of a fix this way.
- **Anchor liveness (#912 class):** assert the test file is actually *collected* by a runner. A prover
  pointed at a file no runner runs is the decorative-guard shape the lane exists to catch.

### The gap the prover structurally cannot close — state it, do not paper over it

`freshHandler()` **deletes `REDIS_URL`**. The TTL rule (M1) is therefore proved against
`redisTtlSeconds`, a pure function, and **never against a live Redis**. A refactor that keeps
`redisTtlSeconds` correct while the `set` path stops calling it passes M1 and ships #886 again.
That hole is closed only by **runbook step E.5/E.6**, which reads the key and its TTL out of a real
Redis on the cluster. **C3 is not satisfied by the prover alone**; it is satisfied by the prover *and*
step E. Anyone reporting C3 as met on the prover alone is reporting half of it.

---

## 4. Failure-mode budget for sprint 3

### Closing this sprint

1. Static blind spots on the scratch-space class — replaced by runtime instrumentation (§2.1).
2. Runtime-entry-copy drift — erased by generation (§2.2).
3. Bloc expiry lapse — the ≥7-day staggering rule reds a bloc re-date (§2.3).
4. #906 unproved — M1–M6 (§3).
5. "No scaffolded app has been observed running anywhere" — S3-V rows A/C/D/E (§1).

### Accepted, named, with the reason on the record

| # | accepted blind spot | why accepted this sprint |
|---|---|---|
| **B1** | **Nothing audits the lane.** `prover-lane.mjs` (459 lines) + `tests/mutation-prover-lane.test.ts` remain the fleet's root of trust and are themselves scanners. | The recursion has to stop somewhere, and my close report said the stopping point must be **named and argued rather than reached by running out of sprint**. Here it is named: the lane is checked by humans at sprint close, and by the fact that a decorative lane's downstream effect — a decorative guard over a real capability — is contradicted by S3-V's behavioural evidence. Adding an auditor for the auditor is the move this budget exists to refuse. |
| **B2** | **Native-addon integrity is default-OFF.** `KNEXT_REQUIRE_NATIVE_INTEGRITY` is opt-in; absent the env, an absent manifest is accepted. | Flipping the default changes shipped runtime behaviour and is a trigger-class change, not an implementer's. **Nobody may describe knext as enforcing native-addon integrity** while this stands. It is a clock, not a control. |
| **B3** | **The byte cap is invisible to the control plane** — env-only, no CR field, no status condition, no `doctor` check. | Promoting it to `spec.security` fires the #548 upgrade-order hazard for a control that needs none. Accepted as designed. *Cheap partial if capacity allows:* have `doctor` **report** the effective value — read-only, touches no CRD, no trigger. |
| **B4** | **Child-process fs writes are attributed at RUN granularity, not file granularity** (§2.1 Half 2). | A coarse red is still a red; the remedy is a bisect. Per-process attribution would mean instrumenting spawn, which re-imports the complexity we are deleting. |
| **B5** | **`Bun.write` / `Bun.$` bypass the `node:fs` monkeypatch.** | Half 2's tree diff catches the persistent case; the transient-`Bun.write` case is genuinely uncovered. Named, with a follow-up issue, not silently absorbed. |
| **B6** | **The 161-leak / 48-file ratchet does not burn down this sprint.** | The runtime control makes a *new* leak impossible, which is the risk that matters. Fixing 48 files across every package mid-sprint is exactly what "a guard that lands with its subject already red teaches people to disable it" warns against. The ceiling stays; it may only fall. |
| **B7** | **The surviving static scanners keep their blind spots** — the skip scan, the metric-docs contract, the retired-toolchain prose sweep. | The byte-cap serve-site scan is **kept deliberately** (small, security, high value). The prose/skip scanners are deletion candidates at a *later* close; deleting three things well beats deleting six things badly. |
| **B8** | **The compat credential remains detached from the shipped artifact** until the vinext axis publishes a number (architect's #1). | Not my seat's item and not in this half of the plan — recorded so it is not mistaken for something §1's runbook closes. **S3-V verifies behaviour; it is not a compat-suite result and must never be reported as one.** |

---

## 5. Refuse-to-close-without — sprint 3 (system designer's seat, 3 items)

1. **Exit criteria 2 and 3 are OBSERVED on a cluster, not written down as a runbook.**
   Rows A–H green on **kind and on OKE**, the OKE run made against a **recorded, confirmed deployed
   operator digest** (P2), evidence committed to `docs/verification/`. Specifically: the subject is a
   **fresh `kn-next create` app** (A), `restartCount == 0` after ≥5 min (C.4), `/_next/image` returns
   **fewer bytes than the source** (D.3), and the skew guard's abort is proved by an **unchanged
   `resourceVersion`** (F.1). A run missing any one of those four does not close the criteria.

2. **The scratch-space scanner is DELETED, and its replacement is mutation-proved on the #918 shape.**
   Not extended, not "kept alongside during a transition" — 1,698 lines out. The replacement must red
   on a `.ts` written into `tests/` **and removed within the same run**, which is the case a tree diff
   alone cannot see. If only the tree-diff half ships, this sprint made the control simpler *and*
   blinder, and I do not close on it.

3. **#906's ISR contract is proved on BOTH paths.** The prover reds on M1–M6 (in particular M3, the
   "always fresh" original defect), **and** runbook step E.5/E.6 observes the key and its TTL in a live
   Redis. The unit test deletes `REDIS_URL`; a prover over that path is not proof of the Redis TTL rule,
   and C3 reported as met on the prover alone is a half-met criterion reported whole.

---

*System-designer half, sprint-3 planning. No code edited.*
