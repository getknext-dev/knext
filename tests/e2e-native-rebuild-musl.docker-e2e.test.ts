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
 * `oven/bun:1.4.2-alpine` image the compat harness boots, against a small,
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
const LOCKFILE_LOOKUP_SH = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');
const LOCKFILES_DIR = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles');
const STANDALONE_BUN_IMAGE =
  'oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f';

const SUITE_TIMEOUT_MS = 240_000; // real `docker pull`/`apk add`/`npm install` under emulation
setDefaultTimeout(SUITE_TIMEOUT_MS);

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return r.status === 0;
}

function runRebuild(
  mountDir: string,
  timeoutMs: number = SUITE_TIMEOUT_MS,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      // The pinned image publishes a multi-arch manifest; the compat harness
      // always runs on amd64 CI runners, and the sharp/libvips packages below
      // are fetched by an explicit x64 spec. Without pinning the platform, a
      // local arm64 host (OrbStack/Docker Desktop on Apple Silicon) silently
      // resolves the arm64 variant instead, and an x64-targeted musl install
      // then fails EBADPLATFORM for an arch reason unrelated to what this
      // test is proving — reproduced directly on this machine.
      '--platform',
      'linux/amd64',
      '-v',
      `${mountDir}:/mnt`,
      '-v',
      `${NATIVE_REBUILD_SH}:/rebuild.sh:ro`,
      // #1257 — the lookup helpers rebuild.sh sources (`. "$(dirname "$0")/lib/..."`,
      // so `/rebuild.sh`'s dirname `/` is where it looks).
      '-v',
      `${LOCKFILE_LOOKUP_SH}:/lib/musl-lockfile-lookup.sh:ro`,
      // #1257 — mounted so the script can `npm ci` against a committed,
      // reproducible lockfile for a known name@version (real for THIS
      // suite's sharp fixture) instead of a fresh, unpinned `npm install`.
      '-v',
      `${LOCKFILES_DIR}:/musl-native-lockfiles:ro`,
      STANDALONE_BUN_IMAGE,
      'sh',
      '/rebuild.sh',
      '/mnt',
      '/musl-native-lockfiles',
    ],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(!dockerAvailable())(
  'scripts/e2e-native-rebuild-musl.sh — real execution inside the pinned image (#1230 round 6)',
  () => {
    let tmpDir = '';
    // Registry pattern (D9, tests/temp-dirs-outside-the-repo.test.ts): every
    // NESTED mkdtempSync below is pushed here and drained in afterAll, rather
    // than relying on the top-level tmpDir's own recursive removal to cover
    // them implicitly — the D9 guard pairs removals per call SITE, not per
    // directory tree, so an only-covered-transitively nested mkdtempSync
    // reads as an unpaired leak. Kept as two literal statements (mkdtempSync
    // call, then a separate push) rather than a wrapper function — a wrapper
    // breaks the D9 guard's OTHER check, which requires each mkdtempSync
    // call's own argument to be traceably rooted at tmpdir()/join(tmpDir,
    // ...) at the call site, not behind a parameter.
    const temps: string[] = [];

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'knext-native-rebuild-docker-'));
    });

    afterAll(() => {
      for (const dir of temps) rmSync(dir, { recursive: true, force: true });
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('refuses to treat ROOT itself as an addon package — a stray .node file with no node_modules-nested package.json does NOT delete or npm-install against ROOT', () => {
      const rootDir = mkdtempSync(join(tmpDir, 'rootguard-'));
      temps.push(rootDir);
      writeFileSync(
        join(rootDir, 'package.json'),
        JSON.stringify({ name: 'knext-fixture-app', version: '1.0.0' }),
      );
      writeFileSync(join(rootDir, 'CANARY-DO-NOT-DELETE.txt'), 'canary');
      mkdirSync(join(rootDir, 'stray'));
      writeFileSync(join(rootDir, 'stray', 'mystery.node'), '');

      const { status, stdout, stderr } = runRebuild(rootDir);

      expect(status, `expected exit 0 (skip, not crash); stderr:\n${stderr}`).toBe(0);
      // The script's own WARNING is an `echo` inside the container — that is
      // the container's STDOUT, which `docker run` forwards to the docker
      // CLI's own stdout. `stderr` here only ever carries DOCKER's own
      // noise (image-pull progress, the base image's ICU notice) — checking
      // it for the script's warning is a real bug found live on CI (job
      // 107269307255): a well-formed `docker run` never wrote the warning to
      // stderr, so the assertion always failed regardless of whether the
      // guard actually fired, which local manual replays never caught since
      // a terminal interleaves both streams.
      expect(
        stdout,
        `must WARN and refuse rather than silently proceed; stdout:\n${stdout}`,
      ).toContain('walked up to ROOT');
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
      // glibc ubuntu-latest runner would have produced, and exactly what
      // Next's output tracing keeps) directly from the registry via `npm
      // pack --force` on the HOST — no throwaway container needed just to
      // fetch two tarballs, and no host-platform dependency since `--force`
      // bypasses npm's own os/cpu/libc engine check (the same check that
      // makes an UNFORCED install of these exact packages fail).
      const packDir = mkdtempSync(join(tmpDir, 'sharp-pack-'));
      temps.push(packDir);
      for (const spec of ['@img/sharp-linux-x64@0.34.5', '@img/sharp-libvips-linux-x64@1.2.4']) {
        // --loglevel=error / stdio: 'ignore': the runner's failure-tail
        // (scripts/bun-test.mjs) captures the LAST 40 lines of the WHOLE
        // process's output, shared across every test in this describe block
        // — npm's verbose "npm notice" pack-manifest dump here can push an
        // EARLIER test's own failure message out of that window entirely
        // (observed live on CI: this test's own tarball fetch is what buried
        // the ROOT-guard test's real error). Silenced since we only care
        // about the tarball landing on disk, not npm's report about it.
        execFileSync('npm', ['pack', spec, '--force', '--loglevel=error'], {
          cwd: packDir,
          timeout: 60_000,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      }
      const sharpDir = mkdtempSync(join(tmpDir, 'sharp-'));
      temps.push(sharpDir);
      mkdirSync(join(sharpDir, 'node_modules', '@img'), { recursive: true });
      for (const [tarball, pkg] of [
        ['img-sharp-linux-x64-0.34.5.tgz', 'sharp-linux-x64'],
        ['img-sharp-libvips-linux-x64-1.2.4.tgz', 'sharp-libvips-linux-x64'],
      ]) {
        const extractDir = mkdtempSync(join(tmpDir, 'extract-'));
        temps.push(extractDir);
        execFileSync('tar', ['xzf', join(packDir, tarball), '-C', extractDir]);
        execFileSync('cp', [
          '-a',
          join(extractDir, 'package'),
          join(sharpDir, 'node_modules', '@img', pkg),
        ]);
      }

      const { status, stdout } = runRebuild(sharpDir, 340_000);
      expect(status, `expected exit 0; stdout:\n${stdout}`).toBe(0);
      expect(stdout).toContain('added @img/sharp-linuxmusl-x64');
      expect(stdout).toContain('added @img/sharp-libvips-linuxmusl-x64');
      // #1257 — this exact name@version (0.34.5 / 1.2.4) has a COMMITTED
      // lockfile under scripts/musl-native-lockfiles/, so both installs must
      // take the reproducible `npm ci` path, never the fresh/unpinned one.
      expect(stdout).toContain(
        '@img/sharp-linuxmusl-x64@0.34.5: using the committed, reproducible lockfile',
      );
      expect(stdout).toContain(
        '@img/sharp-libvips-linuxmusl-x64@1.2.4: using the committed, reproducible lockfile',
      );
      expect(stdout).not.toContain('fresh (non-reproducible');

      // The behavioural claim: the produced musl .node file actually LOADS
      // under the pinned musl bun runtime (not just "a file exists at the
      // right path").
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
    }, 360_000);

    // #1257 round 7 — install scripts (and node-gyp/npm itself) must never
    // run as root inside the container. Extracts the REAL `apk add` /
    // `adduser` / `chown` lines this script uses to set up its unprivileged
    // `builder` user (not a hand-retyped approximation of them — same
    // philosophy as the `--user` extraction below), runs them for real
    // inside the pinned image, then proves `su-exec builder ...` actually
    // drops to a non-root uid: both what the exec'd process itself reports
    // (`id -u`) and the numeric owner of a file it creates.
    it("the builder user this script su-exec's into is genuinely non-root, using the script's OWN setup lines", () => {
      const scriptSrc = require('node:fs').readFileSync(NATIVE_REBUILD_SH, 'utf8') as string;
      const apkLine = scriptSrc
        .split('\n')
        .find((l) =>
          l.includes('apk add --no-cache python3~3.12 make~4.4 g++~14.2 npm~11.6 su-exec~0.2'),
        );
      const adduserLine = scriptSrc.split('\n').find((l) => l.trim().startsWith('adduser -D -H'));
      const chownLine = scriptSrc
        .split('\n')
        .find((l) => l.includes('chown -R builder:builder "${BUILD_HOME}"'));
      expect(
        apkLine,
        'the apk add line must still exist verbatim — this test proves it, not a copy',
      ).toBeTruthy();
      expect(
        adduserLine,
        'the adduser line must still exist verbatim — this test proves it, not a copy',
      ).toBeTruthy();
      expect(
        chownLine,
        'the chown line must still exist verbatim — this test proves it, not a copy',
      ).toBeTruthy();

      const setupScript = [
        'set -eu',
        apkLine,
        'BUILD_HOME="$(mktemp -d)"',
        adduserLine,
        chownLine,
        'su-exec builder:builder id -u',
        "su-exec builder:builder sh -c 'touch /tmp/marker-file'",
        'ls -ln /tmp/marker-file',
      ].join('\n');

      const r = spawnSync(
        'docker',
        ['run', '--rm', '--platform', 'linux/amd64', STANDALONE_BUN_IMAGE, 'sh', '-c', setupScript],
        { encoding: 'utf8', timeout: 90_000 },
      );
      expect(r.status, `expected exit 0; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
      const reportedUid = r.stdout.trim().split('\n')[0];
      expect(reportedUid, `su-exec'd process must NOT report uid 0:\n${r.stdout}`).not.toBe('0');
      expect(
        Number(reportedUid),
        'the reported uid must be a real positive integer',
      ).toBeGreaterThan(0);
      // `ls -ln` prints the numeric uid/gid as the 3rd/4th field — the file
      // the su-exec'd process CREATED must be owned by that same non-root
      // uid, not root (proves the drop applied to the actual filesystem
      // operation, not just what `id` self-reports).
      const lsLine = r.stdout.trim().split('\n').at(-1) ?? '';
      const fileOwnerUid = lsLine.split(/\s+/)[2];
      expect(fileOwnerUid, `file owner uid from: ${lsLine}`).toBe(reportedUid);
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
          // Digest-pinned (security.md: pin by digest, reject :latest) — reuse
          // the same image already in scope rather than pulling a second,
          // unpinned one just to run `cat` + `grep`.
          STANDALONE_BUN_IMAGE,
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
