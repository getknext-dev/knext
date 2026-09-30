/**
 * #1669 round 2 (review fix) — proves the transitive-resolution half of the
 * public API type-surface guard in isolation, against a minimal fixture
 * rather than the real (large) `@getknext/lib` package.
 *
 * The gap the review caught: a single-file `.d.ts` emit of an entry only
 * shows that entry's OWN top-level declarations. `@getknext/lib`'s `.`
 * entry is six `export * from './x'` statements, so a rename/narrowing
 * inside one of those re-exported files (e.g. `redis/client.ts`) changed
 * nothing in the entry's OWN emitted text and passed untouched.
 * `scripts/api-surface/lib.mjs` now uses `checker.getExportsOfModule`
 * instead, which resolves `export *` / `export { X } from` chains to the
 * real target symbol. This file builds the smallest fixture that exercises
 * exactly that: an entry that is nothing but an `export *` from a second
 * file, mutates the re-exported symbol two ways (rename, narrow), and
 * asserts the extracted surface changes each time — i.e. the guard goes red
 * on a change it could not see before this fix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSurfaceForFiles } from '../scripts/api-surface/lib.mjs';
import { absTmpdir } from './helpers/abs-tmp';

let dir: string;
let entryPath: string;
let reExportedPath: string;

function writeFixture(reExportedBody: string) {
  writeFileSync(entryPath, "export * from './re-exported';\n");
  writeFileSync(reExportedPath, reExportedBody);
}

function extract(): string {
  return extractSurfaceForFiles([entryPath, reExportedPath], entryPath, {});
}

describe('#1669: transitive resolution through `export * from`', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(absTmpdir(), 'api-surface-fixture-'));
    entryPath = join(dir, 'entry.ts');
    reExportedPath = join(dir, 're-exported.ts');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks a symbol declared ONLY in the re-exported file, not the entry', () => {
    writeFixture('export function greet(name: string): string {\n  return name;\n}\n');
    const surface = extract();
    expect(surface).toContain('greet(name: string): string');
  });

  it('goes red on a RENAME of the re-exported symbol', () => {
    writeFixture('export function greetRenamed(name: string): string {\n  return name;\n}\n');
    const surface = extract();
    expect(surface).not.toContain('function greet(');
    expect(surface).toContain('greetRenamed(name: string): string');
  });

  it('goes red on a NARROWED parameter type of the re-exported symbol', () => {
    writeFixture('export function greet(name: string): string {\n  return name;\n}\n');
    const widened = extract();
    writeFixture('export function greet(name: "only"): string {\n  return name;\n}\n');
    const narrowed = extract();
    expect(widened).toContain('greet(name: string): string');
    expect(narrowed).toContain('greet(name: "only"): string');
    expect(narrowed).not.toEqual(widened);
  });

  it('goes red on a NARROWED re-exported interface property', () => {
    writeFileSync(entryPath, "export * from './re-exported';\n");
    writeFileSync(reExportedPath, 'export interface Shape {\n  provider: string;\n}\n');
    const widened = extract();
    writeFileSync(reExportedPath, 'export interface Shape {\n  provider: "s3" | "gcs";\n}\n');
    const narrowed = extract();
    expect(widened).toContain('provider: string');
    expect(narrowed).toContain('provider: "s3" | "gcs"');
    expect(narrowed).not.toEqual(widened);
  });
});
