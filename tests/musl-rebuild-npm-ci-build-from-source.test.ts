import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
 * #1426 — every npm install the musl rebuild script performs for a native
 * corpus package MUST run with `npm_config_build_from_source` EXACTLY `true`
 * in the child's environment and no argv override of it. Without it npm's
 * node-pre-gyp downloads a PREBUILT first and never checks libc, so a
 * network-connected runner "succeeds" with the GLIBC prebuilt and
 * ERR_DLOPEN_FAILED resurfaces at runtime (CI run 35862123588, the script's
 * own comment at the pinned `npm ci` sites).
 *
 * BEHAVIOUR, not text. Ten rounds of lexing the script for the flag each lost
 * to a shell/npm semantic the lexer did not model (`env -`, `env -vi`,
 * `--build_from_source=false`, repeated flags, `&`/`|` scoping, …). This test
 * instead RUNS the real script under `sh` with the system tools it needs
 * (apk, adduser, chown, su-exec, stat) stubbed and a stub `npm` first on PATH
 * that records, per invocation, its argv and the exact value of
 * `npm_config_build_from_source` in its environment. Whatever the shell does
 * with the text — `env -i`, quoting, a backgrounded statement — the recording
 * is what the real npm would have seen.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');
const LOCKFILES_DIR = resolve(REPO_ROOT, 'scripts/musl-native-lockfiles');
const FLAG = 'npm_config_build_from_source';

const STUBS: Record<string, string> = {
  apk: 'exit 0',
  adduser: 'exit 0',
  chown: 'exit 0',
  stat: 'echo 1000:1000',
  // `su-exec builder:builder <cmd...>` → run <cmd...> (drop the user spec only).
  'su-exec': 'shift\nexec "$@"',
  // Records what a real npm would have seen; creates nothing, exits 0.
  npm: [
    'f="$REC/npm.$$"',
    `printf '%s' "\${${FLAG}-<unset>}" > "$f.flag"`,
    `printf '%s\\n' "$@" > "$f.argv"`,
    'exit 0',
  ].join('\n'),
};

type Call = { flag: string; argv: string[] };

function pkg(root: string, rel: string, manifest: object) {
  const dir = join(root, 'node_modules', rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'addon.node'), '');
}

/** Runs the script (default: the real one) over a fixture tree; returns the npm calls it made. */
function run(scriptPath = SCRIPT_PATH): { status: number | null; calls: Call[]; out: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'musl-bfs-'));
  try {
    const bin = join(tmp, 'bin');
    const rec = join(tmp, 'rec');
    const root = join(tmp, 'root');
    for (const d of [bin, rec, root]) mkdirSync(d, { recursive: true });
    for (const [name, body] of Object.entries(STUBS)) {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    }
    // Reaches all three install sites: pinned sqlite3 `npm ci`, the pinned sharp +
    // libvips sibling `npm ci`s, and the fresh `npm install` fallback (no lockfile).
    pkg(root, 'sqlite3', { name: 'sqlite3', version: '5.0.2' });
    pkg(root, '@img/sharp-linux-x64', {
      name: '@img/sharp-linux-x64',
      version: '0.34.5',
      optionalDependencies: { '@img/sharp-libvips-linux-x64': '1.2.4' },
    });
    // No committed lockfile for these versions: both sharp siblings take the fresh `npm install` fallback.
    pkg(root, '@img/sharp-linux-arm64', {
      name: '@img/sharp-linux-arm64',
      version: '0.0.1',
      optionalDependencies: { '@img/sharp-libvips-linux-arm64': '0.0.1' },
    });
    pkg(root, 'nolock', { name: 'nolock', version: '1.0.0' });
    const r = spawnSync('sh', [scriptPath, root, LOCKFILES_DIR], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REC: rec },
      encoding: 'utf8',
    });
    const calls: Call[] = [];
    for (const f of readdirSync(rec).filter((n) => n.endsWith('.flag'))) {
      const base = join(rec, f.slice(0, -'.flag'.length));
      calls.push({
        flag: readFileSync(`${base}.flag`, 'utf8'),
        argv: readFileSync(`${base}.argv`, 'utf8').split('\n').slice(0, -1),
      });
    }
    return { status: r.status, calls, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The npm invocations that would NOT have built from source. */
const offenders = (calls: Call[]) =>
  calls.filter((c) => c.flag !== 'true' || c.argv.some((a) => /build.from.source/i.test(a)));

describe('the musl rebuild runs every npm install with npm_config_build_from_source=true (#1426)', () => {
  it('static anchor: exactly four run_as_builder npm ci/install invocations exist (the behaviour run below must reach all four)', () => {
    const lines = readFileSync(SCRIPT_PATH, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && /run_as_builder\b.*\bnpm\b.*\b(ci|install)\b/.test(l));
    expect(lines.length).toBe(4);
  });

  it('every npm invocation the real script makes sees the flag exactly `true` and no argv override', () => {
    const { status, calls, out } = run();
    expect(status, out).toBe(0);
    // ci: sqlite3, sharp musl, libvips musl; install: nolock, unpinned sharp musl + libvips musl.
    expect(calls.length, out).toBe(6);
    expect(calls.filter((c) => c.argv.includes('ci')).length, out).toBe(3);
    expect(calls.filter((c) => c.argv.includes('install')).length, out).toBe(3);
    expect(offenders(calls)).toEqual([]);
  });

  it('the recorder is real: an npm stub that cannot see the flag is reported as an offender', () => {
    expect(offenders([{ flag: '<unset>', argv: ['ci'] }]).length).toBe(1);
    expect(offenders([{ flag: 'false', argv: ['ci'] }]).length).toBe(1);
    expect(offenders([{ flag: '\n\ntrue', argv: ['ci'] }]).length).toBe(1);
    expect(offenders([{ flag: 'true', argv: ['ci', '--build_from_source=false'] }]).length).toBe(1);
    expect(offenders([{ flag: 'true', argv: ['ci', '--no-audit'] }])).toEqual([]);
  });
});
