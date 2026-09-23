import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { countNodeCompileCache } from '../scripts/e2e-bytecode-liveness.mjs';

/**
 * Bytecode caching proven LIVE per cell — the HARNESS half.
 *
 * tests/bytecode-liveness.test.ts pins the rule and
 * tests/bytecode-liveness-chain.test.ts pins the evidence reaching the audit.
 * This file pins the two places the evidence is PRODUCED:
 *
 *   1. scripts/e2e-deploy.sh — the node boot is a CACHED boot (baked from
 *      framework modules only, then booted with NODE_COMPILE_CACHE), V8's own
 *      debug output is diverted out of the server log (it is next.cliOutput in
 *      deploy mode, and tests assert on it), and one evidence line per deploy
 *      carries the accepted/missed/rejected counts;
 *   2. the workflow — the summarize step folds the boot ledger into the shard
 *      summary, and the shard check runs for EVERY runtime, not bun only.
 *
 * Plus the bake driver's own behaviour, against a real node: a cache it bakes
 * is accepted by a later process, and every way it cannot bake exits 1.
 */

const ROOT = resolve(import.meta.dir, '..');
const DEPLOY = readFileSync(join(ROOT, 'scripts/e2e-deploy.sh'), 'utf8');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/test-e2e-deploy.yml'), 'utf8');
const BAKE = join(ROOT, 'scripts/e2e-compile-cache-bake.mjs');
const LEDGER_PATH = '${RUNNER_TEMP:-/tmp}/knext-e2e-boot-modes.log';

/** Exactly-once occurrence — an anchor that appears twice is ambiguous. */
function once(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

/** A fake standalone tree: server.js + a `next` package with the two required modules. */
function fakeStandalone(opts: { withStartServer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bake-'));
  const next = join(dir, 'node_modules/next');
  mkdirSync(join(next, 'dist/server/lib'), { recursive: true });
  writeFileSync(join(next, 'package.json'), JSON.stringify({ name: 'next', main: 'index.js' }));
  // Enough source for V8 to bother caching (tiny functions may be skipped).
  const body = Array.from(
    { length: 200 },
    (_, i) => `exports.f${i} = function f${i}(a) { return a * ${i} + ${i}; };`,
  ).join('\n');
  writeFileSync(join(next, 'index.js'), body);
  if (opts.withStartServer !== false) {
    writeFileSync(join(next, 'dist/server/lib/start-server.js'), body);
  }
  const server = join(dir, 'server.js');
  writeFileSync(server, "require('next');require('next/dist/server/lib/start-server');\n");
  return { dir, server, next };
}

function bake(server: string, env: Record<string, string | undefined>) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('NODE_')) e[k] = v;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync('node', [BAKE, server], { encoding: 'utf8', env: e });
}

describe('e2e-compile-cache-bake — the harness bake, against a real node', () => {
  it('bakes a cache that a LATER process accepts (the node cell is a cached boot)', () => {
    const { dir, next } = fakeStandalone();
    const cache = join(dir, '.cc');
    const r = bake(join(dir, 'server.js'), { NODE_COMPILE_CACHE: cache, NODE_ENV: 'production' });
    expect(r.status, r.stderr).toBe(0);
    // Load the same modules in a fresh process with V8's debug output on.
    const probe = spawnSync(
      'node',
      ['-e', `require(${JSON.stringify(join(next, 'dist/server/lib/start-server.js'))})`],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          NODE_COMPILE_CACHE: cache,
          NODE_DEBUG_NATIVE: 'COMPILE_CACHE',
        },
      },
    );
    expect(countNodeCompileCache(probe.stderr).accepted).toBeGreaterThanOrEqual(1);
  });

  it('the other half: WITHOUT the bake the same load accepts nothing', () => {
    const { dir, next } = fakeStandalone();
    const probe = spawnSync(
      'node',
      ['-e', `require(${JSON.stringify(join(next, 'dist/server/lib/start-server.js'))})`],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          NODE_COMPILE_CACHE: join(dir, '.cc-empty'),
          NODE_DEBUG_NATIVE: 'COMPILE_CACHE',
        },
      },
    );
    expect(countNodeCompileCache(probe.stderr).accepted).toBe(0);
  });

  it('exits 1 when NODE_COMPILE_CACHE is not set', () => {
    const { server } = fakeStandalone();
    expect(bake(server, {}).status).toBe(1);
  });

  it('exits 1 when the runtime refuses the cache (NODE_DISABLE_COMPILE_CACHE)', () => {
    const { dir, server } = fakeStandalone();
    const r = bake(server, {
      NODE_COMPILE_CACHE: join(dir, '.cc'),
      NODE_DISABLE_COMPILE_CACHE: '1',
    });
    expect(r.status).toBe(1);
  });

  it('exits 1 when a module server.js requires cannot load (fail closed)', () => {
    const { dir, server } = fakeStandalone({ withStartServer: false });
    expect(bake(server, { NODE_COMPILE_CACHE: join(dir, '.cc') }).status).toBe(1);
  });

  it('never requires server.js itself (that would start the fixture outside the test)', () => {
    const src = readFileSync(BAKE, 'utf8');
    expect(/req\(serverJs\)|require\(serverJs\)|import\(serverJs\)/.test(src)).toBe(false);
  });
});

describe('e2e-deploy.sh — the node boot is a cached boot, and says so per deploy', () => {
  it('bakes the cache for the node runtime with the bake driver, before boot', () => {
    expect(once(DEPLOY, 'NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_ENV=production \\')).toBe(1);
    expect(once(DEPLOY, 'node "${SCRIPT_DIR}/e2e-compile-cache-bake.mjs" "${SERVER_JS}" >&2')).toBe(
      1,
    );
    expect(DEPLOY.indexOf('e2e-compile-cache-bake.mjs')).toBeLessThan(
      DEPLOY.indexOf('# ── 4. boot the standalone server'),
    );
    expect(/if \[ "\$\{RUNTIME\}" != "bun" \]; then\n\s+NODE_CC_DIR=/.test(DEPLOY)).toBe(true);
  });

  it('boots node WITH the baked cache and V8 compile-cache debug on', () => {
    expect(
      once(DEPLOY, 'NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \\'),
    ).toBe(1);
  });

  it("diverts V8's debug lines OUT of the server log (next.cliOutput) into the side log", () => {
    expect(once(DEPLOY, `2> >(exec awk -v cc="\${NODE_CC_DEBUG_LOG}"`)).toBe(1);
    expect(DEPLOY).toContain('index($0, "[compile cache] ") == 1');
  });

  it('appends the node evidence line AFTER readiness and before the URL is printed', () => {
    const line =
      'echo "mode=server-js runtime=${RUNTIME} image=- bytecode_verified=- ${CC_COUNTS}" >>"${BOOT_MODE_LEDGER}"';
    expect(once(DEPLOY, line)).toBe(1);
    expect(
      once(
        DEPLOY,
        'node "${SCRIPT_DIR}/e2e-bytecode-liveness.mjs" --count-node-log "${NODE_CC_DEBUG_LOG}"',
      ),
    ).toBe(1);
    const at = DEPLOY.indexOf(line);
    expect(at).toBeGreaterThan(DEPLOY.indexOf('log "deployment ready:'));
    expect(at).toBeLessThan(DEPLOY.indexOf('echo "http://localhost:${PORT}"'));
  });

  it('the bun compiled-exec evidence line is unchanged', () => {
    expect(
      once(
        DEPLOY,
        'echo "mode=compiled-exec runtime=${RUNTIME} image=${STANDALONE_BUN_IMAGE} bytecode_verified=true" >>"${BOOT_MODE_LEDGER}"',
      ),
    ).toBe(1);
  });
});

describe('workflow — every shard proves liveness, and the proof reaches the ledger', () => {
  const summarize =
    WORKFLOW.match(/- name: Summarize shard result[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
  const verify =
    WORKFLOW.match(/- name: Verify boot-mode ledger[\s\S]*?(?=\n\s+- name:|\n\n {2}#)/)?.[0] ?? '';

  it('the summarize step folds the SAME boot ledger the deploy script writes into the shard summary', () => {
    expect(summarize).not.toBe('');
    expect(DEPLOY).toContain(`BOOT_MODE_LEDGER="${LEDGER_PATH}"`);
    expect(summarize).toContain(`--boot-ledger "${LEDGER_PATH}"`);
  });

  it('the shard check runs the shared liveness rule for EVERY runtime (no node early-exit)', () => {
    expect(verify).not.toBe('');
    expect(verify).toContain(
      'node scripts/e2e-bytecode-liveness.mjs --check --runtime "${KNEXT_RUNTIME}" --ledger "${LEDGER}"',
    );
    expect(verify).not.toMatch(/if \[ "\$\{KNEXT_RUNTIME\}" != "bun" \]/);
  });
});

describe('the liveness definition is part of the frozen harness set', () => {
  // Lowering a floor mid-window must move the night's fingerprint (and so
  // restart the count), exactly like editing any other harness script.
  it('both new harness scripts are matched by the fingerprint HARNESS_ROOTS', async () => {
    const { HARNESS_ROOTS } = await import('../scripts/compat-window-fingerprint.mjs');
    const scriptsRoot = HARNESS_ROOTS.find(
      (r: { kind: string; path: string }) => r.kind === 'dir' && r.path === 'scripts',
    ) as { match: RegExp };
    expect(scriptsRoot.match.test('e2e-bytecode-liveness.mjs')).toBe(true);
    expect(scriptsRoot.match.test('e2e-compile-cache-bake.mjs')).toBe(true);
  });
});
