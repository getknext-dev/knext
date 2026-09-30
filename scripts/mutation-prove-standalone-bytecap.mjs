#!/usr/bin/env node
/**
 * Mutation proof for the standalone-build request-body cap (ADR-0044
 * Amendment 6): `packages/kn-next/src/adapters/request-body-cap.cjs` and its
 * wiring into every standalone launch path.
 *
 * Each mutation plants one way the control could ship green and unenforced; the
 * guarding spec (`request-body-cap.test.ts`, which boots real child servers
 * under Node AND Bun and drives them over raw sockets) must go RED. The shared
 * driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts on the
 * runner's exit code only, a green baseline first, a canary that proves the
 * harness can see red, anchors asserted exactly once, byte-exact restores and a
 * clean tree between mutations. Run `node scripts/scan-mutation-residue.mjs`
 * afterwards.
 *
 * Usage:  node scripts/mutation-prove-standalone-bytecap.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/request-body-cap.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim: 'the declared Content-Length refusal is removed — the handler runs on an oversized body',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '  if (declared > cap) {',
    replacement: '  if (false) {',
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'bytes are no longer COUNTED — a chunked body with no length passes',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '      if (seen > cap) {',
    replacement: '      if (false) {',
  },
  {
    id: 'M3',
    expect: 'red',
    claim: 'off-by-one on the counted path — a body of exactly the cap is refused',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '      if (seen > cap) {',
    replacement: '      if (seen >= cap) {',
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'off-by-one on the declared path — Content-Length equal to the cap is refused',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '  if (declared > cap) {',
    replacement: '  if (declared >= cap) {',
  },
  {
    id: 'M5',
    expect: 'red',
    claim: "the handler's body stream is not errored — partial processing (or a hang)",
    subject: 'preload',
    validate: jsStillParses,
    anchor: "        if (typeof req.destroy === 'function') req.destroy(err);",
    replacement: '        void err;',
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'the linger is removed — a still-uploading client gets a connection reset',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '    holdTeardown(socket, res);',
    replacement: '    if (socket && !socket.destroyed) socket.destroy();',
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'the env override is never read — the knob is a lie',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '  const raw = env[MAX_REQUEST_BYTES_ENV];',
    replacement: '  const raw = undefined;',
  },
  {
    id: 'M8',
    expect: 'red',
    claim: 'an INVALID value uncaps instead of keeping the default',
    subject: 'preload',
    validate: jsStillParses,
    anchor: "      bytes: DEFAULT_MAX_REQUEST_BYTES,\n      source: 'invalid',",
    replacement: "      bytes: undefined,\n      source: 'invalid',",
  },
  {
    id: 'M9',
    expect: 'red',
    claim: 'node-server stops passing the preload to its child (node AND uncompiled bun)',
    subject: 'nodeServer',
    anchor: '    preloadArgs.push("--require", requestBodyCapPreload);',
    replacement: '    void requestBodyCapPreload;',
  },
  {
    id: 'M10',
    expect: 'red',
    claim: "the compiled standalone executable's preload list drops it",
    subject: 'standaloneCompile',
    validate: jsStillParses,
    anchor: ', "request-body-cap.cjs"];',
    replacement: '];',
  },
  {
    id: 'M11',
    expect: 'red',
    claim:
      'the cap error is forwarded to a body stream nothing listens on — an unhandled error event exits the process',
    subject: 'preload',
    validate: jsStillParses,
    anchor:
      "          process.nextTick(() => callback(this.listenerCount('error') > 0 ? error : null));",
    replacement: '          callback(error);',
  },
  {
    id: 'M12',
    expect: 'red',
    claim:
      'the linger is armed at refusal time, not when the 413 is written — a slow pipelined earlier response is lost',
    subject: 'preload',
    validate: jsStillParses,
    anchor: "  if (typeof res.once === 'function') res.once('finish', () => armLinger(socket));",
    replacement: '  armLinger(socket);',
  },
  {
    id: 'M13',
    expect: 'red',
    claim:
      'the discard byte bound is removed — a refused client streams unbounded bytes while an earlier response is pending',
    subject: 'preload',
    validate: jsStillParses,
    anchor: '  if (state.discarded > LINGER_MAX_BYTES) socket.destroy();',
    replacement: '  void LINGER_MAX_BYTES;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    preload: 'packages/kn-next/src/adapters/request-body-cap.cjs',
    nodeServer: 'packages/kn-next/src/adapters/node-server.ts',
    standaloneCompile: 'packages/kn-next/src/adapters/standalone-compile.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (ADR-0044 Amendment 6) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

// The canary bypasses the gate entirely, so every behavioural case must fall.
prover.proveCanSeeRed({
  subject: 'preload',
  anchor: "    if (event === 'request' && req && res && !gateRequest(req, res, cap.bytes)) {",
  replacement: '    if (false) {',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
