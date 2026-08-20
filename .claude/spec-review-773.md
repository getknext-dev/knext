# Spec review — PR #773 vs issue #763 / ADR-0045

## VERDICT: APPROVE

Reviewed at `f1088fe` (== origin/feat/scaffold-scale-down-delay tip).

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `kn-next create` scaffolds `scaleDownDelay: '5m'`, opt-out by deletion | met | `templates/app/kn-next.config.ts.hbs:23-24` (value + comment "delete this line to scale to zero immediately"). Tested via the REAL scaffolder: `create-scaffold.test.ts::scaffoldApp()` -> `writeScaffold()` (same fn `createMain` calls, `create.ts:361`), renders from `loadTemplates()` to a temp dir, tests read the generated file. Tests: "writes scaleDownDelay: \"5m\" into the generated kn-next.config.ts", "puts it inside the scaling block", "states the idle cost and the opt-out in a comment next to it". MUTATION-PROVED: anchor line deleted from the .hbs (anchor asserted to occur exactly once, abort otherwise) -> 5 failed / 57 passed; restored, git status clean. |
| 2 | Unset ⇒ CR key ABSENT (byte-identical back-compat) | met | `cr-builder.ts:86-94` conditional spread on `!== undefined`. Both halves asserted in `cr-builder-scaling-knobs.test.ts`: "maps scaleDownDelay into spec.scaling when set, verbatim" and "omits the scaleDownDelay KEY entirely when unset" (Object.keys, for partial `scaling` AND absent `scaling`). Operator half already on main (#769: nextapp_types.go:461 omitempty; CRD:376). |
| 3 | Separate commit for the scaffolder half (ADR-0045 Decision 2) | met | `50f7d1d` = plumbing only (config.ts / cr-builder.ts / validate.ts + 2 test files + regenerated emitted-fields + cr-fields). `f1088fe` = template + create-scaffold tests + 2 docs mdx. No bleed. |
| 4 | Docs-site states the idle cost plainly | met | `apps/docs/content/docs/learn/scale-to-zero.mdx`: bolded "**The cost, plainly:** one pod stays up for five minutes after every burst — along with the database connections that pod is holding… close to always-on". `apps/docs/content/docs/scale-to-zero.mdx`: pool-occupancy paragraph, "Existing apps are unaffected until you add the field yourself", plus cluster-enforcement + DB-wake Callout. No ADR/issue numbers anywhere in the docs diff. |
| 5 | Scaffolded value FLOWS to spec.scaling.scaleDownDelay | met | `create-scaffold.test.ts` "the scaffolded value FLOWS into the emitted NextApp CR": extracts the value from the GENERATED file, asserts `buildNextAppCRObject(...).spec.scaling.scaleDownDelay === "5m"`; sibling asserts it survives `validateConfig`. Plus the unit pair, and regenerated `emitted-fields.generated.ts` / `docs/compat/cr-fields.json` (fieldCount 67->68) with sync guards green (14/14). |
| 6 | ADR godoc caveats mirrored on the CLI type | met | `config.ts:148-168` — COST (connection wall: holds pods and their idle DATABASE_URL pool connections; does not raise peak `maxScale × poolMax` but raises IDLE occupancy) and ENFORCEMENT (accepted range is the INSTALLED Knative's; can be clamped/ignored by an older cluster; `kn-next doctor` reports the version). |

## Scope drift
None. `validate.ts` adds a syntax-only Go-duration check — beyond the issue text but ADR-consistent:
`validate-scaling-knobs.test.ts` explicitly asserts "24h" is NOT rejected client-side, keeping range
authority with the operator's Knative-delegated webhook. "Closes #763" is honest — merging resolves
both ADR-0045 action-item clauses.

## Test evidence (run locally by the reviewer)
- `create-scaffold.test.ts` + `cr-builder-scaling-knobs.test.ts` + `validate-scaling-knobs.test.ts`: 90/90 green.
- `cr-fields-generated.test.ts` + `cr-emitted-fields-extractor.test.ts`: 14/14 green.

## Non-blocking notes
1. `cr-builder` guards on `!== undefined`, so `scaleDownDelay: ""` would be emitted; `validateConfig`
   rejects "" first (covered by test), so it is unreachable via `deploy`.
2. The flow test feeds the EXTRACTED value into a hand-built config object rather than loading the
   generated TS through the config loader; placement is covered separately by the "inside the scaling
   block" test, so the seam closes in aggregate.
