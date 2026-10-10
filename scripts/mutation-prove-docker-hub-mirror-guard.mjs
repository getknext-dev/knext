#!/usr/bin/env node
/**
 * Mutation proof for #2106's Docker Hub mirror guard
 * (`scripts/docker-hub-mirror-guard.mjs`, `tests/docker-hub-mirror-guard.test.ts`).
 *
 * Same shared harness/discipline as the other provers: `mutate` asserts the anchor
 * occurs exactly once and aborts otherwise; every mutation is scored by the spec's
 * EXIT CODE (never grepped output); each is restored before the next.
 *
 * Usage: node scripts/mutation-prove-docker-hub-mirror-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/docker-hub-mirror-guard.test.ts';

const PROOF = {
  subjects: {
    guard: 'scripts/docker-hub-mirror-guard.mjs',
    ci: '.github/workflows/ci.yml',
    action: '.github/actions/docker-hub-mirror/action.yml',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'scanner: a pulling job with no mirror step is no longer a violation',
    subject: 'guard',
    anchor: '      if (mirrored < 0 || mirrored > first) {',
    replacement: '      if (false) {',
  },
  {
    label: 'scanner: a mirror step AFTER the first pull is accepted',
    subject: 'guard',
    anchor: '      if (mirrored < 0 || mirrored > first) {',
    replacement: '      if (mirrored < 0) {',
  },
  {
    label: 'scanner: jobs are never considered pulling',
    subject: 'guard',
    anchor: '      if (first < 0) continue;',
    replacement: '      continue;',
  },
  {
    label: 'scanner: a script that itself pulls is not followed',
    subject: 'guard',
    anchor: "    if (existsSync(p) && PULLING_SCRIPT.test(readFileSync(p, 'utf8'))) return true;",
    replacement: '    if (false) return true;',
  },
  {
    label: 'scanner: services/container images are never judged (any Docker Hub ref passes)',
    subject: 'guard',
    anchor:
      "  if (typeof ref !== 'string') return true; // expression-only refs are judged by the author",
    replacement: '  return true;',
  },
  {
    label: 'scanner: setup-buildx without a buildkitd config is accepted',
    subject: 'guard',
    anchor:
      "        if (!w['buildkitd-config'] && !w['buildkitd-config-inline'] && w.driver !== 'docker') {",
    replacement: '        if (false) {',
  },
  {
    label: 'real workflow: a services image reverts to an anonymous Docker Hub ref',
    subject: 'ci',
    anchor: 'image: mirror.gcr.io/library/postgres:16\n',
    replacement: 'image: postgres:16\n',
  },
  {
    label: 'composite action: the daemon registry-mirrors setting is dropped',
    subject: 'action',
    anchor: '{"registry-mirrors": ["https://mirror.gcr.io"]}',
    replacement: '{"x": ["https://mirror.gcr.io"]}',
  },
];

declareMutations(MUTATIONS.length);

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
