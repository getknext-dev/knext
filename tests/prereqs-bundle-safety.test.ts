import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const script = join(ROOT, 'scripts/prereqs/install.sh');
const bash = Bun.which('bash') as string;

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// Fake kubectl logs its args, answers the ingress-class / current-context
// queries, and probes `sha256sum` so the checksum shim is observable.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'prereqs-'));
  tempRoots.push(dir);
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'kubectl'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *jsonpath*) echo kourier.ingress.networking.knative.dev;; *current-context*) echo ambient-ctx;; esac\nsha256sum -c - </dev/null >/dev/null 2>&1\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'shasum'), `#!/bin/sh\necho "shasum $@" >> "${log}"\nexit 0\n`, {
    mode: 0o755,
  });
  for (const t of ['curl', 'jq'])
    writeFileSync(join(dir, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { dir, log, env: { PATH: `${dir}:${process.env.PATH}` } as Record<string, string> };
}

const run = (args: string[], env: Record<string, string>) =>
  spawnSync(bash, [script, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });

describe('prerequisite bundle safety', () => {
  it('refuses a non-interactive run without --context or --yes', () => {
    const s = sandbox();
    const r = run(['--verify'], s.env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--context');
    expect(existsSync(s.log)).toBe(false); // never touched the cluster
    rmSync(s.dir, { recursive: true });
  });

  it('--context is passed to every kubectl call and printed', () => {
    const s = sandbox();
    const r = run(['--verify', '--context', 'target-a'], s.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('target kubectl context: target-a');
    const calls = readFileSync(s.log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.startsWith('--context target-a ')).toBe(true);
    rmSync(s.dir, { recursive: true });
  });

  it('--yes uses and prints the current context', () => {
    const s = sandbox();
    const r = run(['--verify', '--yes'], s.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('target kubectl context: ambient-ctx');
    rmSync(s.dir, { recursive: true });
  });

  it('falls back to shasum -a 256 when sha256sum is unavailable', () => {
    const s = sandbox();
    const r = run(['--verify', '--yes'], { ...s.env, PREREQS_FORCE_SHA_FALLBACK: '1' });
    expect(r.status).toBe(0);
    expect(readFileSync(s.log, 'utf8')).toContain('shasum -a 256 -c -');
    rmSync(s.dir, { recursive: true });
  });

  it('fails with a clear message when neither checksum tool exists', () => {
    const s = sandbox();
    rmSync(join(s.dir, 'shasum'));
    const bin = join(s.dir, 'bin');
    mkdirSync(bin);
    for (const t of ['bash', 'dirname', 'mktemp', 'rm', 'cat', 'sh', 'chmod', 'printf']) {
      const p = Bun.which(t);
      if (p) symlinkSync(p, join(bin, t));
    }
    for (const t of ['kubectl', 'curl', 'jq']) symlinkSync(join(s.dir, t), join(bin, t));
    const r = run(['--verify', '--yes'], { PATH: bin });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('neither sha256sum nor shasum');
    rmSync(s.dir, { recursive: true });
  });
});
