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
 * #344 (hardening the #342 guard): the edge-clean `instrumentation.ts` is only
 * HALF the fence. Because `instrumentation.ts` calls
 * `await import('./instrumentation-node')` with a STATIC literal specifier,
 * webpack STATICALLY traces that module into BOTH the nodejs AND the edge
 * bundle — the runtime `NEXT_RUNTIME === 'nodejs'` guard only stops it EXECUTING
 * on the edge, not from being BUNDLED. The load-bearing edge exclusion is the
 * `IgnorePlugin` in `next.config.ts` webpack(): for the edge compile ONLY it
 * replaces `./instrumentation-node` with an empty module so its Node-only
 * subtree (`@knext/lib/clients` → `@cerbos/grpc`/`pg`/`minio`) never enters the
 * edge bundle. Deleting that plugin passes the instrumentation.ts checks above
 * yet re-breaks the production `next build` with `Module not found`.
 *
 * These assertions close that blind spot: the edge-scoped IgnorePlugin must
 * exist and must target the instrumentation-node module. This test FAILS if a
 * future change removes the plugin (proven in #344 by deleting the block).
 */
describe('next.config.ts edge IgnorePlugin fence (#342/#344)', () => {
  it('has a webpack() config that branches on the edge runtime', () => {
    // The edge exclusion must be scoped to the edge compile — the nodejs
    // compile bundles the real Node-only module (that is where it must run).
    expect(nextConfigSrc).toMatch(/nextRuntime\s*===\s*['"]edge['"]/);
  });

  it('registers an IgnorePlugin (the load-bearing edge exclusion)', () => {
    expect(nextConfigSrc).toMatch(/new\s+webpack\.IgnorePlugin\s*\(/);
  });

  it('the IgnorePlugin targets the instrumentation-node module', () => {
    // The `resourceRegExp` must match `instrumentation-node` so webpack replaces
    // it with an empty module on the edge compile. A plugin that no longer
    // targets this module is as broken as no plugin at all.
    expect(nextConfigSrc).toMatch(/resourceRegExp:\s*\/[^/]*instrumentation-node/);
  });
});
