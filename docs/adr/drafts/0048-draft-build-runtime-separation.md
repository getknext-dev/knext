# ADR-0048 (DRAFT): the build/runtime separation, and what it does to ADR-0042

- **Status:** **DRAFT — proposed, awaiting the founder.** ADR-0042 is a founder decision; an
  amendment to it is a founder decision too. This records the argument and **recommends an option**
  per `.claude/rules/architecture.md` §3. It is a planning artifact (§1), not implementation.
- **Amends (if accepted):** ADR-0042 Decisions 1, 2 and 5.
- **Does not touch:** ADR-0042 Decision 3 (one config surface, one CRD, one operator, one
  `RuntimeContract`). Checked explicitly — this adds one field to the same CRD, not a second CRD.

## Context

Track B of `bun14-runtime-vinext-builder-plan.md` separates knext's two independent user choices —
which **builder** produces the app, which **runtime** executes it — behind an artifact contract
rather than an enumerated matrix. A design gate raised two ADR-0042 obligations. **One of them has
since dissolved on a measurement**, and stating that precisely is most of this ADR's value.

## The measurement that changes the question

ADR-0042 Decision 2 excludes `node + vinext`, in its own words:

> **`node + vinext` is NOT a supported cell under this ADR.** It carries most of vinext's boot win,
> and it is still rejected, because it produces no bytecode.

That is a **policy** exclusion of a cell the ADR concedes *works*. The concern raised at the gate
was that an artifact contract admitting the cell as *capable* would retire that policy without an
amendment.

Then the cell was measured, against the artifact this repo actually builds:

```
$ node examples/bun-exec/.output/server/index.mjs
exit 1 — ReferenceError: Bun is not defined
$ node -e 'console.log(require("./examples/bun-exec/.output/nitro.json").preset)'
bun
```

The built entry is nitro's **bun preset** and calls that runtime's global `serve()` at module top
level. **Node cannot execute it at all.** So `node + vinext` is not a policy question today — it is
not capable, and nothing in the tree builds a node-preset output.

**Consequence: ADR-0042 Decision 2 is not contradicted and needs no amendment.** The contract now
models the shape as `nitro-output-bun` and `nodeRuntime.accepts` excludes it. The two agree.

This is worth recording rather than quietly dropping, because the *reasoning* differed: ADR-0042
excluded the cell for producing no bytecode; the cell is in fact unrunnable. A future node-preset
build would make it capable again — and at that point Decision 2's policy reason revives and must be
ruled on fresh, not assumed retired.

## What genuinely still needs a decision: the default

ADR-0042 Decisions 1 and 5 adopt vinext + `--compile --bytecode` as the **default**, flipping at
Phase 5. The plan recommends the default **stays `node + turbopack`**. The code flips nothing —
absence of `build` means turbopack, and `cr-builder` emits the key only when explicitly set — so
this is a documentation obligation, not a code defect. But it is a real disagreement with an
accepted ADR and a plan draft is not an ADR.

## Options

| | option | consequence |
|---|---|---|
| **A** | **Default stays `node + turbopack`; ADR-0042's Phase-5 flip is superseded.** | Keeps the hard rule ("never make anything but the node/official-adapter target the default") intact rather than amended. The vinext path stays opt-in and compat-gated. Costs the boot win by default until the compat suite justifies it. |
| B | Keep ADR-0042's flip as stated; the plan's §3 recommendation is withdrawn. | Honours the accepted decision. But Phase 5 is `NOT_STARTED`, `current_phase: 0`, and the vinext path currently has no CLI build, no image support and no compat coverage — so the flip cannot be executed now regardless, and leaving it "accepted" keeps a commitment nothing is working toward. |
| C | Defer: neither confirm nor supersede. | The status quo, and the reason this ADR exists. Two accepted documents disagree with the plan the work follows, and the next reader inherits the ambiguity. |

## Recommendation

**Option A.** Not because vinext is unpromising — the measured boot win is real — but because
"which combinations are *valid*" and "which is *default*" are separate questions, and conflating
them is precisely what collapsed the matrix into a single coupled target the first time. Keeping the
default put costs nothing that Phase 5 could deliver today, and it keeps a hard rule unamended
rather than carving an exception into it.

If the compat suite later shows `bun + vinext` green across the matrix, flipping the default is a
one-line change to this ADR and a scaffolder default — cheap, and by then evidence-backed.

## Consequences

- The hard rule stands unamended.
- ADR-0042 Decisions 1 and 5 are **superseded** as to the default; its Phase-5 exit criteria remain
  the bar for *offering* the path, not for defaulting to it.
- ADR-0042 Decision 2 is **untouched** — see above; the cell is not capable today.

## Action items

1. Founder ruling on A / B / C.
2. On A: amend ADR-0042's Status block to point here, and correct its Phase-5 description.
3. Either way: ADR-0036's claim that "vinext runs on either runtime — nitro `node-server` preset for
   node" is **false for the artifact this repo builds** and should be marked as such. It is the
   source of the incorrect contract entry the gate caught, and it will mislead the next reader the
   same way.
