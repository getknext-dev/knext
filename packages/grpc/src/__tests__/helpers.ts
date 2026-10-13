/**
 * Shared test scaffolding: scratch directories (a copy of the fixture zone, or
 * an empty app) and captured CLI output. Every scratch directory lives under
 * `tmpdir()`, is enrolled in this module's registry, and is removed when a test
 * file calls {@link removeScratchDirs} from its `afterAll`.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

export const PKG_DIR = resolve(import.meta.dir, '..', '..');
export const FIXTURE_ZONE = join(PKG_DIR, 'fixtures', 'zone');

const scratchDirs: string[] = [];

/** An empty scratch directory, removed by {@link removeScratchDirs}. */
export function emptyDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `knext-grpc-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Remove every scratch directory this file created. Call from `afterAll`. */
export function removeScratchDirs(): void {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  scratchDirs.length = 0;
}

/** A fresh copy of the fixture zone (proto + config + committed output). */
export function copyFixtureZone(prefix: string): string {
  const dir = emptyDir(prefix);
  cpSync(FIXTURE_ZONE, dir, { recursive: true });
  return dir;
}

/** Every file under `dir`, as relative path -> contents, sorted by path. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

export interface Captured {
  readonly io: { stdout: (s: string) => void; stderr: (s: string) => void };
  readonly out: () => string;
  readonly err: () => string;
}

export function capture(): Captured {
  let o = '';
  let e = '';
  return {
    io: {
      stdout: (s) => {
        o += s;
      },
      stderr: (s) => {
        e += s;
      },
    },
    out: () => o,
    err: () => e,
  };
}
