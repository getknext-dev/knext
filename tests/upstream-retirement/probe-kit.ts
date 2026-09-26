/**
 * Helpers for the upstream-retirement probes (#1450).
 *
 * Every probe is a real run of the PINNED toolchain: it writes a tiny fixture
 * into a fresh temp dir, compiles it with the `bun` on PATH (asserted equal to
 * the repo's Bun pin by retirement.test.ts), runs the result, and reads one
 * `RESULT …` line from stdout. No network, no shared state: the temp dir is
 * also the spawned process's TMPDIR, so anything Bun extracts at runtime (a
 * `.node` addon) lands there and is removed with it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The Bun pin, read from its single source of truth (`tests/bun-version-pins.test.ts`). */
export function pinnedBunVersion(): string {
  const src = readFileSync(join(REPO_ROOT, 'tests/bun-version-pins.test.ts'), 'utf8');
  const hits = [...src.matchAll(/^const PINNED_BUN = '(\d+\.\d+\.\d+)';$/gm)];
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one \`const PINNED_BUN = 'x.y.z';\` in tests/bun-version-pins.test.ts, found ${hits.length}`,
    );
  }
  return hits[0][1];
}

/** The `bun` on PATH — the binary every probe runs. */
export function bunOnPath(): string {
  const bun = Bun.which('bun');
  if (!bun) throw new Error('no `bun` on PATH — the retirement probes run the pinned Bun');
  return bun;
}

export function bunVersionOf(bun: string): string {
  const r = spawnSync(bun, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`\`${bun} --version\` exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The vinext `@getknext/core` pins, and the directory of the installed copy. */
export function pinnedVinext(): { pin: string; installed: string; dir: string } {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/kn-next/package.json'), 'utf8'));
  const pin =
    pkg.dependencies?.vinext ?? pkg.devDependencies?.vinext ?? pkg.peerDependencies?.vinext;
  const dir = dirname(Bun.resolveSync('vinext/package.json', join(REPO_ROOT, 'packages/kn-next')));
  const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  return { pin, installed, dir };
}

export type Sandbox = {
  dir: string;
  /** Write `files` (relative path → contents) under `sub`. */
  write: (files: Record<string, string>, sub?: string) => void;
  copy: (from: string, toRel: string) => void;
  /** Run `cmd` with the sandbox as TMPDIR; returns the `RESULT …` line (or throws). */
  run: (
    cmd: string[],
    cwd: string,
    env?: Record<string, string>,
  ) => { result: string; output: string };
  /**
   * `Bun.build(<options>)` in a child of the pinned Bun, with `<sandbox>/<sub>`
   * as cwd. `options` is a JS object literal (source text).
   */
  compile: (
    sub: string,
    options: string,
  ) => { status: 'built' | 'failed' | 'threw'; detail: string };
  dispose: () => void;
};

export function sandbox(name: string): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), `knext-retire-${name}-`));
  const bun = bunOnPath();
  const write: Sandbox['write'] = (files, sub = '') => {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, sub, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  };
  const run: Sandbox['run'] = (cmd, cwd, env = {}) => {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: dir, ...env },
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) {
      throw new Error(
        `probe inconclusive: \`${cmd.join(' ')}\` (exit ${r.status}) printed no RESULT line:\n${output.slice(0, 800)}`,
      );
    }
    return { result: line.slice('RESULT '.length), output };
  };
  return {
    dir,
    write,
    copy: (from, toRel) => {
      const to = join(dir, toRel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    },
    run,
    compile: (sub, options) => {
      const script =
        `let line;\n` +
        `try { const r = await Bun.build(${options}); line = r.success ? "built" : "failed " + r.logs.map(String).join(" | "); }\n` +
        `catch (e) { line = "threw " + String(e?.message ?? e).split("\\n")[0]; }\n` +
        `console.log("RESULT " + line);\n`;
      write({ '.probe-build.mjs': script }, sub);
      const { result } = run([bun, '.probe-build.mjs'], join(dir, sub));
      const status = result === 'built' ? 'built' : result.startsWith('threw') ? 'threw' : 'failed';
      return { status, detail: result };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
