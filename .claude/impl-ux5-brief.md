# Iteration-5 brief — optional storage (ergonomics row 3b lever), design-gate PROCEED

Repo /Users/banna/alpheya/pocs/knext. Branch `feat/optional-storage` from origin/main, in an
isolated worktree (`git worktree add`). Commit --no-gpg-sign. Push the branch when green and
report — do NOT open the PR (the lead does).

READ FIRST, both in full — they are the spec:
1. `.claude/architect-design-storage.md` — the design gate's PROCEED: the chosen shape
   (optional-by-absence, NO provider:"none" sentinel), the Q1–Q5 reasoning, the SIX CONDITIONS
   (each is an acceptance criterion), and the "ADR to write" section (ADR-0047 + amendment notes
   on ADR-0006/0011).
2. `docs/ux/ergonomics-ledger.md` row 3 (the measured wall this exists to remove).

Non-negotiables from the conditions, restated:
- Type `storage` optional in KnativeNextConfig FIRST and let `tsc --noEmit` enumerate every
  consumer — the type-level scan is the primary guard; fix each site with an intentional,
  announced no-op (preview.ts:315 is the shape to copy). gc must say "no object storage
  configured — nothing to reap", exit 0.
- BOTH validation mirrors (validate.ts:164 AND loader.ts:26) accept absence; a test reds if
  either still rejects it.
- Storage-omitted deploys ANNOUNCE the mode at info (assets served from the image; no CDN
  offload; no cross-deploy asset retention; docs link). doctor reports the mode too.
- Behavioural test: storage-less config builds + the image contains .next/static + emitted HTML
  has NO assetPrefix. Mutation-prove: delete the Dockerfile COPY .next/static line ⇒ red
  (exit-code-branched, anchor-asserted, restore + verify clean).
- Docs same PR: skew-protection.mdx, rollback.mdx, multi-cloud.mdx, cli.mdx gain the "with
  object storage configured" qualifier + a "starting without storage" section. User-facing tone,
  no ADR/issue numbers in the docs site.
- `create` scaffolds storage COMMENTED OUT with the plain-language growth path; also fix row-3a
  while you are in create.ts: the parting line becomes the persona's real next steps
  (cd, npm install, npm run dev, then doctor/deploy) — keep test:seam mentioned but last and in
  plain words.
- Write docs/adr/0047 per the gate's "ADR to write" section (next free number — verify).

TDD throughout; suite + package tsc + root typecheck + biome green; mutation-prove every new
guard. Report to <worktree>/.claude/impl-ux5-report.md, first line DONE or BLOCKED, with the
tsc-enumerated consumer list and every mutation run.
