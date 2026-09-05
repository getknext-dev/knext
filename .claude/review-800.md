APPROVE — final, at `d6e8e0d` (round 3). Rounds 1 and 2 were ISSUES_FOUND; both records are kept below, in order.

# Adversarial code+spec review — PR #800 (`fix/fm-redis-rooted-host`)

Reviewed `31fb449` (red) + `60d3b22` (green) against `origin/main`. I re-ran the repo-wide
scan's own logic at BOTH commits from a detached worktree, and read the installed ioredis
connect path rather than arguing from the PR body.

## Issues, by severity

1. **`60d3b22` commits 482 unrelated files — CI-breaking.** The green commit is
   `9 modified / 482 added`. The 482 are test-temp scratch dirs swept in by a `git add .`:
   ~434 `knext-*/` + `sandbox-fetch-debug-*/` fixtures (including binaries — `entry-*.bin`,
   `cache-entry.bin`, `favicon.ico`, `pnpm-lock.yaml`/`yarn.lock` fixtures) and 48
   `.claude/*-review-*.md` / `*-signoff-*.md` session artifacts, plus an unintended append to
   tracked `.claude/impl-fqdn-report.md` (round-3 notes from #790, unrelated to this PR).
   *Why it matters:* `package.json:8` `lint` = `biome check .`, run at `ci.yml:111`, and
   `biome.json` includes `**` with no exclusion for these paths. I ran biome over a 4-file
   sample of the junk: **3 formatter errors** — the lint gate will be red. Beyond CI, this is
   permanent history bloat, and `.gitignore`'s own "Local scratch / planning artifacts (never
   part of the repo)" section plus the `.claude/verdicts/` rationale ("how the work was done,
   not the work") say explicitly that neither class belongs in the tree. The scan itself grew
   from 1449 to 1931 files. Fix: reset the green commit to the 9 intended files, and add
   `knext-*/` + `sandbox-fetch-debug-*/` to `.gitignore` so it cannot recur.

2. **`tests/rooted-minted-hosts.test.ts:45-53` — stale prose the PR falsifies.** The sibling
   guard's "DELIBERATELY NOT SCANNED" docblock still states that
   `apps/file-manager/kn-next.config.ts` (redis default, `…default.svc.cluster.local`) is "a
   real unrooted host … Deferred, not dismissed." It is rooted as of this PR.
   *Why it matters:* this is the orphaned-deferral prose the red commit was supposed to retire;
   it survived because it never uses the string `app-level-redis`. A guard file asserting a
   decision that is no longer true is exactly the stale-doc class this repo keeps re-fixing —
   the next reader will believe the fm default is still unrooted.

3. **"everywhere it is taught" is falsified by the user-facing docs and the deploy skill.**
   - `apps/docs/content/docs/oke.mdx:102` — `url: process.env.REDIS_URL || 'redis://acme-redis.default.svc.cluster.local:6379'`
   - `apps/docs/content/docs/openshift.mdx:95` — same shape, `acme-redis.apps.svc.cluster.local`
   - `.claude/skills/knext-deploy/SKILL.md:79` — a NextApp CR template: `url: redis://redis.shop.svc:6379`
   The first two are **byte-for-byte the same recipe line** this PR just rooted in
   `apps/file-manager/kn-next.config.ts:17`, on the dogfooded knext.dev docs site — the primary
   teaching surface. They stay invisible to the scan via `documentation-placeholder-hosts`
   (`^(acme|shop|byo|my)[-.]`) and the SKILL via `rooting-explainer-prose`'s blanket
   `/^\.claude\//`, whose stated reason ("texts that EXPLAIN the rooting rule … narrow by
   design") is plainly false for a copy-paste CR template. *Why it matters:* the commit subject
   claims exhaustiveness the guard does not deliver, and knext's docs are part of delivery. The
   placeholder deferral's reason ("rooting them would teach the dot as part of the NAME") does
   not survive contact with this PR — README now teaches `redis.default.svc.cluster.local.`,
   which is equally a placeholder. Either root the docs recipes or narrow both deferrals to
   what their reasons actually cover.

4. **Guard-fidelity gap: the trailing-dot pin runs a major the runtime does not ship.**
   `tests/rooted-host-parsers.test.ts:36` imports the root workspace's `ioredis` —
   `package.json:39` / `pnpm-lock.yaml:59-61` resolve that to **6.0.0** — while every runtime
   consumer is on 5.x (`packages/kn-next:170` `^5.9.2`, `packages/lib:72` `^5.9.3`,
   `apps/file-manager:27` `^5.9.2`). The green commit leans on this ("ioredis 6's trailing-dot
   handling is already pinned"). *Why it matters:* the guard proves the property for a major the
   cache handler never loads. Not a live bug — I executed ioredis **5.9.3** directly and it
   preserves the dot (`options.host === 'file-manager-redis.default.svc.cluster.local.'`) —
   but the pin should assert against the shipped major, or against both.

5. **Nit — the two commits in this PR disagree on the count.** `31fb449` says "Red on 8 sites",
   `60d3b22` says "Nine sites". Both are defensible (8 files / 9 file-host pairs, which is what
   the scan names), but a reader reconciling them wastes time.

## What I attacked and could NOT break (recorded so it is not re-litigated)

- **The ETIMEDOUT/DNS conflation the lead flagged does not apply here.** ioredis's
  `connect ETIMEDOUT` is **synthetic**, not a kernel TCP error: `Redis.js:165-178` arms
  `stream.setTimeout(connectTimeout)` on a socket returned by `net.createConnection({host})`,
  i.e. the idle timer is running **during** `getaddrinfo`, before any SYN. A DNS-phase stall
  therefore surfaces as exactly `connect ETIMEDOUT` (cache-handler budget is 5000 ms,
  `cache-handler.js:111`). The evidence does not exclude the DNS phase, so the lever fits the
  observation. And `StandaloneConnector.js:26-27` assigns `options.host` verbatim into
  `net.createConnection` — no trailing-dot stripping, no TLS/cluster branch touches it. TLS is
  not in play (`redis://`, `options.tls` unset), and Node's `checkServerIdentity('example.com.', …)`
  returns OK anyway, so `rediss://` would not regress either.
- **The red commit is precise.** Running the scan at `31fb449`: exactly the nine claimed
  file→host pairs undeferred, zero stale deferrals. At `60d3b22`: zero undeferred, zero stale.
  The deferral retirement is the minimal one-rule deletion; nothing else in the guard moved.
- **All ten edited lines are in host position** inside config/CR examples — no prose was made
  false and no quoted observation falsified. `docs/benchmarks/**` (the measurement records the
  `measurement-records-quote-evidence` deferral protects) is untouched, and `docs/ARCHITECTURE.md`'s
  edit is inside a `const config = {…}` block, not narrative.
- **Nothing asserts the old literal.** No test, e2e, manifest or script references the unrooted
  `file-manager-redis.default.svc.cluster.local`. The trailing dot cannot be rejected downstream:
  `nextapp_types.go:545-547` has no kubebuilder pattern on `cache.url`, the generated CRD has no
  `pattern`, `cli/validate.ts:196` only checks presence, and `nextapp_controller.go:1110` copies
  `spec.cache.url` into `REDIS_URL` unmodified. The scaffold template ships no redis default.
- **Honest scope is in the tree** — `60d3b22`'s message carries the re-apply caveat. Suggestion
  (not a blocker): a measurer reads the ledger, not `git log`; put that sentence on the
  iteration-3 row in `docs/benchmarks/` before the measurement, or it will be skipped exactly
  the way row 2's was.

## Test quality

The TDD shape is genuine and the guard is not weakened — I reproduced the red at `31fb449` and
the green at `60d3b22` with the guard's own predicates and confirmed the fail-closed
both-directions property still holds (no stale deferral either way); the only weakening is
sideways, in the deferrals that keep three still-unrooted teaching sites (issue 3) and the
ioredis-major mismatch (issue 4) invisible to it.

---

# ROUND 2 — re-review at `248b546`

Verified from a detached worktree at the round-2 head, then removed it. Ran the scan with the
**round-2 predicates** (not round 1's), mutation-proved both narrowed deferrals, and ran biome
the way CI does.

## Your point 1 — verified, with one exception

**Confirmed:** the sweep is gone. Net diff vs `origin/main` is now **18 files** (`git diff
origin/main...248b546 --name-status`), the round-2 commit is `491 files changed, 36 insertions(+),
6163 deletions(-)`, `git ls-files` drops from 1931 → **1450** (main is 1449), and the tracked
`.claude/impl-fqdn-report.md` append is reverted. `.gitignore` gains `knext-*/` and
`sandbox-fetch-debug-*/`, so the class cannot recur.

**Biome, run the way CI runs it** (`cd <tree> && biome check . --diagnostic-level=error`):
`Checked 602 files … no errors` at `248b546`, byte-identical to the `origin/main` baseline
(602 files, no errors). The round-1 lint blocker is dead. *(Aside: running biome with an
out-of-project absolute path reports 201 pre-existing "errors" because nested config/ignore
resolution doesn't apply — that number is an artifact of the invocation, not the tree.)*

**The exception — your "12 intended files" claim is off by six, and one of them is a survivor
of the sweep:**
- `.claude/gate-766-shape.md` is **still `A`** — a 145-line architect-gate session artifact from
  the 482, unreferenced anywhere in the tree (`grep` finds no citation), and not load-bearing for
  any deferral. The unsweep missed exactly one file. Delete it.
- The other five are legitimate but weren't in your count: `apps/docs/content/docs/oke.mdx`,
  `openshift.mdx`, `.claude/skills/knext-deploy/SKILL.md` (the three round-2 rootings, so 12
  rooted sites, not 9) and `tests/rooted-minted-hosts.test.ts` (three test files, not two).
  Recount before asserting a shape; the assertion is what a later reader trusts.

## Findings 2, 4, 5 — closed

- **(2)** `tests/rooted-minted-hosts.test.ts:46-52` now records the rooting instead of asserting
  the reversed decision. Correct.
- **(4)** `ioredis5` = `npm:ioredis@^5.9.3` is wired properly: `package.json:40`, and
  `pnpm-lock.yaml:62-64` carries the `specifier/version` pair with `ioredis@5.9.3` already
  present in `packages`+`snapshots` — so `pnpm install --frozen-lockfile` will not break. The new
  case asserts host **and** port against the 5.x parser; I independently executed 5.9.3 in round 1
  and it preserves the dot, so the assertion is true and non-tautological.
- **(5)** Recorded. Fine.

## NEW — finding 3's guard half does not hold (this is the one to fix)

The three rootings landed, but **the narrowed `documentation-placeholder-hosts` deferral does not
enforce what its own reason claims.** Its new text says: *"Copy-paste RECIPE lines are NOT covered
any more … an unrooted placeholder in a config/yaml/env recipe is a defect."* The predicate is
`/^(acme|shop|byo|my)[-.]/.test(h) && /\.(md|mdx)$/.test(f)` — it filters on **file extension**,
and both docs recipes are `.mdx`. It cannot distinguish a recipe from prose.

**Mutation-proved, not argued.** I re-un-rooted `apps/docs/content/docs/oke.mdx:102` back to
`redis://acme-redis.default.svc.cluster.local:6379` and re-ran the scan: **`UNDEFERRED:` stayed
empty** — the violation is silently absorbed by `documentation-placeholder-hosts` (its match count
just goes 2 → 3). The scan stays green on the exact regression the fix was for. By this repo's own
rule, a guard that stays green when its subject is removed is decoration; finding 3 is currently
fixed by hand-edit only.

*Contrast — the `.claude/skills/` exclusion IS real.* Same mutation on
`.claude/skills/knext-deploy/SKILL.md:79` goes **red**
(`UNDEFERRED: .claude/skills/knext-deploy/SKILL.md -> redis.shop.svc`). That half is enforced.

**And the deferral is currently excusing a live recipe of exactly the class the lever exists for:**
`apps/docs/content/docs/databases.mdx:101` is a copy-paste Kubernetes Secret —
`stringData: DATABASE_URL: "postgresql://app:PASSWORD@acme-pooler.my-apps.svc:6432/acme"` — on the
dogfooded docs site. That is an **app-consumed `DATABASE_URL`**, the artifact the whole rooting
lever was built for, and at three dots it walks the *entire* `ndots:5` search list, i.e. the worst
case of the tail this PR is chasing. It is the only thing the narrowed deferral still matches
besides its sibling on the next line, so the rule's remaining coverage is itself a recipe.

Fix either way, but make the guard carry it: root `databases.mdx`'s two DSNs and drop the
deferral, or key the predicate on **host position** — the mechanism the sibling guard already uses
(`rooted-minted-hosts.test.ts`: "a gateway hostname in HOST POSITION — immediately after a URL's
`@`, an `=` assignment, or a `: \"` YAML value") — so a placeholder is excused only when it is
genuinely a prose mention. Extension-matching is the enumeration mistake in a different costume.

## Merge-time condition

The 6163 deletions restore the tree, but the blobs live in `60d3b22`. **This PR must be
squash-merged** — a merge commit or rebase puts all 482 scratch files permanently into `main`'s
history. Worth confirming the repo's default merge method rather than assuming it, since your
round-2 note leans on squash to do the cleanup.

## Test quality (round 2)

Improved and honest where it is enforced: the 5.x parser case is real, the scan is green with no
undeferred violation and no stale deferral under the new predicates (I re-derived both), and the
`.claude/skills/` narrowing mutation-proves red. The one gap is the `documentation-placeholder-hosts`
predicate, whose stated reason over-claims what it enforces — the same "both halves" defect class
this repo keeps re-filing.

**Verdict, round 2: ISSUES_FOUND** — one blocker-ish guard hole (placeholder deferral does not
enforce its own reason; `databases.mdx:101` DSN unrooted behind it), one leftover swept file
(`.claude/gate-766-shape.md`), and one merge-method condition. Everything else from round 1 is
closed and verified.

---

# ROUND 3 — final verdict at `d6e8e0d`

## APPROVE

Verified from a detached worktree at `d6e8e0d`, mutation-proved, worktree removed.

### All three round-2 items close, and the guard half now holds

**(1) The placeholder deferral.** `databases.mdx:101-102` — both DSNs rooted, including the
`acme-reader-pooler` sibling. The deferral is **gone entirely**, and your reasoning for removing
it rather than rewriting the predicate is right and better than the host-position fix I proposed:
the scan's extraction only ever matches a scheme-bearing URL authority or a bare `pggw*` name, so a
genuine prose placeholder never reached the predicate — the rule was, as its own last two matches
proved, only ever excusing recipes. Deleting it is the honest outcome, and the fail-closed
stale-check forcing that deletion is the allowlist-rot mechanism doing exactly its job.

**Mutation-proved, four sites, anchor-counted (substitution asserted to change the file, abort
otherwise — no silent-perl green):**

| re-un-rooted | scan result |
|---|---|
| `apps/docs/content/docs/oke.mdx` | **RED** → `acme-redis.default.svc.cluster.local` |
| `apps/docs/content/docs/openshift.mdx` | **RED** → `acme-redis.apps.svc.cluster.local` |
| `apps/docs/content/docs/databases.mdx` | **RED** → `acme-pooler.my-apps.svc` + `acme-reader-pooler.my-apps.svc` |
| `apps/file-manager/kn-next.config.ts` | **RED** → `file-manager-redis.default.svc.cluster.local` |

Round 2's decoration is gone: the same `oke.mdx` mutation that stayed green at `248b546` now
fails. Tree restored clean after every mutation (`git status` empty), and the scan is green again
on the restored tree — so the harness itself was shown able to see red before I trusted its green.

**(2)** `.claude/gate-766-shape.md` removed — net diff vs `main` is now **18 M / 0 A**, and
`git ls-files` is **1449**, exactly main's count. Nothing swept survives.

**(3)** The squash requirement is now a visible handling instruction in `d6e8e0d`'s message
("MERGE VIA SQUASH ONLY … the repo allows all three methods, so this is a handling instruction,
not an assumption"). Correct framing. I could not verify the PR comment itself (no network from
this session) — that half is on your word.

### Final state, verified end to end

- **Scan:** zero undeferred violations, zero stale deferrals, 66 violations still matched by the
  eleven remaining rules — so the vacuity guard is satisfied and every surviving deferral still
  covers something real.
- **Biome, as CI runs it:** `Checked 602 files … no errors`, identical to main's baseline.
- **Lockfile:** `ioredis5` = `npm:ioredis@^5.9.3` intact with its `specifier/version` pair;
  `--frozen-lockfile` is safe.
- **The lever itself** (verified in round 1, unchanged): ioredis's `connect ETIMEDOUT` is a
  synthetic socket-idle timer armed *before* `getaddrinfo` returns, so the measured evidence does
  not exclude the DNS phase; `StandaloneConnector` passes `options.host` verbatim; the dot survives
  on both 5.9.3 and 6.x; nothing downstream (CRD pattern, CLI validate, operator env copy) can
  reject it.
- **Scope stays honest:** the deployed apps still need the CR/ksvc re-apply before the iteration-3
  row is taken — recorded in `60d3b22`'s message. My round-1 suggestion to mirror that onto the
  ledger row in `docs/benchmarks/` stands as a *nice-to-have for the measurer*, not a merge blocker.

### One forward-looking note, not a blocker

Removing the last placeholder deferral leaves the scan with **no escape hatch for illustrative
DSNs**: a future contributor writing `postgres://user@acme-db.ns.svc:5432/db` in a doc must root it
or add a new justified deferral. That is the intended direction (recipes teach the rooted form), and
the failure message already tells them both options — recording it so the strictness reads as a
decision rather than a surprise.

### Test quality (final)

Genuine TDD across all three rounds and no test was weakened to pass: the red commit failed on
exactly the nine claimed pairs, every guard change was mutation-proved red in both directions, the
5.x parser case asserts host **and** port against the major the cache handler actually ships, and
the one round-2 guard that was decoration was replaced by enforcement rather than by prose.

**Verdict: APPROVE — conditional on squash-merge**, which is the only thing standing between
`main` and 482 scratch blobs.
