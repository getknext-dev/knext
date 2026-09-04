#!/usr/bin/env node
/**
 * Mutation proof for the deployment-skew id chain (T2, #892).
 *
 * The chain is five small things — a template line, a guard, a marker write, a
 * fail-safe, a CR env entry — and each of them is the shape that ships green
 * and unenforced. Worse, this chain has already been silently inert once: the
 * pre-T2 lock-step guard read `.next/BUILD_ID`, which vinext never writes, so
 * on the default build target it warned and skipped on EVERY deploy while
 * reading as a control that was in place. So the question here is never "does
 * the guard exist" but "does removing what it protects turn it red".
 *
 * WHAT IS PLANTED, and why each one is a real failure rather than a
 * hypothetical:
 *
 *   1-2. Either scaffold template loses `generateBuildId`. This is the #892
 *        root cause exactly: vinext falls back to a UUID, and the whole chain
 *        (marker, protection, reclaim) is keyed on a value nothing can resolve.
 *        Two rows because "we fixed the app template" is how the zone
 *        generator would be left behind.
 *   3.   The vinext leg's missing-prefix branch is disarmed — the pre-T2
 *        behaviour, a guard that reports success while inert.
 *   4.   The guard stops running under `--skip-build`. That is the leg with no
 *        other check on it: nothing else notices that `.output` belongs to an
 *        earlier deploy, so the assets upload under the wrong prefix and the
 *        GC reaps them out from under the new revision.
 *   5.   The guard's SCOPE is widened back to every deploy, so a no-storage or
 *        `--skip-upload` deploy aborts over a directory name while uploading
 *        nothing. Scored against `deploy-no-storage`, the suite that owns that
 *        mode — in round 1 it stubbed the seam to always agree, which is
 *        precisely why this reached review.
 *   6.   The `--skip-build` case reverts to a plain Error, so a mistake with a
 *        one-word fix prints a FATAL stack dump instead of the fix.
 *   7.   The T2d override warning goes silent. It was green-if-deleted in
 *        round 1: a decision recorded only in a comment.
 *   8.   The `.knext-build` marker write is removed — #892's subject. The GC
 *        reverts to over-keeping every vinext build forever.
 *   9.   The marker is written into the ARTIFACT instead of the staging copy,
 *        which mutates a tree the concurrent docker build is COPYing.
 *   10.  The write site stops VERIFYING the caller's id and just writes the
 *        marker. This is the round-2 rule — the equality is enforced where the
 *        marker is written, not by call-site discipline — and its absence is
 *        what let `kn-next build` mark a UUID no revision can protect.
 *   11.  THE OVER-DELETE DIRECTION: any prefix satisfies the check rather than
 *        the stated one. The mutation most likely to look harmless in review.
 *   12.  `_vinext_fonts` drops out of the pruner's reserved set — the
 *        `next/font` namespace that broke round 1's discovery rule.
 *   13.  `reclaimBuildPrefix` short-circuits. It deletes nothing and logs that
 *        it reclaimed the prefix — the pre-T2 behaviour, and the reason T2c is
 *        a store-mutating test rather than an argv assertion.
 *   14.  The CR stops carrying NEXT_DEPLOYMENT_ID at all.
 *   15.  The user's colliding value wins over the deploy's. The entry is still
 *        there, so any "is the key present" check passes.
 *
 * Every spec here imports `bun:test`, so the runner is resolved through
 * `resolveSpecRunner` (#902) — vitest collects nothing in these files, and a
 * prover that spawned it would report every mutation as caught while running
 * zero tests.
 *
 * Usage:  node scripts/mutation-prove-skew-id-chain.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { countOccurrences, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const APP_TEMPLATE = resolve(REPO_ROOT, 'packages/kn-next/templates/app/next.config.ts.hbs');
const ZONE_TEMPLATE = resolve(REPO_ROOT, 'turbo/generators/templates/zone/next.config.ts.hbs');
const DEPLOY = resolve(REPO_ROOT, 'packages/kn-next/src/cli/deploy.ts');
const UPLOAD = resolve(REPO_ROOT, 'packages/kn-next/src/utils/asset-upload.ts');
const CR_BUILDER = resolve(REPO_ROOT, 'packages/kn-next/src/cli/cr-builder.ts');

const SPEC_TEMPLATES = 'packages/kn-next/src/__tests__/skew-build-id-templates.test.ts';
const SPEC_DEPLOY = 'packages/kn-next/src/__tests__/deploy-orchestrator.test.ts';
const SPEC_STAGE = 'packages/kn-next/src/__tests__/asset-upload-stage.test.ts';
const SPEC_GC = 'packages/kn-next/src/__tests__/vinext-asset-gc.test.ts';
const SPEC_CR_ENV = 'packages/kn-next/src/__tests__/cr-builder-env.test.ts';
const SPEC_NO_STORAGE = 'packages/kn-next/src/__tests__/deploy-no-storage.test.ts';

/** SGR colour codes in runner output — matched without a raw escape byte. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const GENERATE_BUILD_ID = '    generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID || null,\n';

/**
 * Every disarm, as `[file, label, anchor, replacement, spec, opts?]`.
 *
 * A TABLE rather than inline calls, so the declaration below is DERIVED from it
 * and cannot drift: adding a row runs it and counts it in the same edit.
 */
const MUTATIONS = [
  [
    APP_TEMPLATE,
    '#892 ROOT CAUSE: the app template loses generateBuildId (vinext mints a UUID)',
    GENERATE_BUILD_ID,
    '',
    SPEC_TEMPLATES,
    // `.hbs` has no comment syntax the harness knows, so the residue marker's
    // prefix is supplied here.
    { commentPrefix: '//' },
  ],
  [
    ZONE_TEMPLATE,
    'the ZONE generator template is left behind while the app template is fixed',
    GENERATE_BUILD_ID,
    '',
    SPEC_TEMPLATES,
    { commentPrefix: '//' },
  ],
  [
    DEPLOY,
    'PRE-T2 BEHAVIOUR: a missing build prefix stops aborting the deploy',
    '        if (!prefix.ok) {\n',
    '        if (false) {\n',
    SPEC_DEPLOY,
  ],
  [
    DEPLOY,
    'the guard stops running under --skip-build (the leg nothing else checks)',
    '    if (resolvedBuild === "vinext" && uploadsAssets) {\n',
    '    if (resolvedBuild === "vinext" && uploadsAssets && !options.skipBuild) {\n',
    SPEC_DEPLOY,
  ],
  [
    DEPLOY,
    'ROUND 2: the guard fires on deploys that upload NOTHING (no-storage / --skip-upload)',
    '    const uploadsAssets = hasStorage(config) && !options.skipUpload;\n',
    '    const uploadsAssets = true;\n',
    // The suite that owns ADR-0047's mode. Round 1 stubbed the seam to always
    // agree here, which is exactly why this defect reached review.
    SPEC_NO_STORAGE,
  ],
  [
    DEPLOY,
    'the --skip-build case reverts to a FATAL dump instead of usage guidance',
    '                throw new UsageError(\n',
    '                throw new Error(\n',
    SPEC_DEPLOY,
  ],
  [
    DEPLOY,
    'T2d: the config-override warning goes silent (green-if-deleted in round 1)',
    '        config.env?.NEXT_DEPLOYMENT_ID !== undefined &&\n',
    '        false &&\n',
    SPEC_DEPLOY,
  ],
  [
    UPLOAD,
    '#892 ITSELF: the .knext-build marker is not staged for a vinext build',
    '    if (buildId) {\n',
    '    if (false) {\n',
    SPEC_GC,
  ],
  [
    UPLOAD,
    'the marker is written into the ARTIFACT instead of the staging copy',
    '            join(stagingDir, "_next", "static", buildId, BUILD_MARKER_FILENAME),\n',
    '            join(sourceDir, "_next", "static", buildId, BUILD_MARKER_FILENAME),\n',
    SPEC_STAGE,
  ],
  [
    UPLOAD,
    'ROUND 2: the write site TRUSTS the caller instead of verifying the prefix',
    '        if (!check.ok) {\n',
    '        if (false) {\n',
    SPEC_STAGE,
  ],
  [
    UPLOAD,
    'THE OVER-DELETE DIRECTION: any prefix satisfies the check, not the stated one',
    '    if (expectedId && siblings.includes(expectedId)) return { ok: true };\n',
    '    if (siblings.length > 0) return { ok: true };\n',
    SPEC_STAGE,
  ],
  [
    UPLOAD,
    "ROUND 2: _vinext_fonts drops out of the pruner's reserved set (the next/font app)",
    '    "_vinext_fonts",\n',
    '',
    SPEC_GC,
  ],
  [
    UPLOAD,
    'PRE-T2 BEHAVIOUR: reclaimBuildPrefix deletes nothing and says it reclaimed',
    '    if (!buildId) return; // never scope to the static root\n',
    '    if (true) return; // never scope to the static root\n',
    SPEC_GC,
  ],
  [
    CR_BUILDER,
    'the CR stops carrying NEXT_DEPLOYMENT_ID into the pod',
    '                  ...(buildId ? { [DEPLOYMENT_ID_ENV]: buildId } : {}),\n',
    '',
    SPEC_CR_ENV,
  ],
  [
    CR_BUILDER,
    "the user's colliding value wins over the deploy's id (the key is still there)",
    '                  ...config.env,\n                  ...(buildId ? { [DEPLOYMENT_ID_ENV]: buildId } : {}),\n',
    '                  ...(buildId ? { [DEPLOYMENT_ID_ENV]: buildId } : {}),\n                  ...config.env,\n',
    SPEC_CR_ENV,
  ],
];

/**
 * Refuse the whole run unless every row is anchored EXACTLY once, changes
 * something, and produces a mutated file distinct from every other row's.
 * A silently-failed substitution yields a green run that proves nothing.
 */
function assertDistinctMutations() {
  const problems = [];
  const seen = new Map();
  for (const [file, label, anchor, replacement] of MUTATIONS) {
    const source = readFileSync(file, 'utf8');
    const occurrences = countOccurrences(source, anchor);
    if (occurrences !== 1) {
      problems.push(`"${label}": anchor occurs ${occurrences} times (expected exactly 1)`);
      continue;
    }
    const mutated = source.replace(anchor, () => replacement);
    if (mutated === source) {
      problems.push(`"${label}": substitution changes nothing`);
      continue;
    }
    const fingerprint = `${file} :: ${createHash('sha256').update(mutated).digest('hex')}`;
    if (seen.has(fingerprint)) {
      problems.push(
        `"${label}" produces a mutated file byte-identical to "${seen.get(fingerprint)}" — ` +
          'two rows, one mutation. Re-anchor on text, not indentation.',
      );
      continue;
    }
    seen.set(fingerprint, label);
  }
  if (problems.length > 0) {
    console.error('FATAL: mutation table preflight failed\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Preflight: ${MUTATIONS.length} rows, all anchored once and all distinct.\n`);
}

assertDistinctMutations();
declareMutations(MUTATIONS.length);

/** One resolved runner per spec — every spec here is bun:test (#902). */
const RUNNERS = new Map();
for (const spec of new Set(MUTATIONS.map((m) => m[4]))) {
  RUNNERS.set(spec, resolveSpecRunner(REPO_ROOT, spec));
}

function runSpec(spec) {
  const runner = RUNNERS.get(spec);
  const result = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec, '')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ANSI, '');
  const summary = output.match(/Tests\s+(.+)/)?.[1] ?? '';
  const passed = Number(
    summary.match(/(\d+) passed/)?.[1] ?? output.match(/^\s*(\d+) pass\b/m)?.[1] ?? 0,
  );
  const failed = Number(
    summary.match(/(\d+) failed/)?.[1] ?? output.match(/^\s*(\d+) fail\b/m)?.[1] ?? 0,
  );
  // The verdict is the EXIT CODE, never a grep of the output: an ANSI-mangled
  // pass/fail grep once certified fourteen decorative mutations all-green.
  // `ran` exists only to catch the collected-nothing case.
  return { ok: result.status === 0, ran: passed + failed };
}

console.log('Baseline: every spec must be GREEN before anything is disarmed.');
for (const spec of RUNNERS.keys()) {
  const baseline = runSpec(spec);
  if (baseline.ran === 0 || !baseline.ok) {
    console.error(`FATAL: ${spec} is not green to begin with (ran ${baseline.ran})`);
    process.exit(1);
  }
  console.log(`   ok ${spec} (${baseline.ran} tests)`);
}
console.log('');

let pass = 0;
let fail = 0;

for (const [file, label, anchor, replacement, spec, opts = {}] of MUTATIONS) {
  console.log(`── disarming: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement, opts);
    const { ok, ran } = runSpec(spec);
    if (ran === 0) {
      // A spec that did not RUN is not a spec that went red. Reporting the
      // disarm as caught here is the confidently-wrong diagnosis this repo has
      // already shipped several times.
      console.error(`   FATAL: no test ran in ${spec} under this mutation`);
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log(`   x DECORATION: ${spec} stayed GREEN with the behaviour removed`);
      fail += 1;
    } else {
      console.log(`   ok went RED as required (${ran} tests ran)`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!runSpec(spec).ok) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`\n${pass} disarm(s) went RED as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
