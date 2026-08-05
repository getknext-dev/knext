# Can "half a scan" be caught mechanically? — a measurement (#639)

**Verdict: NOT TRACTABLE as a gate.** The lint issue #639 proposes reaches **one of three
defect families** and **two of the eight defective assertions** in the corpus that motivated it,
while flagging **65 correct, shipped assertions** on `main` to do it. It ships as an
**advisory** reporter — `scripts/scan-half-scan-candidates.mjs`, exit 0 always, no workflow runs
it — so the measurement stays reproducible for whoever proposes the lint next.

The rules half of #639 (the `.claude/rules/workflow.md` amendment) is a human decision and is
untouched by this. **#639 stays open for it.**

## What was asked

> Consider whether a mechanical check is possible for the common case — e.g. a lint that flags
> `expect(source).toContain(...)`-style assertions in `tests/` that have no paired negative
> assertion. Judge honestly whether that is tractable before building it; a bad heuristic here
> would be noise.

A check that cries wolf is worse than none: it trains people to ignore it, which is the failure
mode the issue is about. So the question was answered by measurement, against ground truth,
before deciding what to ship.

## The corpus

Seven real instances, all merged, all caught by an adversarial reviewer rather than by a test.
They are **not one shape**. Three families:

| Family | What it is |
|---|---|
| **(a) half a scan** | A positive assertion that the sanctioned site has the thing, with nothing asserting that no *unsanctioned* site does. |
| **(b) recurring needle** | A substring/`toContain` whose needle legitimately occurs elsewhere in the haystack, so falsifying the intended site leaves it green. |
| **(c) blocklist** | An enumeration of known-bad forms; any equivalent form passes. |

## The candidate

`scripts/scan-half-scan-candidates.mjs` implements the proposal in three widths, so the
narrowing is visible rather than assumed:

| Variant | Rule | Findings on `main` |
|---|---|---|
| `broad` | the issue's wording literally: any `expect(X).toContain/.toMatch` in an `it()` with no negative assertion | **858** across 141 files |
| `sourcey` | `broad`, restricted to receivers *named* like file text (`source`, `html`, `workflow`, `md`, …) | **317** across 67 files |
| `read` (default) | `sourcey`, restricted to receivers provably bound to a `readFileSync` in the same file | **65** across 23 files |

`read` is the steel-man: the narrowest form that still answers the question the issue asks.
Everything below is measured with it. What counts as a "paired negative" is deliberately
generous — `.not.*`, `toEqual([])`, `toHaveLength(0)`, `toBe(false)`, `toThrow`, `rejects.*` — 
because this repo's idiom for the negative half is an emptiness assertion, and a lint that did
not accept those would flag every scan in the tree.

One implementation detail is worth recording because it nearly falsified the measurement: the
first cut balanced parentheses over raw text, and a regex literal carrying an escaped paren —
`/\bquery(?:Instant|Range)\(/`, one line of the #636 entry — swallowed the rest of the block.
The scan reported a MISS for a reason that had nothing to do with the heuristic under test. A
false negative arrived at by accident is still a false measurement, so the scanner now masks
strings, template literals, regex literals and comments before finding structure. The heuristic
being this easy to fool by ordinary test code is itself part of the answer.

## Per-instance measurement

Each row is the **actual defective assertion** from the commit that introduced it, not a
paraphrase. "Reached" means the scanner flags *that* assertion — not merely that it flags
something somewhere in the same file.

| # | Family | The defective assertion | Reached? | Why |
|---|---|---|---|---|
| **#651** | (b) | `expect(matrix).toContain(declaredCrdApiVersion())` | **YES** | textbook shape: sourcey receiver, positive matcher, no negative in the block |
| **#633** (secondary) | (b) | `expect(source).toContain('AccessDenied')` on `unauthorized.tsx` | **YES** | same shape |
| **#633** (headline) | (b) | `.filter(({ source }) => !source.includes('denyObservabilityAccess'))` then `expect(missing).toEqual([])` | no | not an `expect().toContain` at all, and it already carries the paired negative the lint keys on. An **import** satisfied the substring; a page importing the symbol and rendering `<AccessDenied/>` — a 200 whose body says 401 — passed all 8 tests |
| **#636** | (a) | `expect(probeSites[0]).toMatch(/deadline\.reserved\(\)/)` | no | receiver is an array element, and the block already contains `expect(callSites.filter(…)).toEqual([])`. Moving the reserved deadline to the CR read reinstated the bug with **207 tests green** |
| **#642** | (a) | `expect(unclassified).toEqual([])` over one of two template trees | no | it *is* a negative assertion. The defect is that it scans the wrong tree |
| **#637** | (c) | `expect(/\$\(.*\)/.test(line) && /\becho\b/.test(line)).toBe(false)` | no | a negative assertion. **3 of 5** equivalent swallow shapes (`printf`, backticks, `\| tee`) passed it |
| **#626** | (b) | `assert_contains "$results" "UNCONFIRMED"` | no | a **bash** harness. Outside any TypeScript lint's reach by construction |
| **#632** | — | *(none)* | no | the defect is the **absence** of any test for a claim written in a header comment. Nothing to lint |

**2 of 8 defective assertions; 1 of 3 families; 2 of 7 instances.**

Both reached instances are family (b), and both are the *same* narrow shape. Family (a) — the
one the issue's own title names — is reached **zero** times, and not for want of tuning: three of
the misses already carry a negative assertion, which is precisely the signal the proposed lint
keys on. **The defect is in what the assertion means, not in its syntax.** #642's guard is a
complete scan over the wrong tree; #636's is a complete scan of the wrong *shape* of call site.
No parser can see either.

`tests/half-a-scan-tractability.test.ts` asserts every row of that table, both halves — the two
it reaches and the four it does not.

## The false-positive side

65 findings, 23 files, on a green tree. Spot-checking them finds ordinary presence checks whose
whole purpose is presence and for which a paired negative would be meaningless:

```
packages/kn-next/src/__tests__/loadtest-run.test.ts   expect(yaml).toContain('kind: Job')
packages/kn-next/src/__tests__/troubleshooting-doc.ts expect(doc()).toContain('kn-next doctor')
packages/kn-next/src/__tests__/create-scaffold-parity expect(manifest.files ?? []).toContain('templates')
tests/release-policy-matrix.test.ts                   expect(matrix).toContain(name)
```

That last one is the sharpest evidence available. It sits **four lines above** #651's defective
assertion, in the same file, in the same `describe`. It is correct as written and survived the
fix. The lint cannot tell them apart — so on the single file where it scores its cleanest true
positive, its precision is 1 in 2, and it is *right* to flag only one of them.

A second, runtime measurement was taken for the narrower family-(b) idea — wrap `toContain` and
fail when the needle occurs **more than once** in the haystack, which is decidable on real values
where a lint cannot be. That is a genuinely different check and it does reach #651 and #626's
shape. Measured across the full suite: **203 assertions in 55 test files** have a needle
occurring ≥2 times; 57 remain after requiring both a ≥20-character needle and a ≥2 KB document.
Same conclusion, by a different road.

Double-digit false positives means not shippable as a gate. Triple-digit means not shippable at
all.

## What actually helps

Nothing mechanical, for the two families that matter. What is left is review practice, and it is
worth being honest that a documented expectation degrades and its efficacy is unobservable until
it has already failed — the same standard `security.md` applies to everything else.

Three questions, one per family, for a reviewer looking at any new guard:

1. **(a)** *What stops a second consumer acquiring this?* The guard proves the sanctioned site
   has the thing. Name the site that must **not** have it, and check the guard would go red if it
   did. If the answer is "nothing else would do that", that is the regression, not a hypothetical
   — #636's second consumer was added by the reviewer in one line.
2. **(b)** *How many times does this needle occur in this haystack?* If more than once, the
   assertion proves nothing about the occurrence you care about. Assert the **cell, row or call
   site**, not the document.
3. **(c)** *Is this the bug you just fixed, or the property you want?* Enumerating known-bad forms
   catches only those forms. Assert the one permitted form and let everything unrecognised fail.

And one mechanical thing that does work, already in the repo: **mutation-prove the guard by
adding the bypass, not by deleting the subject.** Every instance in the corpus was found that
way. Deleting the sanctioned behaviour reddens a half-scan just fine; adding an unsanctioned
second site is the mutation it survives.

## How this finding is itself guarded

Five mutations, each applied through the snapshot harness (anchor asserted to occur exactly once,
restored from bytes, `scripts/scan-mutation-residue.mjs` clean afterwards) — both halves, because
a recall claim proved only by its hits is the defect this issue is about:

| Mutation | Reddens |
|---|---|
| the scanner finds nothing | both `REACHES` rows, plus both precision assertions |
| the heuristic widened to the fully naive form (no negative-assertion skip, all matchers, no receiver narrowing) | all four `MISSES` rows |
| the doc softens its verdict | the verdict assertion |
| `main()` returns non-zero | the not-a-gate assertion |
| a workflow references the scanner | the no-workflow scan |

One of those attempts is worth reporting because it went wrong in the way this repo keeps warning
about: mutating the matcher regex by substituting inside the literal put the residue marker
*inside* the regex, silently changing what it matched. The proof round it produced was
uninformative rather than false, but it is exactly the "silently-failed substitution yields a run
that proves nothing" hazard. The edit was re-anchored on the whole statement so the marker lands
on its own line.

## Reproducing this

```
node scripts/scan-half-scan-candidates.mjs                    # default `read` variant
node scripts/scan-half-scan-candidates.mjs --variant=broad    # the issue's wording, literally
npx vitest run tests/half-a-scan-tractability.test.ts         # the per-instance table, asserted
```

The scanner always exits 0 and no workflow invokes it; `tests/half-a-scan-tractability.test.ts`
asserts both. Before wiring it into CI, re-run the measurement — the verdict is empirical, so it
can change, but it has to be re-measured rather than assumed.
