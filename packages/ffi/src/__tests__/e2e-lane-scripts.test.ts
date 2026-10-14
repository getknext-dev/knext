/**
 * The e2e lane's own scripts (packages/ffi/scripts/), unit by unit:
 * - install-ffi-toolchain.sh pins exactly what the product pins
 *   (CARGO_TOOL_PINS, ZIG_PIN): a lane that installs another version proves
 *   a build users never get, or fails on the product's own version check;
 * - the fixture's deny.toml is the one `knext ffi init` writes;
 * - redis-flush.mjs empties the Redis the smoke runs against, and fails when
 *   it cannot prove the store is empty (Next caches the optimized image
 *   there, so a re-run against a warm store can pass without optimizing);
 * - shipped-image-exec.sh, the SERVER_CMD that makes the compat-smoke
 *   runner boot the SHIPPED image: the server path runs the image's own
 *   ENTRYPOINT with the runner's env, the BUN_BE_BUN --version probe runs the
 *   image's compiled executable. Driven with a fake `docker` on PATH.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CARGO_TOOL_PINS, ZIG_PIN } from '../supply-chain';

const PKG = resolve(import.meta.dirname, '../..');
const SCRIPTS = join(PKG, 'scripts');
const tmpDirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ffi-lane-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('install-ffi-toolchain.sh pins what the product pins', () => {
  const sh = readFileSync(join(SCRIPTS, 'install-ffi-toolchain.sh'), 'utf8');
  const pin = (name: string): string | undefined =>
    new RegExp(`^${name}=(\\S+)$`, 'm').exec(sh)?.[1];
  const archBlock = (arch: string): string => {
    const m = new RegExp(`\\n\\s*${arch}[^\\n]*\\)\\n([\\s\\S]*?);;`).exec(sh);
    return m?.[1] ?? '';
  };

  it('each cargo tool at the exact CARGO_TOOL_PINS version', () => {
    expect(pin('CARGO_ZIGBUILD_VERSION')).toBe(CARGO_TOOL_PINS.zigbuild.version);
    expect(pin('CARGO_DENY_VERSION')).toBe(CARGO_TOOL_PINS.deny.version);
    expect(pin('CARGO_AUDITABLE_VERSION')).toBe(CARGO_TOOL_PINS.auditable.version);
    expect(pin('CARGO_CYCLONEDX_VERSION')).toBe(CARGO_TOOL_PINS.cyclonedx.version);
  });

  it('zig at ZIG_PIN, with the same archive sha256 per Linux arch', () => {
    expect(pin('ZIG_VERSION')).toBe(ZIG_PIN.version);
    expect(archBlock('x86_64')).toContain(`zig_sha256=${ZIG_PIN.assets['linux-x86_64']?.sha256}`);
    expect(archBlock('aarch64')).toContain(`zig_sha256=${ZIG_PIN.assets['linux-aarch64']?.sha256}`);
  });

  it('cargo-auditable and cargo-cyclonedx the way the product says to (cargo install --locked --version)', () => {
    // The shell's own spelling, `${VAR}` included: the literal line the script runs.
    const line = (v: string, crate: string) =>
      `cargo install --locked --version "$\{${v}}" ${crate}`;
    expect(sh).toContain(line('CARGO_AUDITABLE_VERSION', 'cargo-auditable'));
    expect(sh).toContain(line('CARGO_CYCLONEDX_VERSION', 'cargo-cyclonedx'));
  });
});

describe('the fixture crate', () => {
  it('carries the deny.toml `knext ffi init` writes, byte for byte', () => {
    const fixture = readFileSync(join(PKG, 'fixtures/ffi-zone/rust/deny.toml'), 'utf8');
    const template = readFileSync(join(PKG, 'templates/init/rust/deny.toml'), 'utf8');
    expect(fixture).toBe(template);
  });
});

/** A RESP server answering FLUSHALL with `flushReply` and DBSIZE with `size`. */
async function fakeRedis(opts: {
  flushReply: string;
  size: number;
}): Promise<{ url: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        const cmd = /\*1\r\n\$\d+\r\n([A-Z]+)\r\n/.exec(buf);
        if (!cmd) return;
        buf = buf.slice((cmd.index ?? 0) + cmd[0].length);
        seen.push(cmd[1] as string);
        if (cmd[1] === 'FLUSHALL') sock.write(`${opts.flushReply}\r\n`);
        else if (cmd[1] === 'DBSIZE') sock.write(`:${opts.size}\r\n`);
        else sock.write('-ERR unknown\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `redis://127.0.0.1:${port}`, seen, server };
}

const flush = (env: Record<string, string | undefined>) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const p = Bun.spawn(['node', join(SCRIPTS, 'redis-flush.mjs')], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(
      ([o, e, code]) => done({ code, out: o + e }),
    );
  });

describe('redis-flush.mjs', () => {
  it('flushes, then proves the store is empty', async () => {
    const r = await fakeRedis({ flushReply: '+OK', size: 0 });
    try {
      const res = await flush({ REDIS_URL: r.url });
      expect(res.code).toBe(0);
      expect(r.seen).toEqual(['FLUSHALL', 'DBSIZE']);
    } finally {
      r.server.close();
    }
  });

  it('fails when keys survive the flush', async () => {
    const r = await fakeRedis({ flushReply: '+OK', size: 3 });
    try {
      const res = await flush({ REDIS_URL: r.url });
      expect(res.code).not.toBe(0);
      expect(res.out).toContain('3 keys');
    } finally {
      r.server.close();
    }
  });

  it('fails when FLUSHALL is refused', async () => {
    const r = await fakeRedis({ flushReply: '-ERR flushall disabled', size: 0 });
    try {
      const res = await flush({ REDIS_URL: r.url });
      expect(res.code).not.toBe(0);
      expect(res.out).toContain('flushall disabled');
    } finally {
      r.server.close();
    }
  });

  it('fails without REDIS_URL', async () => {
    const res = await flush({});
    expect(res.code).not.toBe(0);
    expect(res.out).toContain('REDIS_URL');
  });
});

describe('shipped-image-exec.sh (SERVER_CMD for the shipped image)', () => {
  const IMAGE =
    'localhost:5001/ffi-zone:t@sha256:1111111111111111111111111111111111111111111111111111111111111111';
  /** A fake docker that records its argv, one line per arg, then a blank line. */
  const withFakeDocker = () => {
    const dir = scratch();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'docker.log');
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho >> "${log}"\n`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const calls = (): string[][] =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n\n')
        .filter((c) => c.trim() !== '')
        .map((c) => c.split('\n').filter((a) => a !== ''));
    return { path: `${bin}:${process.env.PATH ?? ''}`, calls };
  };
  const run = (args: string[], env: Record<string, string>, path: string) =>
    spawnSync(join(SCRIPTS, 'shipped-image-exec.sh'), args, {
      env: { PATH: path, ...env },
      encoding: 'utf8',
    });
  const base = {
    KNEXT_SMOKE_IMAGE: IMAGE,
    KNEXT_SMOKE_IMAGE_EXEC: '/app/.next/standalone/knext-standalone-exec',
    KNEXT_SMOKE_CONTAINER: 'ffi-smoke-shipped',
    PORT: '3987',
    HOSTNAME: '0.0.0.0',
    NODE_ENV: 'production',
    REDIS_URL: 'redis://127.0.0.1:6379',
  };

  it("boots the image's own ENTRYPOINT on the host network with the runner's env", () => {
    const d = withFakeDocker();
    const r = run([], base, d.path);
    expect(r.status).toBe(0);
    const runCall = d.calls().find((c) => c[0] === 'run');
    expect(runCall).toBeDefined();
    const argv = runCall ?? [];
    expect(argv).not.toContain('--entrypoint');
    expect(argv.at(-1)).toBe(IMAGE);
    for (const want of ['--rm', '--network', 'host', '--name', 'ffi-smoke-shipped'])
      expect(argv).toContain(want);
    for (const v of ['PORT', 'HOSTNAME', 'NODE_ENV', 'REDIS_URL']) {
      expect(argv[argv.indexOf(v) - 1]).toBe('-e');
    }
  });

  it("answers the BUN_BE_BUN --version probe with the image's compiled executable", () => {
    const d = withFakeDocker();
    const r = run(['--version'], { ...base, BUN_BE_BUN: '1' }, d.path);
    expect(r.status).toBe(0);
    const argv = d.calls().find((c) => c[0] === 'run') ?? [];
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe(base.KNEXT_SMOKE_IMAGE_EXEC);
    expect(argv.slice(-2)).toEqual([IMAGE, '--version']);
    expect(argv[argv.indexOf('BUN_BE_BUN=1') - 1]).toBe('-e');
  });

  it('refuses an image that is not digest-pinned, and any argument on the server path', () => {
    const d = withFakeDocker();
    expect(
      run([], { ...base, KNEXT_SMOKE_IMAGE: 'localhost:5001/ffi-zone:t' }, d.path).status,
    ).not.toBe(0);
    expect(run(['server.js'], base, d.path).status).not.toBe(0);
    expect(d.calls().filter((c) => c[0] === 'run')).toEqual([]);
  });
});
