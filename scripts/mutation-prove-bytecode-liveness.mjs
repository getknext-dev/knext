#!/usr/bin/env node
/**
 * Mutation proof for "bytecode caching proven LIVE per cell" — the guards in
 * tests/bytecode-liveness*.test.ts and rule 7 of tests/compat-window-audit.test.ts.
 *
 * The founder rule is that a cell must not credential unless bytecode caching
 * is proven live at runtime. The two ways that can silently stop being true are
 * the two this proves red:
 *
 *   * DISABLE THE NODE CACHE — the node boot loses NODE_COMPILE_CACHE, the bake
 *     is skipped, or the liveness floor stops judging the accepted count. Each
 *     must red a spec.
 *   * BOOT A NON-BYTECODE BUN — the bun rule stops requiring the compiled exec,
 *     or stops requiring the verifier's proof. Each must red a spec.
 *
 * Plus the plumbing between them, because a correct rule whose evidence never
 * reaches the audit is still decoration: the summary dropping the evidence,
 * the audit dropping rule 7, and the audit treating missing evidence as live.
 *
 * Same discipline as scripts/mutation-prove-compat-window-audit.mjs:
 *   * `mutate` asserts each anchor occurs EXACTLY once and aborts otherwise, so
 *     a silently-failed substitution cannot certify a decorative guard;
 *   * judged on EXIT CODES only, never grepped output;
 *   * a baseline-green check first (a spec already red would make every
 *     mutation look "caught") and a green-again check after each restore;
 *   * `declareMutations` / `recordMutation` so the lane can tell N-of-M from M.
 *
 * Usage:  node scripts/mutation-prove-bytecode-liveness.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIVENESS = resolve(REPO_ROOT, 'scripts/e2e-bytecode-liveness.mjs');
const DEPLOY = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const SUMMARY = resolve(REPO_ROOT, 'scripts/e2e-summary.mjs');
const AUDIT = resolve(REPO_ROOT, 'scripts/compat-window-audit.mjs');
// knext's OWN compile-cache path — what the standalone-node image ships.
const SHIPPED_BAKE = resolve(
  REPO_ROOT,
  'packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs',
);
const CHILD_ENV = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/env.ts');

const SPEC_RULE = 'tests/bytecode-liveness.test.ts';
const SPEC_CHAIN = 'tests/bytecode-liveness-chain.test.ts';
const SPEC_WIRING = 'tests/bytecode-liveness-wiring.test.ts';
const SPEC_AUDIT = 'tests/compat-window-audit.test.ts';
const SPECS = [SPEC_RULE, SPEC_CHAIN, SPEC_WIRING, SPEC_AUDIT];

/**
 * Table-driven, with literal `anchor:` properties, so the static anchor-drift
 * scan (scripts/lib/prover-anchor-scan.mjs) can check every anchor at PR time.
 */
const MUTATIONS = [
  // ── Disable the node cache ───────────────────────────────────────────────
  {
    label: 'node: boot server.js WITHOUT the baked compile cache',
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor: '      NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \\\n',
    replacement: '',
  },
  {
    label: "node: skip knext's shipped bake driver",
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor: '          node "${KNEXT_BAKE_DRIVER}" >&2',
    replacement: '          true',
  },
  {
    label: "node: boot server.js directly instead of through knext's shipped supervisor",
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor: '      exec node "${KNEXT_NODE_SUPERVISOR}" \\',
    replacement:
      '      exec "${SERVER_CMD}" "${SERVER_PRELOAD_ARGS[@]}" "${SERVER_BOOT_TARGET}" \\',
  },
  // ── Break KNEXT's own cache path — the node night must go red ────────────
  {
    label: 'knext: the shipped bake driver stops importing server.js (bakes nothing of the app)',
    target: SHIPPED_BAKE,
    spec: SPEC_WIRING,
    anchor: '    await import(serverPath);',
    replacement: '    void serverPath;',
    // `.mjs.hbs` has no extension-derived comment syntax; it is plain JS.
    commentPrefix: '//',
  },
  {
    label: 'knext: the shipped supervisor stops handing the child NODE_COMPILE_CACHE',
    target: CHILD_ENV,
    spec: SPEC_WIRING,
    anchor: '        ...process.env,',
    replacement:
      "        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_COMPILE_CACHE')),",
  },
  {
    label: 'node: accept a FAILED shipped bake as live',
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: "    if (fields.compile_cache_bake !== 'ok') {",
    replacement: '    if (false) {',
  },
  {
    label:
      "node: stop scoping the count to the standalone child (the supervisor's modules leak in)",
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: '    if (under && !path.startsWith(under)) continue;',
    replacement: '    void under;',
  },
  {
    label: 'node: stop judging the accepted-entry floor (a cold boot must still be refused)',
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: '    if (accepted < NODE_CACHE_ACCEPTED_FLOOR) {',
    replacement: '    if (false) {',
  },
  // ── Boot a non-bytecode bun ──────────────────────────────────────────────
  {
    label: 'bun: accept a server.js boot as live (the non-bytecode fallback)',
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: "    if (fields.mode !== 'compiled-exec') {",
    replacement: '    if (false) {',
  },
  {
    label: "bun: stop requiring the build-time verifier's bytecode proof",
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: "    if (fields.bytecode_verified !== 'true') {",
    replacement: '    if (false) {',
  },
  // ── The plumbing: the evidence must reach the audit, and be graded there ──
  {
    label: 'summary: drop the evidence instead of folding it into the shard summary',
    target: SUMMARY,
    spec: SPEC_CHAIN,
    anchor: '    summary.bytecode = summarizeBootLedger(bootLedger, summary.runtime);',
    replacement: '    void bootLedger;',
  },
  {
    label: 'audit: drop rule 7 (grade nights without looking at bytecode liveness)',
    target: AUDIT,
    spec: SPEC_AUDIT,
    anchor: '      if (!verdict.live) {',
    replacement: '      if (false) {',
  },
  {
    label: 'audit: treat MISSING evidence as live',
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: "    return { live: false, reason: 'no bytecode-liveness evidence recorded' };",
    replacement: '    return { live: true, reason: null };',
  },
  {
    label: 'audit: trust a forged block (live < deploys with notLive zeroed)',
    target: LIVENESS,
    spec: SPEC_RULE,
    anchor: '  if (e.live !== e.deploys || e.notLive !== 0) {',
    replacement: '  if (e.notLive !== 0) {',
  },
];

declareMutations(MUTATIONS.length);

/** True when the spec PASSED. Exit code only — never the output. */
function specPasses(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let pass = 0;
let fail = 0;

function prove({ label, target, spec, anchor, replacement, commentPrefix }) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(target);
  try {
    mutate(snap, anchor, replacement, commentPrefix ? { commentPrefix } : {});
    if (specPasses(spec)) {
      console.log(`   x DECORATION: ${spec} stayed GREEN with the behaviour removed`);
      fail += 1;
    } else {
      console.log(`   ok ${spec} went RED as required`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: every spec must be GREEN before anything is mutated.');
for (const spec of SPECS) {
  if (!specPasses(spec)) {
    console.error(`FATAL: ${spec} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

// Byte snapshots of every subject, taken before the first mutation: each must
// exist (a prover pointed at a deleted file proves nothing), and each must be
// byte-identical again once every mutation has been restored.
// Each named literally, so the static prover audit can see every subject is read.
const SUBJECTS = [
  snapshot(LIVENESS),
  snapshot(DEPLOY),
  snapshot(SUMMARY),
  snapshot(AUDIT),
  snapshot(SHIPPED_BAKE),
  snapshot(CHILD_ENV),
];

for (const m of MUTATIONS) prove(m);

for (const s of SUBJECTS) {
  if (!readFileSync(s.path).equals(s.bytes)) {
    console.error(`FATAL: ${s.path} is not byte-identical to its pre-mutation snapshot`);
    process.exit(1);
  }
}

console.log(`\n${pass} caught, ${fail} undetected.`);
if (fail > 0) {
  console.error('At least one mutation went undetected — that guard is decoration.');
  process.exit(1);
}
