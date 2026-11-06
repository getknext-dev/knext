import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A transient upstream 5xx (GitHub release-asset 504) during a kind manifest
 * fetch used to fail the whole job at the first attempt. The two fetch scripts
 * now retry with a bounded budget, while the checksum check after the download
 * is untouched.
 *
 * The scripts hard-code github.com URLs (they are checksum-pinned to ONE
 * release), so this spec does not add a URL seam to them. Instead it puts a
 * `curl` shim on PATH that rewrites the github.com host to a local fake server
 * and then runs the REAL curl with every other argument unchanged, so the real
 * script flags are exercised against real curl retry behaviour. kubectl/kind
 * and friends are stubbed to fail loudly: nothing real is touched.
 */

const ROOT = join(import.meta.dirname, '..');
const CERT_MANAGER_SCRIPT = 'scripts/kind-manifests/apply-cert-manager.sh';
const KNATIVE_SCRIPT = 'scripts/kind-manifests/apply-knative-kourier.sh';

const REAL_CURL = ['/usr/bin/curl', '/usr/local/bin/curl', '/bin/curl'].find((p) => existsSync(p));

// GNU coreutils prints `FAILED`; the macOS sha256sum prints `did NOT match`.
const CHECKSUM_REJECTED = /FAILED|did NOT match/;

type Mode = { failFirst: number; status: number; reset?: boolean };
let server: Server;
let port = 0;
let mode: Mode = { failFirst: 0, status: 504 };
let requests = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests += 1;
    if (requests <= mode.failFirst) {
      if (mode.reset) {
        // Drop the connection mid-request: curl exit 52/56, not an HTTP status.
        _req.socket.destroy();
        return;
      }
      res.statusCode = mode.status;
      res.end('upstream error');
      return;
    }
    // Deliberately NOT the pinned release bytes: a retried fetch that
    // succeeds must still be stopped by the checksum, never applied.
    res.statusCode = 200;
    res.end('not-the-pinned-manifest\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

async function run(script: string, args: string[], m: Mode) {
  mode = m;
  requests = 0;
  const dir = mkdtempSync(join(tmpdir(), 'kind-fetch-retry-'));
  try {
    for (const tool of ['kind', 'kubectl', 'docker', 'go', 'wget', 'bun']) {
      writeFileSync(join(dir, tool), `#!/bin/sh\necho "STUB ${tool} $*" >&2\nexit 97\n`);
      chmodSync(join(dir, tool), 0o755);
    }
    writeFileSync(
      join(dir, 'curl'),
      [
        '#!/bin/bash',
        'args=()',
        'for a in "$@"; do',
        '  case "$a" in',
        `    https://github.com/*) a="http://127.0.0.1:${port}/\${a#https://github.com/}" ;;`,
        '  esac',
        '  args+=("$a")',
        'done',
        `exec ${REAL_CURL} "\${args[@]}"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'curl'), 0o755);
    const child = spawn('bash', [join(ROOT, script), ...args], {
      cwd: ROOT,
      env: {
        PATH: `${dir}:/usr/bin:/bin:/sbin`,
        HOME: tmpdir(),
        TMPDIR: dir,
        // 0 means curl's own exponential backoff (up to 16 s a try), so use a short fixed delay.
        KIND_MANIFEST_RETRY_DELAY: '1',
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const status = await new Promise<number | null>((r) => child.on('close', r));
    return { status, stderr, requests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SCRIPTS: Array<[string, string[]]> = [
  [CERT_MANAGER_SCRIPT, []],
  [KNATIVE_SCRIPT, ['knative-v1.16.0']],
];

describe('kind manifest downloads retry a transient upstream 5xx', () => {
  it('has a real, working curl to drive', () => {
    expect(REAL_CURL).toBeDefined();
    const v = spawnSync(REAL_CURL as string, ['--version'], { encoding: 'utf8' });
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/^curl \d/);
  });

  for (const [script, args] of SCRIPTS) {
    it(`${script}: two 504s then a 200 is retried through to the checksum stage`, async () => {
      const r = await run(script, args, { failFirst: 2, status: 504 });
      // Three requests: the two failures were retried and the third succeeded.
      expect(r.requests).toBe(3);
      // It got as far as the checksum (which rejects the fake bytes), not a curl HTTP error.
      expect(r.stderr).toMatch(CHECKSUM_REJECTED);
      // ...and the checksum failure stopped the script before anything was applied.
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 30_000);

    it(`${script}: an upstream that always 504s still exits non-zero after a bounded number of tries`, async () => {
      const r = await run(script, args, { failFirst: Number.MAX_SAFE_INTEGER, status: 504 });
      // curl's own HTTP-error exit code propagates through `set -e`.
      expect(r.status).toBe(22);
      expect(r.requests).toBeGreaterThan(1);
      expect(r.requests).toBeLessThanOrEqual(10);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 30_000);

    it(`${script}: a retried-then-successful download with wrong bytes is NOT applied (checksum unchanged)`, async () => {
      const r = await run(script, args, { failFirst: 1, status: 503 });
      expect(r.requests).toBe(2);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(CHECKSUM_REJECTED);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 30_000);

    it(`${script}: a 404 is NOT retried (exactly one request, non-zero exit)`, async () => {
      const r = await run(script, args, { failFirst: Number.MAX_SAFE_INTEGER, status: 404 });
      expect(r.requests).toBe(1);
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 30_000);

    it(`${script}: a connection reset is retried and then succeeds (to the checksum stage)`, async () => {
      const r = await run(script, args, { failFirst: 2, status: 0, reset: true });
      expect(r.requests).toBe(3);
      expect(r.stderr).toMatch(CHECKSUM_REJECTED);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 60_000);

    it(`${script}: an endless connection reset still ends non-zero within the bound`, async () => {
      const r = await run(script, args, {
        failFirst: Number.MAX_SAFE_INTEGER,
        status: 0,
        reset: true,
      });
      expect(r.status).not.toBe(0);
      expect(r.requests).toBeGreaterThan(1);
      expect(r.requests).toBeLessThanOrEqual(10);
      expect(r.stderr).not.toContain('STUB kubectl');
    }, 60_000);
  }
});
