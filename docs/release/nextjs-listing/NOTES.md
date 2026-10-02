# Next.js listing PR — founder notes (Refs #1566, decision context #1565)

**Status: DRAFT ONLY, now push-ready.** Nothing has been submitted, forked publicly, commented, or
opened against `vercel/next.js` or `nextjs/adapters-wg`. The patch, PR body, and a local committed
branch on the founder's fork are ready to go the moment #1565 confirms the placement and (if the
"wait until it reaches 14/14" reading is the one that stands) the credential window closes. Do not submit
`listing.patch` or `adapters-wg-request-draft.md` until that confirmation.

## 2026-10-02 refresh (this pass)

- **Patch still applies cleanly, unchanged**, against current `vercel/next.js` canary
  (`c24d0f874c7af5721c5161c5545b8f1a800a5cca`, fetched 2026-10-02). The target file is still
  `docs/01-app/01-getting-started/17-deploying.mdx` — filename unchanged since the 2026-09-30 base.
  `git apply --check listing.patch` exits 0 with no fuzz.
- **Credential state as of this pass:** v1.0 is on `v1.0.0-rc.5` (knextSha `5109bf75`), Next.js
  `v16.3.6`. Night 1 of 14 completed 4/4 green across all four cells (node×turbopack, node×webpack,
  bun×turbopack, bun×webpack) — see getknext-dev/knext#1359 (the pinned tracker) for the live
  per-night count. **It has not reached 14/14 yet** — do not read anything below as the gate being met.
- **A branch is committed, not pushed**, on the founder's fork (`AhmedElBanna80/next.js`), built off
  current `upstream/canary`. See "Submit at GA" below for the exact commands and the PR text.
  Evidence placeholders stay `[FILL AT GA]` per the honesty guard; nothing is fabricated.
- **No upstream content (PR, issue, comment) was opened in this pass.** The fork clone and local
  commit live only in this session's scratchpad, not pushed anywhere.

## What's already decided (read #1565 and #1566 comments before changing this)

- **#1565 founder comment (2026-09-27, "grilling Q4, option b"):** file the docs-list link PR
  **now** (a link, no credential claim); request Working Group membership **only after** the
  credential is green. The WG request must address `nextjs/adapter-k8s` (Google, GKE + Envoy, no
  Knative) up front.
- **#1566 comment (later):** "Reframed by the Q4 decision: the 'Other Platforms' link PR is filed
  NOW (not after 14/14)... the PR body must state knext is built on the Adapter API and ask where
  they want it; claims limited to what is published today (no credential claim until the windows
  are green)."
- These two comments are in tension with #1566's own issue body ("submitted only after rc.2 reaches
  14/14"). **Resolve this discrepancy with the founder before submitting anything** — this draft
  package is built so either reading works: `listing.patch` carries no credential claim (so it is
  safe to submit under the "now" reading), and `NOTES.md`/the PR-body bullets below gate the
  evidence links behind `[FILL AT GA]` placeholders (so nothing fabricated ships under the "wait for
  14/14" reading).

## Placement decision (#1565): platform list vs. verified tier vs. WG request

Per the research (`.claude/research/nextjs-adapter-listing-path-2026-09-27.md`, `-lessons-*.md`,
both untracked in this worktree, read from the primary checkout):

| Option | Cost | Gate | Precedent |
|---|---|---|---|
| (a) Docs PR to "Other Platforms" list only | ~1 line, one PR | none — reviewers have approved same-day, empty-body reviews (Appwrite #85830, Firebase #86832) | 9/9 current unverified entries |
| (b) Verified-adapter tier | org transfer of the adapter package to `github.com/nextjs`, full compat suite green, WG coordination | Vercel/Next.js team judgment, no published SLA | Only Vercel + Bun; Bun's own path was a Vercel-authored adapter, not a public submission |
| (c) WG membership request | one issue on `nextjs/adapters-wg` | "join by request," but the one public unaffiliated submission (`adapters-wg#2`, `@solcreek/adapter-creek`) has had **0 replies since 2026-04-22** | "Pantheon" joined via minutes; no adversarial rejection precedent, just silence |

**Recommendation (matches the founder's already-recorded #1565 decision): (c) sequenced — file (a)
now, request (c) only after 14/14, and do not treat (c) as a gate for anything else.** Do not pursue
(b) as a near-term goal; it requires org-hosting decisions (governance, who maintains
`nextjs/deploy-knext`) that are out of scope for this draft and belong in the ADR #1565 asks for.

## #1565 is decided: ADR-0062 (PR #1818) — ship the platform-list PR, ask the verified-tier
## question in the same thread, no package transfer now

#1565 ("Next.js listing path: platform list vs verified tier") is **resolved, not open**. ADR-0062
records the founder-delegated choice between (a) platform-list only, (b) pursue the verified tier
now (mirror/transfer the adapter package), and (c) both sequenced — jev scored (c) 0.59 vs (a) 0.39
vs (b) 0.02, re-checked independently at 0.69, same direction. **Decision: (c).**

Concretely, this means:

- Ship the plain platform-list docs PR (`listing.patch` / `docs/deploying-add-knext`) — still the
  primary deliverable, unchanged. It needed no governance decision and keeps the strongest
  same-day-merge precedent.
- **In the same upstream PR thread**, ask the Next.js team what the verified-adapter tier
  concretely requires of a community, open-source adapter that already runs the full compatibility
  suite — see the updated PR body below. This is new: earlier drafts of this PR body only flagged
  the framing mismatch and asked where knext should sit; it now also asks the verified-tier
  question directly, per ADR-0062.
- **No package transfer now.** ADR-0062 explicitly rules out mirroring/transferring the adapter
  package into `github.com/nextjs` at this time — knext keeps the operator, the CLI, the docs site,
  and governance unconditionally. `apps/docs/LISTING.md` (the fuller verified-tier entry draft)
  stays parked; it is not the near-term deliverable.
- The WG request draft (`adapters-wg-request-draft.md`) is unaffected by this decision — it was
  already sequenced to come after 14/14, which ADR-0062 does not change.

## The framing mismatch — do not silently misfile

The current "Other Platforms" section (`17-deploying.mdx`) reads:

> "The following platforms offer their own Next.js integrations. These are **not built on the
> public Adapter API** and are not verified by the Next.js team, so feature support and
> compatibility may vary."

This is **factually wrong for knext**: knext's default build target is `next build` wired through
`adapterPath` / `NEXT_ADAPTER_PATH` (confirmed live in this worktree — `packages/kn-next/src/adapters/next-adapter.ts`,
`apps/docs/content/docs/getting-started.mdx`: "knext's default build uses Next.js's own **official
Deployment Adapter API**... wired through `adapterPath`"). knext is Adapter-API-based but
**not verified** (no org hosting, no WG-coordinated suite run yet) — a third state the current
two-tier "Verified / Other" split does not name.

`listing.patch` deliberately does **not** rewrite the section's framing paragraph — that would be a
larger, more opinionated diff with a materially lower same-day-merge odds (precedent: Hostinger's
#90246 took 7 days once a reviewer pushed back on anything beyond a plain link). Instead:

1. The patch adds knext as a plain link entry, matching every other entry's format exactly (label +
   URL, nothing else) — the cheap, high-precedent-odds path.
2. **The PR body must state the mismatch explicitly** (see bullets below) rather than let the
   surrounding "not built on the Adapter API" sentence stand uncorrected next to knext's entry.
   This is the founder-directed requirement from the #1566 comment.

### Alternative placement/wording (if the founder wants to lead with the correction instead)

If the founder decides the mismatch should be fixed in the diff itself rather than only in the PR
body, here are the two shapes considered and not chosen for the default patch:

- **Option A — qualify the section framing.** Reword the intro sentence to something like: "These
  are not verified by the Next.js team, so feature support and compatibility may vary. Some use the
  public Adapter API; others do not." Diff cost: +0/-1/+1 on the paragraph, touches shared prose
  used for all 9 other entries — higher review friction, higher chance of "why is this PR touching
  wording used by 9 platforms."
- **Option B — a new sub-heading**, e.g. `#### Community adapters (Adapter API, unverified)` under
  "Other Platforms," holding only knext (and any future non-org-hosted Adapter-API adapter). Diff
  cost: a new `####` line + moved entry, structurally larger, but semantically the most honest end
  state, and closest to the lessons doc's own suggestion (`nextjs-platforms-lessons-2026-09-27.md`
  lesson 1: "propose a third sub-bullet group, 'Community adapters (Adapter API, unverified)'").

Both are viable; neither is drafted as the primary `listing.patch` because the plain-link version has
the strongest merge precedent and the PR body carries the correction either way. If the founder
prefers Option B, tell the implementer to regenerate `listing.patch` with the sub-heading instead —
it is a ~10-minute change from this draft.

## PR body — bullet facts only, NOT a finished description

**vercel/next.js requires a human-written PR description, plus an honest AI-assistance disclosure.**
Do not paste a generated paragraph as the PR body. Use these bullets as raw material to write your
own:

- knext is a Next.js deployment framework for Knative/Kubernetes — scale-to-zero, built on the
  official Next.js **Deployment Adapter API** (`adapterPath` / `NEXT_ADAPTER_PATH`), not a
  hand-rolled runtime.
- The "Other Platforms" section's framing line ("not built on the public Adapter API") does not
  apply to knext — ask explicitly where the Next.js team would rather knext sit (plain link as
  drafted here vs. a corrected sub-grouping) rather than assert either unilaterally.
- knext is not requesting verified-adapter status in this PR. No compatibility-suite claim is made
  here. [FILL AT GA] Once rc.2 reaches 14/14 on all four credential cells (node×turbopack,
  node×webpack, bun×turbopack, bun×webpack), the PR body may cite: run ID `[FILL AT GA]`, Next.js
  ref `[FILL AT GA]`, pass/fail counts `[FILL AT GA]`, quarantine ledger size `[FILL AT GA]`, and a
  link to `docs/compat-matrix.md`'s corresponding row `[FILL AT GA]`. **Never fabricate these before
  the run is actually green** — see `nextjs-platforms-lessons-2026-09-27.md` lesson 3: "no
  unverified platform publishes official-suite results; put the credentialed run id... in the PR
  body — that is the differentiator." A false or premature number here would burn exactly the
  credential this whole sprint track exists to earn.
- Link target: `https://knext.dev/docs/getting-started` — verified to exist in this worktree as
  `apps/docs/content/docs/getting-started.mdx`, a Next.js-specific quickstart (not a bare repo
  README) per the Hostinger lesson (a repo-README link stalled review by 7 days; a rotted
  `github.com/hostinger/deploy-nextjs` link is still live on the page today as a cautionary
  example).
- **AI-attribution decision (revised 2026-10-02, founder-directed for this task): the PR text
  carries NO AI-attribution line and no internal references** (no issue/PR numbers, no "knext"
  internal codenames beyond the project name itself). `vercel/next.js`'s `CONTRIBUTING.md` (checked
  this pass, current canary) has no AI-disclosure requirement, so this is not a contribution-norms
  violation — it supersedes the earlier draft of this bullet, which had assumed a disclosure
  requirement that isn't actually documented upstream. The PR body is short, plain, human-toned
  prose (jev-checked, see below) — have a human skim it before it is ever sent, same as any other
  outbound PR.

## Precedent PRs (for the founder to skim, not to copy verbatim)

- [vercel/next.js#85830](https://github.com/vercel/next.js/pull/85830) — Appwrite Sites, +1/-0,
  approved same-day, empty review body. The shape to match.
- [vercel/next.js#86832](https://github.com/vercel/next.js/pull/86832) — Firebase App Hosting, by a
  Google/Firebase engineer, merged in ~2h.
- [vercel/next.js#90246](https://github.com/vercel/next.js/pull/90246) — Hostinger, took 7 days: the
  reviewer asked for a Next.js-specific guide link (not a bare repo) and "preferably [in]
  hostinger's github org," and asked the label be just the company name. That
  `github.com/hostinger/deploy-nextjs` link **404s today** — a live example of what NOT to end up as
  (a rotted repo-README link). This is why `listing.patch` links `knext.dev`, not a GitHub repo.
- [vercel/next.js#91849](https://github.com/vercel/next.js/pull/91849) — introduced the
  verified/unverified split itself (2026-03-24); useful background on how the Next.js team frames
  the distinction, not a PR to imitate for this docs-list submission.

## What to fill at GA (never fabricate before then)

All of the following are `[FILL AT GA]` placeholders in the PR-body bullets above and must be
sourced from the actual green rc.2 run, not estimated or carried over from an earlier rc:

- The 4-cell run IDs (node×turbopack, node×webpack, bun×turbopack, bun×webpack)
- The Next.js canary ref the run was executed against
- Pass/fail counts per cell
- The quarantine ledger size and a link to it
- The corresponding `docs/compat-matrix.md` row/anchor

## Submit at GA (founder or lead) — exact commands, not to be run by this task

This task deliberately did **not** push anything or open anything upstream. A branch
`docs/deploying-add-knext` is committed locally on a scratch clone of the founder's fork
(`AhmedElBanna80/next.js`), built on current `upstream/canary`, with the one-line patch applied and
a plain commit (`docs: add knext to Other Platforms list`). To actually submit once #1565/#1566 are
both confirmed green-lit:

```bash
# from the fork clone with the docs/deploying-add-knext branch checked out
git push -u origin docs/deploying-add-knext

gh pr create \
  --repo vercel/next.js \
  --base canary \
  --head AhmedElBanna80:docs/deploying-add-knext \
  --title "docs: add knext to Other Platforms list" \
  --body "$(cat <<'EOF'
Adds knext to the "Other Platforms" list.

knext (https://knext.dev) is an open-source deployment framework for running Next.js on
Knative/Kubernetes clusters, with scale-to-zero via Knative. Its default build target uses the
official Next.js Deployment Adapter API (adapterPath), not a custom runtime.

This section's intro line says these platforms "are not built on the public Adapter API" — that
doesn't apply to knext, so flagging it here in case you'd rather place it elsewhere (e.g. a
separate sub-group for Adapter-API-based but unverified platforms). Happy to adjust the diff if
you have a preferred placement.

No compatibility-suite or verified-adapter claim is being made in this PR. Separately, I'd be
curious what the verified-adapter tier concretely expects from a community, open-source adapter
that's already running the full compatibility suite — happy to open a separate issue if that's a
better place to ask.
EOF
)"
```

If the credential has reached 14/14 on all four cells by submission time, add one more short
paragraph to the body citing: the run IDs for all four cells, the Next.js ref tested, pass/fail
counts, and a link to `https://knext.dev/docs/compat-matrix`. Pull those from the real green
getknext-dev/knext#1359 state at that moment — never carry over the night-1 numbers in this file.

**jev guardrail run on the PR body text above (2026-10-02, re-checked after adding the ADR-0062
verified-tier question):** "does this read as AI-generated / unnatural for a human contributor" →
0.39 (no); "does this overclaim beyond what the four rc.5 cells currently show" → 0.05 (no). Both
read clean; re-run jev on the final body if it's edited again before submission.

## Test guard

`tests/nextjs-listing-drafts-honesty.test.ts` (bun:test) scans this directory and fails if either
draft contains a filled "14/14" (or equivalent all-green) claim without the literal `[FILL AT GA]`
marker nearby, or any millisecond-denominated cold-start number. Keep both drafts inside
`docs/release/nextjs-listing/` so the guard's glob keeps covering them.
