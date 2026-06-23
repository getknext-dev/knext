#!/usr/bin/env node
/**
 * install-smoke-probe.mjs — PK2 / #115 (app-import probe)
 *
 * Runs INSIDE the clean consumer dir (outside the workspace) on plain Node. It imports
 * the PUBLIC app surface a knext consumer uses (the exact set PK5/#116 declared) and
 * asserts each:
 *   - resolves to real compiled JS (NOT a raw `.ts` — the PK1 failure mode), and
 *   - exposes its expected named/default export.
 *
 * The `KnativeNextConfig` export of `@knext/core` is TYPE-ONLY (erased at build), so we
 * cannot assert a runtime binding for it — instead we assert the `.` module LOADS, and
 * that the committed `kn-next.config.ts` fixture (which `import type`s it) loads on plain
 * Node via type-stripping, proving the type surface is consumable.
 *
 * Exit code is the contract: 0 = all public imports resolved; non-zero = at least one
 * failed. install-smoke.mjs treats any non-zero exit as a hard job failure.
 */

import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/__probe__.js`);

let failures = 0;
function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failures++;
}
function ok(msg) {
  console.log(`  OK:   ${msg}`);
}

/**
 * Each entry: [specifier, namedExportOrNull].
 * - null  -> just assert the module loads (type-only or namespace surface).
 * - name  -> assert that named/default export is present and not undefined.
 */
const PUBLIC_SURFACE = [
  // @knext/core
  ['@knext/core', null], // KnativeNextConfig is type-only; assert the module loads
  ['@knext/core/adapter', null], // default Next.js adapter factory surface
  ['@knext/core/adapters/otel-config', 'resolveOtelOptions'],
  ['@knext/core/adapters/cache-handler', 'default'],
  // @knext/lib
  ['@knext/lib', null],
  ['@knext/lib/logger', null],
  ['@knext/lib/clients', 'getDbPool'],
  ['@knext/lib/health', 'checkDeepHealth'],
];

console.log('[probe] resolving + importing the public app surface on plain Node:');
for (const [spec, named] of PUBLIC_SURFACE) {
  let resolved;
  try {
    resolved = require.resolve(spec);
  } catch (e) {
    fail(`resolve ${spec}: ${e.message}`);
    continue;
  }
  if (resolved.endsWith('.ts')) {
    fail(`${spec} resolved to RAW .ts (${resolved}) — consumer cannot import this`);
    continue;
  }
  let mod;
  try {
    mod = await import(spec);
  } catch (e) {
    fail(`import ${spec}: ${e.message}`);
    continue;
  }
  if (named) {
    const val = mod[named];
    if (val === undefined) {
      fail(`${spec} is missing expected export '${named}'`);
      continue;
    }
    ok(`${spec} [${named}] -> ${shorten(resolved)}`);
  } else {
    ok(`${spec} -> ${shorten(resolved)}`);
  }
}

// KnativeNextConfig type surface: the .ts fixture (which `import type`s it) must load on
// plain Node via type-stripping, proving the type is consumable by an app's config.
try {
  const cfg = await import(`${process.cwd()}/kn-next.config.ts`);
  if (!cfg.default || cfg.default.name !== 'smoke-app') {
    fail('kn-next.config.ts loaded but default export is missing/incorrect');
  } else {
    ok('kn-next.config.ts (uses `import type { KnativeNextConfig }`) loads on plain Node');
  }
} catch (e) {
  fail(`kn-next.config.ts (KnativeNextConfig type fixture): ${e.message}`);
}

function shorten(p) {
  const i = p.indexOf('/node_modules/');
  return i >= 0 ? p.slice(i + '/node_modules/'.length) : p;
}

if (failures > 0) {
  console.error(`[probe] ${failures} public-surface import(s) FAILED`);
  process.exit(1);
}
console.log('[probe] all public-surface imports resolved to real JS');
process.exit(0);
