/**
 * install-smoke rewrites `workspace:^` to literal versions IN THE WORKING TREE so
 * `npm pack` ships installable manifests. It must never leave that rewrite behind:
 * a later `git commit -a` commits it. Every manifest it can touch must be
 * byte-identical afterwards, on success, on throw, on process.exit and on SIGTERM.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withManifestsRestored } from '../scripts/lib/manifest-restore.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(REPO_ROOT, 'scripts', 'lib', 'manifest-restore.mjs');
const SMOKE = join(REPO_ROOT, 'scripts', 'install-smoke.mjs');
const ROOTS = ['apps', 'packages'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake workspace with deliberately odd bytes (CRLF, no trailing newline). */
function fakeRepo(): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'manifest-restore-'));
  dirs.push(root);
  const files: string[] = [];
  const fixtures: Array<[string, string, string]> = [
    ['packages', 'core', '{\r\n  "name": "c",\r\n  "dependencies": {"l": "workspace:^"}\r\n}'],
    ['packages', 'lib', '{"name":"l","version":"1.0.0"}\n'],
    ['apps', 'web', '{"name":"w","dependencies":{"l":"workspace:*"}}\n'],
  ];
  for (const [base, name, body] of fixtures) {
    mkdirSync(join(root, base, name), { recursive: true });
    const f = join(root, base, name, 'package.json');
    writeFileSync(f, body);
    files.push(f);
  }
  return { root, files };
}

const bytes = (files: string[]) => files.map((f) => readFileSync(f).toString('hex'));
const clobber = (files: string[]) => {
  for (const f of files) writeFileSync(f, '{"rewritten":true}\n');
};

describe('manifest restore (install-smoke leaves the tree clean)', () => {
  it('restores every manifest after a successful rewrite', async () => {
    const { root, files } = fakeRepo();
    const before = bytes(files);
    await withManifestsRestored(root, ROOTS, async () => clobber(files));
    expect(bytes(files)).toEqual(before);
  });

  it('restores every manifest when the pack step throws, and rethrows', async () => {
    const { root, files } = fakeRepo();
    const before = bytes(files);
    await expect(
      withManifestsRestored(root, ROOTS, async () => {
        clobber(files);
        throw new Error('npm pack exploded');
      }),
    ).rejects.toThrow('npm pack exploded');
    expect(bytes(files)).toEqual(before);
  });

  for (const how of ['process.exit(1)', "process.kill(process.pid, 'SIGTERM')"]) {
    it(`restores when the process dies via ${how}`, () => {
      const { root, files } = fakeRepo();
      const before = bytes(files);
      const script = `
        import { guardManifests } from ${JSON.stringify(HELPER)};
        import { writeFileSync } from 'node:fs';
        guardManifests(${JSON.stringify(root)}, ${JSON.stringify(ROOTS)});
        for (const f of ${JSON.stringify(files)}) writeFileSync(f, '{"rewritten":true}\\n');
        ${how};
        setTimeout(() => {}, 5000);
      `;
      spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
      expect(bytes(files)).toEqual(before);
    });
  }

  it('a FAILED restore is loud: names the manifest on stderr and forces a non-zero exit', () => {
    const { root, files } = fakeRepo();
    const script = `
      import { guardManifests } from ${JSON.stringify(HELPER)};
      import { writeFileSync, chmodSync } from 'node:fs';
      guardManifests(${JSON.stringify(root)}, ${JSON.stringify(ROOTS)});
      for (const f of ${JSON.stringify(files)}) writeFileSync(f, '{"rewritten":true}\\n');
      chmodSync(${JSON.stringify(files[0])}, 0o444); // restore of this one will fail
      process.exit(0); // the run itself "passed"
    `;
    const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(files[0]);
    expect(r.stderr).toContain('FAILED to restore');
    // the writable ones were still restored (keep going after one failure)
    expect(readFileSync(files[1], 'utf8')).toBe('{"name":"l","version":"1.0.0"}\n');
  });

  it('install-smoke itself, run through to finish(), leaves every manifest byte-identical', () => {
    // A fixture workspace with the REAL scripts/ copied in, so the real install-smoke
    // runs its real rewrite path. KNEXT_BUN is a stub: the build step is a no-op.
    const root = mkdtempSync(join(tmpdir(), 'smoke-e2e-'));
    dirs.push(root);
    cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, '.changeset'));
    writeFileSync(join(root, '.changeset', 'config.json'), '{"ignore":[]}');
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"fx","private":true,"workspaces":["packages/*"]}',
    );
    const manifests: string[] = [];
    const mk = (dir: string, name: string, deps: Record<string, string>) => {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      const f = join(root, 'packages', dir, 'package.json');
      writeFileSync(
        f,
        `{"name":"${name}","version":"1.2.3","dependencies":${JSON.stringify(deps)}}`,
      );
      manifests.push(f);
    };
    mk('lib', '@getknext/lib', {});
    mk('db', '@getknext/db', { '@getknext/lib': 'workspace:^' });
    mk('kn-next', '@getknext/core', {
      '@getknext/lib': 'workspace:^',
      '@getknext/db': 'workspace:^',
    });
    mk('kn-next-alias', 'kn-next', { '@getknext/core': 'workspace:^' });
    const before = bytes(manifests);
    const stub = join(root, 'bun-stub.sh');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = spawnSync('node', [join(root, 'scripts', 'install-smoke.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, KNEXT_BUN: stub },
      timeout: 120_000,
    });
    // Prove the rewrite path really ran (so byte-identity is not vacuous)...
    expect(`${r.stdout}${r.stderr}`).toContain('packing');
    // ...and that it got to finish() (the fixture cannot pass the later install steps).
    expect(`${r.stdout}`).toMatch(/\[install-smoke\] (FAIL|PASS):/);
    expect(bytes(manifests)).toEqual(before);
  });

  it('install-smoke arms the guard BEFORE it rewrites workspace ranges', () => {
    const src = readFileSync(SMOKE, 'utf8');
    const guard = src.indexOf('guardManifests(');
    const rewrite = src.indexOf('rewriteWorkspaceRanges(repoRoot)');
    expect(guard).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rewrite);
  });
});
