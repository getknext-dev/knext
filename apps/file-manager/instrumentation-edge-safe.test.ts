/**
 * Regression guard for #342: `next build` compiles `instrumentation.ts` for BOTH
 * the nodejs AND the edge runtimes. Any TOP-LEVEL static import of a Node-only
 * client module (e.g. `@knext/lib/clients`, which transitively pulls in
 * `@cerbos/grpc` → `@grpc/grpc-js` needing `zlib`/`stream`/`net`/`tls`/`fs`)
 * lands in the edge bundle and fails the production build with
 * `Module not found: Can't resolve 'stream'` etc.
 *
 * The canonical Next.js pattern is to guard the Node-only body behind
 * `process.env.NEXT_RUNTIME === 'nodejs'` and pull the Node-only deps in via a
 * DYNAMIC `await import(...)` inside that guard, so they never enter the edge
 * bundle. This test closes the gate gap: this class of regression must fail the
 * gate here (fast static analysis), not the deploy build.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const instrumentationSrc = readFileSync(join(here, 'src', 'instrumentation.ts'), 'utf8');
const nextConfigSrc = readFileSync(join(here, 'next.config.ts'), 'utf8');

/**
 * Modules that are Node-only (native/Node-built-in dependencies) and therefore
 * must NEVER be reached from a top-level static import in instrumentation.ts,
 * because instrumentation is compiled for the edge runtime too.
 *
 * `@knext/lib/clients` is the primary offender: it transitively imports
 * `@cerbos/grpc`, `pg`, and `minio`.
 */
const NODE_ONLY_MODULES = ['@knext/lib/clients', 'pg', '@cerbos/grpc', 'minio'];

/**
 * Extract the set of module specifiers reached by TOP-LEVEL *static* imports.
 * Deliberately does NOT match `await import(...)` (dynamic imports), which are
 * the intended escape hatch behind the NEXT_RUNTIME==='nodejs' guard.
 */
function topLevelStaticImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `import ... from '<spec>'` and side-effect `import '<spec>'`
  const staticImportRe = /^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm;
  const sideEffectImportRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const re of [staticImportRe, sideEffectImportRe]) {
    for (const match of source.matchAll(re)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

describe('instrumentation.ts edge-bundle safety (#342)', () => {
  const staticSpecs = topLevelStaticImportSpecifiers(instrumentationSrc);

  it.each(NODE_ONLY_MODULES)('does NOT top-level static-import the Node-only module %s', (mod) => {
    expect(staticSpecs).not.toContain(mod);
  });

  it('guards the Node-only body behind NEXT_RUNTIME === "nodejs"', () => {
    expect(instrumentationSrc).toMatch(/process\.env\.NEXT_RUNTIME\s*[!=]==?\s*['"]nodejs['"]/);
  });

  it('loads Node-only wiring via a dynamic import (await import)', () => {
    expect(instrumentationSrc).toMatch(/await\s+import\s*\(/);
  });
});

/**
 * #356 (ADR-0031) graduated the second half of the #342/#344 fence: the
 * edge-scoped `IgnorePlugin` that excludes `./instrumentation-node` from the
 * EDGE bundle is now PLATFORM-OWNED — the knext adapter's `modifyConfig`
 * injects it (unit-guarded in
 * `packages/kn-next/src/__tests__/adapter-edge-ignore-plugin.test.ts`). Apps no
 * longer hand-write that webpack hook; hand-writing it would only duplicate the
 * platform injection.
 *
 * These assertions pin the new ownership: the app must wire the package-shipped
 * adapter via `adapterPath` (that is what carries the injected fence into the
 * build), and the app's own `next.config.ts` must NOT reintroduce a hand-written
 * IgnorePlugin. The end-to-end tripwire is unchanged: the PR-gated production
 * `next build --webpack` still fails if the Node-only subtree ever reaches the
 * edge bundle.
 */
describe('edge IgnorePlugin fence — platform-owned via the knext adapter (#342/#344/#356)', () => {
  it('wires the knext adapter via adapterPath (the fence carrier)', () => {
    expect(nextConfigSrc).toMatch(/adapterPath\s*:/);
  });

  it('the app adapter is the package-shipped @knext/core adapter', () => {
    const appAdapterSrc = readFileSync(join(here, 'next-adapter.ts'), 'utf8');
    expect(appAdapterSrc).toMatch(/from\s+['"]@knext\/core\/adapter['"]/);
  });

  it('does NOT hand-write the IgnorePlugin webpack hook (graduated to the adapter modifyConfig)', () => {
    expect(nextConfigSrc).not.toMatch(/new\s+webpack\.IgnorePlugin\s*\(/);
  });
});
