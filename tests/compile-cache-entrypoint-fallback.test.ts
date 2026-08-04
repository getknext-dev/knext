/**
 * #309 — the container entry must never gate boot on the compile-cache dir.
 *
 * V8 itself is fail-open about a broken NODE_COMPILE_CACHE
 * (`packages/kn-next/src/__tests__/compile-cache-volume-fallback.test.ts`
 * proves every shape), so the only way knext can turn a cache-volume problem
 * into a CRASHLOOP is by adding a check of its own in front of `exec node` —
 * an `mkdir -p "$NODE_COMPILE_CACHE"` on a read-only mount, a `test -w`, a
 * `set -e` with any failing probe. That is a one-line edit away at all times
 * and is invisible to every other test: the bake tests run against a WRITABLE
 * build-stage directory, where such a check passes.
 *
 * ## What is scanned (round 2 — the boundary was too narrow)
 *
 * Round 1 discovered only `CMD ["sh","-c",…]`. A review probe defeated it with
 * `ENTRYPOINT ["/entrypoint.sh"]` whose script did `set -e; mkdir -p
 * "$NODE_COMPILE_CACHE"` — the exact crashloop this exists to prevent — and all
 * seven assertions stayed green, because the Dockerfile was simply never
 * discovered. So discovery now covers every RUNTIME SHELL SURFACE:
 *
 *   - exec-form `CMD`/`ENTRYPOINT` with an `sh -c` / `bash -c` script string;
 *   - SHELL-form `CMD`/`ENTRYPOINT` (the bare-text form, which docker wraps in
 *     `/bin/sh -c` itself);
 *   - exec-form `CMD`/`ENTRYPOINT` naming a SCRIPT — the script's contents are
 *     resolved from the repo and scanned as a surface in their own right.
 *
 * A referenced script that cannot be resolved is a FAILURE, never a pass: "we
 * could not read it" must not read as "it is fine".
 *
 * ## What is asserted, per in-scope surface
 *
 *   - SANCTIONED present (per Dockerfile): the `${NODE_COMPILE_CACHE:-<abs
 *     default>}` override-wins export form (ADR-0035 / #440);
 *   - UNSANCTIONED absent: no boot-gating construct;
 *   - and — the half no blocklist can fake — the surface is EXECUTED with an
 *     unwritable cache dir and must still reach its handoff.
 *
 * ## Boundary, stated rather than implied
 *
 * This reads shell text. It does not evaluate `RUN`-built wrappers, binaries,
 * or a script fetched at build time; a Dockerfile whose entry is a compiled
 * binary is out of scope and would need a container-level test.
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['apps', 'packages', 'examples'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.turbo']);

function walk(dir: string, visit: (file: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

function findDockerfiles(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), (file) => {
      if (/^Dockerfile(\..+)?$/.test(basename(file))) found.push(file);
    });
  }
  return found;
}

/** A runtime shell surface: where it came from, and the shell text itself. */
interface Surface {
  readonly origin: string;
  readonly shell: string;
}

/** Unescape a JSON-array element as written inside a Dockerfile line. */
function unescapeJsonElement(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Resolve a script named by an exec-form entry (e.g. `/entrypoint.sh`) to a
 * file in the repo. Docker copies it in from the build context, so match on the
 * basename anywhere under the app's own directory first, then the repo.
 */
function resolveScript(dockerfile: string, scriptPath: string): string | null {
  const name = basename(scriptPath);
  const candidates: string[] = [];
  walk(dirname(dockerfile), (file) => {
    if (basename(file) === name) candidates.push(file);
  });
  if (candidates.length === 0) {
    for (const root of SCAN_ROOTS) {
      walk(join(REPO_ROOT, root), (file) => {
        if (basename(file) === name) candidates.push(file);
      });
    }
  }
  return candidates[0] ?? null;
}

/**
 * Every runtime shell surface a Dockerfile hands the container. Returns the
 * surfaces plus any script reference that could NOT be resolved — the caller
 * fails on those rather than ignoring them.
 */
function runtimeSurfaces(dockerfile: string): {
  surfaces: Surface[];
  unresolved: string[];
} {
  // A HEALTHCHECK carries its own `CMD`, which is NOT a runtime entry: it runs
  // periodically against an already-booted container and `|| exit 1` is its
  // CONTRACT, not a boot gate. Drop those instructions (including line
  // continuations) before scanning, or the guard reports the healthcheck's
  // `exit 1` as a crashloop risk and its own docs page as a violation.
  const df = readFileSync(dockerfile, 'utf8').replace(
    /^\s*HEALTHCHECK\b(?:[^\n]*\\\n)*[^\n]*\n(?:\s*CMD\b(?:[^\n]*\\\n)*[^\n]*\n)?/gim,
    '',
  );
  const surfaces: Surface[] = [];
  const unresolved: string[] = [];

  for (const instruction of ['CMD', 'ENTRYPOINT'] as const) {
    // Exec form: CMD/ENTRYPOINT [ "…", "…" ]
    const execForm = new RegExp(`^\\s*${instruction}\\s*\\[(.*)\\]\\s*$`, 'gmi');
    for (const match of df.matchAll(execForm)) {
      const parts = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
        unescapeJsonElement(m[1]),
      );
      if (parts.length === 0) continue;
      const shellIndex = parts.findIndex((p) => /(^|\/)(sh|bash)$/.test(p));
      const dashC = parts.indexOf('-c');
      if (shellIndex !== -1 && dashC === shellIndex + 1 && parts[dashC + 1] !== undefined) {
        surfaces.push({ origin: `${instruction} sh -c`, shell: parts[dashC + 1] });
        continue;
      }
      // Not a shell invocation: it may name a script we can read.
      const target = parts[0];
      if (/\.(sh|bash)$/.test(target)) {
        const script = resolveScript(dockerfile, target);
        if (script === null) unresolved.push(target);
        else
          surfaces.push({
            origin: `${instruction} script ${target}`,
            shell: readFileSync(script, 'utf8'),
          });
      }
    }

    // Shell form: CMD/ENTRYPOINT <text>  (docker wraps this in /bin/sh -c)
    const shellForm = new RegExp(`^\\s*${instruction}\\s+(?!\\[)(.+)$`, 'gmi');
    for (const match of df.matchAll(shellForm)) {
      surfaces.push({ origin: `${instruction} shell-form`, shell: match[1].trim() });
    }
  }

  return { surfaces, unresolved };
}

interface Target {
  readonly file: string;
  readonly label: string;
  readonly surfaces: Surface[];
  readonly unresolved: string[];
}

const allTargets: Target[] = findDockerfiles().map((file) => {
  const { surfaces, unresolved } = runtimeSurfaces(file);
  return {
    file,
    label: file.slice(REPO_ROOT.length + 1),
    surfaces,
    unresolved,
  };
});

/** Only Dockerfiles that actually deal with the compile cache are in scope. */
const targets = allTargets.filter(
  (target) =>
    target.surfaces.some((s) => s.shell.includes('NODE_COMPILE_CACHE')) ||
    readFileSync(target.file, 'utf8').includes('NODE_COMPILE_CACHE'),
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

/** Constructs that turn a bad cache dir into a non-zero exit. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bmkdir\b/, 'mkdir fails on a read-only mount and would abort the boot'],
  [/\brm\b/, 'removing cache contents can fail on a read-only mount'],
  [/\btest\s+-[a-z]/, 'a `test` probe on the cache dir gates the boot'],
  [/\[\s+-[a-z]/, 'a `[ -w … ]` probe on the cache dir gates the boot'],
  [/\bset\s+-[eu]/, '`set -e`/`set -u` turns any probe failure into an exit'],
  [/\bexit\b/, 'an explicit exit before the handoff is a boot gate'],
  [/\btouch\b/, 'a write probe fails on a read-only mount'],
  [/\bcd\s+["$]/, 'a `cd` into the cache dir fails when it does not exist'],
];

/**
 * Patch a surface so the handoff is observable: replace the `exec …` line with
 * a marker, or append the marker when there is none (a script that gates and
 * then runs something else must still REACH the end).
 */
function withProbe(shell: string): string {
  const probe = `exec node -e "process.stdout.write('REACHED:' + (process.env.NODE_COMPILE_CACHE || '__UNSET__'))"`;
  if (/\bexec\s/.test(shell)) return shell.replace(/exec .*$/m, probe);
  return `${shell}\n${probe}`;
}

describe('#309 the container entry never gates boot on the compile-cache dir', () => {
  it('found runtime surfaces to guard (a vacuous scan is a failed scan)', () => {
    expect(
      allTargets.length,
      'no Dockerfiles were discovered at all — the scan matched nothing',
    ).toBeGreaterThanOrEqual(2);
    expect(
      targets.length,
      'no Dockerfile deals with NODE_COMPILE_CACHE — every assertion below would pass vacuously',
    ).toBeGreaterThanOrEqual(2);
    // Every in-scope Dockerfile must have yielded at least one READABLE
    // surface. A Dockerfile that mentions the cache but whose entry we cannot
    // read is exactly the round-1 blind spot; fail rather than skip it.
    for (const target of targets) {
      expect(
        target.surfaces.length,
        `${target.label} mentions NODE_COMPILE_CACHE but no runtime shell surface was found ` +
          '(exec-form sh -c, shell form, or a resolvable script). It cannot be guarded — ' +
          'either it is a binary entry (out of scope, state it) or discovery is broken.',
      ).toBeGreaterThan(0);
      expect(
        target.unresolved,
        `${target.label} references entry script(s) that could not be resolved in the repo: ` +
          `${target.unresolved.join(', ')}. "Unreadable" must not read as "fine".`,
      ).toEqual([]);
    }
  });

  for (const target of targets) {
    it(`${target.label}: sets the cache path in an override-wins form`, () => {
      // SANCTIONED half, per Dockerfile rather than per surface: the value may
      // be set by the CMD, by an entry script, or by a plain `ENV` (which the
      // process inherits directly and an operator-injected value overrides for
      // free). Exactly one of those must be true — and when a SHELL sets it, it
      // must use `${VAR:-default}`, never `:=` or a bare assignment, or an
      // injected value would be ignored.
      const combined = target.surfaces.map((s) => s.shell).join('\n');
      const shellSets = combined.includes('NODE_COMPILE_CACHE');
      if (shellSets) {
        expect(combined).toMatch(
          /export\s+NODE_COMPILE_CACHE="?\$\{NODE_COMPILE_CACHE:-\/[^}]+\}"?/,
        );
        // The other half: the forms that silently ignore an injected value.
        expect(combined).not.toMatch(/NODE_COMPILE_CACHE:=/);
      } else {
        // No shell touches it, so the image must set it declaratively with an
        // ABSOLUTE path. Asserted rather than waved through: "not applicable"
        // is how a case goes unchecked.
        expect(
          readFileSync(target.file, 'utf8'),
          `${target.label} mentions NODE_COMPILE_CACHE but neither its entry shell nor an ENV sets it`,
        ).toMatch(/^\s*ENV\s+NODE_COMPILE_CACHE=\/\S+/m);
      }
    });

    for (const surface of target.surfaces) {
      const label = `${target.label} [${surface.origin}]`;

      it(`${label}: contains no construct that could fail the boot on a bad cache dir`, () => {
        for (const [pattern, why] of FORBIDDEN) {
          expect(pattern.test(surface.shell), `${label} contains ${pattern}: ${why}`).toBe(false);
        }
      });

      it(`${label}: still reaches its handoff with an UNWRITABLE NODE_COMPILE_CACHE`, () => {
        const patched = withProbe(surface.shell);
        expect(patched, 'the probe substitution did not apply').not.toBe(surface.shell);
        expect(patched).toContain('REACHED:');

        const cache = join(unwritableDir(), 'bytecode');
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache };
        delete env.NODE_OPTIONS; // harness artifact; keep the child clean
        const out = execFileSync('sh', ['-c', patched], { encoding: 'utf8', env }).trim();

        // Booted, with the injected (broken) value intact — the entry neither
        // aborted nor silently rewrote it.
        expect(out.split('\n').pop()).toBe(`REACHED:${cache}`);
        expect(statSync(dirname(cache)).mode & 0o200).toBe(0);
      });
    }
  }
});
