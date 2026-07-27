# Planning notes derived from the knowledge graph

Generated from `graphify-out/graph.json` (7,179 nodes / 11,455 edges / 703 communities /
70 concept clusters) after the 2026-07-27 incremental rebuild. This file records what the
graph could and **could not** answer, so the next planner does not re-run dead queries.

## What the rebuild changed

| | count |
|---|---|
| new nodes | 1,677 |
| new edges | 3,060 |
| nodes removed (deleted sources pruned) | 359 |
| edges removed | 833 |

458 files had changed since the previous graph (298 code, 160 prose), 19 source files deleted.

## Finding 1 — the compat gate is a structural island

The two communities backing the compatibility suite (`Compat Suite Workflow Guard`,
`Next.js Compat Quarantine`, 70 nodes) have **zero** cross-community edges — with or without
excluding `package.json`/workflow-key hub nodes, which is worth stating because the hub
exclusion was expected to matter and does not. They are backed by five files:

```
tests/compat-suite-workflow.test.ts       36 nodes
tests/deploy-manifest.test.ts             14
tests/deploy-manifest-lanes.test.ts       11
test/deploy-tests-manifest.knext.json      5
tests/compat-quarantine-bounds.ts          4
```

**This is a limitation, not a safety property.** Those guards assert on the workflow by
parsing YAML as text, so no import/call edge ever links the runtime they protect to the
gate that protects it. The practical consequence for planning: *the graph cannot tell you
whether a change to the adapter or the standalone server invalidates the compat gate.*
Any "blast radius" answer for compat work has to come from reading the workflow, not from
graph traversal. Do not ask the graph this question again expecting a real answer.

## Finding 2 — three concept clusters carry the 1.0 argument

These survived extraction intact and are the most useful planning objects in the graph.

**The silent-success failure class.** Terminal failure handling is good (honest Ready, one
verdict path, finalizers, stall detection); *silent* failure handling is the 1.0 gap —
each of these currently reports success:

- silent CRD field pruning against an older operator
- NetworkPolicy silently a no-op on some clouds
- torn cache write on SIGTERM during ISR revalidation
- validating webhook `failurePolicy: Fail` with no `namespaceSelector`
- the ~11 s bimodal cold-start mode
- shallow readiness probe (ADR-0026)

**Compat-gate integrity.** A pass-count-only gate is purchasable — by moving failures into
the quarantine ledger, by a shard that enumerates no tests, or by a check that skips rather
than fails. Zero net new quarantine entries, a per-shard test-count floor, and hard
red-on-fail capability checks are what turn a pass count into a correctness claim.

**CLI↔operator compatibility.** The binding contract is the served CRD's OpenAPI schema —
not a version number (which lies under backports) and not a prose table (which drifts
invisibly, because the apiserver accepts and prunes).

## Finding 3 — the tracks are more disjoint than expected, with one real seam

Only six nodes appear in more than one concept cluster. The one that matters for sequencing:

> **Silent CRD field pruning against an older operator** belongs to *both* the
> silent-success failure class *and* the CLI↔operator compatibility contract.

So the CRD-compatibility work and the silent-failure work are not two independent tracks —
they meet at exactly one node, and that node is the cheapest place to satisfy both. The
remaining overlaps are ADR-0001 restatements and infrastructure runbooks, not scheduling
constraints.

## Known graph defects (fix on the next full rebuild)

1. **Decision relations were flattened.** Extraction is constrained to a fixed relation
   vocabulary (`contains`, `calls`, `references`, `cites`, `rationale_for`,
   `conceptually_related_to`, `semantically_similar_to`, `shares_data_with`, …).
   `supersedes` / `amends` / `reverses` were requested during extraction and did **not**
   survive — they were collapsed into `references`/`cites`. Consequence: *"which decisions
   are still standing?"* is not answerable by traversal. ADR supersession must be read from
   the ADR front-matter directly. 148 ADR nodes exist; only 34 carry a `rationale`.
2. **ADR-0001 is fragmented across six nodes**, not two — `adr_0001`,
   `adr_0001_operator_single_source_of_truth`,
   `docs_adr_0001_operator_single_source_of_truth`,
   `docs_adr_0001_operator_source_of_truth`, `claude_skills_scs_zones_skill_adr_0001`, and
   `claude_md_operator_single_source_of_truth`. Node dedup is by exact id, so every document
   that restates the decision mints its own node. Any centrality measure over ADR nodes is
   therefore understated, and the most-cited decision in the repo is the worst affected
   because restatement count and fragmentation count are the same number.
3. **Hub nodes poison BFS.** A natural-language `graphify query` anchors on `package.json`,
   `scripts`, `dependencies` and returns nothing but manifest keys. Useful traversals need
   those ids excluded explicitly.

## Cost note on the "update after each merge" instruction

A full rebuild at this corpus size is not per-merge affordable: 458 changed files required
eight parallel extraction subagents. The affordable split is

- **per merge** — AST re-extraction only (deterministic, free, no LLM), which keeps
  code structure current;
- **per sprint** — full semantic rebuild, matching the cadence at which the design gates
  already meet.
