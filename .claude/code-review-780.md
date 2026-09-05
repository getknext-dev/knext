# Code review — PR #780 (docs: DB window independence, #766)

**Verdict: ISSUES_FOUND** (one accuracy defect + one sourcing nit; no behaviour, no field, no
decision on #779. Everything else verified clean against both the ruling and the tree.)

## Issues

- `packages/scale-zero-pg/docs/appdatabase-api.md:179-181,186` — **states an unshipped scaffolder
  default as present-tense fact.** The paragraph says knext's traffic-triggered half is
  "`NextApp.spec.scaling.scaleDownDelay`, **scaffolded `5m`**" and that "the shipped manifest value
  (60 s) is BELOW knext's **scaffolded 5 m**". Verified in the tree: `kn-next create` does **not**
  write it — no `scaleDownDelay` occurrence anywhere under `packages/kn-next/src/cli/`
  (`create.ts` included), and ADR-0045 action item `#763 — scaffolder writes scaleDownDelay: '5m'`
  is **unchecked** with **issue #763 still OPEN**. Today the app-side default is *unset* (Knative
  cluster default), not 5 m.
  *Why it matters:* this doc ships in the scale-zero-pg package and is written for the platform
  owner who will make the #779 costed call — the whole framing of that decision is "60 s vs 5 m",
  which is a comparison against a value no user's config currently carries. It also crosses the
  repo hard rule "never present an unbuilt generator as shipping" (CLAUDE.md/scs-zones). Cheap fix:
  "the `5m` ADR-0045 scaffolds (knext#763, pending)" or "the 5 m ADR-0045 recommends".
  Note it is *inherited*, not invented: the architect ruling says the same, and
  `docs/operator/crd-nextapp.md:117` already carries the same pre-existing claim (landed in #769) —
  but this PR propagates it into a second package's docs, so it is worth correcting here rather
  than compounding.

- `packages/scale-zero-pg/docs/appdatabase-api.md:184-185` (and the same figures in the godoc) —
  **"measured: 290 ms / ~2.3 s" is cited with no in-repo record.** `~2.3 s` traces to
  `docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md:35`; `~52 ms` traces to ADR-0045 and
  `docs/benchmarks/fm-confirmatory-prepulled-ab-2026-08-18.md:140`. **290 ms** appears nowhere in
  `docs/benchmarks/` — its only traces are the #766 issue body and the untracked
  `.claude/gate-766-shape.md`. *Why it matters:* the repo's own rule is "cite the code/record, not
  the number", and this is a cross-package doc where a reader cannot follow the citation. Low
  severity — add the benchmark link or say "measured on the file-manager spike (#766)".

## Verified clean (each checked against BOTH the ruling and the tree)

1. **`nextapp_types.go:460-474` godoc.** Numbers match the ruling verbatim (290 ms warm vs ~2.3 s
   cold; ~52 ms warm hit already asserted two paragraphs up). "each operator evaluating its own"
   matches the `WarmSchedule` godoc above it (`:296` "Each operator evaluates the windows itself")
   and ADR-0030's addendum (`:216-220`). "knext's operator never reads or writes AppDatabase" is
   true — the only `AppDatabase` occurrences in `packages/kn-next-operator/{api,internal}` are
   these two comment lines. Placement mirrors the ruling's instruction ("one godoc paragraph,
   nothing else").
2. **CRD drift.** Ran `make manifests` (controller-gen) on the branch: `git diff` is **empty**,
   `git status` shows no tracked modification — the 15 added yaml lines are exactly the
   regenerated description, nothing hand-edited.
3. **`GW_IDLE_MS` citations.** Shipped `packages/scale-zero-pg/deploy/81-apps-gateway.yaml:82` =
   `"60000"`; code default `gateway/internal/gateway/gateway.go:142` = `envInt(env,"GW_IDLE_MS",
   300000)`, consumed by the single per-endpoint `scheduleSleep` timer (`:714,:723`). Both cited
   correctly, and the doc correctly calls it platform-wide (the gateway reads no CR/ConfigMap).
4. **"no `minWarm`" reason.** Both halves hold in code: the appdb operator's Role
   (`deploy/83-appdb-operator.yaml:40-42`) grants `deployments` **without** `deployments/scale`,
   and `appdb/k8s.go:172-176` documents+implements preserving live `spec.replicas` so it never
   fights the gateway. The doc's one-line reason ("no writer can honour it without fighting the
   gateway's single-writer replica ownership") is a fair compression of both.
5. **The invariant is directionally sound, not just transcribed.** `GW_IDLE_MS ≥ scaleDownDelay`
   really does bound the failure: the pool's `idleTimeoutMillis` defaults to 10 s and is asserted
   `< 60_000` ("dead-socket bound", `packages/lib/src/__tests__/clients-ro.test.ts:57`), so
   connections drop ~10 s after the last query, the gateway timer then arms, and the compute is
   reaped at ~T+10s+GW_IDLE_MS while the pod is routable to T+delay. This also means the new
   paragraph does **not** contradict the "Connection-wall interlock" paragraph in the same godoc
   (held pod ⇒ held idle connections) — the pool releases well before the gateway window.
6. **No contradiction with §3b's mechanism text.** The insert sits between §3b's Semantics and
   "Mechanism — a held connection, never a replica write"; it primes rather than contradicts it
   (no replica floor / hold-based warm). Mild flow interruption only.
7. **ADR-0030 addendum note.** Placed inside the addendum (§201-293), as the ruling directed
   ("amend ADR-0030's addendum, not ADR-0045"). Its claims check out: ADR-0045 §Consequences **does**
   forward-reference #766 (`0045-scale-down-delay.md:94`, plus the open action item at `:105`);
   #779 is indeed the `GW_IDLE_MS` fleet-value issue; the `idleDelay` shape was pre-ruled, not
   decided.
8. **Cross-check.** Diff is comment + generated-description + markdown only. No new field, no
   validation change, no operator/reconcile change, no cross-resource read, no CLI/config/CRD
   *schema* change (description-only), and #779 is explicitly deferred ("a costed decision tracked
   on the knext side"), not decided. The ruling's item (a) ("delete the workaround") has nothing
   to do in-tree — `deploy-spike/pg-keepwarm.yaml` is untracked local cruft (`git ls-files` finds
   no `keepwarm`/`deploy-spike` path).

## Test quality

No tests, correctly — the change is comments and prose; the only mechanical guard that applies is
CRD-vs-godoc regeneration, and I ran `make manifests` myself and confirmed a zero diff rather than
trusting the PR's "CRD regenerated" claim.
