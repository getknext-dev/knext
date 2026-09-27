#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
/**
 * Build file-manager's SELF-CONTAINED vinext binary for the host (#1460): the
 * same compile `kn-next build --self-contained` runs, from this checkout's
 * source, so the e2e round can boot it from an empty directory.
 *
 *   bun scripts/build-self-contained.mjs [--skip-vite] [--out <path>]
 *
 * Stages sharp's native packages from nitro's traced `.output/server/
 * node_modules/@img` into `native/` (the host's platform — this is a local /
 * CI-host binary, not an image), writes `native/.integrity.json` (the SAME
 * bytes-pinning half of `native-integrity.ts`'s manifest schema that
 * `stageSharpNative` writes for a shipped image — see NATIVE_INTEGRITY_SCHEMA_VERSION
 * there), then compiles with `--self-contained 1`, which embeds the manifest
 * alongside the native tree. Without it, `sharp-addon-dlopen.mjs`'s dlopen
 * shim finds no manifest beside the extracted tree at runtime and loads it
 * UNVERIFIED (round-1 review of #1496 round 2). This script deliberately
 * skips the lockfile-provenance half (`writeNativeIntegrityManifest`'s
 * `packages` cross-check against `bun.lock`) — it is a CI/local host-build
 * helper for the e2e round, not the shipped `kn-next build` path that owns
 * that supply-chain claim.
 * Prints the binary's path on the last line.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match NATIVE_INTEGRITY_SCHEMA_VERSION in
// packages/kn-next/src/cli/native-integrity.ts and
// packages/kn-next/src/adapters/sharp-addon-dlopen.mjs — the dlopen shim
// refuses a manifest at any other version rather than trust its shape.
const NATIVE_INTEGRITY_SCHEMA_VERSION = 1;

/** Every file under `dir`, recursively, as absolute paths. */
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Writes `<nativeDir>/.integrity.json` — a sha256 per staged file, the same
 * bytes-pinning claim `native-integrity.ts` makes for a shipped image, so the
 * dlopen shim verifies the tree instead of loading it UNVERIFIED.
 */
function writeIntegrityManifest(nativeDir) {
  const files = {};
  for (const abs of walkFiles(nativeDir)) {
    const rel = relative(nativeDir, abs).split(sep).join('/');
    files[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  const manifest = {
    version: NATIVE_INTEGRITY_SCHEMA_VERSION,
    algorithm: 'sha256',
    packages: {},
    files,
  };
  writeFileSync(join(nativeDir, '.integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPILE = resolve(APP, '../../packages/kn-next/src/adapters/vinext-compile.mjs');
const argv = process.argv.slice(2);
const out = resolve(
  argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(APP, 'knext-exec-self-contained'),
);

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: APP, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`[build-self-contained] ${cmd} ${args.join(' ')} exited ${r.status}`);
    process.exit(1);
  }
}

if (!argv.includes('--skip-vite'))
  run('npx', ['--no-install', 'vite', 'build'], { NODE_ENV: 'production' });

const img = join(APP, '.output/server/node_modules/@img');
if (!existsSync(img)) {
  console.error(`[build-self-contained] no ${img} — nitro traced no sharp native packages`);
  process.exit(1);
}
const native = join(APP, 'native');
rmSync(native, { recursive: true, force: true });
mkdirSync(native, { recursive: true });
for (const pkg of readdirSync(img))
  cpSync(join(img, pkg), join(native, pkg), { recursive: true, dereference: true });
writeIntegrityManifest(native);

run(process.execPath, [
  COMPILE,
  '--entry',
  '.output/server/index.mjs',
  '--outfile',
  out,
  '--self-contained',
  '1',
  '--native-dir',
  'native',
]);
console.log(out);
