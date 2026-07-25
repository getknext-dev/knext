import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The npm org `knext` was unavailable; the founder owns `getknext`. Nothing was
 * ever published under `@knext/*` (the scope is empty on npmjs), so the rename to
 * `@getknext/*` is a clean pre-publish cutover — no deprecation shims, no aliases.
 *
 * This guard keeps the old scope from creeping back in via copy-paste or a stale
 * doc snippet. It is deliberately repo-wide and anchored on the `@` so that the
 * GitHub-Packages scope `@getknext-dev/*` (a DIFFERENT, still-valid scope, see
 * scripts/rename-for-ghp.mjs) and the `knext` product name in prose are unaffected.
 */

const repoRoot = join(import.meta.dirname, '..');

/** Every tracked file that still mentions the retired `@knext` npm scope. */
function trackedFilesMentioningOldScope(): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['grep', '-l', '--', '@knext'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (err: unknown) {
    // git grep exits 1 with empty stdout when there are no matches — the goal state.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout?.trim()) return [];
    throw err;
  }
  return out.split('\n').filter(Boolean);
}

/**
 * The single deliberate exception: this skill file narrates the HISTORICAL scope
 * drift (`@kn-next` vs `@knative-next` vs `@knext`) as a case study. Rewriting the
 * quoted history would make the anecdote false.
 */
const HISTORICAL_QUOTE_ALLOWLIST = ['.claude/skills/framework-design/SKILL.md'];

describe('npm scope is @getknext (npm org `knext` was unavailable)', () => {
  it('no tracked file references the retired `@knext` scope', () => {
    const offenders = trackedFilesMentioningOldScope().filter(
      (f) => !HISTORICAL_QUOTE_ALLOWLIST.includes(f),
    );
    expect(offenders).toEqual([]);
  });

  it('the allowlisted file mentions `@knext` only as quoted scope-drift history', () => {
    const src = readFileSync(join(repoRoot, HISTORICAL_QUOTE_ALLOWLIST[0]), 'utf8');
    const lines = src.split('\n').filter((l) => l.includes('@knext'));
    expect(lines.length).toBeGreaterThan(0);
    // Every surviving mention must sit alongside the other historical names,
    // i.e. it is describing the drift, not declaring a live dependency.
    for (const line of lines) {
      expect(line).toMatch(/@kn-next|@knative-next/);
    }
  });

  it('the published packages declare the @getknext scope', () => {
    const expected: Array<[string, string]> = [
      ['packages/kn-next', '@getknext/core'],
      ['packages/lib', '@getknext/lib'],
      ['packages/db', '@getknext/db'],
      ['packages/ui', '@getknext/ui'],
    ];
    for (const [dir, name] of expected) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as {
        name: string;
      };
      expect(manifest.name).toBe(name);
    }
  });

  it('keeps the `kn-next` CLI bin name unchanged (npx kn-next must keep working)', () => {
    const core = JSON.parse(
      readFileSync(join(repoRoot, 'packages/kn-next/package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    expect(Object.keys(core.bin ?? {})).toContain('kn-next');
  });

  it('the GitHub-Packages rename still maps the live scope onto @getknext-dev', async () => {
    const mod = (await import('../scripts/rename-for-ghp.mjs')) as {
      OLD_SCOPE: string;
      NEW_SCOPE: string;
    };
    expect(mod.OLD_SCOPE).toBe('@getknext/');
    expect(mod.NEW_SCOPE).toBe('@getknext-dev/');
    // The two scopes must not prefix-collide, or the rewrite would double-apply.
    expect(mod.NEW_SCOPE.startsWith(mod.OLD_SCOPE)).toBe(false);
  });
});
