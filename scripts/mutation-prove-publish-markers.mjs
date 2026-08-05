#!/usr/bin/env node
/**
 * Mutation proof for the #674 round-2 fixes.
 *
 * Round 1's guards were green against the real `.github/workflows` while the
 * classifier behind them had four holes, every one found by executing it on an
 * input it had never been given. Green-on-one-known-answer is not coverage, so
 * this script restores each round-1 behaviour in turn and REQUIRES the specs to
 * go red. A test that stays green with the defect back is decoration.
 *
 * Restoration is from a BYTE SNAPSHOT (scripts/lib/mutation-harness.mjs), every
 * mutation carries the residue marker, and each anchor is asserted to occur
 * exactly once before anything is written.
 *
 * Usage:  node scripts/mutation-prove-publish-markers.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS = resolve(REPO_ROOT, 'tests/helpers/publish-markers.ts');
const GATE_HELPER = resolve(REPO_ROOT, 'tests/helpers/blocking-gate.ts');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');

const CONCURRENCY_SPEC = 'tests/ci-concurrency-group.test.ts';
const GATE_SPEC = 'tests/blocking-gate-helper.test.ts';

let pass = 0;
let fail = 0;

function vitest(spec) {
  return (
    spawnSync('pnpm', ['exec', 'vitest', 'run', spec], { cwd: REPO_ROOT, encoding: 'utf8' })
      .status === 0
  );
}

/** The spec must be RED while the round-1 defect is restored, and GREEN after. */
function prove({ label, file, spec, anchor, replacement }) {
  console.log(`── mutation: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (vitest(spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the round-1 defect restored');
      fail += 1;
    } else {
      console.log('   ok went RED as required');
      pass += 1;
    }
  } finally {
    restore(snap);
  }
  if (!vitest(spec)) {
    console.log(
      '   x the spec did not return to GREEN after restore — investigate before trusting',
    );
    fail += 1;
  }
}

// Item 1: the registry-push marker matched only a LITERAL `true`, so the
// idiomatic `push: ${{ ... }}` classified as non-publishing.
prove({
  label: 'item 1 — build-push-action `push:` accepts only a literal true again',
  file: MARKERS,
  spec: CONCURRENCY_SPEC,
  anchor: "      if (push === false || push === 'false') return;",
  replacement: "      if (push !== true && push !== 'true') return;",
});

// Item 2: `stringify(doc)` folds at column 80, splitting two-word markers.
prove({
  label: 'item 2 — re-serialise at the default lineWidth of 80 again',
  file: MARKERS,
  spec: CONCURRENCY_SPEC,
  anchor: '  const text = stringify(doc, { lineWidth: 0 });',
  replacement: '  const text = stringify(doc);',
});

// Item 3: `crane push`/`crane copy` — this repo's actual publish command — was
// absent from the marker set.
prove({
  label: "item 3 — drop the `crane` marker (the repo's own publish command)",
  file: MARKERS,
  spec: CONCURRENCY_SPEC,
  anchor: "  { id: 'crane push', re: /\\bcrane (push|copy)\\b/ },",
  replacement: '',
});

// Item 4: cancellation must not reach the push->main group.
prove({
  label: 'item 4 — widen cancel-in-progress back to every event',
  file: CI_YML,
  spec: CONCURRENCY_SPEC,
  anchor: "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  replacement: '  cancel-in-progress: true',
});

// Item 5: REF_SCOPED accepted any interpolation merely CONTAINING `github.ref`.
prove({
  label: 'item 5 — REF_SCOPED accepts a substring match again',
  file: GATE_HELPER,
  spec: GATE_SPEC,
  anchor:
    'const REF_SCOPED = /\\$\\{\\{\\s*github\\.(ref|ref_name|head_ref|event\\.pull_request\\.number)\\s*\\}\\}/;',
  replacement:
    'const REF_SCOPED = /\\$\\{\\{[^}]*github\\.(ref|ref_name|head_ref)[^}]*\\}\\}|pull_request\\.number/;',
});

// Item 6: the exemption is per-marker, not per-file.
prove({
  label: 'item 6 — make the cancel-in-progress exemption blanket per file again',
  file: resolve(REPO_ROOT, CONCURRENCY_SPEC),
  spec: CONCURRENCY_SPEC,
  anchor: '  return markers.filter((m) => !excused.has(m));',
  replacement: '  return excused.size > 0 ? [] : markers;',
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
