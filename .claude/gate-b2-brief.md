# Design gate — the build/runtime separation (Track B of the bun14/vinext plan)

You are a design gate. **Attack this, do not confirm it.** A reviewer asked "is this correct?"
tends to agree; one asked "defeat this" finds the hole. This repo's own history says three
consecutive rounds each fixed the previous round's defect and introduced the next, and every one was
caught by an adversarial prompt.

Repo `/Users/banna/alpheya/pocs/knext`. The work is **uncommitted on `main`'s worktree** (an
unrelated local GPG problem blocks committing), so review the working tree, not a diff against
origin. `git status --porcelain` shows the changed files.

## What is being proposed

Separate knext's two independent user choices — which **builder** produces the app, and which
**runtime** executes it — via an artifact contract instead of an enumerated (build, runtime) matrix.

Read, in this order:

1. `docs/adr/drafts/bun14-runtime-vinext-builder-plan.md` — the plan and its completion table (§8)
2. `packages/kn-next/src/adapters/artifact-contract.ts` — the seam
3. `packages/kn-next/src/cli/validate.ts` (the `build` validation), `src/config.ts` (the `build`
   key), `src/cli/cr-builder.ts` (emission)
4. `packages/kn-next-operator/api/v1alpha1/nextapp_types.go` — the `Build` CRD field
5. The tests: `artifact-contract*.test.ts`, `validate-build-axis.test.ts`,
   `cr-builder-build-axis.test.ts`, `build-runtime-combination-coverage.test.ts`

## The escalation triggers this fires — rule on each explicitly

The plan's §6 names three. **Do not accept the plan's own assessment of them; re-derive.**

1. **Amends ADR-0042 Decision 2**, which reduced the matrix "from three valid cells to two" by
   excluding `node + vinext`. The contract admits it as *capable*. Is treating that exclusion as a
   scope/policy decision rather than a capability one defensible, or is this an ADR amendment
   masquerading as an implementation detail?
2. **Public API + config schema + CRD.** A new `build` key on `kn-next.config.ts` and a new
   `spec.build` on the CRD, additive at `v1alpha1`.
3. **The hard rule** — *"never make anything but the node/official-adapter target the default."*
   The claim is that this is NOT violated: absence means `turbopack`, and no default was flipped.
   **Verify that claim against the code**, including what the CR builder emits when the user sets
   nothing.

## Specific things to try to defeat

- **The `bun ⇒ vinext` claim.** ADR-0036 says this invariant is "enforced fail-closed by CEL
  admission on the CRD". The work asserts no such rule exists. **Check the CRD yourself.** If it
  does exist, the whole separation is built on a false premise.
- **Upgrade ordering (#548).** `build` is emitted only when explicitly set, so a default config
  produces a CR with no `build` key. Is that sufficient for an older operator whose CRD has no such
  field? What happens under `--validate=strict`? Is operator-first still required, and does anything
  enforce it?
- **The availability split.** `vinextBuilder.available === false` because `kn-next build` has no
  vinext path. Is "known but unavailable" a coherent state to ship in a public config schema, or
  does it invite a user to write a config that can never work? Should the key reject at parse time,
  at validate time, or not exist until the builder does?
- **`examples/bun-exec` is claimed as evidence** that vinext, the in-process nitro entry, and a
  minimal App-Router sample already exist. Verify that. If the sample's pipeline is not what the
  contract describes, the descriptor is decorative.
- **The combination-coverage guard.** It enumerates dispositions from the contract. Can you make it
  pass while a real combination is uncovered?
- **Anything the tests assert only one half of.** This repo's most common defect is a guard that
  proves the sanctioned form is present without proving the forbidden form is absent.

## Discipline

- Branch on **exit codes**, never grep output. (Three times this session, output-based checks
  reported success for a failed command.)
- If you propose a guard, **mutation-prove it**: delete the behaviour, watch it go red.
- Never mutate with `perl`. Restore byte-identically and verify.
- Do **not** commit, push, or modify the working tree. You are reviewing.

## Verdict

Write your verdict to `.claude/gate-b2-<your-role>.md`, first line exactly `# SIGN-OFF` or
`# BLOCK`. For a BLOCK, give the exact reproduction and the one-line fix. State plainly which
claims you verified **by running** and which you only read.
