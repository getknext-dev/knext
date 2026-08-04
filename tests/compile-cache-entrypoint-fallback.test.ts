/**
 * #309 (one of four criteria) — the container ENTRYPOINT must never gate boot
 * on the compile-cache directory.
 *
 * V8 itself is fail-open about a broken NODE_COMPILE_CACHE
 * (`packages/kn-next/src/__tests__/compile-cache-volume-fallback.test.ts`
 * proves the shapes), so the only way knext can turn a cache-volume problem
 * into a CRASHLOOP is by adding a check of its own in front of `exec node` —
 * an `mkdir -p "$NODE_COMPILE_CACHE"` on a read-only mount, a `test -w`, a
 * `set -e` with any failing probe. That is a one-line edit away at all times
 * and would be invisible in every existing test: the bake tests run against a
 * WRITABLE build-stage directory, where such a check passes.
 *
 * This guard SCANS rather than enumerates (the repo rule): it discovers every
 * Dockerfile whose runtime CMD mentions NODE_COMPILE_CACHE and applies both
 * halves to each —
 *   - SANCTIONED present: the CMD exports the var with the `${NODE_COMPILE_CACHE:-<abs default>}`
 *     override-wins form (ADR-0035 / #440) and hands off with `exec`;
 *   - UNSANCTIONED absent: no boot-gating construct in that CMD, and, proved by
 *     EXECUTION rather than by reading, the CMD's shell still reaches its
 *     `exec node` when NODE_COMPILE_CACHE points at an UNWRITABLE directory.
 *
 * The behavioural half is the one that cannot be fooled by a construct nobody
 * thought to blocklist.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  type Dirent,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories worth scanning for app Dockerfiles (never node_modules). */
const SCAN_ROOTS = ['apps', 'packages'];

function findDockerfiles(dir: string, found: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findDockerfiles(full, found);
    else if (entry.isFile() && /^Dockerfile(\..+)?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** The runtime `CMD ["sh","-c","…"]` shell string, or null when there is none. */
function runtimeCmd(dockerfile: string): string | null {
  const df = readFileSync(dockerfile, 'utf8');
  const m = df.match(/CMD\s*\[\s*"sh"\s*,\s*"-c"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

const cacheCmds = findDockerfiles(join(REPO_ROOT, SCAN_ROOTS[0]))
  .concat(findDockerfiles(join(REPO_ROOT, SCAN_ROOTS[1])))
  .map((file) => ({ file, cmd: runtimeCmd(file) }))
  .filter(
    (entry): entry is { file: string; cmd: string } =>
      entry.cmd !== null && entry.cmd.includes('NODE_COMPILE_CACHE'),
  );

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort
    }
  }
});

function unwritableDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-309-entrypoint-'));
  scratchDirs.push(dir);
  chmodSync(dir, 0o555);
  let wrote = false;
  try {
    writeFileSync(join(dir, '.probe'), 'x');
    wrote = true;
  } catch {
    // expected
  }
  if (wrote) {
    throw new Error(
      `precondition failed: ${dir} is still writable after chmod 0555 (uid=${process.getuid?.()}). ` +
        'This case simulates a read-only cache volume; as root the simulation is a no-op, so the run is ' +
        'reported as a FAILURE rather than a false pass. Run the suite as a non-root user.',
    );
  }
  return dir;
}

describe('#309 the container entrypoint never gates boot on the compile-cache dir', () => {
  it('found the runtime CMDs to guard (a vacuous scan is a failed scan)', () => {
    expect(
      cacheCmds.length,
      'no Dockerfile runtime CMD mentions NODE_COMPILE_CACHE — the scan matched nothing, ' +
        'so every assertion below would pass vacuously. Fix the scan, not this expectation.',
    ).toBeGreaterThanOrEqual(2);
  });

  for (const { file, cmd } of cacheCmds) {
    const label = file.slice(REPO_ROOT.length + 1);

    it(`${label}: exports the override-wins default and execs`, () => {
      // SANCTIONED half. `${VAR:-default}` (not `:=`, not a bare assignment)
      // is what makes an operator-injected value win while an absolute baked
      // default still applies when nothing is injected.
      expect(cmd).toMatch(/export\s+NODE_COMPILE_CACHE="\$\{NODE_COMPILE_CACHE:-\/[^}]+\}"/);
      expect(cmd).toContain('exec ');
    });

    it(`${label}: contains no construct that could fail the boot on a bad cache dir`, () => {
      // UNSANCTIONED half. Each of these turns an unwritable/read-only/absent
      // cache volume into a non-zero exit — i.e. a crashloop — instead of a
      // slower cold start.
      const forbidden: Array<[RegExp, string]> = [
        [/\bmkdir\b/, 'mkdir fails on a read-only mount and would abort the boot'],
        [/\brm\b/, 'removing cache contents can fail on a read-only mount'],
        [/\btest\s+-[a-z]/, 'a `test` probe on the cache dir gates the boot'],
        [/\[\s+-[a-z]/, 'a `[ -w … ]` probe on the cache dir gates the boot'],
        [/\bset\s+-[eu]/, '`set -e`/`set -u` turns any probe failure into an exit'],
        [/\bexit\b/, 'an explicit exit before `exec node` is a boot gate'],
        [/\btouch\b/, 'a write probe fails on a read-only mount'],
      ];
      for (const [pattern, why] of forbidden) {
        expect(pattern.test(cmd), `${label} runtime CMD contains ${pattern}: ${why}`).toBe(false);
      }
    });

    it(`${label}: still reaches its exec with an UNWRITABLE NODE_COMPILE_CACHE`, () => {
      // The half that no blocklist can fake: run the REAL CMD shell, with the
      // final `exec …` replaced by a marker, against a read-only cache dir.
      const probe = `exec node -e "process.stdout.write('REACHED:' + (process.env.NODE_COMPILE_CACHE || '__UNSET__'))"`;
      const patched = cmd.replace(/exec .*$/, probe);
      expect(
        patched,
        'the exec substitution did not apply — the guard would pass vacuously',
      ).not.toBe(cmd);
      expect(patched).toContain('REACHED:');

      const cache = join(unwritableDir(), 'bytecode');
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache };
      delete env.NODE_OPTIONS; // harness artifact; keep the child clean
      const out = execFileSync('sh', ['-c', patched], { encoding: 'utf8', env }).trim();

      // Booted, and with the injected (broken) value intact — the entrypoint
      // neither aborted nor silently rewrote it.
      expect(out).toBe(`REACHED:${cache}`);
      // And it really was unwritable for the duration of the run.
      expect(statSync(dirname(cache)).mode & 0o200).toBe(0);
    });
  }
});
