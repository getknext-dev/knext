#!/usr/bin/env node
/**
 * Mutation proof for the standalone-build request-body cap (ADR-0044
 * Amendment 6): `packages/kn-next/src/adapters/request-body-cap.cjs` and its
 * wiring into every standalone launch path.
 *
 * Each mutation plants one way the control could ship green and unenforced,
 * then runs the guarding spec (`request-body-cap.test.ts`, which boots real
 * child servers under Node AND Bun and drives them over raw sockets) filtered to
 * the cases that must catch it, and requires a NON-ZERO EXIT. Verdicts branch on
 * the runner's exit code only — never on grepping its (ANSI-coloured) output.
 *
 * Before any mutation the same filtered runs must exit 0 on the clean tree:
 * a filter that selects nothing, or a spec that is already red, would make every
 * mutation "caught" and prove nothing.
 *
 * Every mutation is applied through `scripts/lib/mutation-harness.mjs`: the
 * anchor must occur exactly once (else it aborts), the replacement carries the
 * residue marker, and the file is restored byte-identically (sha256-checked) in
 * a `finally`. Run `node scripts/scan-mutation-residue.mjs` afterwards.
 *
 * Usage:  node scripts/mutation-prove-standalone-bytecap.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/request-body-cap.cjs');
const NODE_SERVER = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/node-server.ts');
const STANDALONE_COMPILE = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/standalone-compile.mjs');
const SPEC = 'packages/kn-next/src/__tests__/request-body-cap.test.ts';

const MUTATIONS = [
  {
    label: 'the declared Content-Length refusal is removed (the handler runs on an oversized body)',
    file: PRELOAD,
    anchor: '  if (declared > cap) {',
    replacement: '  if (false) {',
    filter: 'declared Content-Length over the cap',
  },
  {
    label: 'bytes are no longer COUNTED (a chunked body with no length passes)',
    file: PRELOAD,
    anchor: '      if (seen > cap) {',
    replacement: '      if (false) {',
    filter: 'chunked body with NO Content-Length',
  },
  {
    label: 'off-by-one on the counted path (a body of exactly the cap is refused)',
    file: PRELOAD,
    anchor: '      if (seen > cap) {',
    replacement: '      if (seen >= cap) {',
    filter: 'EXACTLY the cap',
  },
  {
    label: 'off-by-one on the declared path (Content-Length == cap is refused)',
    file: PRELOAD,
    anchor: '  if (declared > cap) {',
    replacement: '  if (declared >= cap) {',
    filter: 'EXACTLY the cap',
  },
  {
    label: "the handler's body stream is not errored (partial processing / hang)",
    file: PRELOAD,
    anchor: "        if (typeof req.destroy === 'function') req.destroy(err);",
    replacement: '        void err;',
    filter: 'chunked body with NO Content-Length',
  },
  {
    label: 'the linger is removed (an uploading client gets a reset, not the 413)',
    file: PRELOAD,
    anchor: '    lingerThenClose(socket);',
    replacement: '    if (socket && !socket.destroyed) socket.destroy();',
    filter: 'still uploading when refused',
  },
  {
    label: 'the env override is never read (the knob is a lie)',
    file: PRELOAD,
    anchor: '  const raw = env[MAX_REQUEST_BYTES_ENV];',
    replacement: '  const raw = undefined;',
    filter: 'overrides the default in both directions',
  },
  {
    label: 'an INVALID value uncaps instead of keeping the default',
    file: PRELOAD,
    anchor: "      bytes: DEFAULT_MAX_REQUEST_BYTES,\n      source: 'invalid',",
    replacement: "      bytes: undefined,\n      source: 'invalid',",
    filter: 'invalid value keeps the default cap',
  },
  {
    label: 'the emit gate is bypassed entirely',
    file: PRELOAD,
    anchor: "    if (event === 'request' && req && res && !gateRequest(req, res, cap.bytes)) {",
    replacement: '    if (false) {',
    filter: 'one byte over the cap',
  },
  {
    label: 'node-server stops passing the preload to its child',
    file: NODE_SERVER,
    anchor: '    preloadArgs.push("--require", requestBodyCapPreload);',
    replacement: '    void requestBodyCapPreload;',
    filter: 'preloads it unconditionally',
  },
  {
    label: "the compiled standalone executable's preload list drops it",
    file: STANDALONE_COMPILE,
    anchor: ', "request-body-cap.cjs"];',
    replacement: '];',
    filter: 'embeds it in its preload list',
  },
];

declareMutations(MUTATIONS.length);

/** Run the spec filtered by `-t`; return the exit status (never the output). */
function runSpec(filter) {
  const r = spawnSync('bun', ['test', SPEC, '-t', filter], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 300_000,
  });
  if (r.error) throw r.error;
  return r.status;
}

console.log('Baseline: every filtered selection must be GREEN on the clean tree.');
for (const filter of new Set(MUTATIONS.map((m) => m.filter))) {
  const status = runSpec(filter);
  if (status !== 0) {
    console.error(`FATAL: baseline for -t ${JSON.stringify(filter)} exited ${status} — nothing here would prove anything`);
    process.exit(1);
  }
  console.log(`   ok baseline green: ${filter}`);
}

let pass = 0;
let fail = 0;
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(m.file);
  let status;
  try {
    mutate(snap, m.anchor, m.replacement);
    status = runSpec(m.filter);
  } finally {
    restore(snap);
  }
  if (status !== 0) {
    console.log(`   ok caught (exit ${status})`);
    pass += 1;
  } else {
    console.log('   x DECORATION: the guard stayed green with the control removed');
    fail += 1;
  }
  recordMutation();
}

console.log(`\n${pass}/${MUTATIONS.length} mutations caught, ${fail} decorative.`);
process.exit(fail === 0 ? 0 : 1);
