/**
 * The kind e2e driver (scripts/ffi-action-e2e.mjs) calls the fixture zone's
 * Server Actions by id, read from the build's server-reference-manifest.json.
 * Next only lists an action there when a CLIENT component imports it, so an
 * action that is exported from actions.ts but not imported by a 'use client'
 * file builds fine and is missing from the manifest — a failure seen only in
 * the kind lane, after the cluster, the Rust build and the image. This scans
 * every action the driver references and checks both halves locally:
 * exported from the fixture's actions.ts, and imported by a client component.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PKG = resolve(import.meta.dir, '..', '..');
const DRIVER = join(PKG, 'scripts', 'ffi-action-e2e.mjs');
const ACTIONS_DIR = join(PKG, 'fixtures', 'ffi-zone', 'src', 'app', 'rust-ffi');
const ACTIONS = join(ACTIONS_DIR, 'actions.ts');

/** Every `<name>Action` identifier the driver uses: `ids.x` reads and the required-names list. */
function driverActions(): string[] {
  const src = readFileSync(DRIVER, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\bids\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/'([A-Za-z_$][\w$]*Action)'/g)) names.add(m[1]);
  return [...names].sort();
}

/** Named imports from './actions' across the fixture's 'use client' files. */
function clientImportedActions(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(ACTIONS_DIR)) {
    if (!/\.(t|j)sx?$/.test(file)) continue;
    const src = readFileSync(join(ACTIONS_DIR, file), 'utf8');
    if (!/^\s*['"]use client['"]/.test(src.replace(/^(\s*\/\/[^\n]*\n)*/, ''))) continue;
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/actions['"]/g)) {
      for (const part of m[1].split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0];
        if (name) out.add(name);
      }
    }
  }
  return out;
}

describe('ffi kind e2e: every action the driver calls is wired in the fixture', () => {
  const names = driverActions();

  it('the driver references the actions (the scan is not vacuous)', () => {
    expect(names).toContain('greetAction');
    expect(names).toContain('pauseAction');
  });

  it('each is an exported async function in the fixture actions.ts', () => {
    const src = readFileSync(ACTIONS, 'utf8');
    const missing = names.filter(
      (n) => !new RegExp(`export\\s+async\\s+function\\s+${n}\\s*\\(`).test(src),
    );
    expect(missing).toEqual([]);
  });

  it("each is imported by a 'use client' component (else Next leaves it out of the manifest)", () => {
    const imported = clientImportedActions();
    expect(names.filter((n) => !imported.has(n))).toEqual([]);
  });
});
