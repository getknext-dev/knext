import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeAdapterClosure } from '../scripts/adapter-import-closure.mjs';

/**
 * S1 / #545 — the adapter EXECUTION-CLOSURE guard.
 *
 * The claim under test is narrow and worth stating exactly: **the adapter never
 * executes CLI code.** That makes `src/cli/` review-safe — a CLI defect cannot
 * corrupt a compat result. It does NOT make CLI changes window-safe: the
 * compat-window digest hashes shipped bytes, and `dist/cli/**` ships inside the
 * tarball under test (`files: ["dist"]`, `bin: ./dist/cli/kn-next.js`), so a CLI
 * change resets the window. An earlier draft of ADR-0039 conflated the two;
 * corrected on PR #574.
 *
 * The claim is not free to keep true — `packages/kn-next/package.json` exports
 * `./internal/cli-validate` and `./internal/cli-shared` from `dist/cli/`, so one
 * import would void it. This guard is what keeps it true as the code moves.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PKG_ROOT = resolve(REPO_ROOT, 'packages/kn-next');
const ADAPTER_ENTRY = resolve(PKG_ROOT, 'src/adapters/next-adapter.ts');

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('the adapter executes no CLI code (ADR-0039 execution claim)', () => {
  it('the real adapter entry reaches no cli/ file', () => {
    const closure = computeAdapterClosure(ADAPTER_ENTRY, { packageRoot: PKG_ROOT });
    expect(closure.violations, closure.violations.map((v) => v.detail).join('\n')).toEqual([]);
    // Sanity: the walker actually walked something — an empty closure would make
    // the assertion above vacuously true.
    expect(closure.files.length).toBeGreaterThan(1);
  });

  it('reports every file it traversed, so the guard is auditable', () => {
    const closure = computeAdapterClosure(ADAPTER_ENTRY, { packageRoot: PKG_ROOT });
    expect(closure.files.some((f) => f.endsWith('adapters/next-adapter.ts'))).toBe(true);
    expect(closure.files.some((f) => f.endsWith('adapters/standalone-bun-exports.ts'))).toBe(true);
  });

  // ── Mutation proofs: the guard must go RED when its subject is violated ────
  it('goes red when the adapter imports a RELATIVE cli/ module', () => {
    const root = tempDir('knext-closure-rel-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@getknext/core","exports":{}}\n');
    writeFileSync(join(root, 'src/cli/shared.ts'), 'export const shared = 1;\n');
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'import { shared } from "../cli/shared";\nexport default shared;\n',
    );
    const closure = computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), {
      packageRoot: root,
    });
    expect(closure.violations.length).toBeGreaterThan(0);
    expect(closure.violations[0].detail).toContain('cli/shared');
  });

  it('goes red when a TRANSITIVE dependency (not the entry) reaches cli/', () => {
    const root = tempDir('knext-closure-trans-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@getknext/core","exports":{}}\n');
    writeFileSync(join(root, 'src/cli/validate.ts'), 'export const v = 1;\n');
    writeFileSync(join(root, 'src/adapters/helper.ts'), 'export { v } from "../cli/validate";\n');
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'import { v } from "./helper";\nexport default v;\n',
    );
    const closure = computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), {
      packageRoot: root,
    });
    expect(closure.violations.length).toBeGreaterThan(0);
  });

  it('goes red when the adapter imports the dist/cli SUBPATH EXPORT (the drift D-1 names)', () => {
    const root = tempDir('knext-closure-subpath-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({
        name: '@getknext/core',
        exports: { './internal/cli-validate': { default: './dist/cli/validate.js' } },
      })}\n`,
    );
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'import { validateConfig } from "@getknext/core/internal/cli-validate";\nexport default validateConfig;\n',
    );
    const closure = computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), {
      packageRoot: root,
    });
    expect(closure.violations.length).toBeGreaterThan(0);
    expect(closure.violations[0].detail).toContain('dist/cli/');
  });

  it('stays green for a dynamic import of a NON-cli module (no false positive)', () => {
    const root = tempDir('knext-closure-ok-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@getknext/core","exports":{}}\n');
    writeFileSync(join(root, 'src/adapters/other.ts'), 'export const o = 1;\n');
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'export const load = () => import("./other");\n',
    );
    const closure = computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), {
      packageRoot: root,
    });
    expect(closure.violations).toEqual([]);
    expect(closure.files.some((f) => f.endsWith('other.ts'))).toBe(true);
  });

  it('goes red on a DYNAMIC import of a cli/ module (dynamic is still the closure)', () => {
    const root = tempDir('knext-closure-dyn-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@getknext/core","exports":{}}\n');
    writeFileSync(join(root, 'src/cli/deploy.ts'), 'export const d = 1;\n');
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'export const load = () => import("../cli/deploy");\n',
    );
    const closure = computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), {
      packageRoot: root,
    });
    expect(closure.violations.length).toBeGreaterThan(0);
  });

  it('fails loudly when a relative import cannot be resolved (silence is not green)', () => {
    const root = tempDir('knext-closure-missing-');
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@getknext/core","exports":{}}\n');
    writeFileSync(
      join(root, 'src/adapters/next-adapter.ts'),
      'import { gone } from "./gone";\nexport default gone;\n',
    );
    expect(() =>
      computeAdapterClosure(join(root, 'src/adapters/next-adapter.ts'), { packageRoot: root }),
    ).toThrow(/gone/);
  });
});
