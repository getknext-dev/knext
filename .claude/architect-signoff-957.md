# Architect sign-off — PR #957 (vinext ISR wiring, closes #953)

**Trigger:** public-API — new published subpath `./internal/vinext-cache-adapter` in
`packages/kn-next/package.json`. Scope of this gate: the API question only.

## Verdict: **SIGN-OFF, with two conditions (documentation, not code) + one follow-up**

## 1. Is `./internal/*` the right mechanism?

**Yes.** vinext's hook takes a **module specifier string**
(`vinext({ cache: { data: { adapter: '<specifier>' } } })`) that its codegen resolves in the app's
own build graph. There is no object to hand over, so ADR-0027's direct-pass preference is
inapplicable by construction — a published subpath is the only shape the upstream contract admits.

This is **not a new surface class**. The same target already ships
`@getknext/core/internal/vinext-image-optimizer`, imported by the scaffold's
`knext-bun-entry.mjs.hbs` (both template trees), and ADR-0041 has `CMD` booting
`./internal/node-server`. The repo's three-way guard (`public-api-surface.test.ts`:
exports-map-minus-`./internal/` ≡ `knext.publicApi.public` ≡ PUBLIC_API.md headings) treats
`./internal/*` as a **deliberate, enforced escape hatch**. This PR uses it as designed.

Alternatives, rejected:

- **Honest public subpath** (`./adapters/vinext-cache-adapter`). Rejected as *worse* honesty: it
  would put knext's semver behind a factory whose signature is dictated by
  vinext@1.0.0-beta.8's generated `setDataCacheHandler(factory({env, options}))`. Promising
  semver stability over a pre-1.0 upstream's internal calling convention is a promise knext
  cannot keep; the first upstream change forces a knext major.
- **Inline the factory into the generated app** (over the already-public
  `./adapters/cache-handler`). Buys zero new surface but moves the class→factory adaptation into
  every user's frozen repo — and its failure mode is precisely the silent `MemoryCacheHandler`
  fallback (row E) this PR exists to fix. Reject.
- **Wrap it in a knext-owned `vinext()` config helper.** Architecturally the best end state —
  see follow-up — but a template-tree-wide refactor, not a blocker on a verification-driven fix.

## 2. Semver / the honesty question

The lead's framing is right and must be answered, not waved through: **generated files are frozen
at scaffold time**, so a string in a user's `vite.config.ts` is load-bearing for that app forever,
while PUBLIC_API.md currently licenses knext to remove any `./internal/*` "in any release,
including patch releases." A blanket disclaimer knext does not actually intend to exercise is the
dishonesty the hard rules forbid — it just currently reads in knext's favour instead of a user's.

The fix is to **narrow the promise, not to rename the path.** "Internal" is accurate about the
right thing (apps must not import it *directly*; it is framework wiring), and the stability
obligation is real but narrower than a public API's.

**Condition A (doc).** In `docs/PUBLIC_API.md` §"Internal subpaths — NOT supported", add a
sub-note: *some internal subpaths appear in generated project files* — list
`vinext-cache-adapter`, `vinext-image-optimizer`, `node-server` — and state the obligation knext
takes on for those: **not renamed or removed without a minor bump, a changelog entry, and a
scaffold/codemod path**, because scaffolded files do not self-update. Do not import them by hand;
if yours came from the scaffold, leave it. Costs no CI change — internal subpaths are excluded
from the three-way guard.

**Condition B (doc).** The internal table is already stale — it lists 7 of the 15 shipped
`./internal/*` entries. Bring it current (at minimum add the vinext pair), and add one sentence to
ADR-0050 §Consequences recording the public-surface consequence, which the draft omits entirely.

## 3. Follow-up (not blocking)

File an issue, **due before v1.0 surface freeze**: consolidate the scaffold's vinext wiring behind
one knext-owned, documented, semver'd plugin entry (`knextVinext()`), so cache adapter + image
optimizer + nitro knobs stop appearing as raw internal specifiers in user repos and can move
freely behind it. Add as an ADR-0050 action item.

*Out of scope for this gate: correctness of the factory, the layer-1/3 provers, cluster row-E
re-verification — those belong to code/spec review and the S3-V runner.*
