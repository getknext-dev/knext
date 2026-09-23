import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildChildEnv } from '../packages/kn-next/src/adapters/env';
import { countNodeCompileCache } from '../scripts/e2e-bytecode-liveness.mjs';

/**
 * Bytecode caching proven LIVE per cell — the HARNESS half, on KNEXT's own path.
 *
 * tests/bytecode-liveness.test.ts pins the rule and
 * tests/bytecode-liveness-chain.test.ts pins the evidence reaching the audit.
 * This file pins that the node evidence exercises what knext SHIPS, so a
 * regression in knext's compile-cache path reds the night:
 *
 *   1. the shipped BAKE DRIVER (templates/runtime-standalone/
 *      knext-compile-cache-bake.mjs.hbs — what Dockerfile.standalone.hbs RUNs),
 *      exercised against a real node: its cache is accepted by a later process;
 *   2. the shipped SUPERVISOR's env wiring (buildChildEnv) hands the child
 *      NODE_COMPILE_CACHE — drop it and the child boots cold;
 *   3. scripts/e2e-deploy.sh resolves BOTH from the installed tarball, bakes
 *      with the driver, boots through the supervisor, grades only the
 *      standalone child, and records the bake's status per deploy;
 *   4. the workflow folds that evidence into the shard summary and checks it on
 *      every runtime.
 */

const ROOT = resolve(import.meta.dir, '..');
const DEPLOY = readFileSync(join(ROOT, 'scripts/e2e-deploy.sh'), 'utf8');
const CLEANUP = readFileSync(join(ROOT, 'scripts/e2e-cleanup.sh'), 'utf8');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/test-e2e-deploy.yml'), 'utf8');
const SHIPPED_BAKE = join(
  ROOT,
  'packages/kn-next/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs',
);
const LEDGER_PATH = '${RUNNER_TEMP:-/tmp}/knext-e2e-boot-modes.log';

/** Exactly-once occurrence — an anchor that appears twice is ambiguous. */
function once(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

/** Every temp dir a test creates, removed once the file finishes (D9). */
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Enough source for V8 to bother caching (tiny functions may be skipped). */
const BIG_MODULE = Array.from(
  { length: 200 },
  (_, i) => `exports.f${i} = function f${i}(a) { return a * ${i} + ${i}; };`,
).join('\n');

/**
 * A fake standalone tree whose server.js behaves like Next's: it loads a
 * framework module and listens on $PORT, answering the warm path with 200.
 */
function fakeStandalone() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-shipped-bake-'));
  temps.push(dir);
  mkdirSync(join(dir, 'node_modules/next'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/next/index.js'), BIG_MODULE);
  writeFileSync(
    join(dir, 'server.js'),
    [
      "require('./node_modules/next/index.js');",
      "require('node:http').createServer((req, res) => {",
      "  res.writeHead(req.url === '/_next/static/chunk.js' ? 200 : 404); res.end('ok');",
      '}).listen(Number(process.env.PORT), process.env.HOSTNAME);',
    ].join('\n'),
  );
  // The template has no Handlebars tokens; the image stages it byte-for-byte.
  const driver = join(dir, 'knext-compile-cache-bake.mjs');
  copyFileSync(SHIPPED_BAKE, driver);
  return { dir, driver, server: join(dir, 'server.js') };
}

let port = 38_900 + Math.floor(Math.random() * 500);
function runShippedBake(dir: string, driver: string, server: string, cache: string) {
  port += 1;
  return spawnSync('node', [driver], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      STANDALONE_SERVER_PATH: server,
      NODE_COMPILE_CACHE: cache,
      KNEXT_WARM_PATH: '/_next/static/chunk.js',
    },
    cwd: dir,
  });
}

/** Load the framework module in a fresh process and count what V8 accepted. */
function acceptedOnReload(dir: string, cache: string) {
  const probe = spawnSync('node', ['-e', "require('./node_modules/next/index.js')"], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_COMPILE_CACHE: cache,
      NODE_DEBUG_NATIVE: 'COMPILE_CACHE',
    },
  });
  return countNodeCompileCache(probe.stderr).accepted;
}

describe("the SHIPPED bake driver (the standalone-node image's own), against a real node", () => {
  it('bakes a cache that a later process ACCEPTS', () => {
    const { dir, driver, server } = fakeStandalone();
    const cache = join(dir, '.next/compile-cache');
    const r = runShippedBake(dir, driver, server, cache);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(acceptedOnReload(dir, cache)).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('the other half: with no bake, the same load accepts nothing', () => {
    const { dir } = fakeStandalone();
    expect(acceptedOnReload(dir, join(dir, '.next/compile-cache-empty'))).toBe(0);
  });

  it('exits non-zero when the warm path does not answer 2xx (the harness records bake=failed)', () => {
    const { dir, driver, server } = fakeStandalone();
    port += 1;
    const r = spawnSync('node', [driver], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        STANDALONE_SERVER_PATH: server,
        NODE_COMPILE_CACHE: join(dir, '.cc'),
        KNEXT_WARM_PATH: '/not-there',
      },
    });
    expect(r.status).not.toBe(0);
  }, 90_000);
});

describe('the SHIPPED supervisor hands the child NODE_COMPILE_CACHE (buildChildEnv)', () => {
  const saved = process.env.NODE_COMPILE_CACHE;
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_COMPILE_CACHE;
    else process.env.NODE_COMPILE_CACHE = saved;
  });

  it('the child env carries the parent NODE_COMPILE_CACHE unchanged', () => {
    process.env.NODE_COMPILE_CACHE = '/app/.next/standalone/.next/compile-cache';
    expect(buildChildEnv().NODE_COMPILE_CACHE).toBe('/app/.next/standalone/.next/compile-cache');
  });
});

describe("e2e-deploy.sh — the node lane runs KNEXT's own bake + supervisor, and says so per deploy", () => {
  it('resolves the supervisor and the bake driver from the INSTALLED tarball', () => {
    expect(
      once(
        DEPLOY,
        `KNEXT_NODE_SUPERVISOR="$(node -e 'process.stdout.write(require.resolve("@getknext/core/internal/node-server"))' 2>/dev/null || true)"`,
      ),
    ).toBe(1);
    expect(
      once(
        DEPLOY,
        'KNEXT_BAKE_TEMPLATE="${KNEXT_CORE_ROOT}/templates/runtime-standalone/knext-compile-cache-bake.mjs.hbs"',
      ),
    ).toBe(1);
    // No harness-private bake survives.
    expect(DEPLOY).not.toContain('e2e-compile-cache-bake.mjs');
  });

  it("bakes with the shipped driver into the image's cache location, before boot", () => {
    expect(once(DEPLOY, 'NODE_CC_DIR="${STANDALONE_APP_DIR}/.next/compile-cache"')).toBe(1);
    expect(
      once(
        DEPLOY,
        '          node "${KNEXT_BAKE_DRIVER}" 2>&1 | tee "${APP_DIR}/.knext-bake.out" >&2',
      ),
    ).toBe(1);
    expect(DEPLOY.indexOf('node "${KNEXT_BAKE_DRIVER}"')).toBeLessThan(
      DEPLOY.indexOf('# ── 4. boot the standalone server'),
    );
  });

  it('boots node THROUGH the shipped supervisor with the cache and V8 debug on', () => {
    expect(once(DEPLOY, '      exec node "${KNEXT_NODE_SUPERVISOR}" \\')).toBe(1);
    expect(
      once(DEPLOY, '      NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \\'),
    ).toBe(1);
    expect(
      once(
        DEPLOY,
        '      STANDALONE_SERVER_PATH="${SERVER_JS}" \\\n      NODE_COMPILE_CACHE="${NODE_CC_DIR}" NODE_DEBUG_NATIVE=COMPILE_CACHE \\',
      ),
    ).toBe(1);
  });

  it("diverts V8's debug lines OUT of the server log (next.cliOutput) into the side log", () => {
    expect(once(DEPLOY, `2> >(exec awk -v cc="\${NODE_CC_DEBUG_LOG}"`)).toBe(1);
    expect(DEPLOY).toContain('index($0, "[compile cache] ") == 1');
  });

  it('grades ONLY the standalone child and records the bake status, after readiness', () => {
    const line =
      'echo "mode=server-js runtime=${RUNTIME} image=- bytecode_verified=- compile_cache_bake=${NODE_CC_BAKE} ${CC_COUNTS}" >>"${BOOT_MODE_LEDGER}"';
    expect(once(DEPLOY, line)).toBe(1);
    expect(
      once(
        DEPLOY,
        'CC_COUNTS="$(node "${SCRIPT_DIR}/e2e-bytecode-liveness.mjs" --count-node-log "${NODE_CC_DEBUG_LOG}" --under "${STANDALONE_ROOT}")"',
      ),
    ).toBe(1);
    const at = DEPLOY.indexOf(line);
    expect(at).toBeGreaterThan(DEPLOY.indexOf('log "deployment ready:'));
    expect(at).toBeLessThan(DEPLOY.indexOf('echo "http://localhost:${PORT}"'));
  });

  it("checks port ownership against the supervisor's child, and cleanup reaps it", () => {
    expect(once(DEPLOY, '    OWNER_PID="${CHILD_PID}"')).toBe(1);
    expect(once(DEPLOY, '    echo "CHILD_PID=${CHILD_PID}" >>"${LOG_FILE}"')).toBe(1);
    expect(CLEANUP).toContain('CHILD_PID="$(grep -E \'^CHILD_PID=\' "${LOG_FILE}"');
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
  it('the liveness definition is matched by the fingerprint HARNESS_ROOTS', async () => {
    const { HARNESS_ROOTS } = await import('../scripts/compat-window-fingerprint.mjs');
    const scriptsRoot = HARNESS_ROOTS.find(
      (r: { kind: string; path: string }) => r.kind === 'dir' && r.path === 'scripts',
    ) as { match: RegExp };
    expect(scriptsRoot.match.test('e2e-bytecode-liveness.mjs')).toBe(true);
  });
});
