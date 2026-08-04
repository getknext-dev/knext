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

export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Workspace globs from `pnpm-workspace.yaml` — cross-checked by `workspaceGlobs`. */
export const WORKSPACE_DIRS = ['apps', 'packages'];

export interface Manifest {
  /** Repo-relative, POSIX-separated — stable in test names across platforms. */
  path: string;
  pkg: Record<string, unknown>;
}

/** The globs `pnpm-workspace.yaml` actually declares. */
export function workspaceGlobs(): string[] {
  const yaml = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  return [...yaml.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1]).sort();
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
