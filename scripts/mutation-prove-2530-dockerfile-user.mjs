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
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/dockerfile-numeric-nonroot-user.test.ts';

// A mutation that rewrites a line must not leave a residue marker where a
// Dockerfile cannot take one: '#' starts a comment in a Dockerfile, so it is safe.
const DOCKER = { commentPrefix: '#' };
const TS_INLINE = { commentPrefix: '/*' };

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

  // ---- scan 2: Dockerfiles written inline by scripts
  {
    id: 'V01',
    subject: 'drill',
    claim: 'the network policy drill image drops its USER line (it would run as root)',
    anchor: 'COPY h2cecho /h2cecho\\nUSER 65532:65532\\nENTRYPOINT',
    replacement: `COPY h2cecho /h2cecho\\n# ${MUTATION_MARKER}\\nENTRYPOINT`,
  },
  {
    id: 'V02',
    subject: 'drill',
    claim: 'the network policy drill image runs as a named user',
    anchor: 'USER 65532:65532\\nENTRYPOINT ["/h2cecho"]',
    replacement: `USER nobody\\n# ${MUTATION_MARKER}\\nENTRYPOINT ["/h2cecho"]`,
  },
  {
    id: 'V03',
    subject: 'spec',
    claim: 'the scan stops looking at printf and echo Dockerfiles',
    anchor: 'if (!/(printf|echo)\\b/.test(l) || !FROM_IMAGE.test(l)) continue;',
    replacement: 'continue;',
    options: TS_INLINE,
  },
  {
    id: 'V04',
    subject: 'spec',
    claim: 'the scan stops looking at heredoc Dockerfiles',
    anchor: 'if (!h) continue;',
    replacement: 'continue;',
    options: TS_INLINE,
  },
  // ---- scan 1: the stage logic and the file discovery
  {
    id: 'V05',
    subject: 'spec',
    claim: 'a stage no longer inherits the USER of the stage it builds on',
    anchor: "cur = stages.find((s) => s.name !== '' && s.name === cur?.from.toLowerCase());",
    replacement: 'cur = undefined;',
    options: TS_INLINE,
  },
  {
    id: 'V06',
    subject: 'spec',
    claim: 'a builder stage that is only copied from is judged like a runnable one',
    anchor: "return stages.filter((s) => s.name === '' || !referenced.has(s.name));",
    replacement: 'return stages;',
    options: TS_INLINE,
  },
  {
    id: 'V07',
    subject: 'spec',
    claim: 'the file discovery no longer recognises `<name>.Dockerfile` files',
    anchor: '|| /\\.(Dockerfile|Containerfile)$/.test(base)',
    replacement: '|| false',
    options: TS_INLINE,
  },
  // ---- scan 3: the images the lanes deploy
  {
    id: 'V08',
    subject: 'rollback',
    claim: 'the rollback lane deploys the root sample image but no longer opts out',
    anchor: '  security:\n    runAsNonRoot: false\n',
    replacement: `  # ${MUTATION_MARKER}\n`,
  },
  {
    id: 'V09',
    subject: 'platform',
    claim: 'the platform lane goes back to the root sample image without opting out',
    anchor:
      'pfAppImage = "docker.io/mendhak/http-https-echo@sha256:" +\n\t\t"a265f55c86cb3baead76fdf379dc8e9e6440ed121874e101e60b833e05bce8d4"',
    replacement: `// ${MUTATION_MARKER}\n\tpfAppImage = "ghcr.io/knative/helloworld-go@sha256:" +\n\t\t"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"`,
  },
  {
    id: 'V10',
    subject: 'assetGc',
    claim: 'the asset GC lane goes back to the root sample image without opting out',
    anchor:
      'gcAppImage = "quay.io/openshift/origin-hello-openshift@sha256:" +\n\t\t"3d2cc2be080ec48a5a1a2cc1d0a762b944665212591e271a5ed6a481f885b1e3"',
    replacement: `// ${MUTATION_MARKER}\n\tgcAppImage = "ghcr.io/knative/helloworld-go@sha256:" +\n\t\t"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"`,
  },
  {
    id: 'V11',
    subject: 'upgrade',
    claim: 'the upgrade e2e goes back to the root sample image',
    anchor:
      'quay.io/openshift/origin-hello-openshift@sha256:3d2cc2be080ec48a5a1a2cc1d0a762b944665212591e271a5ed6a481f885b1e3',
    replacement:
      'ghcr.io/knative/helloworld-go@sha256:c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba',
  },
  {
    id: 'V12',
    subject: 'bundleNightly',
    claim: 'the published-bundle nightly goes back to the root sample image',
    anchor:
      'quay.io/openshift/origin-hello-openshift@sha256:3d2cc2be080ec48a5a1a2cc1d0a762b944665212591e271a5ed6a481f885b1e3',
    replacement:
      'ghcr.io/knative/helloworld-go@sha256:c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba',
  },
  {
    id: 'V13',
    subject: 'spec',
    claim: 'the table records the verified non-root image as uid 0',
    anchor: "user: '1001',",
    replacement: "user: '0',",
    options: TS_INLINE,
  },
  {
    id: 'V14',
    subject: 'spec',
    claim: 'the deploying-file scan finds nothing',
    anchor: 'const DEPLOYING_FILES = DEPLOYERS.filter((f) => deploysApp(read(f)));',
    replacement: 'const DEPLOYING_FILES = DEPLOYERS.filter(() => false);',
    options: TS_INLINE,
  },
  {
    id: 'V15',
    subject: 'spec',
    claim: 'an image nobody classified is accepted as infrastructure',
    anchor: '  return undefined;\n}\n\nconst DEPLOYERS',
    replacement: `  // ${MUTATION_MARKER}\n  return { kind: 'infra', note: 'x' };\n}\n\nconst DEPLOYERS`,
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

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    fileManager: 'apps/file-manager/Dockerfile',
    docs: 'apps/docs/Dockerfile',
    bunExec: 'examples/bun-exec/Dockerfile',
    bunExecNode: 'examples/bun-exec/Dockerfile.node',
    goTemplate: 'templates/go/Dockerfile',
    rustTemplate: 'templates/rust/Dockerfile',
    appHbs: 'packages/kn-next/templates/app/Dockerfile.hbs',
    selfContainedHbs: 'packages/kn-next/templates/app/Dockerfile.self-contained.hbs',
    vinextNodeHbs: 'packages/kn-next/templates/app/Dockerfile.vinext-node.hbs',
    standaloneHbs: 'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
    zoneCaller: 'packages/grpc/e2e/z7-identity-kind/zone-caller/Dockerfile',
    szpgDemo: 'packages/scale-zero-pg/demo/app/Dockerfile',
    spec: 'tests/dockerfile-numeric-nonroot-user.test.ts',
    drill: 'packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh',
    rollback: 'packages/kn-next-operator/test/e2e/rollback_e2e_test.go',
    platform: 'packages/kn-next-operator/test/e2e/platform_e2e_test.go',
    assetGc: 'packages/kn-next-operator/test/e2e/asset_gc_e2e_test.go',
    upgrade: 'scripts/upgrade-e2e/run.sh',
    bundleNightly: '.github/workflows/published-bundle-kind-nightly.yml',
  },
});
prover.preflight(MUTATIONS);
prover.baseline();
prover.proveCanSeeRed(CANARY);

for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
