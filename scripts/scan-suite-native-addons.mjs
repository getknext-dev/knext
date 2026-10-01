#!/usr/bin/env node
/**
 * scripts/scan-suite-native-addons.mjs — lists the native-addon candidates a
 * vercel/next.js deploy-tests suite declares, so
 * scripts/musl-native-lockfiles/suite-native-addons.json can be re-derived on a
 * Next.js bump instead of discovered on a red bun credential night (#1759).
 *
 * REAL-NETWORK, CONTRIBUTOR-RUN, NOT CI-RUN (same contract as
 * scripts/generate-musl-native-lockfile.sh): it reads a local checkout of the
 * Next.js tag and asks the npm registry how each declared dependency resolves.
 * CI only consumes the committed record it helps produce.
 *
 * Usage:
 *   git clone --depth 1 --branch v16.3.6 --filter=blob:none --sparse \
 *     https://github.com/vercel/next.js.git next && \
 *     git -C next sparse-checkout set test
 *   bun scripts/scan-suite-native-addons.mjs next
 *
 * It prints one line per candidate. Classifying each one (runtime vs build-time
 * or never deployed) is a review decision recorded in the JSON, not something
 * this script decides.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The suite roots the knext manifest includes (rules.include). */
export const SUITE_ROOTS = ['test/e2e', 'test/production'];

/** Dependencies whose presence means the package builds or loads a .node file. */
const NATIVE_DEPS = new Set([
  'node-gyp',
  'node-gyp-build',
  'prebuild-install',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'nan',
  'node-addon-api',
  'bindings',
  'cmake-js',
]);

/**
 * Every `name -> spec` a test file declares in a `dependencies: { ... }`
 * literal, or a fixture package.json declares. Returns Map<"name@spec", files[]>.
 */
export function extractDeclaredDeps(root) {
  const out = new Map();
  const add = (name, spec, file) => {
    const key = `${name}@${spec}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(file);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(root, p);
      if (/\.test\.[tj]sx?$/.test(p)) {
        const src = readFileSync(p, 'utf8');
        for (const block of src.matchAll(/dependencies\s*:\s*\{([^}]*)\}/g)) {
          for (const kv of block[1].matchAll(/['"]?([@\w./-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
            add(kv[1], kv[2], rel);
          }
        }
      } else if (entry === 'package.json') {
        let pkg;
        try {
          pkg = JSON.parse(readFileSync(p, 'utf8'));
        } catch {
          continue;
        }
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          for (const [name, spec] of Object.entries(pkg[field] ?? {})) add(name, spec, rel);
        }
      }
    }
  };
  for (const r of SUITE_ROOTS) walk(join(root, r));
  return out;
}

/** Why a registry version manifest looks native, or [] when it does not. */
export function nativeReasons(manifest) {
  const reasons = [];
  if (manifest.gypfile) reasons.push('gypfile');
  if (manifest.binary) reasons.push('binary');
  const scripts = manifest.scripts ?? {};
  const lifecycle = [scripts.preinstall, scripts.install, scripts.postinstall].join(' ');
  if (/node-gyp|prebuild|pre-gyp|cmake-js/.test(lifecycle)) reasons.push('install script');
  for (const d of Object.keys(manifest.dependencies ?? {})) {
    if (NATIVE_DEPS.has(d)) reasons.push(`depends on ${d}`);
  }
  const platform = Object.keys(manifest.optionalDependencies ?? {}).filter((d) =>
    /linux(musl)?-(x64|arm64)|linux-.*-(gnu|musl)/.test(d),
  );
  if (platform.length) reasons.push(`platform packages: ${platform.join(', ')}`);
  return reasons;
}

async function main(root) {
  // Ranges need a semver implementation; Bun ships one. Under plain node only
  // exact versions and dist-tags resolve, and ranges print as UNRESOLVED.
  const semver = globalThis.Bun?.semver;
  const satisfies = semver?.satisfies;
  const order = semver?.order;
  const pick = (doc, spec) => {
    if (doc['dist-tags']?.[spec]) return doc.versions[doc['dist-tags'][spec]];
    if (doc.versions?.[spec]) return doc.versions[spec];
    if (!satisfies) return null;
    const ok = Object.keys(doc.versions ?? {})
      .filter((v) => !v.includes('-') && satisfies(v, spec))
      .sort(order);
    return ok.length ? doc.versions[ok[ok.length - 1]] : null;
  };
  for (const [key, files] of extractDeclaredDeps(root)) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    const spec = key.slice(at + 1);
    if (name === 'next' || name.startsWith('@next/') || /^(workspace|file|link):|^\./.test(spec)) {
      continue;
    }
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
    if (!res.ok) continue;
    const manifest = pick(await res.json(), spec);
    if (!manifest) {
      console.log(`UNRESOLVED ${name}@${spec} (${files[0]})`);
      continue;
    }
    const reasons = nativeReasons(manifest);
    if (reasons.length) {
      console.log(`${name}@${manifest.version} <- ${spec} :: ${reasons.join('; ')} :: ${files[0]}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node scripts/scan-suite-native-addons.mjs <next.js checkout>');
    process.exit(2);
  }
  await main(root);
}
