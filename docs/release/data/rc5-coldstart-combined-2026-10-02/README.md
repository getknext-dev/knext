# rc.5 combined cold-start A/B — raw data

Raw JSONL from the rc.4-vs-rc.5 (integration tip 5b52bbb8, pre-#1784) combined cold-start
measurement. One JSON object per cold-start cycle, as emitted by
`scripts/bench-cold-start-phases/{drive.py,gke/drive.py}` + `cold-cycle.mjs`.

## Final, valid data (used in the published numbers)

- `oke-rc4.jsonl` (n=20: 10 bun + 10 node) — arm A, rc.4, scaffolded via
  `npx @getknext/core@1.0.0-rc.4 create`, OKE node `10.0.1.118` pinned, operator
  `kn-next-operator:v0.1.0`-equivalent digest built from the `v1.0.0-rc.4` tag.
- `oke-integration.jsonl` (n=20: 10 bun + 10 node) — arm B, integration tip, scaffolded via the
  integration-tip CLI (carries the #1776 lazy-instrumentation gate), same node, operator built
  from the integration tip.
- `oke-stall-test.jsonl` (n=20: 10 on `.118` + 10 on `.169`) — bun×turbopack only, integration/ARP-primer
  image on both nodes.
- `instrumentation-ts.diff` — the scaffold-template diff (rc.4 CLI vs integration CLI) that
  motivated re-scaffolding arm B from its own CLI instead of reusing arm A's scaffold dir.

## Invalidated GKE run (kept for the record, per the lead's instruction — not used in any number)

Both arms on this run shared the SAME scaffolded `instrumentation.ts` (copied from the rc.4
scaffold dir rather than regenerated per-arm), so arm B never got the #1776 lazy-instrumentation
gate; the near-zero combined diff this run measured is an artifact of that bug, not a real result.
GKE was also torn down mid-redo (cost), so a tightened re-measurement of arm A never happened
there.

- `gke-phase1-invalid-block1-rc4.jsonl`, `gke-phase1-invalid-block3-rc4.jsonl` — arm A, n=10.
- `gke-phase1-invalid-block2-integration.jsonl`, `gke-phase1-invalid-block4-integration.jsonl` —
  arm B (ungated scaffold), n=10.
- `gke-phase1-corrected-integration-block2.jsonl`, `gke-phase1-corrected-integration-block4.jsonl`
  — arm B re-measured after fixing the scaffold bug (n=10), but GKE was deleted before arm A could
  be re-measured under the same tightened protocol, so these were never compared to a valid
  baseline and are not used in any published number either.

## Reproducing the published numbers

```
python3 scripts/bench-cold-start-phases/stats.py docs/release/data/rc5-coldstart-combined-2026-10-02/<combined-file> first_byte <armA> <armB>
```
(`<combined-file>` = concatenation of `oke-rc4.jsonl` + `oke-integration.jsonl`; "clean" cycles
are those with `watch.first_byte < 5000` — the dataset has a complete gap between ~2850ms and
~9300ms, so any threshold in that range partitions identically.)
