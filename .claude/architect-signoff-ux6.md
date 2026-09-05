BLOCK

# Architect sign-off — feat/placeholder-preflight (UX ledger row 4), commit 0b31428

## Verdict: **BLOCK** (one narrow contract fix; no redesign)

## What passes (recorded so it is not re-litigated)

- **ADR-0001 — clean.** No new cluster writer. `deploy()` still applies only the `NextApp` CR;
  no Knative object is generated anywhere in the diff. `validate` is provably cluster-free
  (no exec/schema imports, pinned by a static scan) — a read-only verb that touches the local
  config file and nothing else is the safest possible addition to this surface.
- **Official-adapter / proto rules — untouched.** No runtime, no adapter, no service contract in scope.
- **Sequencing — in scope.** Tier-A ergonomics driven by a merged measurement (row 4), not deferred
  gRPC/zone scope pulled forward. Positioning is unchanged: this validates *knext's own config*,
  it is not a general PaaS config service.
- **ADR-0046 decision text — honored, not bypassed.** The allowlist stays derived from
  `COMMAND_GROUPS` (no second enumeration); `validateMain` parses its own argv, handles `-h/--help`
  first (help works in an empty dir), rejects unknown flags and stray positionals through
  `UsageError`; the inverted `throw new Error(` scan needs no allowlist entry because every new
  user-facing error raises through the `UsageError` family. `validate-cmd.ts` split from
  `validate.ts` is the right boundary call — it keeps the public `@getknext/core/validate` subpath a
  pure library and avoids an import cycle through `shared.ts`.
- **Amendment 1 is a faithful evolution, not a contradiction** — with one gap (below). Routing
  exit-127 through `UsageError` does stretch the family from "the user mis-typed" to "an expected,
  user-fixable local state", which sits close to the raw-`Error` allowlist's own criterion
  ("environment … something the user could not have avoided by typing a different command line").
  But ADR-0046's allowlist says which errors *may* be raw, not which *must* be — and the presentation
  contract ("a thing the user can fix renders as a message, never a FATAL dump") is extended in its
  own direction, declared, and dated. That is amendment-shaped. Accepted.
- **The scan is generic as claimed** — recursive, array- and unknown-key-aware, cycle-safe, with two
  adversarial dodge tests. Not field-enumerated. Mutation-proof M2 is the right one.

## The block

**Rule:** `.claude/rules/architecture.md` §2 (component boundaries & contracts) + ADR-0046's own
stated principle that *a confidently wrong hint is worse than none*, applied to the public config
contract (`packages/kn-next/src/config.ts`).

The generic scan walks **every** string in the config, including
`config.ts:285 env?: Record<string, string>` — arbitrary user-supplied free text — and a hit is a
**hard, unbypassable deploy refusal**. There is no `--force`, no exclusion, no warn tier. So a
schema-**valid** config (`env: { ALLOWED_TAGS: "<b><i>" }`, an XML/HTML/template-shaped env value)
becomes undeployable, and the message asserts it is "the placeholder from the scaffold" — confidently
wrong about the user's own data, on the front-door command. The CLI thereby narrows the public config
contract below what `config.ts` accepts, undocumented and with no escape. Scanning `env` is
deliberate (the module header uses `env.API_KEY` as an example path), which makes it a decision, not
an oversight — and it is the one decision in this change that is neither in the ADR nor recoverable
by the user.

**Smallest change that unblocks:** exclude knext's free-text string map — `env` — from the
**hard-fail** path (skip it, or emit it as a non-fatal warning listed under the findings). Keep the
generic walk everywhere else; one exclusion of a `Record<string,string>` free-text map is a type-level
carve-out, not a return to enumeration, so the dodge tests and M2 stay meaningful. Add the matching
dodge test (`env` value with angle brackets → deploy proceeds). Nothing else in the diff needs to move.

## Follow-up ADR

Extend ADR-0046 Amendment 1 with the Consequences sentence it is missing — "deploy now refuses
`<...>` anywhere in the config, except free-text `env`, and that is a documented narrowing with a
stated false-positive trade-off" — in the same style as the existing "a positional argument to deploy
is now an error" consequence.


---

# Round 2 — architect re-verdict, commit 46d4278 (diff 0b31428..46d4278)

SIGN-OFF

## Scope of this round
Judged **only** whether 46d4278 implements the round-1 smallest-change spec faithfully. The round-1
"what passes" list stands and is not re-litigated.

## Against the four things I asked to be checked

1. **Which tier — and is the justification sound?** They chose **skip**, not warn, and the
   justification is the stronger of the two available. My spec permitted either ("skip it, or emit it
   as a non-fatal warning"); the implementer took the narrower option and argued it from my own
   principle rather than from convenience: the scaffold never writes placeholders into `env`, so a hit
   there has **no scaffold provenance**, and a warning would still assert "this is the placeholder from
   the scaffold" about the user's own data on *every* deploy. A confidently wrong warning on the
   front-door command is a recurring-noise defect, not a softer version of the hard fail. Sound —
   and the reasoning is recorded in the code comment and the ADR, not just in the PR.

2. **Generic walk intact elsewhere.** Yes. The source change is purely subtractive: one guarded
   `continue`, gated on `path === "" && key === "env"`. Dodge 1 (unknown deeply-nested key), dodge 2
   (array element), cycle-safety, non-string, absent-`storage` (ADR-0047) all survive. The test-file
   churn (376 lines) is a formatter reflow — title-level diff shows every prior test retained, with
   exactly one deliberate inversion (`env values are scanned like everything else` → `env values are
   exempt`) plus two additions. This is a **type-level carve-out of one `Record<string,string>`
   surface**, not a return to field enumeration; M2 and the dodge tests keep their meaning.

3. **Dodge test present and load-bearing — verified by mutation, not by reading.** Two mutations,
   each with an anchor asserted to occur exactly once, then restored (tree left clean):
   - remove the carve-out → **3 red**, including the E2E `deploy` dodge, so the guard is anchored to
     the user-visible refusal and not only to the pure function;
   - widen it to any key named `env` → the root-only test goes **red alone**, so the exemption
     **cannot widen silently** — the precise failure mode I flagged.
   Baseline 27/27 green. Both halves proved.

4. **No new contract narrowing.** Five files, and the only behavioural edit is the exemption. The
   narrowing is now *smaller* than at round 1 and, crucially, **documented in all three places a user
   or maintainer would look**: the ADR consequence, the module header, and `apps/docs .../cli.mdx`
   ("values under `env` are exempt … angle brackets can be perfectly legitimate"). No `--force`
   escape hatch was added — correct, since with `env` excluded every remaining hit is a knext-owned
   field where a `<...>` value cannot be legitimate.

**Boundary check (not asked, but load-bearing):** `validate` and `deploy` consume the **same**
`placeholder-preflight.ts` — the preview verb and the enforcing verb cannot drift, so `validate`
clean → `deploy` refuses is impossible. ADR-0001 remains untouched: still no second writer of
deployment shape.

## Follow-up ADR
None outstanding — the round-1 follow-up is **discharged in this commit**; ADR-0046 Amendment 1 now
carries the Consequences sentence, in the requested style, including why `skip` beat `warn`.
