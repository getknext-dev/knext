#!/usr/bin/env node

/**
 * Find test files where porting `vi.mock` to `mock.module` would break SILENTLY.
 *
 * vitest HOISTS `vi.mock(...)` above the import statements at transform time, so
 * a file can mock a module and also import it statically and the mock still
 * wins. Bun's `mock.module(...)` has no such transform: it runs where it is
 * written, which is *after* the static imports have already been evaluated and
 * bound.
 *
 * The consequence is the dangerous kind. Nothing throws. The test runs against
 * the REAL module, and either passes for the wrong reason or dials a real
 * dependency. That exact failure has already cost this session twice — once
 * when an inline `require` made `vi.mock('ioredis')` stop applying and the
 * health tests hit a live Redis, surfacing only as `MaxRetriesPerRequestError`.
 *
 * So this classifies every file BEFORE any conversion:
 *
 *   SAFE      — mocks nothing, or only imports the mocked module dynamically
 *               (`await import(...)` inside the test). Mechanical port.
 *   HAZARD    — mocks a module it ALSO imports statically. Needs the import
 *               converted to a dynamic one, or the mock moved to a preload.
 *
 * Exit code is 0 either way; this reports, it does not gate. Run it again after
 * the port with `--verify` to assert the HAZARD set is empty.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const verify = process.argv.includes('--verify');

const files = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

/** `vi.mock('x')` / `mock.module('x')` — capture the specifier. */
const MOCK_CALL = /(?:vi\.mock|vi\.doMock|mock\.module)\(\s*['"]([^'"]+)['"]/g;
/** A STATIC import of a specifier: `import ... from 'x'` or `import 'x'`. */
const staticImportOf = (spec) =>
  new RegExp(
    `^\\s*import\\s+(?:[^;]*?\\s+from\\s+)?['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    'm',
  );

const hazards = [];
let mockingFiles = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const specs = [...src.matchAll(MOCK_CALL)].map((m) => m[1]);
  if (specs.length === 0) continue;
  mockingFiles++;

  const clashes = [...new Set(specs)].filter((spec) => staticImportOf(spec).test(src));
  if (clashes.length > 0) hazards.push({ file, clashes });
}

console.log(`scanned ${files.length} test files`);
console.log(`  ${mockingFiles} mock at least one module`);
console.log(`  ${hazards.length} would break SILENTLY under bun's non-hoisted mock.module\n`);

for (const { file, clashes } of hazards) {
  console.log(`  HAZARD  ${file}`);
  for (const c of clashes) console.log(`            mocks AND statically imports: ${c}`);
}

if (verify && hazards.length > 0) {
  console.error(
    `\n${hazards.length} file(s) still mock a statically-imported module. ` +
      'Under bun these exercise the REAL module with no error.',
  );
  process.exit(1);
}
