#!/usr/bin/env node
/**
 * Mutation proof for #2307 (the metric contract parses RENDERED output) and the
 * CDN metrics seam that puts the CDN counters on the app's metrics port.
 *
 * #2307's two acceptance cases, each by EXIT CODE:
 *
 *   - a RENAMED SAMPLE LINE: the emitter keeps its `# TYPE` line and renames
 *     the sample under it. A source scan of `# TYPE` lines cannot see that; the
 *     rendered parse throws on a sample no `# TYPE` declares (R*).
 *   - a NAME PLANTED IN A COMMENT: a `# TYPE`-shaped (or `export const …_METRIC`,
 *     or Go `NewCounter`) string in a comment, plus a consumer that relies on it
 *     (the expected list, or a doc naming it). The source scan accepted the
 *     planted name, so the consumer resolved and the guard stayed GREEN; now it
 *     is not rendered, so the consumer reds (C*).
 *
 * The negative controls (N*) are the other half: a comment alone, with nothing
 * relying on it, changes nothing an emitter renders, so the guard stays GREEN.
 * Under the source scan the first of them was RED (the threat model's closed
 * list saw a new "series"), which is the false positive #2307 also removes.
 *
 * The S* and D* rows prove the guards of the seam itself and of its docs.
 *
 * Several mutations edit MORE THAN ONE file (a plant plus its consumer), which
 * the single-subject `guard-prover` driver cannot express, so this prover runs
 * the same discipline itself (`.claude/rules/workflow.md`): exit codes only;
 * every anchor exactly once (preflight, before anything runs); green baseline
 * for every spec; a canary red first; every restore sha256-verified and the
 * tree checked clean between mutations; a partial run is a failure.
 *
 * Usage:  node scripts/mutation-prove-2307-rendered-metric-contract.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean, runSpecExit } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = 'packages/kn-next/src/__tests__';
const SPECS = {
  contract: `${TESTS}/observability-metric-contract.test.ts`,
  seam: `${TESTS}/cdn-metrics-seam.test.ts`,
  docs: 'apps/docs/cdn-docs.test.ts',
};
// One literal repo-relative path per subject, resolved against REPO_ROOT: the
// shape the fleet's static anchor-drift scan (`scripts/lib/prover-anchor-scan.mjs`) reads.
// Each subject is a `const` bound to a one-line `resolve(REPO_ROOT, …)` of a
// literal path and passed to `snapshot()` by name: the shapes both static
// prover audits read (`scripts/lib/prover-anchor-scan.mjs` matches the one-line
// call with no trailing comma; `scripts/lib/prover-lane.mjs` the snapshot read).
const EDGE = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/cdn-edge.cjs');
const PURGE = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/cdn-purge/metrics.js');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const SELF_CONTAINED = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/standalone-self-contained-supervisor.cjs');
const TEMPLATE = resolve(REPO_ROOT, 'packages/kn-next/templates/app/runtime-contract.mjs.hbs');
const OPERATOR = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/metrics.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const CONTRACT_TEST = resolve(REPO_ROOT, 'packages/kn-next/src/__tests__/observability-metric-contract.test.ts');
const CDN_DOC = resolve(REPO_ROOT, 'apps/docs/content/docs/cdn.mdx');
const PRELOAD = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/cache-control-normalize.cjs');
const LITE = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/deep-health-lite.ts');
const METRICS = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/metrics.ts');
// `.hbs` and `.mdx` are not in the harness's comment table.
const COMMENT = { template: '//', cdnDoc: '<!--' };

const PURGE_ROW =
  '| `knext_cdn_purge_total` | `provider`, `result` | Purge outcomes; appears after the first purge or skipped purge |';
/** A doc row naming `name`, added under the purge row of the CDN metrics table. */
const docRow = (name) => ({
  subject: 'cdnDoc',
  anchor: PURGE_ROW,
  replacement: `${PURGE_ROW}\n| \`${name}\` | none | A planted name |`,
});

// Each anchor runs to the end of its line, so the harness's trailing residue
// marker comments out nothing that matters.
const MUTATIONS = [
  // ── #2307: a renamed sample line ─────────────────────────────────────────
  {
    id: 'R1',
    spec: 'contract',
    expect: 'red',
    claim: 'the edge-decision sample line is renamed under an unchanged # TYPE line',
    edits: [
      {
        subject: 'edge',
        anchor:
          'lines.push(`knext_cdn_edge_decision_total{result="${result}",reason="${reason}"} ${count}`);',
        replacement:
          'lines.push(`knext_cdn_edge_decisions_total{result="${result}",reason="${reason}"} ${count}`);',
      },
    ],
  },
  {
    id: 'R2',
    spec: 'contract',
    expect: 'red',
    claim: 'the foreign-edge-strip sample line is renamed under an unchanged # TYPE line',
    edits: [
      {
        subject: 'edge',
        anchor: '`knext_cdn_foreign_edge_strip_total ${foreignEdgeStripCount()}`,',
        replacement: '`knext_cdn_foreign_edge_strips_total ${foreignEdgeStripCount()}`,',
      },
    ],
  },
  {
    id: 'R3',
    spec: 'contract',
    expect: 'red',
    claim: 'the purge registry renders its samples under a different name than its # TYPE line',
    edits: [
      {
        subject: 'purge',
        anchor: "out.push(`${name}${key ? `{${key}}` : ''} ${value}`);",
        replacement: "out.push(`${name}_x${key ? `{${key}}` : ''} ${value}`);",
      },
    ],
  },
  {
    id: 'R4',
    spec: 'contract',
    expect: 'red',
    claim: 'the self-contained runtime renames its knext_up sample line',
    edits: [
      {
        subject: 'selfContained',
        anchor: '`knext_up ${state.draining ? 0 : 1}`,',
        replacement: '`knext_upp ${state.draining ? 0 : 1}`,',
      },
    ],
  },
  {
    id: 'R5',
    spec: 'contract',
    expect: 'red',
    claim: 'the runtime contract renames its uptime sample line',
    edits: [
      {
        subject: 'template',
        anchor: '`knext_bunexec_process_uptime_seconds ${uptimeSec.toFixed(3)}`,',
        replacement: '`knext_bunexec_process_uptimes_seconds ${uptimeSec.toFixed(3)}`,',
      },
    ],
  },
  // ── #2307: a name planted in a comment, and relied on ─────────────────────
  {
    id: 'C1',
    spec: 'contract',
    expect: 'red',
    claim:
      'a # TYPE line planted in a cdn-edge.cjs COMMENT, with the expected list edited to match ' +
      '(the case the exact-set assertion could not catch)',
    edits: [
      {
        subject: 'edge',
        anchor: "const STRIPS_KEY = Symbol.for('knext.core.cdn.foreignEdgeStrips');",
        replacement:
          "const STRIPS_KEY = Symbol.for('knext.core.cdn.foreignEdgeStrips');\n// '# TYPE knext_cdn_ghost_total counter',",
      },
      {
        subject: 'contractTest',
        anchor: '            "knext_cdn_foreign_edge_strip_total",',
        replacement:
          '            "knext_cdn_foreign_edge_strip_total",\n            "knext_cdn_ghost_total",',
      },
    ],
  },
  {
    id: 'C2',
    spec: 'contract',
    expect: 'red',
    claim: 'a purge-metric constant planted in a COMMENT, and a doc naming it',
    edits: [
      {
        subject: 'purge',
        anchor: "const REGISTRY_KEY = Symbol.for('knext.core.cdn.metrics');",
        replacement:
          "const REGISTRY_KEY = Symbol.for('knext.core.cdn.metrics');\n// export const GHOST_METRIC = 'knext_cdn_ghost_purge_total';",
      },
      docRow('knext_cdn_ghost_purge_total'),
    ],
  },
  {
    id: 'C3',
    spec: 'contract',
    expect: 'red',
    claim: 'a # TYPE line planted in a self-contained supervisor COMMENT, and a doc naming it',
    edits: [
      {
        subject: 'selfContained',
        anchor: 'const DEFAULT_METRICS_PORT = 9464;',
        replacement:
          "const DEFAULT_METRICS_PORT = 9464;\n// '# TYPE knext_ghost_self_contained_total counter',",
      },
      docRow('knext_ghost_self_contained_total'),
    ],
  },
  {
    id: 'C4',
    spec: 'contract',
    expect: 'red',
    claim: 'a Go NewCounter planted in an operator COMMENT, and a doc naming it',
    edits: [
      {
        subject: 'operator',
        anchor: '\trolloutPending.Set(0)',
        replacement:
          '\trolloutPending.Set(0)\n\t// _ = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_ghost_operator_total"})',
      },
      docRow('knext_ghost_operator_total'),
    ],
  },
  // ── negative controls: a comment nothing relies on changes nothing ────────
  {
    id: 'N1',
    spec: 'contract',
    expect: 'green',
    claim:
      'a # TYPE line in a runtime-contract COMMENT alone (the source scan reddened here: the ' +
      'threat model saw a series the binary never serves)',
    edits: [
      {
        subject: 'template',
        anchor: "const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';",
        replacement:
          "const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';\n// '# TYPE knext_bunexec_ghost_total counter',",
      },
    ],
  },
  {
    id: 'N2',
    spec: 'contract',
    expect: 'green',
    claim: 'a # TYPE line in a cdn-edge.cjs COMMENT alone',
    edits: [
      {
        subject: 'edge',
        anchor: "const STRIPS_KEY = Symbol.for('knext.core.cdn.foreignEdgeStrips');",
        replacement:
          "const STRIPS_KEY = Symbol.for('knext.core.cdn.foreignEdgeStrips');\n// '# TYPE knext_cdn_ghost_total counter',",
      },
    ],
  },
  // ── the CDN metrics seam ──────────────────────────────────────────────────
  {
    id: 'S1',
    spec: 'seam',
    expect: 'red',
    claim: 'the preload stops publishing the seam: no CDN series reach the metrics port',
    edits: [
      {
        subject: 'preload',
        anchor: '    cdnEdge.publishMetricsSeam();',
        replacement: '    void 0;',
      },
    ],
  },
  {
    id: 'S2',
    spec: 'seam',
    expect: 'red',
    claim: 'the preload publishes the seam with CDN mode OFF (not zero-diff)',
    edits: [
      {
        subject: 'preload',
        anchor: '  const { ORIGIN_CC, STATE } = cdnEdge;',
        replacement: '  const { ORIGIN_CC, STATE } = cdnEdge;\n  cdnEdge.publishMetricsSeam();',
      },
    ],
  },
  {
    id: 'S3',
    spec: 'seam',
    expect: 'red',
    claim: 'deep-health-lite (the tracing-off listener) stops appending the CDN counters',
    edits: [
      {
        subject: 'lite',
        anchor: '        body = appendExposition(body, readCdnMetrics());',
        replacement: '        body = appendExposition(body, "");',
      },
    ],
  },
  {
    id: 'S4',
    spec: 'seam',
    expect: 'red',
    claim: "deep-health-lite's seam key drifts from the preload's",
    edits: [
      {
        subject: 'lite',
        anchor: 'const CDN_METRICS_SEAM = Symbol.for("knext.core.cdn.renderMetrics");',
        replacement: 'const CDN_METRICS_SEAM = Symbol.for("knext.core.cdn.renderMetric");',
      },
    ],
  },
  {
    id: 'S5',
    spec: 'seam',
    expect: 'red',
    claim: 'startChildMetricsServer (the tracing-on listener) stops appending the CDN counters',
    edits: [
      {
        subject: 'metrics',
        anchor: '                appendExposition(await registry.metrics(), readCdnMetrics()),',
        replacement: '                appendExposition(await registry.metrics(), ""),',
      },
    ],
  },
  {
    id: 'S6',
    spec: 'seam',
    expect: 'red',
    claim: 'the self-contained in-process metrics port stops appending the CDN counters',
    edits: [
      {
        subject: 'selfContained',
        anchor: '      }) + readCdnMetrics();',
        replacement: "      }) + '';",
      },
    ],
  },
  // ── the user docs ─────────────────────────────────────────────────────────
  {
    id: 'D1',
    spec: 'docs',
    expect: 'red',
    claim: 'the docs stop saying the vinext target serves no CDN series',
    edits: [
      {
        subject: 'cdnDoc',
        anchor: 'The `vinext` build target has no CDN support, so it serves no CDN series.',
        replacement: 'The `vinext` build target has no CDN support.',
      },
    ],
  },
  {
    id: 'D2',
    spec: 'docs',
    expect: 'red',
    claim: 'the CDN metrics table drops a counter the server renders',
    edits: [{ subject: 'cdnDoc', anchor: PURGE_ROW, replacement: '| (row removed) | | |' }],
  },
];

const snaps = {
  edge: snapshot(EDGE),
  purge: snapshot(PURGE),
  selfContained: snapshot(SELF_CONTAINED),
  template: snapshot(TEMPLATE),
  operator: snapshot(OPERATOR),
  contractTest: snapshot(CONTRACT_TEST),
  cdnDoc: snapshot(CDN_DOC),
  preload: snapshot(PRELOAD),
  lite: snapshot(LITE),
  metrics: snapshot(METRICS),
};

function preflight() {
  for (const m of MUTATIONS) {
    if (!SPECS[m.spec]) throw new Error(`${m.id}: unknown spec ${m.spec}`);
    for (const e of m.edits) {
      const snap = snaps[e.subject];
      if (!snap) throw new Error(`${m.id}: unknown subject ${e.subject}`);
      const n = readFileSync(snap.path, 'utf8').split(e.anchor).length - 1;
      if (n !== 1) {
        throw new Error(
          `ABORT (preflight): ${m.id}'s anchor occurs ${n}x in ${e.subject} (expected 1): ` +
            JSON.stringify(e.anchor.slice(0, 90)),
        );
      }
    }
  }
  console.log(`preflight ok: every anchor of ${MUTATIONS.length} mutation(s) occurs exactly once`);
}

/** Plant every edit of `m`, run its spec, restore unconditionally; return the exit code. */
function plantAndRun(m) {
  const touched = [];
  try {
    for (const e of m.edits) {
      const snap = snaps[e.subject];
      mutate(snap, e.anchor, e.replacement, { commentPrefix: COMMENT[e.subject] });
      touched.push(snap);
    }
    return runSpecExit(REPO_ROOT, SPECS[m.spec]);
  } finally {
    for (const snap of touched) restore(snap);
  }
}

console.log('=== mutation proof: #2307 rendered metric contract + CDN metrics seam ===');
preflight();
declareMutations(MUTATIONS.length);

assertTreeClean(REPO_ROOT, 'baseline');
for (const [name, spec] of Object.entries(SPECS)) {
  const status = runSpecExit(REPO_ROOT, spec);
  if (status !== 0) {
    console.error(`ABORT: ${name} (${spec}) exits ${status} before any mutation.`);
    process.exit(1);
  }
}
console.log(`baseline ok: ${Object.keys(SPECS).length} spec(s) green`);

// Step 0: the harness must SEE red before any green below is trusted.
const canary = plantAndRun(MUTATIONS[0]);
assertTreeClean(REPO_ROOT, 'after canary');
if (canary === 0) {
  console.error('ABORT: the canary (R1) left the guard GREEN; the harness cannot observe red.');
  process.exit(1);
}
console.log(`step 0 ok: the harness sees red (canary exit=${canary})`);

console.log('\n=== mutations ===');
const failures = [];
let ran = 0;
for (const m of MUTATIONS) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const status = plantAndRun(m);
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  ran += 1;
  recordMutation();
  const ok = m.expect === 'red' ? status !== 0 : status === 0;
  if (!ok) failures.push(`${m.id}: expected ${m.expect}, got exit ${status} — ${m.claim}`);
  const verdict = ok ? (m.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** SURVIVED ***';
  console.log(`   ${m.id} [${m.spec}] expect=${m.expect} exit=${status} ${verdict} — ${m.claim}`);
}

assertTreeClean(REPO_ROOT, 'final');
if (ran !== MUTATIONS.length) {
  console.error(`ABORT: declared ${MUTATIONS.length} mutation(s) but ran ${ran}. Partial != pass.`);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} mutation(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${ran} mutation(s) behaved as required, 0 survived; tree restored clean.`);
