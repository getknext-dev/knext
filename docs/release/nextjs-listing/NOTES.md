# Next.js listing PR — founder notes (Refs #1566, decision context #1565)

**Status: DRAFT ONLY.** Nothing here has been submitted, forked, commented, or opened against
`vercel/next.js` or `nextjs/adapters-wg`. Do not submit `listing.patch` or
`adapters-wg-request-draft.md` until the rc.2 credential window shows **14/14 on all four cells**
(per the #1566 rule: "submitted only after rc.2 reaches 14/14 ... the listing is the reward for the
credential, never before the gate is stably green"). The founder's 2026-09-27 decision on #1565
already reframed the *docs-list* PR specifically to file it now, without a credential claim — see
"What's already decided" below. This package keeps both the pre-drafted PR and the deferred WG
request ready so nothing blocks on drafting time once the gate is green (or once the founder
re-confirms the docs-PR-now sequencing).

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
- Disclosure: this PR's docs diff and body draft were prepared with AI assistance (Claude Code) and
  reviewed by a human before submission. State this plainly in the PR body per vercel/next.js
  contribution norms — do not omit it or phrase it evasively.

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

## Test guard

`tests/nextjs-listing-drafts-honesty.test.ts` (bun:test) scans this directory and fails if either
draft contains a filled "14/14" (or equivalent all-green) claim without the literal `[FILL AT GA]`
marker nearby, or any millisecond-denominated cold-start number. Keep both drafts inside
`docs/release/nextjs-listing/` so the guard's glob keeps covering them.
