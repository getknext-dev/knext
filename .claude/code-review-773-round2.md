# Code review — PR #773, round 2 (fix commit `4e464bb`)

Reviewer: independent code reviewer (read-only). Verified by running Go and the tests, not by reading.

## Verdict: **APPROVE**

All three round-1 findings are resolved. Remaining items below are nits/notes, none blocking.

---

## Finding 1 (was blocking) — regex rejected values the authority accepts: **RESOLVED, proved**

New regex (`packages/kn-next/src/cli/validate.ts:334`):
`/^[+-]?(0|(([0-9]+(\.[0-9]*)?|\.[0-9]+)(ns|us|µs|μs|ms|s|m|h))+)$/`

Probed the way round 1 was, but harder — brute-forced **every** string up to length 5 over the
alphabet `0.+-19nusmhµμ` through Go's `time.ParseDuration`, then ran each Go-accepted string
against the regex:

- length ≤ 4: **245** Go-parseable strings, **0** rejected by the regex.
- length ≤ 5 (both micro signs): **3081** Go-parseable strings, **0** rejected by the regex.

The specific round-1 counterexamples now pass: `"0"`, `"+0"`, `"-0"`, `"+5m"`. Also confirmed
newly-covered and correct: `".5s"`, `"1.s"`, `"1μs"` (U+03BC), `"1µs"` (U+00B5). The permissive
direction is intact — `"1h30m"`, `"42.5s"`, `"2h"`, `"-1s"` pass the CLI and are refused by the one
authority, which is the design. Superset property is now empirically established, not asserted.

`"" ` treated as unset: verified safe on the wire. The CRD field is plain `type: string` with no
`pattern`/`minLength` (`config/crd/bases`, `nextapp_types.go:461` `+optional`, `omitempty`), and the
operator gates on `s.ScaleDownDelay != ""` (`internal/validation/validate.go:283`), so nothing is
stamped. No divergence introduced.

## Finding 2 — corpus derived from the regex it tests: **RESOLVED; the scan is a real guard**

`packages/kn-next/src/__tests__/validate-scaling-knobs.test.ts:140-163` now scans the operator's
`scale_down_delay_agreement_test.go`. Simulated the scan's own logic to check it for vacuity:

- Scans **18** literals; the `>= 15` floor leaves slack 3.
- **Non-vacuous where it matters:** replaying the round-1 regex against the scanned corpus fails on
  exactly `"0"` and `"-1s"` — i.e. this guard would have caught the bug it was written for.
- **Marker drift fails loud, not silent:** if the `"Not durations at all."` comment changes, the
  split no-ops and the corpus grows to 23 literals including `"5 minutes"`, `"300"`, `"abc"`,
  `"5 m"`, `"1h30"`, which the regex rejects ⇒ the test reds. Same for a renamed `values` variable
  (`expect(block).toBeTruthy()`) or a moved file (`readFileSync` throws). Correct failure direction
  in every case.
- Relative path `__dirname/../../../kn-next-operator/...` resolves correctly from
  `packages/kn-next/src/__tests__`.

### Note (not blocking) — the guard is narrower than the fix it guards
It is a **pinned-corpus** guard, not a property/fuzz guard. Three of the four shapes this commit
*added* to the regex are **absent from the scanned 18**: the optional sign, leading-dot fractions
(`.5s`), and U+03BC `μs`. So a future edit that dropped `[+-]?` or the `\.[0-9]+` branch would keep
the scan green. Cheap hardening, if wanted: add `"+5m"`, `".5s"`, `"1.s"`, `"1μs"` to the **Go**
corpus (which strengthens the operator's agreement test too) — the TS scan then inherits them for
free. The 3081-string brute force above is currently the only proof of the full property, and it
lives in this review rather than in CI.

## Finding 3 — docs omitted operator-first upgrade order: **RESOLVED**

`apps/docs/content/docs/scale-to-zero.mdx:88-90` and `learn/scale-to-zero.mdx:107-109` now name it:
deploy stops at the preflight check, the field is named, update the operator first. Re-scanned both
pages — **zero** ADR numbers, issue/PR numbers, or internal jargon (`CRD`, `webhook`, `reconcile`,
`omitempty`, `admission`). Phrasing stays user-facing.

### Nit — antecedent ambiguity, `scale-to-zero.mdx:88`
"`kn-next doctor` reports the version you are running against. **So does the knext operator**:"
parses on first read as *the operator also reports the version*; the intended antecedent is "has to
honour it" from the Callout's opening. The learn page gets this right ("The knext operator has to
know the setting too:"). Suggest mirroring that wording. Cosmetic, docs-only.

### Nit — two spellings of "unset"
`validate.ts:329` now treats a falsy value as unset, while `cr-builder.ts:93` still keys off
`!== undefined`. So `scaleDownDelay: ""` passes validation and *is* emitted as `scaleDownDelay: ""`
in the CR. Harmless on the wire (see Finding 1), but the "unset ⇒ key absent" invariant asserted in
`cr-builder-scaling-knobs.test.ts:191-197` does not hold for the `""` spelling. One-character fix if
you care: make the cr-builder condition truthy too.

## Mechanical checks

- `vitest` on `validate-scaling-knobs.test.ts` + `cr-builder-scaling-knobs.test.ts`: **28/28 pass**.
- `biome check --diagnostic-level=error` on both touched source files: clean.
- No secrets, no shell string-building, no `:latest`, no dishonest `any`/`as` in the new code.
- Generated fixtures untouched by this commit and still generator-exact (verified in round 1:
  `bun scripts/gen-cr-fields.ts` ⇒ "artifacts already up to date", empty diff).

## Test quality

Round 1's one real weakness is gone: the accepted corpus is no longer written against the
implementation it tests, and the scan is mutation-proved non-vacuous against the exact defect it
exists to catch. The residual gap is scope, not honesty — the corpus is a pinned list rather than a
property, so it under-covers three shapes the fix added.
