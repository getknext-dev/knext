#!/usr/bin/env bun
/**
 * Build file-manager's SELF-CONTAINED vinext binary for the host (#1460): the
 * same compile `kn-next build --self-contained` runs, from this checkout's
 * source, so the e2e round can boot it from an empty directory.
 *
 *   bun scripts/build-self-contained.mjs [--skip-vite] [--out <path>]
 *
 * Stages sharp's native packages from nitro's traced `.output/server/
 * node_modules/@img` into `native/` (the host's platform — this is a local /
 * CI-host binary, not an image), then compiles with `--self-contained 1`.
 * Prints the binary's path on the last line.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
