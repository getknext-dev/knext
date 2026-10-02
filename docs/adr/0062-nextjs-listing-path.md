# ADR-0062: Next.js listing path — platform list now, ask about the verified tier, no package transfer yet

- **Status:** **Accepted (2026-10-02).** Founder-delegated decision (#1565, sprint task L1, GA
  runway sprint, track L). The founder delegated the choice between options (a)/(b)/(c) below to
  `jev`; it scored (c) 0.59 vs. (a) 0.39 vs. (b) 0.02. Re-checked independently while writing this
  ADR: 0.69 for (c), same direction. Trigger-class (ADR — a positioning decision), reviewed per
  `.claude/rules/workflow.md`'s sprint-close process; not a merge gate.
- **Relates to:** `CLAUDE.md` §1–2 (identity: the narrow scale-to-zero Next.js adapter for
  Knative/Kubernetes, fame-first, not a general PaaS) and §2's north-star credibility lever
  (verified-adapter status = open source + official compat suite + listed in the Next.js docs).
  Does not amend ADR-0001 (control plane), ADR-0036 (two build targets), or any runtime ADR —
  this is a docs/positioning decision only, no code or CRD surface changes.

## Context

**Fact, from the Next.js docs (canary, 2026-09).** The "Deploying" page carries two different
things, and conflating them is the mistake this ADR exists to avoid:

1. **A plain platform list** — Appwrite, Amplify, Cloudflare, Deno, Firebase, Netlify. Being on
   this list requires only that a platform host Next.js and document how; the list is a pointer,
   not a certification.
2. **A "verified adapters" tier.** Verified status requires, together: the adapter is open
   source, it runs the **full official compatibility test suite**, and it is **hosted under the
   Next.js GitHub organization**. No verified adapter exists yet anywhere — Cloudflare and Netlify
   are both still "working on" theirs. Separately, Node.js-server deployment templates live as
   `nextjs/deploy-<platform>` repos (a thin reference template, not a maintained adapter).

**A Google-backed community adapter already exists for the adjacent space: `nextjs/adapter-k8s`.**
It targets plain Kubernetes with an always-on Deployment model. knext's differentiator against it
is architectural, not cosmetic: knext targets **Knative + scale-to-zero** (official adapter API,
`NextAdapter`, compat-suite-gated, cold-start-optimized), where `adapter-k8s` assumes a
conventionally-provisioned, always-on cluster. The two are not competing for the same workload
shape — one is "run Next.js on any k8s cluster," the other is "run Next.js on Knative and scale to
zero when idle." That distinction is knext's whole pitch; being listed alongside, not folded into,
`adapter-k8s` is the correct frame.

**Why this matters now (fame-first, `CLAUDE.md` §2).** The near-term goal is credibility for the
author's career, not product revenue, and the stated north-star lever is explicitly "listed in the
Next.js docs." A platform-list entry is a cheap, available step toward that lever today; verified
status is not available to anyone yet (zero verified adapters exist), so the decision is really
about *sequencing and governance*, not about which to build first.

## Decision

**Option (c): both, sequenced.**

1. **Docs PR first.** Add knext to the plain platform list on the Next.js docs' Deploying page.
   All code stays in `getknext-dev/knext` — no package move, no org change, no new CI identity.
   This is the fast, available, zero-risk step.
2. **In the same PR thread**, ask the Next.js team what the verified tier concretely requires of a
   community adapter — beyond "open source + compat suite + hosted under nextjs org" as currently
   documented, since no verified adapter has been accepted yet to confirm what that process
   actually asks for in practice (review bar, governance expectations, maintenance commitments,
   whether "hosted under nextjs org" means a mirror, a transfer, or something else).
3. **No package transfer now.** Do not mirror or move the adapter package (or any part of
   `packages/kn-next`) into `nextjs/deploy-knext` or any `nextjs/*` namespace until the answer to
   (2) is in hand and a separate governance decision is made.

## Options considered

| | (a) Platform list only | (b) Pursue verified path now (mirror/transfer adapter package) | (c) Both, sequenced **(decided)** |
|---|---|---|---|
| What ships | a docs PR adding knext to the plain list | a positioning + governance move: propose `nextjs/deploy-knext` as the adapter package's home, operator/CLI/docs stay knext's | the docs PR, plus an open question asked in the same thread about what verified actually requires |
| Governance exposure | none — all code and CI stay in `getknext-dev` | real and premature — commits to a cross-org hosting arrangement with no accepted precedent (zero verified adapters exist to model it on) | none committed now — the ask is a question, not a proposal |
| Credibility lever progress | partial — platform-list visibility only, not the "verified" bar `CLAUDE.md` names as north star | attempts the full lever directly, but on an undefined process | partial now (platform list), with the verified-tier requirements surfaced for a future, better-informed attempt |
| Risk of being wrong | low | high — an unanswerable ask ("transfer the package") sent in cold, before anyone has gone through this with the Next.js team, risks a bad first impression on the credibility lever that matters most | low — the ask is informational, not a commitment, so there is nothing to walk back |
| Matches "fame-first, sequencing not scope-drift" (`CLAUDE.md` §2) | yes, but leaves the verified-tier question unexplored this cycle | conflicts — jumps straight to the biggest, least-defined ask before the cheap step is even done | yes — cheap step first, information-gathering in parallel, bigger decision deferred to when it is actually decidable |
| jev score | 0.39 | 0.02 | 0.59 (re-checked independently: 0.69) |

(b) is the tempting direct path to the credibility lever, but it asks the Next.js team to accept an
org-hosting arrangement that, per the Context section, does not yet have a single accepted
instance to pattern-match against — nobody outside the Next.js team currently knows what "hosted
under the Next.js GitHub organization" is supposed to mean operationally (a mirror kept in sync? a
one-time transfer? co-maintainership?). Asking for the transfer before asking the question is
asking to be the test case for an unspecified process, which is a worse first move than asking the
question in the open and least costly thread available — the platform-list PR.

## Consequences

- **Positive.** The platform-list PR is low-risk, available now, and immediately improves
  discoverability — a direct, inexpensive step toward the stated north-star lever. Asking the
  verified-tier question in the same thread costs nothing extra and produces real information
  (what the Next.js team actually expects) before any governance commitment is made. No ADR-0001,
  CRD, or runtime surface changes — this stays a docs/positioning decision.
- **Negative, stated rather than dressed up.** knext does **not** get verified-adapter status from
  this ADR, and still has zero certainty about what that would take in practice until the Next.js
  team answers. The platform-list entry alone does not satisfy `CLAUDE.md`'s "listed in the Next.js
  docs" framing in its strongest sense — a plain list entry and verified status are different
  claims, and this ADR should not be read, later, as having closed the credibility-lever question.
- **Positioning risk if later re-read sloppily.** A future contributor seeing "knext is in the
  Next.js docs" must not conflate that with verified-adapter status. Any docs or marketing copy
  written after the platform-list PR lands should say "listed" or "platform list," never
  "verified," until a verified adapter actually exists and knext is in it.

## What knext does not give up

Sending the docs PR and asking the question commits knext to nothing beyond that PR. Specifically,
knext keeps, unconditionally, regardless of how the Next.js team answers:

- **The operator.** `packages/kn-next-operator` stays the single source of truth for cluster state
  (ADR-0001), in `getknext-dev/knext`, under no other org's governance.
- **The CLI.** `packages/kn-next` (the TS CLI of record) stays in `getknext-dev/knext`, published
  under the `@getknext/*` npm scope. No part of the CLI surface is proposed for transfer by this
  ADR.
- **The docs.** The dogfooded docs site (`apps/docs`, deployed to OKE) stays knext's own, under
  knext's own domain and governance. A Next.js docs listing is a pointer to it, not a replacement
  for it.
- **Governance.** Any future mirror, transfer, or co-maintainership of any part of the codebase
  into an `nextjs/*` namespace is a **separate decision**, requiring its own ADR, made only after
  the verified-tier question is answered and only with explicit founder sign-off — this ADR grants
  no standing authorization for that step.

## Action items

1. Open the platform-list docs PR against `vercel/next.js` (or the appropriate docs repo), adding
   knext to the Deploying page's plain platform list, pointing at knext's own docs site.
2. In that same PR's review thread, ask the Next.js team what the verified-adapters tier concretely
   requires of a community adapter beyond the three documented criteria (open source, full compat
   suite, hosted under the Next.js GitHub organization) — specifically what "hosted under" means in
   practice.
3. Record whatever answer comes back (or the absence of one after a reasonable wait) as a follow-up
   note on this ADR or a successor ADR; do not let the answer live only in a GitHub thread that can
   be lost to history.
4. No action toward a package mirror/transfer until item 3 is resolved and a separate ADR + founder
   sign-off authorizes it.

Closes #1565.
