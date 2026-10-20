#!/usr/bin/env node
/**
 * Mutation proof for the image half of Pod Security `restricted` (issue #2530):
 * every image the operator runs must name a numeric, non-zero USER.
 *
 * The operator renders `runAsNonRoot: true` on the serving container. The kubelet
 * refuses to start a container whose image has no USER (root) or a USER that is a
 * name (`USER node`), because it cannot verify a name is non-root. That surfaces
 * at pod start in a cluster, so the guard is the place a shipped Dockerfile that
 * would be refused is caught.
 *
 * Guard proved: tests/dockerfile-numeric-nonroot-user.test.ts. Each row breaks one
 * shipped image (a named user, root, or no USER at all, in each of the Dockerfile
 * families: the app templates, the standalone runtime's three stages, the Go and
 * Rust function templates, the examples, the test harness image) or breaks the
 * checker itself (a root uid classed as fine, a named user classed as fine).
 *
 * The operator half (the four rendered fields, the opt-out, Knative's webhook) is
 * proved by rows H01-H15 in scripts/mutation-prove-2052-backendservice.mjs.
 *
 * Discipline (see scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a CANARY must go red before any green below is
 * trusted, and the tree is checked clean between mutations. Run it on a COMMITTED
 * tree: a dirty tree aborts the baseline.
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-2530-dockerfile-user.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/dockerfile-numeric-nonroot-user.test.ts';

// A mutation that rewrites a line must not leave a residue marker where a
// Dockerfile cannot take one: '#' starts a comment in a Dockerfile, so it is safe.
const DOCKER = { commentPrefix: '#' };
const TS_INLINE = { commentPrefix: '/*' };

const SUBJECTS = {
  fileManager: resolve(REPO_ROOT, 'apps/file-manager/Dockerfile'),
  docs: resolve(REPO_ROOT, 'apps/docs/Dockerfile'),
  bunExec: resolve(REPO_ROOT, 'examples/bun-exec/Dockerfile'),
  bunExecNode: resolve(REPO_ROOT, 'examples/bun-exec/Dockerfile.node'),
  goTemplate: resolve(REPO_ROOT, 'templates/go/Dockerfile'),
  rustTemplate: resolve(REPO_ROOT, 'templates/rust/Dockerfile'),
  appHbs: resolve(REPO_ROOT, 'packages/kn-next/templates/app/Dockerfile.hbs'),
  selfContainedHbs: resolve(
    REPO_ROOT,
    'packages/kn-next/templates/app/Dockerfile.self-contained.hbs',
  ),
  vinextNodeHbs: resolve(REPO_ROOT, 'packages/kn-next/templates/app/Dockerfile.vinext-node.hbs'),
  standaloneHbs: resolve(
    REPO_ROOT,
    'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
  ),
  zoneCaller: resolve(REPO_ROOT, 'packages/grpc/e2e/z7-identity-kind/zone-caller/Dockerfile'),
  szpgDemo: resolve(REPO_ROOT, 'packages/scale-zero-pg/demo/app/Dockerfile'),
  spec: resolve(REPO_ROOT, 'tests/dockerfile-numeric-nonroot-user.test.ts'),
};

const MUTATIONS = [
  {
    id: 'U01',
    subject: 'fileManager',
    claim: 'the reference app image runs as a named user',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER node\n',
    options: DOCKER,
  },
  {
    id: 'U02',
    subject: 'docs',
    claim: 'the docs site image runs as root',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER root\n',
    options: DOCKER,
  },
  {
    id: 'U03',
    subject: 'bunExec',
    claim: 'the bun single-executable example image runs as uid 0',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER 0:0\n',
    options: DOCKER,
  },
  {
    id: 'U04',
    subject: 'bunExecNode',
    claim: 'the node example image goes back to the named user `node`',
    anchor: 'USER 1000:1000\n',
    replacement: 'USER node\n',
    options: DOCKER,
  },
  {
    id: 'U05',
    subject: 'goTemplate',
    claim: 'the Go function template runs as root',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER root\n',
    options: DOCKER,
  },
  {
    id: 'U06',
    subject: 'rustTemplate',
    claim: 'the Rust function template has no USER at all (distroless:nonroot is not relied on)',
    anchor: 'USER 65532:65532\n',
    replacement: '\n',
    options: DOCKER,
  },
  {
    id: 'U07',
    subject: 'appHbs',
    claim: 'the scaffolded app image runs as a named user',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER nonroot\n',
    options: DOCKER,
  },
  {
    id: 'U08',
    subject: 'selfContainedHbs',
    claim: 'the self-contained app image has no USER',
    anchor: 'USER 65532:65532\n',
    replacement: '\n',
    options: DOCKER,
  },
  {
    id: 'U09',
    subject: 'vinextNodeHbs',
    claim: 'the vinext node app image runs as root',
    anchor: 'USER 65532:65532\n',
    replacement: 'USER 0\n',
    options: DOCKER,
  },
  {
    id: 'U10',
    subject: 'standaloneHbs',
    claim: 'the standalone bun runtime stage runs as a named user',
    anchor: 'COPY knext-standalone-entry.mjs /app/server.js\n\nUSER 65532:65532\n',
    replacement: 'COPY knext-standalone-entry.mjs /app/server.js\n\nUSER node\n',
    options: DOCKER,
  },
  {
    id: 'U11',
    subject: 'standaloneHbs',
    claim: 'the standalone self-contained stage has no USER (one stage of three loses it)',
    anchor: 'COPY knext-self-contained-server-shim.js /app/server.js\n\nUSER 65532:65532\n',
    replacement: 'COPY knext-self-contained-server-shim.js /app/server.js\n\n',
    options: DOCKER,
  },
  {
    id: 'U12',
    subject: 'standaloneHbs',
    claim: 'the standalone node runtime stage runs as root',
    anchor: '&& chown 65532:65532 /app/.next/standalone/.next/compile-cache\n\nUSER 65532:65532\n',
    replacement: '&& chown 65532:65532 /app/.next/standalone/.next/compile-cache\n\nUSER root\n',
    options: DOCKER,
  },
  {
    id: 'U13',
    subject: 'zoneCaller',
    claim: 'the e2e zone image goes back to the named user `node`',
    anchor: 'USER 1000:1000\n',
    replacement: 'USER node\n',
    options: DOCKER,
  },
  {
    id: 'U14',
    subject: 'szpgDemo',
    claim: 'the scale-to-zero database demo app goes back to the named user `node`',
    anchor: 'USER 1000:1000\n',
    replacement: 'USER node\n',
    options: DOCKER,
  },
  {
    id: 'U15',
    subject: 'spec',
    claim: 'the checker treats uid 0 as acceptable',
    anchor: "return Number(m[1]) > 0 ? 'ok' : 'root';",
    replacement: "return 'ok';",
    options: TS_INLINE,
  },
  {
    id: 'U16',
    subject: 'spec',
    claim: 'the checker treats a named user as acceptable',
    anchor: "if (!m) return 'named';",
    replacement: "if (!m) return 'ok';",
    options: TS_INLINE,
  },
];

// The canary: a real mutation of a real subject. If this stays green the harness
// cannot see red and nothing below means anything.
const CANARY = {
  subject: 'fileManager',
  anchor: 'USER 65532:65532\n',
  replacement: 'USER node\n',
  options: DOCKER,
};

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2530-dockerfile-user: ${MUTATIONS.length} mutations declared`);

const prover = createGuardProver({ repoRoot: REPO_ROOT, spec: SPEC, subjects: SUBJECTS });
prover.preflight(MUTATIONS);
prover.baseline();
prover.proveCanSeeRed(CANARY);

for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
