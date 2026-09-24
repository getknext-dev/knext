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
// biome-ignore format: the anchor scan needs the resolve() call on ONE line
const SHIPPED_BAKE = resolve(REPO_ROOT, 'packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs');
const CHILD_ENV = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/env.ts');
// #1299 — the harness-only accept-any-status tolerance, moved OUT of
// SHIPPED_BAKE and into this HARNESS-owned wrapper instead.
const BAKE_ACCEPT = resolve(REPO_ROOT, 'scripts/e2e-bake-accept.mjs');

const SPEC_RULE = 'tests/bytecode-liveness.test.ts';
const SPEC_CHAIN = 'tests/bytecode-liveness-chain.test.ts';
const SPEC_WIRING = 'tests/bytecode-liveness-wiring.test.ts';
const SPEC_AUDIT = 'tests/compat-window-audit.test.ts';
const SPEC_STATE = 'tests/e2e-state-snapshot.test.ts';
const SPEC_BAKE_ACCEPT = 'tests/e2e-bake-accept.test.ts';
const SNAPSHOT = resolve(REPO_ROOT, 'scripts/lib/e2e-state-snapshot.sh');
const SPECS = [SPEC_RULE, SPEC_CHAIN, SPEC_WIRING, SPEC_AUDIT, SPEC_STATE, SPEC_BAKE_ACCEPT];

/**
 * Table-driven, with literal anchor properties, so the static anchor-drift
 * scan (scripts/lib/prover-anchor-scan.mjs) can check every anchor at PR time.
 */
const MUTATIONS = [
  {
    label: 'node: warm a /_next/static asset instead of a server route',
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor:
      'process.stdout.write((cands.length ? cands : ["/"]).map((r) => `${basePath}${r}`).join(" "));',
    replacement: 'process.stdout.write(`${basePath}/_next/static/x.js`);',
  },
  {
    // #1299 moved this tolerance OUT of SHIPPED_BAKE and into the
    // harness-owned BAKE_ACCEPT wrapper — this mutation moves with it.
    label:
      'e2e-bake-accept: accepts a connection reset / malformed status under KNEXT_WARM_ACCEPT_ANY_STATUS',
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (invalid.length > 0) {',
    replacement: '  if (false) {',
  },
  // ── #1377 review: exit code alone is never enough to tolerate ───────────
  {
    label: 'e2e-bake-accept: tolerates a signal-killed driver (SIGKILL) as if it exited cleanly',
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (signal !== null) {',
    replacement: '  if (false) {',
  },
  {
    label: "e2e-bake-accept: tolerates ANY non-zero exit code, not just the driver's documented 1",
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (exitCode !== 1) {',
    replacement: '  if (false) {',
  },
  {
    label: 'e2e-bake-accept: tolerates a crash that never reached the COMPILE_CACHE: flush line',
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (!stdout.includes(COMPILE_CACHE_MARKER)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'e2e-bake-accept: tolerates ANY stderr, not just the driver\'s own "a warm path did not answer 2xx" marker',
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (!stderr.includes(DRIVER_FAILURE_MARKER)) {',
    replacement: '  if (false) {',
  },
  {
    label:
      'e2e-bake-accept: tolerates an all-2xx WARMED set that still exited non-zero (contradicts the known failure shape)',
    target: BAKE_ACCEPT,
    spec: SPEC_BAKE_ACCEPT,
    anchor: '  if (nonTwoXx.length === 0) {',
    replacement: '  if (false) {',
  },
  {
    // #1299: the shipped driver's own strict-2xx check is what the PRODUCT
    // default (no wrapper, no knob) relies on — this used to be defeated by
    // an env var the driver read itself; now there is no such var in these
    // bytes at all, so the only way to lose strict-by-default is to weaken
    // this comparison directly.
    label: 'knext: the PRODUCT default loosens to accept non-2xx (strict-by-default lost)',
    target: SHIPPED_BAKE,
    spec: SPEC_WIRING,
    anchor: '            allOk &&= res.status >= 200 && res.status < 300;',
    replacement: '            allOk &&= true;',
    commentPrefix: '//',
  },
  {
    label:
      'node: the harness stops setting the accept-any-status knob (404/500 fixtures fail again)',
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor: '            KNEXT_WARM_ACCEPT_ANY_STATUS=1 \\\n',
    replacement: '',
  },
  {
    label:
      'node: skip restoring the fixture tree after the bake (bake-time state leaks into the fixture)',
    target: DEPLOY,
    spec: SPEC_STATE,
    anchor:
      '      restore_state "${STANDALONE_APP_DIR}" "${BAKE_STATE_SNAPSHOT}" ".next/compile-cache"',
    replacement: '      true',
  },
  {
    label: 'node: the restore helper stops unpacking the pristine snapshot',
    target: SNAPSHOT,
    spec: SPEC_STATE,
    anchor: '  tar -C "${dir}" -xf "${tarfile}"',
    replacement: '  true',
  },
  {
    label: 'restore helper: re-add `|| true` to the delete (fails open again)',
    target: SNAPSHOT,
    spec: SPEC_STATE,
    anchor: '! -path "${keepparent}" -depth -delete',
    replacement: '! -path "${keepparent}" -depth -delete 2>/dev/null || true',
  },
  {
    label: 'restore helper: fail open entirely (no chmod, silent delete, no verification)',
    target: SNAPSHOT,
    spec: SPEC_STATE,
    anchor: '  if [ "${want}" != "${have}" ]; then',
    replacement: '  if false; then',
  },
  // ── Disable the node cache ───────────────────────────────────────────────
  {
    label: 'node: boot server.js WITHOUT the baked compile cache',
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor: '      NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \\\n',
    replacement: '',
  },
  {
    label: "node: skip knext's shipped bake driver (and its e2e-bake-accept.mjs wrapper, #1299)",
    target: DEPLOY,
    spec: SPEC_WIRING,
    anchor:
      '          node "${SCRIPT_DIR}/e2e-bake-accept.mjs" node "${KNEXT_BAKE_DRIVER}" 2>&1 | tee -a "${APP_DIR}/.knext-bake.out" >&2',
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
  snapshot(BAKE_ACCEPT),
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
