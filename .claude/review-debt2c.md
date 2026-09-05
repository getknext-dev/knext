# Review — #750 pin-guard input-existence (adversarial) — VERDICT

**Branch** `fix/pin-guard-inputs-exist` (commit a8ac068) vs `origin/main`, worktree
`/Users/banna/alpheya/pocs/knext-wt/pin-guard-inputs-exist`.

## Verdict: APPROVE

Every attack in the brief was run independently; the check survived all of them, plus six
reviewer-designed dodges. All mutation proofs branched on exit codes (never output-grep), all
mutations used an anchor-asserting script (never perl), and the worktree was restored to a
clean `git status` afterwards.

## Attack results

1. **End-to-end live run — PASS.** `node scripts/verify-action-pins.mjs` on the branch tree:
   exit 0, "every pin across 21 workflow/action file(s) … and every `with:` input passed is
   declared by the pinned action (#750)". This same green independently validates the
   `release.yml` changesets v2 input migration — the checker verifies exactly those names
   against `changesets/action@2.1.0`'s metadata at the pinned SHA.
2. **Mutation reds — PASS, reproduced + 6 own dodges.**
   - Reproduced the implementer's proof: `severity`→`severityy` in `supply-chain.yml` → exit 1
     naming the key, the file:line, and trivy's full declared-input set — resolved via the
     403→anonymous-git route against `action.yaml`, so the fallback and candidate order are
     both live-proven.
   - Reviewer dodges, all fail-closed (probe: scratchpad `probe.mjs`, exit 0):
     (A) action with **no `inputs:` block** + passed key → `unknown-input` (empty declared set
     is an answer, and any passed key reds — the brief's absent-inputs clause);
     (B) `with: *alias` → `with-unreadable`; (C) merge key `<<: *defaults` → `unknown-input`
     on `<<` (smuggled keys cannot silently pass); (D) quoted flow map → `with-unreadable`;
     (E) metadata `inputs: *shared` → `action-metadata-unreadable` (never "declares nothing");
     (F) `args:` passed to a non-docker action → `unknown-input` (docker allowlist correctly
     scoped). Matrix/env indirection is a non-dodge: `uses:` and `with:` keys are literal YAML
     in Actions; values are irrelevant to key existence.
3. **Unreachable-metadata-is-failure — PASS.** Bogus 40-hex pin on the changesets step → exit 1,
   `action-metadata-error` reporting BOTH causes (API 403 + git "not our ref"), "Treated as a
   FAILURE, not a pass". The run also happened to exhaust the anonymous API quota mid-run —
   every collateral transport error also redded, confirming fail-closed under real degradation.
   Test-suite halves mutation-proved in the worktree: (a) api-error branch → `return []`
   (fail-open) → vitest exit 1; (b) detection removed (`continue;` unconditionally) → vitest
   exit 1; baseline green exit 0.
4. **Division of labour — PASS.** `tests/release-action-pins.test.ts`: zero-line diff.
5. **Annotated-tag dereference — PASS.** The diff does not touch the tag-resolution/deref code;
   the new path fetches metadata at `?ref=<commit sha>` (nothing to dereference), and the live
   green covered pnpm/action-setup + changesets/action, both annotated tags. `githubApi`'s new
   retry fires only on a THROWN fetch, never an HTTP status, so deref verdicts are unchanged.

## Non-blocking notes

- `parseActionInputs`'s docker detection scans the whole metadata file for a `using: docker`
  line; a block-scalar description containing that exact line would wrongly widen the allowlist
  by `args`/`entrypoint` only. Cosmetic-risk edge; not worth blocking.
- `release.yml` is a credentialed publish-path file — the implementer correctly flagged this as
  trigger-adjacent (workflow.md). The hunk mirrors already-reviewed #749 and is required for the
  branch to be green on a true positive the check itself found on main (#831 merged the v1→v2
  bump without the input migration). The lead should treat the reviewer-escalation note as
  served, and close #749 as superseded on merge.
