#!/usr/bin/env node
/**
 * Mutation proof for the Z7 kind e2e (run.sh): break ONE rule in the operator
 * and the lane must go red, for the reason the rule exists.
 *
 * A guard that stays green when the behaviour it protects is removed is
 * decoration. The lane's assertions cannot be mutated from inside the lane, so
 * this mutates the operator's source (the rows are in mutation-rows.mjs), builds
 * that operator, runs it on the kind cluster, and runs the phases that should
 * notice:
 *
 *   M1 bound-ignored           signing switches in the same pass that publishes
 *                              the new key (the propagation bound is not waited)
 *   M2 staged-key-unpublished  the JWKS never lists the staged key
 *   M3 no-overlap              the previous key is retired the moment it is stamped
 *   M4 staged-key-projected    the zone's key volume also projects next.*
 *   M5 jwks-subpath            a function mounts the JWKS through a subPath
 *   M6 key-in-operator-log     the operator logs the private key it stores
 *
 * A row is KILLED only when run.sh exits non-zero AND its output names the
 * expected reason: a red for another reason (a flake, an unready pod) is not a
 * kill, and is reported as such. The tree is restored byte-for-byte after every
 * row (scripts/lib/mutation-harness.mjs), and a final CONTROL runs the unmutated
 * operator through every phase and must pass: a row is only evidence if it does.
 *
 * Needs a cluster with the lane's `up` and `images` phases done:
 *   PHASES="up images" packages/grpc/e2e/z7-identity-kind/run.sh
 * Slow (each row builds an operator image and runs deploy and the phase under
 * test, 10 to 15 minutes), so it is run by hand, and deliberately not in
 * scripts/ where the nightly prover lane would discover it. The rows' anchors and
 * reasons are checked without a cluster by tests/z7-identity-kind-e2e-lane.test.ts.
 *
 * Exit 0 = every row killed for its reason and the control passed; 1 = a row
 * survived or went red for another reason, or the control failed; 2 = the prover
 * could not run.
 *
 * Usage:
 *   node packages/grpc/e2e/z7-identity-kind/mutation-prove.mjs [M1 M3 ...]
 *   Z7_KEEP_LOGS=1 keeps each row's log (object status and log tails, never a key).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutate, restore, snapshot } from '../../../../scripts/lib/mutation-harness.mjs';
import { ROWS } from './mutation-rows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const OPERATOR = join(REPO, 'packages/kn-next-operator');
const CLUSTER = process.env.KIND_CLUSTER ?? 'knext-z7-e2e';
const BUILD_IMG = 'example.com/kn-next-operator:z7-build';
const OPERATOR_NS = 'kn-next-operator-system';
const DEPLOY = 'deployment/kn-next-operator-controller-manager';

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function die(msg) {
  console.error(`mutation-prove: ${msg}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'knext-z7-mutation-'));
const kubeconfig = join(work, 'kubeconfig');
const kc = sh('kind', ['get', 'kubeconfig', '--name', CLUSTER]);
if (kc.status !== 0) die(`no kind cluster ${CLUSTER}; run run.sh with PHASES="up images" first`);
writeFileSync(kubeconfig, kc.stdout, { mode: 0o600 });

/**
 * Build the operator from the current tree, tag it by its image id (the same tag
 * with new bytes would not roll the Deployment), load it into kind and roll it.
 */
function installOperator(log) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const run = (cmd, args, opts = {}) => {
    const r = sh(cmd, args, opts);
    appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n${r.stdout}${r.stderr}\n`);
    if (r.status !== 0) die(`${cmd} ${args.slice(0, 3).join(' ')} failed (see ${log})`);
    return r.stdout;
  };
  run('make', ['-C', OPERATOR, 'docker-build', `IMG=${BUILD_IMG}`]);
  const id = run('docker', ['image', 'inspect', '--format', '{{.Id}}', BUILD_IMG])
    .trim()
    .replace(/^sha256:/, '')
    .slice(0, 12);
  const img = `example.com/kn-next-operator:z7-${id}`;
  run('docker', ['tag', BUILD_IMG, img]);
  run('kind', ['load', 'docker-image', img, '--name', CLUSTER]);
  run('kubectl', ['-n', OPERATOR_NS, 'set', 'image', DEPLOY, `manager=${img}`], { env });
  run('kubectl', ['-n', OPERATOR_NS, 'rollout', 'status', DEPLOY, '--timeout=240s'], { env });
}

function runLane(phases, log) {
  const r = sh(join(HERE, 'run.sh'), [], { env: { ...process.env, PHASES: phases } });
  const text = `${r.stdout}\n${r.stderr}`;
  writeFileSync(log, text);
  return { status: r.status, text };
}

const wanted = process.argv.slice(2);
const rows = wanted.length ? ROWS.filter((r) => wanted.includes(r.id)) : ROWS;
if (rows.length === 0) die(`no row matches ${wanted.join(' ')}`);

try {
  const results = [];
  for (const row of rows) {
    const log = join(work, `${row.id}.log`);
    const snap = snapshot(join(REPO, row.file));
    let outcome;
    try {
      mutate(snap, row.anchor, row.replacement);
      installOperator(log);
      outcome = runLane(row.phases, log);
    } finally {
      restore(snap);
    }
    const red = outcome.status !== 0;
    const forReason = outcome.text.includes(row.reason);
    const verdict = red && forReason ? 'KILLED' : red ? 'RED-FOR-ANOTHER-REASON' : 'SURVIVED';
    results.push(verdict);
    console.log(`${row.id} ${row.name}: ${verdict} (run.sh exit ${outcome.status}; log ${log})`);
    if (verdict !== 'KILLED') {
      const lines = outcome.text.split('\n').filter((l) => /^(FAIL|==)/.test(l));
      console.log(`  ${lines.slice(-4).join('\n  ')}`);
    }
  }

  // The control: the unmutated operator, rebuilt from the restored tree, through
  // every phase the rows used. A row is only evidence if this passes.
  const controlLog = join(work, 'control.log');
  installOperator(controlLog);
  const control = runLane('deploy verify rotate leaks', controlLog);
  console.log(`CONTROL (unmutated operator, deploy verify rotate leaks): exit ${control.status}`);
  const killed = results.filter((v) => v === 'KILLED').length;
  console.log(`${killed}/${results.length} rows killed for their reason`);
  process.exitCode = killed === results.length && control.status === 0 ? 0 : 1;
} finally {
  if (process.env.Z7_KEEP_LOGS) console.log(`logs kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
