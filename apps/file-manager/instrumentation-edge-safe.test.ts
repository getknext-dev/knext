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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const instrumentationSrc = readFileSync(
  join(here, 'src', 'instrumentation.ts'),
  'utf8',
);

/**
 * Modules that are Node-only (native/Node-built-in dependencies) and therefore
 * must NEVER be reached from a top-level static import in instrumentation.ts,
 * because instrumentation is compiled for the edge runtime too.
 *
 * `@knext/lib/clients` is the primary offender: it transitively imports
 * `@cerbos/grpc`, `pg`, and `minio`.
 */
const NODE_ONLY_MODULES = [
  '@knext/lib/clients',
  'pg',
  '@cerbos/grpc',
  'minio',
];

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
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

describe('instrumentation.ts edge-bundle safety (#342)', () => {
  const staticSpecs = topLevelStaticImportSpecifiers(instrumentationSrc);

  it.each(NODE_ONLY_MODULES)(
    'does NOT top-level static-import the Node-only module %s',
    (mod) => {
      expect(staticSpecs).not.toContain(mod);
    },
  );

  it('guards the Node-only body behind NEXT_RUNTIME === "nodejs"', () => {
    expect(instrumentationSrc).toMatch(
      /process\.env\.NEXT_RUNTIME\s*[!=]==?\s*['"]nodejs['"]/,
    );
  });

  it('loads Node-only wiring via a dynamic import (await import)', () => {
    expect(instrumentationSrc).toMatch(/await\s+import\s*\(/);
  });
});
