#!/usr/bin/env node
/**
 * compat-sharp-pin: in bun CREDENTIAL mode, pin the fixture install's sharp to
 * the exact version that has a committed musl lockfile (#1620 follow-up).
 *
 * WHY. Next pins sharp only as an optionalDependencies RANGE (^0.35.4 for
 * 16.3.5), so the harness installs whatever the registry's newest in-range
 * sharp is on the night. The bun lane rebuilds sharp for musl from committed
 * lockfiles only (credential mode refuses the non-reproducible fallback), so
 * a sharp patch published mid-window would turn every bun credential deploy
 * red, exactly as 16.3.5 did to rc.2. Pinning makes what is installed a
 * reviewed repo fact, not a registry fact.
 *
 * HOW. Reads NEXT_TEST_PKG_PATHS (the harness's JSON [[name, path]] map) and
 * prints it back with ["sharp", <locked version>] appended. The Next.js
 * harness (test/lib/create-next-install.js) turns every entry that is not a
 * direct fixture dependency into a workspace-root pnpm override, and uses it
 * as the version of a fixture that does depend on sharp directly, so the whole
 * fixture tree resolves that exact sharp (which itself pins its platform and
 * libvips packages exactly).
 *
 * The locked version is scripts/musl-native-lockfiles/next-sharp-resolution.json's
 * `sharp`. Before pinning it, this checks that committed lockfiles exist for
 * @img/sharp-linuxmusl-x64@<sharp> and for the libvips that lockfile pins,
 * matching the record, and exits non-zero otherwise, so credential mode can
 * never install a sharp without a committed lockfile.
 *
 * Early-warning and the node lane pass NEXT_TEST_PKG_PATHS through unchanged:
 * early-warning floats on purpose (it exists to warn), and the node lane never
 * runs the musl rebuild.
 *
 * Usage (env: KNEXT_COMPAT_MODE, KNEXT_RUNTIME, NEXT_TEST_PKG_PATHS):
 *   node scripts/compat-sharp-pin.mjs [--repo-root <knext checkout>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(msg) {
  console.error(`::error::[compat-sharp-pin] ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--repo-root');
const repoRoot =
  rootIdx >= 0 && argv[rootIdx + 1]
    ? resolve(argv[rootIdx + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pkgPaths;
try {
  pkgPaths = JSON.parse(process.env.NEXT_TEST_PKG_PATHS ?? '');
} catch {
  fail('NEXT_TEST_PKG_PATHS is not valid JSON');
}
if (!Array.isArray(pkgPaths) || !pkgPaths.every((e) => Array.isArray(e) && e.length === 2)) {
  fail('NEXT_TEST_PKG_PATHS must be a JSON array of [name, path] pairs');
}

const pinning =
  process.env.KNEXT_COMPAT_MODE === 'credential' && process.env.KNEXT_RUNTIME === 'bun';
if (!pinning) {
  process.stdout.write(`${JSON.stringify(pkgPaths)}\n`);
  process.exit(0);
}

if (pkgPaths.some(([name]) => name === 'sharp')) {
  fail('NEXT_TEST_PKG_PATHS already names sharp; refusing to silently replace it');
}

const lockDir = join(repoRoot, 'scripts', 'musl-native-lockfiles');
let record;
try {
  record = JSON.parse(readFileSync(join(lockDir, 'next-sharp-resolution.json'), 'utf8'));
} catch (e) {
  fail(`cannot read next-sharp-resolution.json: ${e.message}`);
}
const { sharp, libvips } = record;
if (!/^\d+\.\d+\.\d+$/.test(String(sharp)) || !/^\d+\.\d+\.\d+$/.test(String(libvips))) {
  fail(
    `next-sharp-resolution.json must record exact sharp/libvips versions (got ${sharp} / ${libvips})`,
  );
}

/** The committed lockfile's pinned entry for <name>, or fail naming the missing dir. */
function locked(key, name) {
  const dir = join(lockDir, key);
  if (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'package-lock.json'))) {
    fail(
      `no committed lockfile at scripts/musl-native-lockfiles/${key}/; credential mode will not install a sharp the bun lane cannot rebuild reproducibly. Add it with scripts/generate-musl-native-lockfile.sh`,
    );
  }
  const entry = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages?.[
    `node_modules/${name}`
  ];
  if (!entry) fail(`scripts/musl-native-lockfiles/${key}/package-lock.json has no ${name} entry`);
  return entry;
}

const sharpEntry = locked(`img-sharp-linuxmusl-x64-${sharp}`, '@img/sharp-linuxmusl-x64');
if (sharpEntry.version !== sharp) {
  fail(`img-sharp-linuxmusl-x64-${sharp} locks ${sharpEntry.version}, not ${sharp}`);
}
const needs = sharpEntry.optionalDependencies?.['@img/sharp-libvips-linuxmusl-x64'];
if (needs !== libvips) {
  fail(`sharp ${sharp} pins libvips ${needs}, but next-sharp-resolution.json records ${libvips}`);
}
const vipsEntry = locked(
  `img-sharp-libvips-linuxmusl-x64-${libvips}`,
  '@img/sharp-libvips-linuxmusl-x64',
);
if (vipsEntry.version !== libvips) {
  fail(`img-sharp-libvips-linuxmusl-x64-${libvips} locks ${vipsEntry.version}, not ${libvips}`);
}

console.error(
  `[compat-sharp-pin] bun credential: pinning the fixture install to sharp@${sharp} (libvips ${libvips}), both with committed musl lockfiles`,
);
process.stdout.write(`${JSON.stringify([...pkgPaths, ['sharp', sharp]])}\n`);
