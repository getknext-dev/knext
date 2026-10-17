#!/usr/bin/env bun
/**
 * `bun build.ts <out-dir>` — build the e2e zone's image context.
 *
 * Stages a zone the way a user's app would have one, then runs the REAL
 * generator over the Go function template's contract:
 *
 *   proto/                  <- templates/go/proto  (the contract the function serves)
 *   knext.grpc.json         <- the `example` function
 *   src/knext/authorize.ts  <- ./authorize.ts
 *   src/generated/grpc/     <- `knext generate` (buf lint + protoc-gen-es + the knext plugins)
 *
 * and bundles ./server.ts with the generated glue and the real runtime into one
 * ESM file, with stand-ins only for `next/cache` and `server-only`. The out
 * directory is a Docker build context: Dockerfile + zone-caller.mjs.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const PKG_DIR = resolve(HERE, '..', '..', '..');
const REPO = resolve(PKG_DIR, '..', '..');
const CLI = join(PKG_DIR, 'scripts', 'knext-grpc.ts');

const out = process.argv[2];
if (!out) {
  console.error('usage: bun build.ts <out-dir>');
  process.exit(64);
}

const zone = mkdtempSync(join(tmpdir(), 'knext-z7-zone-'));
try {
  cpSync(join(REPO, 'templates', 'go', 'proto'), join(zone, 'proto'), { recursive: true });
  writeFileSync(
    join(zone, 'buf.yaml'),
    'version: v2\nmodules:\n  - path: proto\nlint:\n  use:\n    - STANDARD\n',
  );
  writeFileSync(
    join(zone, 'knext.grpc.json'),
    `${JSON.stringify(
      {
        proto: 'proto',
        out: 'src/generated/grpc',
        deadlineMs: 10000,
        gatewayTimeoutSeconds: 300,
        authorize: 'src/knext/authorize.ts',
        functions: { example: { lang: 'go' } },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(zone, 'src', 'knext'), { recursive: true });
  cpSync(join(HERE, 'authorize.ts'), join(zone, 'src', 'knext', 'authorize.ts'));
  cpSync(join(HERE, 'context.ts'), join(zone, 'src', 'knext', 'context.ts'));
  cpSync(join(HERE, 'server.ts'), join(zone, 'src', 'server.ts'));

  const gen = spawnSync('bun', [CLI, 'generate'], { cwd: zone, stdio: 'inherit' });
  if (gen.status !== 0) throw new Error(`knext generate exited ${gen.status}`);

  // The stand-ins sit beside the bundle input, not in the zone's source tree.
  const stubs = join(zone, 'stubs');
  mkdirSync(stubs);
  writeFileSync(
    join(stubs, 'next-cache.mjs'),
    'export const cacheLife = () => {}; export const cacheTag = () => {}; export const updateTag = () => {};',
  );
  writeFileSync(join(stubs, 'server-only.mjs'), 'export {};');

  mkdirSync(out, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(zone, 'src', 'server.ts')],
    target: 'node',
    format: 'esm',
    outdir: out,
    naming: 'zone-caller.mjs',
    plugins: [
      {
        name: 'zone-caller-resolve',
        setup(build) {
          build.onResolve({ filter: /^next\/cache$/ }, () => ({
            path: join(stubs, 'next-cache.mjs'),
          }));
          build.onResolve({ filter: /^server-only$/ }, () => ({
            path: join(stubs, 'server-only.mjs'),
          }));
          // The runtime the generated glue imports, from source (no package build).
          build.onResolve({ filter: /^@getknext\/grpc\/runtime$/ }, () => ({
            path: join(PKG_DIR, 'src', 'runtime.ts'),
          }));
          // The zone has no node_modules: resolve the Connect / protobuf packages
          // from the grpc package, whose dependencies they are.
          build.onResolve({ filter: /^@(connectrpc|bufbuild)\// }, (args) => ({
            path: Bun.resolveSync(args.path, PKG_DIR),
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  cpSync(join(HERE, 'Dockerfile'), join(out, 'Dockerfile'));
  console.log(`zone-caller image context written to ${out}`);
} finally {
  rmSync(zone, { recursive: true, force: true });
}
