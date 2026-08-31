/**
 * ONE scan of the workspace's package manifests, shared by the two guards that
 * need it (#643).
 *
 * `next-version-floor.test.ts` (the CVE floor, `>=`) and
 * `template-next-pin.test.ts` (template pins, `===`) ask different questions of
 * the same set. They had two verbatim copies of the glob list, the walk and the
 * pnpm-workspace cross-check — in a PR whose other half exists precisely
 * because there were two copies of one rule. So the copy is removed rather than
 * left as an exercise for whoever next edits one of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { workspaceGlobs as sharedWorkspaceGlobs } from '../../scripts/lib/workspace-globs.mjs';

export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Workspace roots, cross-checked against the declaration by `workspaceGlobs`. */
export const WORKSPACE_DIRS = ['apps', 'packages'];

export interface Manifest {
  /** Repo-relative, POSIX-separated — stable in test names across platforms. */
  path: string;
  pkg: Record<string, unknown>;
}

/**
 * The globs the repo actually declares — delegated, not re-parsed.
 *
 * The declaration moved from `pnpm-workspace.yaml` to `package.json`'s
 * `workspaces` array when the repo left pnpm. The parsing lives in
 * `scripts/lib/workspace-globs.mjs` because it is reachable from BOTH scripts
 * and tests; this stays as the test-side name so callers are unchanged.
 *
 * Consolidating mattered more than the format change: five separate readings of
 * the same declaration existed, and removing pnpm broke four of them
 * independently. Guards that disagree about what the workspace IS are how a
 * package falls outside all of them at once.
 */
export function workspaceGlobs(): string[] {
  return [...sharedWorkspaceGlobs()].sort();
}

/**
 * Parse a manifest. `package.json.hbs` is JSON with `{{placeholders}}` inside
 * string values, so it only parses once they are neutralised.
 */
export function readManifest(abs: string): Manifest {
  return {
    path: relative(REPO_ROOT, abs).split(sep).join('/'),
    pkg: JSON.parse(readFileSync(abs, 'utf8').replace(/\{\{[^}]*\}\}/g, 'placeholder')),
  };
}

/** Every workspace-member manifest, found by scanning the globs. */
export function workspaceManifests(): Manifest[] {
  const found: Manifest[] = [];
  for (const dir of WORKSPACE_DIRS) {
    for (const entry of readdirSync(resolve(REPO_ROOT, dir))) {
      const manifest = join(REPO_ROOT, dir, entry, 'package.json');
      try {
        if (!statSync(manifest).isFile()) continue;
      } catch {
        continue;
      }
      found.push(readManifest(manifest));
    }
  }
  return found;
}

/** The `next` range a manifest declares, from either dependency field. */
export function nextRange(pkg: Record<string, unknown>): string | undefined {
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const range = (pkg[field] as Record<string, string> | undefined)?.next;
    if (range) return range;
  }
  return undefined;
}
