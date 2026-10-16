#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust slow-call counter (#2385).
 *
 * The generated module times every Rust call, counts a call slower than
 * KNEXT_FFI_SLOW_CALL_MS (default 50 ms, 0 = off) per function, logs the first
 * one per function, reports the first load, and publishes a render function on
 * globalThis that core's loopback metrics listener appends to the metrics port.
 * Each guard below must go red when the behaviour it protects is removed:
 *
 *   - ffi-slow-calls.test.ts      the emitted text (render.ts);
 *   - ffi-loader.test.ts          the behaviour, against a real shared library
 *                                 whose `add` sleeps past the threshold;
 *   - ffi-metrics-seam.test.ts    core's reader (deep-health-lite.ts);
 *   - rust-in-process-doc.test.ts the docs quote the log lines as emitted;
 *   - observability-metric-contract.test.ts  every metric the docs name is emitted.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), each
 * baseline must be green, a canary must go red before any green is trusted,
 * and every restore is content-verified. The loader spec needs a system `cc`.
 *
 * What this does not prove: the kind e2e's metrics assertion
 * (packages/ffi/scripts/ffi-action-e2e.mjs), which needs a cluster.
 *
 * Usage:  node scripts/mutation-prove-2385-ffi-slow-calls.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACT = [
  {
    id: 'S01',
    subject: 'render',
    claim: 'the symbol call is no longer timed (no clock read before it)',
    anchor: "    lines.push('  const $t0 = performance.now();');\n",
    replacement: '',
  },
  {
    id: 'S02',
    subject: 'render',
    claim: 'a slow call is measured but never counted',
    anchor: '    lines.push(`  if ($ms > $slowMs) $slow(${name}, $ms);`);\n',
    replacement: '',
  },
  {
    id: 'S03',
    subject: 'render',
    claim: 'the default threshold is not 50 ms',
    anchor: "  if (raw === undefined || raw.trim() === '') return 50;",
    replacement: "  if (raw === undefined || raw.trim() === '') return 500;",
  },
  {
    id: 'S04',
    subject: 'render',
    claim: 'the counts live under a per-copy Symbol, not the process-wide Symbol.for key',
    anchor: "  const key = Symbol.for('knext.ffi.metrics');",
    replacement: "  const key = Symbol('knext.ffi.metrics');",
  },
  {
    id: 'S05',
    subject: 'render',
    claim: 'the render function is never published for the metrics port',
    anchor:
      "  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('knext.ffi.renderMetrics')] = $renderMetrics;",
    replacement: '',
  },
  {
    id: 'S06',
    subject: 'render',
    claim: 'the slow check runs after an error is thrown (a slow failing call is not counted)',
    anchor:
      "    lines.push('  const $ms = performance.now() - $t0;');\n    lines.push(`  if ($ms > $slowMs) $slow(${name}, $ms);`);\n    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);",
    replacement:
      "    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);\n    lines.push('  const $ms = performance.now() - $t0;');\n    lines.push(`  if ($ms > $slowMs) $slow(${name}, $ms);`);",
  },
];

const LOADER = [
  {
    id: 'L01',
    subject: 'render',
    claim: 'the comparison is inverted: fast calls are counted, slow ones are not',
    anchor: '    lines.push(`  if ($ms > $slowMs) $slow(${name}, $ms);`);',
    replacement: '    lines.push(`  if ($ms < $slowMs) $slow(${name}, $ms);`);',
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'every slow call is logged, not only the first per function',
    anchor: '  if (r.logged.has(fn)) return;\n',
    replacement: '',
  },
  {
    id: 'L03',
    subject: 'render',
    claim: 'KNEXT_FFI_SLOW_CALL_MS=0 no longer turns counting off',
    anchor: '  if (ms === 0) return Infinity;\n',
    replacement: '',
  },
  {
    id: 'L04',
    subject: 'render',
    claim: 'two copies of the module count into two registries (a per-copy Symbol)',
    anchor: "  const key = Symbol.for('knext.ffi.metrics');",
    replacement: "  const key = Symbol('knext.ffi.metrics');",
  },
  {
    id: 'L05',
    subject: 'render',
    claim: 'the module publishes under a key core does not read',
    anchor:
      "  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('knext.ffi.renderMetrics')] = $renderMetrics;",
    replacement:
      "  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('knext.ffi.metricsRender')] = $renderMetrics;",
  },
  {
    id: 'L06',
    subject: 'render',
    claim: 'the first load is never reported',
    anchor: '  if (!r.load.has($LIB)) r.load.set($LIB, seconds);\n',
    replacement: '',
  },
  {
    id: 'L07',
    subject: 'render',
    claim: 'an unusable threshold value is taken as is instead of falling back to 50',
    anchor: '  if (Number.isFinite(ms) && ms > 0) return ms;',
    replacement: '  if (!Number.isNaN(ms)) return ms;',
  },
  {
    id: 'L08',
    subject: 'render',
    claim: 'functions are not listed at 0 once the library loads',
    anchor: '  for (const [fn] of $SCHEMAS) if (!r.slow.has(fn)) r.slow.set(fn, 0);\n',
    replacement: '',
  },
];

const CORE = [
  {
    id: 'C01',
    subject: 'lite',
    claim: "core's listener no longer appends the in-process Rust seam",
    anchor:
      '    return appendExposition(\n        appendExposition(readCdnMetrics(), readUseCacheMetrics()),\n        readFfiMetrics(),\n    );',
    replacement: '    return appendExposition(readCdnMetrics(), readUseCacheMetrics());',
  },
  {
    id: 'C02',
    subject: 'lite',
    claim: 'core reads a key the generated module never publishes',
    anchor: 'const FFI_METRICS_SEAM = Symbol.for("knext.ffi.renderMetrics");',
    replacement: 'const FFI_METRICS_SEAM = Symbol.for("knext.core.ffi.renderMetrics");',
  },
];

const DOCS = [
  {
    id: 'D01',
    subject: 'render',
    claim: 'the slow-call log line changes without the docs that quote it',
    anchor: 'A Rust call blocks this process for its whole duration',
    replacement: 'A Rust call blocks this pod for its whole duration',
  },
  {
    id: 'D02',
    subject: 'render',
    claim: 'the unusable-threshold warning changes without the docs that quote it',
    anchor: 'it must be a number of milliseconds (0 turns slow-call counting off). Using 50.',
    replacement: 'it must be a number (0 turns slow-call counting off). Using 50.',
  },
];

const METRIC_CONTRACT = [
  {
    id: 'M01',
    subject: 'render',
    claim: 'a family the docs name is renamed in the module',
    anchor: "    '# TYPE knext_ffi_load_seconds gauge',",
    replacement: "    '# TYPE knext_ffi_load_secs gauge',",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const contract = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/ffi-slow-calls.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});
const loader = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/ffi-loader.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});
const core = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/ffi-metrics-seam.test.ts',
  subjects: { lite: 'packages/kn-next/src/adapters/deep-health-lite.ts' },
});
const docs = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'apps/docs/rust-in-process-doc.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});
const metricContract = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/observability-metric-contract.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});

console.log('=== mutation proof: in-process Rust slow-call counter (#2385) ===');
contract.preflight(CONTRACT);
loader.preflight(LOADER);
core.preflight(CORE);
docs.preflight(DOCS);
metricContract.preflight(METRIC_CONTRACT);
declareMutations(
  CONTRACT.length + LOADER.length + CORE.length + DOCS.length + METRIC_CONTRACT.length,
);

console.log('\n=== the emitted text (ffi-slow-calls.test.ts) ===');
contract.baseline();
contract.proveCanSeeRed({
  subject: 'render',
  anchor: "    lines.push('  const $t0 = performance.now();');",
  replacement: "    lines.push('  const $t0 = Date.now();');",
});
for (const m of CONTRACT) {
  contract.run({ ...m, expect: 'red' });
  recordMutation();
}
contract.finish(CONTRACT.length);

console.log('\n=== the behaviour, against a real library (ffi-loader.test.ts) ===');
loader.baseline();
loader.proveCanSeeRed({
  subject: 'render',
  anchor: '    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);',
  replacement: '    lines.push(`  if ($st === 99) $fail(${name}, $st);`);',
});
for (const m of LOADER) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length);

console.log("\n=== core's reader (ffi-metrics-seam.test.ts) ===");
core.baseline();
core.proveCanSeeRed({
  subject: 'lite',
  anchor: 'export function readFfiMetrics(): string {\n    return readSeam(FFI_METRICS_SEAM);',
  replacement: 'export function readFfiMetrics(): string {\n    return "";',
});
for (const m of CORE) {
  core.run({ ...m, expect: 'red' });
  recordMutation();
}
core.finish(CORE.length);

console.log('\n=== the docs quote what the module prints (rust-in-process-doc.test.ts) ===');
docs.baseline();
docs.proveCanSeeRed({
  subject: 'render',
  anchor: 'over the \\${$slowMs} ms slow-call threshold',
  replacement: 'over the \\${$slowMs}ms slow-call threshold',
});
for (const m of DOCS) {
  docs.run({ ...m, expect: 'red' });
  recordMutation();
}
docs.finish(DOCS.length);

console.log(
  '\n=== every metric the docs name is emitted (observability-metric-contract.test.ts) ===',
);
metricContract.baseline();
metricContract.proveCanSeeRed({
  subject: 'render',
  anchor: "    '# TYPE knext_ffi_slow_calls_total counter',",
  replacement: "    '# TYPE knext_ffi_slow_total counter',",
});
for (const m of METRIC_CONTRACT) {
  metricContract.run({ ...m, expect: 'red' });
  recordMutation();
}
metricContract.finish(METRIC_CONTRACT.length);
