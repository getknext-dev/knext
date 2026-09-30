import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #1620 — the bun lane's musl-rebuild lockfile mounts are DERIVED from the
 * native addons the app actually resolved, never hardcoded to one sharp
 * version. The rc.2 bun credential cells went 16/16 red because Next 16.3.5
 * resolved sharp 0.35.5 while scripts/e2e-deploy.sh bind-mounted only the
 * 0.34.5 / libvips 1.2.4 lockfiles, and credential mode (correctly) refuses
 * the non-reproducible fallback install.
 *
 * Every case runs the REAL shell code — the lib functions via `sh`, and the
 * e2e-deploy.sh §3b–3d section sliced verbatim and run under `bash` with a
 * stubbed docker — never a TypeScript re-derivation of it.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const LIB_SH = resolve(REPO_ROOT, 'scripts/lib/musl-lockfile-lookup.sh');
const LOCKFILES = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');

const tmps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A synthetic standalone tree carrying a glibc sharp platform package. */
function sharpTree(root: string, sharp: string, libvips: string, extra?: [string, string]) {
  const pkg = join(root, 'node_modules', '@img', 'sharp-linux-x64');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'lib', `sharp-linux-x64-${sharp}.node`), '');
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@img/sharp-linux-x64',
      version: sharp,
      optionalDependencies: { '@img/sharp-libvips-linux-x64': libvips },
    }),
  );
  // Next's output tracing emits a package.json at the standalone root too —
  // it must never be read as an addon.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
  if (extra) {
    const [name, version] = extra;
    const d = join(root, 'node_modules', name);
    mkdirSync(join(d, 'build', 'Release'), { recursive: true });
    writeFileSync(join(d, 'build', 'Release', 'binding.node'), '');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version }));
  }
}

function sh(script: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', ['-c', `. "${LIB_SH}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, KNEXT_COMPAT_MODE: '', ...env },
  });
  return { status: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr };
}

describe('musl_lockfile_specs_for_root: the pins the rebuild will look up, from the resolved tree', () => {
  it('maps a glibc sharp to its musl sibling + the libvips version sharp itself pins', () => {
    const root = tmp('musl-specs-');
    sharpTree(root, '0.35.5', '1.3.4', ['sqlite3', '5.0.2']);
    const r = sh(`musl_lockfile_specs_for_root '${root}'`);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      '@img/sharp-libvips-linuxmusl-x64 1.3.4',
      '@img/sharp-linuxmusl-x64 0.35.5',
      'sqlite3 5.0.2',
    ]);
  });

  it('prints nothing for a tree with no native addons', () => {
    const root = tmp('musl-specs-empty-');
    writeFileSync(join(root, 'package.json'), '{"name":"app","version":"1.0.0"}');
    const r = sh(`musl_lockfile_specs_for_root '${root}'`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('musl_lockfile_mounts: mounts exactly the committed lockfiles the tree needs', () => {
  it('sharp 0.35.5 (Next 16.3.5) mounts the committed 0.35.5 + libvips 1.3.4 lockfiles', () => {
    const root = tmp('musl-mounts-');
    sharpTree(root, '0.35.5', '1.3.4');
    const r = sh(`musl_lockfile_mounts '${root}' '${LOCKFILES}' /musl-native-lockfiles`, {
      KNEXT_COMPAT_MODE: 'credential',
    });
    expect(r.status, r.stderr).toBe(0);
    const want = [
      'img-sharp-libvips-linuxmusl-x64-1.3.4/package.json',
      'img-sharp-libvips-linuxmusl-x64-1.3.4/package-lock.json',
      'img-sharp-linuxmusl-x64-0.35.5/package.json',
      'img-sharp-linuxmusl-x64-0.35.5/package-lock.json',
    ].map((f) => `${LOCKFILES}/${f}:/musl-native-lockfiles/${f}:ro`);
    expect(r.stdout.split('\n')).toEqual(want);
  });

  it('the older sharp 0.34.5 still resolves to its own committed pair', () => {
    const root = tmp('musl-mounts-old-');
    sharpTree(root, '0.34.5', '1.2.4');
    const r = sh(`musl_lockfile_mounts '${root}' '${LOCKFILES}' /c`, {
      KNEXT_COMPAT_MODE: 'credential',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('img-sharp-linuxmusl-x64-0.34.5/package-lock.json');
    expect(r.stdout).toContain('img-sharp-libvips-linuxmusl-x64-1.2.4/package-lock.json');
    expect(r.stdout).not.toContain('0.35.5');
  });

  it('credential mode FAILS CLOSED on an uncommitted version, naming the missing lockfile dir', () => {
    const root = tmp('musl-mounts-miss-');
    sharpTree(root, '0.99.0', '9.9.9');
    const r = sh(`musl_lockfile_mounts '${root}' '${LOCKFILES}' /c`, {
      KNEXT_COMPAT_MODE: 'credential',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${LOCKFILES}/img-sharp-linuxmusl-x64-0.99.0/`);
    expect(r.stderr).toContain(`${LOCKFILES}/img-sharp-libvips-linuxmusl-x64-9.9.9/`);
    expect(r.stderr).toContain('generate-musl-native-lockfile.sh @img/sharp-linuxmusl-x64 0.99.0');
  });

  it('early-warning mode warns and omits the missing pin (the rebuild falls back), exit 0', () => {
    const root = tmp('musl-mounts-ew-');
    sharpTree(root, '0.99.0', '1.3.4');
    const r = sh(`musl_lockfile_mounts '${root}' '${LOCKFILES}' /c`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('img-sharp-linuxmusl-x64-0.99.0/');
    expect(r.stdout.split('\n')).toEqual([
      `${LOCKFILES}/img-sharp-libvips-linuxmusl-x64-1.3.4/package.json:/c/img-sharp-libvips-linuxmusl-x64-1.3.4/package.json:ro`,
      `${LOCKFILES}/img-sharp-libvips-linuxmusl-x64-1.3.4/package-lock.json:/c/img-sharp-libvips-linuxmusl-x64-1.3.4/package-lock.json:ro`,
    ]);
  });
});

// ── scripts/e2e-deploy.sh wiring ────────────────────────────────────────────
const SECTION_START = '    # ── 3c. rebuild native (*.node) addons for musl';
const SECTION_END = '    # ── 3c-ii. the empty-dir lane check';

function runRebuildSection(opts: { sharp: string; libvips: string; lockfiles: string }) {
  const src = readFileSync(DEPLOY_SH, 'utf8');
  const start = src.indexOf(SECTION_START);
  const end = src.indexOf(SECTION_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('the §3c section markers are missing from scripts/e2e-deploy.sh');
  }
  expect(src.indexOf(SECTION_START, start + 1), 'start anchor unique').toBe(-1);
  expect(src.indexOf(SECTION_END, end + 1), 'end anchor unique').toBe(-1);
  const t = tmp('musl-deploy-');
  const bin = join(t, 'bin');
  const rec = join(t, 'rec');
  const scriptDir = join(t, 'scripts');
  const root = join(t, 'standalone');
  for (const d of [bin, rec, join(scriptDir, 'lib'), root]) mkdirSync(d, { recursive: true });
  cpSync(LIB_SH, join(scriptDir, 'lib', 'musl-lockfile-lookup.sh'));
  cpSync(opts.lockfiles, join(scriptDir, 'musl-native-lockfiles'), { recursive: true });
  sharpTree(root, opts.sharp, opts.libvips);
  const docker = join(bin, 'docker');
  writeFileSync(docker, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$REC/argv"\nexit 0\n');
  chmodSync(docker, 0o755);
  const wrapper = [
    'set -euo pipefail',
    'log() { echo "[t] $*" >&2; }',
    `SCRIPT_DIR='${scriptDir}'`,
    `STANDALONE_ROOT='${root}'`,
    `STANDALONE_BUN_IMAGE='oven/bun@sha256:test'`,
    'KNEXT_COMPAT_MODE=credential',
    src.slice(start, end),
    'echo SECTION_DONE',
  ].join('\n');
  const w = join(t, 'wrapper.sh');
  writeFileSync(w, wrapper);
  const r = spawnSync('bash', [w], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REC: rec },
  });
  const argvFile = join(rec, 'argv');
  const argv = existsSync(argvFile)
    ? readFileSync(argvFile, 'utf8').split('\n').slice(0, -1)
    : null;
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, argv, scriptDir };
}

describe('scripts/e2e-deploy.sh mounts the lockfiles for the sharp the app resolved (#1620)', () => {
  it('credential + sharp 0.35.5: docker mounts the committed 0.35.5 and libvips 1.3.4 lockfiles', () => {
    const r = runRebuildSection({ sharp: '0.35.5', libvips: '1.3.4', lockfiles: LOCKFILES });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('SECTION_DONE');
    const argv = r.argv ?? [];
    const mounts = argv.flatMap((w, i) => (w === '-v' ? [argv[i + 1]] : []));
    const lockMounts = mounts.filter((m) => m.includes('/musl-native-lockfiles/'));
    expect(lockMounts.sort()).toEqual(
      [
        'img-sharp-libvips-linuxmusl-x64-1.3.4/package-lock.json',
        'img-sharp-libvips-linuxmusl-x64-1.3.4/package.json',
        'img-sharp-linuxmusl-x64-0.35.5/package-lock.json',
        'img-sharp-linuxmusl-x64-0.35.5/package.json',
      ].map((f) => `${r.scriptDir}/musl-native-lockfiles/${f}:/musl-native-lockfiles/${f}:ro`),
    );
    expect(argv.slice(-4)).toEqual([
      'sh',
      '/e2e-native-rebuild-musl.sh',
      argv[argv.length - 2],
      '/musl-native-lockfiles',
    ]);
  });

  it('credential + a sharp with no committed lockfile: fails BEFORE docker runs, naming the lockfile', () => {
    const partial = tmp('musl-partial-');
    for (const d of readdirSync(LOCKFILES)) {
      if (d !== 'img-sharp-linuxmusl-x64-0.35.5')
        cpSync(join(LOCKFILES, d), join(partial, d), { recursive: true });
    }
    const r = runRebuildSection({ sharp: '0.35.5', libvips: '1.3.4', lockfiles: partial });
    expect(r.status).not.toBe(0);
    expect(r.argv, 'docker must not run').toBeNull();
    expect(r.out).not.toContain('SECTION_DONE');
    expect(r.out).toContain('musl-native-lockfiles/img-sharp-linuxmusl-x64-0.35.5/');
  });

  it('no version-specific lockfile mount is hardcoded in e2e-deploy.sh any more', () => {
    const src = readFileSync(DEPLOY_SH, 'utf8');
    expect(src).not.toMatch(/musl-native-lockfiles\/[a-z0-9-]+-\d+\.\d+\.\d+\//);
  });
});
