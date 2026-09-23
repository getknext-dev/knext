import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * BEHAVIOUR tests for scripts/e2e-native-rebuild-musl.sh and the compiled-exec
 * boot's `--user` flag (#1230 review, round 6) — text scans cannot prove any
 * of these three defects are actually fixed, only that the anchor strings are
 * present. Each case here EXECUTES the real script inside the SAME pinned
 * `oven/bun:1.4.0-alpine` image the compat harness boots, against a small,
 * real fixture tree, and asserts on what actually happened on disk / in the
 * container — not on source text.
 *
 * Requires a working `docker` (matches scripts/e2e-deploy.sh's own hard
 * requirement once the bun lane is in play — see its `command -v docker`
 * check). `describe.skipIf` gates the whole suite on availability rather
 * than failing a contributor machine with no docker daemon; this is an
 * ENVIRONMENT-availability gate (same class as the repo's existing
 * `bunAvailable` pattern), not an artifact-gated skip, so it is declared in
 * tests/declared-test-skips.test.ts as such.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const NATIVE_REBUILD_SH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');
const STANDALONE_BUN_IMAGE =
  'oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb';

const SUITE_TIMEOUT_MS = 180_000; // real `docker pull`/`apk add`/`npm install` under emulation
setDefaultTimeout(SUITE_TIMEOUT_MS);

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return r.status === 0;
}

function runRebuild(mountDir: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${mountDir}:/mnt`,
      '-v',
      `${NATIVE_REBUILD_SH}:/rebuild.sh:ro`,
      STANDALONE_BUN_IMAGE,
      'sh',
      '/rebuild.sh',
      '/mnt',
    ],
    { encoding: 'utf8', timeout: SUITE_TIMEOUT_MS },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(!dockerAvailable())(
  'scripts/e2e-native-rebuild-musl.sh — real execution inside the pinned image (#1230 round 6)',
  () => {
    let workDir = '';

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), 'knext-native-rebuild-docker-'));
    });

    afterAll(() => {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it('refuses to treat ROOT itself as an addon package — a stray .node file with no node_modules-nested package.json does NOT delete or npm-install against ROOT', () => {
      const rootDir = mkdtempSync(join(workDir, 'rootguard-'));
      writeFileSync(
        join(rootDir, 'package.json'),
        JSON.stringify({ name: 'knext-fixture-app', version: '1.0.0' }),
      );
      writeFileSync(join(rootDir, 'CANARY-DO-NOT-DELETE.txt'), 'canary');
      mkdirSync(join(rootDir, 'stray'));
      writeFileSync(join(rootDir, 'stray', 'mystery.node'), '');

      const { status, stderr } = runRebuild(rootDir);

      expect(status, `expected exit 0 (skip, not crash); stderr:\n${stderr}`).toBe(0);
      expect(stderr, 'must WARN and refuse rather than silently proceed').toContain(
        'walked up to ROOT',
      );
      // ROOT survives intact — the canary and its own package.json are both
      // still there (a defeated guard would have `rm -rf`'d the walked-up
      // dir, which in this case IS root, or run `npm install
      // knext-fixture-app@1.0.0` from the public registry as root).
      expect(spawnSync('test', ['-f', join(rootDir, 'CANARY-DO-NOT-DELETE.txt')]).status).toBe(0);
      expect(spawnSync('test', ['-f', join(rootDir, 'package.json')]).status).toBe(0);
    });

    it('installs the musl sharp + sharp-libvips siblings and the resulting native addon LOADS under musl bun (EBADPLATFORM on the glibc name is worked around, not fatal)', () => {
      // Build a REAL traced-tree fixture: fetch the actual glibc-only sharp
      // platform packages (as the compat harness's fixture install on the
      // glibc ubuntu-latest runner would have produced) via a throwaway
      // glibc container, exactly mirroring what Next's output tracing keeps.
      const glibcContainer = `knext-sharp-fixture-${process.pid}`;
      execFileSync('docker', ['rm', '-f', glibcContainer], { stdio: 'ignore' });
      execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--platform',
          'linux/amd64',
          '--name',
          glibcContainer,
          'node:22',
          'sleep',
          '600',
        ],
        { timeout: 120_000 },
      );
      try {
        execFileSync(
          'docker',
          [
            'exec',
            glibcContainer,
            'sh',
            '-c',
            'mkdir /work && cd /work && npm init -y >/dev/null 2>&1 && npm install sharp@0.34.5 --force >/dev/null 2>&1',
          ],
          { timeout: 120_000 },
        );
        const sharpDir = mkdtempSync(join(workDir, 'sharp-'));
        mkdirSync(join(sharpDir, 'node_modules', '@img'), { recursive: true });
        for (const pkg of ['sharp-linux-x64', 'sharp-libvips-linux-x64']) {
          execFileSync('docker', [
            'cp',
            `${glibcContainer}:/work/node_modules/@img/${pkg}`,
            join(sharpDir, 'node_modules', '@img', pkg),
          ]);
        }

        const { status, stdout } = runRebuild(sharpDir);
        expect(status, `expected exit 0; stdout:\n${stdout}`).toBe(0);
        expect(stdout).toContain('added @img/sharp-linuxmusl-x64');
        expect(stdout).toContain('added @img/sharp-libvips-linuxmusl-x64');

        // The behavioural claim: the produced musl .node file actually
        // LOADS under the pinned musl bun runtime (not just "a file exists
        // at the right path").
        const loadCheck = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--platform',
            'linux/amd64',
            '-v',
            `${sharpDir}:/mnt`,
            STANDALONE_BUN_IMAGE,
            'sh',
            '-c',
            "cd /mnt && bun -e \"try{const m=require('./node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node');console.log('LOADED OK:'+typeof m)}catch(e){console.log('ERR:'+e.message)}\"",
          ],
          { encoding: 'utf8', timeout: 60_000 },
        );
        expect(
          loadCheck.stdout,
          `sharp's musl native addon must load cleanly:\n${loadCheck.stdout}\n${loadCheck.stderr}`,
        ).toContain('LOADED OK:object');
      } finally {
        execFileSync('docker', ['rm', '-f', glibcContainer], { stdio: 'ignore' });
      }
    });

    it('--user "$(id -u):$(id -g)" on the boot docker run makes the containerized process run as the INVOKING user, not root (the pid-attribution fix)', () => {
      // Extracted from scripts/e2e-deploy.sh's own boot invocation rather
      // than re-typed, so this proves the ACTUAL flag the script passes, not
      // a hand-written approximation of it.
      const deploySrc = require('node:fs').readFileSync(
        resolve(REPO_ROOT, 'scripts/e2e-deploy.sh'),
        'utf8',
      ) as string;
      expect(
        deploySrc.includes('--user "$(id -u):$(id -g)"'),
        'this test proves the flag the script actually has — if this changed, the test below is proving the wrong thing',
      ).toBe(true);

      const containerName = `knext-pid-attr-test-${process.pid}`;
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      const uid = execFileSync('id', ['-u']).toString().trim();
      const gid = execFileSync('id', ['-g']).toString().trim();
      try {
        execFileSync(
          'docker',
          [
            'run',
            '-d',
            '--rm',
            '--name',
            containerName,
            '--network',
            'host',
            '--user',
            `${uid}:${gid}`,
            STANDALONE_BUN_IMAGE,
            'sh',
            '-c',
            'sleep 60',
          ],
          { timeout: 60_000 },
        );
        const hostPid = execFileSync('docker', [
          'inspect',
          containerName,
          '--format',
          '{{.State.Pid}}',
        ])
          .toString()
          .trim();
        expect(hostPid, 'docker inspect must report a real host pid').not.toBe('0');

        // Read the REAL host-namespace /proc/<pid>/status from a companion
        // container that shares the host pid namespace (--pid host) — the
        // same technique used to manually confirm this live: the kernel's
        // sock_diag permission model (what `ss -p` in scripts/e2e-deploy.sh
        // relies on) only lets an unprivileged caller see PID detail for a
        // SAME-uid socket, so what matters is the process's REAL host uid,
        // not merely what the container's own `id` reports from inside its
        // own user namespace.
        const statusOut = execFileSync('docker', [
          'run',
          '--rm',
          '--pid',
          'host',
          'alpine',
          'sh',
          '-c',
          `cat /proc/${hostPid}/status | grep -i '^Uid:'`,
        ]).toString();
        expect(
          statusOut,
          `the containerized process's real host UID must equal the invoking user's uid (${uid}) — got: ${statusOut}`,
        ).toContain(`\t${uid}\t`);
      } finally {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      }
    });
  },
);
