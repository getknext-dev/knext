# Review brief — optional storage (adversarial code review)

Defeat it. Worktree /Users/banna/alpheya/pocs/knext-wt/feat-optional-storage, branch
feat/optional-storage, commit 3fcf640 vs origin/main (note origin/main has advanced — diff
against the merge-base: `git diff $(git merge-base origin/main HEAD)..HEAD`).
Spec = the design gate's six conditions: /Users/banna/alpheya/pocs/knext/.claude/architect-design-storage.md
(§Conditions). Implementer report: <worktree>/.claude/impl-ux5-report.md. ADR-0047 in the diff.

Hold the PR on ANY unmet condition (the gate said so explicitly). Attack per condition:
1. The announce-every-deploy path: is the info line unconditionally reached on the storage-less
   deploy path, or is there a route (dry-run? preview? build-only?) that silently omits it?
   Does doctor actually report the mode?
2. BOTH mirrors (validate.ts + loader.ts): mutation-prove each independently — restore the
   hard-require in ONE and confirm a test reds for THAT one specifically.
3. The tsc-driven nil-safety: is `storage` truly optional-typed at the SOURCE type (not a cast)?
   grep for non-null assertions (`storage!`) and `as` casts that would defeat the type-level
   scan — each one is a hole. gc's "nothing to reap" no-op: exit 0 proven?
4. The behavioural test: run the mutation yourself (delete the Dockerfile COPY .next/static
   anchor) — red? Restore, verify clean. Does the test REALLY build an image / assert emitted
   HTML, or does it assert source strings (decoration risk)?
5. Docs: all four mdx files qualified? Any remaining unconditional offload claim (grep
   assetPrefix/bucket across apps/docs)? No ADR/issue numbers in the docs site.
6. create scaffolds storage commented-out + the persona parting line fixed (row 3a). Run
   create in a scratch dir and READ the output as the persona.
Also: 1646-test green claim — re-run the package suite yourself; root typecheck; the report's
environmental-failure claims (gpg-based) — confirm none touch this import graph.

Verdict → /Users/banna/alpheya/pocs/knext/.claude/review-ux5.md, first line APPROVE or
ISSUES_FOUND, then stop.
